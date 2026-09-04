/**
 * Pure logic for the Raw View's syntax and selection decorations
 * (M1-PLAN.md D11, CONCEPT.md §4.4). Kept free of CodeMirror so the
 * viewport-scoped node walk and the offsets it produces can be exercised
 * directly by `test/decorations.test.ts`; `rawDecorations.ts` is the thin
 * layer that turns a `DecorationSpan[]` into actual CodeMirror decorations.
 *
 * **What this can and can't highlight, and why.** `NodeStore` retains
 * precise byte offsets for a node's *value* (`ownValueOf`/`valueOf`) and an
 * attribute's *value* (`attributesOf`'s `valueStart`/`valueEnd`), and for a
 * Comment's own span (its full extent, delimiters included, is the whole
 * node). It does **not** retain a node's *name* span or an attribute's name
 * span — only the interned string, via `nameOf`/`textOf`. Storing those
 * would mean two more `Int32Array`s in `NodeStoreBuffers`, at 6.6M nodes on
 * `CONCEPT.md`'s own reference document — real memory for a cosmetic
 * feature the format contract was deliberately built without. So:
 *
 * - **XML element tag names** *are* highlighted anyway, via a grammar
 *   guarantee rather than stored offsets: an element's span always opens
 *   with `<` immediately followed by its name (`formats/xml/index.ts`'s
 *   `parseStartTag` advances exactly one byte past `<` before scanning the
 *   name) — `nameStart = spanStart + 1` is exact, not a heuristic, and the
 *   name's own encoded byte length gives `nameEnd`.
 * - **Attribute names** are not — reconstructing a name's start from its
 *   value's start would mean re-deriving how much whitespace preceded `=`,
 *   which is not recoverable from what the store keeps. Attribute *values*
 *   are highlighted; attribute names render unstyled. A real fix is
 *   storing the offsets, which is a "stop and report" cost decision, not
 *   one this task makes unilaterally.
 * - **Punctuation** (`<`, `>`, `=`, quotes, JSON's `{}[]:,"`) is not
 *   highlighted for the same reason — no stored offsets to draw on without
 *   re-scanning bytes this module has no independent way to validate
 *   against the parse the tree already did.
 */
import type { NodeStore } from '../../../core/nodeStore'
import type { SourceBuffer } from '../../../core/buffer'
import { NodeKind, type NodeRef, type Offset } from '../../../core/types'
import { EMPTY_DELTA_LIST, type DeltaList } from '../../../core/deltaList'
import { lastNodeStartingAtOrBefore } from '../../nodeSpanLookup'
import { translateSpan } from '../../session/spanTranslation'

export type SyntaxClass = 'tagName' | 'string' | 'number' | 'keyword' | 'comment'

export interface DecorationSpan {
  readonly start: Offset
  readonly end: Offset
  readonly className: SyntaxClass
}

const utf8Encoder = new TextEncoder()

function classifyJsonValue(source: SourceBuffer, start: Offset, end: Offset): SyntaxClass {
  if (end <= start) return 'string'
  const first = source.slice(start, source.snapToCharBoundary(start + 1))
  if (first === '"') return 'string'
  if (first === 't' || first === 'f' || first === 'n') return 'keyword' // true / false / null
  return 'number' // a digit or '-' — JSON has no other scalar lead byte
}

/** Every decoration this node itself contributes — never its descendants',
 * which the caller reaches by walking to them separately. */
function decorationsForNode(
  store: NodeStore,
  source: SourceBuffer,
  node: NodeRef,
  deltas: DeltaList
): DecorationSpan[] {
  const spans: DecorationSpan[] = []
  const kind = store.kindOf(node)

  switch (kind) {
    case NodeKind.Element: {
      const name = store.nameOf(node)
      if (name !== null) {
        // R42 addendum (`R42-stale-spans.md`): both ends of the name's
        // span are computed in *original* (pre-edit) coordinates first —
        // `originalSpan.start + 1` for the start, plus the *interned* name's
        // own byte length (necessarily the previous parse's, since `name`
        // itself only refreshes at reparse) for the end — and only then
        // translated as a pair through `deltas`. Translating a synthetic
        // `nameEnd` derived from an already-translated `nameStart` (the
        // previous version of this code) is wrong specifically for an edit
        // *inside* the name itself: `nameStart` correctly doesn't move (the
        // edit is after it), but `nameEnd` needs its own shift — a pure
        // insertion strictly between two original boundaries moves the
        // later one and not the earlier one (D-070 §3b), which only holds
        // when both are actually run through `shiftedOffset` independently.
        const originalSpan = store.spanOf(node)
        const originalNameStart = originalSpan.start + 1
        const originalNameEnd = originalNameStart + utf8Encoder.encode(name).length
        const span = translateSpan({ start: originalNameStart, end: originalNameEnd }, deltas)
        spans.push({ start: span.start, end: span.end, className: 'tagName' })
      }
      // A leaf element's text is folded onto the element itself rather than
      // a separate Text child (§3.2's node-density rule, D-030) — without
      // this, a leaf like `<a>hello</a>` would highlight its tag but never
      // its text, since `NodeKind.Text` below only ever sees the *unfolded*
      // case.
      const ownValue = store.ownValueOf(node)
      if (ownValue !== null) {
        spans.push({ ...translateSpan(ownValue, deltas), className: 'string' })
      }
      break
    }
    case NodeKind.Comment: {
      const span = translateSpan(store.spanOf(node), deltas)
      spans.push({ start: span.start, end: span.end, className: 'comment' })
      break
    }
    case NodeKind.Scalar:
    case NodeKind.Property: {
      const rawValue = store.ownValueOf(node)
      if (rawValue !== null) {
        const value = translateSpan(rawValue, deltas)
        spans.push({ ...value, className: classifyJsonValue(source, value.start, value.end) })
      }
      break
    }
    case NodeKind.Text:
    case NodeKind.CData: {
      const rawValue = store.ownValueOf(node)
      if (rawValue !== null) {
        spans.push({ ...translateSpan(rawValue, deltas), className: 'string' })
      }
      break
    }
    default:
      break
  }

  for (const attr of store.attributesOf(node)) {
    const span = translateSpan({ start: attr.valueStart, end: attr.valueEnd }, deltas)
    spans.push({ start: span.start, end: span.end, className: 'string' })
  }

  return spans
}

/**
 * Decorations for every node whose own decoration span (not its full
 * subtree) overlaps `[from, to)`. Two passes:
 *
 * 1. **Ancestors of the last node starting at or before `from`.** A node
 *    that opened earlier but hasn't closed yet (an element wrapping `from`)
 *    is exactly the ancestor chain of whichever node most recently opened
 *    — bounded by document depth, cheap regardless of document size.
 * 2. **Forward from that same node** until a node's `spanStart >= to` —
 *    every node's own decoration spans start at or after its `spanStart`,
 *    so once that's past `to`, nothing further can still be in range.
 *    Spans are in document order (node refs *are* that order), which is
 *    what makes a forward walk instead of a full scan correct.
 *
 * Every returned span is clipped to `[from, to)` — never partially outside
 * it, regardless of how far the underlying node's own value/comment/tag
 * span actually extends. This is what keeps a node whose span straddles a
 * window or viewport edge safe to decorate on both sides independently,
 * one call each: the caller's `[from, to)` is the source of truth for the
 * decoration's own bounds, not this function's guess about the caller's
 * intent.
 */
export function viewportDecorations(
  store: NodeStore,
  source: SourceBuffer,
  from: Offset,
  to: Offset,
  deltas: DeltaList = EMPTY_DELTA_LIST
): DecorationSpan[] {
  if (store.nodeCount === 0 || from >= to) return []

  const spans: DecorationSpan[] = []
  const clip = (span: DecorationSpan): DecorationSpan | null => {
    const start = Math.max(span.start, from)
    const end = Math.min(span.end, to)
    return start < end ? { start, end, className: span.className } : null
  }

  // `from`/`to` are already live-buffer (current) coordinates — `Raw.tsx`
  // derives them from the CodeMirror viewport, which shows the live buffer
  // directly. `lastNodeStartingAtOrBefore`/the forward walk below still
  // search by `store`'s own (stale) span starts, so the anchor is found in
  // *store* coordinates; `decorationsForNode`'s own translation is what
  // reconciles the two once a span is actually read.
  const anchor = lastNodeStartingAtOrBefore(store, from)

  for (
    let ancestor = store.parentOf(anchor);
    ancestor !== -1;
    ancestor = store.parentOf(ancestor)
  ) {
    for (const span of decorationsForNode(store, source, ancestor, deltas)) {
      const clipped = clip(span)
      if (clipped !== null) spans.push(clipped)
    }
  }

  for (let node = anchor; node !== -1 && node < store.nodeCount; node++) {
    if (translateSpan(store.spanOf(node), deltas).start >= to) break
    for (const span of decorationsForNode(store, source, node, deltas)) {
      const clipped = clip(span)
      if (clipped !== null) spans.push(clipped)
    }
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  return spans
}

export interface Range {
  readonly start: Offset
  readonly end: Offset
}

/**
 * The selected node's own span, clipped to `[windowStart, windowEnd)` —
 * `null` when the node lies outside the window entirely, which is the
 * normal case for most of a document's life and not an error (§4.4:
 * "simply absent when the node lies outside it," the document layer holds
 * the selection regardless of what the Raw View currently shows). No
 * `SyntaxClass` — this is a highlight, not a syntax token, and
 * `rawDecorations.ts` applies its own dedicated CSS class to it.
 */
export function selectionDecoration(
  store: NodeStore,
  selectedNode: NodeRef,
  windowStart: Offset,
  windowEnd: Offset,
  deltas: DeltaList = EMPTY_DELTA_LIST
): Range | null {
  if (selectedNode < 0 || selectedNode >= store.nodeCount) return null
  const span = translateSpan(store.spanOf(selectedNode), deltas)
  const start = Math.max(span.start, windowStart)
  const end = Math.min(span.end, windowEnd)
  return start < end ? { start, end } : null
}
