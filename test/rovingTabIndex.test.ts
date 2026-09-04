/**
 * R62 (`R61-keyboard-workflow.md` §3) — the pure index arithmetic
 * behind `useRovingTabIndex`. The React-hook half needs real DOM focus to
 * exercise meaningfully (`itemsRef.current[next]?.focus()`), covered
 * instead by `test/gridKeyboardNav.test.tsx`'s real-Chromium breadcrumb/
 * toolbar assertions.
 */
import { describe, expect, it } from 'vitest'
import { nextRovingIndex } from '../src/renderer/rovingTabIndex'

describe('nextRovingIndex', () => {
  it('wraps forward past the last item', () => {
    expect(nextRovingIndex(2, 3, 'ArrowRight')).toBe(0)
  })

  it('wraps backward past the first item', () => {
    expect(nextRovingIndex(0, 3, 'ArrowLeft')).toBe(2)
  })

  it('Home jumps to the first item', () => {
    expect(nextRovingIndex(2, 5, 'Home')).toBe(0)
  })

  it('End jumps to the last item', () => {
    expect(nextRovingIndex(0, 5, 'End')).toBe(4)
  })

  it('ignores a key it does not handle', () => {
    expect(nextRovingIndex(1, 3, 'Enter')).toBeNull()
  })

  it('returns null for an empty group', () => {
    expect(nextRovingIndex(0, 0, 'ArrowRight')).toBeNull()
  })

  it('a single-item group stays put on either arrow', () => {
    expect(nextRovingIndex(0, 1, 'ArrowRight')).toBe(0)
    expect(nextRovingIndex(0, 1, 'ArrowLeft')).toBe(0)
  })
})
