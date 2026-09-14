/**
 * R211 — the tab-fitting rule behind Detail's group tabs, without a DOM. The
 * rendered behaviour is `test/detailGridGroupTabs.test.tsx`; this pins the
 * arithmetic, because the one non-obvious property — the "more" button's
 * width depends on the answer — is easy to break into an oscillation or an
 * off-by-one that only shows on some window widths.
 */
import { describe, expect, it } from 'vitest'
import { tabsThatFit } from '../src/renderer/components/Detail/GridGroupPicker'

const constantMore = (width: number) => (): number => width

describe('tabsThatFit (R211)', () => {
  it('shows every tab and no more button when they all fit', () => {
    expect(tabsThatFit([50, 50, 50], 150, constantMore(80))).toBe(3)
  })

  it('reserves room for the more button once anything overflows', () => {
    // 50+50+50 = 150 > 140, so something overflows; the button needs 40.
    expect(tabsThatFit([50, 50, 50], 140, constantMore(40))).toBe(2)
    expect(tabsThatFit([50, 50, 50], 139, constantMore(40))).toBe(1)
  })

  it('can show no tabs at all in a very narrow row — the button alone', () => {
    expect(tabsThatFit([50, 50], 60, constantMore(55))).toBe(0)
  })

  it('does not stop at the first count that fails when the button narrows later', () => {
    // The selected group is the third (index 2). While it is hidden (k <= 2)
    // the button shows its long name (100px); once it is visible (k = 3) the
    // button reads "+N more" (30px). k = 2 fails, k = 3 fits.
    const selected = 2
    const moreWidthFor = (k: number): number => (selected >= k ? 100 : 30)
    expect(tabsThatFit([40, 40, 40, 40], 150, moreWidthFor)).toBe(3)
  })

  it('is deterministic — the same widths always give the same answer', () => {
    const widths = [61, 73, 58, 90, 44, 102]
    const answers = new Set(
      Array.from({ length: 5 }, () => tabsThatFit(widths, 250, constantMore(70)))
    )
    expect(answers.size).toBe(1)
  })
})
