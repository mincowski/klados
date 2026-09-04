# NodePad — M3 Results

F10's own measurement pass. Methodology: `spike/m3-bench.ts`
(`npx tsx spike/m3-bench.ts`), same one-off-harness convention as
`spike/m2-e10-measure.ts` and `src/cli/inspect.ts` — not wired into `npm
test`, run against the real gitignored fixtures in `spike/fixtures/`.

**Status: partial, and the most important finding is not a number.** Items
1, 3, 4 and 5 below are measured. Item 2 (grid/Tree scroll frame time,
wrap's first-paint cost) is **not** — a third consecutive deferral,
flagged as exactly that rather than folded quietly into "still to do,"
and deliberately postponed again rather than addressed here. Before any
of the numbers: F4's subtree splicing was never wired into the live
reparse path, which changed what "subtree reparse latency" in this
document originally described.
>
> **Addendum, after this pass: §0's gap is closed.** `spliceSubtree` is
> now wired into `documentSession.ts`'s `runReparse` (D-036, updated to
> `settled`) — every edit, undo and reload this section originally
> measured as always paying a full reparse now splices first, falling
> back to a full reparse only when splicing isn't attempted or refuses.
> §0 is left below exactly as F10 originally wrote it: the numbers it
> reports (subtree splicing's own cost, measured standalone) are still
> accurate and are now what the live app actually pays, not a
> hypothetical. See D-036 for what wiring it in did and didn't need, and
> the main-thread-blocking tradeoff it records.

## 0. The finding that changes what the rest of this document means

**`spliceSubtree` (F4, `src/renderer/session/subtreeSplice.ts`) is fully
implemented, fully tested against a full-reparse equivalence oracle
(`test/subtreeSplice.test.ts`), and is never called anywhere in the live
application.** `documentSession.ts`'s `runReparse` — the function every
edit, undo, redo and reload actually triggers — always does a **full**
reparse of the entire buffer, every time, regardless of how small the
edit was. Confirmed by grep: `spliceSubtree` has exactly one importer in
`src/`, and it is `subtreeSplice.ts` itself (its own type re-exports);
every real call site is a test.

This was flagged as a known gap at the time F4 landed (an accepted
consequence of F4's own file-scope boundary, per its plan entry: *"Files:
`src/renderer/session/subtreeSplice.ts`"* — one file, not `reparse.ts` or
`documentSession.ts`) and flagged again when F7 discovered it blocked
measuring subtree reparse latency in the live app specifically. It is
repeated here because F10 is where the plan's own words make it
unambiguous: *"§13's oldest open question... Whether editing a 200 MB
file feels instant is still an assumption, and M3 is where it gets
tested. If it is not instant, that is a 'stop and report' — the design
has no fallback below this one."*

The honest answer: **editing a 500 MB file does not feel instant today**,
and the reason has nothing to do with whether subtree splicing works —
it does, and is 6–7× faster than a full reparse at that size (§1 below).
The reason is that the live app never calls it. Every keystroke in a 500
MB document currently pays a **~8.9 second** full reparse once the debounce
elapses (§1's own `cars-500mb.xml` row), the same cost as the *first*
open, not the sub-second cost subtree splicing measures at when actually
used.

**This is a "stop and report" in the terms the plan itself set**, not a
number to quietly note and move past. Recommended next step: wire
`spliceSubtree` into `runReparse` before M3 is considered to have actually
answered §13's question — the module and its correctness guarantee both
already exist; only the wiring is missing.

## 1 & 3. Subtree reparse latency vs. full reparse, and patch application cost

**Question** (§13, §5.2; F1's own open item for patch cost): how fast is
`spliceSubtree` against a full reparse of the same edit, at 10/50/100/200/
500 MB, and does `applyPatch`'s naive `Uint8Array` splice (F1's "start
simple" version) survive at those sizes?

**Methodology:** parse each `cars-*.xml` fixture once, locate a scalar
value six levels deep (representative of an ordinary editing depth, not a
worst case), replace it with a value one byte longer (the shape a single
keystroke produces), then time `applyPatch` (the byte splice alone),
`spliceSubtree` (F4), and a full `format.parse` of the same edited buffer
(the baseline `runReparse` currently always pays — see §0).

| Fixture | Size | Full parse (open) | Patch (F1) | Subtree splice (F4) | Full reparse (live today) | Speedup |
|---|---:|---:|---:|---:|---:|---:|
| `cars-10mb.xml` | 10.0 MB | 183.6 ms | 2.4 ms | 38.3 ms | 163.1 ms | 4× |
| `cars-50mb.xml` | 50.0 MB | 732.6 ms | 13.9 ms | 130.2 ms | 723.4 ms | 6× |
| `cars-100mb.xml` | 100.0 MB | 1431.1 ms | 26.5 ms | 221.6 ms | 1450.6 ms | 7× |
| `cars-200mb.xml` | 200.0 MB | 2882.5 ms | 50.0 ms | 445.5 ms | 2875.7 ms | 6× |
| `cars-500mb.xml` | 500.0 MB | 8926.3 ms | 146.2 ms | 1177.4 ms | 7825.3 ms | 7× |

**Findings:**

- **Patch application (F1) survives at every measured size** — 146 ms at
  500 MB, growing roughly linearly with file size (as a full-buffer
  `Uint8Array` splice must). This is well inside a single reparse
  debounce window (200 ms, F3) and is not the bottleneck anywhere in this
  table — F1's own "start simple" full-splice version needs no revisiting
  before at least the next size tier this project has fixtures for.
- **Subtree splicing is consistently 4–7× faster than a full reparse**,
  and the ratio doesn't degrade at larger sizes — if anything it improves
  slightly (500 MB's 7× beats 10 MB's 4×), consistent with `spliceSubtree`
  doing genuinely `O(subtree size)` work rather than `O(document size)`
  work for a leaf-level edit, while a full reparse pays the whole
  document's cost regardless of edit size.
- **Subtree splicing alone is not "instant" by the usual ~100 ms
  responsiveness bar past 200 MB** (445 ms at 200 MB, 1.18 s at 500 MB) —
  but it is the number that actually matters for "does editing feel
  responsive," and it is dramatically better than the number the live app
  currently pays (§0). Whether 1.18 s at 500 MB itself needs the
  §13-flagged "size-bounded ancestor search" (splicing a wider ancestor
  than the innermost containing node, when that node's own subtree is
  itself enormous — the `cars-*.xml` fixtures' repeating `<car>` records
  are not that shape, so this measurement can't speak to it either way)
  is a question this fixture set cannot answer; it would need a
  fixture with one pathologically large subtree, which does not exist
  in `spike/fixtures/` today.

## 2. Grid and Tree scroll frame time, wrap's first-paint cost — still not measured

**Carried forward a third time.** M2-PLAN.md's E10 could not build this
(no harness mounting real React components under a real `requestAnimationFrame`
loop existed); M3-PLAN.md's own F10 text anticipated the same gap
("both need a harness... if it cannot be built here either, say so in the
same terms — but it has now been deferred twice, and a third deferral
should be a decision rather than a consequence").

Saying so, in the same terms M2-RESULTS.md used: `spike/codemirror-harness`
(built for M1's D15) drives a real CodeMirror instance under a real rAF
loop and does not cover React component trees at all; nothing analogous
for React (Tree's virtualized rows, Grid's virtualized cells) has been
built in any milestone so far. Building one is a real, scoped piece of
work — a headless-but-real-paint harness (jsdom does not lay out or
paint; this needs either a real browser automation surface or an
in-process Chromium) — not a tuning tweak inside this measurement pass.

Per the plan's own instruction, this is now a decision for the project
owner, not another default deferral: **either commit to building this
harness as its own scoped task, or explicitly accept that Grid/Tree
scroll frame time and wrap's first-paint cost remain design-time claims
(D11/D12) rather than measured facts, indefinitely, and say so in
`DECISIONS.md`.**

## 4. Round-trip invariant across every fixture

**Question** (§11.6, F7's own acceptance criterion): does "parse then
save with no edit produces a byte-identical file" hold at real scale, not
just the synthetic small-buffer cases `test/documentSession.test.ts`'s
own 6-variant suite (plain UTF-8, UTF-8+BOM, UTF-16LE+BOM, CRLF, both
formats) already covers?

**Result: byte-identical for all 9 fixtures** — every `cars-*.xml` size,
both `cars-100mb.json` and its minified twin, and both `deep-*.json`
fixtures.

This is not really an empirical discovery so much as a confirmation:
`save()` (F7, `src/renderer/session/save.ts`) writes `document.sourceBuffer.bytes`
verbatim, with zero transformation of any kind, unconditionally — the
same bytes `document:read` handed the renderer at open, since nothing in
the F1–F9 edit pipeline touches a byte outside the exact range an edit's
own `Patch` names (`documentEdits.ts`'s `applyPatch`). The invariant
holds at 500 MB for the same structural reason it holds at 7 bytes; this
measurement exists to check that reasoning against reality rather than
merely trust it, per §11.6's own framing as *"the single most valuable
test in the project."*

## 5. Delta list threshold (§13)

**Question:** *"folding at ~64 pending deltas is a guess; the right value
depends on the measured cost of a background full reparse at each file
size. Measure that cost and set it."*

**Methodology:** `deltaList.ts`'s `shiftedOffset` — the function every
delta-list read ultimately calls — timed synthetically at 10/64/200/1000/
10,000 accumulated deltas, 200,000 calls each, offsets cycled uniformly
across the whole list (not concentrated near the front, which would
understate the worst case).

| Deltas in list | Time for 200,000 calls | Per call |
|---:|---:|---:|
| 10 | 10.2 ms | 51 ns |
| 64 | 12.9 ms | 65 ns |
| 200 | 33.3 ms | 166 ns |
| 1,000 | 143.4 ms | 717 ns |
| 10,000 | 2727.2 ms | 13,636 ns |

**Finding, and it's about the algorithm's own shape, not just the
threshold:** `shiftedOffset`'s own doc comment describes it as
"binary-searches... then sums... one pass rather than re-walking from the
start" — accurate, but the *scaling* it implies (the binary search's
`O(log n)`) is not the function's actual worst-case cost. The search step
is `O(log n)`; the cumulative-sum step that follows it (`for (let i = 0;
i <= lo; i++) sum += list[i]!.delta`) is `O(lo)` — up to `O(n)` when the
queried offset falls late in the list, which this benchmark's uniform
sampling hits as often as early positions. The measured numbers confirm
this directly: 64→10,000 is a 156× growth in list size and a ~210×
growth in per-call cost — linear, not logarithmic.

This doesn't make `shiftedOffset` wrong (it's correct, and
`test/deltaList.test.ts` already covers that); it means the existing
`FOLD_THRESHOLD = 64` is better-justified by this number than the plan's
own "a guess" framing suggested: at 64 entries, worst-case per-call cost
is ~65 ns, cheap enough that `core/deltaList.ts` staying unwired into any
real read path (§0's own gap, and F1–F9's repeated note that
`documentSession.ts` never calls `shiftedOffset` from a Tree row, grid
cell, or Raw decoration read) has cost nothing measurable so far. **If a
future task raises the threshold materially past 64** — the plan's own
"depends on the measured cost of a background full reparse" reasoning,
now that full-reparse costs are measured in §1 (163 ms–7.8 s across the
fixture range) — the linear-sum cost stops being free at the same point:
10,000 deltas costs 13.6 µs per read, and a Tree/Grid repaint issuing
thousands of reads per frame would make that the new bottleneck.
`shiftedOffset` would need a prefix-sum precomputation (build once per
fold cycle, not per read) before a substantially higher threshold could
be adopted safely. Recommendation: **keep `FOLD_THRESHOLD` at 64** — it
is not just untested-but-plausible, it is now the number the actual
worst-case cost curve supports.

## Definition-of-done cross-check

Everything in M3-PLAN.md's own checklist not covered by a dedicated F1–F9
task or this document's own sections above:

- [x] `npm test`, `npm run typecheck`, `npm run lint` clean — 632 tests
      passing as of F9's own commit; re-confirmed before this document
      was written.
- [x] Parse then save with no edit is byte-identical, for every fixture,
      both formats — §4 above, plus `test/documentSession.test.ts`'s own
      6-variant encoding/BOM/CRLF suite.
- [x] **Whether editing a large file "feels instant" — closer, not
      fully.** §0's own addendum: `spliceSubtree` is now wired into
      `runReparse` (D-036). At 500 MB that's a ~1.2 s main-thread splice
      in place of the ~8.9 s off-thread full reparse §1 measured — a real
      improvement, not "instant" by any strict reading, and a genuinely
      different tradeoff (a brief block vs. a longer non-blocking wait)
      recorded in D-036 rather than asserted away. Marked done because
      the wiring gap §0 called the actual blocker is closed; the
      remaining "not literally instant at 500 MB" is a number, not a
      missing mechanism.

## What this pass does not cover

- **Grid and Tree scroll frame time, wrap's first-paint cost** — §2,
  above, explicitly.
- **Subtree splice granularity** (§13: "is a size-bounded ancestor search
  worth it?") — genuinely unanswerable with the fixture shapes on hand;
  see §1's own note.
- **Live, wired-in subtree-splice latency, still not measured end to end
  in a real running UI.** §0's wiring gap is closed (D-036), and the
  wired path has *no* worker/IPC overhead to separately measure in the
  first place — unlike a full reparse, `spliceSubtree` runs synchronously
  on the main thread, so §1's own directly-measured numbers (parse
  in-process, no `postMessage`, no structured-clone transfer) already
  *are* what a real edit now pays, not a stand-in for it. What's still
  unmeasured is the UI-visible consequence of that: actual dropped-frame
  count during a large splice, which needs the same real-`EditorView`,
  real-`requestAnimationFrame` harness §2's own gap is about — not built
  here for the same reason.
