# NodePad — M5 Implementation Plan

<!-- status: built -->

**Status: built.** Tasks **H1–H12**. Results: `docs/plans/M5-RESULTS.md`. Register: `docs/TASKS.md`.
H1 was answered before implementation (deferred, D-043), which put H2 and H3 out of scope; H6 was
answered as "not built this milestone" (D-045). **H12 was built too** (D-048), past what this
plan's own definition of done asked for. Nothing here is open — see the definition of done below
for the one criterion that was reported as unmet and has since been reconciled rather than fixed.

*This file carried no status line at all until 2026-08-20, which is why R50's sweep of eleven
plan headers did not correct it and `CLAUDE.md` went on listing H2b/H2c/H2d/H11 as open for
months after they landed.*

**Audience:** the coding agent implementing this milestone.
**Reference:** `CONCEPT.md` §5.5 (two write paths — read all of it before H4), §5.7
(formatting policy), §3.4 (parsing pipeline), §8 (performance strategy and the memory
budget), §11.2 (soft caps). `DECISIONS.md` D-010, D-031, D-036 (**including its correction
addendum — H2b exists because of it**), D-037, D-040, D-041.

---

## How to use this plan

Work through tasks **in order**. Each has explicit acceptance criteria — do not move on
until they pass. Where a task says "stop and report," stop and report.

> **H1 has been answered by the project lead: streaming is deferred (D-043).** Waiting a few
> seconds to open a large file is an acceptable cost; holding the document four times over
> while doing it is not. **H2 and H3 are therefore out of scope for M5** and are kept below
> only so the analysis behind them survives. Do not build them.

> **What M5 actually is, after that decision:** three unconditional tasks that make large
> documents *usable* rather than merely openable — **H2b** (editing stops freezing the UI),
> **H2c** (opening stops spiking to ~4× the file size), **H4–H8** (Transforms stop spiking to
> ~11×) — plus H9 and the measurement pass. Every one of them is about memory or
> responsiveness. None of them is about waiting.

> **Do H2b and H2c before H4.** H4's Transform triggers the very reparse path H2b fixes and
> allocates through the very pipeline H2c fixes; building it first means measuring its cost
> through two problems that have nothing to do with Transforms.

### What M5 is

§12: *"Streaming tree population. Format/minify Transforms with the chunked write path
(§5.5), and the minified-file banner."*

Two independent halves that share one property: both are about what happens when the
document is large enough that doing the obvious thing costs more memory than the machine
has. §5.5's measurement is the milestone's motto — M0a watched a naive full-document
replacement take renderer RSS from **1191 MB to 5694 MB** on a 500 MB file, by holding the
old document, the new document and the source text at once.

M5 is also where the scale story either closes or is honestly declared closed-enough. §12
already notes it is *smaller than originally planned*: the custom virtualized raw viewer and
large-file mode were retired by windowing at M1.

### What M5 is not

- **No format conversion.** §5.5 lists "convert between formats" as a planned Transform. It
  needs a *writer* per format, and there is no writer contract — `FormatModule` has `parse`,
  `parseRange` and an optional `format`, and inventing a fourth member is a contract change
  (`src/core/types.ts`, do not modify). It also has no natural meaning until there are more
  than two formats to convert between. Out of scope; revisit after M6/M8.
- **No sort-keys Transform.** Also listed in §5.5, also out of scope: it reorders semantic
  content rather than whitespace, which makes it the one planned Transform that is not
  losslessly reversible, and it is not a scale concern. It can ship any time; it does not
  need this milestone's infrastructure.
- **No structural edit commands.** Still post-v1 (§5.4), and M3 already declined them for
  the same reason: they would reintroduce the serialization subsystem §5.1 exists to remove.
- **No tabs.** §11.4 is not in §12's roadmap at all. H9 surfaces the memory figure the tab
  policy will eventually need; it does not build the policy.
- **No YAML, no TOML, no predicates.** M6, M7, M8.

### Hard rules

1. **Save still writes the byte buffer and never generates text** (invariant 6). A Transform
   *is* the generating path, and §5.5's entire point is that the two must not touch. After a
   Transform, Save behaves normally again because the Transform already rewrote the buffer —
   not because Save learned to serialize.
2. **A Transform is one undo entry** however much text it rewrote (§5.6). H7 has a real
   memory problem hiding in that sentence; it is named there rather than discovered.
3. **Transforms are chunked** (§5.5). "A Transform therefore streams its output into a new
   buffer and swaps, rather than materializing everything and dispatching a single
   replacement."
4. **Formatting is conservative and partial, and that is correct behaviour, not a
   limitation** (§5.7). XML mixed content stays byte-identical; `xml:space="preserve"` is
   honoured. A formatter that reformats everything uniformly has corrupted character data.
5. **Never convert the source to a JavaScript string** (invariant 1) — including inside a
   formatter. A formatter reads bytes and writes bytes. The 5694 MB figure above is what
   happens when it does not.
6. **Save preserves the original encoding** (invariant 7). A Transform's output is written in
   the document's encoding, not UTF-8, and inherits the BOM if there was one.
7. **Do not modify `src/core/types.ts`.** H1 in particular will feel pressure to — see there.

---

# Tasks

## H1 — Can the tree stream? — **ANSWERED: no, deferred (D-043)**

> **Closed before implementation began.** The project lead's call, on the reasoning that a
> user opening a large file can reasonably expect to wait a few seconds, so time-to-first-row
> is the *weakest* of the three problems this milestone could spend itself on. The
> measurement that settled it is in H2c: the open pipeline peaks at **4.11× the file size at
> 200 MB and 3.84× at 500 MB** against §8's 2.5× budget — a memory problem strictly more
> serious than the waiting problem streaming would have solved, and one that streaming would
> have made harder rather than easier by adding a second live copy of the store.
>
> §13's *"Streaming tree presentation"* question is therefore **deferred, not answered** —
> nothing here decides how a partial tree should be shown, because no partial tree will
> exist. `NodeFlags.SubtreeComplete` and `SearchResult.provisional` stay as they are: unused
> seams, costing nothing, ready if this reverses.
>
> **The analysis below is retained deliberately**, not as work to do. It is the record of
> what streaming would cost and why, and route (b) in particular stays live for an
> independent reason — see D-043's revisit clause.

**Original deliverable:** a section in `docs/plans/M5-RESULTS.md` and an entry in `DECISIONS.md`. No
production code until it is written.

§3.4 says *"Streaming: emits nodes as it goes… the tree becomes browsable before parsing
completes, for very large files."* Nothing streams today, and the reason is structural
rather than an oversight.

**What exists.** The renderer reads the file over IPC (a structured-clone copy — ~955 ms at
200 MB, already flagged in `src/main/documents.ts`), transfers the bytes into the worker, the
worker parses to completion, and the `done` message transfers the store, the interner, the
row index and the bytes back. A transfer *detaches* the sender's copy. So during the parse,
**the renderer holds no bytes and no store**, and the worker holds everything.

**The prize is worth stating precisely.** 200 MB currently opens in ~5.46 s end to end. A
streamed tree would be browsable at roughly read-time plus one checkpoint — order 1 s. At
500 MB the gap is several times larger. This is the difference between a progress bar and a
usable application.

**Three routes. Evaluate all three; recommend one; record why.**

**(a) Structure-first streaming — no shared memory, no contract change.** The worker sends
periodic *append* messages: a copy of the store rows added since the last checkpoint, a copy
of the interner bytes added since the last checkpoint, and the small fixup set for nodes
still open on the parser stack (bounded by document depth, not size). The renderer appends
into a growing `NodeStore`. Total bytes copied is about what one `exportBuffers` already
copies, just in pieces. The bytes themselves transfer once, at the end.

Consequences, which must be shown to the user rather than papered over: the Tree shows
**structure and names** while parsing (names come from the interner, which streams), but
**values, Detail and Raw are unavailable until the bytes land**, because they need the
source. `NodeFlags.SubtreeComplete` already exists and is already set in `closeNode`, so
§3.4's *"a node's subtree carries a `complete` flag, and the Detail view shows a pending
state rather than a provisional grid"* is available for free — that flag was designed for
exactly this and has never been used for it.

**(b) `SharedArrayBuffer` for the source bytes.** Full fidelity while streaming: Raw, Detail
and search all read the same bytes the worker is parsing. It also closes documents.ts's
~955 ms copy and gives M4's search the worker home §6.6 always described. The cost is real:
`SharedArrayBuffer` requires cross-origin isolation, which this app does not have —
production loads over `loadFile`, there are no COOP/COEP headers, and enabling it means
either a custom protocol with those headers or a command-line switch, plus a review of every
place the pipeline slices, grows or transfers a buffer. **Spike it before recommending it**;
do not assume it is available because the API name resolves.

**(c) Do not stream.** Spend the effort on an honest progress experience instead — the
existing per-1 MB `progress()` signal already reaches the main thread. §12 already trimmed
this milestone once for a similar reason.

**The rule that constrains all three:** a genuinely resumable parser — one that stops at an
arbitrary byte and continues later — is a `FormatModule` change, and `src/core/types.ts` is
not to be modified. Route (a) needs no such change (the parse runs to completion as it does
today; only the *reporting* becomes incremental), and that is a significant part of its
appeal. **If a route seems to require a resumable `parse`, stop and report** rather than
extending the contract.

**Acceptance:** a written recommendation with a measured basis — checkpoint copy cost at
200 MB for (a), a working availability probe for (b) — and a `DECISIONS.md` entry. §13's
*"Streaming tree presentation"* question is answered here or explicitly retired here.

## H2 — Incremental store transfer — **NOT IN SCOPE (D-043)**

**Files:** `src/worker/parse.worker.ts`, `src/core/parseClient.ts`, `src/core/nodeStore.ts`

*H1 chose not to stream. Retained as analysis; do not build.* Note that H2c below touches
the same `exportBuffers` seam for an unrelated reason — read H2c, not this.

Checkpoints on the existing `progress()` hook — it already fires at ~1 MB intervals and
already reaches the main thread without a forwarding sink (M0c's C4 made sure of that; do
not reintroduce a wrapper on the hottest call site in the program).

- Each checkpoint copies **only the newly-appended range** of each store column and of the
  interner's name bytes. Do not transfer whole arrays: a transfer detaches the worker's copy
  and the parse would stop dead on the next node.
- Ship the **open-stack fixups** with each checkpoint. A node opened at checkpoint *k* has
  its `spanEnd` and flags written at `closeNode`, possibly many checkpoints later; the set of
  affected nodes is exactly the parser's open stack, which is document depth, not document
  size.
- `NodeStore` gains an append path alongside `fromBuffers`. That file is ordinary code, not
  the frozen contract — but keep the append path as narrow as the transfer path is, and keep
  `exportBuffers`/`fromBuffers` working unchanged for the non-streaming case.
- **Checkpoint cadence is a tunable, and it is a real trade**: too frequent and the copies
  dominate; too rare and the stream is a slideshow. Set it with a number, not a guess, and
  record it the way row size N and the line-checkpoint stride are recorded.

**Acceptance:** the store the renderer holds after the final checkpoint is **structurally
identical** to the store a non-streaming parse of the same file produces — assert it column
by column, do not eyeball the tree. Total parse time does not regress by more than a stated
budget. Cancelling mid-stream leaves no partial store visible.

## H2b — Stop rebuilding the row index on every edit

**Files:** `src/core/rowIndex.ts`, `src/renderer/session/documentSession.ts`
(`trySpliceReparse`), `src/core/deltaList.ts`

**Unconditional — runs whatever H1 decided.** This is not a streaming task; it is here
because it is the largest main-thread block in the shipped application and because H4 would
otherwise be measured through it.

D-036 wired subtree splicing into the live reparse path and recorded the trade as "a ~1.2 s
main-thread block at 500 MB." That figure is `spliceSubtree` alone. `trySpliceReparse` also
calls `buildRowIndex`, `buildLineIndex` and `buildNameIndex` — **all three over the whole
document, all three synchronously, on the main thread**, immediately after the splice
returns. Measured on the same fixtures and the same one-byte-deeper-leaf edit M3-RESULTS §1
used:

| Fixture | `spliceSubtree` | `buildRowIndex` | `buildLineIndex` | `buildNameIndex` | **Real block** |
|---|---:|---:|---:|---:|---:|
| `cars-200mb.xml` | 501.9 ms | 887.9 ms | 34.4 ms | 51.7 ms | **1476.0 ms** |
| `cars-500mb.xml` | 1299.1 ms | 2315.1 ms | 94.3 ms | 113.8 ms | **3822.3 ms** |

**The splice is 34% of its own cost; the row-index rebuild is ~60%.** Every edit burst on a
large document freezes the UI for the right-hand column.

**The row index does not need rebuilding.** An edit is one byte range with one `delta`:

- Rows entirely **before** the edited range are unchanged — not shifted, not recomputed
- Rows entirely **after** it shift by `delta`, which is precisely what `core/deltaList.ts`'s
  `fold` does to an `Int32Array` of offsets. That module has existed since M3 F2 and, per
  D-037, is still wired into nothing
- Only rows **overlapping** the edited range need real recomputation, and `buildRowIndex`'s
  scan can be restricted to that byte range

**Mind `fold`'s own documented boundary**, which its module comment states plainly: `fold`
shifts in place and cannot grow or shrink the array, so an edit that adds or removes a
newline changes the *row count* and needs rows spliced in or out — `test/deltaList.test.ts`
already has a regression test pinning exactly this. Splicing rows in and out for the
overlapping range is this task's actual work; the shift is the easy half.

**`buildLineIndex` stays a full rebuild** — 34–94 ms, derived from the row index, and its
own doc comment already calls it cheap enough to run unconditionally. **`buildNameIndex`
stays a full rebuild** too, per D-039, which measured that choice deliberately. Neither is
the problem; do not "fix" them.

**Acceptance:** the row index after an incremental reparse is **element-for-element
identical** to a full `buildRowIndex` of the same edited buffer — assert it, including an
edit that inserts a newline and one that deletes a newline, which are the cases `fold` alone
gets wrong. The measured main-thread block at 200 MB and 500 MB drops by roughly the
`buildRowIndex` column above. Re-measure and correct D-036's addendum with the new figures.

**Stop and report if** the row-index rebuild turns out not to be safely incrementalizable —
e.g. because `snapToCharBoundary` or the backward break-byte scan makes a row's boundary
depend on content further away than the edited range. That would be a real finding about
D-006's design, not a reason to leave a 900 ms block in place.

## H2c — The open pipeline holds the document up to four times over

**Files:** `src/main/documents.ts`, `src/core/nodeStore.ts` (`exportBuffers`)

**Unconditional, and the reason H1 was answered the way it was.** §8 budgets ~2.5× the file
size. Measured through the real functions, sampling RSS between each stage:

| Stage | 200 MB | 500 MB |
|---|---:|---:|
| `main`: `readFile` → `Buffer` | 271 MB | 555 MB |
| `main`: **+ `.slice()` → `ArrayBuffer`, both live** | **471 MB** | **1055 MB** |
| `worker`: after parse (store at allocated capacity) | 551 MB | 1236 MB |
| `worker`: + row, line and name indexes | 590 MB | 1342 MB |
| `worker`: **+ `exportBuffers()`, originals and copies both live** | **822 MB** | **1922 MB** |
| | **4.11×** | **3.84×** |

Two independent double-holds, each in a single process, each avoidable:

**1. `document:read` copies the file to hand it over.** `readFile` returns a `Buffer`, and
`buffer.buffer.slice(...)` then makes a second full copy while the first is still live. The
slice exists to avoid sending Node's *pooled* `ArrayBuffer` for small reads — and
`documents.ts`'s own comment already says that is "irrelevant at document sizes." At every
size this application cares about, the `Buffer` already owns an exact-size `ArrayBuffer`, so
the copy buys nothing and costs a full document. Guard it (`byteOffset === 0 &&
byteLength === buffer.buffer.byteLength`) and skip it, or read through a file handle into a
buffer allocated at the size `fs.stat` already reports — `document:stat` is already called
first, for the read-only flag and D6's size checks.

**2. `exportBuffers()` slices all fifteen columns in one object literal**, so all fifteen
copies exist alongside all fifteen originals — **+257 MB at 200 MB, +643 MB at 500 MB**, the
single largest spike in the application. The slices are genuinely required (a transfer needs
standalone buffers, not views into doubled-capacity arrays), but they do not have to be
simultaneous: slice one column, drop the store's reference to the original, move to the next.
Peak overlap falls from the whole store to one column. `exportBuffers` is only ever called
immediately before the store is discarded, so releasing as it goes is safe — say so in the
comment, because it makes the method single-use and that must not be discovered by accident.

Both fixes are small. Together they should bring 200 MB from 822 MB to roughly 590 MB — near
§8's ~503 MB budget and consistent with `M2-RESULTS.md`'s own 554.2 MB figure, which was
measured just *before* the export step and so never saw this.

**A note on that 554.2 MB figure, and on M1's 776.1 MB.** M2 recorded 776.1 MB as a harness
artifact that "held the source bytes twice" and replaced it with 554.2 MB. The artifact was
real — but the pipeline *does* hold the document twice, in two places, and the corrected
figure stops one step short of the transfer. Neither number was wrong about what it measured;
both stopped before the most expensive step. Same shape as D-036's correction.

**Acceptance:** peak RSS through the whole open path, at 10/200/500 MB, reported as a
multiple of file size, before and after. The main-process figure and the worker figure
separately — they are different processes and a per-process peak is what actually fails.
`test/nodeStoreTransfer.test.ts`'s exact-transferable-set assertion still passes; the
rehydrated store is still identical column for column.

**Stop and report if** removing the `document:read` slice turns out to send a pooled buffer
after all — that would mean handing the renderer bytes it does not own, which is worse than
the copy.

## H2d — Chunk the subtree splice

**Files:** `src/renderer/session/subtreeSplice.ts`, `documentSession.ts`

**Unconditional. Finishes what H2b starts.** H2b removes the row-index rebuild from the edit
path; what remains is `spliceSubtree` itself, still synchronous and still on the main thread:
**501.9 ms at 200 MB, 1299.1 ms at 500 MB** (D-036's addendum). That is the whole remaining
block once H2b lands, and it does not need to be a block at all.

**The split is already in the code, which is what makes this cheap.** `spliceSubtree` has two
phases and every refusal happens in the first:

- **Decide** — `canIncrementalReparse`, `findSpliceNode`, `resumeContextFor`, then
  `parseRange` over the edited subtree only, then the two `'malformed'` guards. All bounded
  by *subtree* size, all returning `{ ok: false }` before any document-sized work. Cheap;
  keep it synchronous.
- **Graft** — `graft()` plus `NodeStore.fromBuffers`: three concatenated array segments, of
  which the "after" segment is renumbered and span-shifted element by element. This is the
  O(document) part, it is a flat loop over typed arrays, and it is trivially sliceable.

So the fallback decision is still known immediately — `runReparse` learns "splice or full
reparse" synchronously, exactly as now — and only the grafting yields.

**Run it through D-041's existing seam**: `runChunkedJob` for the slicing, `JobSlot` for
supersede, so a splice overtaken by continued typing never lands. Do not add a second
scheduler.

**The swap must stay atomic.** `graft` already builds into *fresh* arrays rather than
mutating the live store, so the old store stays fully readable while the new one is being
assembled — the Tree and grid keep rendering against it throughout. Committing is
`applyReparseResult`'s existing single `setState`; nothing partially-grafted may ever reach
it. **Never mutate the live store in place to save the allocation** — that would put a
half-renumbered store in front of a render, which is the one failure mode this shape rules
out by construction.

**Acceptance:** the store produced by a chunked splice is identical, column for column, to
the one the synchronous splice produces for the same edit — `test/subtreeSplice.test.ts`'s
existing full-reparse equivalence oracle is the assertion, unchanged. No slice exceeds the
scheduler's budget at 500 MB. A splice superseded mid-graft leaves the previous store intact
and visible. `runReparse` still falls back to a full reparse on every refusal reason it does
today, and still learns of the refusal without waiting.

## H3 — Streaming presentation — **NOT IN SCOPE (D-043)**

**Files:** Tree, Detail, StatusBar

*H1 chose not to stream. Retained as analysis; do not build.* §13's open question, verbatim:
*"How is a partially-parsed tree shown without implying the document ends where parsing has
reached?"*

That is the whole task. A tree that simply stops at the frontier is a lie about the
document's contents, and it is a lie the user cannot detect.

- The frontier needs a visible affordance — the point is that the user can tell the
  difference between "this node has no more children" and "we have not read that far yet"
- **Detail shows a pending state, not a provisional grid** (§3.4), gated on
  `NodeFlags.SubtreeComplete`. A grid that mutates under the user as more rows are parsed is
  exactly what that flag was introduced to prevent
- **Search match counts are provisional** until the root carries `SubtreeComplete` (§6.6).
  M4's G4 left the seam; this is what fills it
- The status bar carries progress; the existing `progress()` bytes-consumed signal is the
  source

**Acceptance:** at no point can a partially-parsed document be mistaken for a complete one —
in the Tree, in Detail, or in a match count. Selecting a node whose subtree is incomplete
gives a pending state, never a grid that later changes shape.

## H4 — The chunked write path

**File:** `src/renderer/session/transform.ts`, and the worker side

§5.5's constraint, and the reason Transforms were scheduled here rather than earlier:

> M0a measured a naive full-document replacement holding the old document, the new document
> and the source text at once: renderer RSS went from **1191 MB to 5694 MB** on a 500 MB
> file.

The shape that avoids it: a Transform **streams output into a new buffer and swaps**. It
never materializes a replacement string, and it never holds three representations at once.

- Runs in the worker, on the same seam that already exists
- Output grows in chunks; the input is read in chunks; peak live memory is the old buffer
  plus the new one plus a bounded working set — **~2× the document, never ~11×**
- Cancellable and progress-reporting like everything else past ~50 ms (§8)
- On completion: the buffer is replaced, a reparse is triggered, and **one** undo entry is
  pushed (H7). That reparse is a *full* one — a Transform rewrites the whole document, so
  `spliceSubtree` will refuse it and `runReparse` falls through to the worker path, which is
  correct. Measure the Transform's own cost separately from the reparse it triggers, or you
  will be reporting H2b's problem as H4's number
- **§11.2's soft cap applies.** A Transform on a very large document should ask first,
  showing the estimated cost — the same shape M2's grid export already uses
  (`GRID_EXPORT_CONFIRM_ROWS`), a confirmation with a number in it, never a refusal

**Acceptance:** formatting `cars-200mb.json` peaks under a stated multiple of the document
size, measured as RSS, and the multiple is nowhere near M0a's. The result reparses cleanly
and the document is usable immediately afterwards.

## H5 — JSON format and minify

**Files:** `src/formats/json/format.ts`, `capabilities.canFormat`

§5.7: *"JSON — the only format where formatting is unconditionally safe and total."* So this
is where the write path gets proven, before H6 attempts the format where it is not.

- Byte-level re-emission: read tokens, write tokens, insert or remove whitespace between
  them. **Numbers and strings are copied verbatim, byte for byte.** Never round-trip a
  number through a JS `number` — `1e400`, `1.0`, `-0`, and integers past 2^53 all survive
  the file and would not survive the parse-and-reprint
- Minify is the same traversal with a different whitespace policy, not a second
  implementation
- Newline style follows `FormatOptions.newline`; indent follows `FormatOptions.indent`
- `canFormat` becomes true for JSON. Commands appear because capabilities changed, not
  because a format id was tested (invariant 8)

**Acceptance:** format-then-minify on every JSON fixture returns to the original minified
bytes; minify-then-format is stable under repetition (formatting twice changes nothing).
Every numeric and string literal is byte-identical across a format round trip — assert it
against the fixtures with awkward numbers, and add some if none exist.

## H6 — XML formatting: answer the scope question

**File:** `src/formats/xml/format.ts` *(or a recorded decision not to write it)*

§13, verbatim: *"Formatter scope — is a conservative XML formatter worth building for M5, or
does the Format command ship JSON-only at first?"* Answer it explicitly; do not let H5's
success imply it.

If it is built, §5.7's rules are not negotiable:

- **Only elements with element-only content are re-indented.** Mixed content stays
  byte-identical. `<p>Hello <b>x</b>!</p>` cannot be re-indented without altering `<p>`'s
  character data — that is corruption, not formatting
- **`xml:space="preserve"` is honoured**, and it is scoped: it applies to the subtree until
  overridden
- CDATA, comments, processing instructions and the prolog are preserved as authored

**The model already carries what this needs.** `NodeFlags.IsMixed` is set at `closeNode`, and
`resumeContextFor` already rebuilds `xml:space` scope from the ancestor chain for M3's
subtree splicing. If the formatter finds itself re-deriving either, look at what exists
first.

**Acceptance:** if built — mixed content is byte-identical across a format, verified over
every XML fixture including the mixed-content and `xml:space` cases; formatting is
idempotent. If not built — `canFormat` stays false for XML, the reason is in
`DECISIONS.md`, and the UI never offers a command that does nothing.

## H7 — Transform commands and undo

**Files:** `src/renderer/session/undoStack.ts`, command registrations

§5.6: *"A Transform is always exactly one entry, however much text it rewrote."*

**There is a memory problem inside that sentence, and it must be decided rather than
discovered.** M3's undo entries are `Patch { start, end, replacement: Uint8Array }`. A
whole-document Transform expressed as one patch holds a full copy of the *new* document,
while undoing it needs a full copy of the *old* one — at 200 MB that is 400 MB of undo state
for a single Format, on top of a document budget §8 puts at ~503 MB.

The formatter's inverse is not byte-exact (re-minifying formatted text does not reproduce the
original byte-for-byte), so it cannot be recomputed instead of stored. Options, in rough
order of honesty:

- Bound the number of **whole-buffer** undo entries retained (one or two), independently of
  the ordinary typing-entry depth, dropping the oldest with the fact visible in the UI
- Spill the pre-transform buffer to a temporary file and read it back on undo
- Refuse to make Transforms undoable above a size, with §11.2's confirmation shape saying so
  before running

**Pick one, record it in `DECISIONS.md` with the number that drove it.** A silently
unbounded undo stack that holds two 200 MB buffers is the failure this project keeps finding
in other tools.

Commands: Format Document, Minify Document — palette-reachable (invariant 10), gated on
`capabilities.canFormat`, disabled with a reason when the document is read-only.

**Acceptance:** Format then Undo returns byte-identical original content and the user's
place. A Transform is exactly one entry regardless of size. Undo depth policy is enforced,
visible, and tested.

## H8 — The minified-file banner

**Files:** Raw view chrome, settings

§5.7, and the distinction it draws is the part that gets implemented wrong:

- **Detection drives the *offer* only** — a heuristic on mean row length. The row index
  already gives this for nothing: mean bytes per row is one division
- **Soft wrap is decided separately and per window**, by whether the window has a scroll
  surface at all (§3.1). `wrapPolicy.ts` already does this and must not start consulting the
  banner's heuristic. A document can need wrap locally without being pathological overall
- A non-intrusive banner offering **[Format document]** / **[Keep as-is]**. Non-intrusive
  means non-modal and dismissible — §11.3's external-change banner set the convention M2b
  settled; follow it rather than inventing a second one
- A setting, **"Format minified files on open,"** for users who prefer it automatic

**Acceptance:** a minified fixture offers the banner; a pretty-printed one does not; a
document that is merely long-lined in places does not. Wrap behaviour is unchanged by
whether the banner appeared. Dismissing is remembered for the session.

## H9 — Memory budget in the status bar

§8: *"Memory budget tracked and surfaced in the status bar."* The status bar exists as of
M2b, and by this milestone the figure is composed of parts that are each measured: source
buffer, node store, attribute table, row index, name index (M4's G1), Raw window.

Report the composed figure, not `performance.memory` — a computed sum from known array
lengths is exact, cheap and does not vary with GC timing. §8's budget table is the shape.

This is deliberately *not* §11.4's tab policy, which is unscheduled. It is the number that
policy will eventually need, made visible now that everything contributing to it exists.

**Acceptance:** the reported figure matches an independently computed sum of the arrays to
within a stated tolerance at 10/200/500 MB. It updates after a Transform.

## H10 — Measurement pass

`docs/plans/M5-RESULTS.md`.

1. **Transform peak RSS** at 200 MB and 500 MB, against M0a's 1191 → 5694 MB. This is the
   number the milestone exists for
2. **Format and minify throughput**, both formats if H6 built one
3. **Peak RSS through the open path** (H2c), before and after, at 10/200/500 MB — main
   process and worker as separate figures, each as a multiple of file size against §8's 2.5×
4. **Whether `M2-RESULTS.md`'s 554.2 MB and `M1-RESULTS.md`'s 776.1 MB can now be reconciled**
   — H2c argues both stopped short of the export step rather than either being wrong
5. **Memory budget accuracy** (H9) across sizes
6. **The incremental-reparse main-thread block** (H2b + H2d), before and after, at 200 MB and
   500 MB — and D-036's correction addendum updated with the result. Report the two
   separately: H2b removes the row-index rebuild, H2d removes the block that remains, and
   collapsing them into one figure hides which one did the work

**Inherited.** **Grid and Tree scroll frame time** and **wrap's first-paint cost** (§13) were
deferred at M2 (E10), M3 (F10) and M4 (G10); **D-040 now records the decision to accept that
gap rather than the deferral itself**, along with what is accepted in exchange and what the
harness would actually take (a real painting surface — jsdom neither lays out nor paints).
Do not re-litigate that here. What M5 *should* do is check whether its own work changes the
calculus: H2b removes the largest main-thread block in the application, and if a
scroll-responsiveness harness is ever going to be budgeted as its own scoped task, the
milestone after the one that made the app responsive is the honest place to ask for it.

## H11 — Spike: read the document once, in the process that parses it

**Deliverable:** a section in `docs/plans/M5-RESULTS.md` and a go/no-go. Timeboxed. **Last task on
purpose** — a positive result extends this milestone with H12 rather than reshaping it
mid-flight, and a negative result costs only the spike.

**What it attacks.** H2c removes the two double-holds but leaves the *shape* of the open path
unchanged: the file is read in the main process, copied to hand over, and structured-cloned
across IPC. Three allocations to get one document into the process that needs it. D-044
records why neither `SharedArrayBuffer` nor a worker-owns-everything rewrite is the answer;
this is the one route that reduces duplication architecturally without touching ownership.

**The approach.** Register a custom scheme in main (`protocol.registerSchemesAsPrivileged`
plus `protocol.handle`, backed by a `fs` read stream), and have the **worker** fetch it:

```ts
const bytes = await (await fetch('nodepad-file:///<token>')).arrayBuffer()
```

Chromium streams the bytes into the requesting process. Main never materializes the document;
the renderer's main thread never sees it either. It exists once, in the process that parses
it. `document:read`, its `.slice()`, and the IPC clone all go away.

**The gate, and the reason this is a spike rather than a task.** `Response.arrayBuffer()` on
a streamed body may accumulate chunks and concatenate, which would reintroduce the very 2×
spike this removes. Chromium can preallocate when `Content-Length` is set, but **that is
unverified here and is the single thing that decides go/no-go.** Measure peak RSS in the
fetching process at 200 MB and 500 MB, with `Content-Length` set and without. A 1× peak is a
go; a 2× peak means this buys only the main-process half and should be weighed against just
keeping `document:read` with H2c's fix.

**Security — do not skip this, and do not design it away later.** A protocol handler that
maps a URL path to a filesystem path is an arbitrary-file-read oracle available to any script
in the renderer, which is a materially worse posture than an IPC call main fully controls.
The handler must serve only documents the user has actually chosen: main mints an opaque,
single-use token when the Open dialog returns (or when a path is otherwise explicitly
accepted), keeps the token → path map, and refuses everything else. **The URL must never
carry a path.** If the spike ends up wanting path-in-URL for convenience, that is a no-go,
not a detail to tidy up in H12.

**Also verify, because both must work:** the scheme resolves under `npm run dev`
(`ELECTRON_RENDERER_URL`, an http origin) *and* in a packaged build (`loadFile`, a file
origin), and it is reachable from a `Worker` context, not only from the document.

**If it goes:** M5 extends with **H12 — implement the fetch read path**, and H10's open-path
peak-RSS figures are re-measured against it. `docs/plans/M5-RESULTS.md` records both sets, since
the H2c numbers are what H12 is judged against.

**If it does not go:** record why in `DECISIONS.md`, keep H2c's fix, and note that the
finding also removes one of the arguments for revisiting `SharedArrayBuffer` — the IPC hop
stays a copy either way.

---

# Definition of done for M5

- [x] H1 answered and recorded — deferred, D-043; H2 and H3 out of scope
- [x] **The incremental reparse no longer rebuilds the row index over the whole document**;
      the resulting index is element-identical to a full rebuild, newline-inserting and
      newline-deleting edits included (`test/rowIndex.test.ts`,
      `test/documentSession.test.ts`'s multi-edit-burst test); D-036's addendum re-measured
- [x] **Peak RSS through the open path is materially reduced, and the reported miss against
      §8's ~2.5× budget was a units mismatch, not a shortfall.** Main process: 1.28×/1.11×
      (200/500 MB) — well inside. Worker: 2.84×/2.69×, down from 4.11×/3.84× pre-fix. **Re-measured
      2026-08-20 and reproduced exactly** (568.0 MB / 2.84× at 200 MB, unchanged). §8's table sums
      *resident* components while this figure is a *peak* including `exportBuffers`'s transfer
      transient; like for like, resident is **2.56× at both 200 and 500 MB** and §8's rule of thumb
      holds. `docs/plans/M5-RESULTS.md` §2's reconciliation note.
- [x] **The subtree splice no longer blocks the main thread**; the chunked result is
      column-identical to the synchronous one (`test/subtreeSplice.test.ts`) and a superseded
      splice never lands (`test/documentSession.test.ts`'s fake-timers test)
- [x] **H11 spiked and answered** — go, with the `arrayBuffer()` peak-RSS measurement
      (~1.00–1.03× at both sizes, with and without `Content-Length`) and the token-scoping
      design recorded for H12 (`spike/h11-protocol-fetch/RESULTS.md`, D-047)
- [x] Transforms run through a chunked write path with peak memory near 2× the document
      (measured: `format()` alone at 1.47×; full pipeline reasoned, not separately measured
      end-to-end — `docs/plans/M5-RESULTS.md` §5), nowhere near M0a's naive ~9–11×
- [x] JSON format and minify are byte-exact on literals and idempotent under repetition
      (`test/jsonParser.test.ts`)
- [x] XML formatting does not exist, and says why (D-045)
- [x] A Transform is one undo entry, and the whole-buffer undo memory policy is decided,
      recorded and enforced (D-046, re-checked against actual post-transform size — see the
      `f39e6e3` fix)
- [x] The minified-file banner offers, never imposes; wrap is unaffected by it (H8,
      `minifiedDetection.ts` never consulted from `wrapPolicy.ts`)
- [x] The status bar reports a composed memory figure that matches an independent sum
      (98.9%/99.5% accuracy, `docs/plans/M5-RESULTS.md` §6)
- [x] Every new command in the palette; capability-gated (`canFormat`), never format-id-gated
- [x] `npm test`, `npm run typecheck`, `npm run lint` clean
- [x] `docs/plans/M5-RESULTS.md` written; `DECISIONS.md` updated for H1 (D-043), H6 (D-045), H7
      (D-046), H11 (D-047); the deferred scroll measurements stay under D-040, not
      re-litigated here
- [x] **No format conversion, no sort-keys, no structural edits, no tabs**

## Report back on any of these

- **Streaming requiring a resumable `parse`.** That is a `src/core/types.ts` change, and the
  contract's own closing section is the place to read before proposing it.
- **`SharedArrayBuffer` turning out to be unavailable or disproportionate in Electron.** It
  is route (b)'s only real risk and it is a platform fact, not a design opinion — find it
  early.
- **A Transform that cannot be chunked** for some format's grammar. §5.5 assumes all of them
  can be; if one cannot, that assumption needs revising rather than the memory ceiling.
- **A formatter that cannot be made idempotent.** Formatting twice must equal formatting
  once; if it does not, the formatter is making choices it should not be making.
- **The undo memory policy forcing a visible feature limit.** That is a legitimate outcome,
  but it is the user's trade to know about, not an implementation detail to bury.
- Anything in `CONCEPT.md` §5.5 or §5.7 that turns out to be wrong once built. §5.7 in
  particular describes formatter behaviour for four formats, three of which have never been
  parsed by this application.
