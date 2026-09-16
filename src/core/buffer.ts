/**
 * SourceBuffer wraps the document's raw bytes. `slice` decodes only the
 * requested range — invariant 1 (never convert the whole source to a JS
 * string) applies here as much as anywhere.
 */

const CONTINUATION_MASK = 0xc0
const CONTINUATION_TAG = 0x80

/**
 * Advances `offset` past any UTF-8 continuation bytes (`0b10xxxxxx`) so a
 * slice never starts mid-character. `offset` is floored first: a fractional
 * offset indexes `bytes` as `undefined`, and `undefined & 0xc0` is `0`, which
 * passes the continuation check silently and produces a boundary that looks
 * valid but isn't — this cost the M0a spike a debugging session.
 */
export function snapToCharBoundary(bytes: Uint8Array, offset: number): number {
  let i = Math.floor(offset)
  if (import.meta.env?.DEV && !Number.isInteger(offset)) {
    throw new Error(`snapToCharBoundary: non-integer offset ${offset}`)
  }
  while (i < bytes.length && (bytes[i]! & CONTINUATION_MASK) === CONTINUATION_TAG) {
    i++
  }
  return i
}

/**
 * R214 (`docs/plans/R214-filter-pass.md` § 0): slices up to this many bytes
 * that are all ASCII are built without `TextDecoder`. Measured in the
 * application's renderer, four million small decodes cost **1,647 ms** through
 * `TextDecoder.decode` and **287 ms** as a character loop (Node: 908 ms against
 * 370 ms) — the binding's per-call cost dominates when the slice is a cell
 * value of a dozen bytes, and the grid's filter pass and sort make millions of
 * them. Longer slices go to the decoder, which wins once the loop's string
 * building does.
 */
const ASCII_FAST_PATH_MAX_BYTES = 128

/**
 * Encodings in which every byte below 0x80 is that ASCII character on its own,
 * wherever it appears — the condition for building a slice without the decoder.
 * Not the stateful or multi-byte legacy encodings: ISO-2022-JP's escape
 * sequences are ASCII bytes, and a Shift_JIS trail byte can be one. Names are
 * `TextDecoder.encoding`'s normalized WHATWG labels.
 */
function asciiIsLiteralIn(encoding: string): boolean {
  return encoding === 'utf-8' || encoding.startsWith('windows-') || encoding.startsWith('iso-8859-')
}

export class SourceBuffer {
  readonly bytes: Uint8Array
  readonly encoding: string
  readonly bomLength: number

  private readonly decoder: TextDecoder
  private readonly asciiFastPath: boolean

  constructor(bytes: Uint8Array, encoding: string, bomLength: number) {
    this.bytes = bytes
    this.encoding = encoding
    this.bomLength = bomLength
    this.decoder = new TextDecoder(encoding)
    this.asciiFastPath = asciiIsLiteralIn(this.decoder.encoding)
  }

  get byteLength(): number {
    return this.bytes.length
  }

  slice(start: number, end: number): string {
    // Only an ordinary integer range: `subarray` reads a negative bound as
    // counting from the end and truncates a fractional one, neither of which the
    // loop reproduces, so those go to the decoder exactly as before.
    if (
      this.asciiFastPath &&
      (start | 0) === start &&
      (end | 0) === end &&
      start >= 0 &&
      end >= start &&
      end - start <= ASCII_FAST_PATH_MAX_BYTES
    ) {
      const bytes = this.bytes
      // `subarray` clamps a past-the-end bound; the loop has to do the same, or
      // it reads `undefined` and appends U+0000.
      const stop = Math.min(end, bytes.length)
      let text = ''
      let i = start
      for (; i < stop; i++) {
        const byte = bytes[i]!
        if (byte > 0x7f) break
        text += String.fromCharCode(byte)
      }
      if (i >= stop) return text
    }
    return this.decoder.decode(this.bytes.subarray(start, end))
  }

  snapToCharBoundary(offset: number): number {
    return snapToCharBoundary(this.bytes, offset)
  }
}
