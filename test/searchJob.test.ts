import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JobSlot, runChunkedJob, type StepResult } from '../src/renderer/session/searchJob'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** A counting step that always exceeds the slice budget (`sliceMs: 0`
 * forces exactly one step per timer tick — deterministic under fake
 * timers, since real elapsed time is unavailable/unreliable there). */
function countUpTo(target: number): (state: number) => StepResult<number, number> {
  return (state) =>
    state >= target ? { done: true, value: state } : { done: false, state: state + 1 }
}

describe('runChunkedJob', () => {
  it('resolves with the final value', async () => {
    const job = runChunkedJob(0, countUpTo(3), { sliceMs: 0 })
    await vi.runAllTimersAsync()
    await expect(job.result).resolves.toBe(3)
  })

  it('yields between slices — never runs to completion synchronously', async () => {
    const job = runChunkedJob(0, countUpTo(5), { sliceMs: 0 })
    let settled = false
    void job.result.then(() => {
      settled = true
    })
    // Nothing has run yet — the first slice is scheduled via setTimeout(0).
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    // One step per tick (sliceMs: 0) — not done after a single tick.
    expect(settled).toBe(false)
    await vi.runAllTimersAsync()
    expect(settled).toBe(true)
  })

  it('reports progress at each slice boundary', async () => {
    const progress: number[] = []
    const job = runChunkedJob(0, countUpTo(4), {
      sliceMs: 0,
      onProgress: (state) => progress.push(state)
    })
    await vi.runAllTimersAsync()
    await job.result
    // sliceMs: 0 means one step per tick; each intermediate (non-final)
    // state is reported, including the state right before the slice that
    // discovers it's actually done.
    expect(progress).toEqual([1, 2, 3, 4])
  })

  it('cancelling rejects the result and stops further steps', async () => {
    let stepCalls = 0
    const step = (state: number): StepResult<number, number> => {
      stepCalls++
      return { done: false, state: state + 1 }
    }
    const job = runChunkedJob(0, step, { sliceMs: 0 })
    await vi.advanceTimersByTimeAsync(0) // let one slice run
    const callsAtCancel = stepCalls
    job.cancel()
    await expect(job.result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.runAllTimersAsync()
    // No slice scheduled after cancel ever calls `step` again.
    expect(stepCalls).toBe(callsAtCancel)
  })

  it('cancelling before the first slice runs still rejects cleanly', async () => {
    const job = runChunkedJob(0, countUpTo(3), { sliceMs: 0 })
    job.cancel()
    await expect(job.result).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a slice keeps stepping past a very generous budget without yielding early', async () => {
    // sliceMs large enough that everything fits in one slice.
    const job = runChunkedJob(0, countUpTo(10), { sliceMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    await expect(job.result).resolves.toBe(10)
  })
})

describe('JobSlot', () => {
  it('starting a new job cancels the previous one in the slot', async () => {
    const slot = new JobSlot<number>()
    const first = slot.start(() => runChunkedJob(0, countUpTo(5), { sliceMs: 0 }))
    await vi.advanceTimersByTimeAsync(0) // let the first job make some progress

    const second = slot.start(() => runChunkedJob(100, countUpTo(103), { sliceMs: 0 }))

    await expect(first.result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.runAllTimersAsync()
    await expect(second.result).resolves.toBe(103)
  })

  it('two starts a tick apart land exactly the later result — the supersede rule', async () => {
    const slot = new JobSlot<number>()
    const landed: string[] = []

    const runOne = (label: string, target: number): void => {
      const job = slot.start(() => runChunkedJob(0, countUpTo(target), { sliceMs: 0 }))
      job.result.then(
        () => landed.push(label),
        () => {
          /* superseded — expected, not a landing */
        }
      )
    }

    runOne('first', 5)
    await vi.advanceTimersByTimeAsync(0)
    runOne('second', 2)
    await vi.runAllTimersAsync()

    expect(landed).toEqual(['second'])
  })

  it('cancel() clears the slot so a later cancel() is a harmless no-op', async () => {
    const slot = new JobSlot<number>()
    slot.start(() => runChunkedJob(0, countUpTo(3), { sliceMs: 0 }))
    slot.cancel()
    expect(() => slot.cancel()).not.toThrow()
  })
})
