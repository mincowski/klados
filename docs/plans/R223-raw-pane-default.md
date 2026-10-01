# R223 — the Raw pane is shown by default

<!-- status: built -->

**Built**, for 1.2.2, with Raw at **30%** rather than the 40% § 2.2 assumed (§ 5). Raised by the
project lead: *"a new user doesn't know that the raw view must be enabled in order to edit."* The
recommendation below was reviewed and accepted as written. One measured cost was accepted rather than
fixed: a tab switch into a minified document takes ~2.4 s by default now (§ 5).

## 1. What a new user meets today — verified

The default layout is Tree + Detail (`layoutLogic.ts`'s `DEFAULT_PANE_VISIBILITY`,
`rawVisible: false`), as `CONCEPT.md` § 4.1 decided: *"Tree and Detail are the default pair. Raw is
toggled in."* Editing happens only in Raw (invariant 6), so on a fresh install:

- **Nothing says Klados can edit.** Undo, Redo and Save sit disabled in the title bar with no stated
  reason, and the start page explains only how to open files.
- **Trying to edit where the data is shown does nothing.** Clicking, double-clicking or typing in
  Detail or the grid selects; nothing points at Raw.
- **The way in is an unlabelled icon or a chord.** One of four title-bar icons (`panel-bottom`), or
  Ctrl+Shift+R.
- **Commands that act on Raw silently do nothing while it is hidden.** Raw is not mounted at all when
  hidden (`Layout.tsx`), and `rawController.ts` is a no-op without a mounted view. So:
  - *Locate in Source* and *Toggle Raw Wrap* do nothing;
  - the palette's jump to a position and next/previous diagnostic (F8) move the node selection, but
    their jump in the text is lost.

  The palette offers all of them regardless.
- **The Detail↔Raw sync is invisible**, which § 4.1 itself calls *"one of the tool's selling points"*
  that *"cannot be perceived when only one of the two is visible"*.

## 2. The change

1. **Tree + Detail + Raw by default.**
   - **Who gets it:** the layout is persisted only once changed (`layoutStore.ts` writes on a toggle
     or a divider drag). So the new default reaches new installs and existing users who never changed
     their layout.
   - **Who keeps theirs:** anyone who changed their layout, including someone who only dragged a
     divider and so saved Raw hidden without choosing it. Accepted by the project lead, rather than
     overwriting saved layouts.
2. **Detail stays dominant.** Raw's default share of the right column is 40% (`rawHeight: 0.4`). At
   1280×800 that leaves the grid roughly 12 visible rows instead of about 20.
   *Corrected by the renders (§ 5): 6 rows, not 12, and the Detail pane overflowed. Landed at 30%.*
   - **Rendered before settled** (`PLANNING.md` § 1): the default window at 1280×800 and 1024×700, in
     both themes, at 40% and about 30%, with a real document.
   - The project lead chooses from the images; the value is not decided in this plan.
3. **Commands that need Raw reveal it** rather than do nothing:
   - *Locate in Source*;
   - *Toggle Raw Wrap*;
   - the palette's jump to a position;
   - next/previous diagnostic.

   *Focus Raw* (Ctrl+3) belongs to the same group; what it does today while Raw is hidden is checked
   first, and it gets the same treatment if it too does nothing. Revealing goes through the existing
   layout rules (`toggleRaw`), so it cannot reach a layout § 4.1 forbids. The jump then lands in the
   newly mounted view, which has to be verified, not assumed, since mounting is asynchronous to the
   command.
4. **Measured before settled.** Every performance figure so far was taken with Raw hidden (R221 § 4).
   Raw holds only a window of about 1 MB (D-031), so the cost should be small, but it is measured:
   - opening the 100, 200 and 500 MB fixtures with Raw visible against hidden;
   - switching to a tab holding a large minified document (`FINDINGS.md`: ~2.5 s today).

   A regression past 15% is reported, not accepted.
5. **The design change is recorded.** `CONCEPT.md` § 4.1 changes its default pair, and a `DECISIONS.md`
   entry says why, since this reverses a decision rather than filling a gap.

## 3. Not in this round

- **A hint when someone tries to type into the grid or Detail.** It would need a reliable way to tell an
  attempt to edit from ordinary keyboard browsing, and with Raw visible by default the need largely goes
  away.
- Migrating saved layouts (§ 2.1).

## 4. Verification

- `test/layout.test.ts`: the default is Tree + Detail + Raw, and the reachable set is still exactly
  § 4.1's five.
- A saved layout is untouched, and a missing one gets the new default.
- **Each Raw-dependent command, with Raw hidden,** reveals it and then does its job:
  - the caret lands at the target;
  - wrap toggles.
- In the built app, from a fresh profile: Raw is visible on first launch, and hiding it survives a
  restart.
- The renders (§ 2.2) and measurements (§ 2.4) are in the results.

## 5. Results

### What landed

- **The default is Tree + Detail + Raw, with Raw at 30%** (`layoutLogic.ts`'s `DEFAULT_PANE_VISIBILITY`,
  `layoutStore.ts`'s `rawHeight`). A saved layout is read as before, so it is kept.
- **Five commands show a hidden Raw, then act**, through `rawController.ts`'s `withRawView`:
  - Locate in Source;
  - Soft Wrap;
  - Focus Raw Source (Ctrl+3), which did nothing with Raw hidden, as § 2.3 suspected;
  - next/previous diagnostic;
  - the palette's `:` jump.

  A hidden Raw is not mounted, so the action waits for the view to register and runs after that
  commit's effects. It has to: the pane registers with the focus model in an effect that runs after
  Raw's own. With no ready document, the command does nothing and the layout is not touched.
- **The palette's `@` jump and the scrubber are unchanged.** They bring along a Raw that is already
  visible, but a node is not a place in the source, so they don't show a hidden one.
- `scripts/screenshot-panes.mjs` (R197) no longer toggles Raw on: on a fresh profile that toggle would
  now hide it.
- `CONCEPT.md` § 4.1, D-115, and `FINDINGS.md`'s minified-wrap entry.

### § 2.2: the renders, and the height

`cars-10mb.xml` on a fresh profile, in the built app, at four shares. Rows means fully visible grid
rows; "overflow" means the Detail pane is taller than its space and scrolls around the grid.

| Window | 40% | 30% | 25% | 20% | Raw hidden |
|---|---|---|---|---|---|
| 1280×800 | 6 rows, **overflow 9 px** | 8 rows | 9 rows | 11 rows | 17 rows |
| 1024×700 | 4 rows, **overflow 69 px** | 6 rows, **overflow 8 px** | 7 rows | 7 rows | 13 rows |
| 1440×900 | 7 rows | 11 rows | 12 rows | 14 rows | 21 rows |
| 1920×1040 | 11 rows | 15 rows | 17 rows | 19 rows | 27 rows |

Raw shows 14, 10, 8 and 6 source lines at 1280×800, and 12, 8, 7 and 5 at 1024×700.

**The plan's 40% was wrong**, and only the renders showed it. Below the grid's 230 px floor (R43),
plus the breadcrumb, heading and attributes above it, the pane overflows. 25% was recommended, as the
largest share that fitted every window rendered. **The project lead chose 30%**, accepting the 8 px
overflow at 1024×700.

### § 2.4: measured, Raw hidden against visible

Built app, Electron 44.4.5, the development machine, temporary profiles, median of three (R221's
method). Opens are timed to the Tree's first row; the 500 MB fixture from its size prompt's Continue.

| Case | Raw hidden | Raw visible |
|---|---|---|
| Open `cars-100mb.xml` | 3.68 s, 669 MB | 3.60 s, 663 MB |
| Open `cars-200mb.xml` | 6.22 s, 957 MB | 6.41 s, 959 MB |
| Open `cars-500mb.xml` | 14.05 s, 1,814 MB | 14.18 s, 1,815 MB |
| **Switch into a `cars-10mb.min.xml` tab** | **96 ms** | **2,445 ms** |

With Raw visible, Raw's first line appears within 30 ms of the Tree's first row.

**The tab switch is far past the 15% bar, and was reported, not accepted silently.** It is the wrap
cost `FINDINGS.md` already recorded for a single-line window: R223 does not add it, but makes it the
default. **The project lead accepted it** rather than fixing it first (D-115). `FINDINGS.md` names the
lever if it is ever wanted: a smaller window for single-line documents.

### Verification

- **`test/layout.test.ts`:**
  - the default is Tree + Detail + Raw;
  - the reachable set is still § 4.1's five;
  - `showRawPane` shows Raw from both layouts that hide it, and is a no-op otherwise;
  - on a fresh module load, as a restart does: no saved layout gives the new default at 30%, and a
    saved one with Raw hidden is kept and not rewritten.
- **`test/rawReveal.test.tsx`, in Chromium:** each of the five commands, from Raw hidden, does its
  job:
  - Locate in Source, F8 and the `:` jump put the caret at the target;
  - Soft Wrap turns wrap on;
  - Focus Raw Source and the `:` jump leave the keyboard in Raw.

  A sixth case checks that with no document open, nothing is shown or saved. Three mutations of
  `rawController.ts`, run while writing it:
  - no reveal: all five reveal cases fail;
  - the pending action dropped: all five fail;
  - the action run synchronously instead of after the commit: the two focus cases fail.

  The Soft Wrap case passed under the second mutation at first. A short document fills less than the
  pane, so Raw wraps it by itself (`wrapPolicy.ts`). It now uses a document long enough to scroll.
- **In the built app, fresh profile:**
  1. Raw is visible at 30% on first launch, with no layout saved.
  2. Ctrl+Shift+R hides it and saves the layout.
  3. After a restart it is still hidden.
  4. Ctrl+3 then shows it, with the keyboard in it.
- **Full suite:** 190 files, 2,333 tests passed. Typecheck and lint clean.
  - One earlier run of `npm test` hung for over 20 minutes in the browser project and was stopped.
  - Each project then passed on its own, and the combined run passed in 64 s. The hang did not
    repeat and its cause is unknown.

### Review

Read from `git diff` after the work, against the invariants and this plan. Nothing to fix:

- No invariant is touched; the change is layout state and command routing.
- The reveal goes through `toggleRaw`, so it cannot reach a layout § 4.1 forbids.
- Each claim above is backed by a test, a mutation or a measurement of the code that landed.

**One edge case is noted rather than handled.** A pending action waits for the next Raw view to
register in the same tab. If a reveal ever failed to mount Raw, the action would run at a later mount
of that tab's Raw. With a ready document, showing the pane always mounts Raw, so this is unreachable
today, and the tab check bounds it.
