/**
 * The byte ↔ editor-position conversion every Raw View module that crosses
 * the window boundary needs — extracted from `rawEdit.ts` (F9), which had
 * the only correct implementation, so the rest of `Raw/*` stop mixing
 * **absolute byte offsets** (what `NodeStore`/`SourceBuffer`/the row index
 * all speak) with **UTF-16 code-unit positions** (what every CodeMirror
 * `EditorView` position actually is) as if they were the same axis.
 *
 * UI-FEEDBACK.md's M5b entry, "Byte offsets and CodeMirror positions
 * are mixed throughout the Raw view," found four sites doing
 * `windowStart + <CodeMirror position>` or the reverse subtraction — this
 * is invisible on ASCII documents (where the two axes coincide) and wrong
 * everywhere else, with the worst case being `Raw.tsx`'s own scroll
 * recentring silently under-reporting how far into the window the viewport
 * is, which can stop `shouldRecenter` from ever firing again.
 */
import { encodeForRoundTrip } from '../../session/documentEdits'

/**
 * The number of bytes `text.slice(0, localUnits)` occupies once encoded in
 * `encoding`. `encodeForRoundTrip` already knows how to encode UTF-8 and
 * both UTF-16 byte orders; `null` (an encoding it can't represent at all)
 * is unreachable here in practice, since the document that produced `text`
 * already parsed successfully in this same encoding — falling back to the
 * UTF-16 unit count itself rather than throwing, since a slightly-wrong
 * recovery beats a crash on every keystroke/scroll/decoration rebuild.
 */
export function localUnitsToByteOffset(text: string, localUnits: number, encoding: string): number {
  const prefix = text.slice(0, localUnits)
  const encoded = encodeForRoundTrip(prefix, encoding)
  return encoded !== null ? encoded.length : prefix.length
}

function utf8ByteLengthOfCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

/**
 * The inverse of `localUnitsToByteOffset`: how many UTF-16 code units into
 * `text` does `localBytes` bytes (encoded in `encoding`) land — clamped to
 * `text.length` if `localBytes` runs past the end. Walks the string once,
 * code point at a time (so a surrogate pair — 2 units, one code point —
 * advances both counters correctly together), rather than binary-searching
 * with repeated calls to `localUnitsToByteOffset`: that would re-encode an
 * ever-larger prefix on every probe, O(n log n) instead of this function's
 * O(n), and this one is called per on-screen decoration span, potentially
 * several times per scroll frame.
 *
 * UTF-16 (LE/BE) doesn't need the walk at all — every code unit is exactly
 * 2 bytes, always, so the conversion is a division. UTF-8 is the case that
 * actually varies per character. Any other encoding (`encodeForRoundTrip`
 * returns `null` for it) falls back to treating bytes as units directly —
 * the same "slightly wrong beats a crash" fallback `localUnitsToByteOffset`
 * takes, and such a document is already read-only in practice per
 * `documentEdits.ts`'s own comment.
 */
export function byteOffsetToLocalUnits(text: string, localBytes: number, encoding: string): number {
  if (localBytes <= 0) return 0
  const enc = encoding.toLowerCase()
  if (enc === 'utf-16le' || enc === 'utf-16be') {
    return Math.min(text.length, Math.floor(localBytes / 2))
  }
  if (enc !== 'utf-8') return Math.min(text.length, localBytes)

  let bytes = 0
  let units = 0
  while (units < text.length) {
    const codePoint = text.codePointAt(units)!
    const charBytes = utf8ByteLengthOfCodePoint(codePoint)
    if (bytes + charBytes > localBytes) break
    bytes += charBytes
    units += codePoint > 0xffff ? 2 : 1
  }
  return units
}
