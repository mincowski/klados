/**
 * The grid cell model (M2-PLAN.md E4, CONCEPT.md §4.3's cell-rendering
 * table). Pure logic, no React — the same `*Model.ts`/`*Logic.ts` split
 * `gridDetection.ts` (E1) and `gridColumns.ts` (E3) use.
 *
 * Computed from `(row, column)` on demand, for one visible cell at a time
 * — never stored per cell (rule 1: no object per cell either). Decodes
 * only what a visible cell needs (invariant 1): a bounded slice of the
 * matching attribute/child's own value span, not the row's full subtree.
 *
 * No `FormatCapabilities` lookup and no branch on which format produced
 * the document anywhere in this module (rule 2) — `store.attributesOf` is
 * naturally empty for a node that never had an attribute recorded on it,
 * so an XML `<car color="red">` and a JSON `"color": "red"` property
 * resolve to a literal cell through the exact same code path, whichever is
 * actually present.
 */
import { NodeFlags, type NodeStore } from '../../../core/nodeStore'
import type { SourceBuffer } from '../../../core/buffer'
import { NodeKind, type NodeRef } from '../../../core/types'
import { EMPTY_DELTA_LIST, type DeltaList } from '../../../core/deltaList'
import { hasChildren } from '../../nodeDisplay'
import { resolveWrapperTarget } from '../../wrapperDescent'
import { translateSpan } from '../../session/spanTranslation'

/** §4.3's governing rule: a cell either shows text verbatim from the
 * document (`Literal`), text Klados generated to summarize something
 * (`Derived`), or nothing because the field isn't present on this row at
 * all (`Absent`). Per cell, not per column (D-017) — a column can be
 * `Literal` on one row and `Derived` on the next. */
export const enum CellKind {
  Absent,
  Literal,
  Derived
}

export interface GridCell {
  readonly kind: CellKind
  /** Decoded display text. `null` for `Absent`, and also for a `Derived`
   * "presence marker" cell (an empty element/property with no value and no
   * children of its own — `<sunroof/>`) — there is no text to show, only
   * the fact that the field exists, which the caller renders as a fixed
   * marker rather than a decoded string. */
  readonly text: string | null
  /** How many same-named occurrences this cell summarizes — 1 for a
   * single field (present or absent alike), the real count for a repeated
   * one (§4.3's `owner` ×2 badge). */
  readonly multiplicity: number
  /** The field's own content is mixed (§4.3's `<desc>a <b>x</b></desc>`) —
   * a further reason the cell is `Derived` even though it never repeats. */
  readonly mixed: boolean
  /** The node to select when the cell is activated (E9: "activating a cell
   * selects the corresponding node in every view") — whatever single node
   * this cell's content actually came from, composite or scalar alike.
   * `null` for an attribute-sourced cell (an attribute isn't an
   * independent node — there is nothing to select but the row itself),
   * for `Absent`, and for a repeated field (no single node a multi-member
   * badge could point to; per-column expansion is post-M2). */
  readonly node: NodeRef | null
}

const ABSENT_CELL: GridCell = {
  kind: CellKind.Absent,
  text: null,
  multiplicity: 0,
  mixed: false,
  node: null
}

const CELL_TEXT_MAX_CHARS = 120
const CELL_TEXT_MAX_BYTES = CELL_TEXT_MAX_CHARS * 4
/** Grandchildren joined into a composite summary (`diesel · 110`) — bounded
 * so a field with dozens of sub-fields doesn't produce an unreadable cell;
 * a full breakdown belongs in the drill-in target, not the summary. */
const COMPOSITE_SUMMARY_MAX_FIELDS = 4
/** Repeated scalar occurrences joined into one cell (`Smith, Jones`) —
 * bounded for the same reason; the multiplicity badge already carries the
 * true count regardless of how many are actually joined into the text. */
const REPEATED_JOIN_MAX = 20

/**
 * A known gap, not a format branch: JSON string *values* carry their
 * surrounding quotes inside their own value span by parser design
 * (`jsonParser.test.ts`, "value spans include the surrounding quotes for
 * strings" — XML's attribute/text values never do, `scanAttributeValue`
 * explicitly excludes its delimiters). §4.3's literal/derived contract
 * requires an XML attribute and a JSON property with the same logical
 * value to render the *same* cell text, so an un-stripped `"red"` next to
 * `red` would visibly fail this module's own "no format branch" claim —
 * more visibly than leaving it in.
 *
 * There is no per-node "is this JSON" signal available here (rule 2), so
 * this strips a leading+trailing `"` structurally, on the decoded text
 * alone, for every value this module decodes. The trade-off is real: an
 * XML value whose data itself happens to start and end with a literal `"`
 * (e.g. an attribute delimited with `'` around content like `"quoted"`)
 * loses those quotes here too. Accepted for the grid specifically, where
 * the parity requirement is explicit; Detail's own Value block has the
 * identical unstripped-quotes gap today, unexercised by any test — a real
 * fix is a shared "logical scalar text" primitive per `FormatModule`, not
 * a case worth inventing narrowly for this one call site.
 */
function stripJsonStringQuotes(text: string): string {
  if (
    text.length >= 2 &&
    text.charCodeAt(0) === 0x22 &&
    text.charCodeAt(text.length - 1) === 0x22
  ) {
    return text.slice(1, -1)
  }
  return text
}

function decodeBounded(source: SourceBuffer, start: number, end: number): string {
  const boundedEnd = source.snapToCharBoundary(Math.min(end, start + CELL_TEXT_MAX_BYTES))
  return stripJsonStringQuotes(source.slice(start, boundedEnd))
}

/** A leaf's own folded value, decoded — `null` when the leaf genuinely has
 * none (an empty element/property). R42/D-070: `span` is translated through
 * `deltas` before decoding, same as every other read path in this file. */
function scalarTextOf(
  store: NodeStore,
  source: SourceBuffer,
  node: NodeRef,
  deltas: DeltaList
): string | null {
  const rawSpan = store.ownValueOf(node)
  if (rawSpan === null) return null
  const span = translateSpan(rawSpan, deltas)
  return decodeBounded(source, span.start, span.end)
}

/** `diesel · 110` from `<engine><type>diesel</type><kw>110</kw></engine>`
 * — the composite child's own first-level scalar values, joined in
 * document order. A grandchild that is itself composite (nested further)
 * contributes nothing to the summary rather than recursing — a summary of
 * a summary stops being a summary — so an all-composite composite falls
 * back to a field count instead of an empty string. */
function compositeSummaryOf(
  store: NodeStore,
  source: SourceBuffer,
  node: NodeRef,
  deltas: DeltaList
): string {
  const parts: string[] = []
  for (const child of store.childrenOf(node)) {
    if (parts.length >= COMPOSITE_SUMMARY_MAX_FIELDS) break
    const text = scalarTextOf(store, source, child, deltas)
    if (text !== null) parts.push(text)
  }
  if (parts.length > 0) return parts.join(' · ')
  const fieldCount = [...store.childrenOf(node)].length
  return `${fieldCount} field${fieldCount === 1 ? '' : 's'}`
}

/** The flattened text runs of a mixed-content node (§4.3's `<desc>a
 * <b>x</b></desc>` → `"a"`, marked mixed) — its direct `Text`/`CData`
 * children's own value spans, joined; nested elements contribute nothing,
 * same reasoning as `compositeSummaryOf`. */
function mixedTextOf(
  store: NodeStore,
  source: SourceBuffer,
  node: NodeRef,
  deltas: DeltaList
): string {
  const parts: string[] = []
  for (const child of store.childrenOf(node)) {
    const kind = store.kindOf(child)
    if (kind !== NodeKind.Text && kind !== NodeKind.CData) continue
    const rawSpan = store.ownValueOf(child)
    if (rawSpan !== null) {
      const span = translateSpan(rawSpan, deltas)
      parts.push(decodeBounded(source, span.start, span.end))
    }
  }
  return parts.join(' ').trim()
}

/**
 * `node` itself, if it's an `Array` — or, if `node` has exactly one child
 * and that child is an `Array`, that child. The second case is what an
 * *empty* JSON array value reaches: `resolveWrapperTarget` never descends
 * into it (CONCEPT.md §3.2 — composite means "has children," and `[]`
 * doesn't — so a Property wrapping only `[]` fails the wrapper's own
 * "exactly one composite child" test and stays put), but it is still the
 * right node to treat as this field's occurrence list, now empty rather
 * than absent from the resolution entirely.
 */
function arrayValueOf(store: NodeStore, node: NodeRef): NodeRef | null {
  if (store.kindOf(node) === NodeKind.Array) return node
  const first = store.firstChildOf(node)
  if (first === -1 || store.nextSiblingOf(first) !== -1) return null
  return store.kindOf(first) === NodeKind.Array ? first : null
}

/**
 * A single field occurrence — `node` is the thing to render (a leaf, a
 * composite, or, after unwrapping, an `Array`). Resolves wrapper
 * indirection first (see the note on `resolveWrapperTarget` below), then
 * — the second half of the same asymmetry — checks whether what's left is
 * an `Array`: XML's repeating fields are multiple direct same-named
 * siblings (handled by `cellForOccurrences`'s caller before this function
 * is ever reached), but JSON's are one Property whose value is a single
 * `Array` node (`"owner": ["Smith", "Jones"]`). Recursing into that
 * array's own elements as the occurrence list is what makes `"owner":
 * ["Smith","Jones"]` and `<owner>Smith</owner><owner>Jones</owner>` render
 * identically — an `Array` never appears in XML's tree at all, so this
 * never fires for it.
 */
function cellForSingleField(
  store: NodeStore,
  source: SourceBuffer,
  node: NodeRef,
  deltas: DeltaList
): GridCell {
  if (!hasChildren(store, node)) {
    const text = scalarTextOf(store, source, node, deltas)
    if (text === null) {
      return { kind: CellKind.Derived, text: null, multiplicity: 1, mixed: false, node }
    }
    return { kind: CellKind.Literal, text, multiplicity: 1, mixed: false, node }
  }

  // D-030's folding is asymmetric the same way E2 found it to be for
  // wrapper descent: an XML composite field's children *are* its fields
  // (`<engine><type>…`), but a JSON composite field is a Property whose
  // one child is a further, separate Object/Array node — the Property
  // itself has nothing to summarize. `resolveWrapperTarget` (already
  // built for exactly this shape) finds the real node in one call; for
  // XML it's a same-node no-op (an Element's own children already are its
  // fields, so it never qualifies as a wrapper here).
  const resolved = resolveWrapperTarget(store, node).destination
  const array = arrayValueOf(store, resolved)
  if (array !== null) {
    return cellForOccurrences(store, source, [...store.childrenOf(array)], array, deltas)
  }

  const mixed = store.hasFlag(resolved, NodeFlags.IsMixed)
  return {
    kind: CellKind.Derived,
    text: mixed
      ? mixedTextOf(store, source, resolved, deltas)
      : compositeSummaryOf(store, source, resolved, deltas),
    multiplicity: 1,
    mixed,
    node: resolved
  }
}

/**
 * `occurrences` is every node found for one field on one row — direct
 * same-named XML siblings, or a JSON array's elements once
 * `cellForSingleField` has unwrapped down to them. Falls through to
 * `cellForSingleField` for exactly one occurrence (an `owner` array of one
 * element must render identically to a single direct `<owner>`, not as a
 * dimmed ×1 — D-016's whole point is that the dimming carries multiplicity,
 * so a multiplicity of one must never dim), and handles zero specially
 * only because a JSON `[]` value can reach here with no XML equivalent to
 * fall back on (an XML field with zero occurrences is simply absent, never
 * an empty repeating group).
 */
function cellForOccurrences(
  store: NodeStore,
  source: SourceBuffer,
  occurrences: readonly NodeRef[],
  drillFallback: NodeRef,
  deltas: DeltaList
): GridCell {
  if (occurrences.length === 0) {
    return {
      kind: CellKind.Derived,
      text: '0 items',
      multiplicity: 0,
      mixed: false,
      node: drillFallback
    }
  }
  if (occurrences.length === 1) {
    return cellForSingleField(store, source, occurrences[0]!, deltas)
  }

  const anyComposite = occurrences.some((m) => hasChildren(store, m))
  if (anyComposite) {
    return {
      kind: CellKind.Derived,
      text: `${occurrences.length} items`,
      multiplicity: occurrences.length,
      mixed: false,
      node: null
    }
  }
  const joined = occurrences
    .slice(0, REPEATED_JOIN_MAX)
    .map((m) => scalarTextOf(store, source, m, deltas) ?? '')
    .join(', ')
  return {
    kind: CellKind.Derived,
    text: joined,
    multiplicity: occurrences.length,
    mixed: false,
    node: null
  }
}

function cellFromAttributeSpan(
  source: SourceBuffer,
  valueStart: number,
  valueEnd: number,
  deltas: DeltaList
): GridCell {
  const span = translateSpan({ start: valueStart, end: valueEnd }, deltas)
  return {
    kind: CellKind.Literal,
    text: decodeBounded(source, span.start, span.end),
    multiplicity: 1,
    mixed: false,
    node: null
  }
}

// More than one direct same-named child only happens in XML (repeating
// Elements, e.g. `<owner>Smith</owner><owner>Jones</owner>`) — JSON's
// Property/Array indirection means a JSON repeat is always exactly one
// match here, unwrapped inside `cellForSingleField` instead.
function cellFromChildMatches(
  store: NodeStore,
  source: SourceBuffer,
  matches: readonly NodeRef[],
  deltas: DeltaList
): GridCell {
  if (matches.length === 0) return ABSENT_CELL
  return matches.length === 1
    ? cellForSingleField(store, source, matches[0]!, deltas)
    : cellForOccurrences(store, source, matches, matches[0]!, deltas)
}

/**
 * The cell for `row`'s field named `columnNameId` — §4.3's full table, one
 * function. An attribute wins over a same-named child (see
 * `gridColumns.ts`'s `collectColumns` for why: the same tie-break, kept
 * consistent so a column's header stats and its cells never disagree about
 * which field a given row actually shows).
 */
export function cellOf(
  store: NodeStore,
  source: SourceBuffer,
  row: NodeRef,
  columnNameId: number,
  deltas: DeltaList = EMPTY_DELTA_LIST
): GridCell {
  for (const attr of store.attributesOf(row)) {
    if (attr.nameId === columnNameId) {
      return cellFromAttributeSpan(source, attr.valueStart, attr.valueEnd, deltas)
    }
  }

  const matches: NodeRef[] = []
  for (const child of store.childrenOf(row)) {
    if (store.nameIdOf(child) === columnNameId) matches.push(child)
  }
  return cellFromChildMatches(store, source, matches, deltas)
}

/**
 * Every distinct field `row` actually has, keyed by name id — one
 * structural pass over its own attributes and children (the same
 * attribute-wins tie-break `collectColumns` uses), each decoded once.
 *
 * R34 §5: `gridFilter.ts`'s quick filter used to call `cellOf` once per
 * *visible* column, and `cellOf` itself re-scans the row's attributes and
 * children on every call — O(visibleColumns × rowFanOut) per row. This is
 * the O(rowFanOut) primitive that replaces it: one scan, however many
 * fields the row actually has, regardless of how many columns are shown.
 */
export function rowFields(
  store: NodeStore,
  source: SourceBuffer,
  row: NodeRef,
  deltas: DeltaList = EMPTY_DELTA_LIST
): ReadonlyMap<number, GridCell> {
  const result = new Map<number, GridCell>()
  for (const attr of store.attributesOf(row)) {
    if (!result.has(attr.nameId)) {
      result.set(attr.nameId, cellFromAttributeSpan(source, attr.valueStart, attr.valueEnd, deltas))
    }
  }
  const childMatches = new Map<number, NodeRef[]>()
  for (const child of store.childrenOf(row)) {
    const nameId = store.nameIdOf(child)
    if (nameId === -1 || result.has(nameId)) continue // unnamed, or an attribute already claimed it
    const matches = childMatches.get(nameId)
    if (matches === undefined) childMatches.set(nameId, [child])
    else matches.push(child)
  }
  for (const [nameId, matches] of childMatches) {
    result.set(nameId, cellFromChildMatches(store, source, matches, deltas))
  }
  return result
}
