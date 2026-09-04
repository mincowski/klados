import { describe, expect, it } from 'vitest'
import {
  matchIndexAtOrAfter,
  matchIndexBefore,
  nextMatchIndex,
  previousMatchIndex
} from '../src/renderer/navigation/matchNavigation'

describe('matchIndexAtOrAfter / matchIndexBefore', () => {
  const starts = Int32Array.from([10, 20, 30])

  it('finds the match at or after an offset', () => {
    expect(matchIndexAtOrAfter(starts, 15)).toBe(1)
    expect(matchIndexAtOrAfter(starts, 20)).toBe(1)
  })
  it('wraps to the first match past the end', () => {
    expect(matchIndexAtOrAfter(starts, 100)).toBe(0)
  })
  it('is null with no matches', () => {
    expect(matchIndexAtOrAfter(new Int32Array(0), 0)).toBeNull()
  })
  it('finds the match before an offset', () => {
    expect(matchIndexBefore(starts, 25)).toBe(1)
    expect(matchIndexBefore(starts, 20)).toBe(0)
  })
  it('wraps to the last match before the start', () => {
    expect(matchIndexBefore(starts, 0)).toBe(2)
  })
})

describe('nextMatchIndex / previousMatchIndex', () => {
  const starts = Int32Array.from([10, 20, 30])

  it('starts from the caret when there is no current match', () => {
    expect(nextMatchIndex(starts, null, 15)).toBe(1)
    expect(previousMatchIndex(starts, null, 15)).toBe(0)
  })
  it('advances and wraps forward', () => {
    expect(nextMatchIndex(starts, 0, 0)).toBe(1)
    expect(nextMatchIndex(starts, 2, 0)).toBe(0)
  })
  it('advances and wraps backward', () => {
    expect(previousMatchIndex(starts, 1, 0)).toBe(0)
    expect(previousMatchIndex(starts, 0, 0)).toBe(2)
  })
  it('is null with no matches regardless of current index', () => {
    expect(nextMatchIndex(new Int32Array(0), 0, 0)).toBeNull()
    expect(previousMatchIndex(new Int32Array(0), 0, 0)).toBeNull()
  })
})
