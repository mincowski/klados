/**
 * The inverse of `TextDecoder` — which has no encoding parameter beyond
 * `'utf-8'` by spec — needed so a query string typed by the user (a JS
 * string, always UTF-16 internally) can be compared against name bytes
 * stored in a **non-UTF-8 document's own encoding** (invariant 7: save
 * preserves the original encoding, so nothing upstream ever transcodes a
 * document to UTF-8) without decoding those stored bytes back to a JS
 * string first (`interner.ts`'s own header: hash-collision comparison is
 * on raw bytes, never on decoded text). R53, `R53-interner-encoding.md`.
 *
 * No new dependency: UTF-8 uses the platform's own `TextEncoder`; UTF-16
 * is a direct code-unit write since a JS string already *is* UTF-16.
 * Every other encoding this project actually sees declared (`windows-1252`,
 * `iso-8859-1`, …) is a single-byte code page, handled by probing
 * `TextDecoder` with that label across all 256 byte values once and
 * inverting the resulting map — genuinely multi-byte, non-UTF encodings
 * (e.g. Shift-JIS) aren't representable this way and correctly fall
 * through to `null`, the same "unrepresentable" answer a real character
 * gap produces.
 */

const utf8Encoder = new TextEncoder()

/** Cached per encoding label: `null` means "not a single-byte code page
 * this approach can invert" (checked once, remembered). */
const singleByteReverseMaps = new Map<string, ReadonlyMap<number, number> | null>()

function singleByteReverseMap(encoding: string): ReadonlyMap<number, number> | null {
  const cached = singleByteReverseMaps.get(encoding)
  if (cached !== undefined) return cached

  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(encoding)
  } catch {
    singleByteReverseMaps.set(encoding, null)
    return null
  }

  const probe = new Uint8Array(256)
  for (let i = 0; i < 256; i++) probe[i] = i
  const decoded = decoder.decode(probe)
  // A genuine single-byte code page decodes 256 bytes to exactly 256 code
  // points, one per byte. Anything else — a multi-byte encoding, or UTF-8/
  // UTF-16 (already handled before this function is ever reached) — fails
  // this shape check and is reported as not invertible this way.
  if (decoded.length !== 256) {
    singleByteReverseMaps.set(encoding, null)
    return null
  }

  const map = new Map<number, number>()
  for (let byte = 0; byte < 256; byte++) {
    const codePoint = decoded.codePointAt(byte)!
    // Keep the first byte producing a given code point. Most single-byte
    // pages are already one-to-one; this only matters for a code point an
    // unmapped byte decodes to (typically U+FFFD, the replacement
    // character) sharing a slot with whatever byte legitimately produces
    // it — first-wins keeps that legitimate mapping.
    if (!map.has(codePoint)) map.set(codePoint, byte)
  }
  singleByteReverseMaps.set(encoding, map)
  return map
}

/**
 * Whether `encoding` can be written at all, independent of any particular
 * text — false only for a genuinely multi-byte non-UTF encoding (e.g.
 * `shift_jis`), never for a single-byte code page that merely lacks a given
 * character (that is `encodeText` returning `null` for a specific string, a
 * different question — R125, `R125-legacy-encoding-edits.md` §3). Reuses
 * `singleByteReverseMap`'s own memoized probe rather than calling
 * `encodeText('', encoding)` and checking for `null`, which would give the
 * right answer today only by accident of the empty string never exercising
 * the reverse-map lookup.
 */
export function canEncode(encoding: string): boolean {
  const normalized = encoding.toLowerCase()
  if (normalized === 'utf-8' || normalized === 'utf8') return true
  if (normalized === 'utf-16le' || normalized === 'utf-16be') return true
  return singleByteReverseMap(encoding) !== null
}

/**
 * Encodes `text` as `encoding` would produce it, or `null` if `encoding`
 * can't represent every character in `text` (a genuine gap — e.g. `日本語`
 * against `windows-1252` — not an error to throw on, since a caller like
 * `Interner.lookup` needs to tell this apart from "not interned").
 */
export function encodeText(text: string, encoding: string): Uint8Array | null {
  const normalized = encoding.toLowerCase()

  if (normalized === 'utf-8' || normalized === 'utf8') {
    return utf8Encoder.encode(text)
  }

  if (normalized === 'utf-16le' || normalized === 'utf-16be') {
    // A JS string is already a sequence of UTF-16 code units — this is a
    // direct byte-order write, not a re-encoding, so every character is
    // representable (surrogate pairs included, as two code units each).
    const bytes = new Uint8Array(text.length * 2)
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (normalized === 'utf-16le') {
        bytes[i * 2] = code & 0xff
        bytes[i * 2 + 1] = (code >> 8) & 0xff
      } else {
        bytes[i * 2] = (code >> 8) & 0xff
        bytes[i * 2 + 1] = code & 0xff
      }
    }
    return bytes
  }

  const reverseMap = singleByteReverseMap(encoding)
  if (reverseMap === null) return null

  const bytes: number[] = []
  // Iterated by code point (`for...of` on a string), not by UTF-16 code
  // unit — a single-byte page has no representation above U+00FF, so a
  // surrogate pair (anything outside the BMP) correctly fails the lookup
  // below and returns `null`, rather than being split into two lookups
  // that could coincidentally both succeed against unrelated bytes.
  for (const ch of text) {
    const byte = reverseMap.get(ch.codePointAt(0)!)
    if (byte === undefined) return null
    bytes.push(byte)
  }
  return Uint8Array.from(bytes)
}

/**
 * The character responsible for `encodeText(text, encoding)` returning
 * `null`, for a caller that already knows `canEncode(encoding)` is `true`
 * (R125 §3) — the first code point in `text` missing from `encoding`'s own
 * reverse map, so a refusal message can name it rather than just say
 * "unrepresentable." Only meaningful, and only ever called, on the refusal
 * path — never in a loop over matches (`textEncode.ts`'s own memoized
 * `singleByteReverseMap` already amortizes the 256-byte probe; this walk
 * over `text` is the part that is not free). Returns `null` if `encoding`
 * is UTF-8/UTF-16 (always representable) or if `text` turns out to be fully
 * representable after all.
 */
export function findUnrepresentableCharacter(text: string, encoding: string): string | null {
  const normalized = encoding.toLowerCase()
  if (
    normalized === 'utf-8' ||
    normalized === 'utf8' ||
    normalized === 'utf-16le' ||
    normalized === 'utf-16be'
  ) {
    return null
  }
  const reverseMap = singleByteReverseMap(encoding)
  if (reverseMap === null) return null
  for (const ch of text) {
    if (!reverseMap.has(ch.codePointAt(0)!)) return ch
  }
  return null
}
