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
  mkdirSync,
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

/** A fresh folder under the OS temp folder, removed after the test. On the
 * Windows runner that is under `C:\Users\RUNNER~1\`, an 8.3 short name, which
 * every launch here then goes through (R240). */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/** Launches the binary with its own profile, and resolves with which file
 * appeared first: the probe's `marker`, or the app's own theme file. */
async function launch(options: {
  binary?: string
  args?: string[]
  env?: Record<string, string>
  marker?: string
}): Promise<{ outcome: 'marker' | 'started'; stderr: () => string }> {
  const profile = tempDir('klados-r230-profile-')
  const theme = path.join(profile, 'titlebar-theme.json')
  const child = spawn(
    options.binary ?? BINARY!,
    [...(options.args ?? []), `--user-data-dir=${profile}`],
    {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'ignore', 'pipe']
    }
  )
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
 * Electron validates the archive on Windows and macOS only. **Measured on
 * Linux** (ubuntu-latest, with the control launch below passing): the tampered
 * copy started and ran, so there the fuse has no effect. That is Electron's
 * documented scope, and the plan's Results record it.
 */
const ASAR_VALIDATED = process.platform === 'win32' || process.platform === 'darwin'

/** The folder `electron-builder --dir` produced, and the archive inside it. */
function unpackedRoot(binary: string): { root: string; asar: string } {
  if (process.platform === 'darwin') {
    const root = binary.slice(0, binary.indexOf('.app/') + '.app'.length)
    return { root, asar: path.join(root, 'Contents', 'Resources', 'app.asar') }
  }
  const root = path.dirname(binary)
  return { root, asar: path.join(root, 'resources', 'app.asar') }
}

/** Copies the `--dir` output into `parent`, and returns the copy's binary and
 * archive. */
function copyOfApp(parent: string): { binary: string; asar: string } {
  const { root, asar } = unpackedRoot(BINARY!)
  const copyRoot = path.join(parent, path.basename(root))
  cpSync(root, copyRoot, { recursive: true, verbatimSymlinks: true })
  return {
    binary: path.join(copyRoot, path.relative(root, BINARY!)),
    asar: path.join(copyRoot, path.relative(root, asar))
  }
}

describe('R230 — an edited app.asar is refused', () => {
  it.runIf(BINARY !== null && ASAR_VALIDATED)(
    'a copy starts, and the same copy with one byte changed refuses for integrity',
    async () => {
      const { binary: copyBinary, asar: copyAsar } = copyOfApp(tempDir('klados-r230-tamper-'))
      // The control: untampered, the copy starts. Without it, a refusal below
      // could be the copy failing for any reason at all, which is how the first
      // Linux measurement was confounded twice.
      const control = await launch({ binary: copyBinary })
      expect(control.outcome).toBe('started')
      for (const child of running.splice(0)) child.kill()

      // One byte inside a string literal of the app's own code.
      const bytes = readFileSync(copyAsar)
      const at = bytes.indexOf(Buffer.from('titlebar-theme.json'))
      expect(at).toBeGreaterThan(0)
      bytes[at] = 'T'.charCodeAt(0)
      writeFileSync(copyAsar, bytes)

      const profile = tempDir('klados-r230-profile-')
      const child = spawn(copyBinary, [`--user-data-dir=${profile}`], {
        stdio: ['ignore', 'ignore', 'pipe']
      })
      running.push(child)
      let stderr = ''
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      // Either it exits, or it starts. Waiting for the exit alone would hang on
      // a copy that runs, which is what an unchecked archive does.
      const theme = path.join(profile, 'titlebar-theme.json')
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
      const result = await Promise.race([
        exited.then((code) => ({ code })),
        vi
          .waitFor(
            () => {
              if (!existsSync(theme)) throw new Error('not started')
            },
            { timeout: STARTUP_TIMEOUT_MS, interval: 50 }
          )
          // Settled either way, so the wait left behind when the copy exits
          // first does not reject later as an unhandled error.
          .then(
            () => 'started' as const,
            () => 'neither exited nor started' as const
          )
      ])

      if (typeof result === 'string') throw new Error(`the tampered copy ${result}`)
      expect(result.code).not.toBe(0)
      expect(existsSync(theme)).toBe(false)
      // Windows: "ASAR Integrity Violation: got a hash mismatch".
      expect(stderr).toMatch(/integrity/i)
    },
    90_000
  )
})

/**
 * R240 (`docs/plans/R240-app-url-spelling.md` §5, criteria 5 and 6) — the
 * packaged app starts from a path whose `file:` URL Node and Chromium spell
 * differently. Before R240, R164's sender guard compared the two raw, refused
 * every IPC call from the app's own page, and the window stayed blank, so
 * `launch` never saw `started`.
 */
describe('R240 — the packaged app starts from any folder name', () => {
  /** The 8.3 alias `dir /x` lists for `name` inside `parent`, or null when the
   * volume generates none. Looked up, never assumed. */
  function shortNameOf(parent: string, name: string): string | null {
    const listing = execFileSync('cmd', ['/c', 'dir', '/x', parent], { encoding: 'utf8' })
    for (const line of listing.split(/\r?\n/)) {
      // `<DIR>  KLADOS~1  klados-long-folder-name`; with no alias, the long
      // name follows `<DIR>` alone.
      const match = /<DIR>\s+(\S+)\s+(\S+)\s*$/.exec(line)
      if (match !== null && match[2] === name) return match[1]!
    }
    return null
  }

  it.runIf(BINARY !== null && process.platform === 'win32')(
    'through an 8.3 alias of its folder (criterion 5)',
    async (ctx) => {
      const parent = tempDir('klados-r240-short-')
      const longName = 'klados-long-folder-name'
      mkdirSync(path.join(parent, longName))
      const { binary } = copyOfApp(path.join(parent, longName))
      const alias = shortNameOf(parent, longName)
      if (alias === null) {
        const reason = `no 8.3 alias for ${longName}: 8.3 name generation is off on this volume`
        console.warn(`R240 criterion 5 skipped: ${reason}`)
        ctx.skip(reason)
        return
      }
      expect(alias).toMatch(/~/)
      const viaAlias = path.join(parent, alias, path.relative(path.join(parent, longName), binary))
      expect(existsSync(viaAlias)).toBe(true)
      const { outcome } = await launch({ binary: viaAlias })
      expect(outcome).toBe('started')
    },
    90_000
  )

  it.runIf(BINARY !== null)(
    'from a long folder name holding ~, [ and ] (criterion 6)',
    async () => {
      const folder = path.join(tempDir('klados-r240-chars-'), 'apps~[portable]')
      mkdirSync(folder)
      const { binary } = copyOfApp(folder)
      // A copy's `chrome-sandbox` is not setuid root, so a packaged Linux build
      // aborts before its first window (`docs/FINDINGS.md`), and making it so
      // needs root. The guard under test does not depend on the OS sandbox.
      const args = process.platform === 'linux' ? ['--no-sandbox'] : []
      const { outcome } = await launch({ binary, args })
      expect(outcome).toBe('started')
    },
    90_000
  )
})
