import { describe, expect, it } from 'vitest'
import { Interner, fnv1a32 } from '../src/core/interner'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('Interner', () => {
  it('returns the same id for the same bytes interned twice', () => {
    const interner = new Interner()
    const bytes = utf8('car')
    const a = interner.intern(bytes, 0, bytes.length)
    const b = interner.intern(bytes, 0, bytes.length)
    expect(a).toBe(b)
    expect(interner.size).toBe(1)
  })

  it('returns different ids for a forced hash collision', () => {
    // Brute-force two distinct byte strings that hash identically under
    // fnv1a32, to exercise the collision-chain comparison path directly
    // rather than hoping the fixtures happen to produce one.
    const seen = new Map<number, Uint8Array>()
    let first: Uint8Array | null = null
    let second: Uint8Array | null = null
    for (let i = 0; first === null || second === null; i++) {
      const bytes = utf8(`name-${i}`)
      const hash = fnv1a32(bytes, 0, bytes.length)
      const existing = seen.get(hash)
      if (existing !== undefined && !bytesEqual(existing, bytes)) {
        first = existing
        second = bytes
        break
      }
      seen.set(hash, bytes)
    }

    const interner = new Interner()
    const idA = interner.intern(first, 0, first.length)
    const idB = interner.intern(second, 0, second.length)
    expect(idA).not.toBe(idB)
    expect(interner.size).toBe(2)
    expect(interner.text(idA)).not.toBe(interner.text(idB))
  })

  it('interns 1,000,000 occurrences of 50 distinct names in under 500ms, size === 50', () => {
    const names = Array.from({ length: 50 }, (_, i) => utf8(`distinct-name-${i}`))
    const interner = new Interner()

    const start = performance.now()
    for (let i = 0; i < 1_000_000; i++) {
      const bytes = names[i % 50]!
      interner.intern(bytes, 0, bytes.length)
    }
    const elapsed = performance.now() - start

    expect(interner.size).toBe(50)
    expect(elapsed).toBeLessThan(500)
  })

  it('text() decodes lazily and is stable across calls', () => {
    const interner = new Interner()
    const bytes = utf8('engine')
    const id = interner.intern(bytes, 0, bytes.length)
    expect(interner.text(id)).toBe('engine')
    expect(interner.text(id)).toBe('engine')
  })

  it('interns a sub-range of a larger buffer', () => {
    const interner = new Interner()
    const bytes = utf8('<car id="x">')
    const id = interner.intern(bytes, 1, 4)
    expect(interner.text(id)).toBe('car')
  })

  it('lookup finds an existing name without interning a new one', () => {
    const interner = new Interner()
    const bytes = utf8('car')
    const id = interner.intern(bytes, 0, bytes.length)
    expect(interner.lookup('car')).toBe(id)
    expect(interner.size).toBe(1)
  })

  it('lookup returns null for a name never interned, without adding it', () => {
    const interner = new Interner()
    expect(interner.lookup('nonexistent')).toBeNull()
    expect(interner.size).toBe(0)
    // A later intern() of the same text still gets a fresh id, not
    // anything the failed lookup might have created.
    const bytes = utf8('nonexistent')
    expect(interner.intern(bytes, 0, bytes.length)).toBe(0)
  })

  it('lookup distinguishes a forced hash collision the same way intern does', () => {
    const seen = new Map<number, Uint8Array>()
    let first: Uint8Array | null = null
    let second: Uint8Array | null = null
    for (let i = 0; first === null || second === null; i++) {
      const bytes = utf8(`name-${i}`)
      const hash = fnv1a32(bytes, 0, bytes.length)
      const existing = seen.get(hash)
      if (existing !== undefined && !bytesEqual(existing, bytes)) {
        first = existing
        second = bytes
        break
      }
      seen.set(hash, bytes)
    }
    const interner = new Interner()
    const idA = interner.intern(first, 0, first.length)
    expect(interner.lookup(new TextDecoder().decode(first))).toBe(idA)
    expect(interner.lookup(new TextDecoder().decode(second))).toBeNull()
  })

  it("lookup finds a non-UTF-8-encoded name when given the document's own encoding (R53)", () => {
    // "café" stored as the document's own windows-1252 bytes — invariant 7,
    // never transcoded to UTF-8. 'é' is 0xE9 in windows-1252.
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
    const interner = new Interner()
    const id = interner.intern(bytes, 0, bytes.length)
    expect(interner.lookup('café', 'windows-1252')).toBe(id)
  })

  it('lookup against the wrong encoding does not find a name that is genuinely present (R53)', () => {
    // The bug this round fixes: encoding the query as UTF-8 against
    // windows-1252-stored bytes produces different bytes for 'é'
    // (0xC3 0xA9 in UTF-8 vs 0xE9 in windows-1252), so an unencoded/
    // wrong-encoding lookup must not accidentally still match.
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]) // "café" in windows-1252
    const interner = new Interner()
    interner.intern(bytes, 0, bytes.length)
    expect(interner.lookup('café')).toBeNull() // default utf-8 — wrong encoding for this document
  })

  it("lookup returns 'unrepresentable' for a query encoding cannot represent, not null (R53)", () => {
    const interner = new Interner()
    expect(interner.lookup('日本語', 'windows-1252')).toBe('unrepresentable')
  })

  it('lookup still returns null for a genuinely absent ASCII name under any encoding (R53)', () => {
    const interner = new Interner()
    const bytes = utf8('car')
    interner.intern(bytes, 0, bytes.length)
    expect(interner.lookup('truck', 'windows-1252')).toBeNull()
  })

  it('grows past its initial capacity', () => {
    const interner = new Interner(4)
    const ids = new Set<number>()
    for (let i = 0; i < 5000; i++) {
      const bytes = utf8(`n${i}`)
      ids.add(interner.intern(bytes, 0, bytes.length))
    }
    expect(interner.size).toBe(5000)
    expect(ids.size).toBe(5000)
  })

  describe('R209 — no prefix/local split; an interned name is the name as written', () => {
    /**
     * **R134's block, inverted rather than deleted.** It asserted that an
     * `Interner` constructed with namespaces enabled split `inv:price` into a
     * prefix and a local name, and that a JSON key like `"12:30"` was spared
     * that only by a capability gate. R209 removed the split entirely
     * (D-101), so the gate has nothing to gate and every format gets the
     * behaviour JSON and TOML already had.
     */
    it('a prefixed name interns whole, colon included', () => {
      const interner = new Interner()
      const bytes = utf8('inv:price')
      const id = interner.intern(bytes, 0, bytes.length)
      expect(interner.text(id)).toBe('inv:price')
    })

    it('two prefixes for one local name are two ids, not one', () => {
      // The property the whole round turns on, at the layer it starts from.
      const interner = new Interner()
      const a = utf8('inv:price')
      const b = utf8('s:price')
      const idA = interner.intern(a, 0, a.length)
      const idB = interner.intern(b, 0, b.length)
      expect(idA).not.toBe(idB)
      expect(interner.size).toBe(2)
    })

    it('the split surface is gone, not merely unused', () => {
      const interner = new Interner()
      for (const member of ['prefixOf', 'localNameOf', 'splitsNamespaces']) {
        expect(member in interner).toBe(false)
      }
    })

    it('fromBuffers takes no namespace flag', () => {
      // Both flags were **optional**, which is what let a caller forget one
      // and get silently different behaviour — the same shape as
      // `NodeStore.fromBuffers`'s fourth parameter. Asserted on arity so a
      // future optional flag of that kind fails here.
      //
      // Only `fromBuffers`: the constructor's own remaining parameter has a
      // default, and `Function.length` counts only parameters before the
      // first defaulted one — so it reads 0 whether there are one or three,
      // and cannot say anything about this. A second constructor argument is
      // a compile error instead, which is the stronger guarantee anyway.
      expect(Interner.fromBuffers.length).toBe(3)
    })

    it('a round trip through fromBuffers needs nothing recomputed', () => {
      // R134 re-scanned every name here to rebuild `colonAt`, and the caller
      // had to pass a flag matching the original interner or the rehydrated
      // one behaved differently. There is no derived state left to get wrong.
      const original = new Interner()
      const bytes = utf8('inv:price')
      const id = original.intern(bytes, 0, bytes.length)
      const buffers = original.exportBuffers()

      const rehydrated = Interner.fromBuffers(buffers.nameBytes, buffers.starts, buffers.ends)
      expect(rehydrated.text(id)).toBe('inv:price')
      expect(rehydrated.size).toBe(original.size)
    })
  })
})

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('Interner.lookup — canonical equivalence (R203)', () => {
  // Escapes with a codepoint guard, per `docs/FINDINGS.md`.
  const COMPOSED = 'caf\u00e9'
  const DECOMPOSED = 'cafe\u0301'

  function internerWith(...names: readonly string[]): Interner {
    const interner = new Interner()
    for (const name of names) {
      const bytes = new TextEncoder().encode(name)
      interner.intern(bytes, 0, bytes.length)
    }
    return interner
  }

  it('guards its own fixtures', () => {
    expect([...COMPOSED].map((c) => c.codePointAt(0))).toEqual([0x63, 0x61, 0x66, 0x00e9])
    expect([...DECOMPOSED].map((c) => c.codePointAt(0))).toEqual([0x63, 0x61, 0x66, 0x65, 0x0301])
    expect(new TextEncoder().encode(COMPOSED).length).toBe(5)
    expect(new TextEncoder().encode(DECOMPOSED).length).toBe(6)
  })

  it('a composed query finds a decomposed name, and the reverse', () => {
    expect(internerWith(DECOMPOSED).lookup(COMPOSED)).toBe(0)
    expect(internerWith(COMPOSED).lookup(DECOMPOSED)).toBe(0)
  })

  it('still prefers the exact byte match when both spellings are interned', () => {
    // `DECOMPOSED` is interned second, so a fallback that ignored the exact
    // path would answer 0 for it. The exact lookup must win.
    const interner = internerWith(COMPOSED, DECOMPOSED)
    expect(interner.lookup(COMPOSED)).toBe(0)
    expect(interner.lookup(DECOMPOSED)).toBe(1)
  })

  it('still returns null for a name the document does not have', () => {
    expect(internerWith(COMPOSED).lookup('tea')).toBe(null)
    expect(internerWith(COMPOSED).lookup('caf\u00e8')).toBe(null) // grave, not acute
  })

  it("keeps R53's 'unrepresentable' ahead of the fallback", () => {
    // The third state is decided by encoding, before any lookup happens —
    // a fallback that answered first would collapse it back into `null`,
    // which is exactly the defect R53 fixed.
    expect(internerWith(COMPOSED).lookup('\u65e5\u672c\u8a9e', 'windows-1252')).toBe(
      'unrepresentable'
    )
  })

  it('sees names interned after the index was first built', () => {
    // A splice interns into the same table. The index carries the count it
    // was built at and rebuilds when that changes.
    const interner = internerWith(DECOMPOSED)
    expect(interner.lookup(COMPOSED)).toBe(0)
    const later = new TextEncoder().encode('na\u0308chste')
    interner.intern(later, 0, later.length)
    expect(interner.lookup('n\u00e4chste')).toBe(1)
  })

  it('answers an ASCII query without consulting the fallback at all', () => {
    // Not an optimization detail — it is why an ASCII needle stays
    // permissive. `cafe` matches nothing here, and must not start matching
    // `café` just because the index composed it.
    const interner = internerWith(DECOMPOSED)
    expect(interner.lookup('cafe')).toBe(null)
  })
})
