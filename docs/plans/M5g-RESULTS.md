# M5g — Results

Task **R13**. Plan: `docs/plans/M5g-PLAN.md`. All numbers below are `npm run bench:format`
(`src/cli/bench-format.ts`, §3.1), one fixture per process invocation for a clean peak-RSS
reading, on this machine, 10 MB fixtures unless noted. `npm test` (946 tests, node project) and
`npx vitest run --project browser` (11 tests) both pass after every optimization below.

---

## O0 — `shouldRecenter` must not fire against a clamped window

Done. `shouldRecenter` (`src/renderer/components/Raw/rawWindow.ts`) takes a `byteLength`
parameter now: a window whose `start` is already 0 cannot recentre backwards, and one whose `end`
is already `byteLength` cannot recentre forwards, regardless of `margin`. Four boundary cases
added to `test/rawWindow.test.ts` (window at document start, mid-document, at document end,
degenerate). Not a Transform-specific fix — it removes a per-scroll-event no-op re-slice from the
first and last 20% of every document ever opened, not just after a Format.

## O1 — skip the pipeline on a no-op format()

Done, and moved further than the plan's own first draft after mid-task feedback: the
byte-identical check runs **in the worker** (`runTransformJob`, `src/worker/parse.worker.ts`),
not the renderer. The worker already holds both the input and `format()`'s output — comparing
there means a no-op never transfers the (possibly hundreds-of-MB) result back at all, where the
first version of this fix would still have paid that transfer only to compare and discard it
renderer-side. `TransformDoneMessage` gained an `unchanged: boolean` field; `bytes` is `null` iff
`unchanged`. The comparison itself is a `BigUint64Array` word compare (8 bytes/iteration) with a
byte-wise tail for `length % 8`, covered at every remainder 0–7 in `test/parseWorker.test.ts`.

`applyTransform` (`src/renderer/session/documentSession.ts`) treats a `null` result as "nothing to
do": no buffer swap, no reparse, no undo entry, no dirty flag. A new `lastTransformWasNoOp` field
on `OpenDocument` drives an alert-strip message ("Already formatted — no changes made."),
cleared on the next edit or Transform. Regression guard:
`test/documentSession.test.ts`'s "a no-op Format does not touch the buffer, dirty flag, undo
stack, or trigger a reparse" — asserts the reparse never ran (a parse-call counter stays at 0),
not just that the bytes look unchanged.

## 3.1–3.3 — bench harness and fixtures

`npm run bench:format -- <file> [<file>...]` (`src/cli/bench-format.ts`) reports `format()` time
and throughput, each reparse stage, total, peak RSS, and whether the output was byte-identical —
following `inspect.ts`'s CLI shape and `spike/m5-bench.ts`'s per-stage RSS convention.
`npm run fixtures:generate` wraps `spike/generate-fixtures.ts` (`node`, not `tsx` — the file uses
top-level `await`, which `tsx`'s default CJS transform rejects; plain `node`'s native TS stripping
handles it directly, with a one-time `MODULE_TYPELESS_PACKAGE_JSON` warning that's cosmetic).

Four new fixtures, per §3.2: `mixed-10mb.xml`, `preserve-10mb.xml`, `nonascii-10mb.xml`,
`deep-10mb.xml`. Building `nonascii-10mb.xml` found a real bug in the generator: `ChunkWriter`'s
shared `write()` path encodes as `latin1` by design (the file's own doc comment: "Output is
deliberately pure ASCII"), so the emoji/CJK/accented-Latin content this fixture needs was silently
truncated to garbage bytes. Fixed with a `writeUtf8()` path that flushes the latin1 buffer first,
then writes real UTF-8 bytes directly. All four fixtures round-trip through `format()` cleanly
after the fix, and the existing `test/xmlFormat.test.ts` invariant suite (unmodified) still passes
against real non-ASCII content it never previously fixture-tested.

> **Correction (review).** This section originally continued "malformed enough that the
> formatter's `formatElement`/`emitChild` mutual recursion overflowed the stack trying to parse
> it… **Confirmed not an app bug**." The generator bug was real and is fixed, but **the stack
> overflow was a second, independent defect and that conclusion was wrong.** It reproduces on
> perfectly well-formed input: `<a>` nested 5 000 deep parses `complete` (well inside
> `DEFAULT_MAX_DEPTH = 10_000`) and `format()` throws `RangeError: Maximum call stack size
> exceeded`. `emitChild`/`formatElement` are recursive descent over user input with no depth
> bound of their own, and pass 1 runs with `maxDepth: 100_000` — ten times the real parse limit —
> so it will happily build a table for depths the emitter cannot walk. That breaks **invariant 4**
> ("parsers are iterative, never recursive descent — deeply nested input is real input and will
> overflow the stack") and the intent of **invariant 5** ("never throw on malformed input").
> There is no `try`/`catch` around `runTransformJob`, so it escapes via `worker.onerror` as a
> generic error: a document NodePad opens and displays fine simply cannot be formatted. Tracked
> as **R18** (`docs/plans/M5h-PLAN.md`).
>
> Recorded at length rather than quietly amended because the failure mode is the interesting
> part: the symptom *was* observed, in this very session, and was attributed entirely to the
> known-bad input in front of it. A stack overflow is a statement about the code's own shape, not
> about its input — invariant 4 exists precisely because "the input was malformed" is never the
> whole explanation.

## O2 — typed arrays replace `Map<Offset, FormatInfo>`

Done. `collectFormatInfo` (`src/formats/xml/index.ts`) now returns a `FormatInfoTable` — parallel
`Int32Array`/`Int32Array`/`Uint8Array` (`starts`/`ends`/`flags`, one packed-bit-flags byte per
element) instead of one `Map` entry and one heap object per element. Only `Element` nodes get a
slot — `formatElement` is the only reader, and only ever queries an element's own span-start
(`Text`/`CData`/`Comment`/`PI`/`DocType` are copied verbatim by `emitChild`'s other branch without
consulting this table at all), so the `Map` version's entries for those kinds were pure overhead
the new version doesn't pay. Pass 1 (`openNode`) and pass 2 (`formatElement`/`emitChild`) both
visit elements in document order — slots are reserved at `openNode` time, so pass 2 walks the
table with a plain ascending cursor (`FormatCursor`) rather than hashing a lookup per element; a
`skipCursorPast` helper keeps the cursor aligned across both the "mixed/preserve subtree copied
verbatim" and "no matching entry — malformed input" branches, where pass 2 doesn't visit every
slot pass 1 recorded.

Measured, `mixed-10mb.xml` (real elements-with-mixed-content path, not the no-op-bytes shortcut
since format() still has to walk and decide): **467.5 ms → 200.2 ms** for `format()` alone.

Differential correctness: `test/xmlFormat.test.ts`'s existing 300-sample generated-corpus
invariant suite (idempotence, structurally-identical reparse, mixed/preserve byte-identity) and
every named acceptance case — including the `<p>Text <b><a>…</a></b> and more text</p>`
subtree-scoped-skip case D-058 records — ran unmodified and pass. The plan's own suggestion to
keep the `Map` version behind a flag for A/B differential testing wasn't taken: the existing
invariant suite already re-derives the formatter's output from scratch and checks it against the
real parser's own read-back, which is a stronger check than comparing two implementations' outputs
against each other (two buggy implementations can still agree).

## O3 — hoist indent strings

Done. `IndentCache` (`src/formats/xml/index.ts`) precomputes each depth's
`newline + indent.repeat(depth)` run exactly once, as bytes, lazily up to whatever depth a
document actually uses — `formatElement`'s hot loop previously called
`options.indent.repeat(depth + 1)` (a fresh string) plus concatenation, twice per element, on
every single child emitted.

Measured, `cars-10mb.min.xml` (the fixture with real formatting work to do, not the
already-formatted no-op case — §3.2 flagged this as the one that actually exercises O2/O3's
target): `format()` throughput **9.6 MB/s → 17.9 MB/s** after O2+O3 combined (§1.3's plan baseline
was 9.6 MB/s / 701 ms; this session's clean single-fixture run measured 372.1 ms).

**Gate check (§4):** "if `format()` throughput after O2+O3 is not meaningfully closer to the
parser's ~65 MB/s, stop and report." 17.9 MB/s is real progress (≈1.9×) but still well short of
parity.

**Which baseline the gate is judged against**, since the two differ and the plan named only one:
the ~65 MB/s in §4 is `M1-RESULTS.md`'s figure for the parse function alone at 200 MB. The
like-for-like number here is **~46 MB/s** — this machine, this session, the reparse's own `parse`
stage over the same 10 MB output. The gate is read against 46, not 65: comparing a 10 MB run to a
200 MB one measured on a different day would flatter or punish the result for reasons that have
nothing to do with O2 or O3. Read as "meaningfully closer, not closed" rather than
either "gate passed cleanly" or "gate failed": genuine improvement, continued to O4 rather than
stopping, but the two-pass design's own ~2× floor (§1.3 cause 1, "by design") means this was never
going to reach 65 MB/s without revisiting that design, which is explicitly out of scope for this
round (§2's O5).

## O4 — stop the Tree collapsing / don't remount the Raw view

**Split.** The Tree half is done; the Raw view half is deferred, not attempted, and recorded here
rather than silently dropped.

**Tree (done).** `Tree.tsx`'s `expandedRef` reset used to key on `store` identity, which changes
on *every* reparse of the same document (an edit, a Transform) — not just when a different file
opens. `TreeContentProps.document` gained a `filePath` field; the reset now compares that instead.
Verified against real Chromium layout (`test/treeExpansion.test.tsx`, via `vitest`'s `browser`
project — the virtualizer needs real container geometry jsdom fakes): a manually expanded node
stays visible across a same-document reparse (a fresh `NodeStore`, same `filePath`) and still
resets when a genuinely different document opens. Confirmed the test actually exercises the fix,
not just the API surface, by reverting the source change and re-running — it fails (in this case,
fails to even import, since the fix also exports `TreeContent` for the test to reach).

**Raw view (deferred).** Not remounting the `EditorView` on every reparse needs
`rawDecorationsExtension`/`rawCaretSyncExtension`/`rawLineNumbersExtension`/`rawEditExtension`
converted from closed-over `store`/`sourceBuffer`/`rowIndex`/`lineIndex` values to live getters —
the same pattern `getWindow: () => RawWindowSnapshot` already uses, and for the same reason
(`rawDecorations.ts`'s own doc comment: "called fresh on every rebuild rather than closed over as
a constant"). That's four extension modules to convert, plus a second effect in `Raw.tsx` (mount
effect re-keyed on document identity, a new one on `[store, sourceBuffer, rowIndex, lineIndex]`
that re-slices the window and forces a decoration rebuild without destroying the view) — real
surgery on the most heavily-hardened, most bug-fixed part of this codebase (D10, J1–J3, R8), with
no live GUI in this session to drive the result and confirm scroll/caret/decoration behavior
actually holds together afterward. `CLAUDE.md`'s own working agreement — "report rather than work
around" when something can't be done with confidence — applies directly. Left as the concrete next
step for whoever picks this up: the getter-conversion shape is fully specified above, not just
"needs care" restated.

---

## What changed vs. what didn't

| Optimization | Status | Headline number |
|---|---|---|
| O0 (clamped-window recentre) | done | 4 new boundary tests, all previously failing |
| O1 (skip no-op pipeline) | done, moved to worker per feedback | no-op: 0 bytes transferred, 0 reparses |
| O2 (typed-array format info) | done | `format()` 467.5 ms → 200.2 ms on `mixed-10mb.xml` |
| O3 (hoisted indent) | done | `format()` throughput 9.6 → 17.9 MB/s on `cars-10mb.min.xml` |
| O4, Tree | done | expansion survives same-document reparse (real-layout test) |
| O4, Raw view | **deferred** | not attempted — see above |
| O5 (skip reparse entirely) | not scheduled | recorded in the plan only, per §2 |
| O6 (undo byte budget) | left for project lead | number, not code — R12 makes the figure visible |

## Fixture reference table (this session, clean single-process runs)

| Fixture | `format()` | throughput | reparse total | total | peak RSS |
|---|---:|---:|---:|---:|---:|
| `cars-10mb.xml` (no-op) | 376.8 ms | 26.5 MB/s | 260.7 ms | 637.5 ms | 96.2 MB |
| `cars-10mb.min.xml` | 372.1 ms | 17.9 MB/s | 284.1 ms | 656.3 ms | 93.8 MB |
| `mixed-10mb.xml` | 191.2 ms | 52.3 MB/s | 286.0 ms | 477.2 ms | 111.7 MB |
| `preserve-10mb.xml` | 179.9 ms | 55.6 MB/s | 237.7 ms | 417.6 ms | 98.5 MB |
| `nonascii-10mb.xml` | 299.5 ms | 33.4 MB/s | 215.7 ms | 515.2 ms | 91.1 MB |
| `deep-10mb.xml` | 208.3 ms | 48.0 MB/s | 172.6 ms | 380.9 ms | 86.1 MB |

Run-to-run variance on this machine is real (a repeat of `cars-10mb.min.xml` during development
measured 346.4 ms and 389.0 ms on other runs of the same fixture) — read these as representative,
not exact, the same caveat every other measurement doc in this project carries.

Note `cars-10mb.xml` is the **no-op** case (§1.2) — the numbers above are what the bench measures,
which is the pipeline's stages regardless of O1.

**What O1 actually removes, stated precisely** (an earlier version of this note claimed a no-op
now "costs the worker-side `bytesEqual` check and nothing else", which is wrong by the largest
term): `format()` still runs in full — **367 ms** on this fixture, re-measured during review —
because O1 compares its *output*, which is the design described in §O1 above. What is skipped is
everything downstream: the result transfer back to the renderer, the buffer swap, the reparse
(**257.6 ms** of the 624.6 ms total), the undo entry and its ~2× retention, the dirty flag, and
the Raw remount plus Tree rebuild that a new store triggers on the main thread. So a no-op costs
roughly `format()` + the compare, against `format()` + everything else before — and the
main-thread half, which is what the original report was about, drops to zero.
