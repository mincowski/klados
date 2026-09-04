/**
 * Grid column collection (M2-PLAN.md E3, CONCEPT.md §4.3). Pure logic, no
 * React — the same `*Model.ts`/`*Logic.ts` split `gridDetection.ts` (E1)
 * uses, exercised directly by `test/gridColumns.test.ts`.
 *
 * A column is identified by name id alone (D-013's grouping rule applied
 * one level down: an attribute and a child node with the same name unify
 * into one column, which is what makes an XML attribute and a JSON
 * property "the same kind of column"). No `FormatCapabilities` lookup
 * anywhere here: `store.attributesOf` is naturally empty for any node that
 * never had `NodeSink.attribute()` called on it (JSON's own nodes, in
 * practice), so scanning it unconditionally already produces the unified
 * behaviour rule 2 requires — checking a capability flag first would only
 * be a format-id branch in a thin disguise.
 */
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'
import { hasChildren } from '../../nodeDisplay'

/** ~60 default columns, with the rest reachable through a column picker
 * (§4.3) — capping by frequency order, so the columns a user is most
 * likely to want survive the cut. */
export const GRID_COLUMN_CAP = 60

/**
 * R34 §6: once the quick filter is scoped and reports what it excluded
 * (§5) and pinning degrades past the viewport (§4), `GRID_COLUMN_CAP` no
 * longer needs to be small to keep those honest — it only decides how many
 * columns show before the user asks for more. The *picker* still needs a
 * hard ceiling, though, so a document with thousands of distinct fields
 * can't grow the shown column set without bound; measured up to 1000
 * columns total (R34 §1) with the fixes in this round, so this sits well
 * above anything ordinary use reaches.
 */
export const GRID_COLUMN_PICKER_CAP = 500

/**
 * A field's per-row shape, tallied into `GridColumn.kindCounts` — the raw
 * material for the header's "widest kind present" icon and its tooltip
 * breakdown (§4.3's "engine — composite in 12 of 40 rows"). Distinct from
 * `gridCell.ts`'s `CellKind`: that is the literal/derived/absent styling
 * question for one visible cell, this is the structural question a whole
 * column's header answers about every row at once.
 */
export const enum FieldKind {
  Attribute,
  ScalarChild,
  CompositeChild,
  RepeatingScalarChild,
  RepeatingCompositeChild
}

const FIELD_KIND_COUNT = 5

function emptyKindCounts(): number[] {
  return new Array<number>(FIELD_KIND_COUNT).fill(0)
}

export interface GridColumn {
  readonly nameId: number
  /** 0-based order this name was first seen among the group's members —
   * the column display order (§4.3: "ordered by first appearance"). */
  readonly firstAppearance: number
  /** Members carrying this field at all, out of the group's total member
   * count — what decides survival past `GRID_COLUMN_CAP`. */
  readonly frequency: number
  /** Indexed by `FieldKind`. */
  readonly kindCounts: readonly number[]
}

/** The largest qualifying group's actual member refs (E1 only counts and
 * names groups; this is the second, later pass over the same children,
 * done only for the group that won — E1's own doc comment on why this
 * isn't folded into detection itself).
 *
 * `groupNameId` is `GroupInfo.nameId` — the group's **resolved** id
 * (R136), so this matches on `resolvedNameIdOf`, the same key
 * `gridDetection.ts` grouped by, not the raw `nameIdOf`. For a document
 * with no namespace resolution in play the two are identical, so this is
 * a no-op change for JSON and namespace-free XML. */
export function collectGroupMembers(
  store: NodeStore,
  parent: NodeRef,
  groupNameId: number
): NodeRef[] {
  const members: NodeRef[] = []
  for (const child of store.childrenOf(parent)) {
    if (store.resolvedNameIdOf(child) === groupNameId && hasChildren(store, child)) {
      members.push(child)
    }
  }
  return members
}

export interface GridColumnResult {
  /** Columns to render, in first-appearance order, capped at
   * `GRID_COLUMN_CAP`. */
  readonly columns: readonly GridColumn[]
  /** Columns beyond the cap, in descending-frequency order (ties broken by
   * first appearance) — what the column picker offers. */
  readonly overflow: readonly GridColumn[]
}

/**
 * One pass over each member's own attributes and named children (§4.3's
 * stated budget: `nameId` reads, no decoding). A member's own children are
 * grouped by name locally first — cheap, bounded by that one member's fan-
 * out — so a field that repeats within a single row (`owner` ×2 on one
 * `car`) is tallied as one `RepeatingScalarChild`/`RepeatingCompositeChild`
 * occurrence for that row, not two separate `ScalarChild` ones.
 *
 * An attribute wins over a same-named child on the same member (a
 * pathological, likely-malformed case — `<car color="red"><color>Blue
 * </color></car>` — that the format grammars don't normally produce): one
 * field, one row, one occurrence, and a defined tie-break beats an
 * undefined one.
 */
export function collectColumns(store: NodeStore, members: readonly NodeRef[]): GridColumnResult {
  const order: number[] = []
  const columnOf = new Map<number, number>() // nameId -> index into `order`
  const frequency: number[] = []
  const counts: number[] = [] // FIELD_KIND_COUNT slots per column, flat

  // Per-member scratch, allocated once and reused: this loop runs 633 K
  // times on `cars-200mb.xml`, and the two `Map`s plus one entry object per
  // distinct field it used to allocate per member cost ~3× the whole
  // function (measured 1084–1135 ms → 357–388 ms, identical output). A
  // member's fan-out is ~6 fields, where a linear scan beats a `Map` lookup
  // outright, so the scratch is parallel arrays reset by `n = 0` rather than
  // anything that has to be cleared or reallocated.
  const fieldName: number[] = []
  const fieldCount: number[] = []
  const fieldComposite: boolean[] = []
  const fieldIsAttr: boolean[] = []

  // R34 §2: the ~6-field assumption above holds for XML/JSON but not for a
  // table, where a member's fan-out is the column count — `findField`'s
  // linear scan then costs O(columns) per field, O(columns²) per member.
  // Below `LINEAR_SCAN_LIMIT` the scan still wins outright (measured); at
  // and above it, switch to a `Map` for this member's remaining lookups.
  // Built lazily, once, from whatever `fieldName` already holds — not
  // allocated for every member, only the ones wide enough to need it.
  const LINEAR_SCAN_LIMIT = 16
  let n = 0
  let fieldIndexByName: Map<number, number> | null = null

  const findField = (nameId: number): number => {
    if (fieldIndexByName !== null) return fieldIndexByName.get(nameId) ?? -1
    for (let k = 0; k < n; k++) if (fieldName[k] === nameId) return k
    return -1
  }

  // Call once, right after a new field is appended at `fieldName[index]`
  // (before `n` is incremented past it) — keeps the Map in sync once it
  // exists, and builds it from the fields seen so far the moment the linear
  // scan stops being the better trade.
  const registerField = (index: number): void => {
    if (fieldIndexByName !== null) {
      fieldIndexByName.set(fieldName[index]!, index)
    } else if (index + 1 >= LINEAR_SCAN_LIMIT) {
      fieldIndexByName = new Map()
      for (let k = 0; k <= index; k++) fieldIndexByName.set(fieldName[k]!, k)
    }
  }

  for (const member of members) {
    n = 0
    fieldIndexByName = null

    for (const attr of store.attributesOf(member)) {
      if (findField(attr.nameId) !== -1) continue
      fieldName[n] = attr.nameId
      fieldCount[n] = 1
      fieldComposite[n] = false
      fieldIsAttr[n] = true
      registerField(n)
      n++
    }

    // Walked directly rather than through `childrenOf`, whose generator
    // allocates a result object per yield on the same hot path.
    for (let child = store.firstChildOf(member); child !== -1; child = store.nextSiblingOf(child)) {
      const nameId = store.nameIdOf(child)
      if (nameId === -1) continue // unnamed: Text/CData/Comment/PI/DocType — not a field
      const at = findField(nameId)
      if (at === -1) {
        fieldName[n] = nameId
        fieldCount[n] = 1
        fieldComposite[n] = hasChildren(store, child)
        fieldIsAttr[n] = false
        registerField(n)
        n++
      } else if (!fieldIsAttr[at]) {
        // An attribute already claimed this name — it wins, and the child is
        // not tallied a second time (a pathological, likely-malformed case
        // the grammars don't normally produce; a defined tie-break beats an
        // undefined one).
        fieldCount[at]!++
        if (hasChildren(store, child)) fieldComposite[at] = true
      }
    }

    for (let k = 0; k < n; k++) {
      const nameId = fieldName[k]!
      let column = columnOf.get(nameId)
      if (column === undefined) {
        column = order.length
        columnOf.set(nameId, column)
        order.push(nameId)
        frequency.push(0)
        for (const zero of emptyKindCounts()) counts.push(zero)
      }
      const kind = fieldIsAttr[k]
        ? FieldKind.Attribute
        : fieldCount[k]! > 1
          ? fieldComposite[k]
            ? FieldKind.RepeatingCompositeChild
            : FieldKind.RepeatingScalarChild
          : fieldComposite[k]
            ? FieldKind.CompositeChild
            : FieldKind.ScalarChild
      frequency[column]!++
      counts[column * FIELD_KIND_COUNT + kind]!++
    }
  }

  const all: GridColumn[] = order.map((nameId, column) => ({
    nameId,
    firstAppearance: column,
    frequency: frequency[column]!,
    kindCounts: counts.slice(column * FIELD_KIND_COUNT, (column + 1) * FIELD_KIND_COUNT)
  }))

  if (all.length <= GRID_COLUMN_CAP) {
    return { columns: all, overflow: [] }
  }

  // Frequency decides survival (ties broken by first appearance, so the
  // result is deterministic and stable across re-selection); the surviving
  // set is then re-sorted back to first-appearance order for display.
  const byFrequencyDesc = [...all].sort(
    (a, b) => b.frequency - a.frequency || a.firstAppearance - b.firstAppearance
  )
  const kept = new Set(byFrequencyDesc.slice(0, GRID_COLUMN_CAP).map((c) => c.nameId))
  const columnsOut = all.filter((c) => kept.has(c.nameId))
  const overflow = byFrequencyDesc.filter((c) => !kept.has(c.nameId))

  return { columns: columnsOut, overflow }
}

/** The header's "widest kind present" (§4.3): composite over scalar,
 * attribute counting as scalar for this purpose (an attribute is always a
 * literal, never composite). */
export function widestKind(column: GridColumn): 'composite' | 'scalar' {
  const composite =
    column.kindCounts[FieldKind.CompositeChild]! +
    column.kindCounts[FieldKind.RepeatingCompositeChild]!
  return composite > 0 ? 'composite' : 'scalar'
}

/** Whether any row shows this field more than once — the "stacked-layers"
 * repeating badge (§4.3), a separate axis from `widestKind`. */
export function isRepeatingColumn(column: GridColumn): boolean {
  return (
    column.kindCounts[FieldKind.RepeatingScalarChild]! +
      column.kindCounts[FieldKind.RepeatingCompositeChild]! >
    0
  )
}
