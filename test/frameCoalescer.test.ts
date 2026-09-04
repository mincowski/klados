/**
 * M5c-PLAN.md J2 acceptance: "a synthetic burst of 20 `scroll` events
 * within one frame produces exactly one recentre check and one viewport
 * publish." `createFrameCoalescer` is the piece of that guarantee that
 * doesn't need a real `EditorView`/DOM to test — a fake frame queue stands
 * in for `requestAnimationFrame`.
 */
import { describe, expect, it } from 'vitest'
import { createFrameCoalescer } from '../src/renderer/components/Raw/frameCoalescer'

function fakeFrameQueue(): {
  requestFrame: (cb: FrameRequestCallback) => number
  cancelFrame: (id: number) => void
  flush: () => void
  pendingCount: number
} {
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextId = 1
  return {
    requestFrame: (cb) => {
      const id = nextId++
      callbacks.set(id, cb)
      return id
    },
    cancelFrame: (id) => {
      callbacks.delete(id)
    },
    flush: () => {
      const entries = [...callbacks.entries()]
      callbacks.clear()
      for (const [id, cb] of entries) cb(id)
    },
    get pendingCount() {
      return callbacks.size
    }
  }
}

describe('createFrameCoalescer', () => {
  it('collapses a burst of 20 requests into exactly one queued frame and one work call', () => {
    const queue = fakeFrameQueue()
    const coalescer = createFrameCoalescer(queue.requestFrame, queue.cancelFrame)
    let workCalls = 0

    for (let i = 0; i < 20; i++) coalescer.request(() => workCalls++)

    expect(queue.pendingCount).toBe(1)
    queue.flush()
    expect(workCalls).toBe(1)
  })

  it('schedules a new frame after the pending one fires', () => {
    const queue = fakeFrameQueue()
    const coalescer = createFrameCoalescer(queue.requestFrame, queue.cancelFrame)
    let workCalls = 0

    coalescer.request(() => workCalls++)
    queue.flush()
    coalescer.request(() => workCalls++)
    queue.flush()

    expect(workCalls).toBe(2)
  })

  it('cancel() drops a pending frame so its work never runs', () => {
    const queue = fakeFrameQueue()
    const coalescer = createFrameCoalescer(queue.requestFrame, queue.cancelFrame)
    let workCalls = 0

    coalescer.request(() => workCalls++)
    coalescer.cancel()
    queue.flush()

    expect(workCalls).toBe(0)
    expect(queue.pendingCount).toBe(0)
  })

  it('cancel() with nothing pending is a no-op', () => {
    const queue = fakeFrameQueue()
    const coalescer = createFrameCoalescer(queue.requestFrame, queue.cancelFrame)
    expect(() => coalescer.cancel()).not.toThrow()
  })
})
