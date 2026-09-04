# R78–R81 — what the Find bar says after a path query, and what the highlight costs to read

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Three reports against R72–R76 as built, from the person who
asked for it. All three are confirmed, one of them measurably worse than reported, and they share a
cause: R74 wired the *state* through and stopped at the surface. §2 was then widened on request to
cover plain text search as well, which turns out not to be the same one-line fix. Related:
`docs/plans/R72-path-query.md` (R74's own Results) and `docs/plans/R60-dark-elevation.md`, which
reached §3's conclusion from the other direction.

Answers first.

---

## 1. R74 landed half of its own option 1

The report: *"I see the text being entered as a regular search string"*, not as read-only path text.

**Correct, and the code says so plainly.** `FindBar.tsx:61` holds `text` in ordinary component
state; the origin sync at `FindBar.tsx:74-81` calls `setText(directResultOrigin)` into that same
state. The input at `FindBar.tsx:228` carries no `readOnly`, no distinct class, no styling. What
the user sees after running `/garage//name` is a normal input containing the characters
`/garage//name` — which is exactly what they would see had they typed those characters as a needle.

R74's Results defends this, and the defence is half right:

> read-write, not read-only, so typing over it is the escape into an ordinary text search

**The plan asked for two things and this argument disposes of only one.** Option 1 was "read-only
text, **prefixed to show it is a path**". Read-only and "typing replaces it" do genuinely
contradict each other, so dropping `readOnly` was a reasonable call. But nothing was put in place
of the prefix: the implementation treats the query's own leading slash — passed as the template
`` `/${query}` `` at `Palette.tsx:357` — *as* the prefix. A slash is not a marker. It is a
character you can also type into Find, and searching for a literal `/` is an ordinary thing to do
in XML.

### The defect nobody looked for: two buttons that silently destroy the result

Worse than cosmetic, and reachable in one click. `handleCaseSensitiveChange` and
`handleRegexChange` (`FindBar.tsx:154-162`) both call `runSearch(text, …)`, and `runSearch` calls
`activeSearchStore.search()`, whose **first two statements** are:

```ts
function search(query: SearchQuery): void {
  hasDirectResult = false
  directResultOrigin = null
```

So after a path query returning 1,202 structural matches, clicking `Aa` or `.*` runs a **text**
search for the literal string `/garage//name`, finds nothing, and replaces the live result with
`No matches`. No warning, no undo, and the origin that would have told you what you just lost is
cleared in the same breath.

Those two toggles are also *meaningless* for a direct result: case sensitivity and regex are
properties of a byte search, and a path query is evaluated against the node model. They cannot
affect it. They can only end it.

### R78 — take the origin out of the input

The contradiction the implementer had to resolve dissolves once the origin stops living in the
field you type into.

- Render the origin as a **non-editable chip** in the bar — `.find-origin`, `--font-mono`, labelled
  as a path (`path /garage//name`), with a dismiss control calling `activeSearchStore.clear()`.
- Leave the input **empty and focused**. Typing is then an ordinary text search because it *is*
  one — no override, no first-keystroke special case, and no effect racing a keystroke. The sync
  effect and `lastSyncedOriginRef` (`FindBar.tsx:73-81`) exist only to win that race and go away
  with it.
- **Disable `Aa` and `.*` while `directResultOrigin !== null`**, with a `title` saying why. A
  control whose only reachable effect is to discard the result should not be live.

This satisfies both halves of option 1 — it is visibly a path, and the escape is still "just type"
— and it keeps the plan's stated reason for preferring option 1 over option 2 ("what would I edit
to change this"): the chip is the thing you dismiss, the input is the thing you type in.

No literal colours (invariant 9). The chip is an existing surface token, not a new hue.

---

## 2. R79 — "0 of 1" is true, and it should not be — for either kind of search

The report: *"it doesn't jump to that but says 0 of 1"*, expecting `1 of N`.

**It does jump. It just never says so.** `runPathQuery` (`Palette.tsx:349-360`) does three things
and omits a fourth:

```ts
activeSearchStore.setDirectResult({ starts, ends }, `/${query}`)
openFind()
navigateToNode(readyDocument.store, order[0]!.node, paneForPaletteJump('pathQuery'))
```

`navigateToNode` moves the selection and the caret to the first match. Nothing calls
`setCurrentMatchIndex(0)`, so `findState.currentIndex` stays `null`, and `FindBar.tsx:218` reads

```ts
const currentDisplay = findState.currentIndex !== null ? findState.currentIndex + 1 : 0
```

→ `0`. The app is sitting on match 1 and reporting that it is on no match at all.

**Two further consequences follow from the same omission**, neither reported, both worse than the
label:

- **Raw draws no current match.** `matchDecorations.ts:73` assigns the current class by
  `current: i === currentIndex`; with `currentIndex === null` nothing matches, so every hit renders
  in the dim fill and *the one you were taken to is not distinguished from the other 1,201*. The
  jump happens and the destination is unmarked.
- **The first `F3` stands still.** `nextMatchIndex(starts, null, caretOffset)` falls through to
  `matchIndexAtOrAfter(starts, caret)`, and the caret is already `starts[0]`, so `lowerBound`
  returns `0` — the first press of Next re-lands on the match you are already on. Next appears
  broken exactly once, then works.

**For the path query the fix is one line**: `setCurrentMatchIndex(0)` after `openFind()`.
`FindBar`'s clamp effect (`FindBar.tsx:105-109`) resets the index only when
`currentIndex >= result.starts.length`, and `runPathQuery` returns early on `nodes.length === 0`,
so index `0` is always in range. The text-search half below is not one line.

### This was seen during R74 and read as normal

`test/findBarOrigin.test.tsx:69-71` says so:

> `setDirectResult` publishes the result but doesn't itself pick a "current" match (that's
> `moveTo`'s job, driven by next/previous) — this asserts the total, not which of the 2 is current.

and R74's own review note records the assertion being narrowed from `"1 of 2"` to `"of 2"` for that
reason. It is an accurate description of what the code does and a wrong conclusion about whether it
should: §1 of `docs/plans/R72-path-query.md` already claimed Enter "jumps to the first", and the
test was changed to fit the code rather than the code to fit the plan. **Tighten the assertion back
to `1 of 2`** as part of this task. It is `CLAUDE.md`'s "tests asserting shape but not exact
values" in its exact form.

### A plain text search has the same gap, and it is a bigger change

Confirmed and now in scope. `runSearch` (`FindBar.tsx:141-147`) opens with
`setCurrentMatchIndex(null)` on every keystroke, so a text search reads `0 of 145` until you press
`F3`, Raw marks no current match, and nothing happens to the view at all until you do. The
destination the first `F3` picks is already the right one — the difference is that it should not
take a keypress to get there.

It is **not** the same fix, for four reasons found by reading the paths involved:

**a. The result is asynchronous.** `search()` starts a chunked job (`findJobFor`) and publishes
exactly once, on completion — `runSearch` in `searchStore.ts` sets `complete: false` up front and
the real result in the `.then`. There is no partial result to select into (`provisional` is
documented as "always `false` in M4 — nothing sets it yet"), which is the good news: exactly one
moment to react to. But the selection cannot happen where the search is *requested*; it has to
happen where the result *lands*.

**b. An edit-driven re-run must not jump.** `searchStore`'s own session subscription re-runs the
active query whenever `document.store` changes — that is, after every debounced reparse while you
are editing in Raw. A naive "select index 0 whenever a complete result arrives" would **yank the
caret out from under someone typing**, on a timer, repeatedly. This is the one way to get this
change badly wrong and it is not hypothetical: `rawEdit.ts:192` calls `session.setCaretOffset` on
every edit, and `Raw.tsx:584-590` re-anchors the CodeMirror window on any `caretOffset` change.

The distinction is available without new plumbing: only `FindBar` itself initiates a user-driven
search. Set a `pendingAutoSelectRef` immediately before `activeSearchStore.search(...)` inside
`runSearch`'s debounce callback, and **consume** it in the effect that observes the completed
result. An edit-driven re-run never sets it. Toggling `Aa`/`.*` goes through `runSearch`, so it
does re-select — which is right; that is a user asking a new question.

**c. The caret is not a stable anchor.** Selecting a match calls `moveTo`, which sets the caret to
that match. So on the next keystroke the "where am I searching from" reference has already moved to
wherever the previous keystroke landed, and backspacing never returns you to where you started.
Capture an explicit **anchor offset** instead — recorded when Find opens and whenever the query goes
empty — and select `matchIndexAtOrAfter(starts, anchor)`. That helper already exists and `goNext`
already uses it for exactly this "search just started" case; this makes the case explicit rather
than reachable only by pressing `F3`.

*Optional refinement, not required:* refresh the anchor when the caret moves for a reason that was
not `moveTo` (compare against the last offset `moveTo` itself wrote). That is what makes clicking
into Raw mid-search re-anchor the way an editor's find does. Four lines, and it can wait.

**d. The clamp effect will fight it.** `FindBar.tsx:105-109` resets `currentIndex` to `null` when
the new result is shorter than the old index. Both it and any new auto-select effect key on
`result`, so as written they would both fire on the same change and the order would decide the
outcome. **Fold them into one effect** — "a new result arrived: pick the index it should have" —
rather than adding a second that has to win a race.

### What it reads — decided: caret-anchored

**Settled: the count is anchored at the caret, not pinned to match 1.** So the display is *"the
first match at or after where you were", of N* — `1 of 145` from a freshly opened document, whose
caret is at 0, and `37 of 145` from a caret already deep in a large file, jumping forward rather
than throwing the reader back to the top.

This is what `F3` already resolves to today from a null index (`nextMatchIndex`'s own
"search just started" branch), so the auto-select is making an existing behaviour visible without a
keypress rather than introducing a second rule. It is also what VS Code and browser find do.

The consequence to accept deliberately: **`1 of N` is not guaranteed**, and a test asserting it must
place the caret at 0 to mean anything. Assert both cases — caret at 0 giving `1 of N`, and a caret
past the first match giving the right non-1 index — or the anchor is untested and the next person
"fixes" it back to zero.

### Two things this deliberately does not merge

`runPathQuery` keeps its own `setCurrentMatchIndex(0)` rather than routing through the new effect.
It selects `order[0]` specifically — the document's first matching node, which is where it already
navigated — not a caret-anchored match, and it is a direct result with no job to wait for. The two
look like duplication and are not.

And the auto-select moves the **selected node** as well as the caret (`moveTo` calls
`setSelectedNode`), so the Tree and Detail follow along on every debounced keystroke. That is
already true of every `F3` press, but doing it per keystroke is a wider blast radius — **measure it
on a large fixture** before calling this done, rather than assuming the 150 ms debounce absorbs it.

---

## 3. R80 — the current-match fill cannot be fixed by choosing a better yellow

The report: the dim yellow is fine; the one you get on Next is "very intense" and makes the text
hard to read.

**Understated.** Contrast of every syntax foreground over each match fill, computed from the
tokens, dark theme:

| Foreground | on `--surface-bg` | on `--find-match-bg` | on `--find-match-current-bg` |
|---|---|---|---|
| `--syntax-comment` gray-500 | 4.20 | 3.14 | **1.04** |
| `--syntax-number` purple-400 | 5.58 | 4.18 | **1.28** |
| `--syntax-tag-name` blue-400 | 5.67 | 4.25 | **1.30** |
| `--syntax-punctuation` gray-400 | 7.05 | 5.28 | **1.61** |
| `--syntax-keyword` blue-300 | 8.04 | 6.02 | **1.84** |
| `--syntax-attr-name` green-400 | 8.10 | 6.06 | **1.85** |
| `--syntax-string` amber-400 | 10.16 | 7.61 | **2.32** |
| `--surface-fg` gray-100 | 15.44 | 11.56 | **3.53** |

`--find-match-current-bg` is `--amber-600` `#a8730f`. A comment inside the current match sits at
**1.04:1** — not "hard to read", *gone*. Nothing in that column clears 3:1, the bar this codebase
already holds itself to twice (R33/D-051 scrollbars, R57 notification edges). Light is the same
defect, less extreme: `--amber-400` gives 2.32–2.82 for the syntax colours.

The dim fill is fine and the report is right about it: 3.14–11.56, all past 3:1. **Only the current
fill is broken**, which is why the difference between them is what got noticed.

### Why this is not a token tweak

Interpolating the dark current fill back toward the dim one, minimum contrast across all eight
foregrounds:

| | `#3d2c0c` (dim) | `#48330c` | `#523a0d` | `#5d410d` | … | `#a8730f` (today) |
|---|---|---|---|---|---|---|
| min contrast | 3.14 | **2.80** | 2.49 | 2.20 | | 1.04 |
| distinct from dim | 1.00 | 1.12 | 1.26 | 1.43 | | 3.28 |

**Ten percent of the way is already below 3:1.** The dim fill has 0.14 of headroom above the bar,
so the budget for "make it brighter" is zero. There is no value that is both legible and visibly
different — *the current-match signal cannot be a fill at all.*

That is `docs/plans/R60-dark-elevation.md`'s conclusion reached from the other direction: a bigger
background step could not carry "elevated" either, and the answer was a border. Same answer here.

- `.cm-np-match-current` keeps `--find-match-bg` and gains a ring:
  `box-shadow: inset 0 0 0 1px var(--find-match-current-border)`. **Inset, not `outline` or
  `border`** — Raw is a virtualized CodeMirror window and the current match must not change line
  height or reflow the window it is drawn in.
- `--find-match-current-border`: `--amber-400` dark, `--amber-600` light. Against their own fills
  that is **7.61:1** and **3.41:1** — the ring becomes the strongest thing on screen and costs the
  text nothing.

### And the token means three different things today

Found while tracing its four uses. `--find-match-current-bg` is a *background under text* in
`Raw.css:161` and a *marker colour that never touches text* everywhere else — and in those three
places it does not mean "current" either:

| Use | What it actually marks |
|---|---|
| `Raw.css:161` | the current match, as a fill |
| `Tree.css:55` | `.tree-row-matched` — **any** matched row, a 3px bar |
| `Grid.css:381` | `.grid-row-matched` — **any** matched row, a 3px bar |
| `Scrubber.css:79` | `.scrubber-marker-match` — **all** bucketed hits |

One token, two incompatible jobs, and a name that is wrong in three of the four places. That is how
it drifted to an illegible value without anyone noticing: it was chosen to work as a marker bar,
where it does work. Split it —

- `--find-match-bg` — fill for every match. Unchanged.
- `--find-match-current-border` — new, the ring. Raw only.
- `--find-match-marker` — new, Tree/Grid/Scrubber. **Keeps today's exact values** (`--amber-600`
  dark, `--amber-400` light), so this half is a pure rename: no visual change, no new contrast
  question.
- `--find-match-current-bg` — retired.

Four component references and four token definitions, all listed above; nothing else in the repo
names it. `test/themeTokens.test.ts` enforces name parity, so both themes change together. Amend
`CONCEPT.md` §9 and record the split in `docs/DECISIONS.md`.

---

## 4. R81 — the guard

§3's table shipped and nobody saw it, because "looks right" was the only check there was.
`test/scrollbarContrast.test.tsx` exists for that reason and its own header says so:
*"This is a contrast bug ('looks right' is not acceptance …)"*.

`test/findMatchContrast.test.tsx`, modelled on it: mount Raw's match classes under each theme, read
`getComputedStyle`, and assert **every** `--syntax-*` foreground and `--surface-fg` clears **3:1**
over `--find-match-bg` and over the current-match fill, in both themes — plus the ring's own ≥3:1
against the fill it sits in.

3:1 rather than 4.5:1, and the reason is measured rather than preferred: `--syntax-comment` on the
*plain* surface is already 4.20 dark / 4.10 light, so a 4.5 bar would fail the unhighlighted
editor, which is not what this round is about. 3:1 is what R33 and R57 both used.

**Verify it fails before trusting it** — restore `--amber-600` as the current fill, watch it go
red, put it back. `test/docsStatus.test.ts` was accepted on that basis; the automated status check
before it was not, and was wrong 80% of the time.

---

## Definition of done

- [x] R78 — the origin renders as a non-editable chip; the input is empty and focused; typing
      starts a text search; `Aa`/`.*` are disabled while a direct result is live. The sync effect
      and `lastSyncedOriginRef` are gone.
- [x] R79 (path) — a path query reads `1 of N`, Raw marks the match it jumped to, and the first `F3`
      advances. `test/findBarOrigin.test.tsx`'s assertion is tightened back to `1 of 2`.
- [x] R79 (text) — a plain text search selects a match when its result lands: the count reads
      `1 of 145` from a document-start caret, Raw marks it, and the view jumps to it — **and the
      correct non-1 index from a caret past the first match**, which is what proves the anchor.
- [x] R79 (text) — **an edit-driven re-run does not move the caret or the selection.** The regression
      guard that matters most here; assert it explicitly rather than by absence.
- [x] R79 (text) — measured on a large fixture: per-keystroke `moveTo` (caret + selected node, so Tree
      and Detail follow) does not make typing in Find feel worse than it does today.
- [x] R80 — `--find-match-current-bg` is split three ways; the current match is a ring, not a
      brighter fill; Tree/Grid/Scrubber are visually unchanged. `CONCEPT.md` §9 and
      `docs/DECISIONS.md` updated in the same commit.
- [x] R81 — `test/findMatchContrast.test.tsx` passes, and was seen to fail against the old value.

---

## Results

**Built as specified**, with one real defect found along the way (below).

**R78.** `FindBar.tsx`'s sync effect and `lastSyncedOriginRef` are gone. The origin renders as a
`.find-origin` chip (`Find.css`) with its own dismiss button calling `activeSearchStore.clear()`;
the input is plain local state, always empty until typed into. `Aa`/`.*` carry `disabled` and an
explanatory `title` while `directResultOrigin !== null`.

**R79.** `Palette.tsx`'s `runPathQuery` now calls `setCurrentMatchIndex(0)` right after
`setDirectResult`/`openFind`. For text search, `FindBar` gained an anchor ref (captured when Find
opens and whenever the query goes empty), a `pendingAutoSelectRef` set only by its own
`runSearch` debounce (never by an edit-driven re-run), and one effect — folding the old clamp
logic and the new auto-select into a single reaction to `result` — that selects
`matchIndexAtOrAfter(starts, anchor)` once a *complete* result lands with a pending flag set.

**A real bug came out of writing the edit-driven-re-run guard test, not out of reading the code**:
gating the fold on `result.complete` was necessary, not incidental. `searchStore.ts`'s `runSearch`
publishes an *incomplete, empty* result the instant any re-run starts — including an edit-driven
one whose real result will turn out unchanged — and the pre-existing clamp effect reacted to that
transient empty array by nulling `currentIndex` on every single edit, with nothing to restore it
afterward (an edit-driven re-run has no pending auto-select). Caught by
`test/findAutoSelect.test.tsx`'s "an edit-driven re-run does not move the caret or the selection"
before it shipped, once the fold made the effect fire on a wider set of `result` transitions than
before and the transient state started mattering.

**The large-fixture measurement**: a synthetic 30 MB / 1,000,000-match XML document, real parse
through `runParseJob`, real `createSearchStore`. `moveTo`'s own cost (`nodeContainingOffset` +
`setSelectedNode` + `setCaretOffset`) sampled at 20 points spread across the match array: p50
0.007 ms, p90 0.019 ms, max 0.290 ms (one outlier, plausibly a GC pause) — three orders of
magnitude under the 150 ms debounce. Not measured: Tree/Detail's own React re-render cost from
`setSelectedNode`, which this round does not change — it is the same cost `F3` already pays on
every press today, not new blast radius from making it automatic.

**R80/R81.** `--find-match-current-bg` retired; `--find-match-bg` (fill, unchanged),
`--find-match-current-border` (new, the ring, Raw only) and `--find-match-marker` (new,
Tree/Grid/Scrubber, pure rename of the prior values) take its place in both theme files.
`Raw.css`'s `.cm-np-match-current` keeps the shared fill and gains
`box-shadow: inset 0 0 0 1px var(--find-match-current-border)`. `CONCEPT.md` §9.3 and
`docs/DECISIONS.md` (D-083) record the decision. `test/findMatchContrast.test.tsx` asserts every
syntax foreground and `--surface-fg` clear 3:1 over the fill, and the ring clears 3:1 against the
fill, in both themes — verified failing first by temporarily restoring the old fill value.

**Tests**: `test/findBarOrigin.test.tsx` (rewritten for the chip/no-sync-effect shape, `1 of 2`
tightened back, a new disabled-toggles case), `test/findAutoSelect.test.tsx` (new — the three
text-search auto-select cases plus the edit-driven-no-jump guard), `test/findMatchContrast.test.tsx`
(new, R81). Full suite green except three pre-existing failures unrelated to this round (an
`afterAll` hook timeout in `mainElectron.test.ts`, a flaky `documentSession.test.ts` case that
passes in isolation, and a `jsonParser.test.ts` timeout) — none touch Find, the palette, or the
changed theme tokens.
