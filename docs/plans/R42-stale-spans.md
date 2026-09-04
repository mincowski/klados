# R42 — the ~270 ms window where every view reads stale spans

<!-- status: built -->

**Built — the addendum is built too.** Register: `docs/TASKS.md`. Decision: `docs/DECISIONS.md`
D-070.

R41 stopped the `EditorView` being rebuilt on every reparse, which fixed the caret being destroyed.
This is the *other* half of what typing in Raw looks like, and it is a different mechanism: between
an edit landing in the buffer and the debounced reparse producing a new store, **the source buffer
is current and every stored span is not.**

The project lead's own description of it is exact and worth keeping as the specification:

> "when having the text `abcdef` and add after the first letter, I'll see `axxxbc` before the entire
> string `axxxbcdef` is shown."

---

## 1. This is a documented gap whose stated reason has just expired

`documentSession.ts`'s `applyEdit` says so in full:

> Still not done here, and still deliberately: F2's pending-delta list (`core/deltaList.ts`) is not
> wired into any UI read path. Between this call returning and the debounced reparse landing […]
> `document.store`/`rowIndex`/`lineIndex` are the *previous* parse's — genuinely stale, not just
> eventually-consistent — against the buffer this call just changed, so a span read in that window
> (Tree row rendering, Grid cells, Raw decorations) can point at the wrong bytes if the edit shifted
> anything. […] **Flagged, not fixed — the debounce window this describes is short (~200 ms) and
> this has not been reported as a visible problem in practice.**

`subtreeSplice.ts` records the same thing from the other side — "wiring `shiftedOffset` into every UI
read path (Tree rows, grid cells, Raw decorations) […] is real, cross-cutting scope."

The gap was correctly identified, correctly scoped, and parked on one condition: that nobody could
see it. **That condition no longer holds.** Nothing about the analysis was wrong; only the premise
changed.

---

## 2. Measured

`cars-small.xml`, caret placed after `Foc` in `<name>Focus</name>`, `XXX` typed, all views sampled
every 40 ms:

| t | Tree previews (first four) | Detail's Value |
|---|---|---|
| +0 ms | `Fleet inventory…` ~ **`FocXu`** ~ **`>201`** ~ **`>Webe`** | `FocXu` |
| +26 ms | `Fleet inventory…` ~ **`FocXX`** ~ **`r>20`** ~ **`r>Web`** | `FocXX` |
| +72 ms | `Fleet inventory…` ~ **`FocXX`** ~ **`ar>2`** ~ **`er>We`** | `FocXX` |
| +274 ms | `Fleet inventory…` ~ `FocXXXus` ~ `2016` ~ `Weber` | `FocXXXus` |

Three distinct symptoms, one cause:

1. **The edited node is truncated to its old byte length.** `FocXXXus` is 8 bytes; the span still
   says 5, so the slice is `FocXX`. This is exactly the `abcdef` → `axxxbc` report.
2. **Every *following* node's preview slides into the tag text.** `<year>2016</year>` renders as
   `ar>2` and `<owner>Weber</owner>` as `er>We` — their spans are short by the 3 bytes just
   inserted ahead of them, so the slice starts inside the previous element's closing tag and ends
   early. Each keystroke shifts it one byte further, which is the visible "crawling" as you type.
3. **It lasts ~274 ms** — the 200 ms debounce plus the reparse — and it restarts on every keystroke,
   so it is continuous while typing rather than a flash.

Symptom 2 was not in the report and is the worse of the two: symptom 1 shows *less* of the right
answer, symptom 2 shows *wrong content* — fragments of markup presented as a node's value.

---

## 3. The fix already exists and was never plugged in

`core/deltaList.ts` is built, tested, and does precisely this: `shiftedOffset(list, offset)` maps an
original offset to its current position, in O(log n) over a short ascending list. Its own header
pins the coordinate space down and warns about the one thing easy to get backwards (`position` is
the **end** of the edited region, not its start).

What is missing is the plumbing, and the plumbing is the whole task:

- **Somewhere to keep the list.** `applyEdit` currently calls `recordEditForSplice`, which tracks
  the same shift but only for `spliceSubtree`'s internal use. The document state needs a pending
  list that accumulates across a burst of keystrokes and is cleared when a reparse lands.
- **Every UI read path translating through it.** Tree row previews, Detail's Value and facets, grid
  cells (`gridCell.ts`'s `cellOf`), and Raw's decorations all slice the buffer using spans from the
  store. Each needs the span translated first.

### 3a. Do it at one seam, not at forty call sites

The obvious implementation — find every `store.spanOf(...)`/`ownValueOf(...)` caller and wrap it — is
the version that rots. Every future read path is one someone can forget, and the failure is silent
and plausible-looking, which `deltaList.ts`'s own header names as the exact failure mode it exists
to make rare.

**Prefer a single accessor the views already funnel through.** Investigate whether a
"current-coordinates span" helper can sit next to the store in `documentSession`'s snapshot, so a
view asks for a node's *displayable* span rather than its raw one and cannot accidentally get the
untranslated version. **Report if that turns out to need a `core/types.ts` change** — it must not,
since this is renderer-side translation over an unchanged contract, but that is the boundary to
watch.

### 3b. What the list cannot do, and what that means on screen

`shiftedOffset` is explicitly one-way and undefined *inside* an edited region: an original offset
strictly within `[start, end)` "reads as unshifted, which is a reasonable default […] but is not
meaningful on its own." For a pure insertion (`start === end`) — which is what typing is — every
span boundary is either before or after the point, so symptoms 1 and 2 both resolve exactly.

A *replacement* (selecting text and typing over it, or a paste) genuinely has no correct answer for
a span boundary inside the replaced region until the reparse lands. **State what that looks like
rather than discovering it:** the edited node's own value should still be right, because its span
end is past the region; a node entirely inside the replaced region has no defined position and
should render unchanged rather than wrong. Accept that, and make sure it degrades to "briefly
stale" rather than "briefly garbage."

### 3c. Rows and lines shift too

`deltaList.ts`'s `fold` shifts the row index, and the line index is rebuilt from it — but `fold`
**cannot add or remove entries**, so an edit that inserts or deletes a newline changes the row
*count* and `fold` alone silently produces a row index with the wrong number of rows. There is
already a regression test pinning this down. R42 must therefore either restrict itself to the
row-count-preserving case and fall back to "wait for the reparse" otherwise, or route through
`subtreeSplice`, which owns exactly that case. **Decide this explicitly; do not let it be decided by
whichever test happens to exist.**

---

## 4. Rejected alternatives (D-070)

- **Shorten the debounce.** Moves the window rather than closing it, and trades a visible glitch for
  a reparse per keystroke — the cost F3 exists to avoid.
- **Reparse synchronously on edit.** The same trade at its worst; H-series measurements are the
  reason this was never on the table.
- **Blank or freeze the affected fields during the window.** Honest, and much cheaper. But it makes
  every view flicker on every keystroke, which is a worse version of the "jumping" already
  complained about — and it throws away information that is *already correct* for the ~99% of nodes
  the edit didn't shift.
- **Do nothing.** This was the standing decision, on a stated premise that has now failed.

---

## 5. Verify

The measurement in §2 is the acceptance test, and it should be automated as one — a browser-project
test that types into a value and asserts, **inside the debounce window**, that:

- the edited node's preview/Value equals the full new text, not a same-length prefix;
- a **following sibling's** preview is unchanged and contains no `<` or `>` — symptom 2's regression
  guard, and the one an implementation that only fixes the edited node would fail;
- both still hold after the reparse lands.

Assert on content, not on timing: sample until the reparse (identifiable by the store changing) and
require every sample to be correct, rather than probing one arbitrary instant.

---

## Results

Built as scoped in §3a: one seam, `session/spanTranslation.ts`'s `translateSpan(span, deltas)`,
rather than a fix at every call site. `OpenDocument` grew one field, `pendingSpanDeltas: DeltaList`
— the union of every edit's shift since `store` was last built, in `store`'s own coordinates.
`applyEdit` records into it the same way `recordEditForSplice` already derives its own tracked
range (translate the patch's end back through the delta already accumulated this burst); every
successful reparse commit resets it to `EMPTY_DELTA_LIST`, including the two call sites §3c's
"decide explicitly" flagged as easy to miss: the ordinary `applyReparseResult` path and
`reloadAndDiscard`'s own inline commit. A third site needed the same reset for a different reason,
found in review rather than planned: `applyUndoEntry` replays undo/redo's own patches directly via
`applyPatch`, bypassing `recordDelta` entirely, so a list left over from unflushed typing would
otherwise be carried forward describing a shift that no longer applies to the post-undo buffer —
translating by the *wrong* amount rather than by none. Reset there too, safe because undo/redo
reparses immediately rather than after F3's debounce.

**§3c's row/line-index question decided narrowly: out of scope, not "handled."** Every consumer
this task closes reads `NodeStore` spans (`spanOf`/`ownValueOf`/`valueOf`, an attribute's
`valueStart`/`valueEnd`) — Tree previews, Detail's Value/facets/children list, Grid cells
(`gridCell.ts`'s whole call chain, `cellOf` through `rowFields`), and Raw's syntax/selection
decorations (`decorations.ts`). None of them read the row or line index, so `fold`'s
can't-add-or-remove-entries hazard never enters into this field at all — nothing here touches
either index, and a row-count-changing edit needs no special case because `shiftedOffset` is pure
byte arithmetic, indifferent to whether a newline was inserted. Stated as a boundary rather than
left implicit: if a future read path decodes text via the row index instead of a node span, this
field does not cover it.

**§3b's replacement-region gap is exactly as accepted as planned**, unexercised by a dedicated test:
`shiftedOffset` has no correct answer for an offset strictly inside a replaced range and reads it as
unshifted, which degrades a replacement to briefly stale rather than briefly wrong. Pure insertion —
what typing is — has every span boundary strictly before or after the edit point, so it resolves
exactly; this is what `test/documentSession.test.ts`'s new `pendingSpanDeltas (R42/D-070)` suite
exercises, reproducing §2's own measured symptoms (the edited node's full new text, not a
same-length prefix; a following sibling's preview staying clean) synchronously inside the debounce
window, plus the reset once the reparse lands.

**One ordering nuance found in review, left as an accepted approximation rather than fixed**: Raw's
decoration rebuild (`rawDecorations.ts`) is driven by CodeMirror's own `update.docChanged`, which
fires as part of the same transaction `rawEdit.ts`'s `applyChangesToSession` calls `session.applyEdit`
from — decorations rebuild before that call updates `pendingSpanDeltas`, so a given keystroke's own
decorations lag by one keystroke rather than reading zero-lag live state. Self-correcting on the next
keystroke (or the reparse), and a one-character highlight lag is a strictly smaller defect than the
multi-keystroke content corruption this round fixes — not reopened without a report.

---

## Addendum — the accepted one-keystroke lag, now reported

**Open.** Raised by the project lead after using R42: *"the only thing that is still wrongly updated
is the syntax highlighting in Raw view. When I type some change into a tag, there is a shift in the
highlighted letters before the content is matched again."*

**This is not an oversight, and the record should not pretend otherwise.** R42's own Results section
found it in review, diagnosed it correctly, and deferred it deliberately — *"Self-correcting on the
next keystroke (or the reparse), and a one-character highlight lag is a strictly smaller defect than
the multi-keystroke content corruption this round fixes — **not reopened without a report**."*

That was a reasonable call on the evidence available. **The condition it named has now been met.**

Worth naming explicitly, because it is the second time in three rounds: R42 exists because
`applyEdit`'s comment parked the whole stale-span problem on *"this has not been reported as a
visible problem in practice"*, and the addendum to that round is now parked-and-unparked on the same
clause. The pattern is not a failure — deferring on "nobody can see it" is the right call when it is
true — but it does mean **"not reported yet" is a countdown, not a conclusion**, and a round that
uses it should expect to come back.

### Measured

`cars-small.xml`, caret placed after `<na` in `<name>Focus</name>`, `Z` then `Y` typed, sampling
each character's highlight class (`T` = tag name, `S` = string, `.` = none):

```
BEFORE          text |        <name>Focus</name>|
                high |.........TTTT.SSSSS.......|

+1 keystroke    text |        <naZme>Focus</name>|
                high |.........TTTT.SSSSS........|     S covers ">Focu"

+2 keystrokes   text |        <naZYme>Focus</name>|
                high |.........TTTT..SSSSS........|    S covers ">Focu"

after reparse   text |        <naZYme>Focus</name>|
                high |.........TTTTTT.............|    correct
```

**The diagnostic detail is that the error stays at exactly one character instead of growing.** With
no translation at all it would be off by one after the first keystroke and off by two after the
second. It is off by one both times — so `translateSpan` *is* being applied, from a delta list
missing only the most recent edit. That confirms the Results section's own diagnosis rather than
finding a new one.

(The final row loses the string highlight because `<naZYme>` no longer matches `</name>` — malformed
input parsed differently, not a defect.)

### Why the ref is stale, precisely

`Raw.tsx`'s comment on `pendingSpanDeltasRef` claims `useLayoutEffect` keeps it current for a rebuild
"triggered by `update.docChanged`, i.e. every keystroke." **That claim is wrong**, and the reason is
worth writing next to it rather than rediscovering:

1. Keystroke → CodeMirror dispatches the transaction.
2. **View plugins update first** — `rawDecorations`'s plugin rebuilds, reading the ref.
3. **Update listeners run second** — `rawEdit` is one, and it is what calls `applyEdit`, which
   records the delta.
4. React re-renders; `useLayoutEffect` refreshes the ref.

`useLayoutEffect` runs after a React *commit*; the rebuild happens inside the *CodeMirror dispatch*,
which is upstream of React entirely on a keystroke. The ordering the comment relies on does hold
between React's own effects — it just isn't the ordering that governs step 2.

### Fix

**Dispatch `bumpDecorationsEffect` when `pendingSpanDeltas` changes**, from a `useLayoutEffect` so
the corrected rebuild lands before paint and no wrong frame is visible. R41 built that effect for
exactly this shape of problem — an extension reading through a getter whose value changed underneath
it — and `Raw.tsx` already dispatches it when the *store* changes. This adds the second trigger.

Two things to get right rather than discover:

- **It must not fire on every render**, only when the delta list identity actually changes, or every
  keystroke costs two full decoration rebuilds plus a dispatch for no reason.
- **Confirm the second rebuild really precedes paint.** `view.dispatch` is synchronous and
  `useLayoutEffect` runs before the browser paints, so it should — but "should" is what the original
  comment said too. Assert it rather than reason about it.

**Rejected: composing the shift from CodeMirror's own `update.changes` inside the plugin.** It is
more exact and single-pass — right the first time instead of right the second — but it gives the
extension a second source of truth for a shift that D-070 deliberately routes through one seam
(`spanTranslation.ts`). The whole point of that seam is that a read path cannot compute the
translation its own way. Recorded rather than built.

### Verify

The existing `pendingSpanDeltas (R42/D-070)` suite asserts translated *output*; nothing asserts the
*timing*, which is why a correct implementation shipped with this defect intact.

- **Browser project, real Chromium**: type one character inside an element name, and inside the
  debounce window assert the highlight boundary sits at the character it should — not that
  `translateSpan` was called. §Measured's `text`/`high` pair is the assertion shape; a one-character
  offset is exactly what a passing-but-wrong implementation produces.
- Assert it after the **second** keystroke too. A fix that merely shifts the lag by one edit still
  passes a single-keystroke test.
- Confirm no wrong frame is painted between the two rebuilds.

---

## Addendum's Results

Built as the addendum's own plan prescribed, plus one thing the plan didn't anticipate, found while
writing the verification test §Verify asked for.

**The prescribed fix, built as specified.** `Raw.tsx` gained a second ref, `lastDispatchedDeltasRef`,
alongside the existing `pendingSpanDeltasRef` — both start at the same value, so the very first
commit dispatches nothing. The same `useLayoutEffect` that already refreshes `pendingSpanDeltasRef`
every render now also compares against `lastDispatchedDeltasRef`, and when `document.pendingSpanDeltas`
has changed since the last dispatch, calls `handle.view.dispatch({ effects: bumpDecorationsEffect.of(undefined) })`
a second time — still inside `useLayoutEffect`, so still before paint. This closes exactly the gap
diagnosed: a decoration rebuild triggered by CodeMirror's own `update.docChanged` (step 2 in the
addendum's own ordering) reads whatever `pendingSpanDeltasRef` held as of the *previous* commit;
this second dispatch forces one more rebuild once the ref is actually current.

**Found while writing the verification test, not anticipated by the plan: this fix alone does not
close the addendum's own reported symptom.** The addendum's repro is specifically an edit *inside an
element's tag name* — and `decorations.ts`'s tag-name span was never being translated correctly in
the first place, independent of timing. The old code:

```ts
const span = translateSpan(store.spanOf(node), deltas) // translates the *element's* outer span
const nameStart = span.start + 1
const nameEnd = nameStart + utf8Encoder.encode(name).length // stale `name`'s length, untranslated
```

`nameStart` is derived from the translated element span, which is correct (the edit is always after
it for this repro). `nameEnd`, though, is never itself passed through `shiftedOffset` — it's
synthesized as `nameStart + (the interned name's own byte length)`, and `name` only refreshes at
reparse. For an edit *inside* the tag name, this is wrong regardless of whether `pendingSpanDeltasRef`
is one keystroke stale or perfectly current: a stale ref makes it wrong one way, a current ref makes
it wrong a different way, but it is never right until the reparse lands and `name` itself updates.
This is *why* the addendum's own measurement showed the error "stay at exactly one character instead
of growing" — not because `translateSpan` was lagging by one edit (the diagnosis in R42's own Results
section), but because `nameEnd`'s length term never moved at all, and the visible drift came entirely
from where `nameStart` happened to land.

**Fixed alongside the timing fix**, since the timing fix alone provably does not resolve the
addendum's reported symptom (verified by reverting it in isolation — see below) and both are squarely
inside `docs/plans/R42-stale-spans.md`'s own stated scope (a view's span-to-text decode path).
`decorationsForNode`'s `NodeKind.Element` case now computes `originalNameStart`/`originalNameEnd` in
pre-edit coordinates first (the second exactly as the old code did — `originalSpanStart + 1 +
byteLength(name)`) and translates *that pair* through `deltas` together, rather than translating the
outer span and deriving `nameEnd` afterward. A pure insertion strictly between two original boundaries
moves the later one and leaves the earlier one alone (§3b's own rule) — which only holds when both
ends are actually run through `shiftedOffset` independently, not when one is computed from the other's
translated value plus a fixed length.

**Verified**, per §Verify, in `test/rawDecorationTiming.test.tsx` (real Chromium, same
fake-parse/tab-backed-session harness R41's own tests use):

- Typing one character inside `<name>` (making it `<naZme>`) resolves the tag-name highlight to the
  full, correct `naZme` inside the debounce window (no reparse — `reparseDelayMs: 5000`).
- A second keystroke (`<naZYme>`) is correct too, not merely shifted by one edit.
- **Confirmed by reverting each fix in isolation** (not merely asserted): with only the
  `decorations.ts` fix and the timing fix reverted, both tests still fail identically to before either
  fix (`naZm`, not `naZme`) — the stale ref feeds the corrected `nameEnd` math a delta list missing
  the very edit being typed. Both changes are necessary; neither alone is sufficient. This is the
  "no wrong frame is painted" property from a different angle: the test asserts synchronously (one
  microtask tick, deliberately not a real animation frame) rather than instrumenting paint directly,
  since a wrong intermediate value would already fail the assertion at that tick if either fix were
  missing.

Full node+browser suite: 111 files, 1263 tests, all green. `npm run typecheck` and `npm run lint`
both clean (3 known warnings, unchanged).
