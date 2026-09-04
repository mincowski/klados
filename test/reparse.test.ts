import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDebouncedReparse } from '../src/renderer/session/reparse'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createDebouncedReparse', () => {
  it('does not call run before the delay elapses', () => {
    const run = vi.fn()
    const scheduler = createDebouncedReparse(run, 200)
    scheduler.trigger()
    vi.advanceTimersByTime(199)
    expect(run).not.toHaveBeenCalled()
  })

  it('calls run once the delay elapses', () => {
    const run = vi.fn()
    const scheduler = createDebouncedReparse(run, 200)
    scheduler.trigger()
    vi.advanceTimersByTime(200)
    expect(run).toHaveBeenCalledOnce()
  })

  it('a burst of triggers produces exactly one call (F3 acceptance)', () => {
    const run = vi.fn()
    const scheduler = createDebouncedReparse(run, 200)
    for (let i = 0; i < 20; i++) {
      scheduler.trigger()
      vi.advanceTimersByTime(50) // well under the 200ms delay each time
    }
    expect(run).not.toHaveBeenCalled() // still mid-burst, timer keeps resetting
    vi.advanceTimersByTime(200)
    expect(run).toHaveBeenCalledOnce()
  })

  it('a pause longer than the delay between two bursts produces two calls', () => {
    const run = vi.fn()
    const scheduler = createDebouncedReparse(run, 200)
    scheduler.trigger()
    vi.advanceTimersByTime(200)
    expect(run).toHaveBeenCalledOnce()

    scheduler.trigger()
    vi.advanceTimersByTime(200)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('cancel prevents a pending call from firing', () => {
    const run = vi.fn()
    const scheduler = createDebouncedReparse(run, 200)
    scheduler.trigger()
    vi.advanceTimersByTime(100)
    scheduler.cancel()
    vi.advanceTimersByTime(200)
    expect(run).not.toHaveBeenCalled()
  })

  it('cancel with nothing pending is a safe no-op', () => {
    const run = vi.fn()
    const scheduler = createDebouncedReparse(run, 200)
    expect(() => scheduler.cancel()).not.toThrow()
    expect(run).not.toHaveBeenCalled()
  })

  it('triggering again after cancel still schedules a fresh call', () => {
    const run = vi.fn()
    const scheduler = createDebouncedReparse(run, 200)
    scheduler.trigger()
    scheduler.cancel()
    scheduler.trigger()
    vi.advanceTimersByTime(200)
    expect(run).toHaveBeenCalledOnce()
  })

  it('defaults to REPARSE_DEBOUNCE_MS when no delay is given', async () => {
    const { REPARSE_DEBOUNCE_MS } = await import('../src/renderer/session/reparse')
    const run = vi.fn()
    const scheduler = createDebouncedReparse(run)
    scheduler.trigger()
    vi.advanceTimersByTime(REPARSE_DEBOUNCE_MS - 1)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledOnce()
  })
})
