/**
 * R239 (`docs/plans/R239-regex-find.md` §2): regex Find, matched in a worker
 * that a deadline or a cancel terminates.
 *
 * `runChunkedJob` slices the work **between** windows, and that is enough for
 * every search that cannot backtrack. A regex can: `(a+)+$` against thirty
 * `a` and a `b` runs one `exec` for about 19 s in the renderer (measured,
 * §6), and no keystroke, Escape or timer is processed until it returns. The
 * window freezes, and killing the process loses every tab's unsaved edits.
 *
 * So regex mode moves one call, `decodedTextMatches`, into a dedicated worker
 * and leaves everything around it here, in the same order as
 * `findDecodedInWindow`: decode and normalize the window
 * (`prepareDecodedWindow`), post the normalized text and needle, then map the
 * returned indices to bytes (`mapWindowMatches`). One window is decoded at a
 * time, with one copy of its text in flight.
 *
 * **Termination is the only cancel.** A message to a worker stuck in `exec`
 * would never be read. A new query, Escape, a document switch and the
 * deadline all terminate the worker; a finished search terminates it too, so
 * no worker outlives its search. This does not contradict D-041: matching
 * never touches the node store, only one window of text and the needle (D-123).
 */
import {
  decodedWindowsFor,
  mapWindowMatches,
  prepareDecodedWindow,
  type MatchSet,
  type PreparedWindow,
  type TextFindOptions
} from '../../core/textFind'
import type { RegexFindRequest, RegexFindResponse } from '../../worker/regexFind.worker'
import type { SearchJob } from './searchJob'

/**
 * How long one window may take before the search gives up — 2 s, decided by
 * the project lead on 2026-10-17 (D-123). An ordinary regex takes about
 * 0.18 ms a window (R205), so this is roughly 10,000× that. It no longer
 * protects the window, which stays responsive whatever the pattern does; it
 * only decides when Klados stops on its own rather than keeping a core busy.
 *
 * It measures matching only: the first window is posted when the worker says
 * it is `ready`, so loading the worker never counts against it.
 */
export const REGEX_WINDOW_DEADLINE_MS = 2000

export interface RegexFindValue extends MatchSet {
  /** `true` when a window passed the deadline: `starts`/`ends` hold only the
   * matches found in the windows before it. */
  readonly timedOut: boolean
}

/** The part of `Worker` this job uses, so a test can supply its own. */
export interface RegexFindWorker {
  onmessage: ((event: MessageEvent<RegexFindResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: RegexFindRequest): void
  terminate(): void
}

export interface RegexFindInput {
  readonly bytes: Uint8Array
  readonly rowIndex: Int32Array
  readonly encoding: string
  readonly needle: string
  readonly options: TextFindOptions
}

export interface RegexFindDeps {
  readonly spawn?: () => RegexFindWorker
  readonly deadlineMs?: number
}

function spawnRegexFindWorker(): RegexFindWorker {
  return new Worker(new URL('../../worker/regexFind.worker.ts', import.meta.url), {
    type: 'module'
  })
}

let liveWorkers = 0
let spawnedWorkers = 0

/** Search workers spawned and not yet terminated. Criterion 2's test hook:
 * after a cancel this must return to 0. */
export function liveRegexFindWorkers(): number {
  return liveWorkers
}

/** Search workers spawned since the page loaded. R241's test hook: a pattern
 * that does not compile must start none. */
export function spawnedRegexFindWorkers(): number {
  return spawnedWorkers
}

export function runRegexFindJob(
  input: RegexFindInput,
  deps: RegexFindDeps = {}
): SearchJob<RegexFindValue> {
  const { bytes, rowIndex, encoding, needle, options } = input
  const deadlineMs = deps.deadlineMs ?? REGEX_WINDOW_DEADLINE_MS
  const windows = decodedWindowsFor(rowIndex)
  const starts: number[] = []
  const ends: number[] = []

  let resolveResult!: (value: RegexFindValue) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<RegexFindValue>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  let settled = false
  let worker: RegexFindWorker | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  let pending: PreparedWindow | null = null
  let windowIndex = 0

  function stopWorker(): void {
    if (deadline !== null) clearTimeout(deadline)
    deadline = null
    pending = null
    if (worker === null) return
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    worker = null
    liveWorkers--
  }

  function finish(timedOut: boolean): void {
    if (settled) return
    settled = true
    stopWorker()
    resolveResult({ starts: Int32Array.from(starts), ends: Int32Array.from(ends), timedOut })
  }

  function postNext(): void {
    if (windowIndex >= windows.length) {
      finish(false)
      return
    }
    pending = prepareDecodedWindow(
      bytes,
      rowIndex,
      encoding,
      needle,
      windows[windowIndex]!,
      bytes.length
    )
    worker!.postMessage({ id: windowIndex, text: pending.text, needle: pending.needle, options })
    deadline = setTimeout(() => finish(true), deadlineMs)
  }

  function onMessage(event: MessageEvent<RegexFindResponse>): void {
    if (settled) return
    if ('ready' in event.data) {
      // The worker has loaded: now the first window, and its deadline.
      if (pending === null && windowIndex === 0) postNext()
      return
    }
    if (pending === null || event.data.id !== windowIndex) return
    if (deadline !== null) clearTimeout(deadline)
    deadline = null
    const chunk = mapWindowMatches(pending, event.data.matches, rowIndex, encoding)
    for (let i = 0; i < chunk.starts.length; i++) {
      starts.push(chunk.starts[i]!)
      ends.push(chunk.ends[i]!)
    }
    windowIndex++
    postNext()
  }

  // Started on a later task, as `runChunkedJob` starts its first slice, so a
  // caller that cancels synchronously never spawns a worker at all.
  setTimeout(() => {
    if (settled) return
    if (windows.length === 0) {
      finish(false)
      return
    }
    worker = (deps.spawn ?? spawnRegexFindWorker)()
    liveWorkers++
    spawnedWorkers++
    worker.onmessage = onMessage
    worker.onerror = (event) => {
      if (settled) return
      settled = true
      stopWorker()
      rejectResult(new Error(`Regex search worker failed: ${event.message}`))
    }
    // Nothing is posted until the worker says `ready` (`onMessage`).
  }, 0)

  return {
    result,
    cancel(): void {
      if (settled) return
      settled = true
      stopWorker()
      rejectResult(new DOMException('Search job cancelled', 'AbortError'))
    }
  }
}
