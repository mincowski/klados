import { SourceBuffer } from './buffer'
import { Interner } from './interner'
import type { NameIndex } from './nameIndex'
import { NodeStore } from './nodeStore'
import type { LineIndex } from './rowIndex'
import type { Diagnostic } from './types'
import type {
  CancelRequest,
  ParseDoneMessage,
  ParseFromUrlJobRequest,
  ParseJobRequest,
  WorkerResponse
} from '../worker/parse.worker'
import { acquireWorker, releaseWorker, replaceWorker } from './workerPool'

/** M5-PLAN.md H12. Must match `main/documents.ts`'s own copy of this string
 * exactly — see that file's own doc comment on why it's duplicated rather
 * than shared through one module (separate TypeScript projects,
 * `tsconfig.node.json` vs this file's `tsconfig.web.json`/
 * `tsconfig.worker.json`). */
const READ_TOKEN_SCHEME = 'klados-file'

/** The host component carries the token — `URL`'s own parsing is what
 * `main/documents.ts`'s protocol handler reads it back out with
 * (`new URL(request.url).hostname`), so this is the one place that shape
 * is decided; keep both ends in sync if it ever changes. */
export function readTokenUrl(token: string): string {
  return `${READ_TOKEN_SCHEME}://${token}/`
}

export interface ParseClientResult {
  readonly store: NodeStore
  /** Wraps the same bytes as `sourceBuffer.bytes`, at `sourceBuffer.encoding` — kept
   * as its own fields too since callers that only need the resolved encoding (the Raw
   * View deciding how to decode a window, §4.4) shouldn't have to reach through it. */
  readonly sourceBuffer: SourceBuffer
  readonly encoding: string
  readonly bomLength: number
  readonly rowIndex: Int32Array
  readonly lineIndex: LineIndex
  /** M4-PLAN.md G1: `nameId → node refs`, built in the worker (or by
   * `trySpliceReparse` when a splice produces a new store outside the
   * worker) — never lazily by a consumer, so it can never be read stale
   * against `store`. */
  readonly nameIndex: NameIndex
  readonly diagnostics: readonly Diagnostic[]
  readonly complete: boolean
  readonly bytesConsumed: number
  readonly formatId: string
}

export interface ParseClientOptions {
  readonly filename: string | null
  readonly maxDepth?: number
  readonly signal?: AbortSignal
  readonly onProgress?: (bytesConsumed: number) => void
}

/**
 * Rebuilds a `ParseClientResult` from a worker's `done` message — the store,
 * interner and source buffer reconstruction that `handleWorkerMessage` needs
 * for a real `postMessage` round trip, factored out so `documentSession.ts`'s
 * tests can drive `runParseJob` directly (no real `Worker` in Vitest) and
 * still exercise the exact same rehydration path production code does.
 */
export function rehydrateParseResult(response: ParseDoneMessage): ParseClientResult {
  const interner = Interner.fromBuffers(
    response.internerBuffers.nameBytes,
    response.internerBuffers.starts,
    response.internerBuffers.ends,
    response.hasNamespaces
  )
  const bytes = new Uint8Array(response.bytes)
  const store = NodeStore.fromBuffers(
    bytes,
    interner,
    response.storeBuffers,
    response.namespaceState
  )
  const sourceBuffer = new SourceBuffer(bytes, response.encoding, response.bomLength)
  return {
    store,
    sourceBuffer,
    encoding: response.encoding,
    bomLength: response.bomLength,
    rowIndex: response.rowIndex,
    lineIndex: response.lineIndex,
    nameIndex: response.nameIndex,
    diagnostics: response.diagnostics,
    complete: response.complete,
    bytesConsumed: response.bytesConsumed,
    formatId: response.formatId
  }
}

let nextRequestId = 1

/**
 * R27: acquires a worker from the shared pool (`workerPool.ts`) rather than
 * spawning and terminating one per call — see that module's own header for
 * why. Queued (via `acquireWorker`'s own promise) when all pool workers are
 * busy, rather than spawning without bound.
 */
export function parseInWorker(
  bytes: ArrayBuffer,
  options: ParseClientOptions
): Promise<ParseClientResult> {
  // A signal that is *already* aborted when this is called — e.g. a caller
  // that starts an async read before the parse and lets the same
  // `AbortController` cover both — must reject here rather than fall
  // through to the `addEventListener('abort', ...)` below: the 'abort'
  // event has already fired once and does not replay for a listener added
  // afterward, so that listener would simply never run and the parse
  // would proceed to completion, ignoring the cancellation entirely. This
  // also keeps the check ahead of `acquireWorker()`, which lazily spawns
  // the pool on first use — a real `Worker` `test/parseClient.test.ts`
  // relies on never being reached here.
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException('Parse aborted', 'AbortError'))
  }

  return acquireWorker().then(
    (worker) =>
      new Promise((resolve, reject) => {
        // The wait for a free worker is itself async — a signal that fired
        // while queued needs the same early-reject check, or a
        // queued-then-cancelled request would run anyway once a worker
        // finally frees up.
        if (options.signal?.aborted) {
          releaseWorker(worker)
          reject(new DOMException('Parse aborted', 'AbortError'))
          return
        }

        const requestId = nextRequestId++
        // `claimed` guards against acting on more than one terminal message
        // (a done/error racing an abort, or a duplicate message) — it is set
        // the instant a handler decides it owns the outcome, before doing any
        // work that might throw. `settled` tracks whether `resolve`/`reject`
        // has actually been called, which can lag `claimed` by the width of a
        // `try` block (D0.2): the handler that claims the outcome may still
        // fail while producing it, and must be able to reject even though it
        // already set `claimed`.
        let claimed = false
        let settled = false

        const settleResolve = (result: ParseClientResult): void => {
          if (settled) return
          settled = true
          releaseWorker(worker)
          resolve(result)
        }

        // `replace`: whether the worker is trustworthy to reuse. A clean
        // 'error' response (a parse error, not a crash) still leaves the
        // worker itself fine — only a cancel or a genuine `onerror` needs
        // `replaceWorker`'s terminate-and-respawn.
        const settleReject = (err: unknown, replace: boolean): void => {
          if (settled) return
          settled = true
          if (replace) replaceWorker(worker)
          else releaseWorker(worker)
          reject(err instanceof Error ? err : new Error(String(err)))
        }

        // The worker is single-threaded and `parse()` runs synchronously, so
        // a posted `cancel` message cannot be dequeued — and therefore
        // cannot reach the in-worker AbortController — until the parse has
        // already finished. `replaceWorker` (terminate, then swap in a
        // fresh pool member) is what actually stops it immediately (C5);
        // the `cancel` message stays wired for the in-worker path §6.6
        // would eventually want, but it is not what makes cancellation work
        // today.
        const onAbort = (): void => {
          const message: CancelRequest = { type: 'cancel', requestId }
          worker.postMessage(message)
          if (claimed) return
          claimed = true
          settleReject(new DOMException('Parse aborted', 'AbortError'), true)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })

        worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
          // D0.2: a throw anywhere in `handleWorkerMessage` (e.g. an
          // unrecognized encoding label reaching `SourceBuffer`'s
          // `TextDecoder`) used to land after the dedup guard had already
          // fired but before cleanup ran, leaving the promise permanently
          // unsettled and the worker leaked. This catch is the backstop for
          // the whole class, not just that one call site.
          try {
            handleWorkerMessage(event)
          } catch (err) {
            settleReject(err, true)
          }
        }

        function handleWorkerMessage(event: MessageEvent<WorkerResponse>): void {
          const response = event.data
          if (response.requestId !== requestId) return

          if (response.type === 'progress') {
            options.onProgress?.(response.bytesConsumed)
            return
          }

          if (claimed) return
          claimed = true
          options.signal?.removeEventListener('abort', onAbort)

          if (response.type === 'error') {
            settleReject(new Error(response.message), false)
            return
          }

          // This worker instance only ever receives a 'parse' request, so it
          // can only ever get 'progress' | 'done' | 'error' back — the
          // transform message variants exist only for `transformClient.ts`'s
          // own worker instances. Narrows `WorkerResponse` down to
          // `ParseDoneMessage` for `rehydrateParseResult`, which is typed
          // against that alone.
          if (response.type !== 'done') return

          const result = rehydrateParseResult(response)
          settleResolve(result)
        }

        worker.onerror = (event: ErrorEvent): void => {
          if (claimed) return
          claimed = true
          options.signal?.removeEventListener('abort', onAbort)
          settleReject(new Error(event.message), true)
        }

        const request: ParseJobRequest = {
          type: 'parse',
          requestId,
          bytes,
          filename: options.filename,
          maxDepth: options.maxDepth
        }
        worker.postMessage(request, [bytes])
      })
  )
}

/**
 * M5-PLAN.md H12 — the production route H11's spike (D-047) measured at
 * ~1.0× peak RSS in the fetching process. R27: same pooled shape as
 * `parseInWorker` (`claimed`/`settled` dedup, `replaceWorker` as the real
 * cancellation mechanism — see that function's own comments, which all
 * apply unchanged here), except there is nothing to transfer: the worker
 * fetches the document itself, over `url` (built by `readTokenUrl` from a
 * token `documentSession.ts` already minted via `api.document.mintReadToken`),
 * rather than receiving bytes the caller already had in hand.
 */
export function parseFromUrlInWorker(
  url: string,
  options: ParseClientOptions
): Promise<ParseClientResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException('Parse aborted', 'AbortError'))
  }

  return acquireWorker().then(
    (worker) =>
      new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
          releaseWorker(worker)
          reject(new DOMException('Parse aborted', 'AbortError'))
          return
        }

        const requestId = nextRequestId++
        let claimed = false
        let settled = false

        const settleResolve = (result: ParseClientResult): void => {
          if (settled) return
          settled = true
          releaseWorker(worker)
          resolve(result)
        }

        const settleReject = (err: unknown, replace: boolean): void => {
          if (settled) return
          settled = true
          if (replace) replaceWorker(worker)
          else releaseWorker(worker)
          reject(err instanceof Error ? err : new Error(String(err)))
        }

        // Same caveat `parseInWorker`'s own comment makes: a `cancel`
        // message can't interrupt a fetch or a synchronous parse already
        // underway in a single-threaded worker — `replaceWorker` below is
        // what actually stops it.
        const onAbort = (): void => {
          const message: CancelRequest = { type: 'cancel', requestId }
          worker.postMessage(message)
          if (claimed) return
          claimed = true
          settleReject(new DOMException('Parse aborted', 'AbortError'), true)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })

        worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
          try {
            handleWorkerMessage(event)
          } catch (err) {
            settleReject(err, true)
          }
        }

        function handleWorkerMessage(event: MessageEvent<WorkerResponse>): void {
          const response = event.data
          if (response.requestId !== requestId) return

          if (response.type === 'progress') {
            options.onProgress?.(response.bytesConsumed)
            return
          }

          if (claimed) return
          claimed = true
          options.signal?.removeEventListener('abort', onAbort)

          if (response.type === 'error') {
            settleReject(new Error(response.message), false)
            return
          }

          if (response.type !== 'done') return

          const result = rehydrateParseResult(response)
          settleResolve(result)
        }

        worker.onerror = (event: ErrorEvent): void => {
          if (claimed) return
          claimed = true
          options.signal?.removeEventListener('abort', onAbort)
          settleReject(new Error(event.message), true)
        }

        const request: ParseFromUrlJobRequest = {
          type: 'parseFromUrl',
          requestId,
          url,
          filename: options.filename,
          maxDepth: options.maxDepth
        }
        worker.postMessage(request)
      })
  )
}
