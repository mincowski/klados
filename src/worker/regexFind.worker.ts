/// <reference lib="webworker" />
/**
 * R239 (`docs/plans/R239-regex-find.md` §2): regex Find's matching, in a
 * worker the renderer can terminate.
 *
 * A pattern that backtracks catastrophically runs one `exec` for as long as
 * it likes, and nothing on the thread running it can interrupt it: not a
 * keystroke, not Escape, not a timer. So the renderer posts each window here
 * and terminates the worker on a deadline or a cancel. Termination is the
 * only thing that stops a running `exec`.
 *
 * This replaces exactly one call, `decodedTextMatches`, and nothing around
 * it. The renderer decodes the window, applies R204's normalization, and
 * maps the returned indices back to bytes; this file never sees a byte or a
 * row. One worker serves one search and is terminated when it ends.
 *
 * It says `ready` once, when it has loaded, and the renderer posts nothing
 * before that: the per-window deadline then measures matching, not starting a
 * worker. Loading counted against it before, and on a slow `windows-latest`
 * runner a harmless pattern stopped at the first window, as "No matches
 * (stopped)".
 */
import { decodedTextMatches, type TextFindOptions } from '../core/textFind'

export interface RegexFindRequest {
  readonly id: number
  /** The window's normalized text (`PreparedWindow.text`). */
  readonly text: string
  /** The normalized needle (`PreparedWindow.needle`). */
  readonly needle: string
  readonly options: TextFindOptions
}

export type RegexFindResponse =
  /** Posted once, when the worker has loaded. */
  | { readonly ready: true }
  | {
      readonly id: number
      /** In `text`'s UTF-16 coordinates, ascending. */
      readonly matches: ReadonlyArray<{ readonly index: number; readonly length: number }>
    }

// The same discriminator `parse.worker.ts` uses, for the same reason: `self`
// is `window` in the renderer, and a stray value import must not take over
// `window.onmessage`.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (event: MessageEvent<RegexFindRequest>): void => {
    const { id, text, needle, options } = event.data
    postMessage({
      id,
      matches: decodedTextMatches(text, needle, options)
    } satisfies RegexFindResponse)
  }
  postMessage({ ready: true } satisfies RegexFindResponse)
}
