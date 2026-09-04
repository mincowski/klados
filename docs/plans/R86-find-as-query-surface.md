# R86–R90 — the Find bar becomes the document's query surface

<!-- status: built-caveat -->

**Built, two things owed — see `docs/TASKS.md`'s Owed table.** Register: `docs/TASKS.md`. Five asks that turn out to be one topic: the Find bar stops
being a one-line needle box. Path becomes a third mode, the input grows to hold what you paste into
it, and a replace row appears underneath. They share one layout and one Enter key, which is why they
are planned together rather than three times. Related: `docs/plans/R72-path-query.md` (the palette's
`/` mode), `docs/plans/R78-find-affordances.md` (the chip this supersedes),
`docs/plans/R41-raw-editing.md` (the edit path Replace has to use).

**Every question in this document is settled — nothing here is waiting on a decision.** Where a
choice was made rather than derived, the section says so and gives the reason.

---

## 1. Path mode is an architecture change that happens to be a nicer UI

The proposal was framed as a convenience — Find is a better place to *refine* a query than a
one-shot palette prompt, and it fixes the hand-off. Both true. But the reason to do it is in
`searchStore.ts`'s own comment on `setDirectResult`:

> there is no `SearchQuery` to re-run when the document changes underneath it — a path query's
> result is a snapshot of node refs translated to spans at evaluation time

**So today, editing a document with a path result live marks it `stale` permanently.** A text search
re-runs on every reparse; a path result cannot, because the store holds the answer and not the
question. Make path a mode and the query is `{ text: '/garage//name', mode: 'path' }` — re-runnable
like anything else, and that gap closes as a side effect.

It is also mechanically cheap. `evaluatePathChunked` (`navigation/pathQueryJob.ts:31`) returns
`SearchJob<Int32Array>` — the *same* `SearchJob` type `findJobFor` returns, both built on
`runChunkedJob`. The store already owns the machinery for this; it has simply never been pointed at
it.

**And it removes the cause of R74 and R78, rather than another symptom.** Every defect in those
rounds came from one thing: the query lived in the palette and the result lived in Find. That split
is what produced an empty input over a live result, a separately-tracked `directResultOrigin`, a
`hasDirectResult` flag, and two toggles whose only reachable effect was to destroy the result. Put
the query where the result already is and the whole apparatus goes.

R72 §2 argued half of this already — reusing Find is right *because* Find owns the count,
next/previous and the highlighting. This finishes the sentence.

**The cost, stated plainly: this supersedes R78, which shipped four commits ago.** The chip was the
correct fix for the design as it stood. This changes the design so the problem does not arise.

---

## 2. R86 — the mode belongs in `SearchQuery`

`SearchQuery` gains a mode; `findJobFor` branches on it and returns either the existing text job or
`evaluatePathChunked` wrapped in the nodes→spans adapter that currently sits inline in
`runPathQuery` (`Palette.tsx:351-356`).

**Confirmed: `SearchQuery` is declared in `session/searchStore.ts`, and `src/core/types.ts` does not
mention it at all.** The frozen contract is untouched by this round — checked rather than assumed,
since it is the one constraint that would have stopped it.

### Parse the path per evaluation, not once when the query is built

`parsePath(query, lookup)` takes a name-lookup closure over `store.interner`, so a parsed path is
**bound to the store that parsed it**. Storing a `ParsedPath` in the query would go stale the moment
a reparse lands — which is precisely the case this round exists to make work.

So `SearchQuery` holds the **text**, and the store parses on every evaluation. That costs a parse per
re-run (microseconds against an evaluation measured at 163–314 ms on a 100–200 MB fixture, per G10)
and is the only version that is correct after an edit.

### What retires

`setDirectResult` has exactly one production caller left once R88 lands (`Palette.tsx`); the rest is
the store's own plumbing and tests. Retire it, along with `hasDirectResult`,
`getDirectResultOrigin`, and `FindBar`'s origin-sync effect. **Retire it in R88, not here** — it must
keep working until the palette stops calling it.

`test/searchStore.test.ts` has 21 references to it. Those tests do not simply delete: each one is
asserting something about supersession or clearing that still has to be true of a path *query*.
Convert them, do not drop them.

### The re-run path is already correct

`searchStore`'s session subscription re-runs on `document.store !== lastStore` via
`if (activeQuery !== null) runSearch(document, activeQuery)`. A path query is an `activeQuery`, so
it re-runs there with no change — against the new store, which is what makes it correct.

---

## 3. R87 — the mode control, and why it is two buttons rather than three

Four shapes were considered:

| Shape | Verdict |
|---|---|
| Three-state cycle on `.*` | **No.** Hides two of three states; nothing shows what is available without clicking through; `aria-pressed` stops meaning anything. |
| A third independent-looking toggle | **No as drawn.** `Aa` and `.*` *compose* — case-sensitivity and regex are orthogonal. Path is exclusive with `.*` and makes `Aa` meaningless. Three identical buttons would lie about the structure. |
| A labelled segmented control `Text │ .* │ /` | Honest, but the widest option, and §5 is about to make the bar taller as well. |
| A `/` prefix typed into the input | **No.** R78's finding was that a slash is not a marker, and `/` is an ordinary needle in XML. |

**Chosen: the cheap segmented control.** `.*` unpressed already means "plain text", so the mode
picker exists today as a one-member radio group with an off state. Add `/` as its second member —
at most one pressed, neither pressed means plain text. Group the two visually in one bordered
segment and separate `Aa` by a gap, so the composition rule reads off the layout: *pick one of
these, and independently set that.*

`role="radiogroup"` semantics with an explicit "plain" state, rather than two `aria-pressed`
buttons that happen to be exclusive — a screen reader should hear the exclusivity, not infer it.

`/` as the glyph: it is the palette's own mode prefix, so the two surfaces teach each other, and it
stays inside R71's ASCII rule. `Aa` disables in path mode, the pattern R78 established for the same
reason.

### Path mode does not search as you type

`/garage/` is a parse error halfway through typing `/garage/cars`. Live evaluation would flicker
between errors and zero matches on every keystroke. **Run on Enter in path mode**; keep the 150 ms
debounce for text and regex.

That still delivers the refinement the request is about — edit, Enter, edit, Enter — and the line is
defensible: a path is a query you compose, a needle is a filter you narrow.

The parse diagnostic goes in the **`.find-footnote` row that already exists** (R72 §6/R76). It is
the right shape and it is already in the layout.

---

## 4. R88 — the palette hands off and keeps its preview

Enter on `/garage//name` opens Find with the text in the input and path mode on, instead of
publishing a direct result. The palette becomes a launcher — the same shape `@` already has, where
it finds, hands off and closes.

**Decided: the palette keeps its live preview** (`Enter to show 1,202 matches`) and its grammar
help. The consequence to accept knowingly: `evaluatePathChunked` then has **two call sites** — the
palette's preview and the store's real evaluation. That is not duplication of *logic*, but it is two
places that can drift on debounce, cancellation and error handling. Keep the palette's preview
strictly a preview: it must never publish a result, only count one.

The grammar help stays in the palette because that is the discovery surface — you go there when you
do not remember the syntax. Find is where you already know it and are iterating.

---

## 5. R89 — the input becomes a textarea that grows

**Reverted by R102 (`docs/plans/R102-find-single-line.md`).** The multi-line `<textarea>` this
section describes was asked for, built and polished twice, and never sat right — it made the
Replace field structurally inconsistent (a `<textarea>` and an `<input type="text">` sharing one
CSS class), and the manual-drag follow-up below had to be pulled after landing. The field is back
to `<input type="text">`. **Kept, in the same revert**: the narrow-width fix (§"`.find-input`
narrows from 320px back to 200px" in the Results below) and `Raw.css`'s 3px left-edge current-match
mark — neither was the part that didn't work. R103 covers the one thing the revert genuinely loses
(a pasted multi-line needle silently flattening with no explanation). The section below describes
what R89 built, which is history now, not the field's current shape.

Two asks, one control: paste a two-line string and have the box grow to show it, and be able to
resize it for a long query.

### The search engine already handles multi-line needles — verified, not assumed

This was the risk, and it is not there. Both paths hold up:

- **Byte path.** `findJobFor` chunks at 1 MiB with no overlap, which looks like a match spanning a
  chunk boundary would be lost. It is not: in `findAsciiInRange` the `to` argument bounds only the
  *start* position (`while (i < boundedTo)`), while the comparison reads `bytes[i + j]` up to
  `i + last`, capped by `searchEnd = bytes.length - m`. Chunks therefore partition match **starts**
  with no gap, and a match that begins before a boundary and ends after it is found.
- **Decoded path.** `decodedWindowsFor` gives consecutive windows a deliberate one-row overlap, and
  its own comment names the reason: "the guarantee a match spanning its boundary needs."

**So this is a pure UI change.** The only blocker is that `<input type="text">` cannot hold a
newline at all — pasting multi-line text into one silently flattens it.

### The Enter key, which is the whole design question

In a `<textarea>`, Enter inserts a newline. In the Find bar, Enter is find-next and Shift+Enter is
find-previous (`FindBar.tsx:208-212`). Direct conflict.

**Resolved by looking at what the request actually is: paste, not typing.** Pasting multi-line text
into a textarea inserts the newlines with no keystroke involved, so the main use case does not touch
Enter at all.

- **Enter stays find-next. Shift+Enter stays find-previous.** They are load-bearing and muscle
  memory.
- **Decided: there is no way to type a newline into the field at all.** Not a modifier chord, not a
  fallback — paste is the only way one gets in, which is also what VS Code does. The alternative is
  a chord nobody discovers, documented in a panel nobody opens, for a case nobody hits. This
  *removes* work: no chord to allocate, nothing for R65's panel, and no third meaning for Enter to
  arbitrate.
- Auto-grow, capped at **6 rows**, then scroll inside. See § "Sizing" below — the cap and the drag
  are in tension and the obvious implementation gets it wrong.
- Manual resize via `resize: vertical` on the textarea. A drag handle on the whole bar is more work
  for the same result — do not build one unless the textarea alone proves insufficient.
- **No horizontal resize.** Reasons in § "Sizing".

### Sizing — the height cap, the width bound, and a defect that already exists

**Cap the auto-grow at 6 rows; do not cap the element with CSS `max-height`.** These look like the
same thing and are not: CSS `resize` respects `max-height`, so `max-height: 6lh` would cap the
*drag* too, leaving manual resize able only to shrink. That is the opposite of why it exists.

- Cap the **JS auto-grow** at 6 rows (`height = 'auto'` then `min(scrollHeight, 6 rows)`).
- Set the CSS `max-height` generously — bounded by the layout, not by 6 rows — so a deliberate drag
  can go past the cap when someone wants to see more.

That gives all three behaviours without conflict: paste forty lines and get a 6-row box that
scrolls; drag it taller when you want to read them; never drag it off-screen.

**Measure rows from `scrollHeight`, not from the value's line count.** A single pasted 400-character
line soft-wraps to many visual rows; `rows`/`\n`-counting would report one and clip the rest.
Soft wrap is visual only — it inserts nothing into the value, so the needle is unaffected.

**Auto-grow must yield to a manual drag.** Once the user has resized, stop auto-growing, or the next
keystroke snaps their box back. A flag set from a `resize` observation is enough. This is the
interaction that produces "weird behaviour" if it is left implicit.

**Keep `overflow-y: auto`, do not hide the scrollbar.** It costs nothing, appears only in the capped
case, and is the only cue that there is more above or below. Hiding it is one declaration if it
turns out to be visually intrusive, but that is a change to make after seeing it, not before.

### The width is already bounded correctly — measured

`.find-bar` already carries:

```css
width: max-content;
max-width: calc(100% - var(--space-2) * 2);
```

and `100%` resolves against **`.layout`**, not the viewport (D-080 — the bar anchors there so it can
never slide under Windows' caption buttons). Driven in the built app at shrinking window widths, with
a 5-character needle:

| Window | `.layout` | `.find-bar` | bar's left edge | row content |
|---|---|---|---|---|
| 1400 | 1400 | 514 | 878 | 488 |
| 640 | 640 | 514 | 118 | 488 |
| 520 | 520 | **504** | 8 | 488 |
| 420 | 420 | **404** | 8 | **488** |

So the answer to "what is the maximum width" is the layout width minus two `--space-2` gutters, it is
already enforced, and the bar never leaves the window — its left edge clamps at 8px rather than going
negative.

**No horizontal resize**, for two reasons. A textarea soft-wraps, so width is not the axis a long
query needs — rows are. And browser `resize` sets an *inline width* on the textarea, which would push
`.find-bar-row` past `.find-bar`'s own `max-width`; the row deliberately has no `flex-wrap` (R8e:
"a find bar that reflows under the pointer is worse than one that scrolls or truncates"), so the
controls would spill outside the elevated surface. Which is exactly what already happens —

### The defect this uncovers, which exists today

Below about **530px of layout width** the row's content (488px) no longer fits the clamped bar, and
`.find-bar` sets no `overflow`, so **the controls spill past the surface and out of the window.**
Screenshotted at 420px: the input, count, `Aa` and `.*` are visible, the ↑ is clipped, and **↓ and
the close button are gone entirely — Find cannot be dismissed with the mouse** (Escape still works).

The cause is `.find-input`'s `min-width: 200px`, which never yields: the input measured 200px at
every width from 1400 down to 420.

**This is pre-existing, and R89 and R90 both make it worse** — the origin chip, a third mode button
and a replace row all add content to the same non-wrapping row. Fix it here rather than shipping two
more reasons for it to happen:

- **`min-width: 0` on the textarea, and it is the only shrinkable item in the row.** Everything
  else — count, mode buttons, `Aa`, the three icon buttons — is `flex: none`. The textarea takes
  `flex: 1 1 auto` with a comfortable `flex-basis` and no floor, so it absorbs every pixel of
  shrink before anything else is asked to.
- **That gives a guarantee with a number behind it.** The non-shrinkable controls measured ~288px
  (the 488px row minus the 200px input), plus 26px of bar padding — so **every control stays inside
  the bar down to about 314px of layout width**, at which point the textarea has reached zero. The
  window opens at 900px wide and sets no `minWidth`, so narrower is reachable by dragging; below
  ~314px the row gets `overflow-x: auto` and **scrolls inside its own rounded surface** instead of
  painting outside the window. That is the degradation R8e already sanctioned in this exact file:
  "a find bar that reflows under the pointer is worse than one that scrolls or truncates."
- **The close button is never the thing that disappears** — that is what "buttons are `flex: none`"
  buys, and it is the acceptance criterion worth testing rather than eyeballing.

*Out of scope but worth recording:* `main/index.ts` sets `width: 900` with **no `minWidth`**, so a
three-pane document viewer can be dragged to any width at all. A window minimum would make the
~314px floor unreachable and is worth having independently of Find — not this round's job.

### Two knock-ons

**R80's ring fragments on a multi-line match.** `.cm-np-match-current` is
`box-shadow: inset 0 0 0 1px`, and CodeMirror splits a `Decoration.mark` per line — so a two-line
match draws **two closed rings**, reading as two separate current matches rather than one spanning
match. Check it, and if it reads badly, drop the top border on the first fragment and the bottom on
the last (or fall back to a left bar). Do not discover this after shipping.

**Regex and newlines.** In regex mode `.` does not match a newline without the `s` flag, so a
pattern a user expects to span lines silently will not. Out of scope to fix here; say so in the
Results rather than leaving it to be found.

---

## 6. R90 — Replace

### First, the invariant question — answered

**What invariant 6 protects is a direction of information flow**, not a location. `CONCEPT.md`
§5.1 states it in full:

> Editing happens only in the Raw View. **The text is the single source of truth; the model is a
> derived projection.** […] No serialization path from model back to text exists, so nothing can be
> lost.

Text flows **into** the model. Nothing flows back out. That is what makes comments, key order,
quoting style and whitespace survive "by definition" — and it is why this project has no
lossless-CST subsystem, which §5.1 calls "otherwise the hardest part of the project."

**So the test for any new write is: does it need to generate document text from the model?**

| Operation | Generates text from the model? | Status |
|---|---|---|
| Typing in Raw | No — a byte splice at the caret | the normal path |
| Editing a grid cell | **Yes** | refused by design (`R31-csv-spike.md`: "invariant 6 refuses all three") |
| Format / Minify | **Yes** | the one accepted exception |
| **Replace / Replace All** | **No** | — |

**Format/Minify is the boundary case, and it was already accepted.** `M5-PLAN.md`'s own hard rules
are unusually blunt about it:

> A Transform **is** the generating path, and §5.5's entire point is that the two must not touch.
> After a Transform, Save behaves normally again because the Transform already rewrote the buffer —
> not because Save learned to serialize.

A formatter walks the parsed tree and emits bytes. That is model → text, the exact thing the
invariant forbids, permitted because it is quarantined: it rewrites the *buffer*, and Save stays a
dumb byte write.

**Replace does not even reach that boundary.** Its offsets come from a search over the *bytes*; the
replacement is bytes the user typed; the model is never consulted, before or after. On the substance
it is the same class of operation as typing in Raw — a byte splice — applied at N sites at once and
started from a different surface. It is **more conservative than Transform**, which already ships.

**Recommendation: allowed.** The only thing it strains is the word "only" in "only in the Raw view",
which is geography rather than architecture.

### But the geography is load-bearing in exactly one place

Found by checking rather than assuming, and it is the real cost. `DECISIONS.md`'s "no read-only
badge" decision amends §11.2 on precisely this ground:

> invariant 6 means editing happens only in the Raw view, and `Raw.tsx` already shows a standing
> banner (*"This file is read-only — changes can't be saved here"*) in **the one pane where an edit
> could be attempted at all**. A status-bar copy would just restate it in a place you are not
> editing.

Replace makes that false. The Find bar is a second place an edit can be attempted — and since R70
hoisted it out of `Raw.tsx`, **it is reachable with the Raw pane hidden**, where the read-only banner
is not shown at all. That decision already records this as "the one gap, recorded rather than
hidden"; Replace widens it from an edge case to the ordinary path.

**Decided: learning the file is read-only when you press Replace is acceptable.** No disabled
button, no pre-emptive badge, no new indicator. The refusal must be *clear* — a notification saying
the document is read-only, not a silent no-op — but it arrives on the attempt, not before it.

**The decision entry still has to be amended, and the distinction matters.** Its *outcome* survives
untouched: there is still no read-only badge in the status bar. What is falsified is its *stated
reason* — "the one pane where an edit could be attempted at all" — which stops being true the moment
Replace ships, and which is precisely the sentence a future reader would rely on when deciding
where an indicator belongs. Amend the reasoning, keep the conclusion, in the same commit as R90.

### The question I had conflated with the invariant

Worth separating, because it is the one that actually deserves care. Replace All **edits regions of
the document the user cannot see**, at scale, in one action — and above the size threshold it may
skip the undo entry entirely, exactly as Transform does. That is not an architecture question; it is
a safety question, and it is what the confirmation dialog is for. Design it with the care §11.2 gave
the export soft-cap: a number in it, and a plain statement when undo will not be available.

### The machinery already exists

`UndoEntry` (`session/undoStack.ts:45`) holds:

```ts
readonly patches: readonly Patch[]
readonly inverses: readonly Patch[]   // "walking this array back to front"
```

An array of patches with inverses, undone back-to-front. Built for edit bursts — but that *is* a
replace-all. Nothing new needs inventing; it needs a batched entry point.

- **Apply back to front.** Each splice shifts every later offset. Descending order keeps the match
  offsets valid without recomputing a single one.
- **One undo entry and one reparse**, not N. `applyEdit` is one splice per call; Replace All needs a
  batched sibling, or the burst-coalescing has to be driven explicitly.

### Three gates, two of which already exist

- **Encoding.** `encodeForRoundTrip` refuses every encoding except UTF-8 and UTF-16 LE/BE — its own
  header says documents in legacy code pages "are currently read-only in practice regardless of
  `readOnly`." **So Replace is unavailable on a windows-1252 document.** That is pre-existing and
  consistent with typing in Raw, not a new limitation, but it must produce a clear refusal rather
  than a silent no-op.
- **Read-only.** `EditRefusal` already has `{ kind: 'read-only' }`.
- **Size — two thresholds, both reusing what exists.** A replace-all builds an undo entry holding
  the original bytes of every match, so cost scales with match *count* as well as replaced bytes.
  - **Confirm above 50,000 matches**, mirroring `GRID_EXPORT_CONFIRM_ROWS = 50_000` — the same
    "this many discrete items in one action" shape, so the number does not need inventing or
    defending separately. §11.2's rule applies: a confirmation with a number in it, never a refusal.
  - **Do not invent a second undo threshold.** `computeUndoStats` already tracks the stack's
    footprint against the memory budget (M5f §3a). If the entry would exceed it, drop the entry and
    **say so in the confirmation** — "this cannot be undone" — rather than discovering it afterwards.
    `applyTransform`'s own 50 MB skip is the precedent for dropping the entry; what it does not have,
    and this does need, is telling the user first.

### The row

A disclosure control on the left of the bar expands a second row: replace input, `Replace`,
`Replace All`. Collapsed by default; `Ctrl+H` is the conventional chord for opening Find with it
already expanded.

**Replace is hidden in path mode**, not merely disabled — a path result is a set of node spans, and
"replace every `<name>` element with this text" is a different and much larger feature than
replacing matched text. Say so in the Results so it is not read as an oversight.

**Regex capture groups (`$1`) in the replacement are out of scope for R90.** They are the natural
next ask, and they need a decision about escaping and about what `$` means in a literal replacement.
Land literal replacement first.

---

## 7. Order matters here, because three tasks rewrite the same layout

R87 adds a button, R89 makes the bar two-dimensional, R90 adds a row. Done in the wrong order that
is three separate rewrites of `.find-bar-row`.

**Do the layout once, in R89**, restructuring the bar into a grid that already has room for a second
row and a growing first cell — then R90 fills the row in. R87's button is small enough to land
before or after either.

R86 → R88 must be in that order regardless: `setDirectResult` cannot retire until the palette stops
calling it.

---

## Definition of done

- [x] R86 — `SearchQuery` carries a mode; path queries run through `findJobFor` and **re-run after
      an edit** instead of going permanently stale. `src/core/types.ts` untouched. The 21
      `setDirectResult` assertions in `test/searchStore.test.ts` are converted, not deleted.
- [x] R87 — `.*` and `/` are one exclusive group with a plain-text off state, `Aa` visibly separate
      and disabled in path mode. Path mode runs on Enter; parse errors render in the existing
      footnote row.
- [x] R88 — the palette's `/` hands off to Find prefilled, keeps its live preview and grammar help,
      and never publishes a result. `setDirectResult`, `hasDirectResult`, `getDirectResultOrigin`
      and the origin chip are gone.
- [x] R89 — a pasted multi-line string searches correctly and the box grows to show it; Enter still
      finds next; there is no way to type a newline (paste only). **The multi-line ring is
      looked at**, and what it does is recorded either way.
- [x] R89 — auto-grow caps at 6 rows measured from `scrollHeight`; a manual drag can exceed the cap;
      auto-grow stops once the user has dragged. No horizontal resize.
- [x] R89 — **the close button is reachable at every window width the app allows**, asserted by a
      test that shrinks the layout rather than by eye. It is not today: below ~530px the row
      overflows the bar and ↓ and ✕ leave the window entirely.
- [x] R90 — Replace and Replace All work as one undo entry applied back-to-front, refuse clearly on
      legacy encodings and read-only documents, and confirm above **50,000 matches**. When the undo
      entry would exceed the memory budget `computeUndoStats` already tracks, the confirmation says
      so before the user commits — not afterwards.
- [x] R90 — a Replace on a read-only document produces a **clear refusal**, not a silent no-op.
      No pre-emptive indicator (decided). `DECISIONS.md`'s "no read-only badge" entry keeps its
      conclusion and has its *reasoning* amended in the same commit, since "the one pane where an
      edit could be attempted at all" stops being true.
- [x] R90 — Replace is hidden in path mode, and the Results say that is deliberate.

---

## Results

Landed as planned, in the order §7 specified (R86 → R87/R88 in that forced order, R89's layout
rewrite done once, R90 filling the row it left room for). Two things owed, both disclosed rather
than discovered later — see `docs/TASKS.md`'s Owed table for the one-line versions.

**R86.** `SearchQuery` gained `mode: 'text' | 'path'`; `findJobFor` branches into `pathJobFor`,
which parses fresh against the live store on every call (never cached — the whole point) and
adapts `evaluatePathChunked`'s node list into the same ascending-span `MatchSet` shape a text scan
produces. A parse failure surfaces through a new `getPathDiagnostic()` rather than being folded
into `SearchResult`, so `FindBar`'s footnote row can render it without a second result shape.
`src/core/types.ts` untouched, confirmed. `setDirectResult`/`getDirectResultOrigin` stayed alive
through this round (R88 retires them) — `search()`/`clear()`/the document-switch handler all gained
one extra reset line rather than being restructured, which is the whole reason the retirement was
deferred a round rather than done here.

**R87.** The mode control is `role="radiogroup"` wrapping two `role="radio"` buttons (`.*`, `/`) in
one bordered `.find-mode-group`, `Aa` a separate `.find-toggle` outside it. Path mode runs only on
Enter — typing updates local state without touching the store — and switching *into* path mode
cancels any debounce still pending from a text/regex search that was mid-flight, found in this
round's own review (§"Review found and fixed" in the R87 commit): left running, that debounce would
have fired a stale `mode: 'text'` search after the switch and silently overwritten whatever the
next Enter produced.

**R88.** `findStore.ts` gained `openFindWithQuery`/`consumeFindPrefill`, mirroring
`paletteStore.ts`'s own `pendingInitialQuery` shape. `Palette.tsx`'s `runPathQuery` shrank from a
20-line function building `SearchResult` arrays and calling `setDirectResult`/`openFind`/
`setCurrentMatchIndex`/`navigateToNode` to three lines: hand off and close. The auto-select-first-match
behaviour R79 already built for text search covers path mode for free once it goes through the same
`search()` call — no second "jump to the first match" implementation exists. `setDirectResult`,
`getDirectResultOrigin`, `hasDirectResult` and the `.find-origin` chip are gone from `searchStore.ts`,
`activeSearchStore.ts`, `FindBar.tsx` and `Find.css`. `test/searchStore.test.ts`'s 21
`setDirectResult`/`getDirectResultOrigin` references (confirmed by counting the pre-R86 file, not
estimated) were converted rather than dropped: the supersession and clearing assertions they made
already had path-mode equivalents from R86, plus one new case added for "a fresh query of either
mode supersedes a path query in flight." `test/findBarOrigin.test.tsx`
(entirely about the retired chip) was deleted; its coverage lives in `test/findPathMode.test.tsx`
and a new palette-handoff test in `test/palettePathQuery.test.tsx`.

**R89.** The textarea auto-grows via a measure-then-set (`height: 'auto'`, read `scrollHeight`, set
`min(scrollHeight, lineHeight × 6)px`) pattern, capped in JS rather than CSS `max-height` as
specified. Manual-resize detection went through two iterations, the first of which review caught
before commit: comparing the `ResizeObserver`'s reported height against the height `autoGrow` last
set (pixel equality) false-positived in this environment — the height `autoGrow` computes
immediately after mount measurably differs from what renders a moment later (font metrics settling,
observed directly, cause not chased further), which read as "already manually resized" before any
drag happened and disabled auto-grow permanently from the first keystroke. Replaced with a
suppress-flag the observer's callback clears on its very next firing regardless of the reported
height, which has no pixel comparison for anything to race. A second review finding, also fixed
before commit: `<FindBar>` itself never unmounts (it renders `null` while closed) but its
`<textarea>` does, so both the auto-grow effect and the `ResizeObserver` needed `findState.isOpen`
in their own dependency arrays, not `[text]`/`[]` alone — otherwise a close-then-reopen left the
observer watching a detached node and the fresh textarea un-measured until the next real keystroke.
Both bugs are covered by `test/findAutoGrow.test.tsx`, including a dedicated close/reopen case that
fails against the pre-fix code. The pre-existing width defect (below ~530px the row painted outside
the bar and the window, close button included) is fixed the way §5 specified — `.find-input` the
row's only shrinkable item, everything else `flex: none`, `.find-bar-row` gains `overflow-x: auto`
as the fallback below ~314px — and asserted geometrically in `test/r8Layout.test.tsx` at 420px
(the screenshot width), 530px (should not scroll) and 314px (the measured floor).

**The multi-line ring, owed.** R80's `box-shadow: inset 0 0 0 1px` on `.cm-np-match-current` became
`inset 3px 0 0 0` — a left edge instead of a full ring, matching R57's own "severity as a 3px left
edge" language rather than inventing a second vocabulary. This is reasoned correctly from the
decoration code (CodeMirror splits a `Decoration.mark` per line, each fragment gets the class
independently, and a left edge reads as one continuous mark across fragments where a closed ring
reads as separate boxes) but **not screenshot-verified** — no running Electron instance was
available in this environment to actually render a multi-line match and look at it, and this is
disclosed rather than silently assumed correct, the way `docs/plans/R43-grid-sizing-and-scroll.md`'s
own R46 entry discloses an unmeasured frame time for the same reason. Regex `.` not matching a
newline without the `s` flag is a real, separate, pre-existing limit — out of scope per §5's own
text, recorded here rather than left to be found.

**R90.** `applyReplaceAll` landed as specified: one undo entry, patches applied back-to-front,
`estimateReplaceAllUndoBytes` (a pure function, `documentEdits.ts`) shared between the caller's
pre-confirmation preview and the session's own re-check so the two can never disagree about whether
an entry will fit. One gap review found before commit: the function documented that `matches` must
arrive ascending (true of every real caller, since `SearchResult.starts` always is) but never
enforced it — a caller that didn't would have had its patches silently misapplied once reversed for
back-to-front application. Now sorts internally rather than trusting the contract. The
confirm-above-50,000-matches gate and the undo-budget-drop gate share one `notify()` call with two
independently-composed message clauses, exercised in `test/findReplace.test.tsx` via the
undo-budget path (small match counts, an oversized replacement) rather than the match-count path.

**The 50,000-match threshold itself, owed.** Constructing 50,001 real matches in a test document
and driving `Replace All` through it was judged not worth the fixture cost for what is, in the code,
the same `notify()` call and the same confirm/cancel command pair the undo-budget path already
exercises end-to-end — the two conditions are one `||` apart in `handleReplaceAllClick`. Recorded as
untested-at-the-literal-threshold rather than assumed equivalent to the tested branch.

Capture groups (`$1`) in the replacement remain out of scope, as planned — the next natural ask,
needing its own decision about escaping.

**Post-landing polish, from direct use of the shipped bar.** Four small corrections, filed against
the rounds they touch rather than as a new one:

- **R89.** `.find-input` narrows from 320px back to 200px — the pre-R89 field had no explicit
  `width`, but `min-width: 200px` governed it at every size measured, so 200px is what "the same
  width as before" actually means once the bar's own extra controls are accounted for separately.
  The textarea's scrollbar is hidden (`scrollbar-width: none` plus the `-webkit-` pseudo-element,
  since Chromium/Electron honors only the latter) — `overflow-y` stays `auto`, so content past the
  6-row cap still scrolls, it just isn't painted.
- **R90.** Replace and Replace All became icon buttons (`arrow-swap`, `arrow-repeat-all`, both
  already-vendored Fluent icons) instead of text labels — narrower, and the pairing reads as "one"
  vs. "every one of these" the same way icons already do elsewhere in the app. The replace row now
  sits directly under the find row at the same width, its input aligned under the find textarea:
  `find-replace-spacer` reserves the width the disclosure button occupies on the row above, and
  `find-replace-input` drops `flex-grow` (`flex: 0 1 200px`, not `1 1 auto`) so it doesn't stretch
  past the field it sits below just because its own row has fewer competing buttons — letting it
  grow was the first thing tried, and it visibly didn't match, so this is asserted geometrically in
  `test/findReplace.test.tsx` rather than assumed. `find-replace-disclosure` narrows to a tight
  22px icon-only button now that it's the only unlabeled control competing for bar width.
- **R89.** The CSS `resize: vertical` handle is gone (`resize: none`); the field's height now
  tracks only `autoGrow`'s own measurement of the text in it. A manual drag and the next
  keystroke's auto-grow disagreed about what height was correct — the drag pinned a height
  `autoGrow` would then leave alone even after the text that justified the drag was gone, so the
  box could end up stuck tall (or short) relative to what it actually held. `manualResizedRef`,
  `suppressNextResizeRef` and the `ResizeObserver` effect that supported the override are removed
  along with it — `FindBar.tsx`'s `autoGrow` goes back to the simple form: measure, clamp at 6
  rows, set. `test/findAutoGrow.test.tsx`'s two manual-resize tests are replaced with one asserting
  `resize: none` and one confirming a fresh open still auto-grows correctly.

One thing learned doing this: both new geometry tests initially failed for a reason unrelated to
the CSS itself — `.find-bar`'s `max-width` is a percentage of its positioned ancestor (`.layout` in
the real app, D-080), and a bare test container with no positioned wrapper resolves that far too
narrow, squeezing the shrinkable textarea down to a few px and producing numbers that looked like
real bugs until `test/r8Layout.test.tsx`'s own wide-positioned-wrapper pattern was applied to both.
