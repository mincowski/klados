/**
 * User feedback after M5e-PLAN.md R8f landed: `Raw.tsx`'s `jumpTo` used to
 * scroll the target line to the vertical center of the viewport. The
 * request was to land it at the *second* visible row instead — one line
 * of leading context, not centered. Exercises the exact CodeMirror
 * mechanism `jumpTo` now uses (`EditorView.scrollIntoView` with
 * `y: 'start'` and a one-line `yMargin`) against a real Chromium layout,
 * since jsdom has no real scroll geometry to measure this against.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

let container: HTMLDivElement
let view: EditorView

beforeEach(() => {
  container = document.createElement('div')
  container.style.height = '200px'
  container.style.width = '400px'
  document.body.appendChild(container)
})

afterEach(() => {
  view.destroy()
  container.remove()
})

async function frame(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function manyLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i}`).join('\n')
}

// CodeMirror's editor grows to fit its content by default — the container's
// own fixed height does nothing until `.cm-editor`/`.cm-scroller` are told
// to fill it, same as `Raw.css`'s real theme has to do.
const FIXED_HEIGHT = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': { overflow: 'auto' }
})

describe('jumpTo scroll positioning (post-R8 feedback)', () => {
  it('lands the target line as the second visible row, not centered', async () => {
    view = new EditorView({
      state: EditorState.create({ doc: manyLines(200), extensions: [FIXED_HEIGHT] }),
      parent: container
    })
    await frame()

    const lineHeight = view.defaultLineHeight
    const targetLine = 100
    const targetPos = view.state.doc.line(targetLine + 1).from

    view.dispatch({
      selection: { anchor: targetPos },
      effects: EditorView.scrollIntoView(targetPos, { y: 'start', yMargin: lineHeight })
    })
    await frame()

    const targetTop = view.lineBlockAt(targetPos).top
    const viewportTop = view.scrollDOM.scrollTop
    const offsetFromTop = targetTop - viewportTop

    // The target line's top should sit roughly one line height below the
    // viewport's own top — i.e. exactly one full line (the yMargin) is
    // visible above it, making the target the *second* visible row.
    expect(offsetFromTop).toBeGreaterThan(lineHeight * 0.5)
    expect(offsetFromTop).toBeLessThan(lineHeight * 1.5)
  })

  it('differs from centering the target (the pre-fix behaviour)', async () => {
    view = new EditorView({
      state: EditorState.create({ doc: manyLines(200), extensions: [FIXED_HEIGHT] }),
      parent: container
    })
    await frame()

    const targetPos = view.state.doc.line(101).from
    view.dispatch({
      selection: { anchor: targetPos },
      effects: EditorView.scrollIntoView(targetPos, { y: 'center' })
    })
    await frame()

    const centeredOffset = view.lineBlockAt(targetPos).top - view.scrollDOM.scrollTop
    // Centered puts the target roughly at half the viewport height, well
    // past where the "second row" placement (~1 line height) lands it.
    expect(centeredOffset).toBeGreaterThan(view.defaultLineHeight * 2)
  })
})
