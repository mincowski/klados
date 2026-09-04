# R102–R103 — the find field goes back to a single line

<!-- status: built -->

**Built.** Done once R100 landed and the rest of the Find bar was confirmed working, so the revert
was never competing with a live bug fix in the same files.
Register: `docs/TASKS.md`. Reverts the multi-line half of R89
(`docs/plans/R86-find-as-query-surface.md` §5); everything else R89 built stays. Results at the end
of this file.

**Every question in this document is settled — nothing here is waiting on a decision.**

---

## 1. Why, stated honestly

The multi-line field was asked for, planned, built and polished twice (`0be62a1`, `6c65686`), and it
is still the part of the bar that does not sit right. Two concrete reasons to take it out rather than
polish it a third time:

- **It made the Replace field inconsistent, structurally.** The find field is a `<textarea>` and the
  replace field is an `<input type="text">`, and both wear `.find-input` — a class that now carries
  textarea-only properties (`resize`, `overflow-y`, `scrollbar-width`, the `::-webkit-scrollbar`
  rule, a `max-height` backstop). One of the two elements ignores half its own class. And when the
  find field grows, the replace field cannot follow, so two controls that are supposed to read as a
  pair stop lining up exactly when the feature is in use.
- **It was under-specified going in, and the follow-ups show it.** The manual drag had to be removed
  after landing (`6c65686`) because a dragged height and `autoGrow`'s measured height disagreed the
  moment the next keystroke arrived — a conflict the plan did not anticipate. That is the second
  correction to a feature whose requirements were "like VS Code."

It is also, as the report puts it, an advanced feature a first version does not need. Reverting is
not an admission that the work was wrong; it is choosing not to carry an unfinished shape.

## 2. What comes out, and what explicitly stays

**Out** — `FindBar.tsx`: the `<textarea rows={1}>` becomes `<input type="text">`; `autoGrow`, its
line-height measurement and the effect that drives it are removed. `Find.css`: `max-height`,
`resize`, `overflow-y`, `scrollbar-width` and the `.find-input::-webkit-scrollbar` rule go, since
every one of them exists only for a growing textarea. `test/findAutoGrow.test.tsx` is deleted.

**Stays, and this is the important half of the task** — R89 was two changes in one commit and only
one of them is being reverted:

- **The narrow-width fix.** `.find-input`'s `width: 200px; flex: 1 1 auto; min-width: 0` and
  `.find-bar-row > *:not(.find-input) { flex: none }` are what keep every control inside the bar down
  to ~314px of layout width — before them, the close button left the window entirely and Find could
  not be dismissed with the mouse. **`test/r8Layout.test.tsx`'s three R89 width tests must still
  pass**, unmodified except for the element selector.
- **`Raw.css`'s current-match mark.** R89 changed R80's full inset ring to a 3px left edge because a
  multi-line match's decoration fragments per line and drew as several closed boxes. Reverting the
  needle does not make that wrong — the left edge is also what R57 established as this app's severity
  language, and a multi-line match can still arise from a needle that was never typed here. **Keep
  it**, and say so, so a future reader does not "finish" the revert by undoing it.
- **Replace, path mode, the mode control and the auto-select behaviour** — untouched. Replace in
  particular gets *better* from this: with both fields being `<input type="text">` again, the
  asymmetry in §1 disappears rather than needing its own fix.

**Test selectors.** R89 rewrote `input` to `textarea` in `findAutoSelect`, `findPathMode` and
`palettePathQuery`; those flip back. A selector change is the whole diff in each — if any of them
needs a behavioural change too, that is a signal the revert removed more than intended.

## 3. R103 — a multi-line paste must be told, not silently mangled

The one thing the revert genuinely loses, and the reason it gets its own id rather than being waved
through.

**Measured, not assumed:** assigning `'a\nb'` to an `<input type="text">` yields `'ab'` — the
newline is dropped and the two lines are **concatenated with no separator**. So pasting a needle
copied across two lines produces a string that appears in no document, and Find reports `No matches`
with nothing on screen explaining why. That is precisely the silent-wrong-answer class this project
keeps finding, and it would be newly introduced by the revert.

**Decided: strip explicitly, and say so.** On paste, if the text contains a line break, remove the
breaks and render one line in `.find-footnote` — the row that already exists for the ASCII-folding
note and R87's path diagnostic — saying line breaks were removed. No new surface, no new state, and
the message appears only in the case that would otherwise be silent.

Rejected: joining with a space instead of removing (invents a character the user did not copy, and is
just as wrong, only less visibly); and refusing the paste (a search box that discards what you paste
is worse than one that tells you what it kept).

## 4. Sequencing

**After R100 lands and the Find bar is otherwise confirmed working.** Stated as a dependency rather
than a preference: R100 touches `Raw.tsx` and R102 touches `FindBar.tsx`, so they do not collide in
the source — but Replace's correctness is currently *unknown* to the eye, because the Raw pane has
been lying about the result. Reverting the find field while that is still true would mean judging the
bar's behaviour through a display that does not update. Fix the display first, look at Find again,
then revert.

## 5. Definition of done

- [x] R102 — the find field is an `<input type="text">`; no `autoGrow`, no textarea-only CSS.
- [x] R102 — **`test/r8Layout.test.tsx`'s three narrow-width tests still pass**, with only the
      element selector changed. The close button stays reachable at 420px and at the ~314px floor.
- [x] R102 — the replace input and the find input are the same element type and line up, with the
      replace row's alignment re-checked rather than assumed.
- [x] R102 — `Raw.css`'s 3px left-edge current-match mark is **unchanged**, with a comment saying it
      outlived the feature that prompted it.
- [x] R103 — pasting text containing a line break puts a single line in the field **and** shows the
      footnote; pasting text without one shows nothing new.
- [x] `docs/plans/R86-find-as-query-surface.md`'s R89 section is marked as reverted by R102, with the
      reason, rather than left describing a field that no longer exists. Its narrow-width half is
      marked as *kept*, in the same edit, since that is the part a reader will otherwise assume went
      with it.
- [x] `docs/TASKS.md`'s Owed table and board reflect that R89's multi-line half is gone.

## 6. Results

Built as specified. `FindBar.tsx`'s `<textarea rows={1}>` is back to `<input type="text">`;
`autoGrow`, its `useLayoutEffect` and the `HTMLTextAreaElement` refs are gone. `Find.css` lost
`max-height`, `resize`, `overflow-y`, `scrollbar-width` and the `::-webkit-scrollbar` rule —
everything that existed only for a growing textarea. `test/findAutoGrow.test.tsx` is deleted.
`.find-input`'s width/flex/min-width rule (the narrow-width fix) and `Raw.css`'s 3px left-edge
current-match mark are untouched, each now carrying a comment saying which half of R89 it belongs
to and that it stays. Three selector-only diffs (`test/findAutoSelect.test.tsx`,
`test/findPathMode.test.tsx`, `test/palettePathQuery.test.tsx`: `HTMLTextAreaElement` →
`HTMLInputElement`) and one selector change inside `test/r8Layout.test.tsx`'s own `findBarRow()`
helper — no behavioural change needed in any of the four, confirming §2's own prediction. The
replace row's alignment (`test/findReplace.test.tsx`'s own geometric assertion) still passes
unmodified, now trivially true rather than coincidentally true — both fields are the same element.

R103: `handlePaste` intercepts a paste only when the clipboard text contains a line break
(`/[\r\n]/`, checked before `preventDefault` so an ordinary paste falls through to the browser's
own default handling untouched), strips the breaks, splices the result into the field at the
current selection, and sets a `showLineBreakNotice` flag the footnote row renders from — cleared
again on the next ordinary text change, so the note doesn't outlive the paste that caused it.
`test/findPasteLineBreak.test.tsx` (3 tests): a line-break paste is stripped and shows the
footnote; an ordinary paste is left to the browser's default handling (asserted via
`event.defaultPrevented`, since a synthetic `paste` dispatch doesn't trigger a real browser
insertion — there is no way to assert on the inserted value itself in this harness); and typing
after a stripped paste clears the notice. `test/r8Layout.test.tsx` and the four other touched test
files pass unmodified in substance (selector-only diffs). Full browser suite (39 files, 189+3
tests) and full node suite pass; `npm run lint` (eslint + stylelint) clean.
