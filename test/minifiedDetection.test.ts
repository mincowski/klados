import { describe, expect, it } from 'vitest'
import { isPathologicallyMinified } from '../src/renderer/session/minifiedDetection'

describe('isPathologicallyMinified (M5-PLAN.md H8)', () => {
  it('offers for a genuinely minified single-line document', () => {
    // One row for a 10 KB document — far above the threshold.
    expect(isPathologicallyMinified(1, 10_000)).toBe(true)
  })

  it('does not offer for a pretty-printed, short-line document', () => {
    // 500 rows averaging 40 bytes each.
    expect(isPathologicallyMinified(500, 20_000)).toBe(false)
  })

  it('does not offer for a document that is merely long-lined in places', () => {
    // Mean row length just under the threshold.
    expect(isPathologicallyMinified(100, 100 * 199)).toBe(false)
  })

  it('offers right at and above the threshold boundary', () => {
    expect(isPathologicallyMinified(100, 100 * 201, 200)).toBe(true)
    expect(isPathologicallyMinified(100, 100 * 200, 200)).toBe(false)
  })

  it('handles an empty document without dividing by zero', () => {
    expect(isPathologicallyMinified(0, 0)).toBe(false)
    expect(isPathologicallyMinified(0, 100)).toBe(false)
  })

  it('a custom threshold is honored', () => {
    expect(isPathologicallyMinified(1, 50, 40)).toBe(true)
    expect(isPathologicallyMinified(1, 50, 60)).toBe(false)
  })
})
