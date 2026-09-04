/**
 * R103 (`R102-find-single-line.md` §3) — the one thing reverting the find
 * field to a plain `<input type="text">` (R102) genuinely loses. Measured
 * directly in that plan: assigning `'a\nb'` to a text input yields `'ab'` —
 * the newline silently vanishes and the two lines are concatenated with no
 * separator, so a needle copied across two lines becomes a string that
 * matches nothing, with nothing on screen explaining why.
 *
 * `FindBar.tsx`'s `handlePaste` intercepts a paste whose clipboard text
 * contains a line break, strips it explicitly, and shows a footnote saying
 * so — this is that behaviour, and its own negative case (an ordinary paste
 * shows nothing new).
 *
 * Same minimal harness `findAutoGrow.test.tsx` (R89, now deleted by this
 * revert) used: no document needs to be open for this — `FindBar` renders
 * once `openFind()` is called, and paste handling doesn't touch the session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { FindBar } from '../src/renderer/components/Find/FindBar'
import {
  closeFind,
  openFind,
  resetFindStoreForTests
} from '../src/renderer/components/Find/findStore'
import { resetTabsForTests } from '../src/renderer/session/tabs'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/styles/base.css'
import '../src/renderer/components/Find/Find.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetTabsForTests()
  resetFindStoreForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetFindStoreForTests()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
}

/** Dispatches a synthetic `paste`, and returns whether the handler called
 * `preventDefault` — the signal `handlePaste` only raises for a clipboard
 * text containing a line break. A synthetic dispatch never triggers the
 * browser's own native "insert the clipboard text" behaviour (that's tied
 * to a genuine paste action, not reproducible by dispatching the event
 * alone), so the ordinary-paste case is asserted on this instead of on
 * `el.value` actually changing. */
function pasteInto(el: HTMLInputElement, text: string): boolean {
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', text)
  const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
  el.dispatchEvent(event)
  return event.defaultPrevented
}

describe('R103 — a multi-line paste is stripped and disclosed, not silently mangled', () => {
  it('pasting text with a line break puts one line in the field and shows the footnote', async () => {
    closeFind()
    openFind()
    await paint(<FindBar />)
    const el = container.querySelector<HTMLInputElement>('.find-input')!

    const prevented = pasteInto(el, 'line one\nline two')
    await paint(<FindBar />)

    expect(prevented).toBe(true) // handlePaste took over the insertion itself
    expect(el.value).toBe('line oneline two')
    expect(container.textContent).toContain('Line breaks were removed from the pasted text.')
  })

  it('pasting text without a line break shows nothing new', async () => {
    closeFind()
    openFind()
    await paint(<FindBar />)
    const el = container.querySelector<HTMLInputElement>('.find-input')!

    const prevented = pasteInto(el, 'needle')
    await paint(<FindBar />)

    expect(prevented).toBe(false) // left to the browser's own default paste handling
    expect(container.textContent).not.toContain('Line breaks were removed')
  })

  it('typing after a stripped paste clears the notice', async () => {
    closeFind()
    openFind()
    await paint(<FindBar />)
    const el = container.querySelector<HTMLInputElement>('.find-input')!

    pasteInto(el, 'line one\nline two')
    await paint(<FindBar />)
    expect(container.textContent).toContain('Line breaks were removed')

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!
    nativeSetter.call(el, 'line oneline twoX')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await paint(<FindBar />)

    expect(container.textContent).not.toContain('Line breaks were removed')
  })
})
