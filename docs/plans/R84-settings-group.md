# R84–R85 — a Settings category, and session restore becomes a choice

<!-- status: open -->

**Open.** Register: `docs/TASKS.md`. Two related asks: session restore should be optional, and the
stateful commands accumulating across `View` and `Edit` should get a home of their own. Related:
`docs/plans/R66-palette-polish.md` (R66 made the category part of the *searchable* string, R68 gave
toggles their On/Off badge), `docs/plans/R65-shortcuts-help.md` (the panel that groups by category),
and `docs/plans/R24-tabs.md` §7 (R29, which built session restore). **`docs/plans/R95-recent-files.md` §6 amends R85's
stated reason** (see the decision below); its conclusion is unchanged.

**Every question in this document is settled — nothing here is waiting on a decision.** The one
thing deliberately left open (whether the layout and wrap toggles eventually follow Theme into
`Settings`) is a matter of taste and is *not* a blocker: `View` is the answer for now.

---

## 1. R84 — the Settings category

There are **six** toggle commands today, not three — every command with a `state: () => …`, which
R68 established as the toggle contract:

| Command | Title | Category now | Surfaces | Chord | Persisted |
|---|---|---|---|---|---|
| `nodepad.layout.toggleTree` | Tree Pane | View | palette, **titleBar** | `Ctrl+Shift+T` | yes |
| `nodepad.layout.toggleDetail` | Detail Pane | View | palette, **titleBar** | `Ctrl+Shift+D` | yes |
| `nodepad.layout.toggleRaw` | Raw Pane | View | palette, **titleBar** | `Ctrl+Shift+R` | yes |
| `nodepad.raw.toggleWrap` | Soft Wrap | View | palette, **paneHeader** | `Ctrl+Shift+W` | no |
| `nodepad.theme.toggle` | Dark Theme | View | palette | `Ctrl+Shift+L` | yes |
| `nodepad.document.toggleFormatMinifiedOnOpen` | Format Minified Files on Open | Edit | palette | — | yes |

**"Is it a toggle" is the wrong axis.** The four at the top are working controls you reach
mid-task — they change what you are looking at *right now*, and each already has a faster way in
than the palette. Filing them under Settings would mean typing `settings tree pane` to hide a pane,
which is worse than today.

The distinction that matters is **does it change what you see now, or what the app does next time.**

### What moves

- **`nodepad.document.toggleFormatMinifiedOnOpen` → `Settings`.** Changes how a *future* open
  behaves. Palette-only, no chord.
- **`nodepad.theme.toggle` → `Settings`.** Decided by the report rather than by the criterion below,
  and it is the right call: a theme is a preference about the application, not a property of the
  document being viewed, and it is the one toggle you set once and forget. It keeps `Ctrl+Shift+L` —
  a category is how a command is *found*, not whether it has a shortcut.
- **`nodepad.sessionRestore.toggle` → `Settings`.** New, R85 below.

Everything else stays in `View`. Whether the layout and wrap toggles eventually follow is a matter
of taste and explicitly left open; `View` is fine for now.

### The rule, so the next one lands correctly

> A command belongs in **Settings** if it changes what the app does on a *future* action rather than
> what is on screen now. In practice that means it has no surface outside the palette. `Dark Theme`
> is the deliberate exception — it has a chord because it is worth reaching quickly, and it is still
> a preference.

Write this into `builtins.ts` next to the category, not only here.

### Two traps, both silent

**a. `CATEGORY_ORDER` is a hard-coded array and unknown categories sort to the front.**
`Shortcuts.tsx:100`:

```ts
const CATEGORY_ORDER = ['File', 'Edit', 'Navigate', 'View', 'Help']
…
const categories = [...byCategory.keys()].sort(
  (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)
)
```

`indexOf` returns **-1** for a category not in the list, so `Settings` sorts *above `File`* — first
in the shortcuts panel — with no error and nothing to notice unless you open the panel.

This bites specifically because of Theme. The panel skips commands with no chord
(`Shortcuts.tsx:162`, `if (chord === null) continue`), so `Format Minified` and `Restore Session`
would never appear and the trap would stay dormant — **`Dark Theme` moving is what makes a
`Settings` section exist there at all.** Add `'Settings'` to `CATEGORY_ORDER`, after `View`.

While there: an unknown category silently sorting first is worth fixing beyond this one case. Either
sort unknowns last (`const i = CATEGORY_ORDER.indexOf(a); return i === -1 ? Infinity : i`) or assert
in a test that every category a command declares appears in `CATEGORY_ORDER`. **Prefer the test** —
it fails at the moment someone adds a category, which is when they can still act on it.

**b. The category is part of the searchable string.** R66 made the palette match and render
`${category}: ${title}`, so `View: Dark Theme` becomes `Settings: Dark Theme`. Anyone who has
learned to type `view dark` now gets nothing. That is the intended cost of the move — it is also the
benefit, since `settings` now finds all three — but it is a behaviour change to muscle memory and
belongs in the LOG entry rather than being discovered.

### Tests

`test/commands.test.ts` already has category coverage. Add: every command's `category` is one of the
known set (which now includes `Settings`), and the three named above are in it. That is also the
guard for trap (a) if you take the test option.

---

## 2. R85 — session restore becomes a setting, default off

Today it is unconditional. `main.tsx:19` calls `beginSessionRestore()` before the first React
render, and `sessionRestore.ts` explains why it cannot be an effect:

> **Must run before the first React render**, not from a `useEffect` — every pane/store reads
> `getActiveSession()`, which lazily mints an empty tab the instant nothing is active yet.

So the gate has to be read **synchronously, before render**. `settings.ts` is already synchronous
`localStorage` access with the `typeof localStorage === 'undefined'` guard, so this is the shape
that already exists — add `getRestoreSessionOnLaunch()` / `setRestoreSessionOnLaunch()` beside
`getFormatMinifiedOnOpen`.

**Default off.** The report is explicit about not wanting it in general.

### The decision inside it: what happens to the stored paths when it is off

`persistSessionState()` writes `{ paths, activeIndex }` to `nodepad.sessionRestore` on every
relevant tab change, via subscriptions `startSessionPersistence()` sets up. Two options when the
setting is off:

- **Keep writing, skip only the restore.** Turning it on then works from the next launch with no
  gap.
- **Stop writing and clear the key.** Recommended. "Off" then means the app does not reopen your
  files and keeps no record of which tabs were open, which is what switching it off is for; the cost
  is that turning it on does nothing until you have opened something afterwards.

  **Amended by R95** (`docs/plans/R95-recent-files.md` §6), which adds a start-pane recent-files
  list and so makes the original wording here — "the app is not keeping a list of your recent file
  paths at all" — false. The **conclusion is unchanged**: still stop writing, still clear the key.
  What changes is the scope of the claim. The two stores are independent and answer different
  questions, and what makes that defensible is the thing this argument was really about: a dormant
  `nodepad.sessionRestore` records invisibly after you switched it off, while a recent-files list is
  on the screen showing exactly what it knows, with a Clear button beside it.

Take the second. It is the behaviour the setting's name implies, and a feature that is off should
not still be recording.

### An asymmetry worth putting in the title

Turning it **off** acts immediately (the stored session is cleared). Turning it **on** does nothing
visible until the next launch. Name the command for the moment it applies —
**`Settings: Restore Session on Launch`** — rather than "Session Restore", so the label itself says
when it takes effect. No notification: R21's notifications are for things that happened to a
document, and a preference that reads its own state back as an On/Off badge (R68) already shows what
it did.

### Tests

- Off (the default) → `beginSessionRestore()` restores nothing and the app starts with one empty tab.
- On → the existing restore behaviour, unchanged. `resetSessionRestoreForTests()` already exists for
  the one-shot guard.
- Switching off clears `nodepad.sessionRestore` and stops further writes.
- Invariant 10 is automatic here (the command is palette-first), but the existing palette-coverage
  test will pick it up either way.

---

## 3. Considered and rejected: the origin as the Find input's placeholder

Raised while reviewing R78 as built — render the path query as the Find input's placeholder text
instead of as a chip, so it clears by itself when you type.

**Rejected, and the deciding reason is that placeholder styling means "nothing here yet."** Using a
hint slot to display live state says the opposite of what is true. The rest, in order:

- **The advantage is already delivered.** The chip clears the moment you type —
  `test/findBarOrigin.test.tsx:83` asserts exactly that. So the trade was never "gains auto-dismiss
  versus costs chrome"; it was only "less chrome, and here is what goes with it".
- The **✕ disappears**, and it is the only way to drop a path result while keeping Find open.
- A placeholder **cannot be selected or copied**, which was R74's own stated reason for preferring
  the origin-in-the-bar shape ("it answers *what would I edit to change this*").
- A placeholder is **not an accessible name or value**. With `aria-label="Find"` on the input, a
  screen reader announces "Find, blank" over 1,202 live matches.
- Long paths **clip** in a `min-width: 200px` input, with no way to see the rest.

The one real argument for it was **bar width**, and it stands: chip + input + count + two toggles +
three buttons is a lot for a narrow window. If that becomes the problem, middle-elide the chip
(`…/elements/car[2]/name`) rather than moving it into the placeholder and losing the dismiss control
and the accessible text with it.

---

## Definition of done

- [ ] R84 — a `Settings` category exists; `Dark Theme`, `Format Minified Files on Open` and R85's
      new toggle are in it; everything else stays in `View`. `Ctrl+Shift+L` still works.
- [ ] R84 — `'Settings'` is in `Shortcuts.tsx`'s `CATEGORY_ORDER` (after `View`), **and** a test
      fails if any command declares a category that array does not know.
- [ ] R84 — the rule for what belongs in Settings is a comment in `builtins.ts`, not only in this
      file.
- [ ] R85 — `Settings: Restore Session on Launch`, default **off**, gating `beginSessionRestore()`
      synchronously before the first render.
- [ ] R85 — switching it off clears `nodepad.sessionRestore` and stops further writes; tests cover
      off, on, and the clear-on-off transition.
- [ ] The category rename is called out in `docs/LOG.md` — `view dark` stops matching, `settings`
      starts finding all three.
