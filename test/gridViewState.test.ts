/**
 * R213 (`docs/plans/R213-grid-view-state.md`) — the view-state store on its own:
 * resolving stored names against a grid's columns, merging a change back without
 * forgetting what another node's table had, and what the store refuses to keep.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { collectColumns } from '../src/renderer/components/Detail/gridColumns'
import { detectGrid } from '../src/renderer/components/Detail/gridDetection'
import {
  columnIdsByName,
  EMPTY_SHAPE,
  GRID_CONTENT_STATE_LIMIT,
  groupKeyOf,
  internerKeyOf,
  mergeShape,
  readContent,
  readShape,
  rememberGroup,
  resetGridViewStateForTests,
  resolveShape,
  selectedGroupIndex,
  writeContent,
  writeShape,
  type GridContentState,
  type GridViewKey
} from '../src/renderer/components/Detail/gridViewState'

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const key: GridViewKey = { tabId: null, filePath: 'C:/docs/cars.xml' }

afterEach(() => resetGridViewStateForTests())

function parse(xml: string, interner = new Interner()): NodeStore {
  const source = new TextEncoder().encode(xml)
  const store = new NodeStore(source, interner)
  xmlFormatModule.parse(source, store, options)
  return store
}

function carsGrid(xml: string): {
  store: NodeStore
  byName: Map<string, number>
  overflowIds: Set<number>
} {
  const store = parse(xml)
  const parent = store.firstChildOf(0)
  const table = detectGrid(store, parent).tables[0]!
  const { columns, overflow } = collectColumns(store, table.members)
  return {
    store,
    byName: columnIdsByName(store, columns, overflow),
    overflowIds: new Set(overflow.map((c) => c.nameId))
  }
}

const content = (overrides: Partial<GridContentState> = {}): GridContentState => ({
  quickFilter: 'golf',
  columnFilters: [],
  filterRowOpen: false,
  active: { row: 0, col: 0 },
  scrollTop: 0,
  scrollLeft: 0,
  nodeCount: 0,
  ...overrides
})

describe('R213 — resolving and merging a stored shape', () => {
  it('resolves names to this grid’s ids and drops the names it does not have', () => {
    const { byName, overflowIds } = carsGrid(
      '<cars><car><make>VW</make><year>1990</year></car><car><make>BMW</make><year>2001</year></car></cars>'
    )
    const resolved = resolveShape(
      {
        sort: { column: 'colour', direction: 'asc' },
        extraColumns: ['make'],
        pinned: ['year', 'colour'],
        widths: [
          ['make', 140],
          ['colour', 90]
        ]
      },
      byName,
      overflowIds,
      500
    )
    expect(resolved.sort).toBeNull()
    // `make` is not an overflow column here, so it needs no "extra" entry.
    expect(resolved.extraColumns.size).toBe(0)
    expect([...resolved.pinned]).toEqual([byName.get('year')])
    expect([...resolved.widths]).toEqual([[byName.get('make'), 140]])
  })

  it('merging a change keeps what another node’s table had, for columns this grid lacks', () => {
    const { store, byName } = carsGrid(
      '<cars><car><make>VW</make></car><car><make>BMW</make></car></cars>'
    )
    const previous = {
      sort: { column: 'isbn', direction: 'desc' as const },
      extraColumns: [],
      pinned: ['isbn'],
      widths: [['isbn', 120] as const]
    }
    const make = byName.get('make')!
    const merged = mergeShape(
      previous,
      { sort: null, extraColumns: new Set(), pinned: new Set([make]), widths: new Map() },
      store,
      byName
    )
    expect(merged).toEqual({
      sort: { column: 'isbn', direction: 'desc' },
      extraColumns: [],
      pinned: ['isbn', 'make'],
      widths: [['isbn', 120]]
    })
  })

  it('an explicit unsort of a column this grid has clears the stored sort', () => {
    const { store, byName } = carsGrid(
      '<cars><car><make>VW</make></car><car><make>BMW</make></car></cars>'
    )
    const merged = mergeShape(
      { ...EMPTY_SHAPE, sort: { column: 'make', direction: 'asc' } },
      { sort: null, extraColumns: new Set(), pinned: new Set(), widths: new Map() },
      store,
      byName
    )
    expect(merged.sort).toBeNull()
  })

  it('acceptance 7: nothing stored is sized by row count', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `<car><make>m${i}</make></car>`).join('')
    const { store, byName } = carsGrid(`<cars>${rows}</cars>`)
    const make = byName.get('make')!
    writeShape(
      key,
      'n:car',
      mergeShape(
        EMPTY_SHAPE,
        {
          sort: { nameId: make, direction: 'asc' },
          extraColumns: new Set(),
          pinned: new Set([make]),
          widths: new Map([[make, 200]])
        },
        store,
        byName
      )
    )
    writeContent(key, 1, 'n:car', content({ nodeCount: store.nodeCount }))
    const serialized = JSON.stringify([
      readShape(key, 'n:car'),
      readContent(key, store, 1, 'n:car')
    ])
    // Bounded by the columns, not the 20,000 rows; and no typed array anywhere.
    expect(serialized.length).toBeLessThan(400)
    expect(serialized).not.toMatch(/Int32Array|"0":/)
  })
})

describe('R213 — what the store keeps, and for how long', () => {
  it('content written under another node count is discarded, not applied to a different node', () => {
    const store = parse('<a><b/><b/></a>')
    writeContent(key, 1, 'n:b', content({ nodeCount: store.nodeCount }))
    expect(readContent(key, store, 1, 'n:b')?.quickFilter).toBe('golf')
    const grown = parse('<a><b/><b/><b/></a>')
    expect(readContent(key, grown, 1, 'n:b')).toBeNull()
  })

  it('keeps at most GRID_CONTENT_STATE_LIMIT nodes, oldest out first', () => {
    const store = parse('<a/>')
    for (let node = 0; node <= GRID_CONTENT_STATE_LIMIT; node++)
      writeContent(key, node, 'n:b', content({ nodeCount: store.nodeCount }))
    expect(readContent(key, store, 0, 'n:b')).toBeNull()
    expect(readContent(key, store, 1, 'n:b')).not.toBeNull()
    expect(readContent(key, store, GRID_CONTENT_STATE_LIMIT, 'n:b')).not.toBeNull()
  })

  it('writing null removes a node’s content', () => {
    const store = parse('<a/>')
    writeContent(key, 3, 'n:b', content({ nodeCount: store.nodeCount }))
    writeContent(key, 3, 'n:b', null)
    expect(readContent(key, store, 3, 'n:b')).toBeNull()
  })

  it('another file opened in the same tab starts fresh', () => {
    writeShape(key, 'n:car', { ...EMPTY_SHAPE, pinned: ['make'] })
    expect(readShape({ ...key, filePath: 'C:/docs/other.xml' }, 'n:car')).toBe(EMPTY_SHAPE)
    writeShape({ ...key, filePath: 'C:/docs/other.xml' }, 'n:car', EMPTY_SHAPE)
    expect(readShape(key, 'n:car')).toBe(EMPTY_SHAPE)
  })

  it('the selected tab is remembered by group name, across stores with different ids', () => {
    const xml =
      '<s><book><t>1</t></book><book><t>2</t></book><magazine><t>3</t></magazine><magazine><t>4</t></magazine></s>'
    const first = parse(xml)
    const firstTables = detectGrid(first, first.firstChildOf(0)).tables
    rememberGroup(key, groupKeyOf(first, firstTables[1]!))

    const renumbering = new Interner()
    parse('<magazine><x/><t/><book/></magazine>', renumbering)
    const second = parse(xml, renumbering)
    const secondTables = detectGrid(second, second.firstChildOf(0)).tables
    expect(secondTables[1]!.nameId).not.toBe(firstTables[1]!.nameId)
    expect(selectedGroupIndex(key, second, secondTables)).toBe(1)
  })

  it('a grid key changes with the interner, and not with the store', () => {
    const interner = new Interner()
    const a = parse('<a/>', interner)
    const b = parse('<a/>', interner)
    expect(internerKeyOf(a)).toBe(internerKeyOf(b))
    expect(internerKeyOf(parse('<a/>'))).not.toBe(internerKeyOf(a))
  })
})
