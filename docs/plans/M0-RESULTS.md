# M0 — Results

Records what M0b measured, against the bars `M0-PLAN.md` sets, and every place this
implementation deviates from or extends the plan as written. Companion to `spike/RESULTS.md`
(M0a); this covers B1–B13. **Updated for M0c** (`docs/plans/M0c-PLAN.md`): the BOM/encoding pipeline,
the row index, the store-transfer allocation, the worker's forwarding sink, and real
cancellation. Figures below are re-measured on the current tree; anything not re-measured is
annotated as such rather than left stale.

## Status

All of B1–B13 are implemented and tested, plus M0c's five close-out items (C1–C5) and its two
documentation/tooling fixes (C6, C7). One item remains genuinely unverified in this
environment, called out below rather than faked (B11: *"Decide how to run it... if this turns
into more than an afternoon, report rather than weakening the test into something that passes
without proving anything"*).

- `npm run typecheck`, `npm run lint`: clean.
- `npm test`: **137 tests passing across 12 files** (encoding, buffer, interner, node store,
  row index, JSON parser, XML parser, format registry, invariants, worker job, store
  transfer, and the new encoding-pipeline suite for M0c's BOM handling). `npm run test:large`
  extends the invariant suite to the 50–500 MB fixtures.
- `npm run inspect -- <file>` produces sensible output for every fixture in
  `spike/fixtures/`, now including row count, row-index size and build time, and the
  resolved encoding.
- `npm run fixtures:generate` is gone (C7) — it pointed at a generator that was never
  written. `spike/generate-fixtures.ts` is the actual fixture generator; the README's
  command table and fixtures section now say so.

## Definition-of-done figures

Measured via `npm run inspect -- spike/fixtures/cars-200mb.xml`, a standalone script for
`runParseJob`'s own path, and a one-off script using `process.memoryUsage()` with
`--expose-gc` (none of these committed — trivial to reproduce; see the CLI's own output for
the shape).

| Metric | Bar | Measured |
|---|---|---|
| Parse time, `cars-200mb.xml`, direct compute path (no worker transfer) | < 3 s | **3.2–3.3 s** (this pass; see note below) |
| `runParseJob` (parse + row index build), vs. the direct path | within 5% | **~4.3–4.6 s vs. ~4.3–4.4 s direct — within ~5%** (C4 closed the prior 21% gap) |
| Node count, `cars-200mb.xml` | within 10% of 6.6 M | **6,592,652** (unchanged) |
| Row index, `cars-200mb.xml` | ~30 MB, not materially over 1 s | **7,796,094 rows, 29.74 MB, ~0.9–1.1 s build** |
| Node store + attribute table + row index (packed, excl. source buffer) | < 320 MB | **287.0 MB** (257.3 MB store/attributes, unchanged, + 29.7 MB row index) |
| Total process RSS after parsing `cars-200mb.xml` (in-process, not via a worker transfer) | < 800 MB | **~589 MB** |
| `deep-1m.json` | Fatal diagnostic, no crash | confirmed |

**Parse time moved from 2.7–2.8 s to 3.2–3.3 s.** This is machine noise, not a regression —
C4 removed the forwarding-sink overhead the M0b figure never had in the first place (that
figure was already measured on the direct path `inspect.ts` uses, the same path measured
here). Re-running the M0b baseline's own methodology today, on this machine, under today's
background load, reproduces the same upward drift on unrelated unchanged code, which is the
tell. Reported honestly rather than smoothed: **the < 3 s bar was already missed on every run
at M0b** (`M0-RESULTS.md`'s own text said 2.7–2.8 s against several runs that in fact ranged
higher — see `M0c-PLAN.md`'s C6), and it is still missed now. This is a decision for the user,
not a bar to quietly relax.

**The row index is a real line item, not free (C2).** Extrapolating cars-200mb.xml's 29.7 MB
to 500 MB gives ~78 MB — accounted for in the 320 MB budget above, which is why it is now its
own row rather than folded silently into node-store memory the way M0b's own report did.
`buildRowIndex` was rewritten from a boxed `number[]` accumulator to a growable
`Int32Array`. Its capacity estimate (`bytes.length / maxRowBytes`) undershoots a
pretty-printed, one-record-per-line file like this one — the real average is ~27 bytes/row
against a 512-byte cap, so the array doubles a handful of times before trimming. A pre-scan
for the real newline density was tried and rejected: it sizes the array exactly but costs
~40% of the function's own build time to do it.

> **Corrected on review (M1 D0.3).** The paragraph above originally claimed the rewrite cut
> "both the transient overhead and, incidentally, the build time." Re-measured, it cut
> neither materially. Peak live memory during the build is **79.7 MB** — a 50.0 MB
> accumulator at final capacity plus the 29.7 MB `toArray()` slice, 2.7× the result — where
> the boxed `number[]` version peaked around 78 MB; and 930 ms against 994 ms is inside
> run-to-run noise. C2's own acceptance criterion ("the transient heap delta drops below
> the size of the resulting array") is **not met**.
>
> What the rewrite did buy is real and worth keeping: no boxing, and no GC pressure from
> 7.8 M pushes. The estimate is the problem — 409,602 against a true 7,796,094, 19× under.
>
> The pre-scan's cost was also mis-measured: a correct counting pass is a second full scan,
> **951 ms against a 930 ms build (~100%, not ~40%)**. Rejecting it was right; the figure
> above should not be reused.
>
> M1 D0.3 takes the third route — size the array from a 256 KB sample (measured at 0.91×
> the true row count on every fixture, for 1.1 ms) and return a view rather than copying
> when the overshoot is small. Expected peak **32.7 MB** at ~931 ms. That paragraph
> restates this figure once implemented.
>
> **Implemented (M1 D0.3).** `estimateRowCount` and the `subarray`-vs-`slice` choice in
> `GrowableInt32.toArray` are in `src/core/rowIndex.ts`; B7's existing tests pass
> unmodified and new tests assert the estimate is within 2× of the true row count on both
> a pretty-printed and a minified fixture. The 32.7 MB / 931 ms figures above are the
> sampling method's own arithmetic, not yet re-measured against `cars-200mb.xml` directly —
> that measurement belongs in `docs/plans/M1-RESULTS.md` (D15) alongside the other deferred
> numbers, not repeated here piecemeal.

**Packed vs. allocated.** `NodeStore.exportBuffers()`/`estimatedMemoryBytes` report the
arrays' *allocated capacity*, which can run up to ~2× the packed figure right after a
capacity-doubling growth step (336 MB allocated vs. 257 MB packed, for `cars-200mb.xml`,
measured on the live in-worker store before export). `packedMemoryBytes` reports the
tight figure the done-criteria bar is actually measured against — it is computed
arithmetically (`count × 38 + attrCount × 16`, per `CONCEPT.md` §3.2's per-node/per-attribute
byte layout) rather than measured from the arrays' actual `byteLength`. That is honest and
correct given the layout is fixed, but it cannot catch an accidentally-added sixteenth column,
and a reader skimming the number alone would assume it was weighed rather than computed. In
the real pipeline the packed/allocated distinction mostly disappears on the main thread:
`exportBuffers()` always returns trimmed copies, so a store received over the worker transfer
is already packed — only the worker's own transient parsing-time footprint sees the allocated
figure. `NodeStore.fromBuffers` reconstructing that store on the main thread no longer
allocates its own full-size scratch arrays only to discard them (C3, below) — a test asserts
this directly for a synthetic 1M-node transfer.

**JSON node density** (§13 open question, previously unmeasured):

| Fixture | Nodes |
|---|---|
| `cars-100mb.json` (pretty) | 5,085,254 |
| `cars-100mb.min.json` | 8,866,489 |

The minified file has ~1.7× the node count of the pretty one at the same 100 MB cap —
expected, not a discrepancy: the generator fills each file to the same byte budget, and a
minified record is smaller, so more of them fit. Node density itself (bytes/node for a
given record) is unaffected by formatting, matching the design's claim that whitespace
handling is orthogonal to the unified node model.

## Not verified in this environment

One thing B11 asks for could not be exercised here, and is reported rather than faked:

1. **Main-thread responsiveness during a large parse.** B11's acceptance criterion is a
   `requestAnimationFrame` counter staying above ~50 fps while a 200 MB file parses in the
   worker — this needs a real `Worker` and a real render loop, both absent from Vitest's
   default Node environment (the same limitation the plan itself calls out). `parse.worker.ts`
   is structured so its actual job (`runParseJob`) is a plain, directly-callable function
   exercised by `test/parseWorker.test.ts`; only the thin `self.onmessage` wiring around it is
   unverified. Running this properly needs an Electron-hosted harness in the style of
   `spike/codemirror-harness/` — not built in this pass.

**Cancellation is fixed as of M0c (C5)** and no longer belongs on this list. The parse itself
is still a single synchronous call per parser — chunking the tokenizer across event-loop turns
remains real added complexity nothing has asked for — so a `cancel` message posted into the
worker still cannot be *processed* until that call returns, exactly as before. What changed:
`parseClient.ts` no longer relies on the worker processing that message at all. `AbortSignal`'s
`abort` event fires synchronously on the main thread the moment `signal.abort()` is called,
independent of anything the worker is doing, and the handler now calls `worker.terminate()`
right there — which genuinely stops the parse immediately, because the worker is a whole OS
thread being killed, not a message waiting in a queue — and rejects the caller's promise with
`AbortError`. The `cancel` message and the worker-side `AbortController` stay wired for the
persistent worker §6.6 will eventually want for search, but they are not the mechanism that
makes cancellation work today; `worker.terminate()` is. A test proving this needs a real
`Worker`, so — per `M0c-PLAN.md`'s own note — it belongs with the Electron-hosted harness above
or with M1's D15, not here.

## SharedArrayBuffer note (B11's own flagged question)

B11 asks whether the source-buffer ping-pong (worker → main → worker again for a future
incremental reparse) shows up in the timings. It wasn't measured here: `runParseJob` was
exercised as a direct function call in every test (per the point above, there is no real
Worker in this environment to transfer through), so no structured-clone/transfer overhead
was ever actually incurred. The parse-time figures above are pure compute; they do not
include whatever `postMessage`-based transfer costs an Electron-hosted run would add. Still
open, and still not this milestone's question to settle (M0c's C5 explicitly left it alone
when fixing cancellation): the `self.onmessage` handler now also transfers `rowIndex`'s
backing buffer alongside the source bytes, but `storeBuffers`' and `internerBuffers`' own
typed arrays are still passed through structured clone rather than transfer, and therefore
copied on every parse rather than moved — noted here rather than silently fixed, since it
wasn't one of M0c's five named defects and changing it touches the same transfer list this
milestone already had to reason about for the row index. Worth folding into whichever future
task actually measures the ping-pong.

## Deviations from the plan as written

- **`src/core/nodeStore.ts` gained `exportBuffers`/`fromBuffers`, `estimatedMemoryBytes`,
  `packedMemoryBytes`**, and **`src/core/interner.ts` gained `exportBuffers`/`fromBuffers`** —
  needed for B11's zero-copy worker transfer and not enumerated in B6/B5's original field
  lists. Additive; nothing existing changed shape.
- **`import.meta.env.DEV` guards use optional chaining** (`import.meta.env?.DEV`) rather than
  the bare form CLAUDE.md's convention shows. `import.meta.env` is a Vite-only global and is
  `undefined` when code runs under plain `tsx` — which is exactly how `npm run inspect` and
  `npm run test:large`'s large-fixture runs execute. The bare form threw outside Vite; this
  was caught by running `inspect` against a real fixture, not by the test suite.
- **A real bug in `parseRange`, caught by `test/xmlParser.test.ts`**: `scanUntilLiteral`
  computed the position just past a terminator (`-->`, `]]>`, `?>`) but never actually
  advanced the parser's cursor to it — every caller (comments, CDATA, PIs, the XML
  declaration) left `state.pos` sitting *at* the terminator instead of past it, so the next
  token was misread as leftover text. Fixed by having the function advance `state.pos` itself
  rather than returning a value callers had to remember to apply.
- **A real bug in the XML parser's trailing-text handling**, also caught by tests: an
  element's *last* text run (after other children, e.g. `<a><b/> </a>`) was being folded
  directly into the element's own value instead of becoming a trailing `Text` node — the
  `hasChildNodes` bookkeeping needed to distinguish "sole content" from "trailing run after
  siblings" had been dropped during cleanup and needed restoring specifically for the
  close-time flush path.
- **`npm test`'s default run takes ~80s**, almost entirely the 200-iteration truncation fuzz
  (B12, invariant 5) against the smallest default fixture, `cars-10mb.xml`. This is what
  B12 asks for, run faithfully; noting it since "the default test run stays fast" was M0's
  own goal for gating large fixtures, and 80s is slower than the rest of the suite combined
  by two orders of magnitude.

### M0c deviations

- **`fixtures:generate` (flagged above as a broken script) is now gone (C7)**, rather than
  fixed by writing the generator it pointed at. `spike/generate-fixtures.ts` already produces
  the right shapes and `spike/fixtures/` already has them checked in as gitignored artifacts;
  writing a second generator for `test/fixtures/generated/` would have been an unrequested
  parallel implementation of the same thing. The README's command table and fixtures section
  now point at the script that actually exists.
- **`NodeStore`'s constructor gained a fourth, optional `onProgress` parameter** (C4), called
  from `progress()` in addition to recording it locally. This is what let
  `parse.worker.ts` hand the store straight to `format.parse()` instead of wrapping it in a
  six-method forwarding `NodeSink` whose only reason to exist was relaying `progress` calls —
  additive, and every other `NodeStore` call site is unaffected by the new optional parameter.
- **`ParseClientResult`'s shape changed**: `bytes: Uint8Array` is gone, replaced by
  `sourceBuffer: SourceBuffer` (constructed from the worker's resolved `encoding` and
  `bomLength`, per C1), plus new `encoding`, `bomLength` and `rowIndex` fields. There were no
  callers yet (`parseClient.ts` is called by nothing outside its own tests), so this is a
  clean reshape rather than a breaking change to anything real.
- **`core/encoding.ts` gained `bomLengthAt`**, a thin wrapper around the same BOM-detection
  logic `stripBom` already had, for the parsers and `runParseJob` to skip a leading BOM in
  place without ever slicing it off (C1's resolution: nothing strips a BOM; spans stay
  absolute in the original buffer).

## Regression baselines going forward

- `cars-200mb.xml`: **~3.2–3.3 s** parse (compute only, no worker transfer overhead measured;
  see the note above on why this moved up from M0b's 2.7–2.8 s — machine noise, not a
  regression from anything changed this milestone).
- `cars-200mb.xml` via `runParseJob` (parse + row index, the worker's own path): **~4.3–4.6 s**,
  within ~5% of the direct path's equivalent total — this is the figure C4 was measured
  against, since M0b's 21%-slower forwarding sink no longer exists.
- `cars-200mb.xml` node store + attribute table: **257.3 MB packed** (unchanged).
- `cars-200mb.xml` row index: **7,796,094 rows, 29.74 MB, ~0.9–1.1 s build**.
- `cars-200mb.xml` node store + attribute table + row index: **287.0 MB packed** — the figure
  the < 320 MB done-criterion actually applies to; M0b's report only covered the first two
  terms.
- The parser production figure quoted in `CONCEPT.md` §12 (~65 MB/s, 200 MB in ~3.15 s) is the
  same order as the parse-time baseline above and was already corrected before this milestone
  began — not a change made here.
- Node density: XML ~32 bytes/node pretty-printed (confirmed at M0a); JSON density now has a
  first measurement (above) but no M0a-equivalent byte/node figure computed yet — worth
  adding if JSON becomes a large-file target before M1.
