/**
 * R178 (`docs/plans/R175-self-write-suppression.md` §10) — a real `writeFile`
 * through `selfWrite` produces **zero** watcher notifications, where the same
 * write without it produces one or more.
 *
 * **Against a real filesystem, deliberately**, and for the reason R171's own
 * real-filesystem test exists: the defect is about what the operating system
 * does, and a fake that fires a callback proves only that the callback is
 * wired. `documentWatchers.test.ts` covers the registry's decision-making
 * against injected events, which is the right tool for the branches; this
 * covers the one thing no fake can answer — whether a genuine \`writeFile\`
 * still reaches the renderer after the suppression is in place.
 *
 * The plan asks for the assertion to be **"zero notifications"** and never
 * "exactly two events were suppressed": one `writeFile` produced two `change`
 * events on Windows in one probe and one in another, so a count is a property
 * of the platform and the moment, not of this code.
 *
 * The bare-write half is the reproduction and is asserted rather than assumed
 * — but it asserts the *mtime moved* first, because that is the registry's own
 * criterion for "the content changed". A run where the file's timestamp did
 * not move would have had nothing to detect and nothing to suppress, and
 * finding that out from the assertion that failed is worth more than a green
 * test that proved nothing.
 *
 * **That assertion earned itself on the first CI run**: it failed on
 * `windows-latest`, where the runner created and rewrote the fixture inside one
 * ~15.6 ms clock tick and the timestamp never moved. `tempFile` now backdates
 * the fixture so the premise holds on any machine — see its comment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFsWatcherDeps } from '../src/main/fsWatcherDeps'
import { createDocumentWatcherRegistry } from '../src/core/documentWatchers'
import { POLL_MS, TIMEOUT_MS } from './support/wait'

/** The margin for the *negative* assertion — that nothing ever arrives.
 * R163's rule names this as the one legitimate use of a duration: there is no
 * condition to wait for when the expected outcome is silence. */
const NO_NOTIFICATION_SETTLE_MS = 400

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort; the OS reclaims the temp directory either way.
    }
  }
})

/** How far back a fresh fixture's timestamp is pushed. Any value past one
 * clock tick works; a minute is unmistakable in a failure message. */
const BACKDATE_SECONDS = 60

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'klados-r178-'))
  created.push(dir)
  const file = path.join(dir, 'watched.json')
  writeFileSync(file, '{"a":1}')
  // **Backdated so the write under test is guaranteed to move the mtime.**
  //
  // Windows advances file timestamps on the system clock tick (~15.6 ms), so a
  // file created and rewritten inside one tick keeps the same `mtimeMs` — and
  // the registry decides "the content changed" by comparing exactly that. The
  // Windows CI runner hit it: `mtimeMoved` came back `false` for the guarded
  // half of the measurement below, which made its premise untrue rather than
  // its conclusion wrong.
  //
  // Pushing the baseline back a minute makes the comparison independent of how
  // fast the machine is, without waiting for a tick. It changes nothing about
  // what is being measured: the watcher fires on the write either way, and the
  // question is only whether the registry forwards it.
  const backdated = new Date(Date.now() - BACKDATE_SECONDS * 1000)
  utimesSync(file, backdated, backdated)
  return file
}

interface Measurement {
  notifications: number
  mtimeMoved: boolean
}

/**
 * Watches a real file, performs a real write, and reports what the registry
 * did about it. `throughSelfWrite` is the only difference between the two
 * halves — same file, same bytes, same watcher, same settle.
 */
async function measure(throughSelfWrite: boolean): Promise<Measurement> {
  const file = tempFile()
  const registry = createDocumentWatcherRegistry(createFsWatcherDeps())
  let notifications = 0
  await registry.watch('tab-1', file, () => {
    notifications += 1
  })

  const before = statSync(file).mtimeMs
  // Deliberately a different length as well as different content: a same-size
  // overwrite is a weaker stimulus for some watch backends, and this test is
  // about suppression rather than about how little the OS will report.
  const write = (): Promise<void> => writeFile(file, '{"a":2,"note":"changed on disk"}')

  if (throughSelfWrite) await registry.selfWrite(file, write)
  else await write()

  const after = statSync(file).mtimeMs

  if (throughSelfWrite) {
    // Negative: give every event this platform intends to emit room to arrive
    // and be wrong.
    await new Promise((resolve) => setTimeout(resolve, NO_NOTIFICATION_SETTLE_MS))
  } else {
    // Positive: wait for the condition, not a duration (R159). The timeout
    // only turns a silent platform into a failed assertion rather than a hang.
    try {
      await vi.waitFor(() => expect(notifications).toBeGreaterThan(0), {
        interval: POLL_MS,
        timeout: TIMEOUT_MS
      })
    } catch {
      // Left to the assertion in the test, which says what it means.
    }
  }

  registry.unwatch('tab-1')
  return { notifications, mtimeMoved: after !== before }
}

describe('R178 — a real save does not look like an external change', () => {
  it('a bare write notifies, and the same write through selfWrite does not', async () => {
    const bare = await measure(false)

    // The reproduction, and the two things it has to be true of before the
    // suppression below means anything: the write moved the file's timestamp
    // (the registry's own criterion), and the watcher reported it.
    expect(bare.mtimeMoved).toBe(true)
    expect(bare.notifications).toBeGreaterThan(0)

    const guarded = await measure(true)

    // Acceptance 1. Zero, not "fewer" — the count a bare write produces varies
    // by platform and by run (one probe saw two events 1 ms apart, another saw
    // one), so the only stable assertion is that none of them get through.
    expect(guarded.mtimeMoved).toBe(true)
    expect(guarded.notifications).toBe(0)
  })

  it('a genuine external write still notifies after a save through selfWrite', async () => {
    // The failure mode a suppression can easily have: the window never closes,
    // or the baseline is left where the save found it, and external-change
    // detection is quietly dead for the rest of the session.
    const file = tempFile()
    const registry = createDocumentWatcherRegistry(createFsWatcherDeps())
    let notifications = 0
    await registry.watch('tab-1', file, () => {
      notifications += 1
    })

    await registry.selfWrite(file, () => writeFile(file, '{"a":2,"note":"ours"}'))
    await new Promise((resolve) => setTimeout(resolve, NO_NOTIFICATION_SETTLE_MS))
    expect(notifications).toBe(0)

    // Somebody else, now.
    await writeFile(file, '{"a":3,"note":"theirs, and longer than ours was"}')
    await vi.waitFor(() => expect(notifications).toBeGreaterThan(0), {
      interval: POLL_MS,
      timeout: TIMEOUT_MS
    })

    registry.unwatch('tab-1')
  })
})
