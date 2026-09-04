/**
 * M5c-PLAN.md J9's own regression guard: "a test that asserts the
 * *number* of `localUnitsToByteOffset`/`byteOffsetToLocalUnits` calls a
 * decoration rebuild makes is O(1) in the mark count — a counting spy, not
 * a timing assertion."
 *
 * `buildDecorationSet` itself can't be exercised directly here — it needs a
 * real `EditorView`, and this project has no DOM/browser test environment
 * (`rawEdit.ts`'s own top comment). What *can* be tested directly, and is
 * the actual place the O(window) cost lived and was fixed (J1), is
 * `rawOffsetMap.ts`'s checkpoint walk: before the fix, converting a mark
 * near the end of a 1 MB window walked every code point from position 0;
 * after it, a walk is bounded by `CHECKPOINT_STRIDE` regardless of where in
 * the window the mark sits. Counting `String.prototype.codePointAt` calls
 * per conversion is the same "counting spy, not a timing assertion" shape
 * the plan asks for, aimed at the primitive the bug actually lived in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildOffsetMap } from '../src/renderer/components/Raw/rawOffsetMap'

let codePointAtCalls = 0
let originalCodePointAt: (this: string, index: number) => number | undefined

beforeEach(() => {
  codePointAtCalls = 0
  originalCodePointAt = String.prototype.codePointAt
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkey-patching a built-in for a call-count spy, restored in afterEach
  ;(String.prototype as any).codePointAt = function (index: number) {
    codePointAtCalls++
    return originalCodePointAt.call(this, index)
  }
})

afterEach(() => {
  String.prototype.codePointAt = originalCodePointAt
})

/** Mixed ASCII/non-ASCII content, long enough to span many checkpoints —
 * the checkpoint-walk path (`buildOffsetMap`'s "everything else" case) is
 * exactly what J1 added; a pure-ASCII fixture would take the identity
 * fast path instead and prove nothing about the walk bound. */
function buildFixture(bytes: number): string {
  const unit = 'café straße 你好 münchen \u{1f600} plain ascii text here, too '
  return unit.repeat(Math.ceil(bytes / unit.length))
}

describe('rawOffsetMap checkpoint walk — J1 regression guard', () => {
  it('toBytes/toUnits at 90% into a ~1MB window do O(checkpoint-stride) work, not O(window)', () => {
    const text = buildFixture(1024 * 1024)
    const map = buildOffsetMap(text, 'utf-8')
    expect(map.ascii).toBe(false) // must exercise the checkpoint path, not the identity fast path

    const deepUnits = Math.floor(text.length * 0.9)
    const deepBytes = map.toBytes(deepUnits)

    codePointAtCalls = 0
    map.toBytes(deepUnits)
    // Bounded by one checkpoint stride's worth of code points, not by how
    // far `deepUnits` is into the document — before J1, this scaled with
    // position (up to the full window, one `codePointAt` per code point
    // from position 0).
    expect(codePointAtCalls).toBeLessThan(2000)

    codePointAtCalls = 0
    map.toUnits(deepBytes)
    expect(codePointAtCalls).toBeLessThan(2000)
  })

  it('the call count at 10% and at 90% into the window are the same order of magnitude', () => {
    // The defining symptom of the pre-J1 bug (§1.1's own table): cost grew
    // with depth into the window (313ms at 10% vs 2479ms at 90%). A bounded
    // walk shouldn't show that shape at all.
    const text = buildFixture(1024 * 1024)
    const map = buildOffsetMap(text, 'utf-8')

    const shallowUnits = Math.floor(text.length * 0.1)
    const deepUnits = Math.floor(text.length * 0.9)

    codePointAtCalls = 0
    map.toBytes(shallowUnits)
    const shallowCalls = codePointAtCalls

    codePointAtCalls = 0
    map.toBytes(deepUnits)
    const deepCalls = codePointAtCalls

    // Same order of magnitude — not the roughly 8x growth (313ms -> 2479ms)
    // §1.1 measured between these two depths pre-fix.
    expect(deepCalls).toBeLessThan(shallowCalls * 3 + 100)
  })

  it('100 conversions scattered across the window do not each re-walk from 0 — total work is roughly linear in call count, not in position', () => {
    const text = buildFixture(1024 * 1024)
    const map = buildOffsetMap(text, 'utf-8')

    codePointAtCalls = 0
    for (let i = 0; i < 100; i++) {
      const units = Math.floor((text.length * i) / 100)
      map.toBytes(units)
    }
    // Each of the 100 calls is bounded by one checkpoint stride — a
    // per-mark O(window) cost (the actual pre-J1 bug, ~240 marks × up to
    // the full window each) would blow this bound by orders of magnitude.
    expect(codePointAtCalls).toBeLessThan(100 * 2000)
  })
})
