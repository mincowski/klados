# NodePad — M5 Results

H10's own measurement pass. Methodology: `spike/m5-bench.ts`
(`npx tsx --expose-gc spike/m5-bench.ts <section> [args]`), the same one-off-harness
convention as `spike/m2-e10-measure.ts`, `spike/m3-bench.ts` and `spike/m4-bench.ts` — not
wired into `npm test`, run against the real gitignored fixtures in `spike/fixtures/`.
**Each section runs as its own process invocation**, not a shared run — a consolidated
single-process version was tried first and produced inflated later-section numbers (earlier
sections' allocations don't reliably return to the OS even with `--expose-gc`'s
`global.gc()`), so each measurement below is a fresh process, matching the real pipeline's
own shape (a fresh worker per parse/transform, per `parseClient.ts`/`transformClient.ts`).

**Status: every M5 task is built and measured.** H1 was answered before implementation began
(deferred, D-043); H2/H3 stayed out of scope per that decision; H6 was answered as "not built
this milestone" (D-045); H11 was spiked and answered "go" (D-047), with H12 (the real
production wiring) explicitly left as a follow-up, not part of this milestone's definition of
done. **H12 was subsequently built anyway** (D-048, commits `4e2f387`…`53ae928`, the same day as
this pass) — so §2's worker figures below predate it. They are unaffected: the harness reads the
file directly into the measuring process, which is the shape H12 gives the worker; H12's saving
was in the main process and the IPC hop, not here.

## 1. H2b — the incremental reparse no longer rebuilds the row index

Already measured and recorded in `docs/DECISIONS.md`'s D-036 addendum (the H2b closure
note) — repeated here for the single-document summary this file is for.

| Fixture | `spliceSubtree` | `incrementalRowIndex` (was `buildRowIndex`) | `buildLineIndex` | `buildNameIndex` | **Real block** |
|---|---:|---:|---:|---:|---:|
| `cars-200mb.xml` | 462.2 ms | **20.2 ms** (was 887.9 ms) | 35.4 ms | 46.8 ms | **564.6 ms** (was 1476.0 ms) |
| `cars-500mb.xml` | 1156.5 ms | **56.8 ms** (was 2315.1 ms) | 127.6 ms | 106.7 ms | **1447.7 ms** (was 3822.3 ms) |

The row-index share drops ~44× (200 MB) / ~41× (500 MB); the whole block drops ~2.6× at both
sizes. The splice itself (H2d's target) is now the dominant remaining cost.

## 2. H2c — peak RSS through the open path, main process and worker separately

Re-measured cleanly (isolated process per reading, `--expose-gc`) against the pre-fix
figures `M5-PLAN.md` itself recorded.

**Main process** (`document:read`'s `.slice()` guard):

| Fixture | Stage | Before | After |
|---|---|---:|---:|
| `cars-200mb.xml` | after `readFile` | 272.5 MB | 256.5 MB |
| `cars-200mb.xml` | after slice/skip | **472.5 MB (2.36×)** | **256.5 MB (1.28×)** |
| `cars-500mb.xml` | after `readFile` | 556.7 MB | 556.8 MB |
| `cars-500mb.xml` | after slice/skip | **1056.7 MB (2.11×)** | **556.8 MB (1.11×)** |

**Worker process** (`NodeStore.exportBuffers()`'s release-as-it-goes fix — the full pipeline
through `exportBuffers`, post-fix only, since the pre-fix figures are `M5-PLAN.md`'s own
822 MB / 1922 MB):

| Fixture | after read | after parse | after indexes | after `exportBuffers` | peak − start |
|---|---:|---:|---:|---:|---:|
| `cars-200mb.xml` | 255.9 MB | 532.1 MB | 574.0 MB | 623.5 MB | **567.6 MB (2.84× file size)** |
| `cars-500mb.xml` | 556.2 MB | 1234.8 MB | 1341.0 MB | 1403.1 MB | **1347.1 MB (2.69× file size)** |

Against the plan's own pre-fix worker figures (822 MB / 4.11× at 200 MB, 1922 MB / 3.84× at
500 MB): **623.5 MB / 3.12× and 1403.1 MB / 2.81× absolute**, or **2.84×/2.69× as a delta
over this process's own baseline** — both readings land close to §8's ~2.5× budget and to
`M2-RESULTS.md`'s own 554.2 MB figure (see §4 below for why that number and this one
reconcile rather than disagree). The two processes are never summed — each has its own
peak, and each is what actually fails if the OS pressures it.

### Reconciliation with §8's ~2.5× budget — added 2026-08-20

This section originally reported the worker figure as *over* §8's budget, and M5's definition of
done carried it as the milestone's one unmet criterion. **Re-measured on 2026-08-20 and reproduced
exactly** — `npx tsx --expose-gc spike/m5-bench.ts h2c-worker spike/fixtures/cars-200mb.xml` gives
`start 71.7  read 271.7  parse 549.3  indexes 590.2  export 639.7 MB`, a delta of 568.0 MB / 2.84×,
against the 567.6 MB / 2.84× above. The measurement is stable and was never in doubt.

**What was wrong was the comparison, not the number.** The two quantities are not the same kind:

- **§8's 503 MB is a sum of *resident* components** — source buffer, node store, attribute table,
  row index, Raw window. It is what the process holds once the document is open.
- **568 MB is a *peak* through the open path**, and the walk passes through `exportBuffers`, whose
  per-column slice adds **+49.5 MB** (639.7 − 590.2). That is a transfer transient: it exists to
  hand standalone buffers to a `postMessage`, it is one column wide by construction (H2c's own
  fix), and §8's table models nothing corresponding to it.

Excluding the transient, the open path's resident total is 590.2 − 71.7 = **518.5 MB, or 2.59×**.

**The decisive figure is H9's**, §6 below, because it measures resident components directly rather
than inferring them from RSS: **512.2 MB at 200 MB, and 1280.5 MB at 500 MB — 2.56× at both.**
Against §8's table as it stood (503 MB) that is 1.8% over; against the corrected table (528 MB,
with the name index restored) it is 3% under. Either way §8's ~2.5× rule of thumb holds, and its
"~1.25 GB at 500 MB" projection turns out to be exact. It was never actually missed.

**One real inaccuracy in §8's table, which this exposes and which is worth fixing there rather
than here:** it budgets 31 MB for "Row index" and lists no other index, but the application builds
three. Measured directly (byteLength, not RSS) at 200 MB: **row 29.7 MB, name 25.1 MB, line
0.03 MB** — the line index is genuinely negligible because its `checkpoints` array is strided at
1024, and the name index postdates §8 by a milestone. `M4-RESULTS.md` §1 had already measured
25.1 MB and published a corrected ~528 MB total; it never made it back into §8. Now amended there.

**A caution about how those three were nearly derived here.** The obvious move is to read them off
this section's own RSS ladder — 590.2 − 549.3 = 40.9 MB for "indexes". That is 14 MB *less* than
the components actually sum to (54.8 MB), because the parse's freed scratch is reused rather than
returned to the OS, so the step's delta understates it. **An RSS delta bounds a stage; it does not
decompose into components.** The 25.1 MB above agrees with M4's independent measurement to three
significant figures precisely because it is a `byteLength`, not a subtraction.

**Nothing was rebuilt to close this.** The code is exactly as H2c left it; only the claim about
it changed.

## 3. H2d — the subtree splice no longer blocks the main thread

Already measured and recorded in `docs/DECISIONS.md`'s D-036 addendum:

| Fixture | synchronous `spliceSubtree` | chunked wall time | max single block |
|---|---:|---:|---:|
| `cars-200mb.xml` | 412.8 ms | 748.7 ms | **~23.6 ms** |
| `cars-500mb.xml` | 962.3 ms | 2302.9 ms | **~22.6 ms** |

~18–40× reduction in the longest single main-thread block, at the cost of roughly doubling
total wall time (spent yielding, not working) — the correct trade for a milestone about
responsiveness, not throughput. The ~23 ms floor is suspected to be Node's own `setTimeout`
granularity rather than real per-batch cost (it didn't move between `GRAFT_BATCH_SIZE` 1024
and 4096) — worth re-measuring inside the real Electron renderer before treating it as exact.

## 4. Reconciling `M2-RESULTS.md`'s 554.2 MB and `M1-RESULTS.md`'s 776.1 MB

Both figures were measured *before* the `exportBuffers` step existed to be measured — not
wrong about what they measured, just stopped one step short, the same shape D-036's own
correction. This pass's own "after indexes" reading (574.0 MB at 200 MB) lands within 4% of
M2's 554.2 MB, corroborating rather than contradicting it: M2 stopped right around there,
and H2c's fix is precisely what keeps the *next* step (`exportBuffers`, 623.5 MB) from being
the ~250 MB further spike it used to be. M1's 776.1 MB included a second in-process copy of
the source bytes on top of that, per its own flagged gap — consistent with the same shape.

## 5. Transform peak RSS (H4), against M0a's naive figure

M0a's own naive full-document-replacement figure: renderer RSS **1191 → 5694 MB** on a
500 MB file (§5.5) — roughly **9×** the file size for the increase alone.

No large real JSON fixture exists on disk (the project's large fixtures are XML), so this
uses a synthetic ~190 MB JSON document generated in-process, measuring `format()` alone —
the piece H4 actually changed:

| Input | Output | RSS delta | Multiple of input |
|---:|---:|---:|---:|
| 189.9 MB | 277.2 MB | 278.8 MB | **1.47×** |

`format()`'s own peak is close to one copy of its output, not the naive shape's "old + new +
source all live" — the `GrowableBytes`-based traversal (H5) is what makes this true. The
*full* Transform pipeline (worker round trip, held old bytes for the undo inverse, received
new bytes) adds roughly one more document's worth on the renderer side — old buffer (kept
for `inversePatchOf`) plus new buffer (received back), consistent with hard rule 3's "~2×
the document, never ~11×," though that full-pipeline number was not separately measured
end-to-end through a real Electron renderer in this pass (flagged, not fabricated).

## 6. H9 — memory budget accuracy

| Fixture | Computed | Actual process RSS delta | Accuracy |
|---|---:|---:|---:|
| `cars-200mb.xml` | 512.2 MB | 518.1 MB | **98.9%** |
| `cars-500mb.xml` | 1280.5 MB | 1286.6 MB | **99.5%** |

Within 1–1.1% at both sizes — the computed figure (a sum of `.byteLength`s and existing
`packedMemoryBytes` getters) tracks real process memory closely enough to be trusted as
shown, not just directionally correct.

## 7. H11 — spike verdict

Recorded in full in `spike/h11-protocol-fetch/RESULTS.md` and `docs/DECISIONS.md`'s D-047.
Summary: a worker `fetch()` over a custom protocol, serving a file through a streamed
response, peaks at **~1.00–1.03×** the document size at both 200 MB and 500 MB, identical
with and without `Content-Length` set. **Go** — H12 (the real production wiring, with the
required token-scoped handler) is recorded as a follow-up, not built this milestone.

## 8. Format/minify — byte-exactness and idempotency

Not a throughput measurement (H5's own `format()` is fast enough at the sizes tested that
timing it is not informative — see §5 above for the one number that matters, peak memory).
Correctness is what H5's acceptance criteria actually asked for, and it's asserted directly
in `test/jsonParser.test.ts`: format-then-minify returns to the original minified bytes,
both directions are idempotent under repetition, every numeric literal tested (`1e400`,
`1.0`, `-0`, integers past 2^53, and several more) survives byte-identically, and a BOM'd
document round-trips with the BOM preserved (a real bug found and fixed while wiring this
up — see the `7725980` commit).

## Inherited — deferred, not re-litigated

**Grid and Tree scroll frame time** and **wrap's first-paint cost** stay deferred, per
D-040's own framing (accepted gap, not this milestone's problem to close). H2b removed the
largest main-thread block in the application; if a scroll-responsiveness harness is ever
budgeted as its own task, M6 is the honest place to ask for it, per D-040's own suggestion —
not litigated further here.

## What was not measured end-to-end

- The full Transform pipeline's renderer-side peak, through a real Electron process rather
  than `format()` in isolation (§5).
- H2d's ~23 ms block figure, inside the real Electron renderer rather than Node (§3) —
  flagged as likely floor-limited by Node's own timer granularity.
- ~~The `npm run dev` shape for H11's custom protocol~~ — **done**, in H12's own review pass
  (D-048): `npm run dev` launched against the http-origin renderer, a JSON and an XML file opened
  through the real dialog, no error tied to scheme registration or the handler.

**Status of the remaining two, re-checked 2026-08-20.** Both still owed and both unchanged as
findings — but the tooling moved: R51 added `test/mainElectron.test.ts`, which drives a real
Electron process, and both items were blocked on exactly that. The Transform pipeline's
renderer-side peak is an RSS reading and looks straightforwardly reachable there. H2d's ~23 ms
floor is a timer-granularity question, so whether it needs a display as well is untested — the
harness exists now, which it did not at M5, and that is as far as this check goes.

None of these blocked the milestone; each is named explicitly rather than silently
assumed fine, per this project's own recurring pattern of measuring the component and not
the pipeline around it (M0's row-index pre-scan, M2's `isNumericColumn`, D-036's own
addendum) — stated here so a fourth instance doesn't need re-discovering from scratch.

---

## Addendum — review after the milestone closed

### One correctness bug in H2b, found by differential fuzzing — fixed

`incrementalRowIndex` began its re-scan at the row *containing* `dirtyStart`. That is one row
too late: a row starting at `S` decides where it ends by scanning forward for a newline and,
failing that, calling `findBreak`, which scans **backward** from `S + maxRowBytes` for a break
byte — and `snapToCharBoundary` can then advance a few bytes further. A row's cut therefore
depends on bytes as far ahead as `S + maxRowBytes + 3`, so an edit landing in that window
moves the *preceding* row's end, and with it the start of the row the edit is actually in.

Found by fuzzing `incrementalRowIndex` against `buildRowIndex` over five document shapes:
**6 mismatches in 7,500 random edits**, all in documents whose row boundaries are hard
`maxRowBytes` cuts rather than newlines. Minimized reproducer, now a test:
`'<c id="0"><n>x</n></c>'.repeat(40)` at `maxRowBytes: 64` — rows fall at 0 and 62, and
inserting one space at offset 62 moves row 0's cut to 63, which the incremental path missed.

Fixed by starting the re-scan at the row containing `dirtyStart - maxRowBytes - 4`, the
provable bound. Costs at most one or two extra re-scanned rows; re-fuzzed at 0 mismatches in
2,000 edits. §1's timings are unaffected — the change adds a bounded constant to a scan whose
cost is dominated by the realignment search.

**Why the suite could not have caught it, which is the more useful finding.**
`test/rowIndex.test.ts`'s `checkEdit` helper computed
`delta = newBytes.length - (end - start)` instead of `newBytes.length - oldBytes.length`. The
resulting `delta` was large enough that `incrementalRowIndex`'s realignment check
(`oldCandidate = next - delta >= dirtyEnd`) could never succeed, so **every test in that
describe block exercised only the scan-to-EOF fallback** — correct results, reached by the
path the optimization exists to avoid. The tail-reuse path had no coverage at all, while
`documentSession.ts`'s `trySpliceReparse` always passed the true net delta and therefore ran
it in production. Helper corrected, and a test added that specifically drives the realignment
path.

### One flaky test, on `main`, unrelated to the above

`documentSession.test.ts` → "coalesces a burst of edits into one reparse" fails intermittently
on `expect(storeChanges).toBe(1)` — observed once in a full-suite run, passing on the same
commit both in isolation and on a second full run (841/841). The test uses
`reparseDelayMs: 5`, and H2d made the splice yield between graft batches, so a burst can now
straddle the debounce window under a loaded event loop in a way it could not when the splice
was synchronous. Not fixed here: worth either a larger `reparseDelayMs` or driving the
debounce with fake timers rather than a real 5 ms wait. Recorded so an intermittent red run
is recognised rather than re-investigated from scratch.
