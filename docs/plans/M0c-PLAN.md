# NodePad — M0c Implementation Plan

<!-- status: built -->

**Audience:** the coding agent implementing this milestone.
**Reference:** `CONCEPT.md` (design), `M0-PLAN.md` (what M0b was asked to build),
`M0-RESULTS.md` (what it produced), `src/core/types.ts` (the format contract).

---

## Why this milestone exists

M0b built the data layer and it works: 130 tests pass, the parsers are correct, node
density and store size land where `CONCEPT.md` §3.2 predicted. `M0-RESULTS.md` is an
honest report and its two self-declared carve-outs were the right calls.

A review after the fact found **five things nothing owned**. Four of them are the sort of
gap that only appears once two callers exist: `inspect.ts` and `parse.worker.ts` do the
same job differently, and where they differ the worker is wrong. The fifth is a
performance defect in the worker's own plumbing.

None of this is rework. It is the wiring between B3, B7 and B11 that no task was written
for, plus three small fixes. It is separated from M1 rather than folded into its first
task because **M1 builds directly on top of all five**: the Raw View cannot decode a window
without an encoding, the scrubber is defined in terms of a row index that is never built,
and the main thread cannot afford a 356 MB throwaway allocation at exactly the moment it
takes delivery of the store.

Budget: a day, not a week. If any task here turns into more, stop and report.

## Hard rules

The M0 rules still apply in full — no recursion in parsers, never convert the source to a
JavaScript string, no object per node, parsers never throw on malformed input, no new
dependencies, and **do not modify `src/core/types.ts`**.

One addition specific to this milestone:

7. **Spans are absolute offsets into the buffer as it was read from disk.** Not into a
   BOM-stripped view of it, not into a subarray. Save writes that buffer (invariant 6) and
   the Raw View windows it (§4.4); every span has to index the same bytes both of them
   hold. C1 exists because this is currently not true.

---

## C1 — Encoding and BOM through the pipeline

**Files:** `src/worker/parse.worker.ts`, `src/core/parseClient.ts`,
`src/formats/xml/index.ts`, `src/formats/json/index.ts`, `src/cli/inspect.ts`,
`test/encodingPipeline.test.ts` (new), `test/invariants.test.ts`

### The defect

`runParseJob` calls `format.detectEncoding(head)` — the *declared* encoding, from the XML
prolog — and never calls `core/encoding.ts`'s `detectEncoding`, which is the function that
reads the BOM. It never calls `stripBom` either. B3 built BOM handling and tested it; B11
never called it, because no task said to. B8 delegated to it explicitly: *"`detectEncoding`:
return null (JSON is UTF-8 by spec; BOM handling covers the rest)."*

Measured through `runParseJob` today:

| Input | Result |
|---|---|
| `{"a":1}` | 3 nodes, 0 diagnostics — correct |
| `{"a":1}` with a UTF-8 BOM | **2 nodes, 2 diagnostics** — `json.bad-literal @0`, `json.trailing-content @1` |
| `<?xml…?><a><b>1</b></a>` with a UTF-8 BOM | **4 nodes** — a phantom `Text` node at span 0–3, and **no diagnostic at all** |
| UTF-16LE XML with a BOM | 8 nodes, `complete: false`, one misleading diagnostic |

B12 does not catch any of this because no fixture carries a BOM. A BOM is what PowerShell,
.NET and several XML editors write by default, so this is a first-week bug in M1, not an
exotic case.

### The design question, and its answer

`inspect.ts` gets the BOM right in one sense — it calls `stripBom` — and wrong in another:
it then parses the **stripped subarray**, so every span it produces is an offset into a
buffer that is 3 bytes shorter than the file on disk. B3 stated the requirement plainly:
*"all spans must be offsets into the original buffer, so record it rather than discarding
it."* Two callers, two behaviours, neither matching the spec.

**Resolution: nothing strips. The parsers skip a leading BOM and spans stay absolute in
the original buffer.**

This is the only option that does not require a correction term somewhere. Save writes the
original bytes; the Raw View windows the original bytes; a span that is off by `bomLength`
from either is a bug waiting for its first BOM'd file. Adding the offset back at every
consumer is the same fix applied N times and forgotten once.

Rejected alternatives, so they are not re-proposed:

- *Strip and shift* — `bomLength` becomes a term in every offset conversion, including
  inside CodeMirror's window arithmetic where §4.4 already warns about fractional offsets.
- *Route through `parseRange(source, bomLength, …)`* — the contract says that range must
  contain **one well-formed subtree**, which a document with a prolog is not.
- *Bias the sink* — hides a document-level fact inside the store.

### Work

1. **Both parsers skip a BOM at offset 0.** XML already scans prolog and misc before the
   root; JSON already skips leading whitespace before the first value. Add `EF BB BF` at
   offset 0 to what each skips, and only at offset 0 — a BOM elsewhere is data.
2. **`runParseJob` resolves the encoding properly:**
   ```ts
   const declared = format.detectEncoding(head)          // XML prolog, or null
   const encoding = detectEncoding(head, declared)       // core/encoding.ts — BOM wins
   ```
3. **Refuse UTF-16 rather than mis-parsing it.** Both parsers are byte-oriented and assume
   an ASCII-compatible encoding; on UTF-16 input they currently produce a plausible-looking
   tree from nonsense. If the resolved encoding starts with `utf-16`, do not parse: emit a
   single Fatal diagnostic `nodepad.encoding.unsupported`, return `complete: false`, and
   report the encoding anyway so the UI can say *why*. This is §11.1's partial-document
   path, not a violation of "parsers never throw" — nothing throws, and a Fatal diagnostic
   is exactly the contract's signal for "cannot continue past this point."

   Real UTF-16 support is a separate piece of work and belongs with `CONCEPT.md` §13's
   legacy-encodings question. Do **not** start it here.
4. **Carry the result out.** `ParseDoneMessage` and `ParseClientResult` gain
   `encoding: string` and `bomLength: number`. `parseClient` constructs the `SourceBuffer`
   (B4) from them and returns it — B4 has been shipped, tested, and called by nothing since.
5. **`inspect.ts` stops parsing the stripped subarray.** It may keep calling `stripBom`
   for the `bomLength` it prints; it must parse the original buffer.

**Acceptance:**

- A BOM'd document and its un-BOM'd twin produce **identical node counts, kinds, names and
  child structure**, with every span in the BOM'd version exactly `bomLength` greater.
  Assert this mechanically over a small document of each format rather than eyeballing it.
- `{"a":1}` with a UTF-8 BOM parses to 3 nodes and 0 diagnostics through `runParseJob`.
- The XML BOM case produces 3 nodes, not 4, and no phantom `Text` node.
- UTF-16LE input yields exactly one Fatal diagnostic, `complete: false`, and a reported
  encoding of `utf-16le`.
- `ParseClientResult.encoding` round-trips a declared `ISO-8859-1` from an XML prolog.
- The B12 invariant suite gains BOM'd variants. Keep them small and in-memory; the point
  is coverage of the offset arithmetic, not another gigabyte on disk.

---

## C2 — Build the row index in the pipeline

**Files:** `src/core/rowIndex.ts`, `src/worker/parse.worker.ts`, `src/core/parseClient.ts`,
`src/cli/inspect.ts`

`buildRowIndex` is implemented, tested by B7, and **called by nothing**. `CONCEPT.md` §3.1
says it is "built once during parsing"; §4.5 defines the scrubber as a ratio resolved
through it; M0's own done criterion counts it in the memory bar — *"node store plus
attribute table plus row index, excluding the source buffer — under 320 MB"* — and
`M0-RESULTS.md` silently reports only the first two terms.

### Build it in the worker

Not on the main thread. Measured on `cars-200mb.xml`, building the index takes **994 ms**.
That is the entire reason there is a worker.

### It is bigger and more expensive than it looks

| Fixture | Rows | `Int32Array` | Build | Transient heap |
|---|---|---|---|---|
| `cars-200mb.xml` | 7,796,094 | 29.7 MB | 994 ms | **78 MB** |
| `cars-100mb.min.json` | 207,189 | 0.8 MB | 449 ms | 6 MB |

Two things to take from that table:

- **29.7 MB against §8's budgeted 31 MB.** The concept's estimate was accurate. Good — but
  it means the row index is a real line item, and extrapolating to 500 MB gives ~19.5 M
  rows and ~78 MB. It is not free and must appear in the reported memory figure.
- **78 MB of transient heap to produce a 29.7 MB array.** `buildRowIndex` accumulates into
  a JS `number[]` and finishes with `Int32Array.from(starts)` — 8 bytes per boxed slot plus
  growth churn plus the final copy, 2.6× the result. At 500 MB that transient is over
  200 MB. **Build directly into a growable `Int32Array`** with the same amortized doubling
  `NodeStore` already uses. This should also cut the 994 ms materially; 7.8 M `Array.push`
  calls are most of it.

### Work

1. Rewrite `buildRowIndex`'s accumulator as a growable `Int32Array`. The signature and
   semantics do not change and B7's tests must pass untouched — if any of them needs
   editing, the behaviour changed and that is a bug, not a test problem.
2. Build the index in `runParseJob` after the parse, using
   `format.capabilities.rowBreakBytes` and `DEFAULT_MAX_ROW_BYTES`.
3. Transfer it back with the store arrays — it is an `Int32Array`, so zero-copy, same as
   the rest.
4. `ParseClientResult` gains `rowIndex: Int32Array`.
5. `inspect.ts` reports row count and row-index bytes, and includes them in the memory line.

**Acceptance:** B7's existing tests pass unmodified. `inspect` on `cars-200mb.xml` reports
7,796,094 rows. The transient heap delta while building drops below the size of the
resulting array. `ParseClientResult.rowIndex.length` matches what `buildRowIndex` returns
for the same bytes.

---

## C3 — `fromBuffers` must not allocate what it discards

**File:** `src/core/nodeStore.ts`

`NodeStore.fromBuffers` passes `buffers.nodeCount` as `initialCapacity`, so the constructor
allocates all fifteen backing arrays at full size — and then every one of them is
overwritten by the transferred buffer on the next fifteen lines.

Measured: **51.5 MB of throwaway allocation for a 1 M-node store**, which is 54 bytes per
node, matching the constructor's arithmetic exactly (38 B of node columns + 16 B of
attribute columns, the latter also sized at `nodeCount`). At `cars-200mb.xml`'s 6.6 M nodes
that is **~356 MB allocated and immediately discarded** — on the main thread, in the same
tick that takes delivery of a zero-copy transfer whose entire purpose was to avoid copying.

Pass `1`. Add a comment saying why, because `Math.max(1, buffers.nodeCount)` looks
deliberate and someone will "fix" it back.

**Acceptance:** a test asserting that reconstructing a 1 M-node store allocates less than
1 MB beyond the buffers handed to it. Measure `process.memoryUsage().external` around the
call — the arrays are typed, so `external` moves and `heapUsed` largely does not.

---

## C4 — Parse into the store directly

**Files:** `src/worker/parse.worker.ts`, `src/core/nodeStore.ts`

`runParseJob` wraps the `NodeStore` in an object literal of six forwarding arrow functions,
solely so that `progress` can also call `postMessage`. That converts the hottest call site
in the program — roughly 6.6 M `openNode` plus `closeNode` plus `value` calls on a 200 MB
file — from monomorphic-on-`NodeStore` into a closure hop each.

Measured on `cars-200mb.xml`:

| Path | Parse |
|---|---|
| Parser → `NodeStore` directly (what `inspect` does) | 3,234 ms |
| Parser → the worker's forwarding sink | **3,923 ms** |

**~690 ms, or 21%, for one relayed callback.**

Give `NodeStore` an optional progress hook — a constructor argument or a settable field,
whichever reads better — and pass the store to `parse()` directly, exactly as `inspect.ts`
already does. One call site, one shape, one implementation of `NodeSink` live per parse,
which is what `types.ts` says the hot path is supposed to look like:

> *"The hot path is monomorphic in practice because exactly one implementation is live per
> parse."*

That sentence is currently false in the worker, which is the only place it matters.

**Acceptance:** `runParseJob` on `cars-200mb.xml` lands within 5% of the direct path.
Progress messages still arrive at ~1 MB intervals — `test/parseWorker.test.ts` already
covers this and must keep passing.

---

## C5 — Make cancellation actually cancel

**File:** `src/core/parseClient.ts`

`M0-RESULTS.md` describes cancellation as *"a safe, non-throwing no-op if the request has
already completed."* It is stronger than that: it is a no-op **always**, and the caller's
promise does not reject either.

`onAbort` posts a `cancel` message and does nothing else. The worker is single-threaded and
`parse()` is fully synchronous, so that message cannot be dequeued until the parse has
finished — as `M0-RESULTS.md` correctly explains. The consequence it does not draw: calling
`signal.abort()` mid-parse leaves the promise pending until the parse completes, then
resolves it with a **full, successful result**. The abort is invisible to the caller.

This needs neither a `SharedArrayBuffer` nor a chunked parse loop. `parseInWorker` creates
one worker per parse and already terminates it on settle, so on abort:

1. `worker.terminate()` — this genuinely stops the parse, immediately
2. `reject(new DOMException('Parse aborted', 'AbortError'))`
3. mark `settled` so the late `onmessage` from a race does nothing

Keep the `cancel` message and the worker-side `AbortController`: they are the right shape
for the persistent worker §6.6 will want for search, and both parsers already check
`signal.aborted` in their main loops. They are simply not the mechanism that works today.

Do **not** treat this as settling the `SharedArrayBuffer` question. That decision belongs
with the buffer ping-pong, which is still open and still wants measuring first.

**Acceptance:** a test — this one needs a real `Worker`, so it belongs with the C6 harness
or with M1's D15 — in which aborting during a 200 MB parse rejects with `AbortError` inside
100 ms, and the worker is gone afterwards.

---

## C6 — Re-measure, and correct the record

**Files:** `docs/plans/M0-RESULTS.md`, `docs/CONCEPT.md` §12

### The parse-time bar is currently missed

`M0-RESULTS.md` reports **2.7–2.8 s** against a **< 3 s** bar. Five runs today, via
`inspect` on the direct path: 3.06, 3.11, 3.14, 3.21, 3.23 s. Through `runParseJob` as it
stands: 3.92 s parse, plus 162 ms for `exportBuffers`.

Caveat honestly: that is `tsx` under Node on one machine, not the electron-vite build, and
machine state differs. But the direct path missed the bar on **every** run, and the 21% gap
between the two paths (C4) is internal and machine-independent.

After C4 the worker path should converge on the direct path at ~3.2 s. **That is still over
the bar.** When you have the number:

- **Do not adjust the bar.** Report it. A criterion moved to fit the result stops being a
  criterion, and this project's working agreements say report rather than work around.
- Record the row-index build (C2) as a **separate** line, not folded into parse time. They
  are two passes with two different costs and M1 will want to optimize them separately.

### `CONCEPT.md` §12 says something now known to be false

> *"Parsers stay in TypeScript at a measured 200 MB/s."*

A3 measured the **throwaway spike parser**. The production parser — with interning, the
`NodeSink` contract, and B9's text rules — runs at 200 MB / ~3.15 s ≈ **65 MB/s**. The
conclusion still holds (TypeScript is fast enough; `CONCEPT.md` §10.1's WASM escape hatch
stays unused), but the number is wrong by 3× and is quoted as a measurement.

Fix the sentence. Add the real figure to `M0-RESULTS.md`'s regression baselines, and note
which parser each number describes.

### Also correct

- The memory row in the done-criteria table, which omits the row index the criterion names.
- The cancellation paragraph, per C5.
- Add a line stating that `packedMemoryBytes` is computed arithmetically
  (`count × 38 + attrCount × 16`) rather than measured from the arrays. It is honest and
  correct, but it cannot detect an accidental sixteenth column, and a reader will assume
  it was weighed.

**Acceptance:** every figure in `M0-RESULTS.md` reproduces on a fresh run of the current
tree, or is annotated with what changed.

---

## C7 — Fix or remove `fixtures:generate`

**Files:** `package.json`, possibly `test/fixtures/generate.ts`

`M0-RESULTS.md` flags this and is right to: `npm run fixtures:generate` is wired in
`package.json` and points at `test/fixtures/generate.ts`, which does not exist. B12's
invariant suite reads from `spike/fixtures/` instead, which already has the right shapes.

A broken npm script is a trap for the next agent. Either write the generator or delete the
script — do not leave it pointing at nothing. Deleting is defensible: the spike fixtures
are the fixtures, `.gitignore` already excludes them, and `spike/generate-fixtures.ts`
still rebuilds them.

If you delete it, also fix `README.md`'s command table, which lists it.

**Acceptance:** every script in `package.json` runs.

---

# Definition of done for M0c

- [ ] A BOM'd document parses identically to its un-BOM'd twin, spans offset by exactly
      `bomLength`, for both formats
- [ ] UTF-16 input is refused with one Fatal diagnostic, not mis-parsed
- [ ] `ParseClientResult` carries `encoding`, `bomLength`, `rowIndex`, and a `SourceBuffer`
- [ ] The row index is built in the worker, transferred, and counted in the memory figure
- [ ] `buildRowIndex`'s transient heap is smaller than its result, with B7's tests unmodified
- [ ] Reconstructing a store from transferred buffers allocates nothing it discards
- [ ] `runParseJob` parses within 5% of the direct path
- [ ] Aborting a parse rejects with `AbortError` and terminates the worker
- [ ] `npm test`, `npm run typecheck`, `npm run lint` clean; every `package.json` script runs
- [ ] `M0-RESULTS.md` reproduces, and `CONCEPT.md` §12's throughput figure is corrected
- [ ] Still **no UI code** beyond the scaffold — that is M1

## Report back on any of these

- Parse time still over 3 s after C4 — this is expected and is a decision for the user, not
  a bar to quietly relax
- The row index costing materially more than 30 MB or 1 s at 200 MB after the rewrite
- Any BOM or encoding case where keeping spans absolute in the original buffer turns out to
  need a correction term after all — that would mean C1's resolution is wrong
- Any need to change `src/core/types.ts`
