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
