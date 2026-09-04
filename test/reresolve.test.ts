/**
 * M3-PLAN.md F5 — CONCEPT.md §5.1's three-step selection cascade. Each test
 * parses an "old" document, picks a selection, parses an "edited" version
 * as a stand-in for what a reparse produces, and asserts which step
 * resolved the selection and to which node — the acceptance criteria taken
 * literally, same style as `subtreeSplice.test.ts`'s "assert it, do not
 * eyeball it."
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { reresolveSelection } from '../src/renderer/navigation/reresolve'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const ROOT = 0
const NO_SELECTION = -1

function parseXml(text: string): NodeStore {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  const result = xmlFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('test fixture must parse completely')
  return store
}

/** The single child of `parent` named `name`, at 0-based `occurrence` among
 * same-named siblings — a small helper so tests can pick "the node named X"
 * without hand-walking `firstChildOf`/`nextSiblingOf` everywhere. */
function childNamed(store: NodeStore, parent: number, name: string, occurrence = 0): number {
  let seen = 0
  for (let child = store.firstChildOf(parent); child !== -1; child = store.nextSiblingOf(child)) {
    if (store.nameOf(child) === name) {
      if (seen === occurrence) return child
      seen++
    }
  }
  throw new Error(`no child named ${name} at occurrence ${occurrence}`)
}

describe('reresolveSelection — step 1: structural path', () => {
  it('editing text before the selected node keeps the same node selected', () => {
    const oldStore = parseXml('<root><a>1</a><b>2</b></root>')
    const oldB = childNamed(oldStore, childNamed(oldStore, ROOT, 'root'), 'b')

    const newStore = parseXml('<root><a>100</a><b>2</b></root>')
    const newB = childNamed(newStore, childNamed(newStore, ROOT, 'root'), 'b')

    const result = reresolveSelection(oldStore, oldB, newStore, 0)
    expect(result).toEqual({ node: newB, step: 1, silent: true })
  })

  it('the Document node itself always resolves trivially', () => {
    const oldStore = parseXml('<root>1</root>')
    const newStore = parseXml('<root>2</root>')
    const result = reresolveSelection(oldStore, ROOT, newStore, 0)
    expect(result).toEqual({ node: ROOT, step: 1, silent: true })
  })

  it('a same-named sibling shift is a known, documented imprecision — position-stable, not content-stable', () => {
    // Selecting the 2nd <item> then inserting a new <item> before the
    // first shifts every later item's same-name position by one. Step 1
    // matches by (name, kind, position) — "always safe, not always
    // minimal" (nodeSpanLookup.ts's own words for the same tradeoff) — so
    // it silently lands on the *new* 2nd item, not the one the user
    // actually had selected. Documented here as the accepted behavior,
    // not a bug: the plan's own step 1 has no content-identity concept to
    // do better with.
    const oldStore = parseXml('<root><item>a</item><item>b</item><item>c</item></root>')
    const oldRoot = childNamed(oldStore, ROOT, 'root')
    const oldSecondItem = childNamed(oldStore, oldRoot, 'item', 1) // "b"

    const newStore = parseXml(
      '<root><item>z</item><item>a</item><item>b</item><item>c</item></root>'
    )
    const newRoot = childNamed(newStore, ROOT, 'root')
    const newSecondItem = childNamed(newStore, newRoot, 'item', 1) // "a", not "b"

    const result = reresolveSelection(oldStore, oldSecondItem, newStore, 0)
    expect(result).toEqual({ node: newSecondItem, step: 1, silent: true })
  })
})

describe('reresolveSelection — step 2: caret offset, scoped to the surviving ancestor', () => {
  it('a caret inside the surviving ancestor resolves to the specific node it lands on, not just the ancestor', () => {
    // <c> is replaced by a same-position, differently-named <x> — the
    // structural walk stops at <a> (the deepest surviving ancestor), but
    // the caret (where the edit actually happened) lands inside the new
    // <x>, which is what a caret-driven "the edit is right here" recovery
    // should select — not <a> itself, which is what step 3 alone would
    // give.
    const oldStore = parseXml('<root><a><b>1</b><c>2</c><e>3</e></a></root>')
    const oldRoot = childNamed(oldStore, ROOT, 'root')
    const oldA = childNamed(oldStore, oldRoot, 'a')
    const oldSelected = childNamed(oldStore, oldA, 'c')

    const newText = '<root><a><b>1</b><x>99</x><e>3</e></a></root>'
    const newStore = parseXml(newText)
    const newRoot = childNamed(newStore, ROOT, 'root')
    const newA = childNamed(newStore, newRoot, 'a')
    const newX = childNamed(newStore, newA, 'x')
    const caretInsideX = newText.indexOf('99')

    const result = reresolveSelection(oldStore, oldSelected, newStore, caretInsideX)
    expect(result).toEqual({ node: newX, step: 2, silent: false })
  })

  it('no previous selection resolves purely from the caret', () => {
    const oldStore = parseXml('<root/>')
    const newText = '<root><a>1</a></root>'
    const newStore = parseXml(newText)
    const newA = childNamed(newStore, ROOT, 'root')
    const caretInsideA = newText.indexOf('1')

    const result = reresolveSelection(oldStore, NO_SELECTION, newStore, caretInsideA)
    expect(result).toEqual({ node: childNamed(newStore, newA, 'a'), step: 2, silent: false })
  })
})

describe('reresolveSelection — step 3: nearest surviving ancestor', () => {
  it('deleting the selected node selects its nearest surviving ancestor when the caret is unrelated to the edit', () => {
    const oldStore = parseXml('<root><a><b>1</b><c>2</c></a><d>3</d></root>')
    const oldRoot = childNamed(oldStore, ROOT, 'root')
    const oldA = childNamed(oldStore, oldRoot, 'a')
    const oldSelected = childNamed(oldStore, oldA, 'c')

    const newText = '<root><a><b>1</b></a><d>3</d></root>'
    const newStore = parseXml(newText)
    const newRoot = childNamed(newStore, ROOT, 'root')
    const newA = childNamed(newStore, newRoot, 'a')
    // Caret sits inside the unrelated <d>, nowhere near where <c> used to
    // be — nothing ties it to the old selection's own lineage.
    const caretInsideD = newText.indexOf('3')

    const result = reresolveSelection(oldStore, oldSelected, newStore, caretInsideD)
    expect(result).toEqual({ node: newA, step: 3, silent: false })
  })

  it('falls back to the document root when nothing deeper survives and the caret is nowhere any node claims', () => {
    const oldStore = parseXml('<root><a><b>1</b></a></root>')
    const oldRoot = childNamed(oldStore, ROOT, 'root')
    const oldSelected = childNamed(oldStore, oldRoot, 'a')

    // Leading whitespace before the root element belongs to no node but
    // the Document itself — a caret there gives step 2 nothing more
    // specific to offer than step 3's own floor.
    const newText = '   <different>2</different>'
    const newStore = parseXml(newText)

    const result = reresolveSelection(oldStore, oldSelected, newStore, 0)
    expect(result).toEqual({ node: ROOT, step: 2, silent: false })
  })

  it('a caret elsewhere in the document still resolves somewhere once the ancestor floor is the document root itself', () => {
    // Once the surviving ancestor degenerates all the way to the document
    // root, every node in the document is trivially "within" it — so the
    // caret-scoped step 2 always has something to offer instead of
    // blindly landing on the invisible Document node. That's a real,
    // intentional emergent property of scoping step 2 to the surviving
    // ancestor rather than a special case: root is a universal ancestor.
    const oldStore = parseXml('<root><a><b>1</b></a></root>')
    const oldRoot = childNamed(oldStore, ROOT, 'root')
    const oldSelected = childNamed(oldStore, oldRoot, 'a')

    const newText = '<different>2</different>'
    const newStore = parseXml(newText)
    const newDifferent = childNamed(newStore, ROOT, 'different')

    const result = reresolveSelection(oldStore, oldSelected, newStore, 0)
    expect(result).toEqual({ node: newDifferent, step: 2, silent: false })
  })
})

describe('reresolveSelection — edge cases', () => {
  it('a store with zero nodes resolves to NO_SELECTION', () => {
    const oldStore = parseXml('<root/>')
    const emptyStore = new NodeStore(new Uint8Array(0), new Interner())
    const result = reresolveSelection(oldStore, ROOT, emptyStore, 0)
    expect(result).toEqual({ node: NO_SELECTION, step: 3, silent: false })
  })
})
