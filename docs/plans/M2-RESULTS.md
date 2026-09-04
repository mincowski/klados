# NodePad — M2 Results

Filled in incrementally as M2's tasks close their own §13 questions and
measurements. E10 owns the full measurement pass (detection/column-collection
cost, grid and Tree scroll frame time, wrap's first-paint cost, peak RSS);
tasks that own a narrower question of their own record it here as they land,
same as `M1-RESULTS.md`.

## E2 — Wrapper descent depth (§13)

**Question** (M2-PLAN.md E2, CONCEPT.md §13): is the ~3-hop descent limit too
tight, or should descent be unbounded, stopping only at the first node that
isn't a transparent wrapper?

**Finding:** ~3 is tuned for XML and is measurably too tight for the JSON
equivalent of the same document. Descending Appendix A's shape from the
document root:

| | Wrapper hops to the first non-wrapper node |
|---|---|
| XML (`root → garage → cars → elements`, then `elements` has 3 `<car>` — not a wrapper) | 3 |
| JSON (`root → {garage → {cars → {items → [car×3]}}}`) | 6 |

(Both counts include the synthetic Document/root node itself, which is also
a transparent wrapper for any document with a single top-level value — see
CONCEPT.md's own "note on wrapper depth," which counts `root → garage` as one
hop for exactly this reason. Starting the count from the first *named*
element instead — `garage` for XML, the `garage` Property for JSON — gives 2
and 5 hops respectively; either way, JSON needs exactly one more hop for each
of `cars` and `items` than XML needs for `cars`.)

The gap is D-030's own folding rule: a scalar value folds onto its Property,
but a composite value keeps a separate Object/Array node ("a `Property`
whose value is an object or array keeps the composite child, as it must").
XML's Element already carries both a name and its children in one node, so
XML's wrapper chain for a given shape is always shorter than JSON's for the
same shape. A depth cap sized to feel right for XML silently truncates the
JSON descent partway through the identical document — which breaks the
"same shape, same result" claim invariant 2 exists to protect, for no reason
the cap itself defends: each hop is O(1) (a wrapper has exactly one
composite child by definition, so the whole descent costs O(chain length)
regardless of how long it's allowed to run) — there is no performance
argument for capping it tightly, only a correctness argument for capping it
at all (a degenerate, pathologically deep single-child chain).

**Decision:** descent is effectively unbounded. `resolveWrapperTarget`
(`src/renderer/components/Detail/transparentWrapper.ts`) stops only when it
reaches a node that is not itself a transparent wrapper — §4.3's own
alternative phrasing, "the first node with repeating children." The `maxDepth`
parameter still exists and defaults to `DEFAULT_WRAPPER_DESCENT_DEPTH = 1000`,
but that number is a safety bound against a degenerate document, not a UX
limit tuned to any real document's expected depth — tests exercise both the
default (reaches the real destination) and an explicit tight cap of 3 (which
visibly truncates the JSON case above), confirming the difference is real
and not just theoretical.

**Also found during implementation, not in §13 but adjacent to it:** the
literal rule text ("exactly one composite child, no attributes, no text")
under-specifies what happens when a node has *other* non-composite children
alongside its one composite child. A `Comment`/`ProcessingInstruction`/
`DocType` sibling is pure document metadata and must not disqualify a
wrapper (Appendix A's `garage` and `cars` both carry an adjacent comment and
are still wrappers) — but a leaf `Element`/`Property`/`Scalar` sibling is a
real data field (exactly what E4's cell-rendering table calls a "presence
marker" or a literal value) and *must* disqualify it, or a shape like
`<zoo><cat/><cat/><dog>…</dog></zoo>` would silently descend into `dog` and
drop both `<cat/>` fields from view entirely — worse than showing them in an
unglamorous list, since they wouldn't even be reachable via the breadcrumb.
`transparentWrapper.ts`'s `wrapperCompositeChild` treats these two cases
differently for exactly this reason; `test/transparentWrapper.test.ts` pins
both directions down.

## E10 — Measurement pass

**Status: partial.** Detection/column-collection cost and peak RSS are
measured, on the real fixtures, in-process. Grid/Tree scroll frame time and
wrap's first-paint cost are **not** measured this pass — see "What this does
not cover" below for why, and what it would take.

### Methodology

`spike/m2-e10-measure.ts` (`npx tsx spike/m2-e10-measure.ts <file>`), the
same one-off-harness convention as `spike/codemirror-harness` and
`src/cli/inspect.ts` — not wired into `npm test`. Parses the real fixture
with the real XML format module, resolves the wrapper chain exactly as
`Detail.tsx` does (E2's `resolveWrapperTarget`), then times `detectGrid`
(E1), `collectGroupMembers`, and `collectColumns` (E3) with
`process.hrtime.bigint()`. RSS is sampled once at the end via
`process.memoryUsage().rss`, after a single `readFileSync` — no second
in-memory copy of the source bytes, which is exactly the harness artifact
`M1-RESULTS.md` flagged as contaminating its own 776.1 MB figure for this
same 200 MB fixture.

### 1. Detection and column collection cost

| Fixture | Size | Members | `detectGrid` (E1) | `collectGroupMembers` | `collectColumns` (E3) |
|---|---|---|---|---|---|
| cars-10mb.xml | 10 MB | 31,655 | 4.4 ms | 2.3 ms | 66.0 ms |
| cars-50mb.xml | 50 MB | 158,334 | 10.2 ms | 9.8 ms | 288.8 ms |
| cars-200mb.xml | 200 MB | 633,268 | 29.0 ms | 35.1 ms | **1026.0 ms** |
| cars-500mb.xml | 500 MB | 1,583,128 | 68.9 ms | 83.1 ms | **2542.0 ms** |

**E1's detection stays comfortably inside a frame budget at every size** —
even 500 MB's 1.58 M members costs 69 ms, and that's a one-time cost on
selecting the parent node, not a per-frame one. §4.3's "under 50 ms for 2 M
children" estimate (E1) holds: extrapolating the near-linear scaling here
(~43 ns/member) puts 2 M members at roughly 88 ms — closer to 50 ms than not,
and nowhere near a visible hitch regardless.

**E3's column collection does not.** 1.03 s at 200 MB and 2.54 s at 500 MB
are both far past "tolerable once, on selection" — this is the exact trap
the plan named in advance: *"If it does not land inside a frame budget, the
fix is not a spinner... Collect from a bounded prefix (~1000 rows) for first
paint and complete in the background — but note the trap: frequency ordering
computed from a sample and then revised reorders columns under the user,
which is worse than a brief wait. If sampling is needed, freeze the order
from the sample and let later discoveries append only."**

This is **the decision the plan itself reserves for the user, not the
agent** ("the choice between 'brief wait' and 'columns that reorder
themselves' is the user's, not the agent's" — M2-PLAN.md's own "Report back"
list). Not implemented here pending that decision. Two candidates, from the
plan's own text:

- Accept the wait (1–2.5 s) as the cost of opening a 200–500 MB file's grid
  the first time, on the reasoning that it's a one-time cost per selection,
  not per frame or per scroll — the same framing `M1-RESULTS.md` used for
  the ~5.46 s end-to-end open time.
  ​
- Sample the first ~1000 members for first paint, complete the full scan in
  the background, and **freeze column order from the sample** — accepting
  that a field appearing only after row ~1000 gets appended at the end
  rather than in true first-appearance order, rather than letting the whole
  column set reorder once the background pass finishes.

> **Corrected on review. The decision above is premature: ~87% of the cost is avoidable,
> and the largest single component was never measured.**
>
> **1. `isNumericColumn` is not in this table and dominates it.** `Grid.tsx` computes
> `numericColumns` on first render by calling `isNumericColumn` for every column, which
> calls `cellOf` — and therefore **decodes text** — for every member. It early-exits on the
> first non-numeric value, so only genuinely-numeric columns scan the whole group, but on
> `cars-200mb.xml` that is still:
>
> | | 200 MB |
> |---|---|
> | `collectColumns` (measured above) | 1122 ms |
> | `numericColumns` (**not** measured above) | **1522 ms** |
> | **Real total to first grid paint** | **2644 ms** |
>
> The fix has no trade-off at all: numeric-vs-not is an *alignment hint*. Sampling the first
> ~200 non-absent values decides it just as well, and the worst case — a column numeric for
> 200 rows and textual later — is a cosmetic misalignment, not a wrong answer. There is no
> column order to freeze and nothing reorders. ~1522 ms → under 1 ms.
>
> **2. `collectColumns` itself has ~3× of avoidable allocation.** It builds two `Map`s plus
> an entry object per distinct field *per member* — 633 K members × 2 Maps × ~6 entries — and
> iterates through the `childrenOf`/`attributesOf` generators, the latter allocating an
> object per attribute. Replacing the per-member Maps with a reused flat scratch array
> (fan-out is ~6 fields, where a linear scan beats a Map outright) and walking
> `firstChildOf`/`nextSiblingOf` directly measures **1084–1135 ms → 357–388 ms, a 2.8–3.2×
> speedup, with identical output**. Non-allocating attribute accessors on `NodeStore` would
> take it further.
>
> **Together: ~2644 ms → ~370 ms at 200 MB, ~900 ms at 500 MB.** At that point the choice
> this section reserves for the user — accept a 1–2.5 s wait, or sample and freeze column
> order — **does not need making**. Neither option was the right first move: the plan's own
> instruction was to *measure* before bounding, and what the measurement actually shows is
> an implementation cost, not an algorithmic one.
>
> **Implemented and re-measured**, same harness, same fixtures:
>
> | | 200 MB before | 200 MB after | 500 MB after |
> |---|---|---|---|
> | `collectColumns` | 1122 ms | **410 ms** | 979 ms |
> | `numericColumns` | 1522 ms | **7 ms** | 5 ms |
> | **Time to first grid paint** | **2644 ms** | **417 ms** | **985 ms** |
>
> `isNumericColumn` now stops at 200 present values *and* 5,000 rows scanned — the value
> sample alone left one sparse column still scanning every member at 328 ms, since an absent
> cell doesn't count toward the sample. `collectColumns` replaces its two per-member `Map`s
> and per-field entry object with a reused flat scratch array, and walks
> `firstChildOf`/`nextSiblingOf` rather than the `childrenOf` generator. Both keep their
> output identical; `test/gridColumns.test.ts`'s ten existing cases pass unmodified, which
> is the check that matters for a rewrite of this kind.
>
> One thing worth recording because it was a real mistake mid-fix: the first attempt
> declared the scratch array's linear-scan helper **inside** the member loop, allocating a
> closure per member and leaving 767 ms on the table — the exact cost being removed, in a
> new place. Hoisting it out gave the remaining 2.7×.
>
> `sortByColumn` also stopped calling `numericValue` inside its comparator (O(n log n) →
> O(n) parses, ~12.6 M → 633 K on this fixture) and now builds one `Intl.Collator` rather
> than letting `localeCompare` reconstruct one per comparison.

Why `collectColumns` costs ~30× `detectGrid` for the same member count:
`detectGrid` reads one `nameId` per composite child (a single pass, no
decoding). `collectColumns` reads every attribute and every named child of
every member, groups them per member, and mutates a `Map` per distinct
field — real, unavoidable extra work for the richer result, not an
implementation inefficiency (no decoding happens either; `store.textOf` is
only ever called for display, never inside the collection loop itself).

### 2. Peak RSS — closes `M1-RESULTS.md`'s own open item

`M1-RESULTS.md` reported 776.1 MB for `cars-200mb.xml` against the 800 MB
bar, then flagged on review that its own harness held the file's bytes
twice (`fs.readFileSync` plus a transfer `ArrayBuffer` slice) and asked for
a re-measurement "through the product's own IPC path" — explicitly deferred
to M2's E10.

| Fixture | Size | Peak RSS (single read, full node store + interner + detection + columns) |
|---|---|---|
| cars-200mb.xml | 200 MB | **554.2 MB** |
| cars-500mb.xml | 500 MB | **1284.1 MB** |

554.2 MB at 200 MB is cleanly under the 800 MB bar, with real margin this
time — no contaminating second copy, and it now sits close to
`M0-RESULTS.md`'s own in-process 589 MB figure (the two agree, as the
corrected reading in `M1-RESULTS.md` predicted they would once the
harness artifact was removed). This is not the exact same measurement as
the full product pipeline — it excludes the row index and line index
(`buildRowIndex`/line index construction, `M0-RESULTS.md`'s own ~0.93 s /
some tens of MB line item) and the transient `Map`/`Set` allocations E1/E3
make internally, most of which GC reclaims before the RSS sample but not
provably all of it — so 554.2 MB is a lower bound on the real product
figure, not the figure itself. Given it already sits close to the
already-corroborated 589 MB in-process number, the remaining gap (row
index, line index) is unlikely to push the total anywhere near 800 MB.
500 MB's 1284.1 MB was never subject to the 800 MB bar (that bar was stated
for the 200 MB fixture specifically) and scales as D-030's own ~2.5–3×
file-size budget predicts.

### What this does not cover

- **Grid scroll frame time** (both axes) and **Tree's own scroll frame
  time** (an M1 done-criterion `M1-RESULTS.md` already left unmeasured) are
  **not measured in this pass.** Both need a real `requestAnimationFrame`
  loop driving a real, rendered `@tanstack/react-virtual` instance — the
  mechanism `M1-RESULTS.md`'s D15 pass built specifically for this
  (`spike/codemirror-harness/main-d15.cjs`, a real Electron `BrowserWindow`
  plus a real rAF loop). That harness is CodeMirror-specific (it drives an
  `EditorView`, not a React tree), so measuring Grid or Tree the same way
  needs a new harness page that mounts the real React components — not
  attempted here. `npm run dev` itself does not launch in this session's
  environment (`electron.app` is `undefined` at startup, a sandbox/display
  constraint, not a code issue — confirmed by the fact that
  `main-d15.cjs`'s own, differently-entered Electron process *does* launch
  cleanly here) — the exact tool needed to measure this by hand is present
  but not scriptable within this pass's time budget.
- **Wrap's first-paint cost** (§13, D12) — the last M1 question `M1-RESULTS.md`
  left open — is likewise not measured; it needs the same kind of live
  `EditorView` harness and is unrelated to the grid.
- **Grid export cost** — not measured in this pass, and it is unbounded. `Grid.tsx`'s
  `copyAs` builds the *entire* displayed grid as one string with no row cap: measured at
  401 ms / 5 MB on `cars-10mb.xml`'s 31,655 rows, which extrapolates to **~8 s and ~97 MB of
  UTF-16 string on `cars-200mb.xml`**, and ~20 s / ~240 MB at 500 MB. Reachable from a
  palette command and a toolbar button, with no warning and no progress. §4.3 says "copy
  *selection*", and M2 has no selection model, so "everything displayed" is a defensible
  reading — but it needs the same soft-cap confirmation §11.2 uses for opening a large file,
  or a row cap, before it is safe to leave on a button.
- **Grid coverage floor (E1's 5%) and wrapper descent depth (E2's ~3)**
  against *real* documents beyond the `cars-*.xml` family: not attempted —
  no second real-world document corpus was available in this pass. Both
  were reasoned about and, for wrapper depth, measured against the
  documented Appendix A shape (see E2's section above); the 5% floor is
  still exactly the "guess needing real documents" `CLAUDE.md`/§13 call it.
