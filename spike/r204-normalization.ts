#!/usr/bin/env -S npx tsx
/**
 * R204's own measurement: what NFC normalization costs the decoded find path,
 * per ~64 KB window.
 *
 * Usage: npx tsx spike/r204-normalization.ts
 *
 * `docs/plans/R202-unicode-comparison.md` § 8 planned against numbers taken
 * from a throwaway script; this is the same measurement against the code that
 * actually shipped, kept because R205 and any later change to
 * `normalizeWindowForSearch`'s boundary rule needs to re-run it. The plan's
 * own § 9 rejects `Intl.Segmenter` on these numbers, so a future round
 * proposing it should have to beat them rather than re-derive them.
 *
 * Three inputs, because the cost is entirely a property of the content:
 *
 *  1. **all ASCII** — the gate answers immediately and no map is built. This
 *     is what a 200 MB log or CSV costs, and it must stay near zero.
 *  2. **mostly ASCII, some NFD** — realistic mixed content.
 *  3. **100% NFD** — the worst case, and the one `Intl.Segmenter` was
 *     measured at 13.957 ms on.
 *
 * Not wired into `npm test` — a measurement script, same convention as
 * `spike/m2-e10-measure.ts` and `spike/r210-grid-models.ts`.
 */
import { DECODED_WINDOW_BYTES, normalizeWindowForSearch } from '../src/core/textFind'

const TARGET = DECODED_WINDOW_BYTES

function windowOf(unit: string): string {
  const reps = Math.ceil(TARGET / new TextEncoder().encode(unit).length)
  return unit.repeat(reps).slice(0, TARGET)
}

const ALL_ASCII = windowOf('the quick brown fox jumps over the lazy dog. ')
const MIXED = windowOf('the quick brown cafe\u0301 jumps over the lazy dog. ')
const ALL_NFD = windowOf('cafe\u0301 nai\u0308ve re\u0301sume\u0301 ')

function ms(fn: () => unknown, runs: number): number {
  const t = performance.now()
  for (let i = 0; i < runs; i++) fn()
  return (performance.now() - t) / runs
}

console.log(`\nper ${(TARGET / 1024).toFixed(0)} KB window, UTF-16 length ${ALL_ASCII.length}`)
console.log('input                        gate      full build   index')

for (const [label, text, runs] of [
  ['all ASCII', ALL_ASCII, 200],
  ['mostly ASCII, some NFD', MIXED, 100],
  ['100% NFD', ALL_NFD, 20]
] as const) {
  // The gate on its own — `text.normalize('NFC') === text`, which is what
  // decides whether any map is built at all.
  const gate = ms(() => text.normalize('NFC') === text, runs)
  const full = ms(() => normalizeWindowForSearch(text), runs)
  const built = normalizeWindowForSearch(text)
  if (built.text !== text.normalize('NFC')) throw new Error(`${label}: piecewise NFC disagreed`)
  console.log(
    label.padEnd(29) +
      `${gate.toFixed(3)} ms`.padEnd(10) +
      `${full.toFixed(3)} ms`.padEnd(13) +
      (built.segments === null
        ? 'none'
        : `${built.segments.outStarts.length} runs, ${((built.segments.outStarts.byteLength * 2) / 1024).toFixed(0)} KB`)
  )
}
