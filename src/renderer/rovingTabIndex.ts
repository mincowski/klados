/**
 * WAI-ARIA roving tabindex (R62, `R61-keyboard-workflow.md` §3): a
 * horizontal group of buttons (Detail's breadcrumb segments, the grid
 * toolbar) is one Tab stop, not one per button — only the "current" member
 * carries `tabIndex 0`, the rest `-1`, and ArrowLeft/ArrowRight/Home/End
 * move which one is current without a fresh Tab press. This is what turns
 * the grid header's own O(columns) tab-stop count (§2's measured 23+, and
 * unbounded on a wide table) into one stop per group.
 *
 * Split into a pure index calculator (`nextRovingIndex`, testable without a
 * DOM) and a small React hook that wires it to real focus.
 */
import { useCallback, useRef, useState, type KeyboardEvent } from 'react'

/** The new active index for `key` pressed while `current` (of `count`
 * items) has focus, or `null` if `key` isn't one this group handles. Wraps
 * at both ends — ArrowRight past the last item returns to the first, same
 * as every other roving-tabindex widget on the platform (a native `<select>`
 * excepted). */
export function nextRovingIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count
    case 'ArrowLeft':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

export interface RovingTabIndex {
  readonly activeIndex: number
  /** Props to spread onto the `index`th item in the group. */
  itemProps(index: number): {
    tabIndex: number
    onKeyDown: (event: KeyboardEvent) => void
    onFocus: () => void
    ref: (el: HTMLElement | null) => void
  }
}

/**
 * `count` items in one roving-tabindex group. `activeIndex` starts at 0 and
 * moves on an arrow key or whichever item last received real focus (a
 * mouse click, say) — either way, the next Tab into the group lands on the
 * item the user was last at, not always the first, matching every other
 * roving-tabindex widget's own convention.
 *
 * Clamped against `count` on every read, not just when it shrinks — the
 * grid toolbar's own item count changes at runtime (the column-picker
 * button and the hidden-matches toggle are both conditionally rendered),
 * and a stale `activeIndex` pointing past the current count would silently
 * make no item the roving stop at all.
 */
export function useRovingTabIndex(count: number): RovingTabIndex {
  const [rawActiveIndex, setActiveIndex] = useState(0)
  const activeIndex = count <= 0 ? 0 : Math.min(rawActiveIndex, count - 1)
  const itemsRef = useRef<(HTMLElement | null)[]>([])

  const itemProps = useCallback(
    (index: number) => ({
      tabIndex: index === activeIndex ? 0 : -1,
      onKeyDown: (event: KeyboardEvent) => {
        const next = nextRovingIndex(activeIndex, count, event.key)
        if (next === null) return
        event.preventDefault()
        setActiveIndex(next)
        itemsRef.current[next]?.focus()
      },
      onFocus: () => setActiveIndex(index),
      ref: (el: HTMLElement | null) => {
        itemsRef.current[index] = el
      }
    }),
    [activeIndex, count]
  )

  return { activeIndex, itemProps }
}
