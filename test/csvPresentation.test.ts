/**
 * R149 (`docs/plans/R145-csv.md` §6): whether D-015 (transparent wrappers) and D-065
 * (initial selection = the wrapper-descent destination) already cover CSV's two-level
 * shape unchanged, checked against the real parser rather than assumed. Both are
 * name-agnostic — `wrapperCompositeChild` never reads a node's name, only its kind,
 * attribute flag and children — and CSV's Array/Object nodes are unnamed, so nothing
 * here required a code change; this file is the verification the plan asked for.
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { NodeKind, type ParseOptions } from '../src/core/types'
import { csvFormatModule } from '../src/formats/csv/index'
import { resolveWrapperTarget } from '../src/renderer/wrapperDescent'
import { detectGrid } from '../src/renderer/components/Detail/gridDetection'
import { collectColumns } from '../src/renderer/components/Detail/gridColumns'

const defaultOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseCsv(text: string): NodeStore {
  const source = new TextEncoder().encode(text)
  const store = new NodeStore(source, new Interner())
  csvFormatModule.parse(source, store, defaultOptions)
  return store
}

describe('CSV Tree/Detail presentation (§6)', () => {
  it('the initial selection (wrapper descent from Document) lands on the Array — the grid is populated with no extra click (acceptance 10)', () => {
    const store = parseCsv('name,age,city\nAlice,30,NYC\nBob,25,LA\nCarol,40,SF\n')
    const { destination, skipped } = resolveWrapperTarget(store, 0)
    expect(store.kindOf(destination)).toBe(NodeKind.Array)
    expect(skipped).toEqual([0]) // Document is the one skipped wrapper
  })

  it('a single-row CSV does not over-descend into the row (the row has no child nodes to be composite)', () => {
    const store = parseCsv('name,age\nAlice,30\n')
    const { destination } = resolveWrapperTarget(store, 0)
    // Must stop at the Array, not descend into its one Object row: a CSV row is
    // never itself composite (fields are facets, not children), so
    // wrapperCompositeChild must disqualify the Array here.
    expect(store.kindOf(destination)).toBe(NodeKind.Array)
  })

  it('detectGrid finds the row group at the Array with no format-specific code (same mechanism as a JSON array of objects)', () => {
    const store = parseCsv('a,b\n1,2\n3,4\n5,6\n')
    const arr = resolveWrapperTarget(store, 0).destination
    const detection = detectGrid(store, arr)
    expect(detection.grid).not.toBeNull()
    expect(detection.grid!.memberCount).toBe(3)
  })

  it('collectColumns names columns from the header, in header order', () => {
    const store = parseCsv('name,age,city\nAlice,30,NYC\nBob,25,LA\n')
    const arr = resolveWrapperTarget(store, 0).destination
    const members = [...store.childrenOf(arr)]
    const { columns } = collectColumns(store, members)
    expect(columns.map((c) => store.textOf(c.nameId))).toEqual(['name', 'age', 'city'])
  })
})
