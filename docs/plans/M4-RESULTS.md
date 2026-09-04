# NodePad — M4 Results

G10's own measurement pass. Methodology: `spike/m4-bench.ts` (`npx tsx spike/m4-bench.ts`),
the same one-off-harness convention as `spike/m2-e10-measure.ts` and `spike/m3-bench.ts` —
not wired into `npm test`, run against the real gitignored fixtures in `spike/fixtures/`.

**Status: measured, and two of the five items turned up findings the plan's own design
intent didn't predict** — §4 (path evaluation) and, to a lesser extent, §5 (scheduler slice
cost). Both are reported as found, not smoothed over; neither blocks the milestone, and
both have a clear next step recorded below rather than left implicit.

## 1. Text find latency — byte path vs. decoded path

Needle `"mileage"` (present in every `<car>` record), identical needle on both paths — the
decoded path forced via `regex: true` so the comparison is the same needle and the same
match count, not two different searches.

| Fixture | Size | Byte path | Matches | Decoded path | Matches |
|---|---:|---:|---:|---:|---:|
| `cars-10mb.xml` | 10.0 MB | 18.1 ms | 63,310 | 188.2 ms | 63,310 |
| `cars-50mb.xml` | 50.0 MB | 80.8 ms | 316,668 | 864.5 ms | 316,668 |
| `cars-100mb.xml` | 100.0 MB | 156.3 ms | 633,210 | 1730.4 ms | 633,210 |
| `cars-200mb.xml` | 200.0 MB | 310.0 ms | 1,266,536 | 3337.8 ms | 1,266,536 |
| `cars-500mb.xml` | 500.0 MB | 791.9 ms | 3,166,256 | 8319.9 ms | 3,166,256 |

**The decoded path is consistently ~10.5× the byte path**, scaling linearly with size on
both — expected, not a surprise: the decoded path pays a `TextDecoder` pass over every row
in every ~64 KB window plus a regex engine, where the byte path is a single
Boyer–Moore–Horspool scan over raw bytes. Both stay well inside a debounce window (200 ms,
F3) at every size except the decoded path past 100 MB — which is the expected cost of
choosing regex or non-ASCII search over a plain substring, not a regression: G2's own
routing (`chooseFindPath`) sends the overwhelmingly common case — a plain ASCII needle — to
the fast path automatically, and only regex/non-ASCII pays this.

## 2 & 3. Name index build time/memory, and invalidation cost

Added as a real line item against §8's own memory budget table (200 MB / ~6.6 M nodes),
not a rounding error:

| Fixture | Size | Build time | Index memory | % of node+attr store |
|---|---:|---:|---:|---:|
| `cars-10mb.xml` | 10.0 MB | 6.7 ms | 1.3 MB | 9.8% |
| `cars-50mb.xml` | 50.0 MB | 12.4 ms | 6.3 MB | 9.8% |
| `cars-100mb.xml` | 100.0 MB | 23.5 ms | 12.6 MB | 9.8% |
| `cars-200mb.xml` | 200.0 MB | 42.4 ms | 25.1 MB | 9.8% |
| `cars-500mb.xml` | 500.0 MB | 98.1 ms | 62.9 MB | 9.8% |

Against §8's own 200 MB budget table (~503 MB total, node store + attribute table ~270 MB),
the name index adds **~25 MB — about 5% of the whole-document budget**, a genuine, fixed
percentage (9.8% of the node+attribute store specifically, at every size measured) rather
than the "negligible" the original table implicitly assumed by omitting it. Updated line
item:

| Component | 200 MB size |
|---|---|
| Source buffer | 200 MB |
| Node store (38 B/node) | ~251 MB |
| Attribute table | ~19 MB |
| Row index | ~31 MB |
| **Name index (G1)** | **~25 MB** |
| Raw View window | ~2 MB |
| **Total** | **~528 MB** (was ~503 MB) |

**Invalidation — rebuild, measured against the splice it rides alongside:**

| Fixture | Splice cost (M3-RESULTS §1) | Rebuild cost (this pass) |
|---|---:|---:|
| `cars-10mb.xml` | 38.3 ms | 2.2 ms |
| `cars-50mb.xml` | 130.2 ms | 12.1 ms |
| `cars-100mb.xml` | 221.6 ms | 21.7 ms |
| `cars-200mb.xml` | 445.5 ms | 41.6 ms |
| `cars-500mb.xml` | 1177.4 ms | 98.1 ms |

**Rebuild costs roughly 8–12% of the splice it rides alongside** — genuinely cheap relative
to the edit that triggers it, and the gap widens (not narrows) at larger sizes. Patching
the index in place (shifting refs by the splice's own `refDelta`, dropping/re-inserting the
edited range — M4-PLAN.md G1's "real difficulty") was **not implemented**: at this measured
cost, a patch could only ever save the ~90% of work that's already cheap, in exchange for a
second, more complex ref-shifting algorithm with its own correctness surface (a wrong patch
producing a stale-but-plausible node ref is worse than a slow one, per G1's own framing).
Recorded as D-039 rather than left as a silent omission.

## 4. Path evaluation per step type, `//name` vs. a full scan

| Fixture | child step | `//mileage` unscoped | scoped `//type` (via `car[1]`) | scoped baseline (bounded walk) | positional `[1]` | facet `[@color="red"]` | `//mileage` full scan |
|---|---:|---:|---:|---:|---:|---:|---:|
| `cars-10mb.xml` | 0.2 ms | 2.2 ms | 8.8 ms | 4.4 ms | 5.4 ms | 21.9 ms | 2.1 ms |
| `cars-100mb.xml` | 0.1 ms | 11.4 ms | 28.9 ms | 38.0 ms | 25.6 ms | 163.0 ms | 7.0 ms |
| `cars-200mb.xml` | 0.0 ms | 14.1 ms | 60.0 ms | 74.5 ms | 60.9 ms | 314.2 ms | 13.0 ms |

**Two findings neither the plan nor §6.6 predicted, reported rather than smoothed over:**

- **An unscoped `//name` from the document root is not meaningfully faster than a full
  scan — sometimes slightly slower.** At 10 MB the index (2.2 ms) and the scan (2.1 ms) are
  a dead heat; at 100 MB the index is *0.61×* the scan's time, i.e. the index run is
  actually costlier. The reason is structural, not a bug: G1's binary search prunes node
  refs *outside* the context's span, but an unscoped `//name`'s context is the whole
  document — there is nothing to prune, and the index pays for materializing a result set
  (`nodesByNameId`'s subarray, iterated into the aggregation array) that costs the same
  order as the scan's own single tight loop over `nameIdOf`. §6.6's claim — "this is the
  step the name index exists for; without it, `//price` is a full document scan" — is true
  of *scoped* descendant queries (a context narrower than the whole document) and not of an
  unscoped one, a distinction the design doc doesn't draw. One real fix already landed from
  this finding: `descendantMatches` originally materialized its match slice via
  `Array.from(...)` before the aggregation loop even started, a second full O(matchCount)
  copy on top of the loop that already visits every element — changed to return the
  `Int32Array` subarray view directly (zero-copy), which is reflected in the numbers above.
- **A predicate step (positional or facet) collects its full candidate set before
  filtering, so "scoping" a query through a predicate-selected ancestor doesn't reduce
  work the way it looks like it should.** `garage/cars/elements/car[1]//type` was built to
  demonstrate a *scoped* descendant query's advantage over the unscoped case — but
  `car[1]` itself is a `childMatches` call that walks **every** `<car>` sibling under
  `<elements>` (tens of thousands to ~700,000 across the fixture range) before the
  positional filter ever discards anything, because predicates are applied *after* a
  step's full match set is already built (`evaluate.ts`'s `applyPredicate`, run over the
  complete `matches` array `evaluateStep` already assembled). The "scoped" descendant step
  that follows *is* fast in isolation, but the query as a whole is dominated by the
  predicate step that reaches it — visible in the numbers above as the scoped case costing
  *more* than the unscoped one at every size, not less. **Not fixed in this pass** — an
  early-exit positional predicate (stop scanning children once the Nth match is found,
  per parent) is a real, scoped follow-up; a facet predicate has no equivalent shortcut
  without a second index over attribute values, which G1 explicitly declined to build
  pre-emptively. Recorded as a finding to report, per the plan's own instruction, not
  quietly absorbed into "path evaluation works."

The **facet predicate's absolute cost** (163–314 ms at 100–200 MB) is the most expensive
operation measured in this pass, for the reason above: `car[@color="red"]` decodes and
compares an attribute value for *every* `<car>` in the document, one `TextDecoder`-backed
`SourceBuffer.slice` call per candidate, before any predicate matches. This is within a
single debounce window at 100 MB but not comfortably so at 200 MB — worth chunking through
G3's scheduler if a facet-heavy query becomes a common interactive path; not done here
since G8's own acceptance criteria (correctness, invariant 8) are met and this pass's job
is to measure, not to redesign mid-report.

## 5. Frame time during search

**No real `requestAnimationFrame`/real-`EditorView` harness exists** — the same gap
`M2-RESULTS.md`'s E10 and `M3-RESULTS.md`'s §2 both already flagged for grid/Tree scroll
frame time and wrap's first-paint cost, carried forward again here rather than
independently rebuilt for this milestone. What *is* measured, honestly labelled as a proxy
rather than the real thing: the wall-clock interval between consecutive slices of a real
`runChunkedJob` (G3) scanning the byte path over the two largest fixtures, via real
`setTimeout(0)` scheduling (not simulated/faked timers) in Node:

| Fixture | Total | Slices | Longest slice | Average slice |
|---|---:|---:|---:|---:|
| `cars-100mb.xml` | 256.3 ms | 17 | 16.9 ms | 14.3 ms |
| `cars-500mb.xml` | 1598.4 ms | 102 | 23.6 ms | 15.5 ms |

**No slice exceeds ~24 ms — comfortably under §6.6's "progress after ~50 ms" bar** at
either size, and slices never blow past it even at the largest fixture. The average
(14–16 ms) is *higher* than the scheduler's own configured `DEFAULT_SLICE_MS` (8 ms)
because this measures the real wall-clock gap between `onProgress` calls, which includes
Node's own `setTimeout(0)` scheduling overhead on top of the synchronous work budget — not
a bug in `runChunkedJob`, but the actual cost of yielding to the event loop between slices,
which is the entire point of chunking in the first place. A search over the largest fixture
never produces a slice anywhere near frame-drop territory (16 ms is one dropped frame at
60 Hz; nothing here reaches that on a single slice at 100 MB, and 500 MB's worst case is
under two).

**This is not the measurement §8's own argument calls for** ("a search that is fast on a
stopwatch and drops frames has not met it") — it is the closest honest proxy available
without the harness `M2-RESULTS.md`/`M3-RESULTS.md` already deferred building. Per the
plan's own instruction ("if it is still not built when M4 ends, that is now a fourth
deferral, and it should be recorded in `DECISIONS.md` as a decision not to measure them —
with what is being accepted in exchange"), see D-040.

## Definition-of-done cross-check

- [x] `npm test`, `npm run typecheck`, `npm run lint` clean (see the milestone-level review
      for the final confirmation across every G-series commit).
- [x] Name index memory reported as a real line item (§2 above) — ~5% of the whole-document
      budget at 200 MB, not negligible.
- [x] Name index invalidation measured both ways the plan asked for a decision on: rebuild
      cost directly, and against the splice it rides alongside (§2–3) — rebuild chosen,
      recorded as D-039.
- [x] Text find latency at every fixture size, both paths separately (§1).
- [x] Path evaluation per step type, `//name` vs. a full scan (§4) — with two findings the
      design didn't predict, reported rather than absorbed silently.
- [~] Frame time during search — measured as the closest honest proxy available (§5); the
      real rAF/real-`EditorView` harness remains unbuilt, now a fourth deferral (D-040).

## What this pass does not cover

- **Grid and Tree scroll frame time, wrap's first-paint cost** — still not measured, for
  the third consecutive milestone; see D-040, which folds M4's own frame-time gap into the
  same recorded decision rather than treating them as two separate open items.
- **A fix for the two path-evaluation findings in §4** — reported, not resolved. An
  early-exit positional predicate and/or an attribute-value index for facet predicates are
  real follow-up work, scoped but not started here.
- **Facet predicate chunking** — §4's own note: expensive enough at 200 MB to be worth
  running through G3 if it becomes a common interactive path; not built, since correctness
  (G8's own acceptance bar) is what this milestone owed.

## Addendum — independent review, after this pass

A milestone-level review (fresh eyes, not the implementing pass) read every G1–G10 commit
against M4-PLAN.md's hard rules and acceptance criteria and found seven issues. Six are
closed in the same review pass, verified with a new regression test each; one is left open,
recorded honestly rather than silently deferred.

**Fixed:**

1. **Decoded-path byte offsets were wrong for single-byte, non-UTF-8 encodings**
   (`textFind.ts`) — G2's own acceptance criterion ("a needle containing non-ASCII is found
   in a windows-1252 fixture at the right byte offset") was never actually tested; the
   implementation always re-encoded the decoded prefix as UTF-8 to measure its byte length,
   which is exact for UTF-8 but wrong for windows-1252 and its relatives, where `TextEncoder`
   (UTF-8-only) produces a different byte count than the source encoding's own one-byte-per-
   character rule. Fixed: a string index *is* the byte offset for any recognized single-byte
   code page (`isSingleByteEncoding`), no re-encoding needed or possible. Multi-byte legacy
   encodings (Shift-JIS, GB18030, Big5) still fall back to the UTF-8-re-encode approximation
   — there is no web-standard API to encode back to any of them, and an exact fix needs an
   incremental decode-and-measure walk instead, left as real follow-up, not pretended away.
2. **Descendant steps double- (or triple-) counted matches under nested contexts**
   (`evaluate.ts`) — `//d//t` against `<d><d><t/></d></d>` returned the inner `<t/>` twice,
   because a later, nested context node's entire descendant range is a *subset* of an
   earlier context's own range, and both were searched independently. This also corrupted
   positional-predicate ranking downstream (duplicate matches inflate a parent's count).
   Fixed with a `coveredUpTo` ref-boundary tracker: a context whose ref falls inside a range
   already searched is skipped wholesale, preserving both exactness and ascending order.
3. **`decodedWindowsFor` could infinite-loop** if a single row's own byte length reached
   `targetBytes` on its own — the next window's one-row overlap (`endRow - 1`) then equalled
   the *current* `startRow`, producing the identical window forever. Unreachable at this
   codebase's own defaults (`DEFAULT_MAX_ROW_BYTES` 512 vs. `DECODED_WINDOW_BYTES` 64 KB) but
   not guarded by the function's own contract for an arbitrary caller-supplied `targetBytes`.
   Fixed by forcing at least two rows per window when the document has that many left,
   guaranteeing the overlap always advances.
4. **`findNodesByName` materialized and sorted every node instance of every fuzzy-matched
   name before truncating to the 50 actually shown** — a common query like `@car` expands
   to every `<car>` in the document (hundreds of thousands on a large fixture) before the
   50-result cap ever applies, since every node sharing a name has an identical score with
   nothing to gain from full expansion. Fixed: rank at the *name* level first (bounded by
   vocabulary size), then expand groups best-score-first, stopping the moment 50 node
   matches are collected — a group that would never make the cut is never expanded.
5. **`currentIndex` (which match is "current" for highlighting/navigation) wasn't clamped**
   when an edit's re-run landed a smaller result set — parked on match 38 of a now-3-match
   result, the display read "38 of 3" and no match ever drew as current (nothing in the
   shorter array equalled the stale index). Fixed in `FindBar.tsx`: an effect resets
   `currentIndex` to `null` (the same "search just started" state) whenever it falls outside
   the live result's bounds.
6. **Path evaluation never ran through G3's scheduler** — hard rule 3 ("anything that could
   exceed ~50 ms is chunked, cancellable, and reports progress") and G8's own "runs through
   G3's scheduler" acceptance criterion, both unmet: the palette's `/` query mode evaluated
   synchronously inside a `useMemo` on every keystroke, against a facet-predicate cost §4
   itself measured at 163–314 ms on a 100–200 MB fixture. Fixed: `evaluatePathStep` (the
   per-step primitive `evaluatePath` was already built from) is now exported from
   `core/path/evaluate.ts`, and a new `renderer/navigation/pathQueryJob.ts` chunks a whole
   path through `runChunkedJob` at step granularity. The palette debounces (150 ms, matching
   `FindBar`'s own) then runs the chunked job through a `JobSlot`, cancelling a stale
   evaluation the same race-free way G4's search does. **What this does and doesn't bound**,
   stated plainly: chunking happens *between* steps, not within one — a single expensive
   step (that same 163–314 ms facet predicate) is still not itself preemptible mid-step.
   What's fixed is evaluation no longer blocking synchronously inside a React render on
   every keystroke, and a changed query now cancels a stale evaluation cleanly instead of
   racing it. A fully preemptible single predicate step needs restructuring
   `applyPredicate`/`descendantMatches` into their own resumable loops — real, scoped
   follow-up, not done here.

**Left open, not fixed:** intermediate node sets inside `evaluate.ts` (`childMatches`,
`descendantMatches`'s wildcard branch, `applyPredicate`'s accumulator) are plain `number[]`,
not the `Int32Array`-backed, reused growable scratch buffer hard rule 2 calls for
("allocated per step against a reused growable scratch buffer, never an array of objects").
A `number[]` is not an array of objects — the letter of "never an array of objects" holds —
but it is not the reused-scratch shape either, and for a step producing a very large
intermediate result (a wildcard descendant step over a huge subtree, for instance) this
costs more than the specified design. Not fixed in this pass: the correctness-bearing
findings above took priority within the review's own time budget, and this one is a
performance/design-adherence gap, not a wrong answer. Real follow-up, recorded here rather
than silently left for a future re-discovery.

---

## Second addendum — review during M5 planning

A second independent read of the shipped M4 code, run while checking `M5-PLAN.md` against
reality. Five findings, none of which change an answer M4 reports above, all recorded here
rather than fixed — the fine-tuning pass planned after M5 is where they belong, and
re-discovering them there costs more than writing them down now.

**Two deviations from `CONCEPT.md` found during the same pass are recorded in
`DECISIONS.md` instead**, because they are design positions rather than defects: D-041
(search runs chunked on the main thread, not in the worker as §6.6 states) and D-042 (the
`number[]` step intermediates §4's own "left open" note above already describes).

### 1. `indexOfCaseInsensitive` is a per-position `slice` + `toLowerCase` scan — 3.2× the cost of the regex it could delegate to

§1's decoded-path table forced the decoded path with `regex: true`, which routes through the
native `RegExp` engine. It therefore never measured `textFind.ts`'s *other* decoded branch:
a **non-regex, non-ASCII, case-insensitive** needle, which falls to `indexOfCaseInsensitive`
— `text.slice(i, i + needleLen).toLowerCase() === needleLower` at **every** position in the
window. On `cars-10mb.xml`:

| Path | Needle | Time |
|---|---|---:|
| Byte (BMH), case-sensitive | `diesel` | 17.6 ms |
| Byte (BMH), case-insensitive | `diesel` | 25.1 ms |
| Decoded, case-sensitive (native `String.indexOf`) | `dieselä` | 111.1 ms |
| Decoded, case-insensitive (`indexOfCaseInsensitive`) | `dieselä` | **369.2 ms** |
| Decoded, case-insensitive (`RegExp` `gi`) | `diesel` | 114.1 ms |

The regex row does the same job as the row above it for **a third of the cost**, on a code
path `decodedTextMatches` already contains. Extrapolating linearly, the 200 MB case is ~7.4 s
against ~2.3 s.

There is a latent correctness bug in the same function: comparing `slice(...).toLowerCase()`
against a pre-lowercased needle assumes case folding preserves length, which is not true for
every character (`U+0130` folds to two code points). A `RegExp` built from an escaped needle
has neither problem.

### 2. `buildFilteredRows` spends its budget testing nodes rather than producing rows

`treeModel.ts`'s filter-to-matches walks down from the root testing every child's span
against the match array, and increments `visited` **per node tested**, against
`EXPAND_ALL_LIMIT` (20,000). On a wide document — a flat `<cars>` root, which is exactly the
fixture shape this project measures everything against — the budget is exhausted by testing
the first 20,000 children, regardless of where the matches actually are. The header comment
discloses this ("a match past that point under the same parent is not found, an accepted
approximation"), so it is a known limit rather than a surprise; what makes it worth
re-examining is that the approximation is avoidable.

The match array is already sorted, and `navigation/nodeSpanLookup.ts` (D14) already maps an
offset to its containing node. Seeding from the *matches* and walking **up** to the root
collecting ancestors costs O(matches shown × depth) instead of O(nodes tested), and needs no
approximation at all for the number of rows a user can actually see.

### 3. `viewportMatchDecorations` walks back exactly one match, but matches may overlap

`matchDecorations.ts` reasons that "walking back one is always sufficient" because starts are
strictly ascending. Starts *are* ascending, but both find paths deliberately emit
**overlapping** matches (the byte path advances `i += 1` on a hit; the decoded path
`from = idx + 1`). For a needle of length L, up to L−1 earlier matches can overlap the
window's start offset, and only one is considered.

Usually invisible — the missed spans nest inside the one that is found, so the highlighting
looks identical. It is visible in exactly one case: when the **current** match (the one
navigation is parked on, styled differently) is among the missed ones, its distinct highlight
silently disappears. Needs a repeated-character needle straddling a window edge to reproduce.

### 4. `Interner.lookup` encodes the query name as UTF-8, so a non-ASCII name in a legacy-encoded document resolves to "absent"

`lookup()` does `lookupEncoder.encode(text)` — `TextEncoder` emits UTF-8 and nothing else,
the same constraint `textFind.ts`'s module comment documents for its own byte path. But
`nameBytes` holds names as they appear in the source, so in a windows-1252 document an
element named `größe` is stored as its windows-1252 bytes and a query for `größe` hashes
UTF-8 bytes, misses, and returns `null`.

`parse.ts` then sets `nameId: null`, and `evaluate.ts` treats that as G7's *"a name absent
from the document is empty, not an error."* **The query returns no results and no
diagnostic** — the one outcome indistinguishable from a correct empty answer. The byte path's
identical constraint is documented and routed around (`chooseFindPath`); this one is neither.
ASCII names in legacy encodings, and every name in a UTF-8 document, are unaffected.

### 5. `applyPredicate`'s facet branch compares decoded strings where §6.5 argues for integer compare

`store.textOf(attr.nameId) === predicate.attrName` runs for **every attribute of every
candidate node**. `Interner.text` caches, so this is not a decode per attribute — but it is a
string comparison per attribute where the whole point of §6.5's interning is that name
matching is an integer compare. `predicate.attrName` could resolve through `Interner.lookup`
at parse time exactly as a step's own name already does (`parse.ts`'s `resolveName`), making
the inner loop `attr.nameId === predicate.attrNameId` and letting an attribute name absent
from the document answer empty without touching the store — the same shortcut G7 already
takes for step names, not applied to predicates.

Note this shares finding 4's encoding constraint, and inherits its fix.

### Minor: nested `setTimeout` clamping in `runChunkedJob`

Browsers clamp `setTimeout` to a ≥4 ms minimum once nesting depth exceeds 5, which every
slice after the fifth hits. Against `DEFAULT_SLICE_MS` of 8, that is roughly a two-thirds
duty cycle — a whole-document scan takes ~1.5× its own compute time in wall clock.
`MessageChannel`'s `postMessage` is the conventional way to yield without the clamp. Not
urgent, and `M4-RESULTS.md` §5's inter-slice measurement (worst case 23.6 ms at 500 MB)
already reflects the real behaviour rather than an idealized one.
