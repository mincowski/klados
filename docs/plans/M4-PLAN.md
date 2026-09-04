# NodePad — M4 Implementation Plan

<!-- status: built -->

**Audience:** the coding agent implementing this milestone.
**Reference:** `CONCEPT.md` §6 (search and query — read all of it before G1), §8 ("Operations,
not just loading", and the memory budget), §7 (palette prefix modes), §4.3 (grid), §11.4
(per-document scoping). `DECISIONS.md` D-010, D-026, D-031.

---

## How to use this plan

Work through tasks **in order**. Each has explicit acceptance criteria — do not move on
until they pass. Where a task says "stop and report," stop and report.

> **M3 comes first.** Search reads spans, and M3 is the milestone that makes spans move.
> Building filter-to-matches against a document that cannot be edited would mean building it
> twice. Do not start G1 until M3 has landed.

> **M3 leaves one thing this milestone must not inherit blindly.** `subtreeSplice.ts`
> deliberately does *not* use the pending-delta list — it applies each splice's shift
> immediately and in full to everything after the edit, an O(node count) rewrite per edit.
> That is a documented "start simple," and F10 measures whether it holds. Search adds two
> more arrays of offsets to that rewrite (G1's name index, G4's match set). Check F10's
> numbers before assuming the immediate-shift approach still pays.

### What M4 is

The three things §6 puts in tier 1 and tier 2, plus the index they both rest on:

- a **name index** — `nameId → node refs`, which §6.5 has claimed exists since M0 and which
  does not
- **text find** over the byte buffer, with the results marked in all three views
- **filter-to-matches** in the Tree
- the **NodePad path** query language: name steps, descendant steps, positional and scalar
  facet predicates

§12's reason for promoting search ahead of format breadth is worth keeping in view while
building it: *"search is the operation that most reliably makes tools of this kind feel
slow."* XML Notepad's reported failure was not loading a 100 MB file — it was the Find
dialog taking minutes afterwards (§8). This milestone is where NodePad either avoids that
or does not.

### What M4 is not

- **No comparison predicates.** `car[price>100]` is M7, and §6.3 says why: it is where a
  small query syntax starts growing a type system. Name, position and facet matching cover
  most real use without one. If a predicate needs to know whether `"10"` is less than `"9"`,
  it is out of scope.
- **No XPath.** §6.4 is post-v1 and XML-only. Do not add a query-language selector, and do
  not add a `canXPath` capability — nothing should exist for it to gate yet.
- **No JSONPath.** §6.3 states the reasoning; it is a decision, not an omission.
- **No search across tabs.** §6.6 rules it out explicitly, and there are no tabs anyway.
- **No streaming.** Provisional match counts on a partially-parsed document (§6.6) belong
  with M5's streaming parse. G4 leaves the seam; it does not build the state.
- **No replace.** Find is read-only in M4. Search-and-replace over a 200 MB byte buffer is a
  bulk-edit problem, not a search problem, and it needs M3's numbers first.

### Hard rules

1. **Never convert the source to a JavaScript string** (invariant 1). Text find operates on
   `Uint8Array`. G2 has a *bounded* decoded path for the cases bytes cannot serve — regex
   and non-ASCII needles — and it is bounded the same way the Raw View's window is: by a
   fixed number of rows at a time, never by document size. Any code that reaches for
   `decoder.decode(allBytes)` has broken the milestone.
2. **Node sets are `Int32Array` of node indices, never materialized objects** (§6.6). "A
   naive engine building object arrays would allocate hundreds of megabytes on a 200 MB
   document." The same rule that produced the flat store produces the query engine.
3. **Anything that could exceed ~50 ms is chunked, cancellable, and reports progress**
   (§6.6, §8). This is not a nice-to-have here — it is the milestone's entire justification.
4. **Nothing above `src/formats/` tests a format id** (invariant 8). The path syntax is
   deliberately identical on every format because the model is already unified; if an
   evaluation step needs to know it is looking at XML, that is a design signal — stop and
   report.
5. **Every search and query command is reachable from the palette** (invariant 10), enforced
   by `test/commands.test.ts` as it already is for everything else.
6. **Do not modify `src/core/types.ts`.** Its closing section already names search indexing
   as shared infrastructure "built from the intern table, format-agnostic" — deliberately
   *not* a `FormatModule` concern. If search seems to need a per-format hook, stop and
   report.

---

## Where search runs — read this before G1

§6.6 says: *"Queries run in the worker, against the same store, so the UI never blocks."*
**That sentence does not describe the architecture that exists**, and the gap is not
something to discover halfway through G3.

What exists: `parseInWorker` spawns a worker per parse, and the `done` message *transfers*
the store buffers, the interner buffers and the source bytes to the renderer
(`transferablesFor`). A transfer detaches the sender's copy. **After a parse completes, the
worker holds nothing and is terminated.** There is no worker-side store for a query to run
against.

The three ways to close that gap, and why only one of them is M4's:

| Route | Cost | Verdict |
|---|---|---|
| Transfer the store back to a worker per query | Detaches the renderer's copy for the duration — the Tree and grid cannot render while a search runs | Unusable |
| `SharedArrayBuffer` for the store and source | Needs cross-origin isolation, which this app does not have (`loadFile` in production, no COOP/COEP headers) and which is a real change to the main process and the whole allocation path | Not M4's to make |
| **Chunked, cancellable, time-sliced work on the main thread** | Yields between slices; a slice is sized to a frame, not to the document | **Build this** |

§8's actual requirement is *"chunked **or** moved off-thread so the UI never blocks"* — the
disjunction is in the design already. Chunking satisfies it, and it satisfies it without a
seam change that M4 has no other reason to make.

**Build G3's scheduler as the one place that decides how work is sliced**, with search jobs
expressed against it rather than against `setTimeout` directly. That is what makes the
worker route a later swap rather than a later rewrite — and M5 has an independent reason to
revisit shared memory (streaming parse needs the bytes readable on both sides at once). If
M5 lands it, search moves behind the same interface. Do not pre-build for that; do not
preclude it either.

**Report if a search job cannot be sliced under a frame** — that is the one finding that
would force the seam question earlier than M5.

---

# Tasks

## G1 — The name index

**Files:** `src/core/nameIndex.ts`, `src/worker/parse.worker.ts`, `src/core/parseClient.ts`

§6.5 claims *"The intern table **is** the name index. `name → node ids` answers 'every node
called `price`' in O(1) plus result size."* It is not. `Interner` maps id → bytes, forward
only. `navigation/nodeNameSearch.ts` says so in its own header comment and works around it
with a 200,000-node scan cap and a `truncated` flag. This task makes the claim true.

**Shape — compressed sparse row, two typed arrays, no `Map`:**

```ts
interface NameIndex {
  readonly starts: Int32Array   // length nameCount + 1; group k is [starts[k], starts[k+1])
  readonly nodes: Int32Array    // node refs, grouped by nameId, ascending within a group
}
```

**Build it in the worker, after `format.parse` returns, and transfer it with everything
else.** Two passes over the node array — count per `nameId`, prefix-sum, fill — so it is
O(n) with no allocation per node, and both arrays join `transferablesFor` at zero copy.
Nodes land in ascending ref order inside each group for free, because the fill pass walks
refs ascending; that is document order, which is what `//name` needs and what a `Map` of
arrays would not have given without sorting.

**Nodes with no name (`NO_NAME`) are not in the index** — text nodes, array elements, the
document root. Size it against the named-node count, not `nodeCount`.

**Attribute names get no index.** `car[@id="c-001"]` is a filter over a candidate node set,
never a lookup by attribute name, and `NodeStore.attributesOf` already binary-searches a
contiguous per-owner range. Adding a second CSR over the attribute table would cost ~4.8 MB
at 200 MB density to serve a query shape that does not exist. If G8 finds it needs one, that
is a finding to report, not a thing to add pre-emptively.

**Invalidation is this task's real difficulty, not the build.** M3's `subtreeSplice`
renumbers node refs: the edited node keeps its ref, the replacement occupies the same
starting index, and *every ref after it shifts by a constant*. So the index is not merely
stale after a splice — it is wrong in a way that reads as plausible. Two honest options:

- **Patch it.** Refs ≥ the splice point shift by the node-count delta; the replaced range's
  entries are removed and the new subtree's re-inserted. One pass over `nodes` (~26 MB at
  200 MB density), which is the same order of work the splice already does when it rewrites
  every span after the edit.
- **Rebuild it**, time-sliced through G3's scheduler, with consumers falling back to the
  bounded scan until it lands.

Measure both in G10 and pick with the number. Whichever you pick, **the index must never be
readable in a stale state** — a wrong node ref from a search result is worse than a slow
search, because it selects the wrong node silently.

**Consumer, immediately:** `findNodesByName` loses `SCAN_LIMIT`, loses `truncated`, and
becomes exact. Its header comment ("A real name index is a reasonable thing to want later")
comes out with it. Delete the cap; do not leave it as a fallback that nothing exercises.

**Acceptance:** every node with a given name is returned, in document order, on a document
where the naive scan is known to miss some (a fixture with matching nodes past ref 200,000).
Memory reported as a real line item against §8's budget table. After a subtree splice, every
ref the index returns still points at a node with that name — assert it against a full
rebuild, do not eyeball it.

## G2 — Text find over the byte buffer

**File:** `src/core/textFind.ts`

§6.2: *"Operates on the byte buffer, not a tree walk — a substring search over `Uint8Array`
with the needle encoded once. Results are an `Int32Array` of byte offsets, resolved to nodes
only when displayed."*

**One rule decides which of two paths runs, and it falls out of encoding rather than being
invented:**

- **All-ASCII needle → the byte path.** Boyer–Moore–Horspool over `Uint8Array`. An
  all-ASCII needle encodes identically in every encoding this application accepts — UTF-16
  is refused at parse with a Fatal diagnostic (`parse.worker.ts`), so every document that
  opens is ASCII-compatible. `TextEncoder` only emits UTF-8, which is exactly why the byte
  path cannot be extended past ASCII: there is no web API that encodes `"café"` to
  windows-1252.
- **Non-ASCII needle, or regex → the decoded path.** Decode a sliding window of rows
  (~64 KB, using the row index that already exists) with `TextDecoder(sourceBuffer.encoding)`
  and run the match there. Windows advance with a **one-row overlap** so a match spanning a
  row boundary is fully contained in the next window; matches are produced ascending, so
  deduplicating on byte offset is trivial.

**Case-insensitivity:** the byte path ASCII-folds in the comparison. The decoded path uses
the platform's own casing. State this in the UI as a footnote, not as a surprise.

**Mapping a decoded match back to a byte offset**, which is the part that goes silently
wrong: a row's byte start is known exactly from the row index, so a match at string index
*i* within a row is at `rowStart + byteLengthOfPrefix`. For UTF-8 that is
`new TextEncoder().encode(prefix).length` on a ≤512-byte prefix; for a single-byte code page
string index *is* the byte offset. Both are cheap and both are exact. **Do not approximate
this** — an off-by-a-few-bytes match offset produces a highlight that drifts and a node
resolution that is occasionally wrong.

**Two limits to write down rather than discover:** the decoded path cannot find a match
longer than one window minus one row (~63 KB), and regex `^`/`$` anchor to the decoded
window, not to document lines. Both are acceptable; neither is acceptable undocumented.

**Acceptance:** find on `cars-200mb.xml` returns the same offsets as a naive
`indexOf`-per-byte reference implementation over a smaller fixture. A needle spanning a row
boundary is found exactly once. A needle containing non-ASCII is found in a
windows-1252 fixture at the right byte offset. Match count and first-match latency reported
at 10/50/100/200/500 MB.

## G3 — The chunked job scheduler

**File:** `src/renderer/session/searchJob.ts`

The one place that decides how long-running work is sliced, per §6.6 and §8. Everything in
this milestone that touches the whole document runs through it: G2's scans, G1's rebuild if
that is the route chosen, G8's evaluation.

- A job is a resumable step function plus a cursor, sliced by **elapsed time, not by item
  count** — 4 MB of ASCII bytes and 4 MB of dense markup are not the same amount of work
- Yields between slices without starving input; **progress after ~50 ms**, per §6.6
- **Cancellable, and superseded jobs never land.** Use the same `activeAbort`-supersede
  discipline `documentSession` already has, and read the bug that was found in it once
  (`174606f`) before writing a second copy of the pattern — a superseded search that lands
  after a newer one shows a stale match count against a current query, which looks like a
  counting bug and is not one
- A new query supersedes the running one; so does an edit, so does closing the document

**Acceptance:** a search over the largest fixture never blocks a frame — measured with a
real `requestAnimationFrame` loop, not asserted. Cancelling mid-scan leaves no state behind.
Two queries issued a keystroke apart produce exactly the later one's results.

## G4 — Search state on the document session

**Files:** `src/renderer/session/searchStore.ts`, `documentSession.ts`

Results are an `Int32Array` of byte offsets, ascending, **resolved to nodes only when
displayed** (§6.2). `navigation/nodeSpanLookup.ts` (D14) already does offset → node; do not
build a second one.

- **Per document** (§6.6, §11.4) — results, match state and filter mode all die with the
  document
- **An edit invalidates the match set.** Re-run on the same debounce as reparse rather than
  shifting offsets through the delta list: find is fast enough that re-running is simpler
  than maintaining correctness across a splice, and a match set that is *nearly* right is
  the failure mode this project keeps finding expensive. Mark the count stale in the
  interim; do not show a number that is quietly wrong.
- **Leave the seam for provisional counts** (§6.6, M5): a boolean on the result set is
  enough. Do not build the streaming state behind it.

**Acceptance:** search survives selection changes and view toggles; it does not survive
closing the document. An edit clears the match set visibly rather than leaving stale
highlights in the Raw view.

## G5 — Find UI

**Files:** `src/renderer/components/Find/`, plus consumers in Raw, Tree and Detail

§6.2's list, in full: *"match count, next/previous, highlight in Raw, matching nodes marked
in the Tree, matching rows marked in the grid."*

- A find bar with `Ctrl+F`. **Note the collision:** M2b bound `Ctrl+F` to the grid's quick
  filter (`89a0f94`). Two different operations cannot share one binding on the strength of
  which pane has focus without becoming unpredictable — resolve it deliberately, one way or
  the other, and record it in `DECISIONS.md`. Do not leave it to a `when` clause and hope.
- Next/previous move the selection and the Raw window. Both are absolute-offset operations,
  so both are independent of where the window happens to be (§4.4).
- **Highlighting in Raw is viewport-bounded.** `rawDecorations.ts` already builds
  decorations for the visible window only, and D-031's whole argument is that the decoration
  set must never be document-sized. Match highlights follow the same rule — binary-search
  the match array for the window's range, decorate that slice.
- Tree and grid marking is an **overlay, not a filter** — the grid's own quick filter and
  column filters (`gridFilter.ts`) are a separate mechanism and both stay. A row can be
  filtered out by one and matched by the other; make sure that reads sensibly.

**Acceptance:** keyboard-only find, next, previous, dismiss. Match count is live and never
stale. Both themes checked for the match and current-match styles. Every command in the
palette.

## G6 — Filter-to-matches in the Tree

**File:** `src/renderer/components/Tree/treeModel.ts`

§6.2: *"A filter-to-matches mode hides non-matching subtrees in the Tree."*

**This needs no new index.** A node's subtree contains a match iff the sorted match array
has an entry in `[spanStart, spanEnd)` — two binary searches per visible row, O(log m), on
rows that are virtualized anyway. Spans are contiguous over a subtree by construction
(`subtreeSplice.ts` documents why), so the test is exact, not approximate.

Auto-expand along the path to each match, but bound it the way `expandAll` already is
(`EXPAND_ALL_LIMIT`, 20,000) — a query matching three million nodes must not attempt to
expand them.

**Acceptance:** filter mode hides every subtree with no match and no others; ancestors of
matches stay visible. Toggling it off restores the previous expansion state, not a collapsed
tree. A match count in the millions does not hang the Tree.

## G7 — The NodePad path parser

**File:** `src/core/path/parse.ts`

§6.3's grammar, and nothing beyond it:

```
cars/car               children by name
cars//price            any descendant
car[@id="c-001"]       scalar facet predicate
car[3]                 positional
*                      any name
```

Produces a small step list — an array of `{ axis, nameId, predicate }` — not an AST of
objects per node. Resolve names to `nameId` **at parse time**, through the document's
interner: a name that does not exist in the document interns to nothing and the query is
answerable as empty without touching the store. That is §6.5's integer-compare argument
applied one level up.

Malformed queries produce a diagnostic with an offset into the query string, never a throw —
the same discipline as invariant 5, for the same reason: the user is mid-typing.

**Acceptance:** every form in §6.3 parses. `car[price>100]` is rejected with a message
saying comparison predicates arrive at M7, not with a syntax error that implies it will
never work.

## G8 — Path evaluation over the flat store

**File:** `src/core/path/evaluate.ts`

§6.6, and the rules there are the whole design:

- **Node sets are `Int32Array` throughout**, allocated per step against a reused growable
  scratch buffer, never an array of objects
- A **name step** walks each context node's children comparing `nameId` — an integer
  compare, which is why §6.5 interns
- A **descendant step (`//`)** uses G1's index: take every node with that `nameId` (already
  ascending), then keep those inside a context node's span. Context spans are ascending and
  either disjoint or nested, so containment is a binary search, not a walk. **This is the
  step the name index exists for** — without it, `//price` is a full document scan.
- A **positional predicate** groups by parent; a **facet predicate** filters through
  `attributesOf`, which is already a binary-searched contiguous range per node
- Runs through G3's scheduler: lazy, chunked, cancellable, progress past ~50 ms

**Acceptance:** every §6.3 form evaluates correctly against both Appendix A documents, XML
and JSON, **with the same query string producing the same node set on both** — that is
invariant 8 and §6.3's central claim, and it is testable rather than aspirational.
`//price` on `cars-200mb.xml` is measurably sublinear in document size relative to a scan.

## G9 — Query UI

Reuse the palette's prefix-mode machinery (§7) rather than building a second entry point.
`@` (jump by name) is already there and becomes exact with G1; the query surface is its
sibling, not a new subsystem.

Results feed the same store as G4, so marking, next/previous and filter-to-matches work
identically whether the match set came from a text find or a path query. **That is the
payoff for expressing both as an offset set** — do not let a query result take a different
route to the same three views.

**Acceptance:** a query and a find are interchangeable everywhere downstream. Every command
in the palette. Keyboard-only end to end.

## G10 — Measurement pass

`docs/plans/M4-RESULTS.md`.

1. **Text find latency** at 10/50/100/200/500 MB — byte path and decoded path separately,
   because they are not the same algorithm and averaging them hides which one is slow
2. **Name index build time and memory**, as a line item added to §8's budget table. At the
   density §8 records (~6.6 M nodes at 200 MB) this is a real percentage of the budget, not
   a rounding error — report it as such
3. **Name index invalidation** — patch versus rebuild after a subtree splice (G1), which is
   the decision this measurement exists to settle
4. **Path evaluation** for each step type, and `//name` against a full scan to confirm the
   index is doing what it was built for
5. **Frame time during search**, under a real `requestAnimationFrame` loop. §8's whole
   argument for this milestone is that the failure mode of comparable tools is a Find dialog
   that blocks — a search that is fast on a stopwatch and drops frames has not met it

**Inherited, and now overdue:** **Grid and Tree scroll frame time** and **wrap's
first-paint cost** (§13). These need a harness that mounts real React components under a
real rAF loop. M2's E10 explained why it could not be built there; M3's F10 said a third
deferral "should be a decision rather than a consequence." If it is still not built when M4
ends, that is now a fourth deferral, and it should be recorded in `DECISIONS.md` as a
decision not to measure them — with what is being accepted in exchange.

---

# Definition of done for M4

- [ ] `nameId → node refs` exists as typed arrays, built in the worker, transferred at zero
      copy, and correct after a subtree splice
- [ ] `findNodesByName` is exact; `SCAN_LIMIT` and `truncated` are gone
- [ ] Text find runs over bytes for ASCII needles and over bounded decoded windows otherwise,
      with exact byte offsets in both
- [ ] Every whole-document operation is chunked, cancellable, reports progress past ~50 ms,
      and a superseded job never lands
- [ ] Matches are marked in Raw, Tree and grid from one offset set, whatever produced it
- [ ] Filter-to-matches hides non-matching subtrees and restores expansion state on exit
- [ ] The §6.3 grammar parses and evaluates, with **identical results for the equivalent XML
      and JSON documents**
- [ ] `Ctrl+F`'s collision with the grid quick filter is resolved and recorded
- [ ] All search and query commands in the palette; keyboard-only end to end; both themes
- [ ] `npm test`, `npm run typecheck`, `npm run lint` clean
- [ ] `docs/plans/M4-RESULTS.md` written; `DECISIONS.md` updated for anything settled
- [ ] **No comparison predicates, no XPath, no replace, no cross-tab search**

## Report back on any of these

- **A search job that cannot be sliced under a frame.** That forces §6.6's worker question
  earlier than M5 wants to answer it, and it is better known early.
- **The name index costing materially more than the two `Int32Array`s predict**, or its
  invalidation after a splice costing more than the splice itself.
- **Path evaluation needing to know the format.** That is invariant 8 failing, and §6.3's
  "one query for every format" claim with it.
- **Any temptation to decode the whole document.** The decoded path exists precisely so that
  temptation has a bounded answer; if it does not cover a real case, say which.
- Anything in `CONCEPT.md` §6 that turns out to be wrong once built. §6.5's "the intern table
  is the name index" was already wrong in exactly this way — it described a design intention
  as an existing property. Expect neighbours.
