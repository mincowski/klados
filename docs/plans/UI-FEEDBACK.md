# NodePad — UI feedback

<!-- status: superseded -->

A running list of observations from actually using the application, collected as they are
noticed rather than invented at planning time. **M2b (`CONCEPT.md` §12, D-034) is planned
against this file.**

Not everything waits for M2b. Anything that is plainly a defect, or basic behaviour a
control is expected to have, gets fixed in whatever milestone owns the component — M2b is
for cross-cutting look-and-feel work, not a queue to defer into. Entries record where they
were handled.

Add entries freely and roughly; sharpening them is the planning step's job, not the
noticing step's.

| Status | Meaning |
|---|---|
| `open` | noticed, not yet scheduled |
| `M2b` | scheduled for the polish milestone |
| `M5b` | scheduled for the fit-and-finish round after M5 (see "Round 2" below) |
| `done` | addressed, with the commit or task noted |

**Everything currently marked `M2b` is in scope for that milestone** — this file is what
its plan gets written against.

---

## Tree view

### Unfolding a node required hitting the disclosure triangle · `done`

Clicking a node's name selected it but did not unfold it, so expanding meant hitting the
small triangle — a 16px target on a 23px row (§9.4's density), and the only way in.

**Resolved in D8:** double-click anywhere on the row toggles it; the triangle stays as the
single-click shortcut.

Deliberately double-click rather than single: selection is the frequent action in this
pane — §4.1 makes Detail the primary working surface and D-018 has selecting a node show
that node — so a single-click toggle would reshape the tree under the pointer every time
you clicked through siblings to compare them in Detail. VS Code's explorer does toggle on
single click; XML Notepad, which §3.2's node model already follows, uses double-click.
One line to switch if the single-click feel turns out to be preferable in practice.

### Single-child chains should be separate rows, not one compacted row · `done`

Opening `cars-10mb.xml` and expanding `Document → garage → cars` shows those as a single
compacted row. Wanted: **every element its own level**, even an only child.

**Resolved in D-034a:** compaction is removed. Expanding a node now auto-expands its
single-child descendants recursively (`autoExpandChain` in `treeModel.ts`), bounded by
`MAX_AUTO_EXPAND_DEPTH`, and collapsing treats the chain as one unit. Every level is its
own row and individually selectable, as requested by the counter-proposal below.

**This reverses a settled decision, so it needs recording as one** rather than being done
quietly. §4.3 and D-015 both specify the Tree compacting single-child chains into one row
(`cars › elements`), citing VS Code's explorer compacting `src/main/java`, and describe it
as "a setting, on by default." The setting exists — `treeCompactionStore.ts`, toggled by
`nodepad.tree.toggleCompaction` — so the mechanical change is small: default it off, or
remove the compaction path entirely if it turns out nobody wants it on.

The reasoning behind the original rule is worth keeping in view before deleting it: the
Detail view's *transparent wrapper* descent (E2) is a separate mechanism solving a related
problem, and it should stay regardless. A grid for `cars` that shows one row containing the
word "elements" is useless in a way that a Tree row per level is not — the Tree is a
structure view, where showing the structure is the point, and Detail is a contents view,
where the wrapper genuinely is noise. Turning off Tree compaction does not argue for turning
off wrapper descent.

**The counter-proposal in the report is better than either.** *"When I open a node and it
has a single child node, unfold that child as well"* — recursively, presumably, down to the
first node with more than one child. That gets the click-saving compaction was for while
keeping every level visible and individually selectable, which is what compaction gives up.
It also composes with the existing expand-on-double-click and arrow-key expansion rather
than being a display mode with its own state.

Two things to settle when building it: whether auto-expansion is bounded (the same
degenerate deep-chain case `DEFAULT_WRAPPER_DESCENT_DEPTH` guards against), and whether a
node auto-expanded this way collapses back as one unit or level by level. Collapsing as one
unit is probably right — it makes the pair of actions symmetric — but it is worth trying
both before committing.

---

## Detail view

### Grid header cells overlap the first rows · `done`

Confirmed, with one root cause shared with the entry below. `.grid-header-row .grid-cell`
sets `flex-direction: column`, so the kind glyph, the sort label and the filter input stack
*vertically* — roughly 45 px of content — inside a header row whose height is
`ROW_HEIGHT`, **23 px**. It overflows by about double and spills over the first one or two
body rows.

**Fixed** alongside the entry below — `flex-direction` is `row` now, and the filter box
moved into its own toggled row (see below), so nothing stacks past 23px any more.

### Grid header cells should be one line — and the corner button is "pin" · `done`

Icon, label and filter on one line, as reported. Fixing the stack fixes the overlap above;
they are the same bug seen from two sides.

**The button is Pin**, and the guess in the report is right: pinning moves the column to
the left of the scrolling region, next to the row-number column, so it does "shift the cell
to the start". It reads as mystery furniture for three reasons worth fixing together —
it is `position: absolute; top: 2px; right: 2px` (so it is nowhere near the other controls
and is the only absolutely-positioned thing in the cell), its label is `◇`/`◆` (a diamond
that says nothing about pinning), and its only explanation is an `aria-label` that a mouse
user never sees. It wants a real icon (§9.5), a `title`, and a place in the same row as
everything else.

**Where the filter goes — decided: a toggled filter row, not a per-column icon.**

Icon + label + a live filter box genuinely do not fit on one 23 px line at a 160 px column
width, so the filter has to move. Two candidates were considered: a filter icon *per header
cell* that reveals that column's box, or one control above the table that reveals a filter
box for *every* column at once.

**The second, for a reason that is easy to miss: a filter that is set must never be
hidden.** Hiding an active filter means the grid is silently showing a subset of the
document, which is the one thing a data inspector must not do. That single requirement is
what separates the two options:

- With a **filter row**, the rule is trivial — the row auto-opens when any filter is set,
  and the toggle cannot hide a row that has content (or hiding clears the filters, stated
  explicitly). One rule, one place.
- With a **per-column icon**, the header must *also* grow an "this column is filtered"
  indicator, or a filtered column scrolled off-screen is invisible. So that option ends up
  building both the icon and the indicator — more furniture in the cell that had too much
  furniture to begin with, which was the original complaint.

The filter row also has nowhere to fight for space: it is its own row at its own height, so
the header cell goes back to one comfortable line of `pin · glyph · label · sort arrow`, and
the overlap above resolves as a side effect rather than needing a second fix.

**Fixed.** The header cell is one flex row now (`pin · glyph · label + sort arrow · filter
dot`); the pin button lost its `position: absolute` and sits in that row like everything
else, and gained a `title` alongside its `aria-label` (still `◇`/`◆` — §9.5's icon resolver
is a separate, still-open M2b entry, not part of this fix). The filter row is a new
`GridFilterRow`, toggled by a "Filters" button in `.grid-toolbar`, reusing
`GridHeaderRow`'s own pinned/virtualized column geometry so pinned and scrolled columns line
up for free. It auto-shows whenever any per-column filter is set and cannot be closed while
one is — the toggle clears the filters instead, per the rule above. A filtered column gets
a small dot next to its label so the state survives scrolling away from the filter row.

**Also found and fixed while verifying this in the running app:** pinning a column already
misaligned its body cells by one row (`git show HEAD:...Grid.css` has no `.grid-row {
display: flex }` rule, so the "#" cell and any pinned cell — all `position: sticky`, which
stays in normal flow unlike the virtualized `absolute` cells — stacked vertically as block
boxes instead of sitting side by side). Pre-existing, not introduced by this fix, but the
new filter row reuses the exact same pinned-cell pattern, so it would have inherited the
same bug. Fixed by adding `display: flex` to `.grid-row`, `.grid-header-row` and
`.grid-filter-row`.

Specifics worth fixing now so they are not re-litigated:

- **The toggle lives in the existing `.grid-toolbar`**, which already holds the quick-filter
  box, the column picker and the copy buttons. No new surface needed. A funnel icon (§9.5)
  with `aria-pressed`.
- **The two filters stay distinct and both stay.** Quick filter answers "find anything in
  this table"; column filters answer "narrow this field". The toggle governs only the
  per-column row.
- **Mark filtered columns on the header cell itself** — a filled funnel or a dot — so state
  survives scrolling horizontally away from the filter row. This is cheap here because the
  row already guarantees the filter is reachable; it is an *indicator*, not a control.
- **The filter row reuses the column virtualizer's geometry.** `GridHeaderRow` already maps
  `colVirtualizer.getVirtualItems()`; the filter row maps the same items, so pinned and
  scrolled columns line up for free.

### Grid takes ~2.6 s to appear on a 200 MB file · `done`

Found by review, not by use — but you will feel it as soon as you select a large group.
Two causes, both implementation rather than design, both fixable without the trade-off
`M2-RESULTS.md`'s open decision describes: `isNumericColumn` decodes every member of every
numeric column to decide text alignment (1522 ms), and `collectColumns` allocates two
`Map`s per member (1122 ms, ~3× more than it needs). Together ~2644 ms → ~370 ms.

**Fixed:** 2644 ms → **417 ms** at 200 MB, 985 ms at 500 MB. `isNumericColumn` now
samples 200 values within 5,000 rows; `collectColumns` uses a reused scratch array instead
of two `Map`s per member.

### The Detail header repeats itself and shows the wrong facts · `done`

Currently an `<h2>` with the node's name, then a `Kind / Name / Children / Source`
definition list. Three problems, and the report is right on all three.

**"Name" is always redundant.** The heading renders `name ?? kindLabelOf(kind)` and the
Name row renders only `when name !== null` — so the row exists in exactly the cases where
the heading already shows the same string, and is hidden in exactly the cases where it would
have told you something. To answer the question directly: the heading differs from the name
only for unnamed nodes (array elements, `Document`, `Text`), and there the row isn't drawn.
Delete it.

**"Source" belongs to the Raw view.** `line 4213` is a fact about where the bytes are, and
the Raw view plus the scrubber already answer it — better, because they show it rather than
stating it. (Keep `sourceRangeLabel` itself: it is exact as of the `LineIndex` work, and
still wanted for the status bar and for `Locate in source`.)

**"Kind" should be an icon, not a row.** `glyphOf(kind)` already exists and the Tree uses it
per row, so the Detail heading can carry the same glyph and stay consistent with what the
Tree just showed for the same node.

**The heading needs to look like one.** `.detail-node-title` sets only `overflow-wrap`, so
an `<h2>` sits at whatever the reset gives it — currently indistinguishable from the `<h3>`
"Attributes" and "Children" below, which are explicitly `--font-size-ui`. It should be
clearly larger.

A shape worth trying, rather than a specification:

```
  ⬢  car                                        6 children
     garage › cars › elements
```

— kind glyph and name on one line as the heading, the child count as a quiet count on the
right (it is the one fact that genuinely belongs to the node and isn't visible elsewhere),
and the existing breadcrumb underneath doing the "where am I" job that Source was
half-doing. That removes the `<dl>` entirely, which is the real win: four label/value pairs
of chrome above every node, most of it redundant, is what makes the pane feel like a debug
readout instead of an inspector.

Worth checking against the Raw view's own header while doing this, so the two panes don't
drift into different header idioms.

**Fixed**, following the suggested shape. The `<dl>` is gone; the `<h2>` now renders
`glyphOf(kind)` · name (or `kindLabelOf(kind)` for unnamed nodes) · child count flush right,
all on one line, with a new `--font-size-lg` token (16px) so it reads as a heading against
the `--font-size-ui` `<h3>`s below it. `sourceRangeLabel` and its own tests are untouched —
only its one call site inside the header was removed. The breadcrumb above already did the
"where am I" job Source was duplicating.

### The Attributes table shouldn't span the full pane width · `done`

`.detail-facets-table` is `width: 100%`, so a two-column `Name | Value` table of short
values stretches the full pane and puts a lot of empty space between the two — which is
exactly what makes it hard to read.

Wanted: size to content, expanding for long names and values, with a sensible minimum so it
doesn't look pinched when the values are all two characters. `width: auto` plus a `min-width`
and a `max-width: 100%` gets most of it; `overflow-wrap: anywhere` is already set and should
stay for the long-value case.

**Fixed:** `width: auto; min-width: 240px; max-width: 100%` — the table sizes to its content
(browser default `table-layout: auto`) up to the pane's width, then wraps long values instead
of stretching the columns apart.

### Copy Grid as CSV has no row cap · `done`

~8 s and ~97 MB of string on a 200 MB file, from a button with no warning. Needs a
confirmation like §11.2's soft cap, or a row limit.

**Fixed:** above 50,000 rows the grid asks first, showing the estimated output size —
§11.2's soft-cap shape, a confirmation rather than a refusal.

## Raw view

### No line numbers · `done`

The gutter was off through D10, on the reasoning that a row is not a line (§3.1) and that
CodeMirror's own numbering restarts at 1 at every window crossing. Both were true and
neither was inherent.

**Resolved:** `core/rowIndex.ts` gained a `LineIndex` — sparse checkpoints over the row
index — and `rawGutter.ts` offsets CodeMirror's window-local numbers by the line the window
starts on. Numbers are exact, not "row number, near enough". Off for a document with no
meaningful lines, on the same rule §4.3 uses for the Detail header.

It also fixed two shipped features that were already showing drifting numbers: D9's
source-range fact and D14's `:` go-to-line both indexed the row index as if rows were
lines. They agree only while no line exceeds the 512-byte cap.

## Palette and commands

_(nothing yet)_

## Chrome, theming, density

### Diagnostic detail sits in the top bar after opening a file · `done`

Opening a document leaves technical detail across the top of the window — file name,
format, encoding, node count, diagnostic count, `selected node N, caret M`. Some of it
belongs in a status bar; none of it belongs where it is.

That block is `DocumentStatus`, and its own module comment says what happened: *"Minimal,
temporary UI for the document session (M1-PLAN.md D6) … Deliberately not the Tree/Detail/Raw
layout (D7–D10 build that); this exists so D6's own acceptance criteria are actually
exercisable before any pane does."* D7 built the real layout and mounted `DocumentStatus`
**inside the command bar** rather than removing it, so a scaffold meant to be deleted became
permanent chrome. `selected node N, caret M` in particular is a debug readout.

**There is no status bar at all**, though `CONCEPT.md` names one three times: §8 (memory
budget tracked and surfaced), §11.2 (read-only state shown there "rather than discovered on
a failed save"), §11.4 (total footprint across tabs). Building it is the natural home for
the file/format/encoding facts and the diagnostic count. Progress and the size-cap
confirmation stay transient; the debug readout goes away entirely.

**Fixed.** A new `StatusBar` component (`components/StatusBar/`) is a flat strip pinned to
the bottom of `Layout` — flat rather than elevated, since §9.4's elevation budget doesn't
name a status bar in either bucket, and a bottom strip with a border reads more like the
pane headers than like the command bar. It renders only in the `ready` phase: the
file/format/encoding/read-only line and the node/diagnostic-count line that `DocumentStatus`
used to render inline in the command bar. `DocumentStatus` keeps only what's actually
transient there — size confirmation, parse progress, the partial-parse warning banner, and
"Open Another File…" — and the `selected node N, caret M` debug readout is deleted outright,
not moved. Memory budget and cross-tab footprint (the rest of what §8/§11.4 ask for) wait for
whichever milestone adds memory tracking and tabs; nothing here blocks them.

### The application's own icons are not wired up · `M2b`

Every asset exists and `assets/README.md` specifies exactly how each is used. Almost none of
it is connected.

**In-window identity is entirely absent — still true, and it's a "stop and report," not a
fix.** assets/README.md's "Title bar" section is a complete spec — the bare mark and never the tile
("a rounded dark tile inside a light title bar reads as a sticker"), 16px from
`mark-16.svg`, colour from a theme token via `currentColor` so it participates in §9.2 like
everything else, and light mode darkening the amber to `#A9701E` because `#E9A33C` measures
~1.9:1 against a light surface, under the 3:1 minimum for a non-text UI element. The spec
itself assumes a title bar under the app's own paint. **There isn't one.** NodePad has no
`frame: false`, no `titleBarStyle`/`titleBarOverlay`, no custom title-bar component anywhere
in `src/renderer` — it runs Electron's fully native OS title bar, which is a fixed bitmap
the OS composites itself. It has no slot for arbitrary SVG content and cannot resolve
`currentColor` against a theme token; there is nothing in this codebase today for the mark
to go *into*. Implementing this as specified means building a custom/overlay title bar
first — real scope, undocumented as a prerequisite by either this entry or assets/README.md — so per
the working agreement ("report rather than work around"), this is left undone rather than
improvised into something assets/README.md didn't ask for. Also worth reconciling separately:
`assets/titlebar-preview.html`, which both docs cite as the visual reference, does not exist
in the repo.

**Decided, not just deferred: this stays undone until a future milestone chooses to take it
on.** The blocking cost isn't the mark itself — it's that today the OS-native title bar and
`theme.ts`'s in-app light/dark toggle are entirely disconnected. `theme.ts` never talks to
the main process (confirmed: zero references to `nativeTheme` anywhere in `src/`); the native
title bar instead follows the **OS's** own dark-mode setting via Electron's default
`nativeTheme.themeSource = 'system'`. They can actively disagree — OS in dark mode, NodePad
toggled to light, and the title bar stays dark. Building the custom title bar properly (not
just cosmetically) means adding an IPC round-trip so `toggleTheme()` pushes the new theme to
the main process, which then either sets `nativeTheme.themeSource` (simplest, but affects the
whole app's native chrome, not just the title bar) or calls `setTitleBarOverlay()` per-window
(finer-grained, Windows/Linux-only API — macOS's traffic-light color stays OS-controlled
regardless of either approach). That's three platform-specific code paths (Windows overlay,
macOS `hiddenInset`, Linux inheriting the Windows path but not always behaving identically
depending on desktop environment) plus a new IPC surface, none of which exist today, and this
development environment cannot visually verify the macOS path at all. Real scope, explicitly
declined for now rather than half-built.

**The window icon is Linux-only · `done`.** `src/main/index.ts` carried the electron-vite
scaffold's `...(process.platform === 'linux' ? { icon } : {})`, so a `npm run dev` window on
Windows showed Electron's default icon. Now unconditional — a packaged build's icon comes
from the `.ico`/`.icns` regardless of this option, so it only ever mattered for `npm run
dev`, but that's the icon *we* look at all day.

**Packaging — confirmed, not just assumed.** Ran `npx electron-builder --dir --win`: it
picked up `assets/build/icon.ico` with no warnings, and the resulting
`dist/win-unpacked/NodePad.exe` carries NodePad's own icon (amber "N" monogram on the dark
tile) when its associated icon is extracted and inspected — not Electron's default. The
`directories.buildResources: assets/build` convention works as expected.

**No favicon in `src/renderer/index.html` · `done`.** Added `<link rel="icon"
type="image/png" href="../../assets/build/icons/32.png">` — the generated tile PNG, not
`mark.svg`, per assets/README.md's own distinction between the tile (OS-level chrome: dock, taskbar,
and — by the same logic — a browser-style tab favicon) and the bare mark (in-window UI,
which a favicon isn't). Verified with a real `electron-vite build`: the tag rewrites to the
bundled asset and resolves correctly in `out/renderer/index.html`.

**One trap before regenerating anything.** assets/README.md says "Rerun after any change to
`assets/`" and gives `python generate.py`, but `tools/generate.py` uses `SRC = "assets"` and
`OUT_PNG = "build/icons"`, both relative to the working directory. From the repo root it
reads the right sources and writes to `./build/icons/`, not `assets/build/icons/`; from
`assets/` it cannot find its sources at all. **Neither invocation reproduces the committed
layout**, so if M2b needs a new size — a 20px title-bar variant, say — fix the script's
paths first rather than hand-moving output. (It uses `makedirs(exist_ok=True)` and never
deletes, so a stray run is harmless to the existing files and to
`assets/build/entitlements.mac.plist` sitting alongside them.)

**Out of scope here, despite assets/README.md mentioning them:** the active-tab underline (tabs are
post-M1, §11.4) and the unsaved-changes dot (M3). assets/README.md's own warning applies to both —
"if amber marks everything it marks nothing, the same discipline as the elevation budget in
§9.4."

### Toolbar buttons are text, not icons · `M2b`

The command bar renders `command.title` as a text label, and the grid's toolbar has literal
`Copy CSV` / `Copy TSV` / `Copy Markdown` buttons. Both should be icons.

`Command.icon` already exists as `IconRef = string` with no resolver — resolving it against
the Fluent set (§9.5) is M2b's own headline entry. Text labels move to tooltips, with the
keybinding included where one exists.

**Partly fixed, done together with the `paneHeader` entry below since they share the same
resolver and button shape.** `@fluentui/svg-icons` (MIT — the exact set §9.5 names) is now a
real dependency, picked over hand-vendoring after asking: it's the raw-SVG package, not the
much heavier `@fluentui/react-icons`, so it costs one static import per glyph actually used
— `commands/icons.ts` resolves an `IconRef` to bundled SVG markup (`?raw` import, inlined at
build time; only icons actually referenced are imported, not the whole set) and a new
`Icon` component (`components/Icon/`) renders it with `fill: currentColor` so it always
matches its surrounding text colour, never a token of its own. The command bar's three
pane-toggle buttons now render an icon with `title`/`aria-label` composing the tooltip —
`"Title (Chord)"` via the same `defaultChordFor`/`formatChord` the palette entry above
already built, falling back to plain title text when a command has no icon.

**Grid's toolbar — done, but deliberately *not* moved to `paneHeader`.** Walking through it
with the user surfaced that relocating it there was the wrong call, not just extra scope:
`.grid-toolbar` sits directly above the grid table, but `PaneShell`'s header sits at the very
top of the Detail pane, above the breadcrumb, the node header, and every other section —
several sections away from the table these controls act on. `paneHeader` fits Tree's
"Expand All" and Raw's "Toggle Soft Wrap" because those act on the *whole pane*; the grid
toolbar only applies when a grid happens to be showing, which argued for leaving it in
place rather than forcing it into a surface built for something else. So the toolbar stays
exactly where it was, with the same icon/tooltip treatment applied in place: Copy
CSV/TSV/Markdown now render `<Icon name="copy">` + a short label (`CSV`/`TSV`/`MD`, since
three identical copy glyphs with no text would be indistinguishable) instead of full words,
the filter toggle gets the filter icon plus its existing active-filter-count badge, and the
column picker gets the table-settings icon plus its `+N` badge — all through the same
`Icon`/`resolveIcon` infrastructure the command-bar and pane-header buttons use, just
without a `Command` behind them (they stay plain `onClick` handlers, as before).

**New: `Ctrl+F` focuses the quick filter.** Separately from the per-column filter row above,
the grid's quick-filter box (searches across all columns at once — unchanged, still the same
control it's always been) had no keyboard entry point; you had to click it. A new palette
command, `nodepad.grid.focusFilter`, bound to `Ctrl+F`, focuses and selects it — reusing the
same "component registers a live handle with a module-level singleton" pattern as
`gridController.ts`'s existing `copyAs` (a `focusQuickFilter` method added to the same
controller). No conflict: nothing in this codebase wires up Chromium's find-in-page or a
CodeMirror search extension, so `Ctrl+F` was free, and the global keymap's capture-phase
listener would win over either even if one existed.

### No visual indication of which pane has focus · `done`

Three panes, `F6`/`Shift+F6` cycling, `Ctrl+1/2/3` jumping, and a `focus` context key that
already tracks the answer — but `Layout.css` has no `:focus-within` rule and no focused-pane
styling, so nothing on screen says where you are. Keyboard navigation between panes is
effectively invisible. §9.6 names focus rings as one of the three things that rot first.

**Fixed.** `.pane:focus-within` gets `outline: 2px solid var(--focus-ring); outline-offset:
-2px` — the same convention `Grid.css` already uses for keyboard focus, reused rather than
inventing a second one. `:focus-within` on `.pane` rather than `:focus` on `.pane-body`
because actual DOM focus sits on the nested body (`registerPane`'s ref); the outline needs
to read as "this pane" the same way `focusin` already treats it for the `focus` context key.
`.pane-body`'s own `outline: none` stays, so the ring doesn't double up.

### The `paneHeader` command surface is defined and unused · `M2b`

§4.1 specifies "thin, *flat* header strips per pane for pane-scoped actions". The registry
has the surface, `commandsForSurface` filters for it, and `PaneShell` renders only a text
label — so nothing is ever placed there. The consequence is that pane-scoped controls have
nowhere to go: the grid's copy buttons, filter box and column picker all sit inside the
Detail *body*, and Tree's expand-all and Raw's wrap toggle are palette-only.

This is also where the icon toolbar above belongs, so the two are worth doing together.

**Partly fixed, for Tree and Raw — Detail/Grid explicitly deferred (see the entry above).**
`Command` gained an optional `pane?: Pane` field — `when` alone can't express "which pane's
header does this belong to," since that's static ownership, not something to evaluate
against live context (a Tree command belongs in Tree's header whether or not Tree currently
has focus). `PaneShell` now renders `commandsForSurface('paneHeader', context).filter(c =>
c.pane === props.pane)` as icon buttons next to the label.

Two commands actually moved there. **Raw's "Toggle Soft Wrap"** already existed
(`palette`-only) — just gained `surfaces: ['palette', 'paneHeader']` and `pane: 'raw'`, no
behavior change. **Tree's "Expand All" didn't exist as a command at all** — corrected from
what this file previously said ("palette-only"): it was a bare `onClick` calling
`runExpandAll` directly, with no registry presence and no palette reachability either.
`treeController.ts` gained an `expandAll()` alongside its existing `locateNode`, mirroring
that pattern, and a new `Tree/commands.ts` registers `nodepad.tree.expandAll` against it —
Tree had no command module before this at all.

### The palette doesn't show keybindings · `done`

`DEFAULT_KEYBINDINGS` maps command id → chord and is already loaded. The palette shows
title and category but not the bound key, so `Ctrl+Shift+L` next to "Toggle Light/Dark
Theme" — the standard way anyone learns a shortcut — is missing. §7's keyboard-first design
is currently undiscoverable from the one surface built to expose it.

**Fixed.** Two small pure functions in `keybindings.ts` — `defaultChordFor(commandId)` and
`formatChord(chord)` — plus a `.palette-option-hint` shown next to the category on each row
when the command has one. It looks up `DEFAULT_KEYBINDINGS` specifically, not whatever a
user has overridden on disk: nothing in the renderer keeps loaded (possibly-overridden)
bindings anywhere the palette can reach them today (`App.tsx`'s `useKeymap` loads them into
a private closure used only for matching), and the default is still an accurate hint for an
unmodified keymap. Exposing the loaded bindings app-wide, so an override shows correctly
too, is a larger change than this entry asked for — worth its own follow-up if it matters in
practice.

### Diagnostics can be seen but not navigated · `done`

The scrubber marks them (`scrubberModel.ts`'s `diagnosticMarkers`) and the top bar counts
them, but there is no *Next diagnostic* / *Previous diagnostic* command. §11.1's whole
rationale for showing a partial tree is that "diagnosing the breakage is usually why the
file was opened" — and on a 200 MB document a marker you can see but cannot jump to is
decoration. The offset → node primitive D14 built is all this needs.

**Fixed.** Two pure functions, `nextDiagnostic`/`previousDiagnostic` (new
`navigation/diagnosticNav.ts`), each `(diagnostics, currentOffset) => Diagnostic | null` —
sorted defensively since the parser only promises report-and-continue, not offset order.
`null` at either boundary, no wraparound, matching `history.ts`'s existing
`stepBack`/`stepForward` convention rather than inventing cyclic navigation for this one
pair. Two new commands (`navigation/commands.ts`) reuse D14's `nodeContainingOffset` and the
same select/locate-in-tree/scrub-to-source triple `Palette.tsx`'s go-to-position flow already
uses — scrubbed to the diagnostic's own offset rather than its containing node's span start,
since that's the more precise of the two. Bound to `F8`/`Shift+F8`, gated on a new
`hasDiagnostics` context key set the same place `hasSelection`/`format` already are.

### "No document open." appears three times, with no way in · `done`

Tree, Detail and Raw each render their own empty paragraph, so an empty window says the
same sentence three times and offers nothing. It is also the first thing every new user
sees. One empty state naming the three ways in — `Ctrl+O`, drag a file onto the window, or
the palette — would replace three dead ends with an instruction.

**Fixed.** `Layout` now renders one `EmptyState` (`components/Layout/EmptyState.tsx`) in
place of the whole pane grid whenever the document session isn't `ready`, naming all three
ways in: `Ctrl+O`, dragging a file onto the window, and the palette (`Ctrl+Shift+P`). Since
CONCEPT.md's five reachable layouts never allow zero visible panes, replacing the grid at
the `Layout` level rather than per-pane still guarantees it shows under all of them. Tree,
Detail and Raw no longer render their own "No document open." — each keeps a one-line guard
purely for narrowing onto `state.document` (Layout never actually mounts them until the
document is ready, so the guard is unreachable in practice), and the now-dead
`.tree-empty`/`.raw-empty` CSS rules are gone. Detail's separate "No node selected." empty
state is untouched — that one is real and reachable once a document *is* open.

---

# Round 2 — from testing after M5

Eight observations, investigated and sharpened here per this file's own header rule
("sharpening them is the planning step's job"). Each records what was actually found in the
code, so the fix is a decision already made by the time anyone opens an editor.

**Status `M5b`** — the fit-and-finish round after M5, following the M0b/M0c/M2b naming
convention. Three of these are defects rather than polish (grid header heights, the Tree
jumping to `Document`, dark-mode chrome) and need not wait for a milestone plan if the coding
agent reaches them sooner; the rest is cross-cutting look-and-feel work of exactly the kind
D-034 says a polish pass is for.

**Two needed a `DECISIONS.md` entry rather than a quiet implementation, and both are now
settled**: removing the grid/list override is **D-049**, and wrapper descent is **D-050**
(the breadcrumb marks it, the Tree unfolds to it, the selection does not move).

**All nine entries below are `done`.** Built in the order this section's own status note
suggested — the byte/UTF-16 fix first, since the scrubber's viewport thumb would otherwise
have inherited its drift. An independent review pass afterward, over all six commits, found
one real bug: the scrubber thumb's `min-height` (so it stays grabbable on a large document)
could push its bottom edge past the strip's own bottom near `topRatio` 1 — a large document
scrolled near its end, exactly the scrubber's own target case. Fixed by clamping `top` with
CSS `min()` against the same minimum height, mirroring how a native scrollbar thumb never lets
its own minimum size push it out of the track. Nothing else the review checked (the byte/UTF-16
conversion's correctness and its five call sites, the Tree's merged effect, match-bucket
boundaries, the viewport store's quantization, D-049's removal completeness, the focus overlay's
z-index against everything else in the app) turned up a bug.

## Tree view

### Selecting a deep node in Raw leaves the Tree showing `Document` · `done`

Reported: selecting a `car` node in Raw shows the right node in Detail, but the Tree jumps to
`Document`; `cars` and `elements` work.

**Cause found, and it is one line.** `Tree.tsx`:

```ts
const activeIndex = Math.max(0, indexOfNode(rows, selectedNode))
```

`indexOfNode` returns `-1` when the selected node is not currently a *visible row*, and
`Math.max(0, -1)` is the root row. `cars` and `elements` work because `autoExpandChain`
(D-034a) already expanded them from the root on open; `car` is one level deeper and its
parent was never expanded, so it has no row at all.

The comment above that line says this is deliberate — "a keyboard-navigation starting point,
not a claim that the root is what's actually selected." **The intent and the result
disagree**: the root row is rendered active and scrolled to, which is indistinguishable from
"the Tree selected `Document`" — which is exactly how it was reported.

**Fix:** expand ancestors whenever the selection changes to a node with no row.
`expandAncestors(node)` already exists in `Tree.tsx` (it is what "Locate in tree" calls) and
is O(depth); the effect that consumes a pending reveal is the natural place to also react to
`selectedNode`. That makes the Tree honour §4.5's single-source-of-truth contract instead of
silently disagreeing with Detail.

**One behaviour change to confirm while doing it:** §11.1 opens a broken document with a deep
error node selected, so the Tree would now auto-expand to it on open. That is probably wanted
— "diagnosing the breakage is usually why the file was opened" — but it is a change, not a
side effect to discover afterwards.

**Fixed**, taking the behaviour change: a single `useEffect` keyed on `(store, selectedNode)`
now expands ancestors whenever the current selection has no row, including on open — the
fallback-to-root-row line stays for the one render before the effect runs, but is no longer
the whole story.

## Detail view

### Grid header and filter cells are shorter than the `#` cell and the body rows · `done`

**Cause found.** In `Grid.tsx`, the virtualized (non-pinned) header cells are positioned:

```ts
style={{ position: 'absolute', left: bodyLeft + virtualCol.start, width: CELL_WIDTH, top: 0 }}
```

`position: absolute` with `top: 0` and **no `height`** sizes the box to its content. The `#`
cell and the pinned cells are `position: sticky`, which stays in normal flow, so they stretch
to the flex row's `ROW_HEIGHT` (23 px). Hence two cell heights in one row, exactly as
reported. `.grid-row` sets an explicit height and its cells are in flow, which is why body
rows are unaffected.

**`GridFilterRow` has the identical defect** on its own virtualized cells — same absolute
positioning, same missing height. Fix both, or the filter row starts looking wrong the moment
the header stops.

**Fix:** add `height: '100%'` to both absolute cell styles. No CSS change needed —
`.grid-header-row` and `.grid-filter-row` already carry an explicit `height`.

**Fixed** exactly as diagnosed — `height: '100%'` added to both.

### The children list and the Attributes table look like different components · `done`

Reported for the single-element case, where it is most obvious, but it is true generally.

**What differs.** `.detail-facets-table` is a real `<table>`: `width: auto`,
`min-width: min(240px, 100%)`, `border-collapse`, a bottom border per row, no outer box.
`.detail-children-list` is a virtualized scroll region: **`height: 300px`** (fixed), a full
border with `--radius-sm`, and `.detail-child-row` flex rows with no separators. A node with
one child therefore renders one row inside a 300 px bordered box.

**The constraint that shapes the fix:** the children list cannot become a `<table>` — it is
virtualized because a node can have millions of children, and that is not negotiable. What
can change is everything visual:

- **`max-height: 300px` instead of `height: 300px`**, so the box is content-sized until it
  actually needs to scroll. The virtualizer keeps working: its inner spacer still drives
  scroll height, and the container simply stops growing at the cap.
- Drop the border and radius; adopt the facets table's per-row bottom border instead.
- Same `padding: var(--space-1) var(--space-2)`, same `--surface-fg-secondary` for the label
  column.

Result: one visual idiom for "a small table of facts about this node", whether the facts are
attributes or children.

**Fixed** exactly as diagnosed: `max-height: 300px`, border/radius dropped in favor of the
facets table's own per-row bottom border, same padding, `--surface-fg-secondary` added to the
name column.

### Remove the "Show as grid" / "Show as list" button · `done` · D-049

Confirmed as clutter: `.detail-grid-toggle` sits in the Children heading and is the only
control there.

**Removing the button alone is the wrong half of the job.** The state lives in
`gridOverrideStore.ts` and there is also a palette command, `nodepad.grid.toggleView`
(`Detail/commands.ts`). Deleting only the button leaves a palette command that silently
changes how the pane renders, with no visible control and no indication — worse than the
button. Remove all three.

**This reverses M2 E9, so it is recorded as D-049** rather than left in a commit message.
E9 exists for a real case: D-014's floor (≥2 members, ≥5% coverage) means
`<cars><car/></cars>` — a single occurrence — never qualifies as a grid, and the override was
how a user could force one anyway. After this, that document can only render as a list.
Accepted: a one-row grid shows a header and one row, which tells a reader nothing the list
does not, while the control was on every Children section whether or not it would change
anything.

**Scope, concretely** — five things, verified against the code, not four:

- the `.detail-grid-toggle` button and its CSS rule
- `gridOverrideStore.ts` entirely
- the `nodepad.grid.toggleView` registration in `Detail/commands.ts`
- `Detail.tsx`'s `registerDetailGridToggle` effect and the `gridController` handle it
  registers — the palette command's live hook, which has no other caller
- `Detail.tsx`'s `candidateGroup` fallback: the `detection.grid === null` branch exists
  *only* to give the override a group to force grid mode onto (its own comment says so).
  `candidateGroup` becomes `detection.grid`, and `useGrid` collapses to
  `detection.grid !== null`.

No keybinding referenced the command and no test asserts on it, so nothing else unwires.

**Fixed** — all five, plus the `<dl>` fallback comment updated to reflect that
`candidateGroup` is gone entirely (`useGrid = detection.grid !== null`), not just unreachable.

### Selecting `garage` shows `elements` — mark it and unfold to it · `done` · D-050

Confirmed, and it is `resolveWrapperTarget` (D-015/D-035) working as designed: `Detail.tsx`
resolves the selection through any chain of transparent wrappers and draws everything —
heading, attributes, children, breadcrumb — from the *destination*. Selecting `garage` in a
document shaped `garage → cars → elements → car…` lands the pane on `elements`.

The rule itself is sound and should stay: the alternative is a one-row table containing the
word "elements", which is what D-015 exists to prevent. What is missing is any signal that a
descent happened, so the pane appears to disagree with the Tree.

**Option A — say it in the header.** A quiet line under the node heading:
`showing contents of garage › cars`, with the skipped segments clickable to pin the pane to
that node instead.
*For:* completely explicit; no behaviour change; the descent becomes teachable.
*Against:* adds chrome back to the header that this file's own "The Detail header repeats
itself" entry just finished stripping out.

**Option B — let the breadcrumb carry it.** The breadcrumb already renders the full path.
Render the segment the user actually selected in normal weight, the descended-through
segments dimmed, and the destination emphasised — so `garage › cars › elements` shows "you
clicked here, you are seeing there" with no new element at all.
*For:* zero new chrome, reuses something already on screen, costs a CSS class.
*Against:* subtle enough to be missed; teaches the rule only to someone who looks.

**Option C — move the Tree selection to the destination.** If Detail is going to show
`elements`, select `elements` everywhere. §4.5 defines a *single*
`{ selectedNode, caretOffset }`, and today Detail quietly renders something other than what
that says — C is the only option that removes the disagreement rather than annotating it.
Expanding `garage` in the Tree would visibly land on `elements`.
*For:* the panes can never disagree; no new UI; the descent becomes observable by watching it
happen.
*Against:* a Tree selection that jumps on click is surprising in its own right, and it means
a wrapper node cannot be selected at all — which matters, because D-034a deliberately kept
every level individually selectable in the Tree.

**Option D — unfold the Tree along the descent, without moving the selection.** Raised in
review and better than A: selecting a wrapper expands the chain so the destination becomes a
visible row, and the breadcrumb's path becomes legible as actual tree structure.
*For:* uses a surface the user is already reading rather than adding one; the selection does
not move, so D-034a's "every level individually selectable" survives.
*Against:* it reshapes the Tree on a single click — see the D8 tension below.

**Decided (D-050): B + D.** The breadcrumb marks the descent; the Tree unfolds to it. C is the
most principled on paper but makes a wrapper node unselectable in the Tree, directly reversing
D-034a, which was itself adopted from feedback in this file. A is kept as the fallback if B
proves too subtle in practice.

**Implementation notes, both cheap:**

- `resolveWrapperTarget` already returns `skipped`, root-first, including the selected node
  when it qualifies. That is exactly the set to expand — and **expanding `skipped` reveals
  `destination` without expanding `destination` itself**, which matters because the
  destination is the node with the repeating children and may have millions of them.
- Expand only when `selectedNode` actually *changes*, so a user who deliberately collapses a
  wrapper and re-selects it does not fight the auto-expansion on every click.
- **The D8 tension, recorded rather than discovered:** D8 deliberately made single-click *not*
  toggle expansion, because "a single-click toggle would reshape the tree under the pointer
  every time you clicked through siblings." This does reshape on single click — but only ever
  expands (never collapses, so no flip-flop), only for a transparent wrapper (a node with
  nothing of its own to show), and only along a chain already being rendered elsewhere.
  Selecting an ordinary node changes nothing.
- **Do not unify this with `autoExpandChain`.** They look identical and are not:
  `autoExpandChain` (D-034a) requires exactly one child, while `wrapperCompositeChild` ignores
  `Comment`/`ProcessingInstruction`/`DocType` children — so a wrapper carrying a comment (the
  Appendix A shape) descends here and stops there.
- This composes with the Tree entry above rather than duplicating it: that one expands
  *ancestors of a selection that has no row*, this one expands *the descent chain below a
  selection that does*. Both end at "the Tree shows what the other panes are talking about."

**Fixed**, both halves, in the same merged `useEffect` as the entry above (one `bump()` per
selection change, not two): the breadcrumb dims `skipped` minus the selected node itself and
keeps the destination's existing `aria-current` emphasis; the Tree expands exactly `skipped`.

## Raw view

### Byte offsets and CodeMirror positions are mixed throughout the Raw view · `done`

Found while working out where a scrubber thumb would get its position. Not reported from use,
because **it is invisible on ASCII documents** — which is every fixture this project owns.

`Raw.tsx` builds the editor's document as `sourceBuffer.slice(start, end)`, a **decoded JS
string**. So an editor position is a UTF-16 code-unit offset into the window, while
`handle.start` is a **byte** offset into the file. Four sites add or subtract the two directly:

| Site | Expression | What it means |
|---|---|---|
| `Raw.tsx` `absTopOffset` | `handle.start + lineBlockAtHeight(…).from` | byte + UTF-16 unit |
| `rawCaretSync.ts` | `getWindowStart() + view.state.selection.main.head` | byte + UTF-16 unit |
| `rawDecorations.ts` | `windowStart + view.viewport.from` / `+ docLength` | byte + UTF-16 unit |
| `rawDecorations.ts` | `mark.start - windowStart` used as an editor position | byte delta as UTF-16 |

`rawEdit.ts` is the **only** module that gets this right, and its own header says why —
*"CodeMirror's own positions are UTF-16 code units, not bytes."* That was commit `a657235`,
an M3 review fix applied at the one site the review looked at, never swept across the others.

**Measured drift at the far end of a 1 MB window**, decoding real content through
`SourceBuffer.slice`:

| Window content | Bytes | UTF-16 units | Drift |
|---|---:|---:|---:|
| Pure ASCII (`cars-*.xml`) | 1,080,000 | 1,080,000 | **0** |
| German / accented Latin | 1,155,000 | 1,023,000 | **132,000** |
| CJK | 1,080,000 | 600,000 | **480,000** |
| Emoji | 960,000 | 720,000 | **240,000** |

Drift is zero while everything earlier in the window is ASCII and grows from the first
non-ASCII character onward, so a document that is mostly ASCII with accented names still
drifts progressively after the first one.

**What it breaks, all only on non-ASCII documents:** syntax and selection highlighting land
progressively further from the spans they describe; clicking in Raw resolves to the wrong node
(`rawCaretSync` feeds `nodeContainingOffset`); Find highlights sit in the wrong place; the
gutter's line numbers drift; and — the worst of them — `absTopOffset` under-reports how far
into the window the viewport is, so `shouldRecenter` can stop firing and **scrolling gets
stuck near the window's end** with no way forward.

**Fix shape:** one pair of helpers converting between a window's byte offsets and its editor
positions, against the window text CodeMirror already holds, with every site above routed
through them. `rawEdit.ts` already does this conversion for edits — extract from there rather
than writing a second implementation. Then a test with a non-ASCII fixture, which the suite
currently has no Raw-view equivalent of.

**Do this before the scrubber thumb below**, which would read its position from `absTopOffset`
and inherit the drift.

**Fixed.** New `rawOffsets.ts` holds both directions (`localUnitsToByteOffset`, moved from
`rawEdit.ts` which now re-exports it; `byteOffsetToLocalUnits`, the new inverse — a single
code-point-aware walk, not a binary search re-encoding an ever-larger prefix). Routed through
at five sites, one more than this entry's own table: `Raw.tsx`'s `absTopOffset` and `jumpTo`
(the latter had the identical bug, not originally listed), `rawCaretSync.ts`'s caret
resolution, and both directions inside `rawDecorations.ts`'s `buildDecorationSet`.
`test/rawOffsets.test.ts` adds the non-ASCII coverage (accented Latin, CJK, emoji) the Raw
view had none of, round-tripped at every code-point boundary against the existing
`localUnitsToByteOffset`.

### The scrollbar jumps when dragged — and what happened to the "preview pane" · `done`

**Two things, and the second answers the first.**

**What was planned is the scrubber, and it is built.** `CONCEPT.md` §4.4 is explicit:
*"A scrubber, not a scrollbar."* It is `Scrubber.tsx` (D13) — the 10 px strip pinned to the
right of the Raw pane, carrying markers for the selected node's span, diagnostics and search
hits, click- and drag-to-move. §4.4 also says why it is a scrubber rather than a scrollbar:
position resolves through the row index (`y → row → byte offset`), so it never asks the
editor how tall the document is, "which is what keeps a 500 MB file off Chromium's maximum
element height." **A VS Code-style minimap — miniature rendered text — is not planned
anywhere and would defeat exactly that**, since it means laying out the whole document. So
nothing is missing; the scrubber is simply thin enough, and marker-only enough, that it does
not read as the scroll control it is meant to be.

**Why the native scrollbar jumps.** CodeMirror's own vertical scrollbar is still visible, and
it describes the **~1 MB window, not the document**. Dragging it fires a stream of scroll
events; `Raw.tsx`'s `onScroll` calls `shouldRecenter` and then `applyReslice`, which replaces
the editor's content with a new window — changing `scrollHeight` and repositioning
`scrollTop` **mid-drag**, so the thumb moves out from under the pointer. Wheel scrolling hides
this because it is incremental; D-031's measurements covered wheel scroll and window
crossings, never a scrollbar drag, which is why it was never caught.

**Why the scrubber looks dead — three gaps, none of them a broken scrubber.** Checked after
the report "there is no indicator moving there when I scroll":

1. **There is no viewport indicator, and there never was.** `Scrubber.tsx` renders exactly
   two things: diagnostic markers and a selected-node marker. Its own `positionRatio` state —
   the scrubber's idea of where it is — feeds `aria-valuenow` and the arrow-key step, and is
   **never rendered**. The position is announced to a screen reader and invisible to everyone
   else, which is the accessibility relationship backwards.
2. **Even drawn, it would not move on scroll.** `positionRatio` is only ever updated inside
   `scrubToRatio`, which only the scrubber's own pointer and keyboard handlers call.
   `rawController.ts` is a **one-way channel** — `RawController` exposes `toggleWrap` and
   `scrubTo`, both Scrubber → Raw. Nothing reports back, so Raw's `onScroll`/`applyReslice`
   never tells the scrubber where the window went. Adding a thumb therefore means adding the
   reverse direction too, not just an element.
3. **On a clean document the strip is genuinely empty.** No diagnostics means no diagnostic
   markers; a selection at the document root puts the one selected-marker at ratio 0, flush
   with the top border where it reads as part of the frame. Nothing else draws at all.

**Search hits were specified for this strip and never added — worth fixing here too.**
§4.4 lists the marker set as "the selected node's span, later search hits (§6) and
diagnostics," and `scrubberModel.ts`'s own comment left the seam open in as many words:
*"a later marker source (M4 search hits …) is just another array fed through the same shape."*
M4 then marked matches in Raw, Tree and grid and never touched the scrubber. This matters more
than the omission suggests: §4.4's stated reason for having markers at all is that they keep
things visible *outside the current window*, and a find on a large document produces matches
almost all of which are outside it. Today Find reports "1,266,536 matches" and the one surface
that could show where they are shows none. `activeSearchStore`'s `starts` is already an
ascending `Int32Array`; it needs sampling rather than one marker per match at that count.

**Fix, in the direction §4.4 already specifies:**

- **Hide the native vertical scrollbar in the Raw editor** (`.raw .cm-scroller` —
  `scrollbar-width: none` plus the `::-webkit-scrollbar` rule). Wheel and keyboard scrolling
  are unaffected; only the misleading thumb goes.

- **Widen the strip to scrollbar width.** Confirmed as reported: 10 px is too thin to read as
  a navigation control once it is the only one. Chromium's classic (non-overlay) scrollbar is
  15 px at default DPI on Windows, so **15 px** makes the swap invisible in layout terms —
  verify against the running app rather than trusting that number. **The width lives in two
  places that must move together**: `.scrubber { width: 10px }` and `.raw { margin-right:
  10px }`, two hardcoded literals with nothing tying them. Introduce a `--scrubber-width`
  token and use it in both, or the next change to one silently overlaps the editor.

- **The thumb shows the viewport, not the window.** This is a real choice, not a detail: a
  1 MB window on a 200 MB document is 0.5 % of the strip, while the visible viewport is a
  fraction of that. D-031 is explicit that *"the window must be invisible"* — it is an
  implementation device, and drawing it would make the user perceive it. A scroll thumb
  conventionally means "what you can see," so: viewport. Give it a minimum height (~20 px) so
  it stays grabbable, exactly as a native scrollbar does, accepting that it then
  over-represents the viewport at large document sizes.

- **Add the Raw → Scrubber channel.** `rawController.ts` is one-way today. Follow the existing
  convention rather than inventing one: a small module-level store (`findStore.ts` and
  `gridOverrideStore.ts` are the pattern) that Raw publishes its viewport range to and the
  scrubber reads with `useSyncExternalStore`. Raw's `onScroll` fires per frame, so quantize
  before publishing — to whole strip pixels, not raw offsets — or every scroll frame
  re-renders the scrubber.

- **Feed search matches through the existing marker shape, bucketed.** `scrubberModel.ts`
  already anticipated this: *"a later marker source (M4 search hits …) is just another array
  fed through the same shape."* Add `kind: 'match'` and a `matchMarkers(rowIndex, starts,
  bucketCount)`. **Do not emit one marker per match** — 1.2 M matches on a 200 MB document is
  1.2 M DOM nodes, and the strip can only resolve a few hundred positions anyway. Bucket by
  ratio (one bucket per strip pixel, or a fixed 256) and emit one mark per non-empty bucket,
  with density driving opacity so a dense region reads as dense.

  Compute it with **two binary searches per bucket, not a scan**:
  `navigation/matchSpanLookup.ts`'s `countMatchesInRange` is exactly that primitive and
  `starts` is already ascending, so 256 buckets cost ~5,400 comparisons instead of walking
  1.2 M offsets — and it is the same `Int32Array` the Tree and grid already test against, so
  no new index and no copy. Memoize on `starts` identity; the search store hands out a stable
  array per result.

Note the deliberate consequence, already in §4.4: *"Navigating is not selecting."* Dragging
the scrubber moves the window without changing the selection, and that stays true — a window
thumb is a *report* of where the window is, not a second selection.

**Fixed**, all five bullets. CodeMirror's own scrollbar is hidden (`scrollbar-width: none`
plus the `::-webkit-scrollbar` rule); the strip widens to a new `--scrubber-width` token
(15px, replacing the two hardcoded `10px` literals) shared by `Scrubber.css` and `Raw.css`;
a new `rawViewportStore.ts` is the Raw → Scrubber channel this needed, publishing a
quantized viewport ratio range so a scroll-per-frame publisher doesn't re-render the thumb
every frame; the thumb shows the viewport (not the window), with a 20px minimum height; and
`scrubberModel.ts`'s `matchMarkers` buckets search hits (256 by default) through
`matchSpanLookup.ts`'s existing `countMatchesInRange`, with density driving marker opacity.

## Chrome, theming, density

### The focused-pane outline is occluded on three sides and too loud in light mode · `done`

Two separate problems in one rule (`Layout.css`):

```css
.pane:focus-within { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
```

**Occlusion.** An `outline` paints with the element's own box, so anything that paints later
or lifts itself into a higher stacking context covers it. Each reported case has its own
culprit, which is what confirms the diagnosis rather than making them separate bugs: native
scrollbars are browser-painted chrome drawn above element content (Tree); `Grid.css`'s
sticky header, filter and row-header cells carry `z-index: 1`–`3` (Detail); CodeMirror's
gutter and the absolutely-positioned scrubber paint over it (Raw). "Not visible at the
bottom" is the same cause — the pane's scrolling child overflows the box the outline is drawn
on.

**Fix:** stop using `outline` for this. Draw the indicator as an overlay owned by `.pane` —
`::after` with `position: absolute; inset: 0; pointer-events: none;` and a `z-index` above the
pane's own content — so it composites over sticky cells, gutters and the scrubber alike.
`.pane` is already the positioned ancestor. A native scrollbar sits outside the padding box,
so inset the overlay to the scroll container's own edge rather than trying to paint across it.

**Intensity — and one thing not to do.** `--focus-ring` is `--blue-500` in light, which is
correct for its actual job: the keyboard focus ring on controls, where §9.6 and §11.5 want it
loud. **Do not dim `--focus-ring` itself** — that is an accessibility regression dressed up as
polish. Add a separate, quieter token (`--pane-focus-ring`), 1 px and low-contrast, for
"which pane am I in", and leave the real focus ring alone. Two different jobs that happened to
be sharing one token.

**Fixed.** `.pane:focus-within`'s `outline` is now a `::after` overlay (`position: absolute;
inset: 0`, `z-index: 10`, `pointer-events: none`) on `.pane` itself — painted after everything
inside it regardless of sticky cells or absolutely-positioned siblings within. `--pane-focus-ring`
is a new token in both theme files (`--gray-300` light, `--gray-600` dark, one step past
`--surface-border`), `--focus-ring` untouched.

### Dark mode: light scrollbars, and light line numbers in Raw · `done`

Two causes, both "never styled at all", and both are §9.6's theme rot exactly.

**Scrollbars.** There is no `color-scheme` declaration anywhere in `src/renderer/styles/` and
no `::-webkit-scrollbar` rule in the codebase, so Chromium paints its default *light*
scrollbars regardless of `data-theme`. **Fix: one line per theme file** —
`color-scheme: dark` in `themes/dark.css`, `color-scheme: light` in `themes/light.css`. That
also corrects default form-control rendering and the default canvas colour, which are wrong
for the same reason and simply have not been noticed yet.

**Raw line numbers.** `Raw.css` styles `.cm-editor`, `.cm-scroller`, `.cm-content`,
`.cm-selectionBackground` and every `.cm-np-*` token class — but has **no `.cm-gutters` or
`.cm-lineNumbers` rule at all**, so CodeMirror's own built-in light gutter theme applies in
both themes. The gutter was added late (the "No line numbers" entry above) and its styling was
never brought into the theme system. **Fix:** style `.raw .cm-gutters` / `.raw .cm-lineNumbers`
from `--elev-1-bg`, `--surface-fg-secondary` and `--surface-border`, like every other surface.

Worth a sweep while in there: both of these were found by looking rather than by a test, and
the same "styled in light, never checked in dark" gap may exist anywhere CodeMirror's or the
browser's own defaults show through.

**Fixed**, both, exactly as diagnosed. The wider sweep wasn't done — flagged, not fixed,
same as it was found.
