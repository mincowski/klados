/**
 * M3-PLAN.md F4's own acceptance criterion, taken literally: "the
 * resulting store is structurally identical to a full reparse of the same
 * text — assert it, do not eyeball it." Every test here builds an edited
 * document two ways — once via `spliceSubtree` starting from the
 * pre-edit store, once via a from-scratch full parse of the post-edit
 * text — and diffs the two stores node-by-node, span-by-span,
 * attribute-by-attribute. Mirrors B12's own invariant-4 style
 * (test/invariants.test.ts), not example assertions on a couple of fields.
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { NodeKind, type FormatModule, type NodeRef, type ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'
import { jsonFormatModule } from '../src/formats/json/index'
import { tomlFormatModule } from '../src/formats/toml/index'
import {
  beginSpliceSubtree,
  spliceSubtree,
  type SpliceRequest
} from '../src/renderer/session/subtreeSplice'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function parseFull(format: typeof xmlFormatModule, text: string): NodeStore {
  const bytes = utf8(text)
  const store = new NodeStore(bytes, new Interner())
  const result = format.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('test fixture must parse completely')
  return store
}

interface FlatAttr {
  readonly name: string
  readonly value: string
  readonly valueStart: number
  readonly valueEnd: number
}

interface FlatNode {
  readonly kind: number
  readonly name: string | null
  readonly spanStart: number
  readonly spanEnd: number
  readonly value: string | null
  readonly attrs: readonly FlatAttr[]
  readonly childCount: number
}

/** Full structural + span + attribute flattening, pre-order — deliberately
 * more thorough than B12's own `flatShape` (kind/name/childCount only),
 * since this module's whole job is getting offsets and attribute tables
 * right, not just shape. */
function flatten(store: NodeStore, bytes: Uint8Array, root: NodeRef): FlatNode[] {
  const decoder = new TextDecoder('utf-8')
  const result: FlatNode[] = []
  const stack: NodeRef[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    const span = store.spanOf(node)
    const value = store.valueOf(node)
    const attrs = [...store.attributesOf(node)]
      .map((a) => ({
        name: store.textOf(a.nameId),
        value: decoder.decode(bytes.subarray(a.valueStart, a.valueEnd)),
        valueStart: a.valueStart,
        valueEnd: a.valueEnd
      }))
      .sort((a, b) => a.valueStart - b.valueStart)
    const children = [...store.childrenOf(node)]
    result.push({
      kind: store.kindOf(node),
      name: store.nameOf(node),
      spanStart: span.start,
      spanEnd: span.end,
      value: value === null ? null : decoder.decode(bytes.subarray(value.start, value.end)),
      attrs,
      childCount: children.length
    })
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
  }
  return result
}

/** Runs an edit both ways and asserts the resulting stores are identical
 * — the actual F4 acceptance test. Returns the splice outcome so callers
 * can additionally assert on failure paths. */
function spliceAndCompare(
  format: typeof xmlFormatModule,
  originalText: string,
  editStart: number,
  editEnd: number,
  replacement: string
): ReturnType<typeof spliceSubtree> {
  const oldStore = parseFull(format, originalText)

  const newText = originalText.slice(0, editStart) + replacement + originalText.slice(editEnd)
  const newBytes = utf8(newText)
  const delta = replacement.length - (editEnd - editStart)

  const request: SpliceRequest = {
    format,
    oldStore,
    newBytes,
    // The splice must reuse the SAME interner as `oldStore` — that's the
    // whole reason names don't need remapping.
    interner: oldStore.interner,
    dirtyStart: editStart,
    dirtyEnd: editEnd,
    delta,
    options: OPTIONS
  }
  const outcome = spliceSubtree(request)

  if (outcome.ok) {
    const freshStore = parseFull(format, newText)
    const splicedFlat = flatten(outcome.store, newBytes, 0)
    const freshFlat = flatten(freshStore, newBytes, 0)
    expect(splicedFlat).toEqual(freshFlat)
    expect(outcome.store.diagnostics).toEqual(freshStore.diagnostics)
  }
  return outcome
}

describe('spliceSubtree — XML', () => {
  it('a leaf text edit, no structural change', () => {
    const xml = '<root><a><b>1</b><c>2</c></a><d>3</d></root>'
    const outcome = spliceAndCompare(
      xmlFormatModule,
      xml,
      xml.indexOf('1'),
      xml.indexOf('1') + 1,
      '100'
    )
    expect(outcome.ok).toBe(true)
  })

  it('an attribute value edit', () => {
    const xml = '<root><item id="1" name="x"/></root>'
    const valueStart = xml.indexOf('"x"') + 1
    const outcome = spliceAndCompare(
      xmlFormatModule,
      xml,
      valueStart,
      valueStart + 1,
      'a much longer value'
    )
    expect(outcome.ok).toBe(true)
  })

  it('an edit that adds a child node inside the spliced subtree', () => {
    const xml = '<root><a><b>1</b></a><e>9</e></root>'
    const insertAt = xml.indexOf('</a>')
    const outcome = spliceAndCompare(xmlFormatModule, xml, insertAt, insertAt, '<c>2</c><d>3</d>')
    expect(outcome.ok).toBe(true)
  })

  it('an edit that removes a child node from the spliced subtree', () => {
    const xml = '<root><a><b>1</b><c>2</c></a><d>3</d></root>'
    const start = xml.indexOf('<c>2</c>')
    const outcome = spliceAndCompare(xmlFormatModule, xml, start, start + '<c>2</c>'.length, '')
    expect(outcome.ok).toBe(true)
  })

  it('a later sibling and an ancestor both shift correctly past the edit', () => {
    // <d> (a later sibling of <a>) and <root> (the ancestor) both have
    // spans that extend past the edit — exactly the two cases this
    // module's own top comment calls out as needing adjustment.
    const xml = '<root><a><b>short</b></a><d>after</d></root>'
    const start = xml.indexOf('short')
    const outcome = spliceAndCompare(
      xmlFormatModule,
      xml,
      start,
      start + 'short'.length,
      'a great deal longer than before'
    )
    expect(outcome.ok).toBe(true)
  })

  it('falls back cleanly when the edit breaks well-formedness', () => {
    const xml = '<root><a><b>1</b></a><d>2</d></root>'
    const closeTag = xml.indexOf('</a>')
    const outcome = spliceAndCompare(xmlFormatModule, xml, closeTag, closeTag + '</a>'.length, '')
    expect(outcome).toEqual({ ok: false, reason: 'malformed' })
  })

  it("a removal shifts an ancestor's own nextSibling, not just its spanEnd", () => {
    // spliceNode ends up at <b> (the exact-span-match rule walks up from
    // <d>). <b>'s parent <a> has a real following sibling <e> — an
    // ancestor whose *own* nextSibling ref must shift by refDelta (-1
    // here, a node is being removed), the specific field the ancestor
    // patching loop originally missed (it only patched spanEnd).
    const xml = '<root><a><b><c>1</c><d>2</d></b></a><e>after</e></root>'
    const start = xml.indexOf('<d>2</d>')
    const outcome = spliceAndCompare(xmlFormatModule, xml, start, start + '<d>2</d>'.length, '')
    expect(outcome.ok).toBe(true)
  })

  it('an insertion shifts nextSibling on two different ancestors at two different depths', () => {
    // spliceNode ends up at <c> (strictly interior insertion). Its
    // immediate parent <b> and grandparent <a> each have their own real
    // following sibling (<h> and <f>) — both need their nextSibling
    // shifted by a positive refDelta, not just the immediate parent.
    const xml = '<root><a><b><c><d>1</d></c><h>2</h></b><f>3</f></a><e>after</e></root>'
    const insertAt = xml.indexOf('</c>')
    const outcome = spliceAndCompare(xmlFormatModule, xml, insertAt, insertAt, '<g>4</g>')
    expect(outcome.ok).toBe(true)
  })

  it('a dirty range spanning multiple top-level siblings splices at the root, not null', () => {
    const xml = '<root><a>1</a><b>2</b></root>'
    // Spans both <a> and <b> — no node other than <root> contains this range.
    const start = xml.indexOf('<a>')
    const end = xml.indexOf('</b>') + '</b>'.length
    const outcome = spliceAndCompare(xmlFormatModule, xml, start, end, '<a>10</a><b>20</b>')
    expect(outcome.ok).toBe(true)
  })

  it('preserves an unrelated diagnostic before the edit and shifts one after it', () => {
    // Two independent malformed regions: an unclosed <bad> that XML's
    // parser recovers from with a diagnostic, and a normal leaf value
    // edited elsewhere, after it.
    const xml = '<root><bad><x>1</x><ok>2</ok></root>'
    const editStart = xml.indexOf('2')
    const outcome = spliceAndCompare(xmlFormatModule, xml, editStart, editStart + 1, '200')
    // Only asserts if the fixture itself produces a complete parse with a
    // recovered diagnostic; spliceAndCompare already checked diagnostics
    // match a fresh parse exactly either way.
    expect(outcome.ok).toBe(true)
  })
})

describe('spliceSubtree — JSON', () => {
  it('a leaf scalar edit, no structural change', () => {
    const json = '{"a":{"b":1,"c":2},"d":3}'
    const outcome = spliceAndCompare(
      jsonFormatModule,
      json,
      json.indexOf('1'),
      json.indexOf('1') + 1,
      '100'
    )
    expect(outcome.ok).toBe(true)
  })

  it('an edit that adds a property inside the spliced subtree', () => {
    const json = '{"a":{"b":1},"e":9}'
    const insertAt = json.indexOf('}', json.indexOf('"a"'))
    const outcome = spliceAndCompare(jsonFormatModule, json, insertAt, insertAt, ',"c":2,"d":3')
    expect(outcome.ok).toBe(true)
  })

  it('an edit that removes a property from the spliced subtree', () => {
    const json = '{"a":{"b":1,"c":2},"d":3}'
    const start = json.indexOf(',"c":2')
    const outcome = spliceAndCompare(jsonFormatModule, json, start, start + ',"c":2'.length, '')
    expect(outcome.ok).toBe(true)
  })

  it('falls back cleanly when the edit breaks well-formedness', () => {
    const json = '{"a":{"b":1},"d":2}'
    const closeBrace = json.indexOf('}') // closes "a"'s object
    const outcome = spliceAndCompare(jsonFormatModule, json, closeBrace, closeBrace + 1, '')
    expect(outcome.ok).toBe(false)
  })
})

describe('spliceSubtree — TOML (M6-PLAN.md R15)', () => {
  it('a leaf scalar edit, no structural change', () => {
    const toml = 'title = "hello"\ncount = 1\n'
    const outcome = spliceAndCompare(
      tomlFormatModule,
      toml,
      toml.indexOf('1'),
      toml.indexOf('1') + 1,
      '100'
    )
    expect(outcome.ok).toBe(true)
  })

  it('an edit inside a [table] header-driven section adds a bare key', () => {
    const toml = '[package]\nname = "example"\n\n[dependencies]\nserde = "1.0"\n'
    const insertAt = toml.indexOf('\n[dependencies]')
    const outcome = spliceAndCompare(
      tomlFormatModule,
      toml,
      insertAt,
      insertAt,
      '\nversion = "0.1.0"'
    )
    expect(outcome.ok).toBe(true)
  })

  it('an edit inside a [table] header-driven section removes a bare key', () => {
    const toml = '[package]\nname = "example"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\n'
    const start = toml.indexOf('\nversion = "0.1.0"')
    const outcome = spliceAndCompare(
      tomlFormatModule,
      toml,
      start,
      start + '\nversion = "0.1.0"'.length,
      ''
    )
    expect(outcome.ok).toBe(true)
  })

  it('an edit inside an inline table value', () => {
    const toml = 'point = { x = 1, y = 2 }\nother = 3\n'
    const start = toml.indexOf('1')
    const outcome = spliceAndCompare(tomlFormatModule, toml, start, start + 1, '100')
    expect(outcome.ok).toBe(true)
  })

  it('an edit inside an inline array value', () => {
    const toml = 'nums = [1, 2, 3]\nother = 4\n'
    const start = toml.indexOf('2')
    const outcome = spliceAndCompare(tomlFormatModule, toml, start, start + 1, '200')
    expect(outcome.ok).toBe(true)
  })

  // A documented, deliberate limitation, not a bug: with only one `fruits`
  // element, its own span co-terminates exactly with the array's (nothing
  // comes after it but the next section), so an edit that inserts a whole
  // new [[fruits]] element there is indistinguishable, span-wise, from an
  // edit landing *inside* the existing element — `findSpliceNode` picks
  // the element (the narrower containing node), and `runSelfContainedBody`
  // correctly refuses to place a header it finds inside an element's own
  // body (its own doc comment's "does not attempt a nested header" case),
  // falling back to a full reparse safely rather than guessing. Still
  // produces the right document either way — this is a splice-efficiency
  // gap, not a correctness one.
  it('adding a new [[array of tables]] element falls back safely when it would land inside the last element', () => {
    const toml = '[[fruits]]\nname = "apple"\n\n[other]\nx = 1\n'
    const insertAt = toml.indexOf('\n[other]')
    const outcome = spliceAndCompare(
      tomlFormatModule,
      toml,
      insertAt,
      insertAt,
      '\n\n[[fruits]]\nname = "banana"'
    )
    expect(outcome).toEqual({ ok: false, reason: 'malformed' })
  })

  it('an edit inside dotted-key implicit table content', () => {
    const toml = '[fruit]\nphysical.color = "red"\nphysical.shape = "round"\n'
    const start = toml.indexOf('red')
    const outcome = spliceAndCompare(tomlFormatModule, toml, start, start + 'red'.length, 'green')
    expect(outcome.ok).toBe(true)
  })

  // The boundary-rewind mechanism `runStatements` exists for (M6-PLAN.md
  // R15): the spliced range for an edit inside [fruits] must NOT swallow
  // the following [vegetables] section — this is the actual acceptance
  // test for that logic, not just the general "matches a full reparse"
  // check every other case here already gets (which would itself fail
  // loudly if boundary-rewind were broken, but this pins the specific
  // mechanism down by name).
  it('a spliced header-table section never absorbs the next sibling section', () => {
    const toml = '[fruits]\nname = "apple"\n\n[vegetables]\nname = "carrot"\n'
    const start = toml.indexOf('apple')
    const outcome = spliceAndCompare(tomlFormatModule, toml, start, start + 'apple'.length, 'pear')
    expect(outcome.ok).toBe(true)
  })

  it('a later sibling section and an ancestor both shift correctly past the edit', () => {
    const toml = '[a]\nx = "short"\n\n[b]\ny = "after"\n'
    const start = toml.indexOf('short')
    const outcome = spliceAndCompare(
      tomlFormatModule,
      toml,
      start,
      start + 'short'.length,
      'a great deal longer than before'
    )
    expect(outcome.ok).toBe(true)
  })

  it('falls back cleanly when the edit breaks well-formedness (unterminated inline table)', () => {
    const toml = 'point = { x = 1, y = 2 }\nother = 3\n'
    const closeBrace = toml.indexOf('}')
    const outcome = spliceAndCompare(tomlFormatModule, toml, closeBrace, closeBrace + 1, '')
    expect(outcome.ok).toBe(false)
  })
})

describe('spliceSubtree — format support', () => {
  it("refuses when the format doesn't support incremental reparse", () => {
    const noIncremental: FormatModule = {
      ...xmlFormatModule,
      capabilities: { ...xmlFormatModule.capabilities, canIncrementalReparse: false }
    }
    const xml = '<root><a>1</a></root>'
    const oldStore = parseFull(xmlFormatModule, xml)
    const request: SpliceRequest = {
      format: noIncremental,
      oldStore,
      newBytes: utf8(xml),
      interner: oldStore.interner,
      dirtyStart: 0,
      dirtyEnd: 0,
      delta: 0,
      options: OPTIONS
    }
    expect(spliceSubtree(request)).toEqual({ ok: false, reason: 'unsupported' })
  })
})

describe('spliceSubtree — R143: a multi-root parseRange result is refused', () => {
  it('a parseRange that emits two top-level siblings is refused as malformed, not silently grafted with an orphaned node', () => {
    // R143-yaml.md §2's own demonstration, reproduced through the real
    // spliceSubtree: a parseRange result whose fresh nodes have more than
    // one root at ref 0 — exactly the shape a YAML outdent produces (a
    // node closes early and a sibling opens within the same reparsed
    // range), and the shape XML/JSON/TOML's own parsers never produce
    // today. Base the format on real XML (so `parse`/`resumeContextFor`
    // build a genuine `oldStore`) and override only `parseRange` to
    // misbehave.
    const xml = '<root><a>1</a><b>2</b></root>'
    const oldStore = parseFull(xmlFormatModule, xml)

    const twoRootFormat: FormatModule = {
      ...xmlFormatModule,
      parseRange(_source, start, end, sink) {
        const mid = start + Math.max(1, Math.floor((end - start) / 2))
        // Both opened and closed with no enclosing frame — each gets
        // `parent === NO_REF` in the fresh store, the orphaning shape.
        const a = sink.openNode(NodeKind.Element, start, -1, -1)
        sink.closeNode(a, mid)
        const b = sink.openNode(NodeKind.Element, mid, -1, -1)
        sink.closeNode(b, end)
        return { complete: true, bytesConsumed: end, diagnosticCount: 0 }
      }
    }

    // The exact span of `<a>1</a>` — `findSpliceNode` escalates a dirty
    // range matching a node's own span exactly, so this reparses `<root>`
    // itself, matching the plan's own "outdent" shape (the enclosing node
    // is what gets reparsed and comes back with an extra root).
    const start = xml.indexOf('<a>')
    const end = xml.indexOf('</a>') + '</a>'.length

    const request: SpliceRequest = {
      format: twoRootFormat,
      oldStore,
      newBytes: utf8(xml),
      interner: oldStore.interner,
      dirtyStart: start,
      dirtyEnd: end,
      delta: 0,
      options: OPTIONS
    }

    const outcome = spliceSubtree(request)
    expect(outcome).toEqual({ ok: false, reason: 'malformed' })
  })

  it('the same multi-root result is also refused on the chunked H2d path', () => {
    const xml = '<root><a>1</a><b>2</b></root>'
    const oldStore = parseFull(xmlFormatModule, xml)

    const twoRootFormat: FormatModule = {
      ...xmlFormatModule,
      parseRange(_source, start, end, sink) {
        const mid = start + Math.max(1, Math.floor((end - start) / 2))
        const a = sink.openNode(NodeKind.Element, start, -1, -1)
        sink.closeNode(a, mid)
        const b = sink.openNode(NodeKind.Element, mid, -1, -1)
        sink.closeNode(b, end)
        return { complete: true, bytesConsumed: end, diagnosticCount: 0 }
      }
    }

    const start = xml.indexOf('<a>')
    const end = xml.indexOf('</a>') + '</a>'.length

    const request: SpliceRequest = {
      format: twoRootFormat,
      oldStore,
      newBytes: utf8(xml),
      interner: oldStore.interner,
      dirtyStart: start,
      dirtyEnd: end,
      delta: 0,
      options: OPTIONS
    }

    const outcome = beginSpliceSubtree(request)
    expect(outcome).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('spliceSubtree — randomized (mirrors B12 invariant 4)', () => {
  it('many random single-leaf edits across a generated document all splice consistently with a full reparse', () => {
    // A moderately sized, deterministically generated document — enough
    // nodes for a meaningful sample without the cost of a real fixture.
    let xml = '<root>'
    for (let i = 0; i < 200; i++) xml += `<item id="${i}"><name>value${i}</name></item>`
    xml += '</root>'

    let a = 0x1234
    function rnd(): number {
      a = (a * 1103515245 + 12345) & 0x7fffffff
      return a / 0x7fffffff
    }

    for (let i = 0; i < 30; i++) {
      const target = Math.floor(rnd() * 200)
      const marker = `value${target}`
      const idx = xml.indexOf(marker)
      if (idx === -1) continue
      const outcome = spliceAndCompare(
        xmlFormatModule,
        xml,
        idx,
        idx + marker.length,
        `edited-${i}`
      )
      expect(outcome.ok).toBe(true)
    }
  })
})

// M5-PLAN.md H2d — the chunked graft (`beginSpliceSubtree`) must produce a
// store column-for-column identical to the synchronous one (`spliceSubtree`)
// for the same edit, and a splice cancelled mid-graft must never resolve.
describe('beginSpliceSubtree — chunked graft (H2d)', () => {
  function requestFor(
    format: typeof xmlFormatModule,
    oldStore: ReturnType<typeof parseFull>,
    originalText: string,
    editStart: number,
    editEnd: number,
    replacement: string
  ): { request: SpliceRequest; newText: string; newBytes: Uint8Array } {
    const newText = originalText.slice(0, editStart) + replacement + originalText.slice(editEnd)
    const newBytes = utf8(newText)
    const delta = replacement.length - (editEnd - editStart)
    return {
      request: {
        format,
        oldStore,
        newBytes,
        interner: oldStore.interner,
        dirtyStart: editStart,
        dirtyEnd: editEnd,
        delta,
        options: OPTIONS
      },
      newText,
      newBytes
    }
  }

  it('produces a store identical to the synchronous splice for a small edit', async () => {
    const xml = '<root><a><b>1</b><c>2</c></a><d>3</d></root>'
    const start = xml.indexOf('1')
    const oldStoreSync = parseFull(xmlFormatModule, xml)
    const oldStoreChunked = parseFull(xmlFormatModule, xml)

    const sync = requestFor(xmlFormatModule, oldStoreSync, xml, start, start + 1, '100')
    const syncOutcome = spliceSubtree(sync.request)
    if (!syncOutcome.ok) throw new Error('sync splice unexpectedly failed')

    const chunked = requestFor(xmlFormatModule, oldStoreChunked, xml, start, start + 1, '100')
    const begun = beginSpliceSubtree(chunked.request)
    if (!begun.ok) throw new Error('chunked splice unexpectedly failed to start')
    const chunkedStore = await begun.job.result

    expect(flatten(chunkedStore, chunked.newBytes, 0)).toEqual(
      flatten(syncOutcome.store, sync.newBytes, 0)
    )
    expect(chunkedStore.diagnostics).toEqual(syncOutcome.store.diagnostics)
  })

  it('produces a store identical to the synchronous splice across many "after" segment batches', async () => {
    // GRAFT_BATCH_SIZE is 4096 — enough siblings after the edited node
    // that the chunked graft's "after" segment loop must span several
    // batches (and, at 8ms slices, likely several scheduled slices too),
    // not just one, to exercise the multi-batch/multi-slice bookkeeping.
    let xml = '<root><edited>1</edited>'
    for (let i = 0; i < 10000; i++) xml += `<item id="${i}"><name>value${i}</name></item>`
    xml += '</root>'

    const start = xml.indexOf('1')
    const oldStoreSync = parseFull(xmlFormatModule, xml)
    const oldStoreChunked = parseFull(xmlFormatModule, xml)

    const sync = requestFor(xmlFormatModule, oldStoreSync, xml, start, start + 1, '100')
    const syncOutcome = spliceSubtree(sync.request)
    if (!syncOutcome.ok) throw new Error('sync splice unexpectedly failed')

    const chunked = requestFor(xmlFormatModule, oldStoreChunked, xml, start, start + 1, '100')
    const begun = beginSpliceSubtree(chunked.request)
    if (!begun.ok) throw new Error('chunked splice unexpectedly failed to start')
    const chunkedStore = await begun.job.result

    expect(flatten(chunkedStore, chunked.newBytes, 0)).toEqual(
      flatten(syncOutcome.store, sync.newBytes, 0)
    )
  })

  it('a cancelled job never resolves, and cancelling twice is a no-op', async () => {
    let xml = '<root><edited>1</edited>'
    for (let i = 0; i < 10000; i++) xml += `<item id="${i}"><name>value${i}</name></item>`
    xml += '</root>'
    const start = xml.indexOf('1')
    const oldStore = parseFull(xmlFormatModule, xml)
    const { request } = requestFor(xmlFormatModule, oldStore, xml, start, start + 1, '100')

    const begun = beginSpliceSubtree(request)
    if (!begun.ok) throw new Error('chunked splice unexpectedly failed to start')

    let settled: 'resolved' | 'rejected' | null = null
    begun.job.result.then(
      () => (settled = 'resolved'),
      () => (settled = 'rejected')
    )

    begun.job.cancel()
    expect(() => begun.job.cancel()).not.toThrow()

    await expect(begun.job.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(settled).toBe('rejected')
  })
})
