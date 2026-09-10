/**
 * R61/R64 (`R61-keyboard-workflow.md` §4–5) — Raw's Tab/Shift-Tab/
 * Enter/Escape keymap. `EditorState` needs no DOM (`rawEdit.test.ts`'s own
 * reasoning for testing the CodeMirror-free core), and a `StateCommand`'s
 * `run` accepts anything with `.state`/`.dispatch`, so these are exercised
 * directly against a fake `{state, dispatch}` target rather than a real
 * `EditorView` — `createRawKeymapBindings` returns the plain binding array
 * `rawKeymapExtension` wraps in `keymap.of(...)`, exactly so this test
 * doesn't need to introspect that opaque Facet-backed `Extension`.
 */
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import type { EditorView, KeyBinding } from '@codemirror/view'
import {
  createRawKeymapBindings,
  leadingWhitespace,
  sniffIndentUnit
} from '../src/renderer/components/Raw/rawKeymap'

describe('sniffIndentUnit', () => {
  it('defaults to two spaces when nothing is indented', () => {
    expect(sniffIndentUnit('a\nb\nc')).toBe('  ')
  })

  it('detects a tab from the first indented line', () => {
    expect(sniffIndentUnit('<a>\n\t<b/>\n</a>')).toBe('\t')
  })

  it('detects two-space indent from the first indented line', () => {
    expect(sniffIndentUnit('<a>\n  <b/>\n</a>')).toBe('  ')
  })

  it('only scans the sample window, not the whole text', () => {
    const text = 'x'.repeat(30000) + '\n\tindented-but-too-late'
    expect(sniffIndentUnit(text, 100)).toBe('  ')
  })
})

describe('leadingWhitespace', () => {
  it('returns the leading run of spaces/tabs', () => {
    expect(leadingWhitespace('  <a>')).toBe('  ')
    expect(leadingWhitespace('\t\t<a>')).toBe('\t\t')
    expect(leadingWhitespace('<a>')).toBe('')
  })
})

/** Builds a fake `EditorView`-shaped target: real `.state`, and a
 * `.dispatch` that applies the transaction and updates `.state` in place —
 * enough for a `StateCommand` (which `KeyBinding.run` accepts here, needing
 * only `.state`/`.dispatch`) to run against, without a DOM. Cast past
 * `EditorView`'s full type, which declares dozens of members this fake
 * never needs to satisfy. */
function fakeView(
  doc: string,
  selection: { anchor: number; head?: number }
): EditorView & { state: EditorState } {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(selection.anchor, selection.head)
  })
  return {
    get state() {
      return state
    },
    dispatch(tr: Transaction) {
      state = state.update(tr).state
    }
  } as unknown as EditorView & { state: EditorState }
}

/** `fakeView`, but with R168's line separator — without it CodeMirror's
 * default split discards the `\r`, and every CRLF assertion below would be
 * testing a document that does not match what `Raw.tsx` builds. */
function fakeCrlfView(
  doc: string,
  selection: { anchor: number; head?: number }
): EditorView & { state: EditorState } {
  let state = EditorState.create({
    doc,
    extensions: [EditorState.lineSeparator.of('\n')],
    selection: EditorSelection.single(selection.anchor, selection.head)
  })
  return {
    get state() {
      return state
    },
    dispatch(tr: Transaction) {
      state = state.update(tr).state
    }
  } as unknown as EditorView & { state: EditorState }
}

function findBinding(bindings: readonly KeyBinding[], key: string): KeyBinding {
  const found = bindings.find((b) => b.key === key)
  if (found === undefined) throw new Error(`no binding for ${key}`)
  return found
}

describe('Tab indents; a multi-line selection indents every line it touches', () => {
  it('inserts the indent unit at an empty cursor', () => {
    const view = fakeView('<a>\n<b/>\n</a>', { anchor: 4 })
    const tab = findBinding(
      createRawKeymapBindings(() => '  '),
      'Tab'
    )
    expect(tab.run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('<a>\n  <b/>\n</a>')
    expect(view.state.selection.main.head).toBe(6)
  })

  it('indents every line a multi-line selection touches', () => {
    const view = fakeView('<a>\n<b/>\n<c/>\n</a>', { anchor: 0, head: 13 })
    const tab = findBinding(
      createRawKeymapBindings(() => '  '),
      'Tab'
    )
    expect(tab.run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('  <a>\n  <b/>\n  <c/>\n</a>')
  })

  it('replaces a single-line selection rather than indenting the whole line', () => {
    const view = fakeView('<a>\n<b/>\n</a>', { anchor: 4, head: 8 })
    const tab = findBinding(
      createRawKeymapBindings(() => '  '),
      'Tab'
    )
    expect(tab.run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('<a>\n  \n</a>')
  })

  it('does nothing and un-consumes Tab on a read-only document', () => {
    const state = EditorState.create({ doc: 'abc', extensions: [EditorState.readOnly.of(true)] })
    const view = {
      state,
      dispatch: () => {
        throw new Error('should not dispatch')
      }
    } as unknown as EditorView
    const tab = findBinding(
      createRawKeymapBindings(() => '  '),
      'Tab'
    )
    expect(tab.run!(view)).toBe(false)
  })
})

describe('Shift-Tab dedents up to one indent unit per line', () => {
  it('removes an exact leading unit', () => {
    const view = fakeView('<a>\n  <b/>\n</a>', { anchor: 6 })
    const shiftTab = findBinding(
      createRawKeymapBindings(() => '  '),
      'Shift-Tab'
    )
    expect(shiftTab.run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('<a>\n<b/>\n</a>')
  })

  it('removes only as much leading whitespace as exists, capped at one unit', () => {
    const view = fakeView('<a>\n <b/>\n</a>', { anchor: 5 })
    const shiftTab = findBinding(
      createRawKeymapBindings(() => '  '),
      'Shift-Tab'
    )
    expect(shiftTab.run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('<a>\n<b/>\n</a>')
  })

  it('leaves an unindented line untouched', () => {
    const view = fakeView('<a>\n<b/>\n</a>', { anchor: 5 })
    const shiftTab = findBinding(
      createRawKeymapBindings(() => '  '),
      'Shift-Tab'
    )
    expect(shiftTab.run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('<a>\n<b/>\n</a>')
  })
})

describe("Enter carries the current line's leading whitespace into the new line", () => {
  it('copies leading whitespace', () => {
    const view = fakeView('<a>\n  <b/>', { anchor: 10 })
    const enter = findBinding(
      createRawKeymapBindings(() => '  '),
      'Enter'
    )
    expect(enter.run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('<a>\n  <b/>\n  ')
  })

  it('does nothing on a read-only document', () => {
    const state = EditorState.create({
      doc: '  a',
      selection: EditorSelection.single(3),
      extensions: [EditorState.readOnly.of(true)]
    })
    const view = {
      state,
      dispatch: () => {
        throw new Error('should not dispatch')
      }
    } as unknown as EditorView
    const enter = findBinding(
      createRawKeymapBindings(() => '  '),
      'Enter'
    )
    expect(enter.run!(view)).toBe(false)
  })
})

describe('Escape arms a one-shot Tab-lets-focus-through hatch', () => {
  it('the first Tab after Escape is un-consumed; the next Tab indents again', () => {
    const view = fakeView('<a>\n<b/>\n</a>', { anchor: 4 })
    const bindings = createRawKeymapBindings(() => '  ')
    const escape = findBinding(bindings, 'Escape')
    const tab = findBinding(bindings, 'Tab')

    expect(escape.run!(view)).toBe(true)
    expect(tab.run!(view)).toBe(false) // let focus traverse
    expect(view.state.doc.toString()).toBe('<a>\n<b/>\n</a>') // unchanged

    expect(tab.run!(view)).toBe(true) // back to indenting
    expect(view.state.doc.toString()).toBe('<a>\n  <b/>\n</a>')
  })

  it('Shift-Tab also honours the armed escape hatch', () => {
    const view = fakeView('<a>\n  <b/>\n</a>', { anchor: 6 })
    const bindings = createRawKeymapBindings(() => '  ')
    const escape = findBinding(bindings, 'Escape')
    const shiftTab = findBinding(bindings, 'Shift-Tab')

    expect(escape.run!(view)).toBe(true)
    expect(shiftTab.run!(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('<a>\n  <b/>\n</a>') // unchanged
  })
})

describe('Backspace and Delete cross a whole line ending, never half of it (R180)', () => {
  const bindings = createRawKeymapBindings(() => '  ')

  it('Backspace at the start of a line removes both bytes of the CRLF', () => {
    const view = fakeCrlfView('alpha\r\nbeta', { anchor: 7 })
    expect(findBinding(bindings, 'Backspace').run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('alphabeta')
    expect(view.state.selection.main.head).toBe(5)
  })

  it('Delete at the visible end of a line removes both bytes of the CRLF', () => {
    const view = fakeCrlfView('alpha\r\nbeta', { anchor: 5 })
    expect(findBinding(bindings, 'Delete').run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('alphabeta')
    expect(view.state.selection.main.head).toBe(5)
  })

  it('falls through to native deletion everywhere else', () => {
    // Returning false un-consumes the key. The round's scope is not to
    // reimplement deletion — a hand-written deleter would have to get grapheme
    // clusters, surrogate pairs and IME state right just to break even.
    const midWord = fakeCrlfView('alpha\r\nbeta', { anchor: 3 })
    expect(findBinding(bindings, 'Backspace').run!(midWord)).toBe(false)
    expect(findBinding(bindings, 'Delete').run!(midWord)).toBe(false)
    expect(midWord.state.doc.toString()).toBe('alpha\r\nbeta')

    const lf = fakeCrlfView('alpha\nbeta', { anchor: 6 })
    expect(findBinding(bindings, 'Backspace').run!(lf)).toBe(false)
    expect(lf.state.doc.toString()).toBe('alpha\nbeta')
  })

  it('falls through for a non-empty selection, which deletes what is selected', () => {
    const selected = fakeCrlfView('alpha\r\nbeta', { anchor: 2, head: 7 })
    expect(findBinding(bindings, 'Backspace').run!(selected)).toBe(false)
    expect(findBinding(bindings, 'Delete').run!(selected)).toBe(false)
    expect(selected.state.doc.toString()).toBe('alpha\r\nbeta')
  })

  it('does nothing on a read-only document', () => {
    let state = EditorState.create({
      doc: 'alpha\r\nbeta',
      extensions: [EditorState.lineSeparator.of('\n'), EditorState.readOnly.of(true)],
      selection: EditorSelection.single(7)
    })
    const view = {
      get state() {
        return state
      },
      dispatch(tr: Transaction) {
        state = state.update(tr).state
      }
    } as unknown as EditorView & { state: EditorState }
    expect(findBinding(bindings, 'Backspace').run!(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('alpha\r\nbeta')
  })
})

describe("Enter inserts the document's own line ending (R181)", () => {
  const bindings = createRawKeymapBindings(() => '  ')

  it('a line added to a CRLF document ends with CRLF', () => {
    // **This is the drift the round exists to stop.** The command built
    // `'\n' + indent`, so every added line got an LF and a CRLF file became a
    // mixed one, one Enter at a time.
    const view = fakeCrlfView('  alpha\r\n  beta\r\n', { anchor: 7 })
    expect(findBinding(bindings, 'Enter').run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('  alpha\r\n  \r\n  beta\r\n')
  })

  it('a line added to an LF document still ends with LF', () => {
    const view = fakeCrlfView('  alpha\n  beta\n', { anchor: 7 })
    expect(findBinding(bindings, 'Enter').run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('  alpha\n  \n  beta\n')
  })

  it('Enter at the end of a CRLF file uses the previous line, not LF', () => {
    // 13, the end of the document — **not** 12, which is between the last
    // `\r` and its `\n`. This fake has no R179 filter, so a caret placed in the
    // gap stays there and the assertion would be about a position the real
    // editor makes unreachable.
    const view = fakeCrlfView('alpha\r\nbeta\r\n', { anchor: 13 })
    expect(findBinding(bindings, 'Enter').run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('alpha\r\nbeta\r\n\r\n')
  })

  it('carries the indent without ever capturing the trailing CR', () => {
    // An indent containing a CR would be a second corruption hiding inside the
    // fix for the first, so this is asserted rather than assumed.
    const view = fakeCrlfView('    deep\r\n', { anchor: 8 })
    expect(findBinding(bindings, 'Enter').run!(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('    deep\r\n    \r\n')
    expect(view.state.doc.toString()).not.toContain('\r    ')
  })
})
