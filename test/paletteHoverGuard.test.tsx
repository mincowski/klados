/**
 * R82 (`R82-hover-and-glyphs.md` §1) — R67's `scrollIntoView({block:
 * 'nearest'})` moves the option list under a pointer that never itself
 * moved. Real Chromium tracks the actual cursor position and re-fires
 * `mouseover` on whichever row slides underneath it when the page scrolls
 * — no synthetic `dispatchEvent` reproduces this, since that never moves
 * the OS-level cursor the browser is actually tracking. So this uses
 * `userEvent.hover` (`vitest/browser`), which drives Playwright's
 * real `locator.hover()` — a genuine pointer move, not a dispatched event —
 * to park the cursor over an early row before scrolling happens.
 *
 * `test/paletteRender.test.tsx`'s own R67 guard never places a pointer at
 * all, so it could not catch this.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETTLE_MS } from './support/wait'
import { userEvent } from 'vitest/browser'
import { createRoot, type Root } from 'react-dom/client'
import { resetTabsForTests } from '../src/renderer/session/tabs'
import { Palette } from '../src/renderer/components/Palette/Palette'
import {
  openPalette,
  resetPaletteStoreForTests
} from '../src/renderer/components/Palette/paletteStore'
import { resetPaletteRecencyForTests } from '../src/renderer/components/Palette/paletteLogic'
import '../src/renderer/commands/builtins'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Palette/CommandPalette.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetPaletteStoreForTests()
  resetPaletteRecencyForTests()
  resetTabsForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetPaletteStoreForTests()
  resetPaletteRecencyForTests()
  resetTabsForTests()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function fireKey(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('R82 §1 — keyboard navigation wins over a stationary pointer', () => {
  it('arrowing down with the pointer parked over an early row keeps the selection where the keyboard put it', async () => {
    openPalette()
    await paint(<Palette />)

    const input = container.querySelector<HTMLInputElement>('.palette-input')!
    const list = container.querySelector<HTMLElement>('.palette-list')!
    const totalOptions = container.querySelectorAll('.palette-option').length
    expect(totalOptions).toBeGreaterThan(5) // enough to overflow the list, per R67

    // A genuine pointer move onto the first row — the actual OS-level
    // cursor Chromium tracks, not a dispatched event.
    const firstOption = container.querySelector('.palette-option')!
    await userEvent.hover(firstOption)
    await paint(<Palette />)
    // The hover did activate row 0 — establishes hover works at all
    // before proving keyboard nav overrides it once the list scrolls.
    expect(container.querySelector('.palette-option-active')).toBe(firstOption)

    // Arrow all the way down without moving the mouse — past the point
    // R67 measured the list scrolling. The cursor never moves; the rows
    // slide underneath it, which is what triggers the bug.
    for (let i = 0; i < totalOptions - 1; i++) {
      fireKey(input, 'ArrowDown')
    }
    await paint(<Palette />)

    const active = container.querySelector('.palette-option-active')!
    const activeRect = active.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    // R67's own assertion: the keyboard-selected row is the one visible…
    expect(activeRect.top).toBeGreaterThanOrEqual(listRect.top - 1)
    expect(activeRect.bottom).toBeLessThanOrEqual(listRect.bottom + 1)
    // …and it is the *last* option — not snapped back to row 0 by a
    // `mouseover` the scroll fired under the still-parked pointer.
    const options = Array.from(container.querySelectorAll('.palette-option'))
    expect(options.indexOf(active)).toBe(options.length - 1)
  })

  it('a genuine pointer move re-enables hover-activation afterward', async () => {
    openPalette()
    await paint(<Palette />)

    const input = container.querySelector<HTMLInputElement>('.palette-input')!
    const options = Array.from(container.querySelectorAll('.palette-option'))
    // Suppress hover the same way the previous test does, then move the
    // real cursor onto a *different* row than the one keyboard nav landed
    // on — a genuine move must win, unlike the stationary one above.
    fireKey(input, 'ArrowDown')
    fireKey(input, 'ArrowDown')
    await paint(<Palette />)
    const afterKeyboard = container.querySelector('.palette-option-active')
    expect(afterKeyboard).toBe(options[2])

    // The exact landing row isn't asserted (Chromium moves the real
    // cursor through intermediate rows en route, which can end the move a
    // row off from the target element's own rect) — what matters is that
    // a genuine move changes the selection at all, proving the gate isn't
    // permanently latched by the earlier keyboard nav.
    await userEvent.hover(options[8]!)
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    await paint(<Palette />)
    expect(container.querySelector('.palette-option-active')).not.toBe(afterKeyboard)
  })
})
