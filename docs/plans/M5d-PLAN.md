# M5d — NodePad draws its own title bar

<!-- status: built -->

**Status: built.** Tasks **R1–R7** (`docs/plans/M5d-RESULTS.md`). Tasks **R1–R7** — the first plan under `CLAUDE.md`'s `R` numbering, so
these ids stay fixed even if the work moves to a different milestone. Register:
`docs/TASKS.md`.

**D-055 settles what the title bar is for**: no toolbar row, but the title bar carries window-
and document-scope commands, pane headers carry pane scope only, and the palette carries
everything. Read it before moving any command between surfaces here.

Requested directly: make the title bar theme-aware by drawing it, move the pane toggles into
it, and retire the command bar. `assets/README.md` §Title bar already specifies the icon half of
this ("Later — a NodePad-drawn title bar"), and D-054a settled that it needs **no new raster
assets**: the mark is inline `mark-16.svg` with `currentColor` and a theme token.

**Tabs are out of scope and already designed** — see §4.

---

## 1. Why this is more than a CSS change

A native title bar is doing five things NodePad has been getting for free, and every one of
them has to be re-provided or deliberately given up:

| The OS does this today | What replaces it |
|---|---|
| Draws caption buttons that match the system | `titleBarOverlay` on Windows; traffic lights stay on macOS; Linux keeps its native frame (R1) |
| Windows 11 **Snap Layouts** on maximize hover | Only survives if the maximize button is the *system* one — the single strongest reason not to draw our own |
| Dims the bar when the window loses focus | A `focus`/`blur` channel to the renderer (R1) |
| Double-click to maximize, drag to move | `-webkit-app-region: drag`, with its own set of traps (R6) |
| Shows the window title | R5 renders it, and gains the dirty state the native bar never showed |

The trap worth naming loudest: **drawing your own maximize button costs Snap Layouts**, which
on Windows 11 is a real, frequently-used feature. `titleBarStyle: 'hidden'` combined with
`titleBarOverlay` gives a system-drawn caption strip whose colours we set and can change at
runtime — the whole point of this milestone — while keeping the button the OS knows about.
Use it. Do not hand-roll the three buttons on Windows.

---

## 2. Tasks

### R1 — The frameless window and the title bar shell

**Main process** (`src/main/index.ts`):

- Windows: `titleBarStyle: 'hidden'` plus `titleBarOverlay: { color, symbolColor, height }`.
  Seed the colours from the persisted theme so the very first paint is right rather than
  flashing light chrome; expose `win.setTitleBarOverlay()` over IPC for theme changes.
- macOS: `titleBarStyle: 'hiddenInset'`. Traffic lights stay and are placed by the OS, so the
  bar must reserve **~78px of left inset** for them — and collapse it in fullscreen, where
  they hide. Listen for `enter-full-screen`/`leave-full-screen` and tell the renderer.
- **Linux keeps its native frame for now.** Frameless on Linux means drawing all three buttons
  ourselves (no overlay API), against window managers whose conventions differ on button
  order, side and behaviour. Stated as a deliberate gap, not an oversight; the component
  should render without its caption region when the platform doesn't want one.

**Renderer** — `src/renderer/components/TitleBar/`:

- The app mark: **inline `mark-16.svg` as a component**, `currentColor` from a theme token.
  `#E9A33C` on dark, `#A9701E` on light, per `assets/README.md`'s palette. No raster, no
  light/dark file pair — D-054a's conclusion, and invariant 9 applies here like any component.
- `-webkit-app-region: drag` on the bar, `no-drag` on every interactive child.
- Height as a token, and **the same number must reach `titleBarOverlay.height`** — two
  unlinked literals here is exactly the `--scrubber-width` mistake M5b already made once.
- Focus/blur dimming from a main→renderer channel, since the OS no longer supplies it.

**Theme synchronisation is the fiddly part.** The renderer owns the theme; only main can call
`setTitleBarOverlay`. That is a new preload API surface — keep it to a single narrow
`titleBar.setOverlayColors(...)` rather than a general "call anything on the window" bridge.

**Acceptance.** The window drags, double-click maximizes, caption buttons work, Snap Layouts
still appear on maximize hover on Windows 11, and switching theme recolours the caption strip
without a restart. Verify by running the app.

### R2 — Pane toggles move into the title bar (D-055)

The three layout toggles in `Layout/commands.ts` are the *only* users of the `commandBar`
surface — verified, not assumed. So this is small:

- Add `'titleBar'` to `Surface` in `commands/registry.ts`.
- Change those three from `['palette', 'commandBar']` to `['palette', 'titleBar']`.
- The title bar renders `commandsForSurface('titleBar', context)` exactly as `CommandBar` does
  today, so icons, tooltips and `defaultChordFor` come along unchanged.

Invariant 10 holds for free: every one of them keeps `'palette'`, and the parity test is what
enforces that rather than discipline.

Panes stay **hidden**, not collapsed to a rail — D-055 settles that, and the reasoning is
there rather than repeated here.

**Acceptance.** The toggles work from the title bar; the palette-parity test passes unmodified.

### R7 — Document-scope controls in the title bar (D-055)

The other half of what the retired command bar owes a home to. D-055's rule is that the title
bar carries **window and document scope**; R2 moved the window half, this moves the document
half.

- **Save**, placed beside the filename and its dirty dot (R5) — the indicator and the action
  that clears it belong together.
- **Undo / Redo.** Note these are **document scope, not Raw scope**: a Transform mutates the
  byte buffer and is undoable below D-046's threshold with Raw uninvolved or hidden, which is
  why they must not go in Raw's pane header however natural that looks today.
- Open File… is R4's, and stays where the tab strip's "+" will go.

Mechanics:

- Add `'titleBar'` to each command's `surfaces`. All four icons — `save`, `undo`, `redo`,
  `document` — are already in `commands/icons.ts`'s Fluent map; no asset work.
- **Disabled, not hidden**, when unavailable. A Save button that vanishes on a clean document
  reflows the strip and destroys pointer muscle memory. This needs the registry to express
  enablement; if it can't yet, that is a real gap to report rather than route around by
  hiding.
- `tooltipFor` comes along unchanged, so every button keeps advertising its chord — D-055's
  point that a persistent surface buys *discovery*, not speed, and a button that teaches its
  shortcut is worth more than two that don't.

**Do not add anything else here.** The strip is deliberately ~6–7 controls; the constraint is
the design, and once tabs land (§11.4) this row is contested.

**Acceptance.** Save, Undo and Redo are reachable and correctly enabled/disabled without the
command bar; every one still appears in the palette (parity test); the strip has not grown.

### R3 — Retire the command bar

Once R2 lands, the bar contains only `DocumentStatus`. J8 (`M5c-PLAN.md`) is already moving
the `empty`/`parsing`/`confirmSize`/`error` phases out of it into the document area — **do J8
first, or do this task's share of it here, but not both.** What is left after J8 is the
ready-document alerts: the partial-parse banner, the minified-file banner, the pending
Transform confirmation.

Those are not toolbar content and should not go looking for a toolbar to live in. They become
a **slim alert strip directly under the title bar, present only when there is something to
say** — which is most of the time nothing. That is what actually removes the permanent
toolbar row the request is about; relocating the banners into the status bar would keep a
row's worth of chrome and make a two-line Transform confirmation illegible.

Delete `CommandBar`, `.command-bar*` styles, and the now-unused `'commandBar'` surface member.
Everything the bar owed a home to is placed by D-055's scope rule: window scope in R2,
document scope in R7, the open-file affordance in R4, banners here.

**Acceptance.** With a clean document open, no horizontal chrome exists between the title bar
and the panes. Opening a malformed file makes the banner appear and the panes shift down.

### R4 — Opening files without a toolbar

Two cases, and only the second is genuinely open:

- **No document open** — the Open button belongs in the document area, which J8 is already
  building. Nothing extra needed here beyond checking the two didn't drift.
- **A document is already open** — keep a single **"Open File…" icon button in the title
  bar**, the middle ground the project lead proposed. `Ctrl+O`, the palette and drag-and-drop
  all keep working regardless; this is the discoverable surface for people who don't know
  them yet.

Place it where the tab strip's "+" will go (§4), so introducing tabs later replaces this
button rather than rearranging the bar around it.

**Acceptance.** A file can be opened from a clean start and with a document already open,
without the command bar existing.

### R5 — The window title becomes the document

The native bar showed "NodePad" and nothing else. Now that the bar is ours:

- Filename, centred or leading — pick one and record it; don't leave it to CSS accident.
- **Middle truncation, never end truncation** — `CONCEPT.md` §11.4 already specifies this for
  tabs and the reasoning is identical here (the end of a filename carries the extension and
  usually the version or date). Implement it as a shared helper now so tabs inherit it.
- The **amber unsaved-changes dot** `assets/README.md` already reserves.
- Tooltip: the full absolute path.

Same-name disambiguation is a tabs problem (§11.4) and is not built here.

**Acceptance.** The title tracks the open document and its dirty state; a long filename
truncates in the middle.

### R6 — Platform and accessibility pass

The part most likely to be skipped, so it is its own task.

- **Drag-region traps.** `-webkit-app-region: drag` swallows text selection, context menus and
  sometimes the first click after the window regains focus. Every child that should be
  clickable needs `no-drag`, and the title text itself should not be selectable-looking if it
  isn't.
- **Keyboard.** The title bar must not become a focus stop that traps or that sits in front of
  the panes in tab order. Its buttons are real `<button>`s with labels.
- **High contrast / forced colors on Windows** — a hand-drawn bar is exactly what breaks
  there. Check it, and let `titleBarOverlay` do its own thing rather than fighting it.
- **macOS fullscreen**: inset collapses, nothing overlaps the traffic lights.
- **Linux**: confirm the native-frame fallback renders sensibly with no caption region.

**Acceptance.** Verified by running the app on Windows; macOS and Linux verified or explicitly
recorded as unverified — `M5c-RESULTS.md`'s precedent for a flagged gap rather than a smoothed
one.

---

## 3. Order

R1 → R2 → R7 → R3 (R3 needs J8 landed, or absorbs its share) → R4 → R5 → R6.

R7 before R3: the command bar should not be deleted until everything it held has somewhere to
go, or the app spends a commit with no reachable Save.

R1 is the only one with real risk. If `titleBarOverlay` can't be made to track the theme
cleanly, **stop and report** — that is the entire justification for the milestone, and a
custom title bar that isn't theme-aware is strictly worse than the native one.

---

## 4. Tabs — deliberately not here

The instinct that a "new tab" button solves the open-a-second-file question is right, and
**`CONCEPT.md` §11.4 already designs the whole thing**: per-tab state, a fixed 2–3 worker pool
rather than one worker per tab, context keys resolving against the active tab, session
restore, and a full tab anatomy (format icon with per-format tint, middle truncation, shared
dirty/close slot, ~120px minimum before the strip scrolls). Read it before planning tabs; it
does not need re-deriving.

What it does not say is what tabs cost *this* codebase, so: **the renderer currently has
twelve module-level singletons that assume exactly one open document** — `documentSession`,
`findStore`, `findController`, `activeSearchStore`, `navigationStore`, `rawController`,
`rawViewportStore`, `treeController`, `gridController`, `paletteStore`, `commands/context`,
and `layoutStore`. §11.4's "all document state is per tab" means most of those become
per-document instances behind an active-document lookup. That is a substantial refactor of the
renderer's spine, and it is why tabs are a milestone rather than a task.

The concrete instruction for this plan: **leave room for the strip.** R4's Open button goes
where "+" will go, and R5's truncation helper is the one §11.4 needs. Nothing else here should
assume a single document more deeply than it already does.

---

## 5. Out of scope

- **Tabs** (§4).
- **A Linux custom title bar** (R1).
- **Same-name path disambiguation** (§11.4, needs tabs to matter).
- **A custom menu bar.** `autoHideMenuBar: true` already hides it and nothing depends on it.
