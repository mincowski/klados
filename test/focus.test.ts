import { beforeEach, describe, expect, it } from 'vitest'
import { getContext, resetContextForTests } from '../src/renderer/commands/context'
import {
  focusPane,
  focusPaneOrFirstAvailable,
  isPaneRegistered,
  moveFocus,
  registerPane,
  resetFocusForTests,
  type FocusablePane,
  type Pane
} from '../src/renderer/focus'

/** A `FocusablePane` double that mimics the one DOM behavior this module
 * relies on: calling `.focus()` synchronously dispatches `focusin`. */
function fakePane(): FocusablePane {
  let listener: (() => void) | undefined
  return {
    focus: () => listener?.(),
    addEventListener: (_type, l) => {
      listener = l
    },
    removeEventListener: (_type, l) => {
      if (listener === l) listener = undefined
    }
  }
}

describe('focus model (D4)', () => {
  beforeEach(() => {
    resetFocusForTests()
    resetContextForTests()
  })

  it('registerPane makes a pane focusable and reachable by focusPane', () => {
    const tree = fakePane()
    registerPane('tree', tree)
    expect(isPaneRegistered('tree')).toBe(true)

    focusPane('tree')
    expect(getContext().focus).toBe('tree')
  })

  it('a click-driven focusin (not just focusPane) also updates the focus context key', () => {
    const detail = fakePane()
    registerPane('detail', detail)
    detail.focus() // stands in for a real click landing focus on the pane
    expect(getContext().focus).toBe('detail')
  })

  it('focusPane on an unregistered pane is a no-op, not a throw', () => {
    expect(() => focusPane('raw')).not.toThrow()
    expect(getContext().focus).toBeNull()
  })

  it('unregistering a pane removes it from the cycle and clears it as "last focused"', () => {
    const tree = fakePane()
    const detail = fakePane()
    const unregisterTree = registerPane('tree', tree)
    registerPane('detail', detail)
    focusPane('tree')
    expect(getContext().focus).toBe('tree')

    unregisterTree()
    expect(isPaneRegistered('tree')).toBe(false)

    moveFocus('next')
    // 'tree' is gone; the only registered pane left is 'detail'.
    expect(getContext().focus).toBe('detail')
  })

  it('moveFocus cycles through registered panes in canonical order, wrapping both ways', () => {
    const panes: Record<Pane, FocusablePane> = {
      tree: fakePane(),
      detail: fakePane(),
      raw: fakePane()
    }
    registerPane('tree', panes.tree)
    registerPane('detail', panes.detail)
    registerPane('raw', panes.raw)

    moveFocus('next')
    expect(getContext().focus).toBe('tree')
    moveFocus('next')
    expect(getContext().focus).toBe('detail')
    moveFocus('next')
    expect(getContext().focus).toBe('raw')
    moveFocus('next') // wraps
    expect(getContext().focus).toBe('tree')

    moveFocus('previous') // wraps the other way
    expect(getContext().focus).toBe('raw')
  })

  it('moveFocus skips panes that are registered out of canonical order or not registered at all', () => {
    // Only tree and raw exist (detail collapsed via a D7 layout toggle) —
    // registered in reverse to prove the cycle uses PANE_ORDER, not
    // registration order.
    const raw = fakePane()
    const tree = fakePane()
    registerPane('raw', raw)
    registerPane('tree', tree)

    moveFocus('next')
    expect(getContext().focus).toBe('tree')
    moveFocus('next')
    expect(getContext().focus).toBe('raw')
    moveFocus('next')
    expect(getContext().focus).toBe('tree')
  })

  it('moveFocus with nothing registered does nothing', () => {
    expect(() => moveFocus('next')).not.toThrow()
    expect(getContext().focus).toBeNull()
  })
})

// R69 (`R69-focus-and-find.md` §1) — `focusPaneOrFirstAvailable`'s own
// fallback trap: `focusPane` alone silently no-ops on a hidden preferred
// pane and would leave focus stranded.
describe('focusPaneOrFirstAvailable (R69 §1)', () => {
  beforeEach(() => {
    resetFocusForTests()
    resetContextForTests()
  })

  it('focuses the preferred pane when it is registered', () => {
    const tree = fakePane()
    const raw = fakePane()
    registerPane('tree', tree)
    registerPane('raw', raw)

    focusPaneOrFirstAvailable('raw')
    expect(getContext().focus).toBe('raw')
  })

  it('falls back to the first available pane (canonical order) when the preferred one is hidden', () => {
    const detail = fakePane()
    const raw = fakePane()
    registerPane('raw', raw)
    registerPane('detail', detail)

    focusPaneOrFirstAvailable('tree') // tree is not registered — collapsed
    expect(getContext().focus).toBe('detail') // first in PANE_ORDER among what's registered
  })

  it('is a no-op, not a throw, when nothing is registered at all', () => {
    expect(() => focusPaneOrFirstAvailable('tree')).not.toThrow()
    expect(getContext().focus).toBeNull()
  })
})
