/**
 * The name index (M4-PLAN.md G1, CONCEPT.md §6.5): `nameId → node refs`.
 * §6.5 claimed the intern table already was this; it wasn't — `Interner`
 * maps id → bytes, forward only, and `NodeStore.nameOf` maps node → name,
 * also forward only. Neither answers "every node called `price`" without a
 * scan. This is the missing inverse, as two flat `Int32Array`s (compressed
 * sparse row), never a `Map` of arrays — a `Map<number, number[]>` at
 * §8's reference density (~6.6M nodes) would mean millions of small array
 * allocations for no benefit over two typed arrays sized once.
 */
import type { NodeStore } from './nodeStore'

/** `NodeStore`'s own "no name" sentinel (`nodeStore.ts`'s private `NO_NAME`,
 * not exported — `nameIdOf` is the only way to observe it from outside). */
const NO_NAME = -1

export interface NameIndex {
  /** Length `nameCount + 1`. Group `k`'s node refs are
   * `nodes[starts[k]..starts[k+1])`. CSR-style: `starts` is a prefix sum
   * over per-name counts, so a name with no nodes is simply an empty
   * range, not a missing entry. */
  readonly starts: Int32Array
  /** Node refs, grouped by `nameId`, ascending within each group — the
   * fill pass below walks node refs ascending, so this is document order
   * for free, which is what `//name` (G8) needs and a `Map` of arrays
   * would not have given without a separate sort. */
  readonly nodes: Int32Array
}

/**
 * Two passes over the node array, O(n), no per-node allocation: count per
 * `nameId`, prefix-sum into `starts`, then fill `nodes` using a scratch
 * cursor copy of `starts` so the prefix sums themselves survive as the
 * returned index's group boundaries.
 *
 * `nameCount` is the interner's `size` at the time the store was built —
 * passed in rather than derived, so a caller building this from a store
 * whose interner has grown further (never happens today, but nothing here
 * should assume it) sizes `starts` correctly either way.
 */
export function buildNameIndex(store: NodeStore, nameCount: number): NameIndex {
  const nodeCount = store.nodeCount
  const starts = new Int32Array(nameCount + 1)

  for (let node = 0; node < nodeCount; node++) {
    const nameId = store.nameIdOf(node)
    if (nameId === NO_NAME) continue
    starts[nameId + 1] = starts[nameId + 1]! + 1
  }
  for (let id = 0; id < nameCount; id++) {
    starts[id + 1] = starts[id + 1]! + starts[id]!
  }

  const nodes = new Int32Array(starts[nameCount]!)
  const cursor = starts.slice(0, nameCount)
  for (let node = 0; node < nodeCount; node++) {
    const nameId = store.nameIdOf(node)
    if (nameId === NO_NAME) continue
    const pos = cursor[nameId]!
    nodes[pos] = node
    cursor[nameId] = pos + 1
  }

  return { starts, nodes }
}

/** Every node ref with `nameId`, in document order — a zero-copy view into
 * `index.nodes`, not a fresh allocation. Empty for an out-of-range id
 * (e.g. a query name that never occurs in this document, per G7's "interns
 * to nothing and the query is answerable as empty without touching the
 * store"). */
export function nodesByNameId(index: NameIndex, nameId: number): Int32Array {
  if (nameId < 0 || nameId + 1 >= index.starts.length) return EMPTY
  return index.nodes.subarray(index.starts[nameId]!, index.starts[nameId + 1]!)
}

const EMPTY = new Int32Array(0)

/** Total bytes of the two backing arrays — G10's budget-table line item. */
export function nameIndexMemoryBytes(index: NameIndex): number {
  return index.starts.byteLength + index.nodes.byteLength
}
