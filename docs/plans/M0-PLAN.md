# NodePad — M0 Implementation Plan

<!-- status: built -->

**Audience:** the coding agent implementing this milestone.
**Reference:** `CONCEPT.md` (design), `src/core/types.ts` (the format contract).

---

## How to use this plan

Work through tasks **in order**. Each has explicit acceptance criteria — do not move on
until they pass. Where a task says "stop and report," stop and report; do not guess.

> **This whole plan is complete and is retained as a record. Do not work from it.**
> A1–A6b and B1–B13 have all run; results are in `spike/RESULTS.md` and
> `docs/plans/M0-RESULTS.md`.
>
> **The current milestone is M0c — see `docs/plans/M0c-PLAN.md`.** It closes five gaps this plan
> left between B3, B7 and B11: BOM and encoding never reach the worker, the encoding never
> reaches the main thread, the row index is built by nothing, the store transfer allocates
> what it discards, and the worker's forwarding sink costs 21% of parse time. M1 follows,
> in `docs/plans/M1-PLAN.md`.
>
> Read this file to understand *why* the data layer is shaped as it is — particularly the
> node-model rules in B6/B8/B9 and the sentinels in B6, which are counter-intuitive enough
> that an implementer will be tempted to "simplify" them back. Read `CONCEPT.md` §3.2
> before touching any of them.

### M0 has no user interface

The deliverable is a **library plus a command-line harness**. No React components, no
tree view, no windows beyond what the scaffold generates.

This will feel wrong. The concept describes three views in detail and it is tempting to
start building them. Do not. M0 exists to prove the data layer is correct and fast enough,
and a UI built on an unproven data layer has to be rewritten. Views are M1.

### Hard rules

1. **No recursion in parsers.** Use an explicit stack. Recursive descent overflows on
   deeply nested input, which is a real input.
2. **Never convert the source to a JavaScript string.** Not for convenience, not
   temporarily, not "just to check." A JS string is UTF-16 and doubles the memory. Work on
   `Uint8Array` and decode only short slices on demand.
3. **No object per node.** All node data lives in the parallel typed arrays of
   `NodeStore`. If you find yourself writing `{ kind, name, children }`, stop.
4. **Parsers never throw on malformed input.** Emit a diagnostic and continue where the
   grammar allows.
5. **Do not add dependencies** beyond those listed in each task. If you believe one is
   needed, stop and report.
6. **Do not modify `src/core/types.ts`** to make an implementation easier. If the contract
   seems wrong, stop and report — that is a design signal, not a blocker.

---

# M0a — Spike · complete

**Purpose:** replace two assumptions with measurements. This code was **throwaway**: it
lives in `spike/`, is not integrated, has no tests, and is not pretty.

Retained as the record of what was measured. Do not re-run it as part of M0b; the figures
it produced are the regression baselines the rest of this plan is written against.

The two assumptions:

1. CodeMirror 6 can host a 100–200 MB document with acceptable latency and memory
2. A byte-scanning TypeScript parser reaches ~100–300 MB/s

Both are load-bearing. Assumption 1 sets the large-file threshold and decides whether
`CONCEPT.md` §1's target is achievable in v1 at all. Assumption 2 decides whether the
parsers stay in TypeScript.

## A1 — Fixture generator

**File:** `spike/generate-fixtures.ts`

Generate synthetic documents into `spike/fixtures/` (gitignored):

| File | Size | Shape |
|---|---|---|
| `cars-10mb.xml` | 10 MB | repeating records, ~8 fields, some with nested `<engine>` |
| `cars-50mb.xml` | 50 MB | same shape |
| `cars-100mb.xml` | 100 MB | same shape |
| `cars-200mb.xml` | 200 MB | same shape |
| `cars-500mb.xml` | 500 MB | same shape |
| `cars-100mb.json` | 100 MB | equivalent JSON, pretty-printed |
| `cars-100mb.min.json` | 100 MB | equivalent JSON, **single line** |
| `deep-10k.json` | small | 10,000 nested arrays |
| `deep-1m.json` | small | 1,000,000 nested arrays |

Use the structure from `CONCEPT.md` Appendix A as the record template. Vary field presence
so roughly 10% of records omit an optional field, and 10% have a scalar `<engine>` rather
than a nested one — the parser work later needs realistic input.

Write incrementally with a stream. Do not build the document in memory.

**Acceptance:** all files generated; `cars-500mb.xml` is within 5% of 500 MB; the
generator's own peak memory stays under 200 MB.

## A2 — CodeMirror latency and memory harness

**File:** `spike/codemirror-harness/` (minimal Electron app, or a plain Vite page if that
is faster — this is throwaway)

Dependencies: `codemirror`, `@codemirror/state`, `@codemirror/view`.

For each of the 10/50/100/200/500 MB XML fixtures, and the two 100 MB JSON fixtures,
measure:

1. **Load time** — from `readFile` complete to first paint of the editor
2. **Resident memory after load** — `process.memoryUsage().rss` in the renderer, sampled
   after a forced GC if available. Record the baseline before load and report the delta.
3. **Keystroke latency** — insert a single character via `dispatch`, measure to the next
   paint (`requestAnimationFrame` after the transaction). Do this **100 times at each of
   three positions**: 1% into the document, 50%, and 99%. Report p50 and p95 per position.
4. **Scroll smoothness** — programmatically scroll through 200 viewports, record frame
   intervals, report the percentage of frames over 32 ms.
5. **Full document replacement** — time a transaction replacing the entire document (this
   simulates a Transform from `CONCEPT.md` §5.5).

Configure the editor **without** syntax highlighting and **without** CodeMirror's history
extension, since neither is used in the real design (§4.4, §5.6). Include line numbers and
`EditorView.lineWrapping` **off**.

Also record: does the minified 100 MB JSON behave differently from the pretty-printed one?
A single 100 MB line may defeat CodeMirror's internal line handling entirely. This is an
important result either way.

**Acceptance:** a table of all numbers for all fixtures, written to
`spike/RESULTS.md`. If a fixture crashes or hangs beyond 60 s, record that as the result
and move on — a crash is data.

## A3 — Parser throughput probe

**File:** `spike/xml-throughput.ts`

Write a deliberately minimal XML scanner: find element boundaries and attribute
boundaries, write offsets into pre-allocated `Int32Array`s. No interning, no validation,
no error handling, no tree structure beyond a depth counter. It does not need to be
correct on edge cases — it needs to be representative of the inner loop.

Run against the 100 MB and 500 MB XML fixtures. Report MB/s and the peak memory of the
resulting arrays.

**Acceptance:** throughput figure for both files in `spike/RESULTS.md`.

## A4 — Offset shift probe

**File:** `spike/offset-shift.ts`

Allocate four `Int32Array`s of 10,000,000 elements. Time adding a constant to every
element of all four (this is what a naive post-edit offset fixup costs at 500 MB scale).
Run 20 times, report p50.

This decides whether the pending-delta list in `CONCEPT.md` §5.2 is mandatory or merely an
optimization — if a bulk shift costs 20 ms, the much simpler naive approach may be
acceptable.

**Acceptance:** timing in `spike/RESULTS.md`.

## A5 — Apply the decision table

Write conclusions into `spike/RESULTS.md`, applying these rules **mechanically**. Do not
reinterpret them.

### CodeMirror threshold

Use p95 keystroke latency at the 50% position as the deciding metric.

| Result at 200 MB | Decision |
|---|---|
| p95 < 50 ms **and** memory delta < 1.5 GB | Set threshold to **500 MB**. Verify at 500 MB; if that also passes, large-file mode is not needed in v1 and M5 can be deferred. |
| p95 50–150 ms | Set the threshold to the **largest fixture size where p95 < 50 ms**. Record it. |
| p95 > 150 ms, but 100 MB passes | Threshold is **100 MB**. `CONCEPT.md` §1's 200 MB editing target is not met by CodeMirror alone — **stop and report**, because M3 and M6 need re-planning. |
| 100 MB fails | **Stop and report.** The custom viewer moves into v1 and the roadmap changes materially. |

If the minified 100 MB JSON performs dramatically worse than the pretty-printed file,
record this separately — it may mean the Format-on-open prompt (§5.7) is mandatory rather
than optional, and should move earlier in the roadmap.

### Parser language

| Throughput at 100 MB | Decision |
|---|---|
| ≥ 100 MB/s | TypeScript parsers confirmed. Proceed with M0b as written. |
| 50–100 MB/s | Acceptable. Proceed, and note the figure as a regression baseline. |
| < 50 MB/s | **Stop and report.** A WASM parser core may be required, which changes M0b. |

### Delta list

| Bulk shift of 4×10 M Int32 | Decision |
|---|---|
| < 50 ms | Note that the naive shift is viable; the delta list becomes an optimization rather than a requirement. Still implement per §5.2, but record this. |
| ≥ 50 ms | Delta list is mandatory as specified. |

**Do not begin M0b until `spike/RESULTS.md` is complete and the A5 decision table applied.**

---

## A6 — Windowed CodeMirror

**Added after A1–A5 completed**, in response to their results, and for the same reason those
tasks existed: to replace an assumption with a number.

A5 set the large-file threshold at 500 MB on keystroke latency and memory. But scrolling
failed well below that, and the fix A5 recommends — a second, custom Raw View
implementation — is expensive. Option D proposes something cheaper: **CodeMirror never
receives the whole document.** It gets a window of ~1 MB around the current position, sliced
at row boundaries, with absolute offsets reconstructed as `origin + localOffset`.

If it holds, the tiered Raw View (`CONCEPT.md` §8), the large-file threshold, and M5's custom
virtualized viewer all become unnecessary, and CodeMirror stops being a standing exception to
invariant 2. That is a large enough simplification to measure before M0b commits against it.

Same rules as A1–A5: throwaway code, extend `spike/codemirror-harness/`, no tests, no polish.

### Setup

Add a window mode to the existing harness:

- Read the fixture into a `Uint8Array`. **Do not decode it in full** — invariant 2 applies
  even in the spike, and a whole-file decode is precisely what this task exists to avoid.
- Slice `[origin, origin + windowBytes)`, snapping **both** ends forward to a UTF-8 lead
  byte, and decode only that slice into CodeMirror.
- Keep `origin` beside the editor. Every offset reported is `origin + localOffset`.
- Offset `lineNumbers({ formatNumber })` so displayed numbers match the whole document, using
  a line count from a one-time scan.
- Editor config exactly as A2: line numbers on, no highlighting, no history, no wrapping.

Window sizes: **256 KB, 1 MB, 4 MB**.
Fixtures: `cars-200mb.xml`, `cars-500mb.xml`, `cars-100mb.min.json`.

### Measure

1. **Open cost** — slice, decode and first paint from a cold editor. Compare against A2's
   load time for the same fixture.
2. **Renderer RSS delta** after the window is loaded. Compare against A2's figure for the
   same fixture.
3. **Keystroke latency** — as A2: 100 insertions at 1%, 50% and 99% *of the window*, p50 and
   p95. Expect the vsync floor at every window size and every fixture. The minified fixture
   is the interesting one.
4. **Scroll smoothness within a window** — as A2: 200 viewports, wheel p50/p95, percentage of
   frames over 32 ms. Expect the 10 MB result (0%).
5. **Re-slice cost** — replace the document with a window at a new origin. p50 and p95 over
   100 re-slices at random origins. This is what "Locate in source" will cost; compare it
   against A2's jump figures (67 / 151 / 395 ms).
6. **Re-slice under continuous scrolling** — the new risk this task exists to test. Scroll
   continuously so the viewport crosses a window edge, re-slicing with 20% hysteresis and
   re-centring. Over **20 boundary crossings**, record frame intervals (p95 and max), and
   record **drift**: after each re-slice, the byte offset at the top of the viewport and the
   caret's absolute offset must both be unchanged. Report drift in bytes, not as a boolean.
7. **Offset round-trip** — insert a character at a known absolute offset through the window
   and assert `origin + localOffset` equals it, at the 1%, 50% and 99% positions of the file.
   A correctness check, not a benchmark: a failure here invalidates every figure above.

**Acceptance:** all figures for all three window sizes and all three fixtures in
`spike/RESULTS.md`, plus the decision table below applied.

### Decision table — apply mechanically

Deciding metrics: **re-slice p95 (5)**, and **frame intervals and drift while crossing a
boundary (6)**, both at a **1 MB window on `cars-500mb.xml`**.

| Result | Decision |
|---|---|
| re-slice p95 < 16.7 ms **and** crossing p95 < 32 ms and max < 50 ms **and** drift is 0 bytes | Windowing confirmed. **Option D adopted**: no large-file threshold, one Raw View implementation, M5 loses the custom viewer. |
| re-slice p95 16.7–50 ms, crossing and drift as above | Viable. Record the **smallest** window size that meets the row above, and use that value. |
| re-slice p95 > 50 ms, **or** crossing p95 ≥ 32 ms, **or** max ≥ 50 ms, **or** drift ≠ 0 | **Stop and report.** Windowing does not hold. Fall back to CodeMirror over the whole document, and §8 and M5 need re-planning around scroll performance instead. |

Record separately, because it decides where Format-on-open lands:
**keystroke p95 on `cars-100mb.min.json` in a window.** A2 measured 179 ms with the whole
document loaded. If a windowed slice sits at the vsync floor, the *latency* argument for
promoting Format-on-open disappears and only the readability argument remains.

---

## A6b — Windowing confirmation

**A6 settled the direction; this closes the two things it inferred rather than measured.**

A6's mechanical result was "stop and report," but on bars that were badly written. The
re-slice bar (`p95 < 16.7 ms`) was set *below* the harness's own vsync floor, so no result
could ever clear it. The crossing bar used p95 over 20 samples, which is the maximum — the
reported 43.2 ms is the worst crossing observed, while the *median* was 29.2 ms and inside
the 32 ms bar. The decision has been taken to adopt windowing (`DECISIONS.md` D-031); this
task confirms two inferences the design now rests on.

**This is confirmation, not a gate.** M0b may proceed in parallel. But if either bar below
fails, **stop and report before M1 commits to the Raw View**, because the fallback is
materially different work.

Extend `spike/codemirror-harness/` as before: throwaway, no tests, no polish.

### Part 1 — Incremental re-windowing

A6 re-slices with a full replacement: `dispatch({changes: {from: 0, to: length, insert:
newText}})`. A re-centred window shares most of its content with the old one, so replace
that with the **two edge changes** the move actually represents — drop from the leading
edge, append at the trailing edge — leaving the shared middle untouched.

Two things should follow, and both are the point of the exercise:

- crossing cost falls, because the transaction no longer rewrites ~1 MB of text
- **top-of-viewport drift goes to zero**, because CodeMirror maps scroll position and
  selection through a change set. The `scrollTop = 0` reset A6 needed (its bug 2) should
  become unnecessary — if it is still needed, say so, because that means position is not
  being mapped and the premise is wrong.

Re-measure item 6 from A6 — 20 boundary crossings at **1 MB window on `cars-500mb.xml`** —
reporting crossing p50/p95/max, top-of-viewport drift and caret drift. Re-run A6's item 7
offset round-trip afterwards: incremental patching changes how `origin` is maintained, and
a correctness regression there would invalidate everything.

### Part 2 — Soft wrap inside a window

`CONCEPT.md` §3.1 states that wrap is turned on when a window has no vertical scroll
surface, because the window advances on scroll and a single-line window can never move.
That is reasoning, not measurement.

> As written at the time, §3.1 keyed this off a *document-wide* mean row length. This task's
> own `hasScrollRange` check showed the test belongs at the **window** — a file of otherwise
> normal lines can still produce a single-line window over one bad region — and §3.1 was
> corrected accordingly. The measurements below are unaffected.

With `EditorView.lineWrapping` **on**, at a 1 MB window over `cars-100mb.min.json`:

1. Confirm a vertical scroll range exists (`scrollHeight > clientHeight`) and report the
   number of visual lines.
2. Keystroke latency — 100 insertions at 1%, 50%, 99% of the window; p50 and p95.
3. In-window scroll smoothness — as A6, wheel p50/p95 and percentage of frames over 32 ms.
4. Boundary crossing — 20 crossings, same figures as Part 1. This is the case A6 had to
   skip entirely.

Also record, as a sanity check that wrap is not free everywhere: the same four figures for
a 1 MB window over `cars-500mb.xml` with wrap on.

### Decision table — apply mechanically

Deciding configuration: **1 MB window on `cars-500mb.xml`** for Part 1, and **1 MB window
on `cars-100mb.min.json`** for Part 2.

Bars are written against the median for steady-state cost and the maximum for the worst
hitch, and nothing is asked to beat the 16.7 ms vsync floor.

| Part | Metric | Bar |
|---|---|---|
| 1 | Crossing p50 | < 32 ms |
| 1 | Crossing max | < 50 ms |
| 1 | Caret drift | 0 bytes |
| 1 | Top-of-viewport drift | < 1 line (≈ 40 bytes) |
| 1 | Offset round-trip | passes at 1%, 50%, 99% |
| 2 | Vertical scroll range exists | yes |
| 2 | Keystroke p95 | at the vsync floor (< 25 ms) |
| 2 | Crossing p50 / max | < 32 ms / < 50 ms |

| Result | Decision |
|---|---|
| All bars pass | Windowing confirmed as specified. Record the crossing figures as the M1 regression baseline. |
| Part 1 passes, Part 2 fails | Windowing holds; **minified documents need a non-scroll window trigger**. Report which of §3.1's alternatives is needed — horizontal scroll position, or an explicit affordance — and note that §5.7's Format command becomes the practical answer for these files rather than a convenience. |
| Part 1 fails | **Stop and report.** Incremental patching does not deliver what §4.4 requires. §8 and §12 need re-planning around a second Raw View implementation after all. |

Record separately: whether the `scrollTop = 0` reset from A6's bug 2 is still required.

### Result — complete, all bars passed

Crossing collapsed to **16.8 ms p50 / 20.8 ms max** with **0 bytes of drift**, top and
caret, across every crossing; wrap gave the minified fixture a real ~5,800-row scroll
surface with every figure at the floor. The `scrollTop = 0` reset is no longer required —
CodeMirror's own change-mapping does the work, provided the re-window dispatches **only**
the two edge changes with no accompanying selection or scroll effect. Full numbers in
`spike/RESULTS.md`; the mechanism is now specified in `CONCEPT.md` §4.4 and recorded as
D-031.

**M1 regression baseline** (1 MB window, incremental re-slice): `cars-500mb.xml` no wrap —
16.8 / 20.8 / 20.8 ms, 0 B. `cars-100mb.min.json` wrap on — 16.4 / 16.6 / 16.6 ms, 0 B.
`cars-500mb.xml` wrap on — 17.2 ms p50, 33.5 ms max, 0 B.

---

# M0b — Core

The real code starts here. Everything in this section is production quality with tests.

## B1 — Scaffold

Create an Electron + Vite + TypeScript project using **electron-vite**.

> Check the current electron-vite documentation for the scaffold command rather than
> assuming one — it has changed between versions. If scaffolding fails, report the error
> rather than hand-rolling a config.

⚠️ **The working directory is not empty.** It already holds `src/core/types.ts` (the
contract — B2), `docs/`, `spike/`, `assets/`, `tools/`, `CLAUDE.md`, `README.md`, and a
root `.gitignore`. Scaffolders generally assume an empty directory, and several will
happily create their own `src/`.

**The repository is initialised, on `main`, with no commits yet.** Before running anything
that writes files, commit what is here:

```
git status --porcelain --untracked-files=all | wc -l    # expect ~72
git add -A && git commit -m "Design, M0a spike results, and icon assets"
```

If that count is much larger than 72, or `git status` lists anything under
`spike/fixtures/`, `node_modules/` or a `dist/`, then something that should be ignored is
not — **stop and report** rather than committing a gigabyte of fixtures.

Then scaffold. If the scaffolder refuses to run in a non-empty directory, scaffold into a
temporary directory and merge its output in, rather than clearing the way for it. Losing
`src/core/types.ts` costs a design conversation, not just a file — and with the tree
committed first, `git diff` tells you exactly what the scaffolder touched, which is most of
why the commit comes first.

Then:

- Enable TypeScript `strict: true`. Also enable `noUncheckedIndexedAccess`.
- Add **Vitest** for tests, **ESLint** and **Prettier**.
- Add the npm scripts listed in `README.md` (`dev`, `build`, `package`, `test`,
  `test:watch`, `lint`, `typecheck`).
- Create the directory structure from `README.md`.
- Add `LICENSE` (MIT). **`.gitignore` already exists** at the root, with a second one
  narrowing `spike/` — read both before adding to them. `spike/` is deliberately committed
  apart from fixtures, dependencies and build output: `RESULTS.md` is a decision record and
  `codemirror-harness/out/*.json` is the raw evidence behind D-030 and D-031.
- If the scaffolder writes its own `.gitignore`, **merge rather than replace**. Watch for a
  bare `out/` or `dist/` rule: unanchored, `out/` would silently swallow the spike's
  measurement data. The existing rules are root-anchored (`/out/`, `/dist/`) for exactly
  this reason.
- Add the scripts to `package.json`, including `inspect` (B13), `fixtures:generate` and
  `test:large` (B12) — `README.md`'s command table already lists all of them.

**Acceptance:** `npm run dev` opens an empty Electron window. `npm test` runs and reports
zero tests. `npm run typecheck` and `npm run lint` pass.

## B2 — The format contract

**`src/core/types.ts` already exists in the repository.** Leave it where it is and do not
modify it — earlier drafts of this plan said to copy it in from a `format-module.ts` that
no longer exists.

Read its closing section ("Deliberately NOT in this contract") before implementing
anything else. It defines the boundary you are working within.

One comment in it is now out of date and is **not** a licence to change the code. `value()`
is documented as *"May be called more than once for mixed content, in which case the sink
records the node as mixed."* B9 no longer works that way — mixed content produces ordered
`Text` children, so `value()` is called once per node. The signature and the contract are
unaffected; only the comment's example is stale. If you think this needs correcting, report
it rather than editing.

**Acceptance:** the file typechecks unchanged. No implementations yet.

## B3 — Encoding detection

**File:** `src/core/encoding.ts`

```ts
export function detectEncoding(head: Uint8Array, declared: string | null): string
```

Order of precedence:

1. **BOM** — UTF-8 (`EF BB BF`), UTF-16LE (`FF FE`), UTF-16BE (`FE FF`)
2. **Declared** — the value a format module extracted from the document (XML prolog)
3. Default `utf-8`

Also export `stripBom(bytes): { bytes: Uint8Array; bomLength: number }`. The BOM length
matters: all spans must be offsets into the **original** buffer, so record it rather than
discarding it.

**Acceptance:** unit tests for each BOM, for a declared `ISO-8859-1`, for BOM-beats-
declaration, and for the default case.

## B4 — SourceBuffer

**File:** `src/core/buffer.ts`

```ts
export class SourceBuffer {
  readonly bytes: Uint8Array;
  readonly encoding: string;
  readonly bomLength: number;

  slice(start: number, end: number): string;      // decode on demand
  byteLength: number;
  snapToCharBoundary(offset: number): number;     // forward to next lead byte
}
```

`slice` uses a single reused `TextDecoder` per encoding. It is called for visible content
only — do not add a whole-document `toString()`, even for debugging.

`snapToCharBoundary` advances past UTF-8 continuation bytes (`0b10xxxxxx`).

**Export it as a free function too** — `snapToCharBoundary(bytes, offset)` — and have the
method delegate. B7 needs it and does not have a `SourceBuffer`; so will the Raw View's
window slicing (`CONCEPT.md` §4.4). One implementation, three callers.

**Guard the offset.** Floor it on entry and reject a non-integer in dev builds. A fractional
offset makes `bytes[offset]` `undefined`, and `undefined & 0xc0` is `0`, so the continuation
check silently passes and a corrupt offset escapes downstream — this cost the M0a spike a
debugging session, surfacing as an asynchronous throw far from its cause.

**Acceptance:** tests including multi-byte content (CJK, emoji) where a naive slice at an
arbitrary offset would produce replacement characters, proving `snapToCharBoundary` fixes
it.

## B5 — Interner

**File:** `src/core/interner.ts`

```ts
export class Interner {
  intern(source: Uint8Array, start: number, end: number): number;
  text(id: number): string;
  get size(): number;
}
```

Implementation:

- FNV-1a 32-bit hash over the byte range
- `Map<number, number[]>` from hash to candidate ids for collision chains
- Name bytes appended to a growable `Uint8Array`; per-id start/end in growable
  `Int32Array`s
- On hash collision, **compare bytes directly** — do not decode to compare
- `text(id)` decodes lazily and caches the result in a plain array

**Acceptance:** interning the same bytes twice returns the same id. Two different names
with a forced identical hash return different ids (construct this case directly in the
test). Interning 1,000,000 occurrences of 50 distinct names yields `size === 50`, and
completes in under 500 ms.

## B6 — NodeStore

**File:** `src/core/nodeStore.ts`

Implements `NodeSink` from `types.ts`. Fields exactly as `CONCEPT.md` §3.2 specifies:
`kind`, `nameId`, `valueStart`, `valueEnd`, `spanStart`, `spanEnd`, `parent`, `firstChild`,
`nextSibling`, `prevSibling`, `flags`.

Plus the attribute side table: `attrOwner`, `attrNameId`, `attrValueStart`, `attrValueEnd`.

Requirements:

- All arrays grow by doubling from an initial capacity of 1024. Growth copies.
- `openNode` links the new node to its parent and previous sibling in O(1). You will need
  a small internal stack of open nodes, plus a "last child of current parent" pointer.
- `closeNode` sets `spanEnd` and pops.
- In development builds only (`import.meta.env.DEV`), assert that `closeNode` matches the
  innermost open node and that `attribute()` is not called after a child has been opened.
- Expose read accessors: `kindOf`, `nameOf` (via interner), `childrenOf` (iterator),
  `attributesOf` (iterator over the contiguous range).
- Expose **`valueOf(node)`**, returning the node's value span whether it is held on the
  node itself or in a child `Text` node (`CONCEPT.md` §3.2). Every consumer goes through
  this; none of them should branch on which representation a given element uses.
- `flags` bits: `hasAttributes`, `isAlias`, `isCData`, `isMixed`, `droppedWhitespace`,
  `subtreeComplete` (§3.4). Six of eight used — if a seventh is needed, report rather than
  widening the array.
- `value()` may be called on an element node, not only on a `Text` node — `types.ts`
  specifies it as "content for the currently open node."
- **`isMixed` is set by the sink, not by repeated `value()` calls.** B9 emits mixed content
  as ordered `Text` children, so a mixed element receives `value()` zero times. Track two
  booleans per open-node stack frame — `sawTextChild`, `sawNonTextChild` — and set `isMixed`
  at `closeNode` when both are true. O(1) per node; do **not** scan children at close, since
  a node can have millions.
- **Define the sentinels explicitly and document them at the top of the file.** A node with
  no value of its own (an element whose text lives in `Text` children, or one with no text
  at all) and a node with no name (array elements, text nodes, the document root) both need
  an unambiguous representation. Use `valueStart === valueEnd === -1` and `nameId === -1`
  rather than zero or `spanStart`, so that "absent" is never confusable with "empty at
  offset 0". B12's invariants and `valueOf` both depend on this being unambiguous.
- Track `subtreeComplete` in `flags` per `CONCEPT.md` §3.4.

**Do not** add a method that returns a node as an object.

**Acceptance:** a hand-built sequence of ~20 sink calls produces the expected tree,
verified via the read accessors. Growth is exercised by inserting 5000 nodes. Dev
assertions fire on mismatched `closeNode`.

## B7 — Row index

**File:** `src/core/rowIndex.ts`

```ts
export function buildRowIndex(
  bytes: Uint8Array,
  maxRowBytes: number,
  breakBytes: readonly number[],
): Int32Array
```

Returns row start offsets. A row ends at `\n`, or after `maxRowBytes`, whichever comes
first. When cutting at `maxRowBytes`:

1. Scan **backward** up to 16 bytes for one of `breakBytes`; cut just after it if found
2. Otherwise cut at `maxRowBytes`
3. Either way, `snapToCharBoundary` the result

Also export `rowAt(index, offset): number` using binary search.

Default `maxRowBytes`: 512. Record this as a tunable — `CONCEPT.md` §13 lists the value as
an open question.

**Acceptance:** a file with normal lines yields one row per line. A single-line 10 MB
input yields `ceil(size / 512)` rows, ±5% for break-character adjustment. No row starts
mid-character in a CJK fixture. `rowAt` agrees with a linear scan across 1000 random
offsets.

## B8 — JSON parser

**File:** `src/formats/json/index.ts`, implementing `FormatModule`.

**Build JSON before XML.** It is much simpler, and it validates the sink contract before
you take on the harder grammar.

Explicit stack. States: value, object (expecting key / colon / value / comma / close),
array (expecting value / comma / close).

Mapping:

- object → `NodeKind.Object`; members → `NodeKind.Property` with the key as name
- array → `NodeKind.Array`; elements → unnamed nodes (`nameId === -1`)
- `hasAttributes: false`; never call `sink.attribute()`

**Scalar folding, per `CONCEPT.md` §3.2 — this is the JSON counterpart of B9's text rules
and is not the obvious implementation:**

- A `Property` whose value is a **scalar** token (string, number, `true`, `false`, `null`)
  calls `value()` on the `Property` itself and opens **no** child node.
- A `Property` whose value is an **object or array** opens that composite as its child, as
  normal.
- An **array element** cannot fold — there is no property to fold into — so a scalar array
  element is an unnamed `NodeKind.Scalar` node with its own value. This asymmetry is
  intended; `Scalar` nodes exist only here.

In every case `value()` covers the token **including** the quotes for strings — spans
describe source, not decoded values.

The practical effect: `{"a": 1, "b": {"c": 2}}` is `Object`, `Property a` (value `1`),
`Property b`, `Object`, `Property c` (value `2`) — five nodes, not seven. `[1,2,3]` is
`Array` plus three `Scalar` nodes, unchanged.

Strings: scan for the closing quote, honouring `\\` escapes. Do not decode.

`detect`: extension `.json`; content sniff for a first non-whitespace byte of `{` or `[`.
`detectEncoding`: return null (JSON is UTF-8 by spec; BOM handling covers the rest).

`parseRange` and `resumeContextFor`: JSON needs no scope state, so the resume context is a
constant. Set `canIncrementalReparse: true`.

`format`: implement it — JSON is the one format where pretty-printing is unconditionally
safe (`CONCEPT.md` §5.7). `canFormat: true`.

**Acceptance:** parses all JSON fixtures. Passes the B12 invariant suite. `deep-10k.json`
parses successfully; `deep-1m.json` produces a Fatal diagnostic and does **not** crash.
Round-trips `format()` output through `parse()` to an identical tree shape.

## B9 — XML parser

**File:** `src/formats/xml/index.ts`, implementing `FormatModule`.

Explicit stack of `{ node: NodeRef, nameId: number }`.

Dispatch on `<`:

| Prefix | Handling |
|---|---|
| `</` | end tag — match against stack top by `nameId`; mismatch is an Error diagnostic, then recover by popping to the nearest match |
| `<?xml` | prolog — extract `encoding="..."` for `detectEncoding` |
| `<?` | `ProcessingInstruction` |
| `<!--` | `Comment` |
| `<![CDATA[` | `CData` |
| `<!DOCTYPE` | `DocType` — scan balanced brackets, do not attempt to parse internal subsets |
| otherwise | start tag |

Start tags: name, then attributes as `name` `=` `"value"` or `'value'`. Self-closing `/>`
opens and immediately closes. Emit `xmlns` and `xmlns:*` as **ordinary attributes** — the
sink handles namespace scope, not you (§2).

**Text handling follows `CONCEPT.md` §3.2, and it is not the obvious implementation.** M0a
measured that a Text node per text run makes 66% of the store whitespace and single-value
wrappers, at ~5× the file size instead of ~2.5×. Two rules:

- **Whitespace-only text between elements produces no node.** Set `droppedWhitespace` on
  the parent instead. Exception: inside `xml:space="preserve"`, emit it normally.
- **An element with exactly one text run and no child nodes** holds that run in its own
  value via `value()` on the element — no `Text` node. An element that *has* child nodes
  keeps its text runs as ordered `Text` nodes and gets `isMixed`; mixed content is
  unaffected.

Both are decidable in one pass. Hold at most one pending text run per stack frame plus a
`hasChildNodes` boolean: when a child node opens, flush the held run as a `Text` node first;
at the end tag, fold it if no child node was ever opened. Buffering is O(depth).

Track `xml:space` as a scope stack alongside namespace scope, and carry it in
`ResumeContext` — `parseRange` starting mid-document must know whether it is inside a
preserve scope. Implement this even though M0 sets `canFormat: false`; retrofitting scope
tracking into a finished parser is a rewrite.

Do not decode text to classify it as whitespace — test bytes for `0x20`, `0x09`, `0x0A`,
`0x0D` directly.

**Do not decode entity references** in M0. Spans describe source. Note it as deferred.

`hasAttributes: true`, `hasNamespaces: true`, `hasComments: true`.

`resumeContextFor`: rebuild the namespace scope stack by walking ancestors and reading
their `xmlns` attributes — this is the one place decoding from `AncestorView` is expected.
**Rebuild the `xml:space` scope in the same walk.** Without it, `parseRange` inside a
preserve scope drops whitespace the full parse kept, and B12's subtree-reparse-equivalence
invariant fails on exactly the documents the rule exists for.

`format`: **not implemented in M0.** Set `canFormat: false`. Safe XML formatting requires
mixed-content detection and is scheduled for M5.

**Acceptance:** parses all XML fixtures. Passes B12. Handles the `<engine>petrol</engine>`
vs nested `<engine>` variance in the fixtures. Unclosed tags produce diagnostics and a
partial tree rather than a throw.

## B10 — Format registry

**File:** `src/formats/registry.ts`

```ts
export function selectFormat(
  head: Uint8Array,
  filename: string | null,
): FormatModule | null
```

Call `detect()` on each registered module, return the highest confidence above 0.5, or
null. Registration is a static array — no plugin loading in M0.

**Acceptance:** correct selection for `.xml`, `.json`, an extensionless XML file, an
extensionless JSON file, and null for a plain text file.

## B11 — Worker pipeline

**Files:** `src/worker/parse.worker.ts`, `src/core/parseClient.ts`

The worker receives `{ bytes: ArrayBuffer, filename }` as a **transferred** buffer,
selects a format, parses into a `NodeStore`, and transfers the resulting arrays back —
also zero-copy.

**Transfer the source buffer back as well.** A transfer *detaches* the sender's
`ArrayBuffer`, so after posting it the main thread no longer has the document — and it
needs it for the Raw View's window (`CONCEPT.md` §4.4) and for Save (§5.5). Returning it
alongside the store arrays is the M0 answer and costs nothing, since transfers are
pointer moves.

> **Report, do not decide:** this leaves the buffer ping-ponging once per parse, and
> §6.6 wants the worker to query the same store for search later, which will want it in
> both places at once. `SharedArrayBuffer` is the obvious answer and needs cross-origin
> isolation configured in the Electron shell. M0 does not need to solve this — note in
> `docs/plans/M0-RESULTS.md` whether the ping-pong showed up in the timings.

Post progress messages at ~1 MB intervals. Support cancellation via a message that
triggers the `AbortSignal` passed in `ParseOptions`.

`parseClient.ts` wraps this in a promise-based API with a progress callback.

**Acceptance:** a 200 MB XML fixture parses in the worker; the main thread stays
responsive throughout (verify with a `requestAnimationFrame` counter that never drops
below ~50 fps). All arrays arrive intact **and the source buffer is not detached on the
main thread** — assert `bytes.byteLength !== 0` after the parse resolves. Cancellation
mid-parse resolves cleanly without leaking the worker.

The responsiveness check needs a real renderer with real `Worker` and `requestAnimationFrame`
— Vitest's default Node environment has neither, and jsdom's worker support will not
exercise a transfer. Decide how to run it (an Electron-hosted test, or a small manual
harness like M0a's) and record the choice; if this turns into more than an afternoon,
report rather than weakening the test into something that passes without proving anything.

## B12 — Invariant test suite

**File:** `test/invariants.test.ts`

Runs against **every** fixture, for both parsers. These are the tests that protect the
architecture; write them properly.

**Numbered B12 but written during B8.** B8's and B9's acceptance criteria both say "passes
the B12 invariant suite," which is impossible if the suite is written last. Build the
invariants against JSON as B8 lands, then extend them to XML with B9 — the invariants are
format-agnostic by construction, so this costs nothing and means the parsers are being held
to them while they are being written rather than afterwards.

1. **Span containment** — for every node: `spanStart < spanEnd`; the span contains the
   value range *when one is present*; the span lies fully within the parent's span.
   Absent values (`valueStart === -1`, per B6) and absent names (`nameId === -1`) are
   normal and must be skipped rather than treated as zero-length ranges at offset 0 — an
   assertion that forgets this passes on the fixtures and fails on the first array
   element. Names are not span-checkable at all: they live in the intern table (B5), not
   as offsets.
2. **Sibling ordering** — consecutive siblings do not overlap and are in ascending offset
   order. They need **not** be contiguous: B9 drops whitespace-only text nodes, so gaps
   between sibling spans are expected and are not a defect.
3. **Link consistency** — `prevSibling`/`nextSibling` are mutual inverses; `parent` agrees
   with `firstChild` traversal; every node is reachable from the root exactly once.
4. **Subtree reparse equivalence** — for 100 randomly chosen nodes, call `parseRange` over
   the node's span and assert the resulting subtree has identical shape, kinds and
   interned names to the original. *(This is the closest M0 gets to the round-trip test,
   and it directly validates the incremental reparse design.)*
5. **Truncation fuzz** — truncate each fixture at 200 random offsets; assert no throw, no
   hang beyond 10 s, and that diagnostics are produced.
6. **Byte fuzz** — corrupt 100 random bytes in each fixture; same assertions.
7. **Depth limit** — nesting beyond `maxDepth` yields a Fatal diagnostic, never a crash.

Fixtures over 50 MB should be skipped unless an env var is set, so the default test run
stays fast. Add `npm run test:large`.

**Acceptance:** all invariants pass on all fixtures for both formats.

## B13 — CLI harness

**File:** `src/cli/inspect.ts`, script `npm run inspect -- <file>`

Prints: detected format, encoding, parse time, node count, interned name count, memory
used by the store, diagnostic count, and the first three levels of the tree as indented
text.

This is how M0 is demonstrated and how performance regressions get noticed before there
is any UI.

**Acceptance:** produces sensible output for every fixture.

---

# Definition of done for M0

- [ ] `spike/RESULTS.md` complete, both A5 and A6 decision tables applied; A6b run and its
      table applied
- [ ] XML and JSON both implement `FormatModule` without modifications to `types.ts`
- [ ] All B12 invariants pass on all fixtures, both formats
- [ ] `cars-200mb.xml` parses in the worker in **under 3 seconds**, with the main thread
      never blocked
- [ ] For `cars-200mb.xml`: node count within 10% of **6.6 M**, and the model — node store
      plus attribute table plus row index, excluding the source buffer — under **320 MB**.
      *This is the direct test of B9's text rules: emit a node per text run by mistake and
      the count roughly triples, which is the point of measuring it rather than trusting it*
- [ ] Total process memory for the same file under **800 MB**
- [ ] `deep-1m.json` produces a diagnostic and does not crash
- [ ] Node counts for `cars-100mb.json` and `cars-100mb.min.json` recorded in
      `docs/plans/M0-RESULTS.md`. No bar to hit — M0a measured XML only, so this establishes the
      JSON baseline that does not yet exist (`CONCEPT.md` §13)
- [ ] `npm run inspect` works on every fixture
- [ ] `npm run typecheck` and `npm run lint` clean
- [ ] **No UI code exists** beyond the empty scaffold window
- [ ] A short `docs/plans/M0-RESULTS.md` recording measured throughput, memory, and any
      deviation from this plan

## Report back on any of these

- A6b failing either bar — it decides whether the Raw View needs a second implementation
- Node count or model size materially over the done-criterion figures above
- Parser throughput under 50 MB/s
- Any need to change `src/core/types.ts`
- Any invariant that cannot be satisfied without changing the design
- Anything in `CONCEPT.md` that turned out to be wrong once implemented

The last one matters most. The concept has been reviewed twice but never executed.
