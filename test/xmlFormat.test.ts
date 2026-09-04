/**
 * M5e-PLAN.md R11 — the XML formatter. Invariant-tested against a
 * generated corpus (M0-PLAN B12's rule: parser/formatter work is
 * invariant-tested, not example-tested), plus a handful of examples for
 * the specific shapes §5.7's acceptance criteria name directly.
 */
import { describe, expect, it } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeFlags, NodeStore } from '../src/core/nodeStore'
import { DEFAULT_MAX_DEPTH } from '../src/core/parseDefaults'
import type { FormatOptions, ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

const dec = new TextDecoder()
const PARSE_OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }
const FORMAT_OPTIONS: FormatOptions = { indent: '  ', newline: '\n' }

function format(source: Uint8Array): Uint8Array {
  return xmlFormatModule.format!(source, FORMAT_OPTIONS)
}

/** A structural snapshot of a parse — kind/name/value/attrs per node, in
 * store order — independent of byte offsets, so it can compare a document
 * against its own reformatted output even though every offset shifted. */
function structuralSnapshot(source: Uint8Array): unknown[] {
  const interner = new Interner()
  const store = new NodeStore(source, interner)
  xmlFormatModule.parse(source, store, PARSE_OPTIONS)
  const out: unknown[] = []
  for (let i = 0; i < store.nodeCount; i++) {
    const attrs: [string, string][] = []
    for (const a of store.attributesOf(i)) {
      attrs.push([interner.text(a.nameId), dec.decode(source.subarray(a.valueStart, a.valueEnd))])
    }
    const value = store.valueOf(i)
    out.push({
      kind: store.kindOf(i),
      name: store.nameOf(i),
      value: value === null ? null : dec.decode(source.subarray(value.start, value.end)),
      attrs
    })
  }
  return out
}

function mixedAndPreserveSpans(source: Uint8Array): { start: number; end: number }[] {
  const store = new NodeStore(source, new Interner())
  xmlFormatModule.parse(source, store, PARSE_OPTIONS)
  const spans: { start: number; end: number }[] = []
  for (let i = 0; i < store.nodeCount; i++) {
    if (store.hasFlag(i, NodeFlags.IsMixed)) {
      const span = store.spanOf(i)
      spans.push({ start: span.start, end: span.end })
    }
  }
  return spans
}

// mulberry32 — deterministic, same generator shape `invariants.test.ts` uses.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Generates a bounded-depth, deliberately messy XML document — random
 * whitespace, attributes, comments, CDATA, mixed content and
 * xml:space="preserve" scopes — so the invariants below are checked
 * against shapes no hand-picked example would think to cover. */
function genXml(rand: () => number, depth: number): string {
  const names = ['a', 'b', 'c', 'car', 'x']
  const name = (): string => names[Math.floor(rand() * names.length)]!
  const ws = (): string => (rand() < 0.5 ? '' : ' '.repeat(1 + Math.floor(rand() * 3)))
  const wrapWs = (s: string): string => ws() + s + ws()

  function genAttrs(): string {
    const n = Math.floor(rand() * 3)
    let out = ''
    for (let i = 0; i < n; i++) out += ` ${name()}="v${Math.floor(rand() * 100)}"`
    if (depth > 3 && rand() < 0.15) out += ' xml:space="preserve"'
    return out
  }

  function genChild(d: number): string {
    const r = rand()
    if (r < 0.5 && d < 4) return genElement(d + 1)
    if (r < 0.65) return `<!--c${Math.floor(rand() * 100)}-->`
    if (r < 0.75) return `<![CDATA[data${Math.floor(rand() * 100)}<>&]]>`
    if (r < 0.85) return `<?pi${Math.floor(rand() * 10)} data?>`
    return `text${Math.floor(rand() * 100)}`
  }

  function genElement(d: number): string {
    const tag = name()
    const attrs = genAttrs()
    if (d >= 5 || rand() < 0.15) return `<${tag}${attrs}/>`
    const childCount = Math.floor(rand() * 4)
    if (childCount === 0) {
      return rand() < 0.3 ? `<${tag}${attrs}></${tag}>` : `<${tag}${attrs}>${wrapWs('')}</${tag}>`
    }
    let body = ''
    for (let i = 0; i < childCount; i++) body += wrapWs(genChild(d))
    return `<${tag}${attrs}>${body}</${tag}>`
  }

  return genElement(depth)
}

describe('xmlFormatModule.capabilities', () => {
  it('canFormat is true (R11 reopens D-045)', () => {
    expect(xmlFormatModule.capabilities.canFormat).toBe(true)
    expect(xmlFormatModule.format).toBeDefined()
  })
})

describe('xmlFormatModule.format — invariants (generated corpus)', () => {
  const SAMPLE_COUNT = 300
  const rand = mulberry32(20260810)
  const samples: string[] = []
  for (let i = 0; i < SAMPLE_COUNT; i++) samples.push(genXml(rand, 0))

  it('is idempotent: format(format(x)) === format(x)', () => {
    for (const s of samples) {
      const source = utf8(s)
      const once = format(source)
      const twice = format(once)
      expect(dec.decode(twice), `input: ${s}`).toBe(dec.decode(once))
    }
  })

  it('reparsing the formatted output yields a structurally identical tree', () => {
    for (const s of samples) {
      const source = utf8(s)
      const formatted = format(source)
      expect(structuralSnapshot(formatted), `input: ${s}`).toEqual(structuralSnapshot(source))
    }
  })

  it('every node flagged IsMixed stays byte-identical to its own input span', () => {
    for (const s of samples) {
      const source = utf8(s)
      const mixedSpans = mixedAndPreserveSpans(source)
      if (mixedSpans.length === 0) continue
      const formatted = format(source)
      // A mixed element is copied verbatim by the formatter, so it must
      // appear byte-identical somewhere in the output — not necessarily at
      // the same offset (siblings before it may have been reformatted).
      const formattedText = dec.decode(formatted)
      for (const span of mixedSpans) {
        const original = dec.decode(source.subarray(span.start, span.end))
        expect(formattedText.includes(original), `mixed span from input: ${s}`).toBe(true)
      }
    }
  })
})

describe('xmlFormatModule.format — named acceptance cases', () => {
  it('reformats element-only content with indentation', () => {
    const out = format(utf8('<root><a/><b/></root>'))
    expect(dec.decode(out)).toBe('<root>\n  <a/>\n  <b/>\n</root>\n')
  })

  it('a leaf with its own text is never split across lines', () => {
    const out = format(utf8('<a>some text</a>'))
    expect(dec.decode(out)).toBe('<a>some text</a>\n')
  })

  it('an element flagged IsMixed is left byte-identical, unrecursed', () => {
    const input = '<a>Hello <b>   World   </b> there</a>'
    const out = format(utf8(input))
    expect(dec.decode(out)).toBe(input + '\n')
  })

  it('xml:space="preserve" scope is left byte-identical, including nested elements', () => {
    const input = '<a xml:space="preserve"><b/>   <c>  x  </c></a>'
    const out = format(utf8(input))
    expect(dec.decode(out)).toBe(input + '\n')
  })

  // D-058 follow-up (raised against `<p>Text <b><a>with a link</a></b> and
  // more text</p>`): the skip rule is subtree-scoped, not element-scoped.
  // `<p>` is mixed; `<b>` and `<a>` inside it are not, on their own. An
  // element-scoped skip would freeze `<p>` and then happily descend into
  // `<b>`/`<a>` and reindent them — inserting whitespace into mixed
  // content, exactly the corruption the flag exists to prevent. A
  // hand-written example on purpose, per the plan's own instruction: this
  // is the known trap, not a case a random corpus is likely to hit (it
  // needs a *non-mixed* element nested inside a *mixed* one).
  it('the skip rule is subtree-scoped: non-mixed descendants of a mixed element stay untouched too', () => {
    const input = '<p>Text <b><a>with a link</a></b> and more text</p>'
    const out = format(utf8(input))
    expect(dec.decode(out)).toBe(input + '\n')
  })

  it('reflows pre-existing whitespace between structural children', () => {
    const out = format(utf8('<root>  <a/>\n\n  <b/>  </root>'))
    expect(dec.decode(out)).toBe('<root>\n  <a/>\n  <b/>\n</root>\n')
  })

  it('preserves attributes verbatim, including order and spacing', () => {
    const out = format(utf8('<a x="1"   y="2"/>'))
    expect(dec.decode(out)).toBe('<a x="1"   y="2"/>\n')
  })

  it('preserves an empty element exactly, self-closing or not', () => {
    expect(dec.decode(format(utf8('<a/>')))).toBe('<a/>\n')
    expect(dec.decode(format(utf8('<a></a>')))).toBe('<a></a>\n')
  })

  it("preserves whitespace-only leaf content (it is the element's own value, not filler)", () => {
    const out = format(utf8('<a>   </a>'))
    expect(dec.decode(out)).toBe('<a>   </a>\n')
  })

  it('a CDATA-and-text-only leaf is copied verbatim, on one line', () => {
    const input = '<a>x<![CDATA[<y>]]>z</a>'
    const out = format(utf8(input))
    expect(dec.decode(out)).toBe(input + '\n')
  })

  it('preserves the XML declaration and reformats the root after it', () => {
    const out = format(utf8('<?xml version="1.0" encoding="UTF-8"?>\n<root><a/></root>'))
    expect(dec.decode(out)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <a/>\n</root>\n'
    )
  })

  it('preserves a BOM untouched', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('<root><a/></root>')])
    const out = format(withBom)
    expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(dec.decode(out.subarray(3))).toBe('<root>\n  <a/>\n</root>\n')
  })
})

describe('xmlFormatModule.format — encoding refusal', () => {
  it('refuses a UTF-16 document rather than silently corrupting it', () => {
    const declared = '<?xml version="1.0" encoding="UTF-16"?><root><a/></root>'
    const bom = [0xff, 0xfe] // UTF-16LE BOM
    const bytes = new Uint8Array([...bom, ...Array.from(utf8(declared))])
    expect(() => format(bytes)).toThrow(/utf-16/i)
  })

  it('formats a plain UTF-8 document with no BOM and no declaration', () => {
    expect(() => format(utf8('<a/>'))).not.toThrow()
  })
})

// M5h-PLAN.md R18, §1's own table: `formatElement`/`emitChild` used to be
// mutually recursive over user input with no depth bound of their own,
// overflowing the JS call stack at 5 000 levels of `<a>` nesting — well
// inside DEFAULT_MAX_DEPTH (10 000), so not an exotic input. §3's own test
// is this table, parametrised.
describe('xmlFormatModule.format — deep nesting does not overflow the stack (M5h-PLAN.md R18)', () => {
  function deepXml(depth: number): Uint8Array {
    return utf8('<a>'.repeat(depth) + 'leaf' + '</a>'.repeat(depth))
  }

  it('the degenerate case: <a></a> formats correctly', () => {
    expect(dec.decode(format(utf8('<a></a>')))).toBe('<a></a>\n')
  })

  it.each([100, 1000, 5000, 9000])(
    'depth %i: format() does not throw and re-parses to the same tree (hard rule 4)',
    (depth) => {
      const source = deepXml(depth)
      const deepOptions: ParseOptions = { maxDepth: depth + 10, encoding: 'utf-8' }

      let formatted: Uint8Array
      expect(() => {
        formatted = format(source)
      }).not.toThrow()

      const before = new NodeStore(source, new Interner())
      const beforeResult = xmlFormatModule.parse(source, before, deepOptions)
      const after = new NodeStore(formatted!, new Interner())
      const afterResult = xmlFormatModule.parse(formatted!, after, deepOptions)

      expect(beforeResult.complete).toBe(true)
      expect(afterResult.complete).toBe(true)
      // §3's own ask: pass 1 and pass 2 agree on element count — the
      // cursor contract O2 introduced is what a recursion-to-iteration
      // rewrite is most likely to break silently.
      expect(after.nodeCount).toBe(before.nodeCount)
    }
  )

  it('depth past DEFAULT_MAX_DEPTH degrades to the input unchanged rather than throwing (invariant 5)', () => {
    const source = deepXml(DEFAULT_MAX_DEPTH + 5000)
    let formatted: Uint8Array
    expect(() => {
      formatted = format(source)
    }).not.toThrow()
    expect(formatted!).toEqual(source)
  })

  it("depth exactly at the failure point from the plan's own measurement (20 000) does not throw", () => {
    expect(() => format(deepXml(20_000))).not.toThrow()
  })
})
