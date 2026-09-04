/**
 * UI-FEEDBACK.md M5b's Raw → Scrubber channel — the quantize-then-compare
 * logic is the one part of `rawViewportStore.ts` worth testing directly:
 * it's what keeps a scroll-per-frame publisher from notifying its
 * subscriber (the scrubber thumb) on every single frame.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearRawViewport,
  getRawViewport,
  publishRawViewport,
  subscribeRawViewport
} from '../src/renderer/components/Raw/rawViewportStore'

afterEach(() => {
  clearRawViewport()
})

describe('rawViewportStore', () => {
  it('starts empty', () => {
    expect(getRawViewport()).toEqual({ topRatio: 0, bottomRatio: 0 })
  })

  it('publishes a clamped, quantized ratio pair', () => {
    publishRawViewport(0.25, 0.5)
    expect(getRawViewport()).toEqual({ topRatio: 0.25, bottomRatio: 0.5 })
  })

  it('clamps ratios outside [0, 1]', () => {
    publishRawViewport(-0.5, 1.5)
    expect(getRawViewport()).toEqual({ topRatio: 0, bottomRatio: 1 })
  })

  it('notifies subscribers on a real change', () => {
    let calls = 0
    const unsubscribe = subscribeRawViewport(() => calls++)
    publishRawViewport(0.1, 0.2)
    expect(calls).toBe(1)
    unsubscribe()
  })

  it('does not notify when the quantized value is unchanged', () => {
    publishRawViewport(0.1, 0.2)
    let calls = 0
    const unsubscribe = subscribeRawViewport(() => calls++)
    // Well within one quantization step of the already-published value.
    publishRawViewport(0.1 + 1e-9, 0.2 - 1e-9)
    expect(calls).toBe(0)
    unsubscribe()
  })

  it('clear resets to empty and notifies once', () => {
    publishRawViewport(0.3, 0.6)
    let calls = 0
    const unsubscribe = subscribeRawViewport(() => calls++)
    clearRawViewport()
    expect(getRawViewport()).toEqual({ topRatio: 0, bottomRatio: 0 })
    expect(calls).toBe(1)
    unsubscribe()
  })

  it('clear on an already-empty store is a no-op', () => {
    let calls = 0
    const unsubscribe = subscribeRawViewport(() => calls++)
    clearRawViewport()
    expect(calls).toBe(0)
    unsubscribe()
  })
})
