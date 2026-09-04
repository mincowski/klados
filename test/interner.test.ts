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

  describe('R134 — prefix/local split, capability-gated', () => {
    it('splits a prefixed name when namespaces are enabled', () => {
      const interner = new Interner(undefined, true)
      const bytes = utf8('inv:price')
      const id = interner.intern(bytes, 0, bytes.length)
      expect(interner.prefixOf(id)).toBe('inv')
      expect(interner.localNameOf(id)).toBe('price')
    })

    it('an unprefixed name has no prefix, and localNameOf is the whole name', () => {
      const interner = new Interner(undefined, true)
      const bytes = utf8('price')
      const id = interner.intern(bytes, 0, bytes.length)
      expect(interner.prefixOf(id)).toBeNull()
      expect(interner.localNameOf(id)).toBe('price')
    })

    it('a colon in a position that is not a prefix separator (leading colon) is not a prefix', () => {
      const interner = new Interner(undefined, true)
      const bytes = utf8(':oops')
      const id = interner.intern(bytes, 0, bytes.length)
      expect(interner.prefixOf(id)).toBeNull()
      expect(interner.localNameOf(id)).toBe(':oops')
    })

    it('splitsNamespaces reports the constructor flag', () => {
      expect(new Interner().splitsNamespaces).toBe(false)
      expect(new Interner(undefined, true).splitsNamespaces).toBe(true)
    })

    it('a JSON-shaped key with a colon is not split when namespaces are disabled (the default)', () => {
      const interner = new Interner()
      const bytes = utf8('12:30')
      const id = interner.intern(bytes, 0, bytes.length)
      expect(interner.prefixOf(id)).toBeNull()
      expect(interner.localNameOf(id)).toBe('12:30')
    })

    it('fromBuffers recomputes the split when told the original interner had namespaces enabled', () => {
      const original = new Interner(undefined, true)
      const bytes = utf8('inv:price')
      const id = original.intern(bytes, 0, bytes.length)
      const buffers = original.exportBuffers()

      const rehydrated = Interner.fromBuffers(buffers.nameBytes, buffers.starts, buffers.ends, true)
      expect(rehydrated.prefixOf(id)).toBe('inv')
      expect(rehydrated.localNameOf(id)).toBe('price')
    })

    it('fromBuffers defaults to no split when the flag is omitted', () => {
      const original = new Interner(undefined, true)
      const bytes = utf8('inv:price')
      const id = original.intern(bytes, 0, bytes.length)
      const buffers = original.exportBuffers()

      const rehydrated = Interner.fromBuffers(buffers.nameBytes, buffers.starts, buffers.ends)
      expect(rehydrated.prefixOf(id)).toBeNull()
    })
  })
})

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
