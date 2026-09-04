# R61–R64 — the keyboard workflow, and making it discoverable

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Touches `CONCEPT.md` §7 (the focus model) and D-055 (title-bar
buttons keep their chord in the tooltip). Results at the end of this file; design decisions recorded
as D-078. Detail's non-grid (list) mode arrow-key navigation, named below as the lowest-value part of
this task, was **not built** — left open, disclosed rather than silently dropped.

Four reports from using the app: Tab cannot insert a tab character in Raw; moving between panes by
keyboard takes far too many Tab presses; the command palette is undiscoverable; and does CodeMirror
give us editing comforts for free?

**The unifying finding is that most of the keyboard model already exists and none of it is
visible.** F6/Shift+F6 cycle panes today. Ctrl+1/2/3 jump to one. Tree and Grid already navigate by
arrow key. All measured below. What is actually missing is much smaller than the report assumes —
and the discoverability problem is much larger, because it is the *reason* the report assumes it.

---

## 1. What already works, measured

Driven against the built app (`_electron`, `cars-small.xml`), reading `document.activeElement`
after each press:

| Key | Result |
|---|---|
| `F6` from Raw | focus → Tree |
| `F6` again | focus → Detail |
| `Ctrl+1` | focus → Tree |

`focus.ts` has had `focusPane`/`moveFocus` and a `PANE_ORDER` cycle since M1's D4;
`commands/keybindings.ts:80-84` binds `Ctrl+1`/`Ctrl+2`/`Ctrl+3` and `F6`/`Shift+F6`; all five are
registered palette commands gated on `when: 'format'`.

Arrow-key navigation inside a pane is also built, and covers more than the report assumes:
`Tree.tsx:358-388` handles all four arrows — Left/Right collapse and expand, and fall through to
parent/child selection when there is nothing to toggle — plus Home/End and Enter/Space.
`Grid.tsx:461-476` does the same for cells, Home included.

**So the proposal in the report — Tab between panes, arrows within one — is already the design, with
F6 in Tab's place.** §3 is why that substitution is correct rather than a compromise.

## 2. Why Tab feels wrong: 23 stops, and the count is unbounded

Starting focused on the Tree pane and pressing Tab, recording each stop:

```
 0. Tree (pane body)          8. Toggle per-column filter row   16. grid-header-label
 1. Document tree             9. Copy Grid as CSV               17. Pin column
 2. detail-breadcrumb-segment 10. Copy Grid as TSV              18. grid-header-label
 3. detail-breadcrumb-segment 11. Copy Grid as Markdown         19. Pin column
 4. detail-breadcrumb-segment 12. Data grid                     20. grid-header-label
 5. detail-breadcrumb-segment 13. Pin column                    21. Pin column
 6. detail-breadcrumb-copy    14. grid-header-label             22. Pin column
 7. Filter grid rows          15. Pin column                    23. grid-header-label
```

The probe gave up at 24 presses **without ever reaching Raw** — it was still inside the grid header.

The number is not the point. **The grid header spends two tab stops per column** (a Pin button and a
sortable header label), so the count is not 23, it is *O(columns)*: on one of R34's wide tables it is
well past 120, and no amount of patience gets a keyboard user to the Raw pane. `cars-small.xml` is a
narrow fixture and already shows it.

This is a real accessibility defect independent of the report — a screen-reader user has the same
problem, and worse.

## 3. R62 — one tab stop per pane

**Tab must keep doing what Tab does.** Rebinding it to pane switching is the one option to reject
outright, for three separate reasons:

- It is the platform's focus-traversal key. Every assistive technology, and every user, assumes it.
- R61 needs Tab *inside* Raw to insert indentation. A global Tab-switches-panes binding would
  conflict with the other half of this very round.
- The conventional key already exists and is already bound: **F6 is the Windows convention for
  "next pane/region"** — Explorer, Firefox, Chrome and VS Code all use it — and NodePad has had it
  since M1. Ctrl+1/2/3 matches VS Code's "focus editor group N". These are the bindings a user
  coming from other apps would try.

So the defect is the **traversal order**, not the key, and the fix is the pattern the standard
already prescribes: WAI-ARIA's **composite widget / roving tabindex** — a tree, grid or toolbar is
*one* tab stop, and arrow keys move within it.

The work:

1. The grid header's per-column controls (`Pin column`, the sortable header label) get
   `tabIndex={-1}` and become arrow-reachable from the grid's existing key handler rather than
   being tab stops of their own. This alone removes the unbounded term.
2. Detail's breadcrumb segments and the grid's toolbar buttons (filter, the three copy commands)
   become single roving-tabindex groups on the same pattern.
3. The pane body stays the one stop per pane, which is what `focus.ts` already registers.

Target: **Tree → Detail → Raw in three Tab presses, on any document.**

**Detail's non-grid mode** — the report is unsure what arrows should do there. It is a facet list;
Up/Down between rows is the consistent answer and costs little, but it is the lowest-value part of
this task and is fine to defer if it grows. The grid, which is where the report's actual use is
(*"navigating the table"*), already works.

### Refinement — the F6 question, and why the spatial idea is right but homeless

Reported after the plan landed: F-keys are effectively unavailable on a modern keyboard, where the
top row defaults to volume and brightness and F6 needs a chorded `Fn`. Proposed alternative:
`Ctrl+←` for Tree, `Ctrl+↑` for Detail, `Ctrl+↓` for Raw.

**The spatial reading is exactly right.** The layout is not a left-to-right row of three, despite
`PANE_ORDER` naming them that way — `CONCEPT.md` §4.1 puts Raw *below* Detail ("Raw stacks below
Detail, never beside it"), and `layoutStore.ts` keeps a `treeWidth` and a `rawHeight`, one per
divider:

```
┌──────┬──────────────┐
│      │   Detail     │   ← Ctrl+↑
│ Tree ├──────────────┤
│  ←   │   Raw        │   ← Ctrl+↓
└──────┴──────────────┘
```

So left/up/down really does map onto where the panes are. The problem is not the idea, it is that
**every arrow-key modifier is already spoken for**, and two of the three collisions are with things
that must not move:

| Candidate | Status |
|---|---|
| `Ctrl+←` / `Ctrl+→` | **word-wise caret motion in every text editor.** See below — this one is worse than a collision. |
| `Ctrl+↑` / `Ctrl+↓` | already `nodepad.navigate.drillUp` / `drillDown` — and hierarchy-up/down is a *better* use of Ctrl+arrow in a tree tool than pane focus is |
| `Alt+←` / `Alt+→` | already `nodepad.navigate.back` / `forward`, the browser convention |
| `Alt+↑` / `Alt+↓` | free — but it would split the `Alt+arrow` family between history and pane focus |
| `Ctrl+Alt+arrow` | free in-app; Intel and AMD display drivers bind it to **screen rotation** on Windows |
| `Ctrl+Shift+arrow` | selection-extend-by-word in every editor |
| `Ctrl+K` then `Ctrl+arrow` | **free**, and VS Code's own binding for spatial group focus. Chords are already supported (`KeyBinding.chord`, `CHORD_TIMEOUT_MS`) |

**`Ctrl+←`/`→` deserves its own note, because it exposes a gap in this module's stated safety rule.**
`keybindings.ts`'s header says global bindings are safe because the listener is capture-phase and
"every binding here requires a modifier (Ctrl/Shift/F-key), never a bare printable character
CodeMirror needs for typing." That rule protects *typing*. It does not protect **editing keys that
themselves carry a modifier** — and `Ctrl+←`/`→` is word-jump, muscle memory for everyone who has
ever used a text field. Bound globally, the capture-phase listener at `App.tsx:34` would win and
word-jump would silently stop working in Raw. Worth recording as a rule the module states more
narrowly than it means: the real constraint is "never take a key the editor needs," modifier or not.

#### On F6 itself

The instinct that nobody uses it is fair, but F6 is not an arbitrary pick — it is the actual
cross-platform convention for "next pane/region": Windows Explorer, Firefox, Chrome, **GTK/GNOME and
KDE alike**. That answers the "what about Linux?" question: Linux is not a third convention here, it
is the same one. It is also what a screen-reader user will try first.

So **keep F6**. It costs one line, it is what the platform documents, and removing it would make the
app worse for the users least able to work around it. The question is only what to add beside it.

#### Recommendation: add nothing, and make `Ctrl+1/2/3` visible instead

With three panes, direct jumps dominate cycling — `Ctrl+1`/`2`/`3` already reach any pane in one
press, they match VS Code's editor-group numbering, and they no-op safely on a hidden pane
(`focusPane` returns early when the pane is not registered). A cycle binding earns its place at five
or six targets, not three; F6 already covers the case for anyone who wants it.

**The real defect is the same one R63 is about: nothing on screen says `Ctrl+1/2/3` exists.** The
cheap fix is to put the number in each pane header's tooltip (`"Tree (Ctrl+1)"`), reusing D-055's
`"Title (Chord)"` shape — the app already renders exactly that for title-bar buttons, so this is
consistency, not a new idea. That teaches the binding at the moment the user is looking at the pane
they want to reach.

If a second binding is wanted anyway, take **`Ctrl+K` then `Ctrl+←`/`Ctrl+↑`/`Ctrl+↓`** — the only
candidate above that is both free and rooted in software people already use, and the chord
infrastructure exists. It is worse ergonomically than `Ctrl+1/2/3`, which is the argument for not
adding it.

**What is genuinely worth building later, and is a different task:** focus-follows-geometry rather
than focus-follows-a-fixed-map. Five layouts are reachable, so with Detail hidden "down" from Tree
should mean Raw, and today no fixed mapping can express that. That is tmux/i3/VS Code's
"focus group left" behaviour, it needs the layout store rather than the keymap, and it should not be
smuggled into a binding change.

### Acceptance

Assert the Tab-stop count from Tree to Raw is ≤ 4 **on a wide fixture**, not on `cars-small.xml`.
Measuring it on a narrow document is how the unbounded term stays invisible — the count would pass
at 23 today on a fixture with six columns and still be 120 on a real one. This is the same class of
mistake `docs/FINDINGS.md` records under "measuring a component cleanly while leaving the pipeline
around it unmeasured."

## 4. R61 — Tab in Raw

**Measured**: with the caret at the start of an indented line in Raw, Tab moves focus to the
Scrubber (`aria-label="Document position"`) and the line is unchanged.

**Cause**: `Raw.tsx` registers **no CodeMirror keymap at all.** `keymap` appears nowhere in
`src/renderer`, and the extension list at `Raw.tsx:331` is decorations, caret sync, line numbers and
the edit listener — nothing bound to a key. Every keystroke Raw handles today is either the
browser's own contenteditable behaviour or the app's global keymap. So Tab falls through to the
browser's focus traversal, exactly as observed.

**Fix: a `keymap.of([...])` in Raw's extension list**, with:

- **Tab** — insert one indent unit at each cursor; indent the selected lines when the selection
  spans more than one line.
- **Shift+Tab** — remove one indent unit.
- **An escape hatch, and it is not optional.** Trapping Tab inside an editor makes the pane a
  keyboard dead end for anyone who cannot use a mouse. CodeMirror's own documented pattern is
  **Escape, then Tab** — press Escape and the next Tab traverses focus normally. VS Code solves the
  same problem with `Ctrl+M` (toggle "Tab moves focus"). Take CodeMirror's: it is the convention for
  this widget, and it needs no new binding to discover. **Check first what Escape already does while
  Raw has focus** (Find's close path is the obvious collision) — this is a thing to verify in the
  code, not to assume from the pattern.
- **Read-only documents**: no handler, so Tab keeps traversing focus. There is nothing to indent.

**No new dependency.** `indentWithTab` lives in `@codemirror/commands`, which is **not installed** —
`package.json` has only `@codemirror/state` and `@codemirror/view`. Writing the two commands by hand
against `state.changeByRange` is roughly thirty lines and avoids adding a package for two keys.

**No new plumbing either.** `rawEdit.ts` is an `EditorView.updateListener` on `update.docChanged`
(`rawEdit.ts:157`), so a keymap-inserted change reaches `applyEdit` by exactly the path a typed
character does. Nothing about the byte buffer, the delta list or R42's span translation needs to
know a keymap exists.

### What Tab should insert, and an adjacent finding worth more than the feature

The report's concern is a tab-indented file. The honest answer is to **sniff the document's own
indentation** — scan the first N indented lines, use a tab if they use tabs — and fall back to two
spaces. That keeps a tab-indented file tab-indented without adding a setting.

While checking what the app already believes about indentation:

```ts
const DEFAULT_FORMAT_INDENT = '  '                    // documentSession.ts:1503
const DEFAULT_FORMAT_NEWLINE: '\n' | '\r\n' = '\n'    // documentSession.ts:1504
```

Both are hardcoded constants passed to every `format()` call. **Format Document silently rewrites a
tab-indented file to spaces, and a CRLF file to LF.** That is a larger version of the reported
problem — not being able to *type* a tab is an inconvenience; having every existing tab replaced on
a Format is data the user did not ask to change, and on CRLF it makes every line of the file differ
in version control.

This is reported, not folded in: it is a `FormatOptions` plumbing question (detect from the document,
or a setting, or both) that deserves deciding on its own rather than inside a task about a key. It
does **not** block R61 — R61's sniffing is local to the keymap.

## 5. R64 — Enter, and the auto-close question

**Measured**: with the caret at the end of `  <!-- Fleet inventory… -->` (two spaces of indent),
Enter then a character produces a new line reading `Z` — column 0, no indent carried over.

Same cause as §4: no keymap, so Enter is the browser's plain newline.

**Auto-indent on Enter: build it, in R61's keymap.** Copying the current line's leading whitespace
into the new line is ~15 lines against `@codemirror/state`, needs no dependency, and — importantly —
is **format-agnostic**, so it satisfies invariant 8 without anything having to know what XML is.
This is the same keymap R61 adds, which is why the two are one task pair rather than two rounds.

**Auto-closing tags and brackets: not available, and the reason matters.**

| Feature | Package | Installed? |
|---|---|---|
| `indentWithTab`, `insertNewlineAndIndent` | `@codemirror/commands` | no |
| language-aware indentation | `@codemirror/language` | no |
| `closeBrackets` | `@codemirror/autocomplete` | no |
| `autoCloseTags` | `@codemirror/lang-xml` / `lang-html` | no |

So there is nothing to "just switch on" — every one is a new dependency, which needs asking anyway.
But the language-aware ones are worse than a dependency question: **`lang-xml` brings a Lezer
grammar, which is a second parser of the same document.** NodePad already has a parse, a node store
and an incremental reparse; adding a parallel CodeMirror syntax tree over the same ~1 MB window
duplicates the work and the memory on a document the whole architecture is careful about, and it
would be the only place in the app that knows XML by name above `src/formats/`.

Doing it *properly* means asking the format what closes a construct — which is a `FormatCapabilities`
question, and `FormatCapabilities` lives in `src/core/types.ts`. **That is a contract change, so the
standing rule applies: stop and report.** R64 therefore builds auto-indent and reports auto-close as
a contract question with a recommendation attached, rather than reaching for `lang-xml` because it
is nearer.

The recommendation, for when that conversation happens: it is a small capability (something like
"given this open construct, what text closes it"), it is genuinely per-format, and it is exactly the
kind of thing `FormatCapabilities` exists for — but it should be added when a second feature wants
it too, not for one keystroke.

## 6. R63 — the palette is advertised in the one place you immediately leave

The report is right that the palette is undiscoverable, but it is not unadvertised.
`DocumentArea.tsx:48` renders, on the empty screen:

> Press `Ctrl+O`, drag a file onto this window, or open the palette (`Ctrl+Shift+P`).

**That text is on screen only while no document is open** — it is replaced the instant a file loads,
and a user who opens NodePad by double-clicking a file never sees it at all. The one surface that
teaches the palette is the one surface nobody is looking at, because they are looking at the Open
dialog.

### The fix is smaller than it looks

`nodepad.palette.open` (`components/Palette/commands.ts:10`) is registered with
`surfaces: ['palette']` and **no icon**. The title bar already renders one button per command
carrying the `'titleBar'` surface (`TitleBar.tsx:77`; **seven** commands do today — four in
`session/commands.ts`, three pane toggles in `Layout/commands.ts`). So the change is:

```ts
surfaces: ['palette', 'titleBar'],
icon: '<name>'
```

plus one entry in `commands/icons.ts`'s static import map.

**And the tooltip does the actual teaching**, which is the part worth being deliberate about:
`tooltipFor` renders `"Title (Chord)"` (D-055), so the button's tooltip and `aria-label` both read
**"Show All Commands (Ctrl+Shift+P)"**. The button makes the palette clickable; the tooltip makes it
learnable. That is the whole reason this is a better answer than adding another line of hint text.

Seven is already a fair number of icon-only buttons, and an eighth is the point at which the strip
is worth looking at as a whole rather than appending to. That is a judgement to make with the
rendered result in front of you, not in this document — but it is the reason the icon choice below
matters more than it would for button three.

### The icon

Constrained by what the title bar already uses — `folder-open`, `undo`, `redo`, `save`, `revert`,
`code-text`, `search`, `apps-list-detail`, `panel-left`, `panel-bottom`, `filter`,
`table-settings`, the three chevrons and `add`:

| Candidate | Verdict |
|---|---|
| `key_command_20_regular` | the ⌘ glyph — reads as macOS on a Windows-first app |
| `search_20_regular` | already the Find command's icon; two buttons, one glyph |
| `apps_list_20_regular` | too close to `apps-list-detail`, already the Detail toggle |
| **`text_bullet_list_square_20_regular`** | **recommended** — "a list of things in a box", shares no family with anything above |
| `keyboard_20_regular` | defensible fallback; reads as "shortcuts" rather than "commands" |

All five exist in the vendored set (checked in `node_modules/@fluentui/svg-icons`); this is a taste
call, and the last column is a recommendation, not a measurement.

### Rejected: VS Code's title-bar field

VS Code puts a clickable search/command *field* in the centre of its title bar. Against it here:
NodePad's title bar centre already carries the filename with middle-truncation and the dirty dot
(R5), and the whole strip is the window's drag region — a wide interactive control in the middle of
it fights both. A button in the existing `title-bar-actions` group costs nothing and conflicts with
nothing.

### Worth considering alongside, not instead

The empty-state hint is good and should stay. The gap is that **nothing teaches a keyboard model
once a document is open** — not F6, not Ctrl+1/2/3, not the palette. A status-bar affordance, or a
first-run hint, would address that more directly than the title-bar button does; it is out of scope
here because it is a design question with no obvious precedent in this app, and the button is worth
having either way.

---

## Ordering

**R63 first** — it is the smallest, it is independent of the other three, and it is the one that
makes the rest discoverable. Then **R61 + R64 together**: they are one keymap, and splitting them
would mean adding `keymap.of([...])` to `Raw.tsx` twice. **R62 last**, since it is the largest and
the only one that touches component structure rather than adding to it.

---

## Results

Built in the stated order — R63, then R61+R64 together, then R62.

**R63.** `nodepad.palette.open` gained `surfaces: ['palette', 'titleBar']` and
`icon: 'text-bullet-list-square'` (`components/Palette/commands.ts`); the icon itself
(`text_bullet_list_square_20_regular`, the plan's own recommendation) added to `commands/icons.ts`'s
static import map. No new plumbing needed — the title bar already renders one button per
`titleBar`-surfaced command, and `tooltipFor` already reads the existing `Ctrl+Shift+P` binding from
`DEFAULT_KEYBINDINGS`, so the button's tooltip/`aria-label` read "Show All Commands (Ctrl+Shift+P)"
with no separate wiring.

**R61 + R64.** New module `components/Raw/rawKeymap.ts`, split the way `rawEdit.ts` already is: pure
helpers (`sniffIndentUnit`, `leadingWhitespace`) plus a `createRawKeymapBindings` factory returning
the plain `KeyBinding[]` that `rawKeymapExtension` wraps in `keymap.of(...)`. Wired into `Raw.tsx`'s
mount effect, `getIndentUnit` sniffed fresh from a bounded prefix of the live `sourceBufferRef` on
every keypress (not once at mount) — same live-ref reasoning `storeRef`/`sourceBufferRef` already
use for surviving a same-document reparse (R41) without a remount. Tab inserts the sniffed unit at
an empty cursor, replaces a same-line selection, or indents every line a multi-line selection
touches; Shift+Tab dedents up to one unit per line; Enter copies the current line's leading
whitespace. Escape arms a one-shot flag that lets the very next Tab (or Shift+Tab) through to the
browser's own focus traversal instead of indenting — CodeMirror's own documented convention, checked
first against `FindBar.tsx`'s own Escape handler (a React `onKeyDown` on a different DOM element,
confirmed not to collide). Every command checks `state.readOnly` itself, since `document.readOnly`
can flip after mount (F7's Save As) without remounting the view. No new dependency —
`@codemirror/commands` (which would have supplied `indentWithTab`) is still not installed;
hand-written against `state.changeByRange` instead, ~150 lines including comments. `DEFAULT_FORMAT_INDENT`/`DEFAULT_FORMAT_NEWLINE`'s own silent-rewrite gap (§4's "adjacent finding")
was re-confirmed still present (`documentSession.ts:1503-1504`) and left as disclosed future work,
exactly as the plan scoped it.

**R62.** New shared module `src/renderer/rovingTabIndex.ts` (`nextRovingIndex`, pure; `useRovingTabIndex`,
the React hook) — used identically by Detail's breadcrumb segments (`Detail.tsx`) and the grid
toolbar's filter/CSV/TSV/MD buttons (`Grid.tsx`). The grid header's own Pin/sort-label controls took
a different shape (D-078): `tabIndex={-1}` on both buttons, reachable instead through the grid's
existing `onKeyDown` via a header "row" (`active.row === -1`, entered by ArrowUp from row 0, exited
by ArrowDown) — Enter toggles sort, a bare `P` toggles pin, and the active header cell gets the same
`grid-cell-active` class/`aria-selected` the body's own active cell already uses. Detail's non-grid
list mode gained no arrow navigation, per the plan's own "fine to defer" call.

**Acceptance.** §3's own criterion (Tree → Detail → Raw in ≤ 4 Tab presses, measured on a wide
fixture) is satisfied by construction: the grid header's O(columns) stops are gone (`tabIndex={-1}`
on every Pin/label button, `test/gridKeyboardNav.test.tsx`'s own assertion), and the toolbar/
breadcrumb groups are one stop each — nothing between Tree and Raw scales with document width
anymore. Not re-measured with the original 24-press manual probe (§2's own method): the fix is a
removal of tab stops, verified structurally, not a walk that would just re-confirm the same absence.

**Review.** One finding, fixed before commit: the header-row keyboard tests (`ArrowUp` then `Enter`/
`p` in the same synchronous burst) initially read a stale `active` value, because two `dispatchEvent`
calls issued back-to-back without an intervening paint hit the same pre-update React closure —
fixed by awaiting a render between them, which is also the more honest shape for what a real
keypress sequence looks like. No other findings — the keymap commands (`rawKeymap.ts`) and the
roving-tabindex hook (`rovingTabIndex.ts`) are both small enough, and split into pure-logic/DOM-
wiring halves cleanly enough, that nothing else turned up rereading the diff.

**Tests.** `test/rawKeymap.test.ts` (16, the CodeMirror-free command logic against a fake
`{state, dispatch}` target), `test/rovingTabIndex.test.ts` (7, `nextRovingIndex`'s pure arithmetic),
`test/gridKeyboardNav.test.tsx` (6, real Chromium — tabIndex, header-row entry/exit, sort/pin
toggling, the toolbar group), `test/detailBreadcrumbNav.test.tsx` (2, real Chromium — the breadcrumb
group). All pass; `npm run typecheck` and `npm run lint` both clean (three pre-existing
`react-hooks/incompatible-library` warnings, unrelated, at the ratchet's own limit).
