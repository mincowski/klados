# M0a — Spike results

Purpose: replace two assumptions with measurements (see `M0-PLAN.md` §M0a).

**Status: complete.** A1–A6b done, all decision tables applied.

**Headline:** both original assumptions hold, and more comfortably than expected.
CodeMirror 6 handles a 500 MB document with **17 ms p95 keystroke latency** and the
byte-scanning TypeScript parser runs at **200 MB/s**. The large-file threshold is
therefore set to **500 MB** by the A5 decision table.

**But** the A5 decision table's metrics do not cover the one thing that did fail:
**scrolling**. See [§Scrolling](#the-metric-the-decision-table-does-not-cover) — it is
the reason the recommendation there is not simply "delete large-file mode."

**A6, added after A5, tests the cheaper fix for exactly that gap:** never give
CodeMirror the whole document — feed it a small window around the current position and
reconstruct offsets as `origin + localOffset`. Typing and opening are transformed
(20–200× faster, memory near-zero instead of gigabytes) and random-access "jump" cost
drops by ~20–45× versus whole-document scrolling. The one place windowing did **not**
clear A6's strict bar was the cost of **crossing** a window boundary mid-scroll —
43 ms against a 32 ms line — which A6's decision table resolved mechanically to "stop
and report," with a practical caveat spelled out in
[§A6 recommendation](#a6-recommendation): the bar was cleared using the simplest
possible re-slice mechanism (a full document-text replace), and the recommendation was
that a more sophisticated one would very likely close the gap.

**A6b confirms exactly that.** Replacing the full-text replace with the two edge changes
a re-centred window actually represents — drop the leading edge, append the trailing
edge, leave the shared middle untouched — collapses crossing cost to the **vsync floor
(16.8 ms p50, 20.8 ms max)** and, more importantly, **top-of-viewport and caret drift
both measure exactly 0 bytes across 60 boundary crossings**, with no manual
repositioning code and no `scrollTop` reset. CodeMirror's own change-mapping does the
work A6 was doing by hand. Soft wrap also confirmed: a 100 MB single-line document gets
a genuine scrollable window (~5,800 visual lines) once wrap is on, with the same
frame-perfect figures. **Every A6b bar passes — windowing is confirmed as specified.**
See [§A6b](#a6b--windowing-confirmation-) for the full numbers.

---

## Environment

| | |
|---|---|
| CPU | Intel Core i5-4670 @ 3.40 GHz (4 cores, no HT, Haswell, 2013) |
| RAM | 24 GB |
| OS | Windows 11 Pro 26100 |
| Node | v24.15.0 |
| Electron | 38.8.6 (Chromium 140, Node 22.22) |
| CodeMirror | `@codemirror/state` 6.5.x, `@codemirror/view` 6.38.x |
| Display | 60 Hz |

> **Read every figure as a lower bound.** This is a twelve-year-old desktop CPU with
> roughly half the per-core throughput of a current laptop. Decisions below are applied
> to these numbers as written, which biases every one toward the conservative choice.

Throughout, **MB means 1024×1024 bytes.**

### One measurement caveat that affects every latency number

Keystroke latency is measured as `dispatch()` → next `requestAnimationFrame`, as
`M0-PLAN.md` A2 specifies. On a 60 Hz display that has a **hard floor of ~16.7 ms**:
one vsync interval. Essentially every pretty-printed result below reports p50 = 16.6–16.7 ms,
which does not mean "typing takes 16.7 ms" — it means **the transaction and re-render
completed within a single frame and the measurement is dominated by waiting for vsync.**

This matters for reading the results: 17 ms is not a latency figure, it is a *floor*, and
the real conclusion is "CodeMirror's cost is below the frame budget at every size tested."
The minified fixture, which reports 25–180 ms, is the only one that escapes the floor —
which is precisely what makes it interesting.

---

## A1 — Fixture generator ✅

**File:** `spike/generate-fixtures.ts`
**Run:** `node spike/generate-fixtures.ts [name…]` — Node 24 runs TypeScript directly via
type-stripping, so the spike needs no build step and no dependencies.

Output goes to `spike/fixtures/`, gitignored via `spike/.gitignore`.

| File | Target | Actual | Δ | Time |
|---|---|---|---|---|
| `cars-10mb.xml` | 10 MB | 10.00 MB | +0.0004% | 0.1 s |
| `cars-50mb.xml` | 50 MB | 50.00 MB | +0.0008% | 0.3 s |
| `cars-100mb.xml` | 100 MB | 100.00 MB | +0.0002% | 0.6 s |
| `cars-200mb.xml` | 200 MB | 200.00 MB | +0.0001% | 1.2 s |
| `cars-500mb.xml` | 500 MB | 500.00 MB | +0.00004% | 3.2 s |
| `cars-100mb.json` | 100 MB | 100.00 MB | +0.0002% | 0.8 s |
| `cars-100mb.min.json` | 100 MB | 100.00 MB | +0.0001% | 1.3 s |
| `deep-10k.json` | small | 19.5 KB | — | <0.1 s |
| `deep-1m.json` | small | 1.91 MB | — | <0.1 s |

Whole set: **7.6 s**, 977 MB on disk.

### Acceptance

| Criterion | Result |
|---|---|
| All files generated | ✅ 9/9 |
| `cars-500mb.xml` within 5% of 500 MB | ✅ 524,288,214 B — **0.00004%** over |
| Generator peak memory under 200 MB | ✅ **193.6 MB** peak RSS |

At peak RSS 193.6 MB, `heapUsed` was 67.3 MB and `external` 14.6 MB — live set ~82 MB,
the remaining ~110 MB being V8 arena not yet returned to the OS. Re-running under
`--max-old-space-size=96` gives 184.3 MB at identical throughput, confirming the
generator is not holding it. Nothing larger than one 512 KB chunk is ever live.

### Shape of the data

Template follows `CONCEPT.md` Appendix A (`garage › cars › elements › car`), so the
fixtures also exercise the transparent-wrapper rule (§4.3) later. Measured variance in
`cars-10mb.xml` (31,655 records):

| Feature | Target | Actual |
|---|---|---|
| Records omitting optional `color` | ~10% | 9.7% |
| Records with scalar `<engine>petrol</engine>` | ~10% | 9.7% |
| Records with `<sunroof/>` present | — | 34.8% |
| Mean `<owner>` elements per record | — | 1.26 (1–3) |

Deterministic (mulberry32, seed `0x5eed`), pure ASCII, streamed with backpressure into
one reused `Buffer`.

### Verification beyond the stated criteria

A benchmark against a malformed fixture would waste the entire spike, so:

- `cars-100mb.json` and `cars-100mb.min.json` both round-trip through `JSON.parse`
  (334,301 and 582,891 records).
- `cars-100mb.min.json` contains **0 newlines** — genuinely one 100 MB line.
- `cars-10mb.xml` is well-formed: independent tag-balance scan gives 329,573 elements,
  max depth 6, 0 unclosed — matching A3's parser exactly.

---

## A2 — CodeMirror latency and memory ✅

**Files:** `spike/codemirror-harness/` — minimal Electron app (`main.cjs`, `renderer.js`,
Vite-bundled), driver `run-all.js`, raw output in `out/*.json`.

Electron rather than a plain Vite page, because A2 asks for renderer **RSS**, which a
browser page cannot report (`performance.memory` gives JS heap only, not resident set).
Each fixture runs in its **own Electron process** so memory figures are not contaminated
by the previous run.

Editor configured per plan: `lineNumbers()` only — **no** syntax highlighting, **no**
history extension, **no** line wrapping.

### Results

| Fixture | Load | RSS Δ | Type p95 @1% | @50% | @99% | Replace |
|---|---|---|---|---|---|---|
| `cars-10mb.xml` | 107 ms | +50.7 MB | 17.3 | 17.7 | 17.4 | 75 ms |
| `cars-50mb.xml` | 365 ms | +176.2 MB | 17.1 | 17.7 | 17.3 | 432 ms |
| `cars-100mb.xml` | 675 ms | +282.9 MB | 17.3 | 17.7 | 17.5 | 663 ms |
| `cars-200mb.xml` | 1236 ms | +489.8 MB | 17.7 | **17.3** | 17.4 | 1404 ms |
| `cars-500mb.xml` | 2890 ms | +1115.5 MB | 17.5 | **17.5** | 17.5 | 3485 ms |
| `cars-100mb.json` | 689 ms | +281.5 MB | 16.9 | 17.8 | 17.1 | 650 ms |
| `cars-100mb.min.json` | **49 ms** | **+102.7 MB** | **139.6** | **177.2** | **179.0** | 18 ms |

All latencies in ms. Bold = the decision-table metric, and the outlier.

Nothing crashed, hung, or hit a timeout. p50 keystroke latency was **16.6–16.7 ms at every
pretty-printed size from 10 MB to 500 MB** — the vsync floor, i.e. below one frame.

### Memory

RSS delta converges on **~2.2× file size** (10 MB: 5.0×, 50 MB: 3.5×, 100 MB: 2.8×,
200 MB: 2.5×, 500 MB: 2.2×; small files are dominated by fixed overhead). This is
consistent with `CONCEPT.md` §8's claim that CodeMirror keeps a UTF-16 copy — 2× the
source — plus per-line rope overhead. **§8's reasoning is confirmed; its conclusion is
not** (see A5).

**A separate memory finding, not asked for but important.** RSS *after the full-document
replacement*, following a forced GC, was far higher than after load:

| Fixture | After load | After replace |
|---|---|---|
| `cars-100mb.xml` | 359 MB | 1411 MB |
| `cars-200mb.xml` | 567 MB | 2592 MB |
| `cars-500mb.xml` | 1191 MB | 5694 MB |

Part of this is the harness holding the replacement string by design, so treat it as an
upper bound rather than a clean measurement. But the direction is real and it bears on
`CONCEPT.md` §5.5: a **Transform transiently holds the old document, the new document and
the source text at once**. At 500 MB that is a multi-gigabyte spike on an operation the
concept describes as routine. Worth an explicit streaming or chunked design in M5 rather
than a single `dispatch` replacing everything.

### The minified file — the plan asked specifically, and the answer is yes

`M0-PLAN.md` A2: *"does the minified 100 MB JSON behave differently from the
pretty-printed one? … This is an important result either way."*

**It behaves dramatically differently, in both directions.**

| Metric | `cars-100mb.json` (3.76 M lines) | `cars-100mb.min.json` (1 line) | Ratio |
|---|---|---|---|
| Load | 689 ms | **49 ms** | 14× *faster* |
| RSS delta | 281.5 MB | **102.7 MB** | 2.7× *smaller* |
| Keystroke p50 | 16.7 ms | **25.0–27.6 ms** | 1.6× slower |
| Keystroke p95 | 17.8 ms | **139.6–179.0 ms** | **~10× slower** |
| Full replace | 650 ms | 18 ms | 36× faster |

Loading and memory get *better* — one line means almost no rope structure to build. But
**typing gets about ten times worse and is the only configuration in the entire spike
that escapes the vsync floor.** Every keystroke must re-process a 100 MB line, and p95
approaching 180 ms is squarely in "the editor feels broken" territory.

Note the scroll figure for this fixture (0% of frames over 32 ms) is **meaningless** — a
one-line document has nothing to scroll vertically. It should not be read as a good result.

### The metric the decision table does not cover

Scroll smoothness was measured two ways, because they answer different questions:
viewport-sized jumps (page-down navigation, worst case) and 100 px steps (mouse wheel).

| Fixture | Jump p50 | Jump >32 ms | Wheel p50 | Wheel p95 | Wheel >32 ms |
|---|---|---|---|---|---|
| `cars-10mb.xml` | 16.7 ms | 0% | 16.6 ms | 23.4 ms | 0% |
| `cars-100mb.xml` | 67.0 ms | 59.0% | 16.7 ms | 105.9 ms | 11.5% |
| `cars-200mb.xml` | 150.9 ms | 100% | 16.7 ms | 199.5 ms | 24.5% |
| `cars-500mb.xml` | 394.9 ms | 100% | **266.0 ms** | 634.9 ms | 53.5% |

This is the one place CodeMirror degrades with document size, and it degrades badly:

- **≤ 10 MB** — flawless.
- **100 MB** — wheel scrolling holds a 16.7 ms median with occasional ~100 ms stalls
  (11.5% of frames). Noticeable but usable. Page-down is sluggish at 67 ms.
- **200 MB** — median still one frame, but a quarter of frames exceed 32 ms and p95 is
  ~200 ms. Visibly janky. Page-down at 151 ms feels broken.
- **500 MB** — **median** frame is 266 ms. This is not jank, it is unusable scrolling,
  even though typing at the same size is still frame-perfect.

The asymmetry is the interesting part: **typing cost is independent of document size,
scrolling cost is not.** CodeMirror's rope makes a localised edit cheap regardless of
scale, but vertical navigation must consult a height map across 19.5 M lines, and at
500 MB the document is also tall enough (~370 M px at ~19 px/line) to exceed Chromium's
maximum element height, forcing scaled scrolling on top.

---

## A3 — Parser throughput ✅

**File:** `spike/xml-throughput.ts`

A minimal byte-scanning XML scanner: element and attribute boundaries written into
pre-allocated `Int32Array`s, explicit open-element stack, no interning, no validation, no
tree beyond a depth counter. Best of 3 runs (1 at 500 MB), after a JIT warm-up pass.

| Fixture | Throughput | Time | Nodes | Elements | Attributes |
|---|---|---|---|---|---|
| `cars-100mb.xml` | **200 MB/s** | 500 ms | 9,778,133 | 3,296,386 | 601,524 |
| `cars-500mb.xml` | **207 MB/s** | 2421 ms | 48,890,978 | 16,481,883 | 3,006,955 |

Peak memory of the resulting arrays: 198 MB used (281 MB allocated) at 100 MB;
990 MB used (1406 MB allocated) at 500 MB. Process RSS reached 1545 MB on the 500 MB run.

An earlier revision of the probe measured 248 MB/s; adding the whitespace-only
classification that `M0-PLAN.md` B9 requires cost ~20%. **200 MB/s is the honest figure**
because the real parser must do that work.

Element count (329,573 in the 10 MB fixture) matches the independent tag-balance check
exactly, so the scanner is counting the right things.

### ⚠️ Node density is 5× denser than `CONCEPT.md` assumes

This is the most consequential finding in the spike and it was not something A3 set out
to measure.

| | `CONCEPT.md` | Measured |
|---|---|---|
| Bytes of source per node | ~50 (§3.2) / ~60 (§8) | **10.7** |
| Nodes in a 200 MB XML file | ~3.3 M (§8) | **~19.6 M** |

The cause: **~40% of all nodes are whitespace-only text nodes.** Pretty-printed XML puts
a newline and indentation between every pair of tags, and `M0-PLAN.md` B9 requires a Text
node for each one ("Whitespace-only text between elements still produces a Text node").
Measured consistently at **39.9%** of all nodes across both the 100 MB and 500 MB fixtures.

Counting elements only gives 31.8 bytes/element — still roughly **2× denser** than §8's
60 B/node, before whitespace is considered at all.

Reworking §8's memory budget for a 200 MB XML file at measured density:

| Component | §8 estimate | Measured projection |
|---|---|---|
| Source buffer | 200 MB | 200 MB |
| Node store @ 38 B/node | ~125 MB (3.3 M nodes) | **~745 MB** (19.6 M nodes) |
| Attribute table | ~50–100 MB | ~19 MB (1.2 M attrs × 16 B) |
| Row index | ~20 MB | ~20 MB |
| **Total** | **~445 MB (2.2×)** | **~985 MB (4.9×)** |

**The "~2.5× the file size" rule of thumb in §8 is wrong for pretty-printed XML; the real
figure is ~5×.** At 500 MB that projects to ~2.5 GB for the node store alone, against §8's
stated ~1.3 GB total. This does not block M0b, but it invalidates several downstream
numbers: the soft-cap confirmation text in §11.2 (*"this file needs ~1.3 GB"*), the tab
memory budget in §11.4, and the M0 done-criterion of "200 MB parses with total process
memory under 600 MB" — which on this evidence is **not achievable** with whitespace text
nodes retained, since the node store alone would be ~745 MB.

The lever is obvious and worth a design decision before B6/B9: whitespace-only text nodes
are 40% of the store and carry almost no information. Options — not chosen here, since
this is a design call rather than a spike result:

1. Do not emit nodes for whitespace-only text between elements; record a flag on the
   parent. Loses byte-exact reconstruction from the model, which §5.1 says is not needed
   because the buffer is the source of truth.
2. Emit them but store them in a cheaper side structure.
3. Accept ~5× and revise §8, §11.2 and §11.4 to match.

Option 1 alone takes the 200 MB projection from ~985 MB back to ~640 MB.

---

## A4 — Offset shift ✅

**File:** `spike/offset-shift.ts` — 20 runs, JIT warmed, arrays pre-faulted.

| Configuration | Data touched | min | **p50** | p95 |
|---|---|---|---|---|
| **As specified** — 4 × `Int32Array(10,000,000)` | 153 MB | 50.4 ms | **51.4 ms** | 54.2 ms |
| At measured 500 MB density — 4 × `Int32Array(48,890,978)` | 746 MB | 227.8 ms | **231.5 ms** | 280.6 ms |

Effective bandwidth ~3.0 GB/s in both cases, so the cost is purely linear in node count.

The specified probe lands at **51.4 ms — one millimetre over the 50 ms decision boundary**,
which would be an uncomfortable basis for a decision on its own. But the 10 M figure comes
from `CONCEPT.md`'s ~50 B/node assumption, and A3 measured 10.7 B/node: a real 500 MB
document has **48.9 M nodes**, making the true cost **231.5 ms**. The marginal call
disappears.

Only the four offset arrays (`valueStart`, `valueEnd`, `spanStart`, `spanEnd`) need
shifting — `parent`, `firstChild`, `nextSibling` and `prevSibling` hold node indices, not
byte offsets, and are unaffected by an edit. The row index shifts too, adding to the total.

---

## A5 — Decision table, applied

Applied mechanically, as instructed.

### CodeMirror threshold

Deciding metric: **p95 keystroke latency at the 50% position, 200 MB = 17.3 ms**
(17.0 ms in a second run). Memory delta at 200 MB = **489.8 MB**.

> Row 1: *p95 < 50 ms **and** memory delta < 1.5 GB* → 17.3 ms < 50 ms ✅,
> 489.8 MB < 1.5 GB ✅.
> → *"Set threshold to **500 MB**. Verify at 500 MB; if that also passes, large-file mode
> is not needed in v1 and M6 can be deferred."*

Verification at 500 MB: p95 @50% = **17.5 ms** < 50 ms ✅; memory delta = **1115.5 MB**
< 1.5 GB ✅. **Passes.**

### ✅ DECISION: large-file threshold is 500 MB

`CONCEPT.md` §8's 50 MB figure was wrong by a factor of ten, and the §1/§8 conflict flagged
in the concept **disappears**: CodeMirror comfortably hosts the 100–200 MB working target,
with 500 MB still within the memory bound. The blocking open question in §13
("Large-file editing ceiling") is **resolved** — the custom viewer does not need
single-span editing, and §1's target does not come down.

### ⚠️ …with one qualification the decision table cannot see

The table decides on keystroke latency and memory only. On those metrics 500 MB passes
cleanly. But **scroll performance fails well before 500 MB**, and a document you cannot
scroll is not usable regardless of how fast typing is.

Reading the scroll data against the same "is this comfortable?" bar:

| Size | Typing | Memory | Scrolling | Verdict |
|---|---|---|---|---|
| ≤ 100 MB | ✅ frame-bound | ✅ 283 MB | ⚠️ 11.5% frames >32 ms | Comfortable |
| 200 MB | ✅ frame-bound | ✅ 490 MB | ⚠️ 24.5% frames >32 ms, p95 200 ms | Usable, visibly janky |
| 500 MB | ✅ frame-bound | ✅ 1116 MB | ❌ **266 ms median frame** | Editing fine, navigation unusable |

So the honest statement is: **the threshold at which CodeMirror must be replaced for
*editing* is above 500 MB, but the threshold at which it stops being pleasant to *navigate*
is around 100–200 MB.** These are different problems with different fixes, and the second
one is not what large-file mode was designed to solve — a custom virtualized viewer over
the byte buffer would in fact scroll *better*, since uniform row heights over a row index
make scroll position arithmetic rather than a height-map lookup.

**Recommendation** (a recommendation, not a decision — this is the user's call):

- Set the large-file editing threshold to **500 MB** as the table directs.
- Do **not** delete the scale milestone. Re-aim it: its justification is no longer
  "CodeMirror cannot hold the document" but "CodeMirror cannot scroll it smoothly."
- Keep it deferred past M1–M4 as the table permits, since ≤100 MB is comfortable today.

### Minified files — recorded separately as the plan requires

> *"If the minified 100 MB JSON performs dramatically worse … it may mean the
> Format-on-open prompt (§5.7) is mandatory rather than optional, and should move earlier
> in the roadmap."*

It does: **~10× worse p95 keystroke latency** (179 ms vs 17.8 ms), and the only fixture in
the spike to exceed one frame. **The trigger condition is met.** On this evidence the
Format-on-open prompt should be treated as mandatory rather than optional, and pulled
earlier than M5.

Two things make this cheaper than it sounds: minified documents *load* faster and use
*less* memory, so formatting them is affordable; and JSON is the one format where
formatting is unconditionally safe (§5.7), which is exactly the format minification
happens to.

### Parser language

Throughput at 100 MB = **200 MB/s**.

> Row 1: *≥ 100 MB/s* → *"TypeScript parsers confirmed. Proceed with M0b as written."*

### ✅ DECISION: parsers stay in TypeScript

2× the threshold on a 2013 CPU, and holding 207 MB/s at 500 MB, so it does not degrade
with scale. The WASM escape hatch (§10.1) stays unused. Record **200 MB/s** as the
regression baseline.

Extrapolating to the M0 done-criterion — `cars-200mb.xml` parsed in under 3 s — the raw
scan takes ~1.0 s, leaving ~2 s of budget for interning, tree links and sink overhead.
Achievable, but not with room to spare.

### Delta list

Bulk shift of 4 × 10 M `Int32` = **51.4 ms p50**.

> Row 2: *≥ 50 ms* → *"Delta list is mandatory as specified."*

### ✅ DECISION: the pending-delta list of §5.2 is mandatory

The specified probe only just clears the boundary (51.4 vs 50 ms), but at the node density
A3 actually measured the figure is **231.5 ms** — four and a half times over. Implement
§5.2 as written.

---

## A6 — Windowed CodeMirror ✅

Added after A1–A5, in direct response to A5's scrolling finding. CodeMirror never
receives the whole document — it gets a window of bytes around the current position,
sliced at character boundaries, with absolute offsets reconstructed as
`origin + localOffset`. If this holds, the tiered Raw View, the large-file threshold, and
M5's custom viewer all become unnecessary.

**Files:** `renderer-windowed.js` (measurement), `harness-lib.js` (shared with A2,
including the windowing primitives — `snapForward`, `sliceWindow`, `buildLineIndex`,
`computeOrigin`), `main-windowed.cjs`, `run-all-windowed.js`. Same rules as A1–A5:
throwaway, no tests, no polish.

Window sizes: 256 KB, 1 MB, 4 MB. Fixtures: `cars-200mb.xml`, `cars-500mb.xml`,
`cars-100mb.min.json`. The file is read once as a `Buffer` (never decoded in full) and
reused across all three window sizes per fixture. A line-start index is built once per
fixture via `Buffer.indexOf(0x0a, …)` (native memchr, no decode) so displayed line
numbers match the whole file — this is structurally the row index `CONCEPT.md` §3.1
describes for the real product, reused here only for cosmetics.

### Three bugs found and fixed while building the harness

Worth recording on their own, because two of them are exactly the kind of mistake a real
windowed Raw View implementation could make and should guard against.

1. **A fractional byte offset silently corrupts UTF-8 boundary snapping.**
   `windowBytes * 0.2` (used to re-centre a window with hysteresis) is `52428.8` for a
   256 KB window — not an integer. `snapForward`'s continuation-byte check
   (`buf[offset] & 0xc0 === 0x80`) reads `buf[52428.8]`, which is `undefined`;
   `undefined & 0xc0` is `0`, so the check silently never advances and the fractional
   offset survives all the way into `EditorView.scrollIntoView`, where CodeMirror throws
   `"No tile at position 52428.8…"` — **off an internal async pass, not synchronously**,
   so the failure surfaces nowhere near its cause and the process just hangs until the
   harness's own timeout. Fixed at the source (floor before use) and defensively inside
   `sliceWindow` itself, so no caller can reintroduce it. **Any real implementation that
   computes a byte offset via multiplication or division before slicing needs an explicit
   integer guard** — this is not a spike-only concern.
2. **A stale `scrollTop` after a document swap.** Replacing the window's content changes
   its height; leaving `scrollTop` at its pre-swap value makes CodeMirror query its height
   map at a now out-of-range position on its next internal measure pass. Fixed by
   resetting `scrollTop = 0` immediately after every document replacement, before
   anything else touches geometry.
3. **A self-inflicted hang from fixed-pixel scroll steps.** The spec's realistic
   100 px wheel step is fine against a whole-file scroll height, but a *window* is small
   on purpose — even a 256 KB window holds ~8,000 lines (~160,000 px) — so climbing to
   an 80%-depth trigger 100 px at a time needs 1,000+ awaited frames, repeated after every
   one of 20 crossings, for every window size. Fixed by scaling the step to the window's
   own height (~60 steps span it, regardless of size) — still genuinely incremental
   scrolling, just not wheel-sized.

A fourth issue is a genuine finding rather than a bug: **a single-line document (the
minified JSON fixture) has almost no vertical scroll range within any window** — the
whole window is one enormous line, so `scrollTop` cannot advance and boundary-crossing-
by-scrolling literally cannot occur. The harness detects this (`scrollHeight <=
clientHeight`) and reports it explicitly rather than hanging or faking a 0-crossings
result. **This is a real product question, not just a test artifact**: a windowed Raw
View needs a navigation trigger for minified documents that doesn't depend on vertical
scroll — horizontal scroll position, or an explicit "load more" affordance, since the
mechanism this spike (and presumably the real design) leans on for panning the window
forward does not exist for a one-line file.

### Results

All figures in ms unless noted. "Crossing" rows are boundary-crossing frame time (§item
6); drift is reported after settling a few extra frames to distinguish CodeMirror's
async viewport refinement from genuine positional error (see note below).

**`cars-200mb.xml`**

| Window | Open | RSS Δ | Type p95 (1/50/99%) | Scroll (in-window) p95 | Reslice p50/p95 | Crossing p50/p95/max | Drift top/caret |
|---|---|---|---|---|---|---|---|
| 256 KB | 24.3 | +1.5 MB | 17.6 / 17.5 / 17.0 | 20.1 | 16.7 / 16.9 | 29.4 / 41.7 / 41.7 | 32 / 0 B |
| 1 MB | 29.1 | −2.6 MB | 16.8 / 16.8 / 17.4 | 23.8 | 16.7 / 16.9 | 29.5 / 41.0 / 41.0 | 43 / 0 B |
| 4 MB | 17.5 | −9.1 MB | 16.9 / 17.4 / 17.7 | 25.5 | 15.4 / 35.2 | 46.2 / 60.2 / 60.2 | 41 / 0 B |

**`cars-500mb.xml`** — the deciding fixture

| Window | Open | RSS Δ | Type p95 (1/50/99%) | Scroll (in-window) p95 | Reslice p50/p95 | Crossing p50/p95/max | Drift top/caret |
|---|---|---|---|---|---|---|---|
| 256 KB | 23.6 | +2.3 MB | 17.0 / 17.6 / 17.5 | 24.7 | 16.7 / 18.4 | 29.7 / 60.1 / 60.1 | 34 / 0 B |
| **1 MB** | **16.1** | **−3.1 MB** | 16.9 / 16.8 / 17.7 | 25.0 | **16.7 / 17.4** | **29.2 / 43.2 / 43.2** | **32 / 0 B** |
| 4 MB | 16.1 | −9.0 MB | 16.8 / 17.1 / 17.2 | 28.3 | 14.4 / 32.3 | 45.6 / 76.3 / 76.3 | 34 / 0 B |

**`cars-100mb.min.json`** — recorded separately per the plan (see below)

| Window | Open | RSS Δ | Type p95 (1/50/99%) | Scroll p95 | Reslice p50/p95 | Boundary crossing |
|---|---|---|---|---|---|---|
| 256 KB | 20.4 | +0.6 MB | 16.9 / 16.8 / 16.8 | 16.8 | 16.7 / 16.8 | skipped — no scroll range |
| 1 MB | 17.8 | −5.3 MB | 16.8 / 16.8 / 16.8 | 16.9 | 16.7 / 16.8 | skipped — no scroll range |
| 4 MB | 14.6 | −21 MB | 16.9 / 16.8 / 16.8 | 16.8 | 16.7 / 16.8 | skipped — no scroll range |

Negative RSS deltas (e.g. −21 MB) are GC noise at this scale, not real savings — the
absolute figures are all within a few tens of MB, negligible next to A2's whole-document
deltas. The **offset round-trip check** (item 7 — a correctness gate, run before every
other measurement for a given window/fixture pair) passed on **all 9 window/fixture
combinations**, at the 1%, 50% and 99% file positions each: reconstructed
`origin + localOffset` matched the intended absolute offset exactly, and the inserted
test character landed at the expected position every time.

**A note on the drift numbers.** They are read back a few frames after the reslice, not
immediately — CodeMirror's viewport plugin does a coarse initial layout pass and refines
over subsequent frames, and reading back before it settles reports that imprecision as if
it were positional error. With the extra settle, top-of-viewport drift is a steady
30–43 bytes across every fixture and window size — under one XML line, i.e. line-snapping
from `y: 'start'` alignment, not accumulating error. Caret drift is exactly 0 in every
case. (An earlier version of the test showed caret drift up to 2.5 MB; that was a bug in
the test's caret handling — a caret carried forward across many crossings while the
window pans away from it eventually falls outside the *next* window's byte range, and
CodeMirror's silent clamp of the resulting out-of-range selection was being misread as
drift. Fixed by re-anchoring the caret near the tracked scroll position on every crossing,
which still exercises genuine cross-reslice preservation — just of a position guaranteed
to be in-window on both sides.)

### Decision table, applied

Deciding metrics, both at **1 MB window on `cars-500mb.xml`**: re-slice p95, and frame
time / drift while crossing a boundary.

| Metric | Value | Row 1 bar |
|---|---|---|
| Re-slice p95 | 17.4 ms | < 16.7 ms — **fails** (by 0.7 ms) |
| Crossing p95 | 43.2 ms | < 32 ms — **fails** |
| Crossing max | 43.2 ms | < 50 ms — passes |
| Drift | 0 bytes | = 0 — passes |

Row 1 (windowing confirmed outright) does not apply. Row 2 requires the *same* crossing
and drift bar as row 1 while only relaxing the re-slice figure — crossing p95 fails that
bar (43.2 ≥ 32 ms), so row 2 does not apply either. That satisfies row 3's condition
directly (*"crossing p95 ≥ 32 ms"*):

> Row 3: *"Stop and report. Windowing does not hold. Fall back to CodeMirror over the
> whole document, and §8 and M5 need re-planning around scroll performance instead."*

### ⚠️ DECISION (mechanical): stop and report — windowing does not clear the bar

Applied exactly as instructed, without reinterpreting the table.

### A6 recommendation

The mechanical result should not be read as "windowing failed." Every other figure is a
large, unambiguous win, and the one figure that missed its bar missed it by an amount
that matters far less than the bar's strictness implies:

- **Open cost**: 16.1 ms vs A2's 2890 ms for the same 500 MB file — **~180× faster**.
- **Memory**: −3.1 MB vs A2's +1115.5 MB — a windowed Raw View would not meaningfully
  add to the document's resident footprint at all.
- **In-window scrolling**: 25.0 ms p95 vs A2's 634.9 ms p95 wheel-scroll at 500 MB —
  **~25× better**, because a window's scroll height is bounded regardless of file size.
- **"Locate in source" (reslice as a proxy for a random jump)**: 17.4 ms p95 vs A2's
  754.3 ms p95 viewport-jump figure at 500 MB — **~43× faster**.
- **Minified files stop being a special case**: keystroke p95 on `cars-100mb.min.json`
  drops from A2's **179 ms** (whole document) to **16.8–16.9 ms** in every window size
  tested — the vsync floor, indistinguishable from any other fixture. See the dedicated
  note below; this has its own downstream consequence.

Against that, **crossing a window boundary costs 29–46 ms p50, 41–76 ms p95** across the
sizes and fixtures tested, worse than the 32 ms bar. Two things temper this:

1. **It is a boundary event, not a steady-state cost.** A5's scroll failure at 500 MB was
   a **266 ms median for every single scroll frame** — this is 29–76 ms once per
   `windowBytes × ~0.6` bytes of scrolling (e.g. roughly once every 600 KB scrolled for a
   1 MB window). The user-perceptible profile is "smooth scrolling with an occasional
   brief pause," not "the whole gesture is slow," which is a materially different (and
   much better) experience than what A5 measured.
2. **The reslice mechanism tested here is the simplest possible one** — a full
   `dispatch({changes: {from: 0, to: length, insert: newText}})`, replacing the entire
   window's text on every crossing. A real implementation has room the spike does not:
   incremental patching at the shared edge between old and new window (most of a
   re-centred window's content already existed in the old one), avoiding the full-text
   replacement this measurement pays for every time.

**Recommendation** (a recommendation, not a decision — this is the user's call): treat
A6 as **strong evidence for Option D**, not as its rejection. Windowing is very likely
the right direction; the specific number that missed its bar is the one most likely to
improve with an implementation more sophisticated than this spike's, and even at the
measured (unoptimized) figure, boundary crossing is an infrequent-event cost rather than
a per-frame one. Suggested path: prototype incremental re-window patching during M0b/M1
and re-measure crossing cost specifically, rather than discarding the windowing approach
or reinstating the large-file/custom-viewer split A5 was trying to avoid.

### Keystroke latency on the minified fixture, recorded separately

Per the plan: *"If a windowed slice sits at the vsync floor, the latency argument for
promoting Format-on-open disappears and only the readability argument remains."*

It does sit at the floor: **16.8–16.9 ms p95 in every window size**, against A2's 179 ms
with the whole file loaded. **The latency argument for mandatory Format-on-open
(A5) no longer holds under windowing.** What remains is the readability argument alone —
a 100 MB single line is still unpleasant to read and navigate structurally regardless of
typing speed, and the boundary-crossing mechanism itself does not work on a one-line file
at all (see the harness finding above), so *some* accommodation for minified documents is
still needed. But the specific trigger condition A5 used (typing latency) is resolved by
windowing rather than by formatting, which changes where Format-on-open belongs: a
readability convenience offered on open, not a requirement forced by an editing-latency
cliff.

---

## A6b — Windowing confirmation ✅

A6's "stop and report" rested on two things it inferred rather than measured: that a
full-document-replace re-slice is the ceiling on crossing cost, and that soft wrap would
actually give a minified document a scrollable window. The decision to adopt windowing
was already made (`DECISIONS.md` D-031); this closes both inferences with numbers before
M1 commits the Raw View to it.

**Files:** `renderer-a6b.js`, `main-a6b.cjs`, `index-a6b.html`, `run-a6b.js`; reuses
`harness-lib.js` (with `computeWindowBounds` factored out of `sliceWindow` so the
incremental path can decode only the small edge diffs instead of the whole window).
Same rules as A1–A6: throwaway, no tests, no polish. One fixed configuration each for
Part 1 and Part 2 — no window-size sweep, so one Electron process covers everything
(51 s wall time for both parts, reading a 500 MB and a 100 MB buffer once each).

### Part 1 — Incremental re-windowing

A6 re-sliced with `dispatch({changes: {from: 0, to: length, insert: newText}})` — a full
replacement. A re-centred window shares most of its content with the old one, so this
replaces that with the two edits the move actually represents:

```
sharedStart = max(oldStart, newStart);  sharedEnd = min(oldEnd, newEnd)
front change: [0, sharedStart-oldStart)   -> decode(buf, newStart, sharedStart)
back  change: [sharedEnd-oldStart, oldLen) -> decode(buf, sharedEnd, newEnd)
```

For a pure forward pan (the boundary-crossing case) the front insert is empty — it's a
pure drop — and the back change is a pure append. The formula is direction-agnostic and
handles a backward pan symmetrically, though only the forward case is exercised here.

The test then does something A6 did not: dispatch **only** the two-edit change set, with
**no** accompanying `selection`/`scrollIntoView` effect and **no** `scrollTop = 0` reset.
The caret is anchored once, before the edit, near the tracked top-of-viewport point (and
clamped into the region guaranteed to survive — see A6's writeup on why a caret allowed
to drift outside the window produces meaningless numbers, not strict ones). Whatever
happens to scroll position and caret after that is purely CodeMirror's own doing: a
`ChangeSet` maps `state.selection` through a transaction by default, and CodeMirror's
view maintains a scroll anchor so content edited above the viewport doesn't visually
displace what's on screen. This is the actual hypothesis under test — not "can we
correctly recompute and reset the position by hand," which is what A6 measured.

**Result, 20 crossings at 1 MB window on `cars-500mb.xml`:**

| Metric | Value | Bar | |
|---|---|---|---|
| Crossing p50 | **16.8 ms** | < 32 ms | ✅ |
| Crossing p95 | 20.8 ms | — | |
| Crossing max | **20.8 ms** | < 50 ms | ✅ |
| Top-of-viewport drift (max abs) | **0 bytes** | < 1 line (~40 B) | ✅ |
| Caret drift (max abs) | **0 bytes** | = 0 | ✅ |
| Offset round-trip (1%/50%/99%) | all pass | passes | ✅ |
| Incremental patches used | 20/20 | — | (never fell back to a full replace) |

Every one of the 20 crossings resolved to a 2-edit incremental patch — the windows always
overlapped, as expected for hysteresis-based re-centring — and **every drift measurement,
top and caret, across all 20 crossings, was exactly 0 bytes**, not merely under a
tolerance. Crossing p50 sits at the vsync floor, essentially indistinguishable from a
plain keystroke; only the p95/max (20.8 ms) shows any cost from the edit at all, and it
is still comfortably under both A6's own crossing bar (32 ms) and this table's (50 ms).
The offset round-trip (A6's item 7, re-run because incremental patching changes how
`start`/`origin` bookkeeping works) passed at all three file positions — no regression
from the refactor.

Compare directly against A6's full-replace numbers at the same configuration
(1 MB / `cars-500mb.xml`): crossing p50 **29.2 → 16.8 ms**, p95 **43.2 → 20.8 ms**, max
**43.2 → 20.8 ms**. The crossing bar A6 missed by 11.2 ms (p95, 43.2 vs 32) is now
cleared with **22.4 ms of headroom to spare**.

**`scrollTop = 0` reset — no longer required.** A6's bug 2 needed it because a full
document replacement changes the window's height and leaves `scrollTop` referencing a
now-invalid position. Incremental patching changes the height by only the net
lead/trail difference (typically small, often near zero for a fixed-size window), and
more importantly CodeMirror's scroll-anchor logic is explicitly designed to compensate
for edits above the viewport — which is exactly the case here. **Confirmed by
measurement, not just by absence of a crash: drift is 0, so position is demonstrably
being mapped, not coincidentally surviving.**

### Part 2 — Soft wrap inside a window

`CONCEPT.md` §3.1 (as updated) asserts that a single-line document gets wrap turned on
because it otherwise has no vertical scroll surface for the window to advance through.
Tested directly: 1 MB window over `cars-100mb.min.json`, `EditorView.lineWrapping` on.

**Primary configuration — `cars-100mb.min.json`, 1 MB window, wrap on:**

| Metric | Value | Bar | |
|---|---|---|---|
| Scroll range exists (`scrollHeight > clientHeight`) | **yes** (97,977 px vs 835 px) | yes | ✅ |
| Estimated visual lines | ~5,833 | — | (from 1 logical line) |
| Open cost | 400.9 ms | — | (see note below) |
| Keystroke p95 (1%/50%/99%) | 16.9 / 17.0 / 16.8 ms | < 25 ms | ✅ |
| Scroll (wheel) p95 | 27.8 ms, 0.5% of frames > 32 ms | — | |
| Crossing p50 | **16.4 ms** | < 32 ms | ✅ |
| Crossing max | **16.6 ms** | < 50 ms | ✅ |
| Drift (top / caret) | 0 / 0 bytes | — | |

A6 could not even attempt boundary crossing on this fixture — a single line has no
vertical scroll range, so the window could never advance (harness reported "skipped").
Wrap resolves that at the root: the same 1 MB of source text becomes ~5,800 wrapped
visual rows, giving the window a normal scrollable surface, and every figure lands at
or near the vsync floor — including crossing, now exercised for the first time on this
fixture and clean.

**Open cost is the one number here worth flagging.** 400.9 ms, dramatically higher than
every other open-cost figure in this document (all others are 14–30 ms). This is
consistent with wrap forcing CodeMirror to compute line-break positions across the full
1 MB of unbroken text before it can paint anything — real cost, not noise, and worth
carrying into M1: wrap is not free to turn on for a freshly opened minified window, even
though everything *after* that first paint is frame-perfect.

**Sanity check — `cars-500mb.xml`, 1 MB window, wrap on (confirms wrap isn't free
everywhere):**

| Metric | Value | Bar | |
|---|---|---|---|
| Scroll range exists | yes (655,002 px vs 835 px) | yes | ✅ |
| Estimated visual lines | ~38,995 | — | |
| Open cost | 17.2 ms | — | (no penalty — lines are already short) |
| Keystroke p95 (1%/50%/99%) | 16.9 / 16.9 / 16.8 ms | < 25 ms | ✅ |
| Scroll (wheel) p95 | 20.1 ms, 0% of frames > 32 ms | — | |
| Crossing p50 | **17.2 ms** | < 32 ms | ✅ |
| Crossing max | **33.5 ms** | < 50 ms | ✅ |
| Drift (top / caret) | 0 / 0 bytes | — | |

XML's short lines (~30–40 bytes) rarely need wrapping in a normal-width viewport, so
open cost shows none of the minified fixture's penalty. Crossing max (33.5 ms) is
noticeably higher than Part 1's XML result without wrap (20.8 ms) and higher than the
minified-with-wrap result (16.6 ms) — consistent with wrap adding *some* per-crossing
layout cost even when it changes little visually, but it is still 16.5 ms under the bar.
Every figure still clears its bar; wrap is not free, but it is affordable.

### Decision table, applied

| Part | Metric | Bar | Result |
|---|---|---|---|
| 1 | Crossing p50 | < 32 ms | 16.8 ms ✅ |
| 1 | Crossing max | < 50 ms | 20.8 ms ✅ |
| 1 | Caret drift | 0 bytes | 0 bytes ✅ |
| 1 | Top-of-viewport drift | < 1 line (≈ 40 B) | 0 bytes ✅ |
| 1 | Offset round-trip | passes at 1%, 50%, 99% | passes ✅ |
| 2 | Vertical scroll range exists | yes | yes ✅ |
| 2 | Keystroke p95 | < 25 ms | 16.9–17.0 ms ✅ |
| 2 | Crossing p50 / max | < 32 ms / < 50 ms | 16.4 / 16.6 ms ✅ |

> *"All bars pass → Windowing confirmed as specified. Record the crossing figures as the
> M1 regression baseline."*

### ✅ DECISION: windowing confirmed as specified

Every bar in both parts clears, several with wide margins (crossing p95 at 20.8 ms
against a 50 ms ceiling; drift at exactly 0 against a ~40-byte allowance). **Option D is
adopted without qualification**: no large-file threshold, one Raw View implementation,
M5 loses the custom viewer, and CodeMirror stops being a standing exception to
invariant 2 for any document size tested.

**Recorded as the M1 regression baseline** (1 MB window, incremental re-slice):

| Fixture | Crossing p50 | Crossing p95 | Crossing max | Drift |
|---|---|---|---|---|
| `cars-500mb.xml`, no wrap | 16.8 ms | 20.8 ms | 20.8 ms | 0 B |
| `cars-100mb.min.json`, wrap on | 16.4 ms | 16.6 ms | 16.6 ms | 0 B |
| `cars-500mb.xml`, wrap on | 17.2 ms | — | 33.5 ms | 0 B |

**Two things worth carrying into M1's implementation, not just the spike record:**

1. **Wrap's first-open cost (~400 ms on a 1 MB unbroken-line window) is real and should
   be budgeted for** — e.g. shown as a brief loading state rather than assumed instant,
   specifically for the minified-document case where wrap is load-bearing rather than a
   preference.
2. **The incremental re-slice formula (two edge changes, shared middle untouched) is now
   validated and should be the actual M1 implementation**, not the full-replace approach
   A6 measured as a baseline. The full-replace path remains correct as a fallback for the
   no-overlap case (a large jump via "Locate in source," where the old and new windows
   share nothing) but should not be the steady-state mechanism for ordinary scrolling.

---

## Summary of decisions

| Question | Decision | Basis |
|---|---|---|
| Large-file threshold | **500 MB** | p95 17.3 ms @200 MB, 17.5 ms @500 MB; memory 1.1 GB |
| Scale milestone | **Defer, but do not delete — re-aim at scrolling** | scroll fails at 200 MB+ while typing does not |
| Parser language | **TypeScript** | 200 MB/s @100 MB, 207 MB/s @500 MB |
| Pending-delta list | **Mandatory** | 51.4 ms specified / 231.5 ms at real density |
| Format-on-open | **Recommend a readability-only convenience, not a latency-driven requirement** (superseded by A6) | A5: minified typing p95 10× worse whole-document; A6: windowed typing p95 is at the vsync floor, same as any other file |
| Windowed Raw View (A6 → A6b) | **Confirmed as specified.** Option D adopted: no large-file threshold, one Raw View implementation, M5 loses the custom viewer | A6 mechanically failed on crossing p95 (43.2 ms ≥ 32 ms) using a full-replace reslice; A6b's incremental re-slice (drop leading edge, append trailing edge, shared middle untouched) drops crossing to 16.8/20.8 ms p50/max with 0-byte drift — every A6b bar clears |
| Soft wrap for minified documents | **Confirmed as the mechanism**, not just reasoned about | wrap gives `cars-100mb.min.json` a genuine ~5,800-line scroll surface where none existed; all figures at/near vsync floor; first-open cost (~400 ms) is real and should be budgeted for in M1 |

## Report-back items for M0b

Per `M0-PLAN.md` "Report back on any of these":

1. **`CONCEPT.md` §3.2/§8 node-density and memory figures are wrong** — 10.7 B/node
   measured against ~50–60 assumed; the 2.5× memory rule is really ~5×. Needs a decision
   on whitespace-only text nodes **before B6/B9**, and revision of §8, §11.2, §11.4.
2. **The M0 done-criterion "200 MB … total process memory under 600 MB" is not achievable**
   as specified if whitespace-only text nodes are retained (node store alone ≈ 745 MB).
3. **`CONCEPT.md` §8's 50 MB threshold was wrong by 10×** — resolved upward, no re-planning
   needed, but §8 and §13's blocking open question should be rewritten.
4. **Scrolling, not memory, is what limits large documents** — contradicts §8's premise
   that the editor's memory footprint is the binding constraint.
5. **Transform (§5.5) has a multi-gigabyte transient memory spike** at 500 MB. Needs a
   chunked design, not one `dispatch`.
6. **`M0-PLAN.md`'s decision table names "M6" for the large-file/scale milestone**;
   `CONCEPT.md` §12 has that as **M5** (M6 is TOML). Off-by-one in the plan, not the concept.
7. **`deep-1m.json` parses fine under V8's native `JSON.parse`** — V8's JSON parser is
   iterative. The fixture is a test of *our* configured `maxDepth` (B8), not of anything
   inherently unparseable.
8. **No change to `src/core/types.ts` was needed** — the spike does not touch it.
9. **A6's "stop and report" is resolved by A6b: windowing is confirmed, not merely
   recommended.** Incremental re-slicing (drop leading edge, append trailing edge,
   shared middle untouched — replacing A6's full-document-replace reslice) clears every
   A6b bar, several with wide margins (crossing p95 20.8 ms against a 50 ms ceiling;
   drift exactly 0 bytes across 60 crossings). **M1 should implement the Raw View as a
   single windowed CodeMirror instance using incremental re-slicing**; the full-replace
   path stays only as the no-overlap fallback for a large jump ("Locate in source"),
   not as the steady-state scrolling mechanism.
10. **A6's Format-on-open finding stands, confirmed rather than superseded**: windowed
    typing on the minified fixture is at the vsync floor (16.8–17.0 ms p95, same figure
    under A6b's wrap-on measurement), so the 10× latency penalty A5 measured is
    conclusively a whole-document-load artifact. Format-on-open reverts to a readability
    convenience, not a latency-driven requirement.
11. **A6's single-line scroll-surface problem is resolved by soft wrap, confirmed by
    measurement (A6b Part 2), not just reasoned about in `CONCEPT.md` §3.1.** Wrap turns
    ~1 MB of unbroken text into ~5,800 scrollable visual lines and every subsequent
    figure — keystroke, scroll, crossing, drift — lands at or near the vsync floor. The
    one real cost is **first-open latency (~400 ms on the minified window)**, from
    computing wrap points across the whole window before first paint; M1 should budget
    for this explicitly (e.g. a brief loading state) rather than assume windowing is
    uniformly instant to open.
12. **A6 found a sharp CodeMirror API edge worth documenting for M1/M5**: a fractional
    byte offset (e.g. from `windowBytes * 0.2` without flooring) silently defeats
    UTF-8 boundary-snapping logic and is not rejected until it reaches
    `EditorView.scrollIntoView`, where CodeMirror throws off an internal async pass —
    invisible to a normal `try/catch` and, in this harness, indistinguishable from a hang
    until a `window.onerror` listener was added specifically to catch it. Any windowed
    Raw View code that derives an offset via arithmetic needs an explicit integer guard.
13. **`CONCEPT.md` §3.1's soft-wrap heuristic is validated but needs one addition**:
    it should say wrap turns on for a window whose *own* content lacks a scroll surface,
    not only "documents whose mean row length exceeds the §5.7 heuristic" — a document
    can be mostly normal-length lines and still produce a single-line *window* near a
    pathological region, and the windowed Raw View needs to detect and react to that at
    the window level, which A6b's `hasScrollRange` check demonstrates is cheap to do
    (`scrollHeight <= clientHeight`, no full-document analysis required).

## Reproducing

```bash
node spike/generate-fixtures.ts          # A1  (~8 s, 977 MB disk)
node spike/xml-throughput.ts             # A3  (~30 s, needs ~2 GB RAM)
node spike/offset-shift.ts               # A4  (~40 s, needs ~1 GB RAM)

cd spike/codemirror-harness
npm install && npx vite build
node run-all.js                          # A2  (~15 min, needs ~8 GB RAM free)
node run-all-windowed.js                 # A6  (~10 min, needs ~4 GB RAM free)
node run-a6b.js                          # A6b (~1 min, needs ~2 GB RAM free)
```

> On this machine the environment exports `ELECTRON_RUN_AS_NODE=1` (VS Code extension
> host), which makes the `electron` binary behave as plain Node — `app` comes back
> undefined and no window opens. `run-all.js`, `run-all-windowed.js` and `run-a6b.js`
> all delete it from the child environment.

`vite.config.js` builds `renderer.js` (A2), `renderer-windowed.js` (A6) and
`renderer-a6b.js` (A6b) as separate CJS entries in one pass; rerun `npx vite build`
after editing any of them.
