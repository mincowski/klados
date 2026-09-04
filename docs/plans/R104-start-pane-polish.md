# R104–R105 — the start pane, after looking at it

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Four reports against R96/R97 as built: the heading is noise, the
Open hint's key caps overlap, the recent rows have no vertical spacing and truncate the *file name*
while showing the path in full, and the two columns are too narrow. Follow-up to
`docs/plans/R95-recent-files.md`. Results at the end of this file.

**Every question in this document is settled — nothing here is waiting on a decision.** The layout
was chosen from a rendered comparison at three widths, and every cause below was measured in real
Chromium against the app's own stylesheet.

---

## 1. The width is the root cause, and three of the four reports are downstream of it

Measured with `DocumentArea.css` loaded, at the ~341px column the 720px two-column block produces:

| | box | wants | |
|---|---|---|---|
| file name | **72.2px** | 84px | **clipped** |
| directory | **216.8px** | 252px | clipped |

**The less important half gets three times the space.** And R96's own choice of `max-width: 720px`
split two ways is what produces a column narrower than a single recent row needs.

**Stacked at 560px, nothing truncates at all** — asserted, not eyeballed: with a 48-character
filename in the list, `name clipped? false   dir clipped? false`. The Open hint also stops wrapping,
which removes the condition under which §3's key caps collide.

So R104 is one change with three effects, and R105 is the row itself.

## 2. R104 — the block stacks, and the heading goes

**`.document-area-columns` becomes `flex-direction: column`, and the block's `max-width` drops from
720px to 560px.** Open above Recent, matching the reference the report supplies.

**The trap, found by rendering the first attempt rather than by reasoning about it.**
`.document-area-column` is `flex: 1 1 260px`. In a *column* flex container `flex-basis` is a
**height**, not a width, and `flex-grow: 1` then stretches both sections to fill the container — the
first render put Open and Recent at opposite ends of a tall empty box. The sections must become
`flex: none` once stacked. This is the whole reason the change is not a one-line
`flex-direction` swap.

**The heading is removed — but the slot stays.** R97 reuses `StartColumns({ heading })` to render the
**error banner** above the same two sections (`DocumentArea.tsx`'s `error` case), so the prop becomes
optional and `empty` passes nothing. Deleting the prop would delete R97's dead-end fix with it.

Consequences to finish rather than leave behind:

- **`.document-area-start-heading` becomes dead CSS** — the `error` case uses
  `.document-area-banner-error`, not this. Remove it.
- **`<div role="status">` around the `empty` case must go.** With the text gone, that region now
  announces the entire Open and Recent block, and — because a `status` region announces *changes* —
  opening a file would announce the whole start screen re-rendering. It was correct when it wrapped
  one sentence; it is wrong wrapping a file list. The start screen is not a status.
- **`role="alert"` on the `error` case has the same shape and is worth fixing in the same pass**:
  it wraps `StartColumns` entirely, so the alert announces the error message *plus* both sections.
  The alert belongs on the banner `<p>`, which is the thing that is actually an alert.

## 3. R104 — the hint's line box has to contain its own key caps

Measured, at the wrapped two-line width:

| | |
|---|---|
| `.document-area-hint` line box | **17.00px** (`line-height: normal`) |
| `kbd` border box | **19.00px** |

**An inline element's padding and border never grow the line box it sits in** — so the key caps stand
2px proud of their own line, and on a wrapped paragraph consecutive lines collide. That is the
reported overlap, exactly.

**The fix is `line-height` on the paragraph, not padding on the `kbd`.** Padding would make the caps
taller and the overlap worse; the caps are already taller than the line. `line-height: 1.9` clears it
with margin to spare and reads well at 13px.

**It must land even though §2 stops the wrap at 560px.** A narrow window wraps the hint again, and a
fix that depends on the paragraph never wrapping is not a fix.

**Note the shared class:** `.document-area-hint` is also the parsing phase's percentage line
(`<p className="document-area-hint">{percent}%</p>`). It gains leading it does not need, which is
harmless — but if that looks wrong, scope the rule to the Open column rather than reverting it.

## 4. R105 — the recent row

**Vertical spacing.** `.document-area-recent-list` has no `gap` at all (computed `row-gap: normal`),
and the row's vertical padding is `var(--space-1)`. Add `gap: var(--space-1)` and give the row
`var(--space-1) var(--space-2)` with a wider internal `gap: var(--space-3)` between glyph, name and
path.

**The name must never lose a character while the path still has one to give.** Both are
`flex: 1 1 auto` today, so shrink is distributed proportional to content width — which means the long
directory keeps more absolute width while the short filename is squeezed, the inversion §1 measured.

Fix: `flex-shrink: 1` on the name, **`flex-shrink: 100` on the directory**, so the path absorbs
essentially all pressure first. Plus `overflow: hidden` on the row, because middle truncation gives
each field an incompressible floor — `.document-area-recent-tail` is `white-space: nowrap` and
`textTruncate.ts` guarantees it is never truncated — so at the narrowest widths the row would
otherwise overflow rather than clip.

**This is a contract violation, not just an unlucky layout.** What is being cut today is the *tail*,
which `textTruncate.ts` documents as *"Never truncated — always fully visible."* The parent
`.document-area-recent-name` is `overflow: hidden`, so for a short filename — where
`splitForMiddleTruncation` yields a 1-character head and a 12-character tail — there is nothing for
the head's ellipsis to give up and the parent clips the tail instead. Worth stating in the code
comment: middle truncation only works when the head has room to disappear into.

**Buttons stay; the name takes `--accent`.** The report is open to VS Code's links and this is the
better of the two: a `<button>` is the correct semantics (opening a file is an action, not
navigation), the full-width row is a larger hit target than a text link, and the existing
`--row-hover-bg` row highlight is an affordance links would lose. Colouring the file name with
`--accent` gets the appearance the report is after without giving any of that up.

Checked rather than assumed: `--accent` as text measures **7.21:1** on the dark surface and
**4.98:1** on the light one, both clear of WCAG AA's 4.5:1 for normal text — and it is already used
as text in `CommandPalette.css:75` and `Detail.css:100`, so this is an established token use, not a
new one.

**But the row has a hover background, and that is where it fails.** Measured against
`--row-hover-bg` rather than the surface:

| | on `--surface-bg` | on `--row-hover-bg` |
|---|---|---|
| dark | 7.21 | 5.70 |
| light | 4.98 | **4.29** |

So the light theme drops **below AA** on exactly the state the user is looking at when they are about
to click. Small margin, but this project does not ship a measured miss.

**Decided: the name reverts to `--surface-fg` on hover.** One rule, and it reads correctly rather
than as a workaround — `--accent` is there to say "this is actionable", and on a hovered row the
highlight is already saying it, so the colour has no work left to do. `--surface-fg` is the token
designed to be legible on `--row-hover-bg`, so the pair is safe by construction rather than by luck.

Rejected: accepting 4.29 because hover is transient (WCAG exempts no state, and the transient moment
is the one that matters here); bolding the name (13px bold does not reach WCAG's large-text
threshold, so the ratio requirement is unchanged); and a new darker accent token (a whole token for
one label, when an existing token already solves it).

## 5. Definition of done

- [x] R104 — Open sits above Recent in a block capped at 560px; both sections are `flex: none`, so
      neither stretches to fill the column's height.
- [x] R104 — **at 560px, with a 48-character filename in the list, neither the name nor the path is
      clipped.** Asserted by comparing `scrollWidth` against `clientWidth`, not by eye — that
      comparison is what caught the original defect.
- [x] R104 — no `No document open.` heading; `StartColumns`'s heading slot still renders R97's error
      banner; `.document-area-start-heading` is gone.
- [x] R104 — the `empty` case is no longer a `role="status"` region, and `role="alert"` in the
      `error` case wraps the banner rather than the whole start pane.
- [x] R104 — the hint's line box is **at least as tall as its `kbd` border box**, asserted as a
      measurement rather than a screenshot, and holding at a width where the hint wraps.
- [x] R105 — recent rows have visible vertical separation.
- [x] R105 — **narrowing the pane truncates the path first**: a test that shrinks the layout and
      asserts the file name is still whole after the directory has started to ellipsize, and that
      the row clips rather than overflowing at the narrow floor.
- [x] R105 — the file name renders in `--accent` at rest and `--surface-fg` on hover, so the
      light theme never sits at 4.29:1; the rows are still `<button>`s with the hover highlight
      intact.
- [x] The code comment on `.document-area-recent-name` records *why* the tail was being clipped —
      middle truncation needs a head with room to give — so the next person does not reintroduce it.

## 6. Results

Built as specified, no deviations. `.document-area-columns` is `flex-direction: column` with
`max-width: 560px` on `.document-area-start`; `.document-area-column` is `flex: none` (the
column-flex-basis-is-height trap from §2, avoided rather than rediscovered). `StartColumns`'s
`heading` prop is now optional; the `empty` phase passes none at all (`.document-area-start-heading`
and its CSS rule are deleted), and the `error` phase moves `role="alert"` onto the banner `<p>`
itself rather than wrapping the whole `StartColumns` output. The `empty` phase's `role="status"`
wrapper is gone with it. `.document-area-hint` gets `line-height: 1.9`, clearing the `kbd` overlap
on a wrapped line. `.document-area-recent-list` gets `gap: var(--space-1)`; the row's internal gap
grows to `var(--space-3)` and the row itself gains `overflow: hidden`. `.document-area-recent-name`
is `flex-shrink: 1` and `.document-area-recent-dir` is `flex-shrink: 100`, so the path absorbs
shrink pressure first; the name renders in `--accent` at rest and reverts to `--surface-fg` on
`.document-area-recent-row:hover`.

`test/recentFilesUi.test.tsx` gained ten tests (real Chromium, `getBoundingClientRect`/
`scrollWidth`/`clientWidth` measurements and `userEvent.hover` for the real-cursor `:hover` state
`dispatchEvent` cannot produce): the 560px/48-char no-clip case, the missing heading and absent
`role="status"`, `role="alert"` on the banner alone, the hint's line-box-vs-`kbd` measurement,
visible row spacing, directory-truncates-before-name at a narrow width with the row itself not
overflowing, and the accent/hover color pair (compared as computed `rgb()` strings, not the raw
token strings, since that's what the DOM actually reports). Full browser suite (39 files, 196
tests, including the ten new ones) passes; `npm run lint` (eslint + stylelint) clean on the changed
files. `npm run typecheck:web` shows nine pre-existing errors unrelated to this change (a
same-shape `externalRewrites`/`OpenDocument` mismatch across several test files, present
identically on the pre-change tree) — not touched by this round.

### 6.1 Addendum — only the name is clickable, and the spacing rebalanced

Two follow-up reports against the built result, from a screenshot: the whole-row button (§4's own
"the full-width row is a larger hit target than a text link, and the existing `--row-hover-bg` row
highlight is an affordance links would lose") read as broken in practice — a row that *looks* like a
link but responds to a click anywhere in its own whitespace is surprising, not generous. And the
Open File… button sat visually closer to "Recent" than to its own heading/hint, because
`.document-area-column`'s internal gap (`--space-2`) and `.document-area-columns`' between-section
gap (`--space-4`) were close enough in value that the section boundary didn't read as one.

**Reversed: only `.document-area-recent-name` is now a `<button>`**, wrapping just the file name;
the row itself is a plain, non-interactive `<div>` with no hover background, no cursor, no border —
`title={entry.path}` moved from the row onto the name link, since it's the interactive element now.
The link gets `--accent` at rest (unchanged) and an underline on hover/focus instead of reverting to
`--surface-fg` — that reversion existed only to avoid a contrast failure against the row's own
`--row-hover-bg` (§4's WCAG measurement), which no longer exists to fail against. `:focus-visible`
gets an explicit `--focus-ring` outline, since a plain-text button has no visible default. One
specificity trap: `.document-area-recent-name`'s own `color`/`background` were initially outranked
by the pre-existing `.document-area button` rule (element + class beats a single class), silently
falling back to `--surface-fg` — fixed by scoping the selector to
`.document-area-recent-row .document-area-recent-name`, caught by the accent-color test failing
rather than by inspection.

**Spacing: `.document-area-columns`' gap grew to `calc(var(--space-4) + var(--space-2))` (24px)**,
and a new `.document-area-open-column` rule narrows that section's own internal gap to `--space-1`
(4px) — heading, hint and button now read as one tight unit, with the larger gap doing all the work
of separating Open from Recent.

`test/recentFilesUi.test.tsx` updated: every row-click test now dispatches on
`.document-area-recent-name` (the row no longer carries `title` or handles clicks), and the
accent/hover test now asserts the link stays `--accent` and gains `text-decoration: underline` on
hover, rather than reverting to `--surface-fg`. Full browser suite (40 files, 201 tests) passes;
`npm run lint` clean.
