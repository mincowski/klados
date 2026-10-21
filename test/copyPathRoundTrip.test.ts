/**
 * R242 (`docs/plans/R242-copy-path-round-trip.md` §4, criteria 1 and 2) —
 * **Copy path finds the node it was copied from**, for every node of every
 * format, by evaluating the path rather than only parsing it.
 *
 * R75's own test stopped at "it parses", and the path it checked found
 * nothing: before R242 every JSON and CSV path, and some TOML ones, came back
 * empty. Each path here goes through what the palette does with a paste —
 * strip the `/` mode prefix (`parsePaletteInput`), parse, evaluate — and must
 * return exactly the node it was copied from.
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { buildNameIndex } from '../src/core/nameIndex'
import { NodeStore } from '../src/core/nodeStore'
import { SourceBuffer } from '../src/core/buffer'
import type { FormatModule } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { tomlFormatModule } from '../src/formats/toml/index'
import { csvFormatModule } from '../src/formats/csv/index'
import { evaluatePath } from '../src/core/path/evaluate'
import { parsePath } from '../src/core/path/parse'
import { copyPathFor, pathSegmentsOf } from '../src/renderer/components/Detail/detailModel'

const ROOT = 0

/** Every node but the document itself, with what its copied path finds. */
function roundTrips(
  format: FormatModule,
  text: string
): Array<{ node: number; path: string; found: number[] | string }> {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  const parsed = format.parse(bytes, store, { maxDepth: 1000, encoding: 'utf-8' })
  if (!parsed.complete) throw new Error('fixture must parse completely')
  const nameIndex = buildNameIndex(store, store.interner.size)
  const source = new SourceBuffer(bytes, 'utf-8', 0)
  const results: Array<{ node: number; path: string; found: number[] | string }> = []
  for (let node = ROOT + 1; node < store.nodeCount; node++) {
    const path = copyPathFor(pathSegmentsOf(store, node))
    const query = parsePath(path.slice(1), (name) => store.interner.lookup(name))
    results.push({
      node,
      path,
      found: query.ok
        ? [...evaluatePath(store, nameIndex, source, query.path)]
        : query.diagnostic.message
    })
  }
  return results
}

function expectEveryNodeFound(format: FormatModule, text: string): void {
  const results = roundTrips(format, text)
  expect(results.length).toBeGreaterThan(0)
  const wrong = results.filter(
    (r) => !(Array.isArray(r.found) && r.found.length === 1 && r.found[0] === r.node)
  )
  expect(wrong).toEqual([])
}

describe('R242 — every node is found again by its copied path', () => {
  it('XML: repeated names, comments, processing instructions, text, namespaces', () => {
    expectEveryNodeFound(
      xmlFormatModule,
      '<?xml version="1.0"?>\n<!-- top -->\n<garage xmlns:ns="urn:x">\n' +
        '  <cars><car id="c1"><make>Saab</make></car><!-- between -->' +
        '<car id="c2">text<make>Volvo</make>tail</car><car/></cars>\n' +
        '  <ns:item>x</ns:item><größe>1</größe><?pi data?>\n</garage>\n'
    )
  })

  it('JSON: an object at the top, nested arrays, duplicate keys', () => {
    expectEveryNodeFound(
      jsonFormatModule,
      '{"books":[{"title":"A","tags":["x","y"]},{"title":"B","tags":[]}],' +
        '"meta":{"n":2,"n":3},"matrix":[[1,2],[3,[4,5]]],"empty":{},"none":null}'
    )
  })

  it('JSON: an array at the top, and a bare scalar at the top', () => {
    expectEveryNodeFound(jsonFormatModule, '[{"t":1},{"t":2},[3,4],"s",null]')
    expectEveryNodeFound(jsonFormatModule, '42')
  })

  it('TOML: tables, an array of tables, arrays and inline tables inside them, quoted keys', () => {
    expectEveryNodeFound(
      tomlFormatModule,
      'name = "x"\n"first name" = "y"\n"a.b" = 1\nsite.host = "h"\n' +
        '[server]\nport = 8080\nhosts = ["a", "b"]\npoint = { x = 1, y = 2 }\n' +
        '[[books]]\ntitle = "A"\n[[books]]\ntitle = "B"\ntags = ["a", ["b", "c"]]\n'
    )
  })

  it('CSV: header names with spaces', () => {
    expectEveryNodeFound(csvFormatModule, 'id,unit price,name\n1,9.5,Ann\n2,3,Bob\n')
  })

  it('JSON keys built from every reserved character, whitespace, quotes and other awkward names', () => {
    const awkward = [
      ...['/', '[', ']', '@', '*', '(', ')', '=', '!', '<', '>', "'"].map((ch) => `a${ch}b`),
      'a\\"b', // a `"` inside a JSON key, as the source spells it
      'first name',
      'a b', // no-break space
      'a　b', // ideographic space
      '*',
      '"',
      '123',
      'and',
      'not',
      'größe',
      '𠀀',
      '',
      'dup',
      'dup'
    ]
    const object = `{${awkward.map((key, i) => `"${key}":${i}`).join(',')}}`
    expectEveryNodeFound(jsonFormatModule, object)
    expectEveryNodeFound(jsonFormatModule, `[${object},${object}]`)
  })

  it('the paths themselves, for a few nodes a person would copy', () => {
    const paths = new Map(
      roundTrips(
        jsonFormatModule,
        '{"books":[{"title":"A","first name":"Ann"},{"title":"B"}]}'
      ).map((r) => [r.path, r.found])
    )
    expect([...paths.keys()]).toEqual([
      '/*',
      '/*/books',
      '/*/books/*',
      '/*/books/*/*[1]',
      '/*/books/*/*[1]/title',
      '/*/books/*/*[1]/"first name"',
      '/*/books/*/*[2]',
      '/*/books/*/*[2]/title'
    ])
  })
})
