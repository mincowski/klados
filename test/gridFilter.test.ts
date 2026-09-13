import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import {
  collectColumns,
  collectGroupMembers,
  type GridColumn
} from '../src/renderer/components/Detail/gridColumns'
import { EMPTY_GRID_FILTERS, filterIndices } from '../src/renderer/components/Detail/gridFilter'

const xmlOptions: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function parseXml(text: string): { store: NodeStore; source: SourceBuffer } {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  xmlFormatModule.parse(bytes, store, xmlOptions)
  return { store, source: new SourceBuffer(bytes, 'utf-8', 0) }
}

const ROOT = 0

const CARS =
  '<garage>' +
  '<car><name>Golf</name><color>red</color></car>' +
  '<car><name>Model 3</name><color>blue</color></car>' +
  '<car><name>Panda</name></car>' +
  '</garage>'

function setup(text: string): {
  store: NodeStore
  source: SourceBuffer
  members: number[]
  columns: readonly GridColumn[]
} {
  const { store, source } = parseXml(text)
  const garage = store.firstChildOf(ROOT)
  const carNameId = store.nameIdOf(store.firstChildOf(garage))
  const members = collectGroupMembers(store, garage, carNameId)
  const columns = collectColumns(store, members).columns
  return { store, source, members, columns }
}

describe('filterIndices (M2-PLAN.md E7)', () => {
  it('returns every row, in document order, with no filters', () => {
    const { store, source, members, columns } = setup(CARS)
    expect(filterIndices(store, source, members, columns, EMPTY_GRID_FILTERS).indices).toEqual([
      0, 1, 2
    ])
  })

  it('quick filter narrows to rows matching any column, case-insensitively', () => {
    const { store, source, members, columns } = setup(CARS)
    const result = filterIndices(store, source, members, columns, {
      quick: 'BLUE',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([1])
  })

  it('quick filter matches across different columns', () => {
    const { store, source, members, columns } = setup(CARS)
    // "panda" matches the name column on row 2, "red" matches color on row 0.
    const result = filterIndices(store, source, members, columns, {
      quick: 'pand',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([2])
  })

  it('per-column filter narrows to rows whose specific column matches', () => {
    const { store, source, members, columns } = setup(CARS)
    const colorId = columns.find((c) => store.textOf(c.nameId) === 'color')!.nameId
    const result = filterIndices(store, source, members, columns, {
      quick: '',
      perColumn: new Map([[colorId, 'red']])
    })
    expect(result.indices).toEqual([0])
  })

  it('a row absent from a filtered column never matches that column filter', () => {
    const { store, source, members, columns } = setup(CARS)
    const colorId = columns.find((c) => store.textOf(c.nameId) === 'color')!.nameId
    // Panda (row 2) has no color at all — must not match any substring.
    const result = filterIndices(store, source, members, columns, {
      quick: '',
      perColumn: new Map([[colorId, '']])
    })
    // Empty per-column filter text is treated as "no filter" (trimmed to
    // nothing), so this should behave like EMPTY_GRID_FILTERS.
    expect(result.indices).toEqual([0, 1, 2])
  })

  it('multiple per-column filters combine with AND', () => {
    const { store, source, members, columns } = setup(CARS)
    const nameId = columns.find((c) => store.textOf(c.nameId) === 'name')!.nameId
    const colorId = columns.find((c) => store.textOf(c.nameId) === 'color')!.nameId
    const result = filterIndices(store, source, members, columns, {
      quick: '',
      perColumn: new Map([
        [nameId, 'golf'],
        [colorId, 'blue']
      ])
    })
    expect(result.indices).toEqual([]) // no row is both named Golf and colored blue
  })

  it('preserves document order in a non-contiguous surviving subset', () => {
    const { store, source } = parseXml(
      '<garage>' +
        '<car><name>Golf</name><color>red</color></car>' +
        '<car><name>Model 3</name><color>blue</color></car>' +
        '<car><name>Panda</name><color>red</color></car>' +
        '</garage>'
    )
    const garage = store.firstChildOf(ROOT)
    const carNameId = store.nameIdOf(store.firstChildOf(garage))
    const members = collectGroupMembers(store, garage, carNameId)
    const columns = collectColumns(store, members).columns

    // Rows 0 and 2 are red, row 1 is blue — the surviving subset skips the
    // middle row, so [0, 2] (not [2, 0]) is the only order that's still
    // "document order."
    const result = filterIndices(store, source, members, columns, {
      quick: 'red',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([0, 2])
  })
})

// R34 §5: the quick filter is scoped to visible columns, but reports what it
// excluded rather than silently narrowing "matches anywhere" to "matches in
// the columns I happen to be showing."
describe('filterIndices hidden-match reporting (R34 §5)', () => {
  it('a match confined to a column outside the visible set is excluded but counted', () => {
    const { store, source, members, columns } = setup(CARS)
    // "color" carries the only "red"/"blue" — drop it from the visible set,
    // as if it had scrolled past GRID_COLUMN_CAP or been unticked.
    const visibleColumns = columns.filter((c) => store.textOf(c.nameId) !== 'color')
    const result = filterIndices(store, source, members, visibleColumns, {
      quick: 'blue',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([])
    expect(result.hiddenMatchCount).toBe(1)
    expect(result.hiddenMatchColumns.map((id) => store.textOf(id))).toEqual(['color'])
  })

  it('a row matching both a visible and a hidden column counts as a visible match, not hidden', () => {
    const { store, source, members, columns } = setup(CARS)
    const visibleColumns = columns.filter((c) => store.textOf(c.nameId) !== 'color')
    // "red" is only in "color" here, so this exercises the hidden-only path;
    // give it a query that also matches the visible "name" column instead.
    const result = filterIndices(store, source, members, visibleColumns, {
      quick: 'golf',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([0])
    expect(result.hiddenMatchCount).toBe(0)
  })

  it('reports zero hidden matches when every match is already visible', () => {
    const { store, source, members, columns } = setup(CARS)
    const result = filterIndices(store, source, members, columns, {
      quick: 'blue',
      perColumn: new Map()
    })
    expect(result.indices).toEqual([1])
    expect(result.hiddenMatchCount).toBe(0)
    expect(result.hiddenMatchColumns).toEqual([])
  })
})

describe('filterIndices — NFC (R202)', () => {
  // Fixtures from escapes with a codepoint guard, per `docs/FINDINGS.md`:
  // typing these directly is how R72 and R202's own measurements went wrong,
  // because a tool normalizes them away and the test still passes against
  // text that is no longer the text under examination.
  const COMPOSED = 'Caf\u00e9' // C a f U+00E9
  const DECOMPOSED = 'Cafe\u0301' // C a f e U+0301

  const CAFES =
    '<list>' +
    `<shop><name>${COMPOSED}</name></shop>` +
    `<shop><name>${DECOMPOSED}</name></shop>` +
    '<shop><name>Diner</name></shop>' +
    '</list>'

  function quick(text: string): readonly number[] {
    const { store, source, members, columns } = setup(CAFES)
    return filterIndices(store, source, members, columns, { quick: text, perColumn: new Map() })
      .indices
  }

  it('guards its own fixtures', () => {
    expect([...COMPOSED].map((c) => c.codePointAt(0))).toEqual([0x43, 0x61, 0x66, 0x00e9])
    expect([...DECOMPOSED].map((c) => c.codePointAt(0))).toEqual([0x43, 0x61, 0x66, 0x65, 0x0301])
    expect(COMPOSED).not.toBe(DECOMPOSED)
    expect(COMPOSED.normalize('NFC')).toBe(DECOMPOSED.normalize('NFC'))
  })

  it('a composed query matches a decomposed cell, and both spellings at once', () => {
    // Before R202 this returned only row 0 — the two spellings are different
    // strings, and nothing in the codebase called `normalize`.
    expect(quick(COMPOSED)).toEqual([0, 1])
  })

  it('a decomposed query matches a composed cell', () => {
    expect(quick(DECOMPOSED)).toEqual([0, 1])
  })

  it('an ASCII query still matches the decomposed spelling it always did', () => {
    // The gate's reason for existing. `cafe` matches `Cafe` + U+0301
    // character for character today; normalizing the *cell* would compose
    // that into `é` and lose the match. NFC can never add an ASCII
    // character that was not there, so skipping it for an ASCII needle is
    // strictly more permissive as well as free.
    expect(quick('cafe')).toEqual([1])
  })

  it('normalizes per-column filters too, and only the ones that need it', () => {
    const { store, source, members, columns } = setup(CAFES)
    const nameId = columns[0]!.nameId
    expect(
      filterIndices(store, source, members, columns, {
        quick: '',
        perColumn: new Map([[nameId, COMPOSED]])
      }).indices
    ).toEqual([0, 1])
  })

  it('still folds case across the normalization', () => {
    expect(quick(COMPOSED.toUpperCase())).toEqual([0, 1])
  })
})
