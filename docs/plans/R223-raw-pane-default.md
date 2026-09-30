# R223 — the Raw pane is shown by default

<!-- status: open -->

**Open.** Raised by the project lead for 1.2.2: *"a new user doesn't know that the raw view must be
enabled in order to edit."* The recommendation below was reviewed and accepted as written; this plan
records it.

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
