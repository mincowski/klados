/**
 * The empty-state "Open File…" button — `DocumentArea.tsx`'s `empty` phase
 * used to offer only the `Ctrl+O`/drag/palette hint text, with no click
 * affordance, unlike its own `error` phase a few lines below. Verifies the
 * button is present and genuinely wired to `activeSession.openFileDialog()`
 * (not just rendered) by driving the real singleton — there is no
 * `window.api` in this browser test environment, so a real click safely
 * degrades to the 'error' phase with a specific message
 * (`documentSession.ts`'s own `openFileDialog` doc comment: "every other
 * IPC call... degrades to an 'error' phase rather than an unhandled
 * rejection").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { DocumentArea } from '../src/renderer/components/Layout/DocumentArea'
import { activeSession } from '../src/renderer/session/activeSession'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Layout/DocumentArea.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
})

async function paint(): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(<DocumentArea />)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

describe('DocumentArea empty state', () => {
  it('offers an Open File… button alongside the Ctrl+O hint', async () => {
    const initial = activeSession.getSnapshot()
    if (initial.phase !== 'empty') {
      throw new Error(
        `expected activeSession to start 'empty' in this test process, got '${initial.phase}' — another test in this worker must have opened a document first`
      )
    }

    await paint()

    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Open File…'
    )
    expect(button).toBeDefined()
  })

  it('the button is genuinely wired to activeSession.openFileDialog()', async () => {
    if (activeSession.getSnapshot().phase !== 'empty') {
      throw new Error("activeSession is not 'empty' — cannot safely exercise this click")
    }

    await paint()
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Open File…'
    )!
    button.click()

    // openFileDialog() is async; give its no-window.api branch a tick to
    // settle into the 'error' phase.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const after = activeSession.getSnapshot()
    expect(after.phase).toBe('error')
    if (after.phase === 'error') {
      expect(after.message).toBe('The document API is unavailable.')
    }
  })
})
