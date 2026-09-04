/**
 * `parseInWorker` needs a real `Worker`, which Vitest's node environment
 * doesn't have (same reason `worker/parse.worker.ts`'s own tests exercise
 * `runParseJob` directly instead) — so only the parts reachable without
 * ever constructing one are unit-tested here.
 */
import { describe, expect, it } from 'vitest'
import { parseInWorker } from '../src/core/parseClient'

describe('parseInWorker — already-aborted signal (D6 regression)', () => {
  it('rejects immediately with AbortError, never constructing a Worker', async () => {
    const controller = new AbortController()
    controller.abort()

    const bytes = new TextEncoder().encode('{}').buffer as ArrayBuffer
    // `new Worker(...)` inside `parseInWorker` would throw under Vitest's
    // node environment (no such global) if this path reached it — a
    // rejection here, rather than that throw, is what proves the
    // already-aborted check runs first.
    await expect(
      parseInWorker(bytes, { filename: 'x.json', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
