# R95–R97 — a recent files list on the start pane

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. One request: the start pane splits into two columns — recent
files with a Clear on one side, today's open-a-file content on the other. Related:
`docs/plans/R24-tabs.md` §7 (R29, session restore, which is *not* this), and
`docs/plans/R84-settings-group.md` §R85, **whose stated reason this round falsifies** (§6).

**Every question in this document is settled — nothing here is waiting on a decision.** Where a
choice was made rather than derived, the section says so and gives the reason.

---

## 1. What exists, and what does not

**There is no recent-files list to reuse, and the thing that looks like one is not one.**
`persistSessionState()` (`sessionRestore.ts`) writes `{ paths, activeIndex }` for the **currently
open tab set**, overwriting the key on every relevant change. Close a file and it is gone from
`nodepad.sessionRestore` immediately — it is a snapshot of *now*, not a history. R95 needs its own
store.

Four things that do exist and remove most of the work:

- **Exactly one place records that a document opened.** `phase: 'ready'` appears as a *transition*
  at `documentSession.ts:797` and nowhere else — every other `setState` in the file spreads
  `...state` and preserves the phase. So a reparse, a transform and a dirty-flag change do **not**
  re-enter it. `path`, `document.fileName` and `document.formatId` are all in scope there. One line
  covers `openPath`, the Open dialog, drag-and-drop *and* session restore, with none of the per-tab
  subscription machinery `sessionRestore.ts` needs for its own job.
- **`formatGlyphOf(formatId)`** (`TabStrip/tabDisplay.ts:56`) already maps a format to its `<>` /
  `{}` / `[]` marker — the one R83 just re-monospaced. Storing `formatId` with the entry means a row
  needs no format re-detection at render time.
- **`splitForMiddleTruncation`** (`textTruncate.ts`) already does head-ellipsis-with-visible-tail,
  and is already used by both `TabStrip.tsx` and `TitleBar.tsx`. A path row is exactly its case: the
  end of a filename carries the extension, and the end of a directory is the part that identifies
  it.
- **`theme.ts`** is the subscribable module-store shape to copy (`getX` / `setX` / `subscribeX` over
  a `Set<() => void>`), read through `useSyncExternalStore`; **`sessionRestore.ts`'s
  `isPersistedSession`** is the validator shape, where corrupt or hand-edited JSON degrades to "no
  entries" rather than crashing on launch.

## 2. R95 — the store, the recorder, and the command

New `src/renderer/session/recentFiles.ts`, key `nodepad.recentFiles`, cap **6** as requested.

```ts
interface RecentFile {
  readonly path: string
  readonly fileName: string
  readonly formatId: string
}
```

**Paths only, never content** — the same rule `sessionRestore.ts` states for itself, and worth
restating here because this list is now the longer-lived of the two.

`recordRecentFile(entry)` moves an existing path to the front, prepends a new one, truncates to 6.
**The guard that matters: if the path is already at index 0, return before writing** — no
`localStorage` write, no listener notification, so a component subscribed to this store never
re-renders for a no-op. Given §1 that guard is belt-and-braces rather than load-bearing, which is
exactly why it should be there: it makes the recorder safe to call from anywhere without re-deriving
whether that site can fire twice.

**Two call sites, both named:**

- `documentSession.ts:797`, the ready transition — every successful open.
- `documentSession.ts:1952`, where Save As sets `filePath: picked.path` — **decided to include**.
  After a Save As the document you are editing *is* that path, and a recent list that cannot offer
  the most recent file of all is wrong. It costs one call because the dedup guard handles everything
  else.

**Session restore reorders the list on launch**, since restoring a tab calls `openPath` and so
passes through the same transition. Considered and accepted: the entries are unchanged, only their
order among themselves, and "recently opened" is still literally true of a restored tab.

### Clear is a command; the file rows are not

Invariant 10 covers **commands**, and the distinction is worth stating rather than assumed:

- **The six rows are data**, the way tree rows and tab-strip entries are data. Clicking one is a
  selection, not a command, and six dynamically-generated commands would be a different feature.
- **Clear is an action**, so it is registered: `nodepad.document.clearRecentFiles`, title `Clear
  Recent Files`, category `File`, `surfaces: ['palette']` — matching `nodepad.document.open`'s own
  id shape. The button in the start pane invokes it through `runCommand`, the way `Layout.tsx`'s
  pane-header buttons already do, rather than calling the store directly.

It is gated with `when` on a new `hasRecentFiles` context key, hidden rather than disabled — the
reasoning `session/commands.ts` already gives for undo/redo: "rather than leaving an always-enabled
command that's silently a no-op most of the time."

**No confirmation.** §11.2's soft-cap pattern is for operations whose size is the risk; clearing six
paths costs nothing to rebuild.

## 3. R96 — clicking a recent file opens it *in the current tab*

Not `openPathInNewTab`. The two existing open paths already disagree deliberately, and the reason
settles this:

| Trigger | Calls | Why |
|---|---|---|
| Palette / title bar `Open File…` | `openNewTab()` | R26: Ctrl+O must not silently discard the active tab's document |
| **Start pane** `Open File…` button | `activeSession.openFileDialog()` | you are already looking at an empty tab; a new one would strand this one |

A recent-file click happens on the start pane, which means the active tab is empty. So
**`activeSession.openPath(path)`**, matching the button six inches to its left. Opening a new tab
there would leave a blank tab behind on every single click.

## 4. R96 — the two-column start pane

`DocumentArea`'s `empty` case becomes:

```
              No document open.
  ┌─ Open ──────────────┐  ┌─ Recent ─────────────┐
  │ Ctrl+O / drag hint  │  │ <> cars.xml   ~/data │
  │ [ Open File… ]      │  │ {} pkg.json   ~/proj │
  │                     │  │ …                    │
  │                     │  │ Clear                │
  └─────────────────────┘  └──────────────────────┘
```

**`No document open.` moves above both columns** — it describes the whole state, not the left half,
and hoisting it is what lets both columns carry a heading without one of them looking bolted on.

**Open on the left, Recent on the right.** On a fresh install the Recent column is empty, and a
leading empty column reads as a broken layout; the primary action also belongs first in reading
order and in tab order. One line to swap if it looks wrong in practice.

**`flex-wrap`, not a media query.** `.document-area-start` is a flex row with `flex: 1 1 260px` on
each column and `flex-wrap: wrap`, so narrow windows stack the columns with no breakpoint to get
wrong and no dependence on how zoom interacts with media queries (R59's own trap). This is R89's
lesson applied on purpose: a fixed floor (`min-width: 200px`) is what let the Find bar's controls
spill out of the window, and wrapping degrades by stacking instead of overflowing. Open stays on top
when stacked, which is also the right order.

`.document-area` sets `text-align: center` and `max-width: 480px` on its phase children; the start
layout overrides both (`text-align: left`, a wider max around 720px). Rows hover on
`--row-hover-bg`, which `.document-area button:hover` already uses — invariant 9, no new colour.

**A row shows** the format glyph, the file name, and the directory in `--surface-fg-secondary`, both
strings through `splitForMiddleTruncation`, with the full path as `title`. **The directory is always
shown**, which is what makes two files of the same name in different folders distinguishable without
importing `tabLabelsOf`'s same-name disambiguation rule.

**Six plain `<button>`s, not a roving tabindex group.** `rovingTabIndex.ts` exists and R62 used it to
collapse a 23-stop grid header, but the reason there was that the count was O(columns). Six is not a
problem, and a roving group would make Tab skip five files the user can see. Native buttons also get
Enter and Space for free.

**No autofocus.** A new empty tab appearing should not take the keyboard; R69 focuses a pane after an
*open*, deliberately, and this is the state before one.

## 5. R97 — the stale entry, and the dead end it lands in

A recent file can be deleted, renamed or on an unmounted drive. `openPath` never throws — every
failure degrades to the `'error'` phase, which is exactly how `sessionRestore.ts` reads back whether
a restore worked — so clicking a stale entry already produces an honest message. Two things are
still wrong:

**The entry stays in the list.** Decided: a failed open **removes that entry**, so the next thing the
user sees does not offer them the file that just failed. No pre-validation on render — six `stat`
IPC round-trips every time an empty tab appears, to grey out a row the user probably was not going to
click, is the wrong trade.

**And they cannot get back to the list.** `cancel()` handles only `confirmSize` and `parsing`
(`documentSession.ts:1328-1337`), so **nothing returns a session from `error` to `empty`** — the
error phase replaces the start pane, and the recent list is gone until something else opens
successfully. Decided: **the two-column start layout renders in the `error` phase too**, under the
existing error banner. It is the same component, it costs a case label, and it retires a dead end
`DocumentArea.tsx`'s own comment already frets about ("this button just avoids making the error state
a visual dead end"). `parsing` and `confirmSize` keep their focused single-purpose layouts — a file
list next to a running progress bar is an invitation to start a second open.

## 6. The R85 collision, which has to be resolved rather than noticed

`docs/plans/R84-settings-group.md` §R85 is still `open`, and decides that switching session restore
off **clears** `nodepad.sessionRestore`, on this stated reason:

> "Off" then means the app is not keeping a list of your recent file paths at all, which is what
> switching it off is for

**This round makes that sentence false.** After R95 the app keeps a list of recent file paths whether
or not session restore is on.

**Decided: two independent stores, and R85's conclusion stands.** They answer different questions —
"reopen what I had" versus "what was I working on" — and they have different lifetimes: closing a
file removes it from one and not the other. Turning session restore off does **not** clear recent
files.

**What makes that defensible is visibility, which is also what R85's argument was really about.**
The objection to a dormant `nodepad.sessionRestore` is that it keeps recording invisibly after you
switched it off. A recent-files list is on the screen, listing exactly what it knows, with a Clear
button next to it. That is the opposite failure mode.

**So R85's reasoning is amended and its conclusion kept** — the same move R90 makes for the
"no read-only badge" entry, and for the same reason: the sentence a future reader would rely on is
the one that has to be true. The amendment lands in this round's first commit, not R85's, because
R95 is what falsifies it and R85 may not be built yet. Corrected text scopes the claim to what it
actually covers: *off means the app does not reopen your files and does not keep a record of which
tabs were open; the start pane's recent list is a separate, visible feature with its own Clear.*

**No `Settings: Remember Recent Files` toggle in this round.** The Clear button is the control, and
one is enough until someone wants otherwise; if it is ever wanted, R84's new `Settings` category is
where it goes.

## 7. Order and definition of done

**R95 → R96 → R97.** R95 is the store the pane renders; R97 needs the pane to exist before it can
keep it alive through an error.

- [x] R95 — cap of 6; a repeat open moves the path to the front rather than duplicating it; corrupt
      or hand-edited JSON degrades to an empty list rather than throwing; `clearRecentFiles` empties
      it.
- [x] R95 — **recording fires once per successful open**, asserted by counting store notifications
      across a reparse and a burst of edits, not by eye. And a Save As to a new path records it.
- [x] R95 — `nodepad.document.clearRecentFiles` is palette-reachable (the blanket invariant-10 test
      in `test/commands.test.ts` covers this once it is registered) and is hidden, not disabled,
      when the list is empty.
- [x] R96 — clicking a recent file opens it **into the active tab**: the tab count is unchanged,
      asserted, since the tempting `openPathInNewTab` would strand a blank tab on every click.
- [x] R96 — the columns **stack rather than overflow** at narrow widths, asserted by shrinking the
      layout in a test rather than by eye. R89's defect is the precedent: nothing may leave the
      window.
- [x] R96 — the empty state reads `No recent files.` rather than rendering an empty box, and the
      Clear button is absent there.
- [x] R97 — a click on a path that no longer exists produces the error message, **removes that entry
      from the list**, and leaves the recent list on screen so a second file can be tried.
- [x] §6's amendment to `docs/plans/R84-settings-group.md` lands in the same commit as R95.

## 8. Results

Landed in order: R95 (`8822aaf`), R96 (`789efb0`), R97 (`3419ab3`). No deviations from the design.

One structural note for a future reader diffing this against the code: `openPath` in
`documentSession.ts` is now a thin wrapper (`attemptOpenPath` does the actual work) so R97's
"check the settled phase, remove if `error`" logic covers every failure branch — a `stat` throw for
a deleted file, the hard-ceiling/soft-cap paths, and a `startParse` failure — from one place rather
than four. `confirmOpenAnyway`'s own `startParse` call (the soft-cap confirmation path) is not
wrapped the same way; a stale recent file large enough to hit the soft cap and then fail on
confirmation keeps its entry. Judged acceptable rather than fixed: the common case (a deleted or
renamed file) fails at the `stat` call, inside the wrapped path, before any size check runs.

Test coverage: `test/recentFiles.test.ts` (the store, pure; the two `documentSession.ts` recording
sites and the R97 removal, via the same fake-parse harness `test/documentSession.test.ts` and
`test/sessionRestore.test.ts` use) and `test/recentFilesUi.test.tsx` (the two-column layout, the
click-into-active-tab behaviour, narrow-width stacking measured in real Chromium, and the R97
UI round-trip).
