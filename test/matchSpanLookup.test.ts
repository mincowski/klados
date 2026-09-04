import { describe, expect, it } from 'vitest'
import { countMatchesInRange, hasMatchInRange } from '../src/renderer/navigation/matchSpanLookup'

describe('hasMatchInRange', () => {
  const starts = Int32Array.from([5, 10, 10, 20, 50])

  it('finds a match inside the range', () => {
    expect(hasMatchInRange(starts, 8, 15)).toBe(true)
  })
  it('is false for an empty match set', () => {
    expect(hasMatchInRange(new Int32Array(0), 0, 100)).toBe(false)
  })
  it('is false when nothing falls in range', () => {
    expect(hasMatchInRange(starts, 21, 49)).toBe(false)
  })
  it('is exclusive of the range end', () => {
    expect(hasMatchInRange(starts, 0, 5)).toBe(false)
    expect(hasMatchInRange(starts, 0, 6)).toBe(true)
  })
  it('is inclusive of the range start', () => {
    expect(hasMatchInRange(starts, 5, 6)).toBe(true)
  })
  it('is false for an empty or inverted range', () => {
    expect(hasMatchInRange(starts, 10, 10)).toBe(false)
    expect(hasMatchInRange(starts, 10, 5)).toBe(false)
  })
})

describe('countMatchesInRange', () => {
  const starts = Int32Array.from([5, 10, 10, 20, 50])

  it('counts duplicated offsets', () => {
    expect(countMatchesInRange(starts, 10, 11)).toBe(2)
  })
  it('counts the whole set for an all-covering range', () => {
    expect(countMatchesInRange(starts, 0, 1000)).toBe(5)
  })
  it('is zero for an empty match set', () => {
    expect(countMatchesInRange(new Int32Array(0), 0, 100)).toBe(0)
  })
  it('is zero for an empty or inverted range', () => {
    expect(countMatchesInRange(starts, 10, 10)).toBe(0)
    expect(countMatchesInRange(starts, 10, 5)).toBe(0)
  })
})
