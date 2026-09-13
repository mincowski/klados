/**
 * R201 (`docs/plans/R201-unicode-path-names.md`) — the path query grammar can
 * name a non-ASCII node.
 *
 * Two halves, and the second is the one that made this a round rather than a
 * one-line regex widening: the character class had to stop being a whitelist,
 * **and** the cursor had to advance by code point. A lone surrogate matches no
 * `\p{L}` class however the class is written, so widening alone would have left
 * astral names broken while closing the `FINDINGS.md` entry.
 *
 * **Every fixture is authored from `\uXXXX` escapes and guards its codepoints
 * before asserting behaviour** (`docs/FINDINGS.md`). Typing the characters
 * directly is how R72 and R202's own measurements went wrong twice: an editor
 * or a tool normalizes them away and the test still passes, against text that
 * is no longer the text under examination.
 */
import { describe, expect, it } from 'vitest'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { buildNameIndex } from '../src/core/nameIndex'
import { NodeStore } from '../src/core/nodeStore'
import { evaluatePath } from '../src/core/path/evaluate'
import { parsePath, type NameResolver } from '../src/core/path/parse'
import type { ParseOptions } from '../src/core/types'
import { xmlFormatModule } from '../src/formats/xml/index'

const OPTIONS: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

/** `größe` — Latin small letter o with diaeresis, composed (U+00F6). */
const GROESSE = 'größe'
/** U+20000, the first CJK Extension B ideograph — outside the BMP, so it is
 * two UTF-16 code units and a surrogate pair to any code-unit-at-a-time
 * cursor. R201 § 2's case. */
const ASTRAL = '\u{20000}'

function codePoints(s: string): number[] {
  return [...s].map((c) => c.codePointAt(0)!)
}

function parseXml(text: string): { store: NodeStore; source: SourceBuffer } {
  const bytes = new TextEncoder().encode(text)
  const store = new NodeStore(bytes, new Interner())
  const result = xmlFormatModule.parse(bytes, store, OPTIONS)
  if (!result.complete) throw new Error('test fixture must parse completely')
  return { store, source: new SourceBuffer(bytes, 'utf-8', 0) }
}

function run(store: NodeStore, source: SourceBuffer, query: string): number[] {
  const nameIndex = buildNameIndex(store, store.interner.size)
  const parsed = parsePath(query, (name) => store.interner.lookup(name))
  if (!parsed.ok) throw new Error(`query failed to parse: ${parsed.diagnostic.message}`)
  return [...evaluatePath(store, nameIndex, source, parsed.path)]
}

function resolverFor(names: readonly string[]): NameResolver {
  const map = new Map(names.map((name, i) => [name, i]))
  return (name) => map.get(name) ?? null
}

describe('R201 — a non-ASCII name tokenizes and resolves', () => {
  it('guards its own fixtures', () => {
    expect(codePoints(GROESSE)).toEqual([0x67, 0x72, 0x00f6, 0x00df, 0x65])
    expect(codePoints(ASTRAL)).toEqual([0x20000])
    expect(ASTRAL.length).toBe(2) // a surrogate pair, which is the whole point
  })

  it('//größe resolves against a document containing that element', () => {
    // Acceptance 1. Before R201 this failed to *tokenize*: the cursor stopped
    // at `ö` and the parse died one layer before name resolution was reached,
    // which is why R53's encoding fix was unreachable from the UI.
    const { store, source } = parseXml(`<root><${GROESSE}>1</${GROESSE}><other/></root>`)
    expect(run(store, source, `//${GROESSE}`)).toHaveLength(1)
  })

  it('an astral name resolves — the half a wider character class would have missed', () => {
    // Acceptance 2. `\p{L}` does not match a lone surrogate, so a widened
    // regex over code units still rejects this.
    const name = `x${ASTRAL}y`
    const { store, source } = parseXml(`<root><${name}>1</${name}></root>`)
    expect(run(store, source, `//${name}`)).toHaveLength(1)
  })

  it('resolves a non-ASCII name inside a predicate, on both axes', () => {
    const { store, source } = parseXml(
      `<root><item ${GROESSE}="L"><${GROESSE}>1</${GROESSE}></item><item/></root>`
    )
    expect(run(store, source, `//item[@${GROESSE}="L"]`)).toHaveLength(1)
    expect(run(store, source, `//item[${GROESSE}]`)).toHaveLength(1)
  })

  it('keeps R53’s ‘unrepresentable’ distinct from a parse failure', () => {
    // Acceptance 4. The two failure modes answer different questions —
    // "this query is malformed" against "this document's encoding cannot
    // express that character at all" — and collapsing them re-introduces
    // exactly what R53 fixed.
    const interner = new Interner()
    const parsed = parsePath(`//${GROESSE}`, (name) => interner.lookup(name, 'windows-1252'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.path.steps[0]!.nameId).toBe(null)

    // `日本語` has no windows-1252 spelling at all. It **tokenizes** — that is
    // R201's fix working — and then fails at resolution with its own message,
    // which is R53's third state surfacing rather than collapsing into
    // "no results". The two failures must not read alike.
    const cjk = parsePath('//日本語', (name) => interner.lookup(name, 'windows-1252'))
    expect(cjk.ok).toBe(false)
    if (cjk.ok) return
    expect(cjk.diagnostic.message).toContain('cannot be represented')

    const broken = parsePath('//[', resolverFor([]))
    expect(broken.ok).toBe(false)
    if (broken.ok) return
    expect(broken.diagnostic.message).not.toContain('cannot be represented')

    // Same distinction inside a predicate, which resolves names on its own path.
    const inPredicate = parsePath('//x[@日本語="v"]', (name) =>
      name === 'x' ? 0 : interner.lookup(name, 'windows-1252')
    )
    expect(inPredicate.ok).toBe(false)
    if (inPredicate.ok) return
    expect(inPredicate.diagnostic.message).toContain('cannot be represented')
  })
})

describe('R201 — the reserved set is what ends a name', () => {
  // Acceptance 3, asserted per character rather than by sampling. These are
  // the whole basis for where a name ends now that the class is an exclusion
  // rather than a whitelist, so each one earns its own assertion.
  const RESERVED = ['/', '[', ']', '@', '*', '(', ')', '=', '!', '<', '>', '"', "'"]

  for (const ch of RESERVED) {
    it(`${JSON.stringify(ch)} terminates a name`, () => {
      const parsed = parsePath(`//ab${ch}cd`, resolverFor(['ab', 'abcd', `ab${ch}cd`]))
      if (parsed.ok) {
        // Whatever the rest of the query means, the *name* stopped at `ab`.
        expect(parsed.path.steps[0]!.nameId).toBe(0)
      } else {
        // Or the character made the query malformed, which also proves it was
        // not swallowed into the name.
        expect(parsed.diagnostic.offset).toBeGreaterThan(0)
      }
    })
  }

  it('whitespace terminates a name', () => {
    const parsed = parsePath('//ab cd', resolverFor(['ab', 'ab cd']))
    if (parsed.ok) expect(parsed.path.steps[0]!.nameId).toBe(0)
  })

  it('characters the grammar does not reserve now belong to names', () => {
    // The point of the inversion: `+`, `#`, `$`, `%`, `~` and `|` are not part
    // of this grammar, so a document that interned them is reachable. Under
    // the old whitelist every one of these was a tokenizer error.
    for (const name of ['a+b', 'a#b', 'a$b', 'a%b', 'a~b', 'a|b', 'a,b', 'a;b', 'a?b']) {
      const parsed = parsePath(`//${name}`, resolverFor([name]))
      expect(parsed.ok, name).toBe(true)
      if (parsed.ok) expect(parsed.path.steps[0]!.nameId, name).toBe(0)
    }
  })

  it("'and' and 'or' still need a word boundary, astral characters included", () => {
    // `matchesWord` refuses the boundary when a name character follows. A
    // high surrogate is not reserved, so it correctly denies it too.
    const names = ['android', `and${ASTRAL}`, 'a', 'b']
    expect(parsePath('//x[android]', resolverFor([...names, 'x'])).ok).toBe(true)
    expect(parsePath(`//x[and${ASTRAL}]`, resolverFor([...names, 'x'])).ok).toBe(true)
  })
})

describe('R203 — a path query resolves across NFC and NFD', () => {
  const COMPOSED = 'caf\u00e9'
  const DECOMPOSED = 'cafe\u0301'

  it('guards its own fixtures', () => {
    expect(codePoints(COMPOSED)).toEqual([0x63, 0x61, 0x66, 0x00e9])
    expect(codePoints(DECOMPOSED)).toEqual([0x63, 0x61, 0x66, 0x65, 0x0301])
  })

  it('//caf\u00e9 resolves against a document whose element name is decomposed', () => {
    // Acceptance 2 of `docs/plans/R202-unicode-comparison.md`. The two
    // spellings render identically, so before R203 a user typing the name
    // they could see got an empty result with nothing to explain it.
    const { store, source } = parseXml(`<root><${DECOMPOSED}>1</${DECOMPOSED}><other/></root>`)
    expect(run(store, source, `//${COMPOSED}`)).toHaveLength(1)
    expect(run(store, source, `//${DECOMPOSED}`)).toHaveLength(1)
  })

  it('resolves the reverse, and inside a predicate', () => {
    const { store, source } = parseXml(
      `<root><item ${COMPOSED}="x"><${COMPOSED}>1</${COMPOSED}></item><item/></root>`
    )
    expect(run(store, source, `//${DECOMPOSED}`)).toHaveLength(1)
    expect(run(store, source, `//item[@${DECOMPOSED}="x"]`)).toHaveLength(1)
  })

  it('does not make an unrelated name resolve', () => {
    const { store, source } = parseXml(`<root><${DECOMPOSED}>1</${DECOMPOSED}></root>`)
    expect(run(store, source, '//cafe')).toHaveLength(0)
    expect(run(store, source, '//caf\u00e8')).toHaveLength(0)
  })
})
