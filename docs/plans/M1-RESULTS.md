# M1 — Results (D15)

Records what D15 measured, against the three numbers `M1-PLAN.md` deferred and the two
open questions §13 left unsettled. Companion to `M0-RESULTS.md` (M0) and `spike/RESULTS.md`
(M0a); this is the first time any of these five things has been measured on a real
`Worker`, a real `requestAnimationFrame` loop, or the actual shipped worker artifact rather
than in-process code or throwaway synthetic data.

## Status

All three deferred numbers are measured; both §13 questions are settled with data, not
carried over unresolved. One finding changes a stated M0/CLAUDE.md figure (worker-path
parse throughput is lower than the direct-path figure, explained below, not a regression);
one finding is a genuine miss against an existing bar (200 MB end-to-end open time) and is
reported rather than smoothed, per this project's own house rule.

- `npm test`, `npm run typecheck`, `npm run lint`: clean (see the D10–D14 implementation
  commits; unchanged by this measurement pass, which adds no product code).
- Every figure below reproduces via `spike/codemirror-harness/main-d15.cjs` — see
  "Methodology" for exact invocations. Nothing here is committed as a script beyond that
  harness itself, matching `M0-RESULTS.md`'s own convention.

## Methodology

Two new Electron-hosted harness pages, added to the existing `spike/codemirror-harness`
package (already had Electron, Vite and `@codemirror/state`/`view` installed at the
production versions — 6.7.1 / 6.43.7, confirmed by inspecting `node_modules` directly, not
assumed):

- **`renderer-d15-open.cjs`** drives the *real* worker protocol: `new Worker(workerUrl,
  { type: 'module' })` pointed at `out/renderer/assets/parse.worker-*.js` — the actual
  `electron-vite build` artifact, not a copy — sent the same `ParseJobRequest` shape
  `parseClient.ts` sends, rehydrated with the same `Interner.fromBuffers` /
  `NodeStore.fromBuffers` / `SourceBuffer` construction `rehydrateParseResult` does
  (reimplemented inline rather than imported, so Vite's worker-constructor detection
  doesn't try to bundle `parse.worker.ts` a second time for a module that only needed its
  rehydration logic). A `requestAnimationFrame` loop runs continuously from just before the
  job is posted to just after it resolves, recording every frame gap.
- **`renderer-d15-scroll.cjs`** imports `components/Raw/rawWindow.ts` (`computeWindowBounds`,
  `planReslice`, `shouldRecenter`, `WINDOW_BYTES`) and `components/Raw/decorations.ts`
  (`viewportDecorations`) directly — the real, shipped algorithms, not reimplementations —
  and wires them into a real `EditorView` via a `ViewPlugin` matching `rawDecorations.ts`'s
  own shape. Runs the same document through two configurations, decorations on and off, in
  the same process: `harness-lib.js`'s `scrollTest` (A2/A6's own methodology, reused not
  rewritten) plus a boundary-crossing loop using the *real* `planReslice`/
  `computeWindowBounds`, ported from `renderer-a6b.js`'s `incrementalReslice` the same way
  the product code was.

One Electron process per measurement (`main-d15.cjs`), same reasoning as every M0a spike:
clean RSS per run, uncontaminated by whatever ran before it.

```
cd spike/codemirror-harness
npx vite build
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe main-d15.cjs \
  open <fixture> <name> <outPath> <capMs> <path-to-built-worker.js>
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe main-d15.cjs \
  scroll <fixture> <name> <outPath> <capMs> "" [windowBytes]
```

`ELECTRON_RUN_AS_NODE` has to be explicitly cleared — this environment sets it, which
makes the Electron binary run as plain Node (no `app`, no `BrowserWindow`) unless removed
from the child's environment first. `run-a6b.js` already does this; it cost some time to
rediscover here before finding that existing comment.

---

## 1. Main-thread responsiveness during parse

**Bar:** stay above ~50 fps while `cars-200mb.xml` parses in the worker (B11, deferred from
M0 — Vitest has no real `requestAnimationFrame`).

| Fixture | Size | Parse (worker) | Frames | p50 | p95 | max | Frames > 32 ms | Mean FPS |
|---|---|---|---|---|---|---|---|---|
| cars-10mb.xml | 10 MB | 278.5 ms | 17 | 18.0 ms | 18.2 ms | 18.2 ms | **0** | 59.3 |
| cars-50mb.xml | 50 MB | 1165.3 ms | 67 | 18.0 ms | 18.1 ms | 18.5 ms | **0** | 56.8 |
| cars-100mb.xml | 100 MB | 2347.4 ms | 133 | 18.0 ms | 18.1 ms | 18.6 ms | **0** | 56.4 |
| cars-200mb.xml | 200 MB | 4496.6 ms | 253 | 18.0 ms | 18.1 ms | 18.5 ms | **0** | 56.2 |
| cars-500mb.xml | 500 MB | 11563.5 ms | 650 | 18.0 ms | 18.1 ms | 19.8 ms | **0** | 56.2 |

**Passes cleanly, at every size tested, not just the 200 MB bar fixture.** Zero frames over
32 ms across 1,120 total recorded frames, including the 500 MB run's 650 frames over an
11.6 second parse — B11's original claim ("parsing off-thread means the render thread's own
frame cadence should barely notice, no matter how long the parse takes") holds exactly as
stated, now confirmed on the real worker rather than inferred from "it's a separate
thread." The frame time clusters tightly around 18 ms (≈55.6 Hz) rather than nearer 16.7 ms
(60 Hz) — a fixed per-frame cost from Electron's own compositor/DevTools overlay in this
harness, present regardless of what the worker is doing; it does not move with fixture
size, which is the signal that it isn't the parse touching the main thread at all.

## 2. Viewport decoration cost

**Bar:** every A2/A6 latency figure was measured with syntax highlighting off (§13); re-run
with D11's decorations on and see whether it pushes scroll or crossing off the vsync floor.

Same-process A/B on `cars-500mb.xml` (A6b's own deciding fixture), 1 MB window (production
default), 200 scroll frames + 20 boundary crossings per configuration:

| | Scroll p50 | Scroll p95 | Scroll max | % frames > 32 ms | Crossing p50 | Crossing p95 | Crossing max |
|---|---|---|---|---|---|---|---|
| Decorations **on** | 17.6 ms | 23.0 ms | 28.9 ms | 0% | 17.8 ms | 18.7 ms | 18.7 ms |
| Decorations **off** | 17.6 ms | 19.4 ms | 20.8 ms | 0% | 17.6 ms | 17.9 ms | 17.9 ms |
| A6b historical (decorations didn't exist) | — | — | — | — | 16.8 ms | — | 20.8 ms |

**Decorations cost is real but small, and nowhere near the floor.** Scroll p95 goes from
19.4 ms to 23.0 ms (+3.6 ms); scroll max from 20.8 ms to 28.9 ms (+8.1 ms). Crossing cost is
within noise (+0.8 ms max). Both configurations stay at 0% frames over the 32 ms bar across
the whole 200-frame scroll. The crossing numbers land close to A6b's own
historical figures (measured on a different day, different background load — a same-run
comparison is the more reliable read, and it agrees with the historical one regardless).
**§13's question is answered: no, decorations do not push scroll or crossing off the vsync
floor**, on the fixture and window size that matter most. `DECISIONS.md` D-031 updated —
see below.

## 3. End-to-end open time

**Bar:** none existed before this measurement (M0's "< 3 s" covered only the parse function
itself, in-process, not the file read, the worker round trip, or first paint). Proposed
below, from the data, not invented first.

| Fixture | Size | IPC file read¹ | Worker parse + transfer + 1 frame | **Total** |
|---|---|---|---|---|
| cars-10mb.xml | 10 MB | ~51 ms | 286.2 ms | **~337 ms** |
| cars-50mb.xml | 50 MB | ~244 ms² | 1180.0 ms | **~1.42 s** |
| cars-100mb.xml | 100 MB | ~488 ms² | 2359.6 ms | **~2.85 s** |
| cars-200mb.xml | 200 MB | ~955 ms | 4504.0 ms | **~5.46 s** |
| cars-500mb.xml | 500 MB | ~2.39 s | 11574.8 ms | **~13.96 s** |

¹ Cited from `src/main/documents.ts`'s own measurement note (`window.api.document.read`,
real Electron build, these same fixtures: 10 MB ~51 ms, 200 MB ~955 ms, 500 MB ~2.39 s,
~215 MB/s), not re-measured here — D15's harness measures the renderer/worker side, not the
IPC seam, and re-deriving a number that's already measured and cited in the code it
describes would just add noise.
² Interpolated from that same ~215 MB/s rate; 50/100 MB weren't in the original three-point
measurement.

**This is where a real gap shows up: 200 MB takes ~5.46 s to become interactive, not the
3 s the parser alone was budgeted for.** Two things were never in the 3 s figure: the file
read (955 ms of the 5.46 s, 17%) and the worker round trip's own overhead — see the
throughput note below. Reported per this document's own house rule (M0-RESULTS.md's own
words) rather than smoothed over.

**Proposed bar, from this data:** under **1 s** for files up to ~50 MB (reads as instant),
under **6 s** for 200 MB, under **15 s** for 500 MB — provided the main thread stays
responsive throughout (§1 confirms it does) and progress is visibly shown the whole time
(D6 already does this — the `'parsing'` phase with a byte-consumed percentage). A long wait
with visible, honest progress and a responsive window is a materially different experience
from the 3 s figure's implicit "block until done," and this is the number a user actually
experiences, not the parse function in isolation. **This is a bar to set, not one already
met** — flagging per `M1-PLAN.md`'s own "Report back" list ("End-to-end open time on 200 MB
landing somewhere a user would notice" — it does).

> **Corrected on review.** The paragraph below compares two figures that cover different
> work, and the gap it reports is mostly that difference rather than a cost of the worker.
>
> - **65 MB/s** is the parse *function* alone: `CONCEPT.md` §12 states it as "200 MB in
>   ~3.15 s", and `M0-RESULTS.md` lists the row index build (~0.93 s) and `exportBuffers`
>   (~0.16 s) as separate line items on top of it.
> - **45 MB/s** is 200 MB ÷ 4.50 s, and that 4.50 s is parse **plus** row index, line index,
>   `exportBuffers`, transfer and rehydration.
>
> The like-for-like figure already exists: `M0-RESULTS.md`'s own done-criteria table
> measured `runParseJob` **in-process** at **4.3–4.6 s** for this fixture. D15's real worker
> lands at 4.50 s — inside that range. **The worker seam costs nothing measurable**, and the
> speculation below about worker startup and cold JIT is explaining a gap that is largely an
> artifact of scope, not a real one. Nothing here changes the end-to-end open-time finding,
> which stands on its own.

**Worker-path parse throughput is ~45 MB/s, not the ~65 MB/s direct-path figure
`CLAUDE.md`/`M0-RESULTS.md` cite.** Computed from the table above (size ÷ parse-worker-ms):
37.6 MB/s at 10 MB rising to ~45–47 MB/s by 100 MB and holding there through 500 MB — the
small-file number is skewed by worker startup being a fixed cost amortized less at small
sizes, but the plateau from 100 MB up is real and stays below the direct-path figure. D0
made the store/interner transfer zero-copy (a transfer list, not structured clone), so this
isn't a copying cost; the most likely remaining causes are worker startup itself and a cold
JIT in a freshly spawned thread versus a warmed-up main-thread process — plausible, not
independently isolated here. Not a regression (nothing changed about the parser between
that figure and this one), but a real, previously-unmeasured gap between "the parser's own
throughput" and "what the worker seam actually delivers," now on record rather than
conflated.

**Node/row counts cross-check exactly against `M0-RESULTS.md`:** `cars-200mb.xml` —
6,592,652 nodes, 7,796,094 rows — both to the digit, confirming the parser and row index
are unchanged in effect across everything built since (D0 through D14).

**Peak process RSS**, for context (not a substitute for `M0-RESULTS.md`'s own in-process
figure, which remains the right way to read the 800 MB bar — this includes Electron's own
Chromium process baseline, which the in-process Node measurement never had to pay):

| Fixture | RSS before parse | RSS after (worker + transfer + rehydration) |
|---|---|---|
| cars-200mb.xml | 474.3 MB | **776.1 MB** |
| cars-500mb.xml | 1074.5 MB | **1806.8 MB** |

776.1 MB stays under the 800 MB bar, with less headroom than the in-process 589 MB figure
implied — worth knowing before treating that margin as generous. The "before parse"
baseline already includes the file's raw bytes in memory twice over (`fs.readFileSync` plus
the `ArrayBuffer` slice made to transfer them), which is a harness artifact of how this
measurement reads the file, not a product cost — the product reads via IPC once, as a
single `ArrayBuffer`.

> **Corrected on review.** The two halves of that paragraph pull against each other and the
> second one wins. If the baseline carries ~200 MB the product never pays, the product's own
> figure is ~576 MB — which *agrees* with `M0-RESULTS.md`'s in-process 589 MB rather than
> undercutting it. The two measurements corroborate each other; the margin is not thinner
> than it looked.
>
> The honest reading is narrower than either: **the 800 MB bar was not cleanly measured
> here.** The contamination is known to exist and its exact size is not, so 776.1 MB is an
> upper bound on a figure that includes a harness artifact, not a reading of the product.
> M1's done-criterion ("peak RSS across a real 200 MB worker transfer measured against the
> 800 MB bar for the first time") is therefore **not** met. Re-measuring needs the harness to
> release the source `ArrayBuffer` before sampling, or to read through the product's own IPC
> path — worth folding into M2's E10 rather than leaving as a figure that reads more
> alarming than the data supports.

---

## §13 questions settled

### Window size: **1 MB confirmed**

Same-session comparison on `cars-500mb.xml`, decorations on and off, at 256 KB / 1 MB / 4 MB:

| Window | Scroll p95 (on / off) | Crossing p95 (on / off) | Crossing max (on / off) |
|---|---|---|---|
| 256 KB | 21.7 / 19.1 ms | 18.7 / 18.6 ms | 18.7 / 18.6 ms |
| **1 MB** | 23.0 / 19.4 ms | 18.7 / 17.9 ms | 18.7 / 17.9 ms |
| 4 MB | 20.6 / 20.2 ms | **45.3** / 28.8 ms | **45.3** / 28.8 ms |

256 KB and 1 MB perform almost identically on every figure. 4 MB is measurably worse on
crossing specifically — p95 45.3 ms with decorations on, above both the 32 ms frame budget
and A6's own 32 ms crossing bar — reproducing A6/A6b's original finding (larger windows
cost more per crossing, because more text has to be decoded and inserted) on the shipped
mechanism rather than the spike's. **1 MB stays the right choice**: enough margin below
256 KB's crossing frequency (fewer re-slices per byte scrolled) without paying 4 MB's
crossing cost, and it's already what ships. `WINDOW_BYTES` in `rawWindow.ts` is unchanged.

### Row size N: **512 bytes confirmed, not re-swept**

Not re-measured with a fresh parameter sweep — the value hasn't changed since D0.3, and
nothing in D10–D14 surfaced a problem with it. What *is* newly confirmed: `cars-200mb.xml`
produces exactly 7,796,094 rows / lines this session (matching D0.3's own figure to the
digit — see the throughput table above), and D10's window mechanism, built directly on top
of that row index (`computeWindowBounds` snaps to row boundaries), performs exactly to
spec at every size tested in §1–§3. A parameter with no reported problem and matching
numbers three milestones later doesn't need a fresh sweep to justify leaving alone; it needs
a reason to change, which hasn't appeared. Re-scoped per D15's own acceptance criterion
("explicitly re-scoped with a reason") rather than swept for its own sake.

---

## `DECISIONS.md` updated

D-031's "Revisit if: M1 finds that viewport decorations push in-window latency off the
floor" is answered — they don't (§2 above). Addendum added to D-031 rather than a new
entry, since this closes that decision's own stated open question rather than raising a new
one.

## What this does not cover

- **Tree's own virtualized-scroll frame time is not separately measured.** The M1
  definition of done names it explicitly ("tree scrolls with no frame over 32 ms"); this
  pass measured Raw's scroll (§2) and the worker's main-thread impact (§1), not a scripted
  scroll through `@tanstack/react-virtual`'s rendered rows. Tree's own per-row work (a glyph
  and a text label, no decoding beyond what's already visible) is simple enough that a
  problem here would be surprising, but "would be surprising" is a reason to measure it, not
  a substitute for having done so — a real gap, not an oversight to gloss over.
- **Minified-document decoration cost** (`cars-100mb.min.json`) — the scroll harness parses
  via the real XML format module directly; wiring the JSON module in for one fixture was
  judged not worth the time against this pass's actual asks (§13 names cars-500mb.xml as
  the deciding fixture for both window size and, by extension, decoration cost). Wrap
  behavior on minified documents is D12's own concern and unaffected by decorations, which
  only affect what's drawn, not whether the window can scroll.
- **50/100 MB IPC read times** are interpolated from the existing ~215 MB/s figure, not
  independently measured — see the open-time table's own footnote.
- **Tree/Detail first-render cost** is not measured separately from parse+transfer. D8's
  Tree renders exactly one row (the collapsed root) on open regardless of document size, so
  its own contribution to "time to interactive" is negligible by construction, not by
  omission — but this was reasoned, not measured, and is worth a real number if a future
  pass has budget for one.
