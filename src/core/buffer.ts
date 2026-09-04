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

export class SourceBuffer {
  readonly bytes: Uint8Array
  readonly encoding: string
  readonly bomLength: number

  private readonly decoder: TextDecoder

  constructor(bytes: Uint8Array, encoding: string, bomLength: number) {
    this.bytes = bytes
    this.encoding = encoding
    this.bomLength = bomLength
    this.decoder = new TextDecoder(encoding)
  }

  get byteLength(): number {
    return this.bytes.length
  }

  slice(start: number, end: number): string {
    return this.decoder.decode(this.bytes.subarray(start, end))
  }

  snapToCharBoundary(offset: number): number {
    return snapToCharBoundary(this.bytes, offset)
  }
}
