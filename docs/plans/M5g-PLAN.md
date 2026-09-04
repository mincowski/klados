# M5g — Transform performance

<!-- status: built -->

**Status: built.** O4's deferred Raw-view-remount half was closed later by R41 (`docs/plans/R41-raw-editing.md`). Task **R13**. Register: `docs/TASKS.md`. Results:
`docs/plans/M5g-RESULTS.md` — O0–O3 and O4's Tree half are done and measured; O4's Raw-view-remount
half is deferred, not attempted, with the reason and the concrete next step recorded there.

Reported: pressing pretty-print on `cars-10mb.xml` made the UI sluggish, with **no visible
change to the document**. Both halves of that turn out to be exactly right, and the second one
explains the first.

Everything in §1 is measured on this machine with the real fixtures, not estimated.

---

## 1. What it costs today

### 1.1 The pipeline, stage by stage

`applyTransform` does: copy the buffer for transfer → worker `format()` → swap the buffer →
**full reparse** (parse, row index, line index, name index).

| Stage | 10 MB | 50 MB |
|---|---:|---:|
| buffer copy for transfer | 2 ms | 11 ms |
| **`format()` in worker** | **568 ms (69%)** | **2 704 ms (72%)** |
| reparse: parse | 194 ms | 798 ms |
| reparse: `buildRowIndex` | 50 ms | 229 ms |
| reparse: `buildLineIndex` | 4 ms | 10 ms |
| reparse: `buildNameIndex` | 8 ms | 16 ms |
| **total** | **826 ms** | **3 769 ms** |
| peak RSS | 166 MB (**16.6×**) | 405 MB (**8.1×**) |

Scaling is linear (5× the input for 4.6× the time), so there is no hidden O(n²) — the constant
is just high. Extrapolated: **~15 s at 200 MB, ~38 s at 500 MB.**

### 1.2 The finding that explains the report

**`format()` on `cars-10mb.xml` returns output byte-identical to its input.** Verified byte for
byte. The fixture is already formatted the way the formatter would format it.

So the entire 826 ms, the buffer swap, the full reparse, the undo entry, the dirty flag and
every downstream remount happened **to produce the same file**. The sluggishness is real work
with a guaranteed-empty result.

### 1.3 `format()` is 3× slower than parsing the same bytes

568 ms to format versus 194 ms to parse — and formatting is morally a tokenize plus a copy, so
it should be in the same class as parsing, not triple it. Three causes, in order of size:

1. **Two full tokenizing passes.** R11's design, and correct — mixed-content detection needs
   lookahead, so pass 1 records verdicts and pass 2 emits. That alone justifies ~2× parse, i.e.
   ~390 ms of the 568 ms. This is the part that is *by design*.
2. **`collectFormatInfo` returns `Map<Offset, FormatInfo>` — one Map entry and one heap object
   per element.** `cars-10mb.xml` has **329,573 start tags**, so that is 329k entries plus 329k
   objects, roughly **25 MB of overhead for a 10 MB file**. This is invariant 2's
   no-object-per-node rule being broken inside the formatter, and it accounts for most of the
   ~180 ms that is *not* explained by the two passes, plus the GC churn behind it.
3. **A string allocation per emitted child.** `out.pushAscii(options.newline +
   options.indent.repeat(depth + 1))` builds a fresh string on every child, twice per element
   (before and after). ~660k allocations on this fixture.

### 1.4 Memory

`format()` alone peaks at **7.7× the source**. The pipeline peaks at 16.6× (10 MB) and 8.1×
(50 MB) — the small-file figure is dominated by fixed overhead, so **~8× is the steady-state
number**, against §8's ~2.5× budget for an open document.

Contributors, largest first: the formatter's own working set (the Map above, plus `GrowableBytes`
doubling — a grow at 8 MB briefly holds 8 + 16 MB), the **undo entry**, and the old store and
indexes staying alive until the reparse lands.

The undo entry deserves its own line: `applyTransform` builds
`{ start: 0, end: oldBytes.length, replacement: newBytes }` plus `inversePatchOf(oldBytes, patch)`
— i.e. **a full copy of the old document and a full copy of the new one**, retained in the undo
stack for the rest of the session. That is ~2× the document per Transform, and it is correct
per §5.6's "always exactly one entry", but it is not free and is currently unaccounted for
anywhere.

### 1.5 Where the *main thread* actually goes

`format()` and the reparse both run in the worker, so neither should block the UI directly. The
sluggishness is downstream of the new store arriving:

- **`Raw.tsx`'s mount effect is keyed on `[store]`** — a new store destroys and recreates the
  entire `EditorView`, re-slices the window, rebuilds decorations, and re-runs the wrap
  evaluation (A6b measured ~400 ms for a wrap pass over a ~1 MB window).
- **`Tree.tsx` resets `expandedRef` to `new Set([ROOT])` on a new store** — so formatting
  **collapses the whole tree**. User-visible, unrelated to performance, and worth fixing in the
  same pass. Check whether the debounced edit reparse hits this too; if it does, every pause in
  typing collapses the tree, which would be much worse.

### 1.6 The sluggishness that outlasts the job — found, and it is a pre-existing bug

Reported after §1.1–§1.5 were written: *"wait a few seconds and the UI is still sluggish — the
mouse pointer doesn't update moving across panes, maximizing doesn't resize the panes."* Those
are main-thread-starvation symptoms, and nothing above explains a job that finished in 826 ms
still costing anything.

**Cause: `shouldRecenter` has no notion of the window already being clamped against the
document's edge.** It is a pure fraction of the window:

```ts
const position = (viewportTopOffset - windowStart) / span
return position < margin || position > 1 - margin
```

At the top of a document the window is `[0, 1 MB]` and cannot move any further back — but
`position` is near 0, so it returns `true`. Verified against the real functions on a 10 MB
document:

| Caret | Window | `shouldRecenter` | |
|---|---|---|---|
| 0 (root selected) | `[0, 1 048 576]` | **true** | window already at doc start |
| 100 | `[0, 1 048 576]` | **true** | window already at doc start |
| mid-document | `[4 718 592, 5 767 168]` | false | |
| end | `[9 437 184, 10 485 760]` | **true** | window already at doc end |

So in the **first and last 20% of a window pinned to a document boundary**, every single
`scroll` event runs `computeWindowBounds` → `applyReslice` → a dispatch → a decoration rebuild,
and lands on **exactly the window already in place**. `planReslice(0, 1 MB, 0, 1 MB)` produces an
incremental plan with empty leading and trailing ranges — a no-op edit that still counts as
`docChanged`. Nothing moves; the work is pure waste, and it repeats per scroll event
indefinitely.

**Why the Transform triggers it.** The reparse produces a new store, `Raw.tsx` remounts on
`[store]`, and R8's 8f fix means the caret follows the selected node — for a freshly-reparsed
document that is typically the root, at **offset 0**. The view is parked exactly in the region
where every scroll event costs a full re-slice. It never recovers on its own, which is why it
outlasts the job.

**This is not caused by formatting.** It affects the top of *every* document, including on open
— the format just reliably puts you there. That also means fixing it is worth more than this
milestone: it is a permanent tax on the first and last 200 KB of every file.

`applyReslice`'s cost per event was not measured directly; §3.4 does that.

**§1.5's items are reasoned from code, not instrumented.** §3 closes that.

---

## 2. Optimizations, ranked

### O0 — `shouldRecenter` must not fire against a clamped window *(do first)*

§1.6. The fix is to make the test aware of the document's own edges: a window whose `start` is
already 0 cannot recentre backwards, and one whose `end` is already `byteLength` cannot recentre
forwards, so in those directions the answer is always `false` regardless of the margin.
`shouldRecenter` currently takes `(viewportTopOffset, windowStart, windowEnd, margin)` and has no
`byteLength` — it needs one, which is a signature change confined to `rawWindow.ts` and its
caller.

This is **not a Transform bug** and its value is not limited to this milestone — it removes a
per-scroll-event re-slice from the first and last 200 KB of every document ever opened. It is
first because it is the smallest change here and it is what the report was actually about.

`test/rawWindow.test.ts` already exercises `shouldRecenter`; add the four boundary cases from
§1.6's table, each of which fails before the fix.

### O1 — Detect the no-op and skip the pipeline *(highest value on the Transform itself)*

If `format()`'s output is byte-identical to its input, do not swap the buffer, do not reparse,
do not push an undo entry, do not mark the document dirty. Report it instead:

> Already formatted — no changes made.

A length check plus a byte compare over 10 MB costs ~1 ms against the 826 ms it avoids, and it
removes the buffer swap, the reparse, the Raw remount and the Tree collapse entirely. **This is
the exact case that produced the report.**

It does not avoid `format()` itself. That is fine and worth stating: a cheaper "is this already
canonical?" pre-check would duplicate the formatter's own rules and drift from them.

### O2 — Replace `Map<Offset, FormatInfo>` with typed arrays

Invariant 2 applied where it was skipped. Two shapes, in preference order:

- **Best: no lookup at all.** Pass 1 and pass 2 visit elements in the *same document order*, so
  pass 1 can append verdicts to parallel `Int32Array`s (start, end, flags) and pass 2 walks them
  with a cursor. No hashing, no boxing, no per-element object.
- Fallback if the orders ever diverge: keep the parallel arrays and binary-search the sorted
  start offsets. Still `Int32Array`, still no objects.

Expected: the ~25 MB per 10 MB disappears, along with the GC pressure behind it. **Do not
predict a time saving in the plan — measure it.**

### O3 — Hoist the indent strings

Precompute indentation once per depth — ideally as a preallocated byte run pushed with
`pushBytes`, so no string is created in the hot loop at all. Bounded by max depth, which
`DEFAULT_MAX_DEPTH` already caps.

Small, obvious, and the kind of thing worth doing while O2 is open in the same file.

### O4 — Don't remount the Raw view on a new store

Addresses §1.5 directly. The `[store]` key is doing "a new document opened" duty for what is
often "the same document, reparsed". Re-slicing the window and re-dispatching decorations is far
cheaper than destroying an `EditorView`. Needs care: the store really can be structurally
different after an edit, so the safe version keys on document *identity*, not store identity.

Related and separate: stop `Tree.tsx` collapsing on a reparse of the same document.

### O5 — Skip the reparse entirely *(ambitious; not for this round)*

Formatting changes only whitespace *between* elements, so the tree's shape is unchanged and only
spans shift. In principle the existing store could be span-remapped instead of reparsed, saving
the whole 256 ms / 1 053 ms reparse column. This contradicts H4's "a Transform always triggers a
full reparse", is easy to get subtly wrong, and should not be attempted before O1–O4 are
measured. **Recorded so it is not re-derived cold, not scheduled.**

### O6 — Bound the undo cost — **the mechanism already exists**

Proposed: make pretty-print undoable only up to a size limit (~100 MB), above which it is not
reversible in the UI.

**That is already built.** `TRANSFORM_CONFIRM_BYTES = 50 MB` (`documentSession.ts:94`, D-046):
at or above it, `requestTransform` shows a confirmation instead of running, and
`confirmTransformAnyway` calls `applyTransform(kind, allowUndo: false)` — so the Transform runs
without an undo entry and the 2× retention never happens. `applyTransform` re-checks against the
*actual output* size too, not just the input, so a small file that formats into a huge one also
loses undo rather than silently blowing the budget.

So the only open question is the **number**: 50 MB today, 100 MB suggested. Not a code change of
any substance — but it is D-046's recorded figure, so moving it means amending that entry with
the reasoning, not editing the constant quietly. **Left for the project lead to decide**; nothing
in this plan depends on which value wins.

What is *not* covered: below the threshold the entry holds a full copy of both documents, and
nothing surfaces that — worse, `computeMemoryBudget` does not count it, so NodePad's own reported
total is understated by ~2× the document after a Format.

**Making it visible is now R12's**, as `M5f-PLAN.md` §3a: undo history becomes a counted
component of the memory budget with its own row and entry count, not a separate curiosity. A
diff-based inverse — fixing the cost rather than reporting it — remains out of scope here and
unscheduled.

---

## 3. How to test all of this

### 3.1 A committed benchmark, not a scratchpad script

`npm run bench:format` — following the existing `npm run inspect` harness pattern, in-repo so the
numbers are reproducible by anyone and comparable across commits. It must report **per stage**,
because measuring the component and not the pipeline is the mistake `CLAUDE.md` already names
four times and which §1.1 exists to avoid repeating.

Output per fixture: `format()` ms, throughput MB/s, each reparse stage, total, peak RSS, output
size delta, and whether the output was byte-identical.

### 3.2 Fixtures — the current set is not enough

`cars-*.xml` are all already-formatted ASCII, which is why the no-op case went unnoticed. Add,
generated by `npm run fixtures:generate`:

| Fixture | Exercises |
|---|---|
| `cars-10mb.xml` (existing) | the **no-op** path — output must be byte-identical |
| `cars-10mb.min.xml` | **generated, exists** — see below |
| `mixed-10mb.xml` | many `IsMixed` elements — the subtree-skip path, and R11's copy-verbatim branch |
| `preserve-10mb.xml` | `xml:space="preserve"` scope |
| `nonascii-10mb.xml` | multi-byte content — **the suite still has no non-ASCII XML fixture**, flagged since M5b |
| `deep-10mb.xml` | deep nesting — indentation cost grows with depth (O3's target) |

**`cars-10mb.min.xml` is already generated** by `scripts/minify-xml.mjs`, committed with this
plan:

```bash
node scripts/minify-xml.mjs spike/fixtures/cars-10mb.xml
```

10 485 791 → 6 989 799 bytes (−33.3%), 389 814 whitespace runs removed. It is byte-level and
conservative on purpose: a text run is dropped only when it sits between `>` and `<` and is
*entirely* whitespace, so element text and mixed content survive byte-identical. It is not a
general minifier and does not know about `xml:space="preserve"`.

Measured on it, i.e. the path where the formatter has real work to do:

| Stage | `cars-10mb.min.xml` (6.7 MB → 10.0 MB) |
|---|---:|
| `format()` | 701 ms (72%) |
| reparse | 274 ms |
| **total** | **977 ms** |
| peak RSS | 176 MB |

Note the throughput: **9.6 MB/s** against 18.6 MB/s on the no-op input. Real formatting work is
~2× the cost of the already-formatted case, so §1.3's causes matter more here, not less.

### 3.3 Sizes

10, 50, 100 MB by default; 200 and 500 behind `--large`, matching `npm run test:large`'s existing
convention. Report the scaling factor so a future O(n²) shows up as a number rather than a
feeling.

### 3.4 In-app measurement — this is what the report was actually about

§1.5's main-thread costs are currently reasoned, not measured. **Use R10's tooling** — this is
precisely the gap it was built to close, so "verified by reading the code" is not acceptance:

- Playwright + Electron: open `cars-10mb.xml`, press the pretty-print button, record frame
  intervals across the whole interaction with a `requestAnimationFrame` loop. Report median and
  count of frames over 32 ms, the shape `M1-RESULTS.md` §1 uses.
- Assert the Tree's expansion state survives a format.
- Screenshot before and after, so "no visible change" is demonstrable rather than asserted.

### 3.5 Correctness must not move

Every optimization here is a rewrite of code that R11 got right. Re-run R11's existing
invariants after each: idempotence, structurally identical re-parse, mixed and `preserve`
subtrees byte-identical, and the `<p>Text <b><a>…</a></b> and more text</p>` subtree case.

**O2 specifically:** keep the `Map` implementation available behind a flag or in the test only,
and assert the typed-array version produces identical verdicts on the generated corpus. This is a
data-structure swap under working code — differential testing against the thing being replaced is
the cheapest possible safety net, and this project has caught two real bugs that way already.

### 3.6 Regression guards

- A throughput floor for `format()` (assert MB/s above a threshold, not an absolute ms) so a
  future change that reintroduces per-element allocation fails rather than being noticed months
  later.
- A test that the no-op path does **not** mark the document dirty and does **not** trigger a
  reparse — the guard for O1, and the behaviour the whole task exists to fix.

### 3.7 Record the numbers

`docs/plans/M5g-RESULTS.md`, before-and-after per optimization. If any of §2's expected wins does not
materialise, **say so with the measurement** rather than quietly dropping it — the JSON
formatter's path is unmeasured too and may want the same treatment, and a negative result there
is just as useful.

---

## 4. Order

**O0 first** — it is a handful of lines, it is what the "still sluggish seconds later" report was
actually about, and its value extends past this milestone to every document open.

Then O1: smallest remaining change, fixes the "nothing happened but it cost a second" experience
outright, and it makes every later measurement easier to read because the no-op case stops
dominating casual testing.

Then 3.1–3.3 (the harness and fixtures), then O2, O3, O4, each measured. O5 is recorded, not
scheduled. O6 is a number for the project lead to pick, not work.

**Gate:** if `format()` throughput after O2+O3 is not meaningfully closer to the parser's
~65 MB/s, stop and report rather than continuing to O4 — that would mean the two-pass design
itself is the cost, which is a different conversation and possibly a §5.7 one.
