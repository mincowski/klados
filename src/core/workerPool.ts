/**
 * R27 (`R24-tabs.md` §5, `CONCEPT.md` §11.4): "a small fixed pool
 * (2–3) with a queue, not one worker per tab." Before this,
 * `parseClient.ts` and `transformClient.ts` each spawned a fresh `Worker`
 * per call and terminated it on completion or cancellation — already close
 * to a pool of one, per §5's own framing. This generalizes that pattern to
 * `POOL_SIZE` long-lived workers shared across every caller (parse,
 * parseFromUrl, transform), queued when all are busy rather than spawning
 * without bound.
 *
 * A pooled worker is single-purpose for the lifetime of one job: a caller
 * `acquireWorker()`s it, sets its own `onmessage`/`onerror` (the previous
 * job's handlers are cleared on release, so there's never a stale listener
 * from an earlier job), posts its request, and either `releaseWorker`s it
 * back on a clean finish or `replaceWorker`s it on cancellation/crash.
 * Never two jobs share one worker concurrently — that is what the queue
 * is for, not an optimization to skip.
 */
const POOL_SIZE = 3

function spawnWorker(): Worker {
  return new Worker(new URL('../worker/parse.worker.ts', import.meta.url), {
    type: 'module'
  })
}

let pool: Worker[] | null = null
const free: Worker[] = []
const waiters: Array<(worker: Worker) => void> = []

function ensurePool(): void {
  if (pool !== null) return
  pool = Array.from({ length: POOL_SIZE }, spawnWorker)
  free.push(...pool)
}

/**
 * Resolves with a free worker — immediately if one is idle, otherwise once
 * one is released or replaced. The pool itself is created lazily, on the
 * first call, rather than at module load: constructing a `Worker` is not
 * something a module import should have as a side effect, and it lets
 * `parseInWorker`'s own already-aborted check (`options.signal?.aborted`)
 * keep rejecting *before* ever reaching this function — `test/parseClient
 * .test.ts` asserts exactly that ordering (a real `Worker` throws under
 * Vitest's node environment, so a regression there would fail loudly).
 */
export function acquireWorker(): Promise<Worker> {
  ensurePool()
  const worker = free.shift()
  if (worker !== undefined) return Promise.resolve(worker)
  return new Promise((resolve) => waiters.push(resolve))
}

/** A clean finish — the worker is trusted to be reusable. Handlers are
 * cleared here, not left for the next acquirer to overwrite, so a worker
 * sitting idle in `free` never has a stale `onmessage` armed. */
export function releaseWorker(worker: Worker): void {
  worker.onmessage = null
  worker.onerror = null
  const waiter = waiters.shift()
  if (waiter !== undefined) {
    waiter(worker)
    return
  }
  free.push(worker)
}

/**
 * Cancellation or a worker-thread crash: the worker may be mid-synchronous
 * job (parsing/formatting is not interruptible mid-call — `parseClient.ts`'s
 * own comment on why `terminate()`, not a posted `cancel` message, is what
 * actually stops work promptly) and cannot be trusted to still be usable.
 * Terminates it and swaps in a freshly spawned replacement so the pool
 * stays at `POOL_SIZE` — the same "terminate the worker" behaviour this
 * codebase always had, except now the *pool slot* survives the individual
 * worker instance instead of being torn down and rebuilt by the next
 * caller.
 */
export function replaceWorker(worker: Worker): void {
  worker.onmessage = null
  worker.onerror = null
  worker.terminate()
  const replacement = spawnWorker()
  if (pool !== null) {
    const index = pool.indexOf(worker)
    if (index !== -1) pool[index] = replacement
  }
  const waiter = waiters.shift()
  if (waiter !== undefined) {
    waiter(replacement)
    return
  }
  free.push(replacement)
}

/** For measurement (R30) and diagnostics — not read by any caller yet. */
export function getWorkerPoolStats(): {
  readonly size: number
  readonly free: number
  readonly queued: number
} {
  return { size: pool?.length ?? 0, free: free.length, queued: waiters.length }
}

/** Test-only: tears the pool down so each test starts clean, the same role
 * `resetTabsForTests` plays for `session/tabs.ts`. */
export function resetWorkerPoolForTests(): void {
  pool?.forEach((worker) => worker.terminate())
  pool = null
  free.length = 0
  waiters.length = 0
}
