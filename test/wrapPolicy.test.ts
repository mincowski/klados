import { describe, expect, it } from 'vitest'
import { needsWrapToScroll } from '../src/renderer/components/Raw/wrapPolicy'

describe('needsWrapToScroll (D12)', () => {
  it('needs wrap when content is shorter than the viewport (no scroll surface)', () => {
    expect(needsWrapToScroll(100, 200)).toBe(true)
  })

  it('needs wrap when content exactly fills the viewport (still no surface to scroll)', () => {
    expect(needsWrapToScroll(200, 200)).toBe(true)
  })

  it('does not need wrap when content exceeds the viewport', () => {
    expect(needsWrapToScroll(5000, 200)).toBe(false)
  })

  it('is false for an unmeasured (zero or negative) client height, not a false positive', () => {
    expect(needsWrapToScroll(0, 0)).toBe(false)
    expect(needsWrapToScroll(100, 0)).toBe(false)
    expect(needsWrapToScroll(100, -1)).toBe(false)
  })
})
