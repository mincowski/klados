import { describe, expect, it } from 'vitest'
import { SourceBuffer } from '../src/core/buffer'
import {
  applyPatch,
  applyPatchesAscending,
  createEdit,
  encodeForRoundTrip,
  rebaseSequentialPatches,
  type Patch
} from '../src/renderer/session/documentEdits'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function bufferOf(bytes: Uint8Array, encoding = 'utf-8', bomLength = 0): SourceBuffer {
  return new SourceBuffer(bytes, encoding, bomLength)
}

describe('applyPatch', () => {
  it('splices a replacement in, leaving offsets outside the patch untouched', () => {
    const bytes = utf8('hello world')
    const patch: Patch = { start: 6, end: 11, replacement: utf8('there') }
    const result = applyPatch(bytes, patch)
    expect(new TextDecoder().decode(result)).toBe('hello there')
  })

  it('applies an insertion (start === end) without deleting anything', () => {
    const bytes = utf8('helloworld')
    const patch: Patch = { start: 5, end: 5, replacement: utf8(' ') }
    expect(new TextDecoder().decode(applyPatch(bytes, patch))).toBe('hello world')
  })

  it('applies a pure deletion (empty replacement)', () => {
    const bytes = utf8('hello world')
    const patch: Patch = { start: 5, end: 11, replacement: new Uint8Array(0) }
    expect(new TextDecoder().decode(applyPatch(bytes, patch))).toBe('hello')
  })

  it('a patch at the very start leaves everything after it untouched', () => {
    const bytes = utf8('0123456789')
    const patch: Patch = { start: 0, end: 3, replacement: utf8('X') }
    expect(new TextDecoder().decode(applyPatch(bytes, patch))).toBe('X3456789')
  })

  it('a patch at the very end leaves everything before it untouched', () => {
    const bytes = utf8('0123456789')
    const patch: Patch = { start: 8, end: 10, replacement: utf8('XY') }
    expect(new TextDecoder().decode(applyPatch(bytes, patch))).toBe('01234567XY')
  })

  it('does not mutate the input buffer', () => {
    const bytes = utf8('hello world')
    const before = bytes.slice()
    applyPatch(bytes, { start: 0, end: 5, replacement: utf8('bye') })
    expect(bytes).toEqual(before)
  })

  it('throws (dev-only) rather than silently corrupting on an inverted range', () => {
    const bytes = utf8('hello world')
    expect(() => applyPatch(bytes, { start: 5, end: 2, replacement: utf8('x') })).toThrow(
      /invalid range/
    )
  })

  it('throws (dev-only) rather than silently corrupting on a negative start', () => {
    const bytes = utf8('hello world')
    expect(() => applyPatch(bytes, { start: -3, end: 5, replacement: utf8('x') })).toThrow(
      /invalid range/
    )
  })

  it('throws (dev-only) rather than silently corrupting when end exceeds the buffer', () => {
    const bytes = utf8('hello')
    expect(() => applyPatch(bytes, { start: 0, end: 100, replacement: utf8('x') })).toThrow(
      /invalid range/
    )
  })
})

/** The pre-R108 shape, for byte-identity comparison — apply patches one at
 * a time, descending, exactly what `applyReplaceAll` did before. */
function applyDescendingSlow(bytes: Uint8Array, patchesAscending: readonly Patch[]): Uint8Array {
  let out = bytes
  for (const patch of [...patchesAscending].reverse()) out = applyPatch(out, patch)
  return out
}

describe('applyPatchesAscending', () => {
  it('splices multiple non-overlapping ascending patches in one pass', () => {
    const text = 'the cat sat on the cat mat'
    const bytes = utf8(text)
    const firstCat = text.indexOf('cat')
    const secondCat = text.indexOf('cat', firstCat + 1)
    const patches: Patch[] = [
      { start: firstCat, end: firstCat + 3, replacement: utf8('dog') },
      { start: secondCat, end: secondCat + 3, replacement: utf8('dog') }
    ]
    const result = applyPatchesAscending(bytes, patches)
    expect(new TextDecoder().decode(result)).toBe('the dog sat on the dog mat')
  })

  it('matches the byte-for-byte output of the old descending per-patch loop', () => {
    const bytes = utf8('cat-cat-cat-cat-cat')
    const patches: Patch[] = [0, 4, 8, 12, 16].map((start) => ({
      start,
      end: start + 3,
      replacement: utf8('elephant')
    }))
    expect(applyPatchesAscending(bytes, patches)).toEqual(applyDescendingSlow(bytes, patches))
  })

  it('handles a match at the very first byte and the very last byte', () => {
    const bytes = utf8('cat-middle-cat')
    const patches: Patch[] = [
      { start: 0, end: 3, replacement: utf8('X') },
      { start: 11, end: 14, replacement: utf8('Y') }
    ]
    expect(new TextDecoder().decode(applyPatchesAscending(bytes, patches))).toBe('X-middle-Y')
  })

  it('handles matches immediately adjacent to each other', () => {
    const bytes = utf8('catcat')
    const patches: Patch[] = [
      { start: 0, end: 3, replacement: utf8('dog') },
      { start: 3, end: 6, replacement: utf8('dog') }
    ]
    expect(new TextDecoder().decode(applyPatchesAscending(bytes, patches))).toBe('dogdog')
  })

  it('an empty patch list returns the input unchanged (by content)', () => {
    const bytes = utf8('unchanged')
    expect(new TextDecoder().decode(applyPatchesAscending(bytes, []))).toBe('unchanged')
  })

  it('throws (dev-only) on out-of-order or overlapping patches', () => {
    const bytes = utf8('abcdef')
    expect(() =>
      applyPatchesAscending(bytes, [
        { start: 3, end: 5, replacement: utf8('X') },
        { start: 4, end: 6, replacement: utf8('Y') }
      ])
    ).toThrow(/invalid or out-of-order range/)
  })
})

describe('rebaseSequentialPatches', () => {
  it('is a no-op for a single patch', () => {
    const patch: Patch = { start: 5, end: 8, replacement: utf8('X') }
    expect(rebaseSequentialPatches([patch])).toEqual([patch])
  })

  it('shifts later patches left by the cumulative length delta of earlier ones (shrinking)', () => {
    // Two "sequential" patches — the second one's start (10) is only
    // correct once the first (a 6-byte range replaced by 1 byte, a -5
    // delta) has already been applied.
    const sequential: Patch[] = [
      { start: 2, end: 8, replacement: utf8('X') }, // 6 bytes -> 1, delta -5
      { start: 10, end: 13, replacement: utf8('Y') }
    ]
    expect(rebaseSequentialPatches(sequential)).toEqual([
      { start: 2, end: 8, replacement: utf8('X') },
      { start: 15, end: 18, replacement: utf8('Y') } // 10-(-5), 13-(-5)
    ])
  })

  it('shifts later patches right for a growing replacement', () => {
    const sequential: Patch[] = [
      { start: 2, end: 3, replacement: utf8('XXXX') }, // +3
      { start: 4, end: 6, replacement: utf8('Y') }
    ]
    expect(rebaseSequentialPatches(sequential)).toEqual([
      { start: 2, end: 3, replacement: utf8('XXXX') },
      { start: 1, end: 3, replacement: utf8('Y') } // 4-3, 6-3
    ])
  })
})

describe('R110 — Replace All performance', () => {
  it('5 MB / 20,000 matches completes well under 2 seconds and produces correct bytes', () => {
    const needle = 'engine'
    const filler = 'x'.repeat(240)
    const unit = needle + filler
    const repeats = Math.ceil((5 * 1024 * 1024) / unit.length)
    const text = unit.repeat(repeats)
    const bytes = utf8(text)

    const patches: Patch[] = []
    let searchFrom = 0
    for (;;) {
      const idx = text.indexOf(needle, searchFrom)
      if (idx === -1) break
      patches.push({ start: idx, end: idx + needle.length, replacement: utf8('eng') })
      searchFrom = idx + needle.length
    }
    expect(patches.length).toBeGreaterThanOrEqual(20000)

    const start = performance.now()
    const result = applyPatchesAscending(bytes, patches)
    const elapsedMs = performance.now() - start

    expect(elapsedMs).toBeLessThan(2000)
    expect(new TextDecoder().decode(result)).toBe(text.split(needle).join('eng'))
  })
})

describe('encodeForRoundTrip', () => {
  it('encodes UTF-8 losslessly, including multi-byte characters', () => {
    const encoded = encodeForRoundTrip('héllo 中 😀', 'utf-8')
    expect(encoded).not.toBeNull()
    expect(new TextDecoder('utf-8').decode(encoded!)).toBe('héllo 中 😀')
  })

  it('encodes UTF-16LE losslessly, including a surrogate pair', () => {
    const encoded = encodeForRoundTrip('héllo 中 😀', 'utf-16le')
    expect(encoded).not.toBeNull()
    expect(new TextDecoder('utf-16le').decode(encoded!)).toBe('héllo 中 😀')
  })

  it('encodes UTF-16BE losslessly', () => {
    const encoded = encodeForRoundTrip('héllo 中', 'utf-16be')
    expect(encoded).not.toBeNull()
    expect(new TextDecoder('utf-16be').decode(encoded!)).toBe('héllo 中')
  })

  it('is case-insensitive on the encoding name', () => {
    expect(encodeForRoundTrip('a', 'UTF-8')).not.toBeNull()
    expect(encodeForRoundTrip('a', 'Utf-16LE')).not.toBeNull()
  })

  it('encodes single-byte legacy code pages via the shared textEncode probe (R125)', () => {
    expect(encodeForRoundTrip('a', 'windows-1252')).not.toBeNull()
    expect(encodeForRoundTrip('a', 'iso-8859-1')).not.toBeNull()
  })

  it('still refuses a genuinely multi-byte non-UTF encoding', () => {
    expect(encodeForRoundTrip('a', 'shift_jis')).toBeNull()
  })
})

describe('createEdit', () => {
  it('produces the expected bytes for a UTF-8 document', () => {
    const buffer = bufferOf(utf8('{"a":1}'))
    const outcome = createEdit(buffer, { start: 5, end: 6, text: '2' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(new TextDecoder().decode(outcome.bytes)).toBe('{"a":2}')
    expect(outcome.patch).toEqual({ start: 5, end: 6, replacement: utf8('2') })
  })

  it('refuses an edit at offset 0 that would eat a BOM (D-032)', () => {
    const bomLength = 3
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('{}')])
    const buffer = bufferOf(bytes, 'utf-8', bomLength)
    const outcome = createEdit(buffer, { start: 0, end: 1, text: 'X' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reason).toEqual({ kind: 'bom' })
    expect(outcome.message.length).toBeGreaterThan(0)
  })

  it('allows an edit that starts exactly at bomLength', () => {
    const bomLength = 3
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('{}')])
    const buffer = bufferOf(bytes, 'utf-8', bomLength)
    const outcome = createEdit(buffer, { start: 3, end: 4, text: '[' })
    expect(outcome.ok).toBe(true)
  })

  it('refuses an edit on a document in a genuinely multi-byte encoding', () => {
    const buffer = bufferOf(utf8('<a>x</a>'), 'shift_jis')
    const outcome = createEdit(buffer, { start: 0, end: 0, text: 'y' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reason).toEqual({ kind: 'unsupported-encoding', encoding: 'shift_jis' })
    expect(outcome.message.length).toBeGreaterThan(0)
  })

  it('applies an edit to a windows-1252 document containing é, round-tripping through bytes (R125)', () => {
    // The buffer's own initial bytes must actually be windows-1252, not
    // UTF-8 mislabeled — otherwise this would only prove the encode step
    // works, not that the whole document stays coherent.
    const initial = new TextEncoder().encode('<a>x</a>') // pure ASCII either way
    const buffer = bufferOf(initial, 'windows-1252')
    const outcome = createEdit(buffer, { start: 3, end: 4, text: 'é' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    // Assert on the actual bytes that would be saved, not just the decoded
    // string — the whole point of the round is what lands in the file.
    expect(outcome.patch.replacement).toEqual(new Uint8Array([0xe9]))
    expect(new TextDecoder('windows-1252').decode(outcome.bytes)).toBe('<a>é</a>')
    // The document's own encoding is unchanged — nothing silently became UTF-8.
    expect(buffer.encoding).toBe('windows-1252')
  })

  it('refuses an edit inserting 日 into a windows-1252 document, naming the character', () => {
    const buffer = bufferOf(utf8('<a>x</a>'), 'windows-1252')
    const outcome = createEdit(buffer, { start: 3, end: 4, text: '日' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reason).toEqual({
      kind: 'unrepresentable-character',
      encoding: 'windows-1252',
      character: '日'
    })
    expect(outcome.message).toContain('日')
  })
})
