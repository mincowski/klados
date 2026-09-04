import { describe, expect, it } from 'vitest'
import { horizontalWheelDelta } from '../src/renderer/wheelDelta'

describe('horizontalWheelDelta (R45)', () => {
  it('uses deltaX when the wheel already reports one (a trackpad or a tilt wheel)', () => {
    expect(horizontalWheelDelta({ deltaX: 12, deltaY: 0 })).toBe(12)
    expect(horizontalWheelDelta({ deltaX: -8, deltaY: 40 })).toBe(-8)
  })

  it('falls back to deltaY when deltaX is 0 — an ordinary mouse wheel never reports deltaX', () => {
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 40 })).toBe(40)
  })

  it('is 0 when both axes are 0', () => {
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 0 })).toBe(0)
  })
})
