/**
 * Grid group detection (M2-PLAN.md E1, CONCEPT.md §4.3's detection algorithm).
 * Pure logic, no React — the same `*Model.ts`/`*Logic.ts` split every other
 * view uses, so `test/gridDetection.test.ts` can exercise it directly.
 */
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'
import { isGridEligible } from '../../nodeDisplay'

/**
 * A group qualifies with at least this many members (§4.3, D-014) — below
 * this a "group" is a single occurrence, not a repeat; E9's manual override
 * is what resolves that ambiguity, not a lower floor here.
 */
export const GRID_MIN_MEMBERS = 2

/**
 * A group qualifies only once it covers at least this share of the node's
 * composite children (§4.3, D-014) — a floor, not a majority: two groups
 * cannot both exceed 80%, so a majority threshold would make a second
 * qualifying group arithmetically impossible. Exported because §13 lists it
 * as a guess awaiting real documents (E10).
 */
export const GRID_MIN_COVERAGE = 0.05

export interface GroupInfo {
  /** The child's own **resolved** name id (`NodeStore.resolvedNameIdOf`,
   * R134/R136) — D-013's "name alone, no shape signature," with "name" now
   * meaning the resolved `(URI, localName)` identity for XML rather than
   * the raw interned spelling. §4.3 groups by the resolved id so that two
   * sections using different namespace prefixes for one element group
   * together (`<soap:Body>` and `<s:Body>`, one URI). For non-namespaced
   * documents (JSON, or an XML document that never declares one)
   * `resolvedNameIdOf` returns the same value `nameIdOf` always did, so
   * this closes the gap this comment used to describe without changing
   * anything for the common case.
   *
   * **Not the raw `nameId`** — `gridColumns.ts`'s `collectGroupMembers`
   * matches members against this same resolved id, not against
   * `store.nameIdOf`, so the two stay consistent. Column headers still
   * render from a member's own raw `nameId` (the prefix as written); only
   * the grouping key changed.
   */
  readonly nameId: number
  readonly memberCount: number
}

export interface GridDetectionResult {
  /** Children eligible to be a grid record: they have at least one child of
   * their own (CONCEPT.md §3.2's "composite"), **or** at least one scalar
   * facet (D-088 — a CSV row, R145 §2, is `attribute()`-only by design and
   * would otherwise never qualify). Ineligible children — leaf elements,
   * folded scalars, Text/Comment/PI/DocType — never enter a group (rule 4)
   * and are not counted here. */
  readonly compositeChildCount: number
  /** Every distinct-name group found among the composite children, in no
   * particular order — including groups too small or too sparse to qualify,
   * so a caller can report "3 magazines" alongside the 40-book grid. */
  readonly groups: readonly GroupInfo[]
  /** The largest qualifying group (§4.3 rule 3), or `null` when none
   * qualifies — a single `<car>` among otherwise-heterogeneous children
   * produces no grid (rule: `≥ 2 members`), which is the single-occurrence
   * ambiguity E9's manual override resolves. */
  readonly grid: GroupInfo | null
}

/**
 * One pass over `node`'s children: a `nameId` read and a counter per
 * distinct id, no decoding and no allocation per child (§4.3's stated
 * budget — under 50 ms for 2 M children, measured in E10). Only the count
 * per name is collected here; gathering the winning group's actual member
 * refs is a second, later pass (E3's column collection), done only for the
 * group that wins.
 */
export function detectGrid(store: NodeStore, node: NodeRef): GridDetectionResult {
  const counts = new Map<number, number>()
  let compositeChildCount = 0

  for (const child of store.childrenOf(node)) {
    if (!isGridEligible(store, child)) continue
    compositeChildCount++
    const nameId = store.resolvedNameIdOf(child)
    counts.set(nameId, (counts.get(nameId) ?? 0) + 1)
  }

  const groups: GroupInfo[] = []
  let grid: GroupInfo | null = null

  for (const [nameId, memberCount] of counts) {
    const group: GroupInfo = { nameId, memberCount }
    groups.push(group)

    const qualifies =
      memberCount >= GRID_MIN_MEMBERS && memberCount / compositeChildCount >= GRID_MIN_COVERAGE
    // Strict '>': a tie keeps whichever group was encountered first (Map
    // iteration order is insertion order, i.e. first appearance among the
    // children) — an arbitrary but stable and deterministic tie-break, since
    // §4.3 does not specify one and D-014 only rules out two groups both
    // exceeding 80%, not an exact tie below it.
    if (qualifies && (grid === null || memberCount > grid.memberCount)) {
      grid = group
    }
  }

  return { compositeChildCount, groups, grid }
}
