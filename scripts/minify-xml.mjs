/**
 * Produces an unformatted XML fixture from a formatted one, so pretty-print
 * has something to actually do (M5g-PLAN.md §3.2 — every existing
 * `cars-*.xml` is already formatted exactly the way the formatter formats,
 * which is why R13's no-op finding went unnoticed until it was measured).
 *
 * Byte-level and deliberately conservative: it removes a text run only when
 * that run sits between `>` and `<` and is **entirely** whitespace. A run
 * containing any non-whitespace is left completely untouched, so element
 * text (`<name>Golf</name>`) and mixed content (`<p>Hello <b>x</b>!</p>`)
 * both survive byte-identical. It is not a general XML minifier — it does
 * not know about `xml:space="preserve"`, so do not point it at a document
 * that uses it.
 *
 *   node scripts/minify-xml.mjs spike/fixtures/cars-10mb.xml
 *   node scripts/minify-xml.mjs <in> <out>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const GT = 0x3e // >
const LT = 0x3c // <

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- plain .mjs; there is no type syntax to annotate with here
function isSpace(b) {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d
}

const input = process.argv[2]
if (input === undefined) {
  console.error('usage: node scripts/minify-xml.mjs <in.xml> [out.xml]')
  process.exit(1)
}
const output = process.argv[3] ?? input.replace(/\.xml$/, '.min.xml')

const src = new Uint8Array(readFileSync(input))
const out = new Uint8Array(src.length)
let w = 0
let removedRuns = 0

for (let i = 0; i < src.length; i++) {
  out[w++] = src[i]
  if (src[i] !== GT) continue

  // Look ahead over a whitespace run; drop it only if the very next
  // non-whitespace byte starts a tag. Anything else is real content.
  let j = i + 1
  while (j < src.length && isSpace(src[j])) j++
  if (j > i + 1 && j < src.length && src[j] === LT) {
    i = j - 1 // skip the run; the loop's own i++ lands on `<`
    removedRuns++
  }
}

const result = out.subarray(0, w)
writeFileSync(output, result)

const pct = ((1 - result.length / src.length) * 100).toFixed(1)
console.log(`${input}  ${src.length.toLocaleString()} bytes`)
console.log(`${output}  ${result.length.toLocaleString()} bytes  (-${pct}%)`)
console.log(`whitespace runs removed: ${removedRuns.toLocaleString()}`)
