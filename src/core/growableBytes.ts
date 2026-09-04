/**
 * A growable accumulator over a plain `Uint8Array`, doubling capacity like
 * `rowIndex.ts`'s own `GrowableInt32` — and for the identical reason: a
 * Transform's output (M5-PLAN.md H4/H5) can be document-sized, and a JS
 * `number[]` boxes every pushed byte (8 bytes/slot plus growth churn),
 * which is exactly the anti-pattern that class's own doc comment measured
 * at 2.6x the size of the final result. `pushAscii` is for short, known-
 * ASCII structural text only (indentation, punctuation) — never source
 * content, which invariant 1 requires stay bytes throughout.
 */
export class GrowableBytes {
  private arr: Uint8Array
  private len = 0

  constructor(initialCapacity = 1024) {
    this.arr = new Uint8Array(Math.max(1, initialCapacity))
  }

  get length(): number {
    return this.len
  }

  private ensure(needed: number): void {
    if (needed <= this.arr.length) return
    let capacity = this.arr.length * 2
    while (capacity < needed) capacity *= 2
    const grown = new Uint8Array(capacity)
    grown.set(this.arr.subarray(0, this.len))
    this.arr = grown
  }

  push(byte: number): void {
    this.ensure(this.len + 1)
    this.arr[this.len] = byte
    this.len++
  }

  /** Copies `source[start, end)` verbatim — the only path scalar/string
   * source bytes should ever travel, so a number never round-trips
   * through a JS `number` and a string never round-trips through decode
   * + re-encode. */
  pushBytes(source: Uint8Array, start: number, end: number): void {
    const count = end - start
    this.ensure(this.len + count)
    this.arr.set(source.subarray(start, end), this.len)
    this.len += count
  }

  /** ASCII-only structural text (indentation, punctuation) — never source
   * content. */
  pushAscii(text: string): void {
    this.ensure(this.len + text.length)
    for (let i = 0; i < text.length; i++) {
      this.arr[this.len] = text.charCodeAt(i)
      this.len++
    }
  }

  /** Same `COPY_THRESHOLD` shape as `GrowableInt32.toArray` — a view close
   * to capacity is returned as a `subarray` (no copy), further off it is
   * `slice`d to trim the slack. */
  toArray(): Uint8Array {
    if (this.arr.length - this.len <= this.arr.length * 0.15) {
      return this.arr.subarray(0, this.len)
    }
    return this.arr.slice(0, this.len)
  }
}
