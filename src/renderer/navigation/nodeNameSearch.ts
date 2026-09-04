/**
 * The palette's `@` mode — jump to a node by name (M1-PLAN.md D5/D14,
 * CONCEPT.md §7). Reuses `Palette/paletteLogic.ts`'s `fuzzyMatch` rather
 * than reimplementing fuzzy matching for a second data source.
 *
 * **Exact, via M4-PLAN.md G1's name index.** This used to scan node refs in
 * document order up to a fixed cap (`SCAN_LIMIT`), so a match past the cap
 * was simply never seen — the honest, bounded version for M1. G1's name
 * index makes the real fix available: fuzzy-matching runs over the
 * *interned name table* (one entry per unique name) rather than over every
 * node, and each match expands to its full node-ref group from the index.
 * The interned name table is bounded by vocabulary size, not document
 * size, so this is now both exact and cheap — no scan cap, no truncation.
 */
import type { NodeStore } from '../../core/nodeStore'
import type { NameIndex } from '../../core/nameIndex'
import type { NodeRef } from '../../core/types'
import { fuzzyMatch } from '../components/Palette/paletteLogic'

/** Caps how many matches are *displayed*, not which ones are found — a
 * presentation concern (`RESULT_LIMIT`), unlike the old `SCAN_LIMIT` which
 * bounded correctness. Matches are sorted by score first, so this is
 * "show the best 50," not "give up after 50 nodes." */
const RESULT_LIMIT = 50

export interface NodeNameMatch {
  readonly node: NodeRef
  readonly name: string
  readonly score: number
  readonly indices: readonly number[]
}

export interface NodeNameSearchResult {
  readonly matches: readonly NodeNameMatch[]
}

interface NameGroupMatch {
  readonly nameId: number
  readonly name: string
  readonly score: number
  readonly indices: readonly number[]
}

export function findNodesByName(
  store: NodeStore,
  nameIndex: NameIndex,
  query: string
): NodeNameSearchResult {
  if (query.length === 0) return { matches: [] }

  // Rank at the *name* level first — every node sharing a name has an
  // identical score, so there is nothing to learn by expanding a group to
  // its full node list before deciding whether it's even among the best
  // 50. Bounded by vocabulary size (nameCount), never by how many node
  // instances a common name like "car" has (hundreds of thousands on a
  // large document) — expanding every matching group fully before sorting
  // and truncating used to materialize and sort all of them for nothing
  // past the first 50 actually shown.
  const nameCount = nameIndex.starts.length - 1
  const groups: NameGroupMatch[] = []
  for (let nameId = 0; nameId < nameCount; nameId++) {
    const start = nameIndex.starts[nameId]!
    const end = nameIndex.starts[nameId + 1]!
    if (start === end) continue // no live node currently has this name

    const name = store.textOf(nameId)
    const match = fuzzyMatch(query, name)
    if (match === null) continue
    groups.push({ nameId, name, score: match.score, indices: match.indices })
  }
  groups.sort((a, b) => b.score - a.score || a.nameId - b.nameId)

  // Expand groups, best score first, stopping once RESULT_LIMIT node
  // matches have been collected — the only point past which more work
  // couldn't possibly change what's displayed.
  const matches: NodeNameMatch[] = []
  for (const group of groups) {
    if (matches.length >= RESULT_LIMIT) break
    const start = nameIndex.starts[group.nameId]!
    const end = nameIndex.starts[group.nameId + 1]!
    for (let i = start; i < end && matches.length < RESULT_LIMIT; i++) {
      matches.push({
        node: nameIndex.nodes[i]!,
        name: group.name,
        score: group.score,
        indices: group.indices
      })
    }
  }

  return { matches }
}
