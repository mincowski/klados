/**
 * M3-PLAN.md F9 — `applyChangesToSession`'s own logic (UTF-16-unit-to-byte
 * conversion, absolute-offset conversion, shift accumulation, refusal
 * reporting), independent of CodeMirror — see `rawEdit.ts`'s own top
 * comment for why this is tested at this level rather than through a real
 * `EditorView`.
 */
import { describe, expect, it } from 'vitest'
import type { DocumentSession } from '../src/renderer/session/documentSession'
import type { EditOutcome, EditRequest, Patch } from '../src/renderer/session/documentEdits'
import {
  applyChangesToSession,
  localUnitsToByteOffset,
  type RawChange
} from '../src/renderer/components/Raw/rawEdit'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** A fake `applyEdit` that succeeds unconditionally, recording every
 * request it was called with — enough to assert absolute offsets without
 * a real `SourceBuffer`/session. */
function fakeSession(
  requests: EditRequest[],
  refuseAt?: number
): Pick<DocumentSession, 'applyEdit'> {
  let calls = 0
  return {
    applyEdit(request: EditRequest): EditOutcome {
      requests.push(request)
      const index = calls++
      if (refuseAt !== undefined && index === refuseAt) {
        return { ok: false, reason: { kind: 'read-only' }, message: 'refused' }
      }
      const patch: Patch = {
        start: request.start,
        end: request.end,
        replacement: utf8(request.text)
      }
      return { ok: true, patch, bytes: new Uint8Array() }
    }
  }
}

describe('localUnitsToByteOffset', () => {
  it('equals the unit count for pure ASCII UTF-8 text', () => {
    expect(localUnitsToByteOffset('hello world', 5, 'utf-8')).toBe(5)
  })

  it('counts real bytes, not UTF-16 units, for multi-byte UTF-8 characters', () => {
    // 'é' is 1 UTF-16 unit but 2 UTF-8 bytes.
    const text = 'café world'
    // Up to and including "café" is 4 chars / 5 bytes (c-a-f-é(2 bytes)).
    expect(localUnitsToByteOffset(text, 4, 'utf-8')).toBe(5)
    // Past "café " (5 units) is 6 bytes.
    expect(localUnitsToByteOffset(text, 5, 'utf-8')).toBe(6)
  })

  it('counts 2 bytes per UTF-16 unit for a UTF-16 encoding', () => {
    expect(localUnitsToByteOffset('abc', 3, 'utf-16le')).toBe(6)
    expect(localUnitsToByteOffset('abc', 3, 'utf-16be')).toBe(6)
  })

  it('handles a surrogate pair (an astral character) consistently with encodeForRoundTrip', () => {
    // U+1F600 (😀) is one Unicode code point but 2 UTF-16 code units (a
    // surrogate pair) and 4 UTF-8 bytes.
    const text = 'a😀b'
    // Slicing to unit 3 (past the full surrogate pair) must count all 4
    // UTF-8 bytes of the emoji plus the leading 'a'.
    expect(localUnitsToByteOffset(text, 3, 'utf-8')).toBe(1 + 4)
  })
})

describe('applyChangesToSession', () => {
  it('converts a single local change to an absolute EditRequest (ASCII, unit === byte)', () => {
    const requests: EditRequest[] = []
    const session = fakeSession(requests)
    const priorText = 'hello world'
    const changes: RawChange[] = [{ fromA: 5, toA: 6, inserted: 'x' }]

    const result = applyChangesToSession(session, 1000, priorText, 'utf-8', changes)

    expect(result).toEqual({ ok: true, netByteDelta: 0 }) // 'x' replaces 1 char with 1 char
    expect(requests).toEqual([{ start: 1005, end: 1006, text: 'x' }])
  })

  it('computes the correct byte offset when non-ASCII text precedes the edit', () => {
    // Regression: CodeMirror's fromA/toA are UTF-16 units, not bytes — an
    // edit after "café " (5 units, 6 bytes in UTF-8) must land at byte
    // offset 6, not unit offset 5.
    const requests: EditRequest[] = []
    const session = fakeSession(requests)
    const priorText = 'café world'
    const changes: RawChange[] = [{ fromA: 5, toA: 5, inserted: '!' }]

    applyChangesToSession(session, 0, priorText, 'utf-8', changes)

    expect(requests).toEqual([{ start: 6, end: 6, text: '!' }])
  })

  it('computes the correct byte offset for a UTF-16-encoded document', () => {
    // Every character is 2 bytes here — a naive unit-as-byte conversion
    // would be off by a factor of 2 for every position past the start.
    const requests: EditRequest[] = []
    const session = fakeSession(requests)
    const priorText = 'abcde'
    const changes: RawChange[] = [{ fromA: 3, toA: 3, inserted: 'X' }]

    applyChangesToSession(session, 100, priorText, 'utf-16le', changes)

    expect(requests).toEqual([{ start: 106, end: 106, text: 'X' }])
  })

  it('reports a positive net delta for an insertion', () => {
    const requests: EditRequest[] = []
    const session = fakeSession(requests)
    const changes: RawChange[] = [{ fromA: 3, toA: 3, inserted: 'abc' }]

    const result = applyChangesToSession(session, 0, 'abcdefghij', 'utf-8', changes)

    expect(result).toEqual({ ok: true, netByteDelta: 3 })
  })

  it('reports a negative net delta for a deletion', () => {
    const requests: EditRequest[] = []
    const session = fakeSession(requests)
    const changes: RawChange[] = [{ fromA: 3, toA: 8, inserted: '' }]

    const result = applyChangesToSession(session, 0, 'abcdefghij', 'utf-8', changes)

    expect(result).toEqual({ ok: true, netByteDelta: -5 })
  })

  it('shifts each subsequent change in the same transaction by the accumulated delta', () => {
    const requests: EditRequest[] = []
    const session = fakeSession(requests)
    // Two insertions in one transaction: "ab" at local unit 0, then "xyz"
    // at what was local unit 10 *before* the first insertion —
    // CodeMirror's own iterChanges gives both relative to the same
    // pre-transaction document.
    const priorText = '0123456789ABCDEFGHIJ'
    const changes: RawChange[] = [
      { fromA: 0, toA: 0, inserted: 'ab' },
      { fromA: 10, toA: 10, inserted: 'xyz' }
    ]

    const result = applyChangesToSession(session, 100, priorText, 'utf-8', changes)

    expect(requests).toEqual([
      { start: 100, end: 100, text: 'ab' },
      // The second change's absolute start is shifted by the first
      // change's own +2 byte delta, so it lands where "xyz" actually
      // belongs in the buffer *after* "ab" was inserted.
      { start: 112, end: 112, text: 'xyz' }
    ])
    expect(result).toEqual({ ok: true, netByteDelta: 5 })
  })

  it('reports a refusal without applying anything past it', () => {
    const requests: EditRequest[] = []
    const session = fakeSession(requests, 0)
    const changes: RawChange[] = [
      { fromA: 0, toA: 0, inserted: 'x' },
      { fromA: 5, toA: 5, inserted: 'y' }
    ]

    const result = applyChangesToSession(session, 0, '0123456789', 'utf-8', changes)

    expect(result).toEqual({ ok: false, message: 'refused' })
    // Only the refused attempt itself — nothing after it was tried.
    expect(requests).toHaveLength(1)
  })

  it('an empty change list is a no-op success', () => {
    const session = fakeSession([])
    const result = applyChangesToSession(session, 0, '', 'utf-8', [])
    expect(result).toEqual({ ok: true, netByteDelta: 0 })
  })
})
