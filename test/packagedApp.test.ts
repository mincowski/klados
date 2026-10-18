/**
 * R230 (`docs/plans/R230-shipped-app-hardening.md` §3) — the **packaged**
 * binary, as `electron-builder --dir` leaves it, refuses to be used as a Node
 * runtime, and still works.
 *
 * **Not Playwright.** `enableNodeCliInspectArguments: false` is one of the
 * fuses under test, and Playwright's `_electron` attaches through `--inspect`,
 * so it cannot drive this binary. `mainElectron.test.ts` launches the stock
 * Electron against `out/`, which no fuse touches. This file spawns the binary
 * itself and reads what it leaves on disk.
 *
 * **How a probe is judged without a timer.** With a fuse off, the probe's code
 * would run and write a marker file. With it on, the binary ignores the
 * variable and starts the GUI, and the renderer writes `titlebar-theme.json`
 * into the profile on first render, through IPC (`TitleBar.tsx`'s
 * `useTitleBarOverlaySync`). So each probe waits for **either** file: the
 * marker means the fuse failed, the theme file means the app started instead,
 * and the theme file alone is criterion 4's smoke test as well, since it proves
 * the preload loaded, the sender guard accepted the page and the renderer
 * mounted.
 *
 * **When it runs.** CI packages with `--dir` right before the test step, on
 * all three runners. Locally `dist/` is usually stale, so the suite runs only
 * when the packaged app is newer than both `out/main/index.js` and
 * `electron-builder.yml`; on CI a missing or stale build is a failure, never a
 * skip, so the guard cannot go quietly vacuous there.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Where `electron-builder --dir` leaves the executable, per platform. */
const CANDIDATES: Record<string, string[]> = {
  win32: ['dist/win-unpacked/Klados.exe'],
  darwin: [
    'dist/mac-arm64/Klados.app/Contents/MacOS/Klados',
    'dist/mac/Klados.app/Contents/MacOS/Klados'
  ],
  linux: ['dist/linux-unpacked/klados']
}

function packagedBinary(): string | null {
  return (CANDIDATES[process.platform] ?? []).find((p) => existsSync(p)) ?? null
}

/** The packaged binary when it is newer than what it was built from; null if
 * absent or stale. */
function freshBinary(): string | null {
  const binary = packagedBinary()
  if (binary === null) return null
  const built = statSync(binary).mtimeMs
  const sources = ['out/main/index.js', 'electron-builder.yml'].filter((p) => existsSync(p))
  return sources.every((p) => statSync(p).mtimeMs <= built) ? path.resolve(binary) : null
}

const BINARY = freshBinary()
const ON_CI = process.env.CI === 'true'

/** The GUI must be up within this, per criterion 4. */
const STARTUP_TIMEOUT_MS = 15_000

/** The fuse values the plan's table sets, as `@electron/fuses read` names them. */
const EXPECTED_FUSES: Record<string, 'Enabled' | 'Disabled'> = {
  RunAsNode: 'Disabled',
  EnableCookieEncryption: 'Enabled',
  EnableNodeOptionsEnvironmentVariable: 'Disabled',
  EnableNodeCliInspectArguments: 'Disabled',
  EnableEmbeddedAsarIntegrityValidation: 'Enabled',
  OnlyLoadAppFromAsar: 'Enabled',
  // At its default: off, `loadFile` cannot read inside app.asar (D-122).
  GrantFileProtocolExtraPrivileges: 'Enabled'
}

const running: ChildProcess[] = []
const temps: string[] = []

afterEach(() => {
  for (const child of running.splice(0)) child.kill()
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A killed process can hold a profile file for a moment on Windows; the
      // OS temp folder is cleaned eventually either way.
    }
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/** Launches the binary with its own profile, and resolves with which file
 * appeared first: the probe's `marker`, or the app's own theme file. */
async function launch(options: {
  args?: string[]
  env?: Record<string, string>
  marker?: string
}): Promise<{ outcome: 'marker' | 'started'; stderr: () => string }> {
  const profile = tempDir('klados-r230-profile-')
  const theme = path.join(profile, 'titlebar-theme.json')
  const child = spawn(BINARY!, [...(options.args ?? []), `--user-data-dir=${profile}`], {
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  running.push(child)
  let stderr = ''
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  let outcome: 'marker' | 'started' | null = null
  await vi
    .waitFor(
      () => {
        if (options.marker !== undefined && existsSync(options.marker)) outcome = 'marker'
        else if (existsSync(theme)) outcome = 'started'
        if (outcome === null)
          throw new Error('neither the probe nor the app has written anything yet')
      },
      { timeout: STARTUP_TIMEOUT_MS, interval: 50 }
    )
    .catch((err: unknown) => {
      // Why it did not start is in the app's own stderr; without it a timeout
      // here says nothing.
      throw new Error(`${(err as Error).message}
--- the app's stderr:
${stderr.slice(-4000)}`)
    })
  return { outcome: outcome!, stderr: () => stderr }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

describe('R230 — the packaged binary is not a general-purpose Node runtime', () => {
  it('a packaged build to test exists on CI', () => {
    // The other tests skip without one; on CI that would make them vacuous.
    if (ON_CI) expect(BINARY, 'electron-builder --dir output, newer than out/').not.toBeNull()
  })

  it.runIf(BINARY !== null)('reads back the fuse values the plan sets', () => {
    const output = execFileSync('npx', ['@electron/fuses', 'read', '--app', BINARY!], {
      encoding: 'utf8',
      shell: process.platform === 'win32'
    })
    for (const [fuse, state] of Object.entries(EXPECTED_FUSES)) {
      expect(output, fuse).toMatch(new RegExp(`\\b${fuse} is ${state}\\b`))
    }
  })

  it.runIf(BINARY !== null)(
    'starts, and its renderer reaches the main process (criterion 4)',
    async () => {
      const fixture = path.join(tempDir('klados-r230-doc-'), 'doc.json')
      writeFileSync(fixture, '{"a":1}')
      const { outcome } = await launch({ args: [fixture] })
      expect(outcome).toBe('started')
    },
    STARTUP_TIMEOUT_MS + 5_000
  )

  it.runIf(BINARY !== null)(
    'ignores ELECTRON_RUN_AS_NODE',
    async () => {
      // A script path, not the plan's `-e`: in Node mode every argument after
      // `-e <code>` is read as a Node option, so the `--user-data-dir` the GUI
      // needs made Node exit with "bad option" before the code ran, and the
      // probe could never have written its marker. After a script path the
      // remaining arguments are the script's own; in GUI mode the path is just
      // a file Klados is asked to open.
      const dir = tempDir('klados-r230-')
      const marker = path.join(dir, 'r230-runasnode.txt')
      const probe = path.join(dir, 'r230-runasnode.cjs')
      writeFileSync(
        probe,
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')
`
      )
      const { outcome } = await launch({
        args: [probe],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        marker
      })
      expect(outcome).toBe('started')
      expect(existsSync(marker)).toBe(false)
    },
    STARTUP_TIMEOUT_MS + 5_000
  )

  it.runIf(BINARY !== null)(
    'ignores NODE_OPTIONS',
    async () => {
      const dir = tempDir('klados-r230-')
      const marker = path.join(dir, 'r230-nodeoptions.txt')
      const probe = path.join(dir, 'r230-probe.cjs')
      writeFileSync(probe, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')\n`)
      const { outcome, stderr } = await launch({
        env: { NODE_OPTIONS: `--require ${JSON.stringify(probe)}` },
        marker
      })
      expect(outcome).toBe('started')
      expect(existsSync(marker)).toBe(false)
      // **Measured: the GUI refuses `--require` with or without the fuse**
      // (Electron: "Most NODE_OPTIONs are not supported in packaged apps"), so
      // the marker alone cannot tell the two apart. What the fuse changes is
      // that the variable is not read at all, and that log line goes with it.
      expect(stderr()).not.toContain('NODE_OPTION')
    },
    STARTUP_TIMEOUT_MS + 5_000
  )

  it.runIf(BINARY !== null)(
    'opens no inspector for --inspect',
    async () => {
      // A port nothing else here uses; the app is up before it is tried, so a
      // refused connection means no inspector, not "not yet".
      const port = 9229 + Math.floor(Math.random() * 500)
      const { outcome } = await launch({ args: [`--inspect=${port}`] })
      expect(outcome).toBe('started')
      expect(await canConnect(port)).toBe(false)
    },
    STARTUP_TIMEOUT_MS + 5_000
  )
})

/**
 * R230 criterion 3 — with `enableEmbeddedAsarIntegrityValidation`, an edited
 * `app.asar` is refused. Run on a copy of the `--dir` output, never on it.
 *
 * Electron validates the archive on Windows and macOS; on Linux the fuse has
 * nothing to check against (see the plan's Results).
 */
const ASAR_VALIDATED = true // R230 MEASUREMENT: every platform, to see whether Linux refuses

/** The folder `electron-builder --dir` produced, and the archive inside it. */
function unpackedRoot(binary: string): { root: string; asar: string } {
  if (process.platform === 'darwin') {
    const root = binary.slice(0, binary.indexOf('.app/') + '.app'.length)
    return { root, asar: path.join(root, 'Contents', 'Resources', 'app.asar') }
  }
  const root = path.dirname(binary)
  return { root, asar: path.join(root, 'resources', 'app.asar') }
}

describe('R230 — an edited app.asar is refused', () => {
  it.runIf(BINARY !== null && ASAR_VALIDATED)(
    'a copy with one byte changed exits without starting',
    async () => {
      const { root, asar } = unpackedRoot(BINARY!)
      const copyParent = tempDir('klados-r230-tamper-')
      const copyRoot = path.join(copyParent, path.basename(root))
      cpSync(root, copyRoot, { recursive: true, verbatimSymlinks: true })
      const copyAsar = path.join(copyRoot, path.relative(root, asar))
      const copyBinary = path.join(copyRoot, path.relative(root, BINARY!))

      // One byte inside a string literal of the app's own code.
      const bytes = readFileSync(copyAsar)
      const at = bytes.indexOf(Buffer.from('titlebar-theme.json'))
      expect(at).toBeGreaterThan(0)
      bytes[at] = 'T'.charCodeAt(0)
      writeFileSync(copyAsar, bytes)

      const profile = tempDir('klados-r230-profile-')
      const child = spawn(copyBinary, [`--user-data-dir=${profile}`], { stdio: 'ignore' })
      running.push(child)
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))

      expect(code).not.toBe(0)
      expect(existsSync(path.join(profile, 'titlebar-theme.json'))).toBe(false)
    },
    60_000
  )
})
