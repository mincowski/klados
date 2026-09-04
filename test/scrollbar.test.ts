/**
 * M5c-PLAN.md J4 — `thumbGeometry`, the one pure piece of
 * `Scrollbar.tsx`'s logic (thumb size/offset as a 0-1 track fraction,
 * derived from scroll geometry).
 */
import { describe, expect, it } from 'vitest'
import { thumbGeometry } from '../src/renderer/components/Scrollbar/Scrollbar'

describe('thumbGeometry', () => {
  it('is null when content does not overflow the client area', () => {
    expect(thumbGeometry({ scrollPos: 0, scrollSize: 100, clientSize: 100 })).toBeNull()
    expect(thumbGeometry({ scrollPos: 0, scrollSize: 90, clientSize: 100 })).toBeNull()
  })

  it('sizes the thumb as clientSize/scrollSize at the top', () => {
    const geometry = thumbGeometry({ scrollPos: 0, scrollSize: 400, clientSize: 100 })
    expect(geometry).not.toBeNull()
    expect(geometry!.size).toBeCloseTo(0.25)
    expect(geometry!.offset).toBeCloseTo(0)
  })

  it('offsets the thumb proportionally to scroll position', () => {
    // scrollSize 400, clientSize 100 -> maxScroll 300, thumb size 0.25.
    // Scrolled halfway (150/300) -> offset halfway across the remaining track (0.75 * 0.5).
    const geometry = thumbGeometry({ scrollPos: 150, scrollSize: 400, clientSize: 100 })
    expect(geometry!.offset).toBeCloseTo(0.375)
  })

  it('reaches the bottom of the track at max scroll', () => {
    const geometry = thumbGeometry({ scrollPos: 300, scrollSize: 400, clientSize: 100 })
    expect(geometry!.offset + geometry!.size).toBeCloseTo(1)
  })

  it('clamps a tiny thumb to a minimum size', () => {
    const geometry = thumbGeometry({ scrollPos: 0, scrollSize: 1_000_000, clientSize: 100 })
    expect(geometry!.size).toBeCloseTo(0.05)
  })

  it('clamps offset within [0, 1 - size] even at the extremes', () => {
    const atStart = thumbGeometry({ scrollPos: 0, scrollSize: 400, clientSize: 100 })!
    const atEnd = thumbGeometry({ scrollPos: 300, scrollSize: 400, clientSize: 100 })!
    expect(atStart.offset).toBeGreaterThanOrEqual(0)
    expect(atEnd.offset + atEnd.size).toBeLessThanOrEqual(1.0001)
  })
})
