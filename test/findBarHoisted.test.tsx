/**
 * R70 (`R69-focus-and-find.md` §2) — `<FindBar />` used to be mounted
 * inside `Raw.tsx`, so `Ctrl+F` (via `openFind()`) did nothing whenever the
 * Raw pane was hidden. It's now a direct child of `Layout.tsx`'s own
 * `.layout`, unconditional on both the document session's phase and
 * `layoutStore`'s `rawVisible` — this exercises exactly that: opening Find
 * with Raw hidden (or no document open at all) still renders the bar. Real
 * Chromium (`test/notifications.test.tsx`'s own pattern for a component
 * that reads `useDocumentSession()`/module-level stores).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { Layout } from '../src/renderer/components/Layout/Layout'
import { getLayoutState, resetLayoutForTests } from '../src/renderer/components/Layout/layoutStore'
import {
  closeFind,
  openFind,
  resetFindStoreForTests
} from '../src/renderer/components/Find/findStore'
import { resetTabsForTests } from '../src/renderer/session/tabs'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Layout/Layout.css'
import '../src/renderer/components/Find/Find.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  container.style.height = '600px'
  container.style.width = '900px'
  document.body.appendChild(container)
  root = createRoot(container)
  resetTabsForTests()
  resetLayoutForTests()
  resetFindStoreForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetLayoutForTests()
  resetFindStoreForTests()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

describe('R70 §2 — Find is mounted at the layout shell, not inside Raw', () => {
  it('opening Find renders .find-bar even with no document open (Raw not even mounted)', async () => {
    await paint(<Layout />)
    expect(container.querySelector('.find-bar')).toBeNull()

    openFind()
    await paint(<Layout />)

    expect(container.querySelector('.find-bar')).not.toBeNull()
  })

  it('opening Find renders .find-bar with the Raw pane explicitly hidden', async () => {
    // rawVisible defaults to false (`layoutLogic.ts`'s own
    // `DEFAULT_PANE_VISIBILITY`) — asserted rather than assumed, since the
    // whole point of this test is Raw being hidden.
    expect(getLayoutState().rawVisible).toBe(false)

    await paint(<Layout />)
    openFind()
    await paint(<Layout />)

    expect(container.querySelector('.find-bar')).not.toBeNull()
    expect(container.querySelector('.raw')).toBeNull() // Raw's own EditorView host isn't mounted
  })

  it('.find-bar is positioned absolute inside .layout (position: relative), not fixed to the viewport', async () => {
    openFind()
    await paint(<Layout />)

    const findBar = container.querySelector('.find-bar')!
    const layout = container.querySelector('.layout')!
    expect(getComputedStyle(findBar).position).toBe('absolute')
    expect(getComputedStyle(layout).position).toBe('relative')
  })

  it('closeFind removes the bar again', async () => {
    openFind()
    await paint(<Layout />)
    expect(container.querySelector('.find-bar')).not.toBeNull()

    closeFind()
    await paint(<Layout />)
    expect(container.querySelector('.find-bar')).toBeNull()
  })
})
