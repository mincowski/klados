/**
 * Grid group detection (M2-PLAN.md E1, CONCEPT.md §4.3's detection algorithm).
 * Pure logic, no React — the same `*Model.ts`/`*Logic.ts` split every other
 * view uses, so `test/gridDetection.test.ts` can exercise it directly.
 *
 * **R210 (`docs/plans/R210-grid-grouping.md`) replaced the model.** It used
 * to promote the *largest* qualifying group to be **the** table: three
 * `<a>` and two `<b>` gave an `<a>` table, and adding two more `<b>`
 * switched the whole view to a `<b>` table. The output was a function of the
 * document's *data* rather than its *structure*, with a tie-break this
 * file's own comment admitted was arbitrary. Now every group of at least
 * `GRID_MIN_MEMBERS` is its own table, in document order, and adding members
 * to one group can never change which groups render.
 *
 * **And it is one pass, which is a specification rather than a preference**
 * (§8, from §4's measurement). Collecting members by calling a second
 * `collectGroupMembers`-style pass per group is O(children × groups) — 8 ms
 * at one group and **513 ms at a hundred**, measured on 200,000 children in
 * `spike/r210-grid-models.ts`. Bucketing once gives the counts and the
 * members together and is flat in group count at 8–10 ms.
 */
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'
import { isGridEligible } from '../../nodeDisplay'

/**
 * A group qualifies with at least this many members (§4.3, D-014) — below
 * this a "group" is a single occurrence, not a repeat; E9's manual override
 * is what resolves that ambiguity, not a lower floor here.
 *
 * **This is now the only qualifying rule.** `GRID_MIN_COVERAGE` — a group
 * had to cover 5% of the composite children — went with the largest-group
 * model that needed it (R210 §3). It answered *"is this group dominant
 * enough to be the table?"*, a question one-table-per-group does not ask,
 * and it carried a cliff: spread children evenly across 21 groups and each
 * covered 4.76%, so **nothing** qualified and no table rendered at all.
 */
export const GRID_MIN_MEMBERS = 2

export interface GridGroup {
  /** The child's own interned name id — D-013's "name alone, no shape
   * signature". `-1` for the unnamed children of a JSON or CSV array, which
   * is a real group key rather than a missing one: every row of a CSV is an
   * unnamed `Object`, and they form one group under `-1`.
   *
   * R134–R136 keyed this on a namespace-*resolved* id, so `inv:price` and
   * `s:price` bound to one URI formed a single group; R209 removed that
   * (D-101). Two prefixes for one URI are two groups, which since R210 is
   * two tables rather than a table and a list.
   */
  readonly nameId: number
  /** The group's members, in document order — the rows of its table.
   *
   * **Collected here rather than by a second pass.** The pass that counts
   * is the pass that collects; see this file's header for what the second
   * pass cost. */
  readonly members: readonly NodeRef[]
}

export interface GridDetectionResult {
  /** Children eligible to be a grid record: they have at least one child of
   * their own (CONCEPT.md §3.2's "composite"), **or** at least one scalar
   * facet (D-088 — a CSV row, R145 §2, is `attribute()`-only by design and
   * would otherwise never qualify). Ineligible children — leaf elements,
   * folded scalars, Text/Comment/PI/DocType — never enter a group (rule 4)
   * and are not counted here. */
  readonly compositeChildCount: number
  /** Every distinct-name group among the eligible children, **in document
   * order** (first appearance), including groups too small to render as a
   * table — so a caller can report "3 magazines" alongside the 40-book
   * table. */
  readonly groups: readonly GridGroup[]
  /** The groups that render as tables: `groups` filtered to those with at
   * least `GRID_MIN_MEMBERS` members, same order. Empty when nothing
   * repeats, which is the single-occurrence ambiguity E9's manual override
   * used to resolve.
   *
   * **Not capped here.** `Detail.tsx` caps how many it renders
   * (`GRID_TABLE_CAP`) and lists the remainder, because the cap is a
   * rendering budget — the number of live virtualizers on screen — rather
   * than a statement about the document. */
  readonly tables: readonly GridGroup[]
}

/**
 * One pass over `node`'s children: a `nameId` read and a push per eligible
 * child, no decoding (§4.3's stated budget — under 50 ms for 2 M children,
 * measured in E10, and 8–10 ms for 200 K in R210 §4).
 *
 * **One eligibility test, used for both counting and membership.** Before
 * R210 there were two, and they disagreed: detection counted with
 * `isGridEligible` while `collectGroupMembers` collected with
 * `hasChildren`. A CSV row has attributes and no children, so **every CSV
 * document detected a row group and then collected zero members** — an
 * empty table above a list of anonymous `Object` rows, in a format shipped
 * in v1. Neither function was wrong on its own, which is why it survived
 * R145–R149 and its tests: the CSV test built its members with
 * `childrenOf` directly rather than through the path the application uses.
 */
export function detectGrid(store: NodeStore, node: NodeRef): GridDetectionResult {
  // Insertion order is document order — `childrenOf` walks the child list
  // forwards and a `Map` iterates in insertion order — so this is §6's
  // "groups ordered by first appearance" with no sort.
  const byName = new Map<number, NodeRef[]>()
  let compositeChildCount = 0

  for (const child of store.childrenOf(node)) {
    if (!isGridEligible(store, child)) continue
    compositeChildCount++
    const nameId = store.nameIdOf(child)
    const bucket = byName.get(nameId)
    if (bucket === undefined) byName.set(nameId, [child])
    else bucket.push(child)
  }

  const groups: GridGroup[] = []
  const tables: GridGroup[] = []
  for (const [nameId, members] of byName) {
    const group: GridGroup = { nameId, members }
    groups.push(group)
    if (members.length >= GRID_MIN_MEMBERS) tables.push(group)
  }

  return { compositeChildCount, groups, tables }
}
