/**
 * `DEFAULT_MAX_DEPTH`, shared between `worker/parse.worker.ts` (a full
 * parse) and `renderer/session/documentSession.ts` (`trySpliceReparse`,
 * M3 D-036) so both use the exact same depth limit rather than two
 * constants that could silently drift apart.
 *
 * Deliberately its own file, not re-exported from `parse.worker.ts`
 * itself: that module's own top comment explains it runs in a Web Worker,
 * and its bottom-of-file `self.onmessage = ...` registration is a real
 * side effect gated on `typeof self.postMessage === 'function'` — a check
 * that does not actually distinguish a `WorkerGlobalScope` from a
 * `Window` (`self === window` in a renderer, and `window.postMessage` is
 * a real function too). Every existing cross-boundary reference to that
 * module is `import type` for exactly this reason (`core/parseClient.ts`)
 * — a *value* import pulls the whole module, side effect included, into
 * whatever bundle imports it. `documentSession.ts` needing one plain
 * number is not worth reintroducing that risk; this file has no worker
 * code in it at all, so importing it has no side effect to worry about.
 */
export const DEFAULT_MAX_DEPTH = 10_000
