/**
 * M5-PLAN.md H4 — the client half of the chunked Transform write path.
 * R27: pools its worker through `workerPool.ts`, same as `parseClient.ts`'s
 * `parseInWorker`/`parseFromUrlInWorker` — see that module's own header.
 * A Transform is a single request/response round trip (`format.format`'s
 * own contract has no progress signal to relay), so this is simpler than
 * the parse functions — no `onProgress`, no partial-result handling.
 */
import type { FormatOptions } from './types'
import type {
  TransformDoneMessage,
  TransformErrorMessage,
  TransformJobRequest,
  WorkerResponse
} from '../worker/parse.worker'
import { acquireWorker, releaseWorker, replaceWorker } from './workerPool'

export interface TransformClientOptions {
  readonly formatId: string
  readonly options: FormatOptions
  readonly signal?: AbortSignal
}

let nextRequestId = 1

/** Resolves with the transformed bytes, transferred back — the caller owns
 * `bytes` (the input `ArrayBuffer`) no longer once this is called, same
 * transfer-detaches-the-sender's-copy rule `parseInWorker` documents.
 * Resolves `null` when the worker found `format()`'s output byte-identical
 * to its input (M5g-PLAN.md O1) — the comparison runs worker-side, where
 * both copies already live, so a no-op never transfers the result back at
 * all. */
export function transformInWorker(
  bytes: ArrayBuffer,
  { formatId, options, signal }: TransformClientOptions
): Promise<ArrayBuffer | null> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Transform aborted', 'AbortError'))
  }

  return acquireWorker().then(
    (worker) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          releaseWorker(worker)
          reject(new DOMException('Transform aborted', 'AbortError'))
          return
        }

        const requestId = nextRequestId++
        let settled = false

        const settleResolve = (result: ArrayBuffer | null): void => {
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

        const onAbort = (): void => {
          // Unlike a parse, a transform has no in-worker `AbortController`
          // to signal — `format.format` is synchronous within the worker
          // and runs to completion once started (same reasoning
          // `parseInWorker`'s own comment gives for why `replaceWorker`,
          // not a `cancel` message, is what actually stops work promptly).
          // Replacing just discards the result once it would have arrived.
          settleReject(new DOMException('Transform aborted', 'AbortError'), true)
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
          const response = event.data
          if (response.requestId !== requestId) return
          if (response.type !== 'transformDone' && response.type !== 'transformError') return
          signal?.removeEventListener('abort', onAbort)

          if (response.type === 'transformError') {
            settleReject(new Error((response as TransformErrorMessage).message), false)
            return
          }
          const done = response as TransformDoneMessage
          settleResolve(done.unchanged ? null : done.bytes)
        }

        worker.onerror = (event: ErrorEvent): void => {
          signal?.removeEventListener('abort', onAbort)
          settleReject(new Error(event.message), true)
        }

        const request: TransformJobRequest = {
          type: 'transform',
          requestId,
          bytes,
          formatId,
          options
        }
        worker.postMessage(request, [bytes])
      })
  )
}
