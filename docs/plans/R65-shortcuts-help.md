# R65 — the keyboard shortcuts panel

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Comes out of `docs/plans/R61-keyboard-workflow.md` R62's refinement,
which proposed pane-header tooltips and is superseded by this for the reason in §1. Related: R63
(the palette's own discoverability) and R60 (this adds an elevated surface). Results at the end of
this file.

The report: a **Help: Shortcuts** palette command opening a large modal that lists the important
navigation and editing shortcuts.

---

## 1. Why this replaces the tooltip idea rather than joining it

R62's refinement suggested putting `(Ctrl+1)` in each pane header's tooltip. Checked:
`Layout.tsx:66` renders the pane label as

```tsx
<span className="pane-header-label">{props.label}</span>
```

— a bare `<span>` with no `title`. Only the header *buttons* carry tooltips, through `tooltipFor`.
So that suggestion would have added a hover-only affordance where none exists today, on a
non-interactive element, discoverable only by hovering something that does not look hoverable. The
report is right to skip it. A panel is the better answer to the same problem, and it scales to the
keys that have no button anywhere to hang a tooltip on.

## 2. The finding: the app already displays chords it cannot know are correct

This is the part that makes R65 more than a UI task.

Keybindings are **user-overridable** — `keybindings.ts`'s own header: *"user-overridable and
persisted as a JSON file in `userData` — no in-app editor in M1, the file is the whole interface."*
`loadKeybindings()` reads that file over IPC.

But the loaded result is stored in a **local variable inside `useKeymap`'s effect** (`App.tsx:22`):

```ts
let bindings: readonly KeyBinding[] = []
const controller = createKeymapController(() => bindings)
loadKeybindings().then((loaded) => { if (!disposed) bindings = loaded })
```

Nothing outside that closure can read it. So every chord the app *displays* comes from
`defaultChordFor`, which looks up `DEFAULT_KEYBINDINGS` — the defaults, not the effective bindings.
`keybindings.ts`'s own doc comment on `defaultChordFor` says so plainly, and calls it "still an
accurate hint in the common case."

That reasoning holds for a tooltip. **It does not hold for a panel whose entire purpose is to be the
authoritative answer to "what are the keys?"** — a user who has overridden their keymap is exactly
the user who opens it, and it would confidently tell them the wrong thing for every key they
changed. Today this affects the palette's hints and title-bar tooltips; R65 would industrialise it.

**So R65 depends on making the loaded keymap readable**: a small module-level store in
`keybindings.ts` in the shape `theme.ts` and `layoutStore.ts` already use — `getKeybindings()` plus
`subscribeKeybindings()` — set once by `loadKeybindings()`'s resolution, with `DEFAULT_KEYBINDINGS`
as the value before it resolves. `useKeymap` reads from it instead of its private `let`, so there is
one source of truth rather than two.

Two consequences worth taking deliberately:

- **`defaultChordFor` should gain an effective-binding sibling, not change meaning.** The palette and
  tooltips should move to it too — that is a strictly correct change and the same one-line call
  site — but it is a behaviour change to surfaces R65 was not asked to touch, so make it in R65 and
  say so, rather than leaving two chord-lookup functions with no rule about which to call.
- **The async window is real and now visible.** `App.tsx`'s own comment already accepts that
  bindings load asynchronously. A panel opened in that window would render defaults; with the store
  and a subscription it re-renders when the real ones arrive. That is the argument for a subscribable
  store rather than a plain getter.

## 3. What goes in the panel

Two kinds of key, and the difference decides the design:

**a. Commands with bindings — derived, never hand-written.** The registry has every command's `id`,
`title` and `category`, and the keymap has the chords. `category` already partitions into exactly
the groups the report asks for: **File (17), Edit (18), Navigate (8), View (17)** — cross-checked
against the 60 `registerCommand` calls in `src/renderer`, so every command has one and the four
account for all of them. Rendering
`category → [title, chord]` from the registry means the panel cannot drift from what the app
actually does, which a hand-maintained list is guaranteed to do — this project has a standing
example in invariant 10, which is enforced by test precisely because "remember to add it" does not
survive contact with a year of rounds.

**b. In-pane keys that are not commands — curated, and unavoidably so.** Tree's arrows, Home/End and
Enter/Space (`Tree.tsx:358-388`), the grid's cell arrows (`Grid.tsx:461-476`), and — once R61 lands —
Raw's Tab/Shift+Tab/Enter and the Escape-then-Tab hatch. None of these is a registered command,
none has a chord in `DEFAULT_KEYBINDINGS`, and **these are exactly what the report means by
"navigation and editing"**. They have to be authored by hand.

Be honest about (b) in the code rather than pretending otherwise: it is a literal table in the panel
module, with a comment naming the three files it describes, so that the next person changing
`Tree.tsx`'s key handler has one place to look. Do not try to derive it — the alternative is a test
that parses `switch (event.key)` blocks, which would be worse than the drift it prevents.

### Grouping

Present the curated in-pane section **first**, grouped by pane (Tree / Detail / Raw), then the
derived command sections by category. Rationale: the reported use is *"navigate the file"*, which is
the in-pane keys; the command list is long and skimmable, and a user reaching for `Ctrl+S` already
knows to look under File.

Every command with a binding appears. Do not curate the derived half to "important" ones — the
selection would be someone's guess, it would go stale silently, and the panel is scrollable.

## 4. Opening it

- **Command**: `nodepad.help.shortcuts`, title **"Help: Shortcuts"** (the report's own name),
  registered with `surfaces: ['palette']`. Invariant 10 is satisfied by construction.
- **Category**: this needs a fifth, `Help`. `Command.category` is typed `string`
  (`registry.ts:43`), not a union, so this costs nothing but the string itself. The existing four are File/Edit/Navigate/View and it
  belongs to none of them; a `Help` category also gives the panel somewhere to put itself and any
  later "About".
- **Binding: `F1`.** Free (`F3`, `F6`, `F8` are taken), and universal for help across Windows, GTK
  and KDE. R62's refinement noted F-keys are awkward on a modern keyboard — that argument was about
  a key used constantly in a workflow, which is not this: a shortcuts panel is opened rarely and
  deliberately, and F1 is the one F-key everyone still knows.
- **Not `?`.** It is the web convention (GitHub, Gmail, Slack) and it is unavailable here for a
  structural reason worth recording: `keybindings.ts` requires every global binding to carry a
  modifier, because the listener is capture-phase and a bare printable key would be stolen from
  typing in Raw. `?` is a bare printable key. This is the rule working as intended.
- Optionally also `Ctrl+K Ctrl+S`, VS Code's binding for the same thing. Cheap (chords are
  supported), but a second binding for a rarely-opened panel is decoration; F1 plus the palette is
  enough.

## 5. The surface itself

Reuse the palette's shape rather than inventing one — `Palette.tsx` already solves the hard parts
(overlay, focus containment, Escape to close, restoring focus to wherever it came from,
`useSyncExternalStore` over a module-level open/closed store). `components/Help/` mirroring
`components/Palette/`'s layout is the natural home: `Shortcuts.tsx`, `shortcutsStore.ts`,
`commands.ts`, `Shortcuts.css`.

Sizing: wider and taller than the palette's `min(560px, …)` / `max-height: 60vh`, since this is a
two-column reference rather than a filter list — but it must scroll inside its own box, and it must
not assume a window height.

**It is an elevated surface, so R60 applies.** `--elev-2-bg` plus the `--surface-border` hairline —
without the hairline it is invisible against a light-mode pane, and with R60's dark change it needs
the border to have any boundary at all. **This is the first new elevated surface since R60, so it is
also the first real test of R60's acceptance criterion 3** ("every `--elev-2-bg` surface resolves a
non-`none` border in both themes"), which exists exactly so this panel cannot be added without one.
If R65 lands before R60, give it the border anyway and say so.

Accessibility: `role="dialog"`, `aria-modal="true"`, a labelled heading, and — since this is the
app's keyboard documentation — it must itself be fully keyboard-operable, including scrolling.

## 6. Acceptance

1. **Every binding in the effective keymap appears in the panel.** A test over
   `DEFAULT_KEYBINDINGS`, asserting each `commandId` resolves to a registered command that the
   panel renders. This is invariant 10's own trick applied to documentation, and it is what stops
   §3a from drifting.
2. **The panel shows the effective binding, not the default.** Load an override that changes one
   chord and assert the panel renders the overridden one — the direct regression test for §2, and
   the reason §2 is a finding rather than a detail.
3. Opens from both the palette and `F1`, closes on Escape, and returns focus where it came from.
4. Renders a non-`none` border in both themes (§5 / R60).

## 7. Not in scope

**No keybinding editor.** `keybindings.ts` says the JSON file *is* the interface, and this panel is
read-only documentation. Showing effective bindings makes an in-app editor easier later; it does not
imply one, and building both at once would put a settings UI inside a help task.

**Nothing is checked against the OS.** R59 already recorded that Electron's default application menu
binds `Ctrl+=`/`Ctrl+-`/`Ctrl+0` to its own zoom roles and that whether the app's bindings win is
unverified. The panel lists what NodePad believes; it cannot know what the platform intercepts, and
should not imply otherwise.

---

## Results

**§2's store, built as specified.** `keybindings.ts` gained `getKeybindings`/`setKeybindings`/
`subscribeKeybindings` (module-level, `theme.ts`'s own shape) plus `effectiveChordFor` alongside the
existing `defaultChordFor`. `App.tsx`'s `useKeymap` now resolves `loadKeybindings()` into the store
instead of a private closure `let`. The consequence §2 called out deliberately was made in this same
round, not deferred: `uiHelpers.ts`'s `tooltipFor` (every title-bar button and pane-header button),
`Palette.tsx`'s own chord hint, and `Grid.tsx`'s quick-filter label all moved from `defaultChordFor`
to `effectiveChordFor` — one-line call-site changes each, verified by a new
`describe('the effective-keybindings store (R65 §2)')` block in `test/keybindings.test.ts` (4 tests).

**§3/§4/§5 built as specified**, one deviation: the derived half reads `getAllCommands()` filtered by
`surfaces.includes('palette')` rather than `commandsForSurface('palette', context)`. `commandsForSurface`
is `when`-filtered, live context — correct for a menu, wrong for documentation, since a command whose
`when` is momentarily false (no document open, say) still has a real chord worth knowing. This mirrors
D-055's own "disabled, not hidden" reasoning for the title bar, applied to a reference panel instead
of a button. New modules: `components/Help/shortcutsStore.ts`, `commands.ts`
(`nodepad.help.shortcuts`, category `Help`, `F1` — added to `DEFAULT_KEYBINDINGS`), `Shortcuts.tsx`,
`Shortcuts.css`. `IN_PANE_KEYS` is the curated table §3b asked for, naming `Tree.tsx`, `Grid.tsx`, and
`components/Raw/rawKeymap.ts` (R61/R64, landed in the same stretch as this task) as the three files it
describes.

**Acceptance, all four met:**

1. Every `DEFAULT_KEYBINDINGS` entry resolves to a registered, palette-surfaced command whose title
   renders in the panel — `test/shortcuts.test.tsx`.
2. Loading an override (`setKeybindings`) changes what the panel renders, not what
   `DEFAULT_KEYBINDINGS` itself says — the direct regression test for §2.
3. Opens via the palette command, via `F1` through the real `createKeymapController` +
   `DEFAULT_KEYBINDINGS`, closes on Escape, and restores focus to wherever it was.
4. `.shortcuts-panel` resolves a non-`none`, non-transparent border in both themes — the first real
   exercise of R60's own acceptance criterion 3, also covered structurally by adding
   `components/Help/Shortcuts.css` to `test/elevationBorders.test.ts`'s enumerated surface list.

**Review.** One thing worth recording rather than a defect: the first draft filtered the derived
section through `commandsForSurface`, which would have made the panel's own contents depend on
whatever context happened to be live when it was opened — caught rereading the diff against §3a's
"cannot drift from what the app actually does," which implies stability, not a live filter. Switched
to the unfiltered `getAllCommands()` scan before committing. No other findings.

**Tests.** `test/keybindings.test.ts` gained 4 (the store); `test/shortcuts.test.tsx` (new, 8, real
Chromium) covers all four acceptance criteria plus the empty-when-closed case. `npm run typecheck`
and `npm run lint` both clean.
