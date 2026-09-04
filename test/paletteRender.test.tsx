/**
 * R66–R68 (`R66-palette-polish.md`) — the palette's rendered output.
 * Real Chromium (`test/notifications.test.tsx`'s own pattern), since R67's
 * scroll-into-view claim needs real layout and real `scrollIntoView`
 * geometry, which jsdom fakes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { resetTabsForTests } from '../src/renderer/session/tabs'
import { Palette } from '../src/renderer/components/Palette/Palette'
import {
  openPalette,
  resetPaletteStoreForTests
} from '../src/renderer/components/Palette/paletteStore'
import { resetPaletteRecencyForTests } from '../src/renderer/components/Palette/paletteLogic'
// Static, once per file — registers every built-in command (30+), enough
// to overflow the palette's own list for R67's scroll test.
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

describe('R66 §1 — the category renders as part of the option label, searchable', () => {
  it('an option shows "Category: Title", and typing a category name filters to it', async () => {
    openPalette()
    await paint(<Palette />)

    const firstOption = container.querySelector('.palette-option-title')!
    // Every built-in command title includes its category as a prefix now.
    expect(firstOption.textContent).toMatch(/^[A-Za-z]+: /)

    const input = container.querySelector<HTMLInputElement>('.palette-input')!
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!
    nativeSetter.call(input, 'view')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await paint(<Palette />)

    const options = Array.from(container.querySelectorAll('.palette-option-title'))
    expect(options.length).toBeGreaterThan(0)
    for (const option of options) {
      expect(option.textContent?.toLowerCase().startsWith('view:')).toBe(true)
    }
  })

  it('the old separate .palette-option-category span is gone', async () => {
    openPalette()
    await paint(<Palette />)
    expect(container.querySelector('.palette-option-category')).toBeNull()
  })
})

describe('R67 §2 — the active option scrolls into view', () => {
  it('after enough ArrowDown presses, the active option is inside the visible list', async () => {
    openPalette()
    await paint(<Palette />)

    const input = container.querySelector<HTMLInputElement>('.palette-input')!
    const list = container.querySelector<HTMLElement>('.palette-list')!
    const totalOptions = container.querySelectorAll('.palette-option').length
    expect(totalOptions).toBeGreaterThan(5) // enough commands to overflow a typical list height

    for (let i = 0; i < totalOptions - 1; i++) {
      fireKey(input, 'ArrowDown')
    }
    await paint(<Palette />)

    const active = container.querySelector('.palette-option-active')!
    const activeRect = active.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()

    expect(activeRect.top).toBeGreaterThanOrEqual(listRect.top - 1)
    expect(activeRect.bottom).toBeLessThanOrEqual(listRect.bottom + 1)
  })
})

describe('R68 §3 — a toggle command shows its On/Off state in the palette', () => {
  it('"View: Soft Wrap" (or another toggle) renders an Off/On badge', async () => {
    openPalette()
    await paint(<Palette />)

    const input = container.querySelector<HTMLInputElement>('.palette-input')!
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!
    nativeSetter.call(input, 'dark theme')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await paint(<Palette />)

    const option = container.querySelector('.palette-option')!
    expect(option.querySelector('.palette-option-title')!.textContent).toBe('View: Dark Theme')
    const state = option.querySelector('.palette-option-state')
    expect(state).not.toBeNull()
    expect(['On', 'Off']).toContain(state!.textContent)
  })
})
