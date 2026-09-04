/**
 * XPath 1.0's `number()` conversion, read straight out of the document's
 * bytes (R129, `docs/plans/R129-query-predicates.md` §4 and §9).
 *
 * **This is deliberately not `Number()`.** XPath 1.0's lexical form is
 *
 * ```
 * -? digits ('.' digits?)?  |  -? '.' digits
 * ```
 *
 * with leading/trailing whitespace allowed and *nothing else*. Five of the
 * nine cases §4 tabulates diverge from JavaScript: `1e3`, `0x10`, `""`,
 * `+5` and `Infinity` are all **NaN** here and all finite under `Number()`.
 * `test/xpathNumber.test.ts` asserts that table case by case, so the
 * divergence cannot be "fixed" by someone who reads it as a bug — it is
 * what every other XPath engine answers, and the later XPath work has to
 * agree with this module or the two query languages drift.
 *
 * **It never builds a string**, not even on the failure path. §2 measured
 * decode-then-`Number()` at 155.3 ms against 15.5 ms for reading the digits
 * out of the byte range, over the same 400,000 values — the 22× is entirely
 * string allocation, so a "fall back to `slice()` when the fast scan gives
 * up" shape would hand all of it straight back.
 *
 * **Encodings.** Digits, `-`, `.` and the four XPath whitespace characters
 * sit at their ASCII code points in every encoding this app parses except
 * UTF-16, which interleaves a zero byte. That is the whole of
 * `NumberByteLayout`: stride 1 for everything ASCII-transparent (UTF-8, the
 * single-byte code pages, and the ASCII-transparent multi-byte pages), and
 * stride 2 with the significant byte first (LE) or second (BE) for UTF-16.
 * A UTF-16 unit whose *other* byte is non-zero is not an ASCII character at
 * all, and reads as "not a digit" rather than as a truncated one.
 */

/** How one character sits in the byte range — see the module header. */
export interface NumberByteLayout {
  /** Bytes per character: 1 for ASCII-transparent encodings, 2 for UTF-16. */
  readonly stride: number
  /** Index of the ASCII-valued byte within a unit (0 for LE, 1 for BE). */
  readonly offset: number
}

/** The layout for every ASCII-transparent encoding — the default. */
export const ASCII_LAYOUT: NumberByteLayout = { stride: 1, offset: 0 }

const UTF16LE_LAYOUT: NumberByteLayout = { stride: 2, offset: 0 }
const UTF16BE_LAYOUT: NumberByteLayout = { stride: 2, offset: 1 }

/** Chosen once per query from `SourceBuffer.encoding`, never per value. */
export function numberByteLayout(encoding: string): NumberByteLayout {
  const normalized = encoding.toLowerCase()
  if (normalized === 'utf-16le') return UTF16LE_LAYOUT
  if (normalized === 'utf-16be') return UTF16BE_LAYOUT
  return ASCII_LAYOUT
}

const CH_TAB = 0x09
const CH_LF = 0x0a
const CH_CR = 0x0d
const CH_SPACE = 0x20
const CH_MINUS = 0x2d
const CH_DOT = 0x2e
const CH_ZERO = 0x30
const CH_NINE = 0x39

/** Past the end, or a UTF-16 unit that isn't an ASCII character, reads as
 * `-1` — a value that matches no branch below, so both cases fall out as
 * "not a digit" without a separate flag. A module-level function taking
 * every operand rather than a closure over them: this is called once per
 * character of every candidate's value, and a closure would be an
 * allocation per candidate (§9's own rule). */
function codeAt(
  bytes: Uint8Array,
  i: number,
  end: number,
  stride: number,
  offset: number,
  other: number
): number {
  if (i + stride > end) return -1
  if (stride === 2 && bytes[i + other] !== 0) return -1
  return bytes[i + offset]!
}

function isSpace(code: number): boolean {
  return code === CH_SPACE || code === CH_TAB || code === CH_CR || code === CH_LF
}

/** Exactly representable as doubles, and the largest such table — beyond
 * `1e22` a power of ten is itself rounded, so scaling by one stops being
 * correctly-rounded. A `Float64Array` rather than a plain array: element
 * reads need no element-kind check. */
const POW10 = new Float64Array([
  1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17,
  1e18, 1e19, 1e20, 1e21, 1e22
])
const MAX_EXACT_POW10 = POW10.length - 1

/** 10^15 fits in a double's 53-bit integer range with room to spare, so a
 * mantissa of at most this many digits is accumulated exactly. Digits past
 * it are counted into the exponent and dropped (truncated toward zero)
 * rather than accumulated into a mantissa that has already lost its low
 * bits — see `xpathNumberFromBytes`'s own note on the residual. */
const MAX_MANTISSA_DIGITS = 15

/** Scales an accumulated mantissa by a power of ten — called once per
 * value, never per character. */
function assemble(mantissa: number, exponent: number, negative: boolean): number {
  let value: number
  if (exponent === 0) {
    value = mantissa
  } else if (exponent > 0) {
    value =
      exponent <= MAX_EXACT_POW10 ? mantissa * POW10[exponent]! : mantissa * Math.pow(10, exponent)
  } else {
    value =
      -exponent <= MAX_EXACT_POW10
        ? mantissa / POW10[-exponent]!
        : mantissa * Math.pow(10, exponent)
  }
  return negative ? -value : value
}

/**
 * XPath 1.0 `number()` over `bytes[start, end)`, or `NaN` if the range is
 * not exactly one XPath number (with optional surrounding whitespace).
 *
 * **Precision.** Values with at most 15 significant digits and a decimal
 * exponent within ±22 — every number any real document holds — are computed
 * as one exactly-representable multiply or divide and are therefore
 * correctly rounded, identical to `parseFloat`. Beyond that the result may
 * differ from `parseFloat` by an ulp or so, because the excess digits are
 * truncated rather than fed through a big-integer rounding path. Recorded
 * rather than hidden: the alternative is either a decimal-string round trip
 * (which §9 forbids for a 22× reason) or a full Grisu/Ryu inverse, which is
 * a great deal of code for the last bit of a 16-digit measurement.
 *
 * **Two implementations, one grammar.** The ASCII case is written out with
 * direct `bytes[i]` reads rather than driven through `codeAt`'s
 * stride/offset indirection: measured on the 400,000-value corpus, sharing
 * one generic scanner cost **25.5 ms** against **7.6 ms** for the
 * specialised one — 3× on the single function this milestone exists to make
 * fast. The wide (UTF-16) path keeps the general scanner, where the
 * indirection is unavoidable anyway and no corpus is 400,000 values deep.
 */
export function xpathNumberFromBytes(
  bytes: Uint8Array,
  start: number,
  end: number,
  layout: NumberByteLayout
): number {
  return layout.stride === 1
    ? xpathNumberAscii(bytes, start, end)
    : xpathNumberWide(bytes, start, end, layout.offset)
}

/** The hot path — see `xpathNumberFromBytes`'s note. `end` is clamped by
 * the loop conditions, so an out-of-range read is impossible without a
 * per-character bounds helper.
 *
 * Exported so a caller that has already established the encoding is
 * ASCII-transparent (a predicate does, once per query) can call it
 * directly rather than paying `xpathNumberFromBytes`'s dispatch per
 * value. */
export function xpathNumberAscii(bytes: Uint8Array, start: number, end: number): number {
  let i = start
  while (i < end) {
    const code = bytes[i]!
    if (code !== CH_SPACE && code !== CH_TAB && code !== CH_CR && code !== CH_LF) break
    i++
  }

  let negative = false
  if (i < end && bytes[i] === CH_MINUS) {
    negative = true
    i++
  }

  let mantissa = 0
  let mantissaDigits = 0
  let exponent = 0
  let sawDigit = false

  while (i < end) {
    const digit = bytes[i]! - CH_ZERO
    if (digit < 0 || digit > 9) break
    sawDigit = true
    if (mantissaDigits < MAX_MANTISSA_DIGITS) {
      mantissa = mantissa * 10 + digit
      // Leading zeros are not significant digits: until the mantissa is
      // non-zero this stays 0, so "0000000000000000.5" is still exact.
      if (mantissa !== 0) mantissaDigits++
    } else {
      exponent++
    }
    i++
  }

  if (i < end && bytes[i] === CH_DOT) {
    i++
    while (i < end) {
      const digit = bytes[i]! - CH_ZERO
      if (digit < 0 || digit > 9) break
      sawDigit = true
      if (mantissaDigits < MAX_MANTISSA_DIGITS) {
        mantissa = mantissa * 10 + digit
        if (mantissa !== 0) mantissaDigits++
        exponent--
      }
      i++
    }
  }

  // `1.` and `.5` are both in the grammar; a bare `.`, a bare `-`, and an
  // empty range are not.
  if (!sawDigit) return NaN

  while (i < end) {
    const code = bytes[i]!
    if (code !== CH_SPACE && code !== CH_TAB && code !== CH_CR && code !== CH_LF) break
    i++
  }

  // Anything left is trailing junk (`12abc`), and makes the range not a
  // number rather than a prefix of one.
  if (i < end) return NaN

  return assemble(mantissa, exponent, negative)
}

/** UTF-16, where one character is two bytes and the ASCII value sits in
 * one of them. Same grammar, driven through `codeAt`. */
function xpathNumberWide(bytes: Uint8Array, start: number, end: number, offset: number): number {
  const stride = 2
  const other = 1 - offset

  let i = start
  let code = codeAt(bytes, i, end, stride, offset, other)

  while (isSpace(code)) {
    i += stride
    code = codeAt(bytes, i, end, stride, offset, other)
  }

  let negative = false
  if (code === CH_MINUS) {
    negative = true
    i += stride
    code = codeAt(bytes, i, end, stride, offset, other)
  }

  let mantissa = 0
  let mantissaDigits = 0
  let exponent = 0
  let sawDigit = false

  while (code >= CH_ZERO && code <= CH_NINE) {
    sawDigit = true
    if (mantissaDigits < MAX_MANTISSA_DIGITS) {
      mantissa = mantissa * 10 + (code - CH_ZERO)
      if (mantissa !== 0) mantissaDigits++
    } else {
      exponent++
    }
    i += stride
    code = codeAt(bytes, i, end, stride, offset, other)
  }

  if (code === CH_DOT) {
    i += stride
    code = codeAt(bytes, i, end, stride, offset, other)
    while (code >= CH_ZERO && code <= CH_NINE) {
      sawDigit = true
      if (mantissaDigits < MAX_MANTISSA_DIGITS) {
        mantissa = mantissa * 10 + (code - CH_ZERO)
        if (mantissa !== 0) mantissaDigits++
        exponent--
      }
      i += stride
      code = codeAt(bytes, i, end, stride, offset, other)
    }
  }

  if (!sawDigit) return NaN

  while (isSpace(code)) {
    i += stride
    code = codeAt(bytes, i, end, stride, offset, other)
  }

  // Trailing junk, a non-ASCII unit, or a dangling odd byte all land here.
  if (i < end) return NaN

  return assemble(mantissa, exponent, negative)
}

const utf8 = new TextEncoder()

/**
 * The same conversion for a JS string — used **once per query**, on the
 * literal the user typed, never on document content. UTF-8 is
 * ASCII-transparent, so any non-ASCII character in the literal encodes to a
 * byte above `0x7f` and correctly reads as "not a digit."
 */
export function xpathNumberFromText(text: string): number {
  const bytes = utf8.encode(text)
  return xpathNumberFromBytes(bytes, 0, bytes.length, ASCII_LAYOUT)
}

/** `bytes[start, end)` against a needle, byte for byte — §9's "never decode
 * a value to compare it," and the reason the needle is encoded once per
 * query in the document's own encoding rather than per candidate. */
export function bytesEqual(
  bytes: Uint8Array,
  start: number,
  end: number,
  needle: Uint8Array
): boolean {
  if (end - start !== needle.length) return false
  for (let i = 0; i < needle.length; i++) {
    if (bytes[start + i] !== needle[i]) return false
  }
  return true
}
