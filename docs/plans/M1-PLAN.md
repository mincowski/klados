# NodePad — M1 Implementation Plan

<!-- status: built -->

**Audience:** the coding agent implementing this milestone.
**Reference:** `CONCEPT.md` §4 (views), §7 (commands), §8 (performance), §9 (theming),
§11 (lifecycle). `DECISIONS.md` D-026 to D-031. `src/core/types.ts` (unchanged, still).

---

## How to use this plan

Work through tasks **in order**. Each has explicit acceptance criteria — do not move on
until they pass. Where a task says "stop and report," stop and report.

> **M0c is complete** (`docs/plans/M0-RESULTS.md`). **D0 must land before D6.** D1–D5 build UI
> infrastructure and touch nothing in `src/core/`, so they can proceed in parallel with D0.
> D6 is the first code that ever performs a real worker transfer, and D0 fixes two defects
> in exactly that seam — one of which hangs the app on untrusted input.

### What M1 is

The application becomes usable: open a file, see its tree, inspect a node, read its source,
navigate by keyboard. Three views, synchronized, in two themes, driven by a command
registry.

### What M1 is not

Three things the concept describes in detail that are **out of scope**, all of which an
agent reading `CONCEPT.md` will be tempted to start:

1. **No editing.** §12 puts editing at M3. The Raw View is **read-only** in M1 —
   `EditorState.readOnly.of(true)`, the `isReadOnly` context key pinned true, no undo
   stack, no pending-delta list, no reparse. This is not a placeholder to be improved on;
   it is what removes half the difficulty from D10, and building the window against a
   moving document before it works against a static one is how D10 fails.
2. **No grid mode.** §4.3's grid is the signature feature and it is M2. D9 builds **list
   mode only**. Do not implement group detection, column collection, or transparent
   wrappers, and do not build "scaffolding for later" — M2 will want the detection
   algorithm designed against real documents, not against a guess made now.
3. **No search.** §6 is M4. The palette's `@` and `:` prefix modes are in scope (D5)
   because they are navigation, not search; text find and path queries are not.

Streaming tree population is M5. In M1 the tree renders after the parse completes.

### Hard rules

The M0 rules stand. Five more, specific to building a UI on this data layer:

1. **No object per node — including in React.** The single most likely way this milestone
   goes wrong is a developer mapping the store into `{ id, name, children }` for the tree,
   because that is what every React tree example takes as a prop. At 6.6 M nodes that is
   6.6 M objects and the flat store was pointless. Components take a `NodeRef` (a number)
   and read through `NodeStore` accessors. Row components are keyed by `NodeRef`.
2. **The editor never receives more than one window.** No code path may construct an
   `EditorState` over the whole document — not for a small file, not as a fast path, not
   temporarily. D-031 is the decision the Raw View exists on top of. A size check that says
   "this file is small, just load it all" reintroduces the tiered Raw View that M0a
   deleted, and it will be written by someone who thinks they are being kind to small files.
3. **No literal colours in components.** Semantic tokens only, enforced by stylelint (D2).
   This includes the CodeMirror theme.
4. **Every command reachable from any surface is reachable from the palette.** Enforced by
   the test in D3, not by discipline.
5. **Nothing above `src/formats/` tests a format id.** Format-varying behaviour reads
   `FormatCapabilities`. If a view needs to know something the capabilities do not express,
   that is a signal the capabilities are missing a field — stop and report rather than
   writing `if (formatId === 'xml')`.

---

## Dependencies

`CLAUDE.md` requires asking before adding any dependency. Below is everything M1 needs,
with registry-reported unpacked sizes and licences. **Every package is MIT**, which matters
for §10.2: NodePad is MIT and bundles third-party licence texts at build time.

### Runtime

| Package | Version | Licence | Unpacked | Why |
|---|---|---|---|---|
| `react` | 19.2.8 | MIT | 172 KB | §10.1 |
| `react-dom` | 19.2.8 | MIT | 7.3 MB † | §10.1 |
| `scheduler` | 0.27.0 | MIT | 83 KB | transitive of `react-dom` |
| `@codemirror/state` | 6.7.1 | MIT | 436 KB | §4.4 |
| `@codemirror/view` | 6.43.7 | MIT | 1.25 MB | §4.4 |
| `@marijn/find-cluster-break` | 1.0.3 | MIT | 14 KB | transitive of `@codemirror/state` |
| `crelt` | 1.0.7 | MIT | 6 KB | transitive of `@codemirror/view` |
| `style-mod` | 4.1.3 | MIT | 24 KB | transitive of `@codemirror/view` |
| `w3c-keyname` | 2.2.8 | MIT | 8 KB | transitive of `@codemirror/view` |
| `@tanstack/react-virtual` | 3.14.9 | MIT | 57 KB | tree virtualization (D8) |
| `@tanstack/virtual-core` | 3.17.7 | MIT | 405 KB | transitive |

† `react-dom`'s unpacked size is dominated by development and profiling builds that never
reach the bundle; the production build is ~130 KB gzipped.

**Eleven packages, nine of them transitive from three direct choices.** That is a small
tree by React standards and it is deliberate.

### Development

| Package | Version | Licence | Unpacked | Why |
|---|---|---|---|---|
| `@types/react` | 19.2.18 | MIT | 409 KB | types |
| `@types/react-dom` | 19.2.4 | MIT | 30 KB | types |
| `@vitejs/plugin-react` | 6.0.5 | MIT | 40 KB | JSX transform, Fast Refresh |
| `eslint-plugin-react-hooks` | 7.1.1 | MIT | 4.1 MB | hook-rule lint |
| `stylelint` | 17.14.1 | MIT | 961 KB + 35 direct deps | enforces invariant 9 (D2) |

### Two packages I recommend **against**, with reasons

**`cmdk` (1.1.1, MIT, 82 KB) — do not add.** §10.1 names it as "`cmdk` or equivalent,"
and on size alone it looks free. Its dependency tree is not: `cmdk` pulls four Radix
packages, and `@radix-ui/react-dialog` alone pulls fifteen more (`react-remove-scroll`,
`aria-hidden`, `focus-scope`, `dismissable-layer`, `presence`, `portal`, …) — roughly
twenty-five packages transitively, more than doubling M1's runtime tree, for a filtered
list.

Worse, it is the wrong shape. §7 requires the palette to be **generated from the registry**
with `when`-clause filtering, recency ranking, and three prefix modes (`>` commands, `@`
jump to node, `:` go to position). None of that is cmdk's model; all of it would be fought
in. What remains that cmdk actually provides is fuzzy matching and roving-focus keyboard
handling — perhaps 200 lines against a data source that is already a plain array.

**Build the palette (D5).** If it turns out worse than expected after a genuine attempt,
stop and report — reversing this is cheap and adding a dependency later costs nothing that
adding it now would have saved.

**`@codemirror/commands` (6.10.4, MIT, 244 KB) — probably not, decide in D10.** It is the
conventional way to get a default keymap, but it depends on `@codemirror/language` and
`@lezer/common` (556 KB together) — an entire syntax-tree layer that NodePad explicitly
does not use, since decorations come from NodePad's own parse tree (§4.4).

M1's Raw View is read-only, so most of what that package provides — every editing command,
undo, indentation — is dead weight by construction. What is actually needed is cursor
motion and selection, which `@codemirror/view` provides through the `keymap` facet and
`contenteditable`. **Try the `keymap` facet first.** If a genuinely needed behaviour
(`Home`/`End` semantics on wrapped lines is the likely one) turns out to live in
`@codemirror/commands`, add it and say which behaviour forced it.

### Not needed, despite appearances

- **`@codemirror/search`** — M4, and NodePad's find runs over bytes, not the editor's window.
- **A CSS-in-JS library** — §9.2 specifies CSS custom properties on `:root` switched by a
  `data-theme` attribute, chosen precisely because it costs no runtime and no re-render.
- **A state management library** — §4's state is `{ selectedNode, caretOffset }` plus a
  context-key store. Two `useSyncExternalStore` subscriptions, not Redux.
- **An icon package** — `assets/` already holds the Fluent set the project vendored; see
  `assets/README.md`.

Install nothing until the user has signed off on this table.

---

# Tasks

## D0 — Close the worker transfer seam

**Files:** `src/worker/parse.worker.ts`, `src/core/parseClient.ts`, `src/core/encoding.ts`

Two defects found reviewing M0c, both in the seam D6 depends on and neither reachable
before now, because nothing has ever run a real `Worker`. Small — half a day — and both
are the kind that only ever surface in production if not fixed here.

### D0.1 — The store arrays are copied, not transferred

`self.onmessage` builds its transfer list as `[response.bytes, response.rowIndex.buffer]`.
The fifteen arrays in `storeBuffers` and the three in `internerBuffers` are **not in it**,
so structured clone **copies** them on every parse:

| | Bytes |
|---|---|
| In the transfer list (source + row index) | 229.7 MB |
| Structured-cloned instead — `storeBuffers` + `internerBuffers` | **257.3 MB** |

B11's own acceptance criterion says the worker *"transfers the resulting arrays back — also
zero-copy."* It never did. `M0-RESULTS.md` names this honestly in its SharedArrayBuffer
note but files it as future work; it is not future work, because D6 is the first code that
will actually pay for it — peak during `postMessage` is store + clone + source ≈ **714 MB**,
against an 800 MB bar that `M0-RESULTS.md` states was measured in-process, never across a
transfer.

The fix is the transfer list. Every array in both records is a `.slice()` product owning
its own `ArrayBuffer` (verify: `NodeStore.exportBuffers` and `Interner.exportBuffers` both
slice), so there are no aliased or duplicate buffers and transferring is safe. Collect
every `ArrayBuffer.isView` value from both records, plus `bytes` and `rowIndex.buffer`.

This does **not** settle the `SharedArrayBuffer` question — that is about the source buffer
ping-ponging back for incremental reparse, and it stays open.

**Acceptance:** a real Electron-hosted parse of `cars-200mb.xml` where every transferred
array is detached in the worker afterwards (`byteLength === 0`) and intact on the main
thread. Peak main-thread RSS across the transfer measured and recorded — this is the first
time the 800 MB bar is tested on the path that actually ships.

### D0.2 — A bad declared encoding hangs the app

`<?xml version="1.0" encoding="NONSENSE"?><a/>` parses fine and the worker returns
`encoding: 'NONSENSE'`. `parseClient` then calls `new SourceBuffer(bytes, 'NONSENSE', 0)`,
whose constructor calls `new TextDecoder('NONSENSE')`, which throws `RangeError`.

Where it throws is what makes it serious. In `worker.onmessage` the throw lands **after**
`settled = true` and **before** `cleanup()`:

- the promise is never resolved and never rejected — it hangs forever
- the worker is never terminated — it leaks
- the user sees a spinner and no error, on a document NodePad parsed perfectly well

The encoding label comes from the document's own prolog, so this is untrusted input
producing an unrecoverable hang. §11.1 says an invalid document opens with a diagnostic;
this one opens with nothing at all, ever.

Two fixes, both wanted:

1. **Validate the label in the worker,** where the diagnostic channel already exists. Try
   `new TextDecoder(label)`; on `RangeError`, emit a **Warning** diagnostic
   (`nodepad.encoding.unrecognized`) naming the label, and resolve to `utf-8`. The main
   thread then never receives a label it cannot construct a decoder from. Warning, not
   Fatal — unlike UTF-16 (C1), an unrecognised label on ASCII-compatible bytes usually
   parses correctly anyway, and refusing would be worse than proceeding with a note.
2. **Make `onmessage` incapable of hanging.** Wrap its body so any throw rejects the
   promise and terminates the worker. D0.1's fix is the specific bug; this is the class.

**Acceptance:** the `NONSENSE` document resolves, carries a Warning diagnostic, and reports
`utf-8`. A forced throw anywhere in `onmessage` rejects rather than hangs. A test for the
first case needs no `Worker` — `runParseJob` is directly callable.

### D0.3 — Size the row index from a sample, and stop copying it

Not a defect and **not blocking**, but C2's stated acceptance criterion — *"the transient
heap delta while building drops below the size of the resulting array"* — is not met, and
the fix is cheap. Measured on `cars-200mb.xml`:

| | |
|---|---|
| Result | 29.7 MB (7,796,094 rows) |
| Accumulator at final capacity | 50.0 MB |
| **Peak live during `toArray()`** | **79.7 MB** — 2.7× the result |
| Build time | 930 ms, against the boxed `number[]` version's 994 ms |

Two causes, and both have to be fixed or neither pays.

**The capacity estimate is 19× under.** `bytes.length / maxRowBytes` assumes every row runs
the full 512 bytes, which is true only of minified input. Measured across the fixtures:

| Fixture | Actual rows | `bytes.length / 512` | Off by | 256 KB sample × 1.1 | Off by |
|---|---|---|---|---|---|
| `cars-10mb.xml` | 389,815 | 20,482 | 19.0× | 428,915 | 0.91× |
| `cars-200mb.xml` | 7,796,094 | 409,602 | 19.0× | 8,578,243 | 0.91× |
| `cars-100mb.json` | 3,760,867 | 204,802 | 18.4× | 4,133,369 | 0.91× |
| `cars-100mb.min.json` | 207,189 | 204,802 | 1.0× | 228,362 | 0.91× |
| `deep-1m.json` | 3,907 | 3,908 | 1.0× | 4,298 | 0.91× |

Sampling the first 256 KB with the real cutting rule and extrapolating with a 1.1× margin
lands at **0.91× on every fixture** — consistently ~10% over, never under — and costs
**1.1 ms** on a 200 MB file.

**`toArray()` copies.** Even with a perfect estimate, slicing to a tight array means both
arrays exist at once. The copy is half the peak, not a rounding error on it.

### What to build

1. **Estimate by sampling.** Run the existing cutting rule over
   `min(256 KB, bytes.length)`, extrapolate by `bytes.length / sampleSize`, multiply by
   1.1. Clamp into `[bytes.length / maxRowBytes, bytes.length / 16]` — the lower bound is
   today's estimate, which is a true structural floor; the upper bound caps the damage if
   the sample is unrepresentative in the other direction.
2. **Do not copy when the overshoot is small.** If the used length is within ~15% of
   capacity, return `subarray(0, len)` rather than `slice(0, len)`. The view's buffer is
   transferable exactly as the tight array's is; it just carries ~3 MB of slack.
   Above that threshold, slice as now — that path still exists for the case where the
   sample was wrong and the array doubled.
3. Keep the growable `Int32Array`. It is the right structure; only its starting size and
   its exit were wrong.

Expected: **peak 32.7 MB, build ~931 ms**, holding 32.7 MB instead of 29.7 MB. At 500 MB
that is ~82 MB peak against today's ~200 MB, on a file §8 budgets at ~1.25 GB total and
§11.4 already treats as near the multi-tab ceiling.

### Why not the two obvious alternatives

**Counting exactly in a first pass** gives a perfect 29.7 MB peak, and costs a **second
full scan: 951 ms measured, against a 930 ms build.** That doubles the time of the most
latency-visible moment in the application to save 3 MB over the sampled version.
`M0-RESULTS.md` rejected a pre-scan at *"~40% of the function's own build time"* — the real
figure is ~100%, so its conclusion was right for the wrong reason and its measurement
should not be reused.

**Leaving it alone** is defensible: 50 MB, transiently, in a worker, once per open. If D0's
budget is better spent on D0.1 and D0.2, say so and move on — but then correct
`M0-RESULTS.md` to state 79.7 MB rather than implying a reduction that was not measured.

### Degradation, which is the reason sampling is safe

- **Sample under-estimates** (long single-line header, then pretty-printed records): the
  array doubles exactly as it does today. No worse than the status quo.
- **Sample over-estimates** (newline-dense header, minified body): the `/ 16` clamp bounds
  the allocation at ~52 MB on a 200 MB file — roughly what the current code already peaks at.

**Acceptance:** B7's existing tests pass unmodified — the returned offsets are unchanged and
only the allocation strategy differs. A test asserts the estimate is within 2× of the true
row count for one pretty-printed and one minified fixture. `M0-RESULTS.md`'s C2 paragraph
states the peak transient figure a fresh run reproduces.

## D1 — Renderer scaffold

**Files:** `src/renderer/`, `electron.vite.config.ts`, `tsconfig.web.json`,
`eslint.config.mjs`

React into the existing electron-vite scaffold. `src/renderer/index.html` exists and loads
nothing; give it an entry point, a root component, and Fast Refresh in dev.

Also: `electron.vite.config.ts` is currently `{ main: {}, preload: {}, renderer: {} }`. The
worker (B11) is instantiated via `new Worker(new URL(…), { type: 'module' })` and has never
run through a real Vite build — only as a direct function call in tests. Verify it builds
and instantiates. If it does not, that is a D1 problem, not a D6 problem.

**Acceptance:** `npm run dev` opens a window rendering a React component. `npm run build`
produces a working package. `npm run typecheck` and `npm run lint` stay clean, with
`eslint-plugin-react-hooks` active. A trivial worker round-trip succeeds in the built app.

## D2 — The style system

**Files:** `src/renderer/styles/palette.css`, `themes/light.css`, `themes/dark.css`,
`tokens.css`, `.stylelintrc`, `package.json`

§9's two layers: a raw colour ramp referenced **only** by theme files, and semantic tokens
referenced **only** by components. Implemented as CSS custom properties on `:root`,
switched by `data-theme`.

Requirements that are easy to get wrong and expensive to retrofit:

- **Dark is authored, not inverted** (§9.1). Two peer token sets.
- **Elevation is a token pair** (§9.3): `--elev-N-bg` *and* `--elev-N-shadow`. Light theme
  carries elevation in the shadow; dark theme drops the shadow near zero and steps the
  background lighter. Components declare a level and never set a shadow. This is the
  specific requirement that makes a hand-built style system necessary — a theme layer that
  only swaps colours produces a dark mode where every elevated surface looks flat.
- **The elevation budget** (§9.4): elevated = the top command bar and transient surfaces
  only. The three panes are flat, separated by 1px dividers and background tone.
- **Row height 22–24px**, not Fluent's touch defaults.
- **The CodeMirror theme is defined in the same token set** (§9.2), not in a separate
  editor config. D10 consumes it; define the syntax tokens now (`syntax.tagName`,
  `syntax.attrName`, `syntax.string`, `syntax.number`, `syntax.comment`, …) even though
  nothing renders them yet.

**Enforce invariant 9 with tooling.** stylelint's `color-no-hex`, plus
`declaration-property-value-disallowed-list` for `rgb(`/`hsl(`/named colours, scoped to
everything except the theme files. Add `npm run lint:css` and include it in `npm run lint`.

**Add the theme-toggle command in this task**, wired to a keybinding, before D3's registry
exists if necessary and moved into it after. §9.6 is explicit: dark mode is not a
user-facing v1 feature and will rot unless it is used constantly during development.

**Acceptance:** a hex literal added to any component file fails `npm run lint`. Toggling
`data-theme` on `:root` switches themes with no React re-render (verify with a render
counter). Both themes have complete token sets — a test asserting that
`light.css` and `dark.css` define exactly the same token names catches the drift §9.6
predicts.

## D3 — Command registry and context keys

**Files:** `src/renderer/commands/registry.ts`, `context.ts`, `test/commands.test.ts`

The `Command` interface from §7, verbatim:

```ts
interface Command {
  id: string
  title: string
  category: string
  icon?: IconRef
  when?: ContextExpression
  surfaces: Surface[]     // palette | commandBar | paneHeader | contextMenu
  weight?: number
  run(ctx: AppContext): void
}
```

Context keys are a small reactive key/value store — `focus`, `format`, `nodeKind`,
`hasSelection`, `isReadOnly`, `isWrapped`. **There is deliberately no `isLargeFile` key**
(§7); an earlier draft had one and D-031 removed the tiering it gated. If a command needs
to vary by file size, that is a design signal — stop and report.

`ContextExpression` needs `==`, `!=`, `&&`, `||`, `!` and bare truthiness. Write the
evaluator; it is about eighty lines and a dependency for it would be absurd.

**Menus, keybindings, the command bar and pane headers are all generated by filtering the
registry** (D-026). Nothing is wired individually. This is the task where that is
established, and every later task adds commands rather than handlers.

**Every later task registers its commands through `commands/builtins.ts`**, importing its
own module there rather than from a view. The palette-parity test below can only cover what
has been imported, so a command module reached only from a component is invisible to it —
the invariant would then pass while no longer checking anything. One barrel, one import in
the test.

**Acceptance:** the invariant test required by §7 — *every command whose `surfaces`
includes anything must also include `palette`* — over the live registry, so it fails when a
later task adds a pane-header button without a palette entry. Context expressions have unit
tests including precedence. Registering two commands with the same id throws in dev, and a
malformed `when` throws at registration rather than when a surface first queries it.

## D4 — Keybindings and the focus model

**Files:** `src/renderer/commands/keybindings.ts`, `src/renderer/focus.ts`

- Chord support (`Ctrl+K Ctrl+S`), with a pending-chord indicator so a half-entered chord
  is visible rather than mysterious
- Bindings resolved against the registry by command id, never against handlers
- User-overridable, persisted as a keybindings file (a JSON file in `app.getPath('userData')`;
  no UI for editing it in M1)
- A defined focus model for moving between the three panes, driving the `focus` context key

The Raw View complicates this: CodeMirror consumes keys inside the editor. Establish which
bindings are global (palette, pane toggles, focus movement) and which the editor may
swallow, and make that a documented rule rather than a series of `stopPropagation` calls
discovered one bug at a time.

**Acceptance:** a chord fires the right command and a mistyped chord cancels cleanly. A
binding on a command whose `when` is false does not fire. Focus moves between all three
panes by keyboard alone, and `focus` updates on every transition.

## D5 — Command palette

**File:** `src/renderer/components/Palette/`

Built in-house — see the dependency section.

- Fuzzy match over the registry, filtered by the current `when` context
- Recently-used ranked first, persisted across sessions
- Prefix modes: `>` commands (default), `@` jump to node by name, `:` go to position — a
  line number, or a byte offset in documents without meaningful lines (§7)
- Elevated surface (§9.4), correct focus trapping and restoration, `Esc` closes

`@` and `:` need a document open, so build `>` now and wire the other two in D14 once
navigation exists. Register them as disabled-without-a-document rather than absent, so the
palette does not change shape when a file opens.

**Acceptance:** every registry command is reachable by fuzzy search. Filtering respects
`when`. Recency survives a restart. Keyboard-only operation throughout: open, type, arrow,
enter, escape. Screen-reader semantics per §11.5 — the input is `combobox`, the list
`listbox`, with `aria-activedescendant`.

## D6 — Document session

**Files:** `src/main/documents.ts`, `src/preload/index.ts`, `src/renderer/session/`

**Requires M0c.** This is the seam between the data layer and the UI.

1. **Main process:** an Open dialog and a file read that returns an `ArrayBuffer` over IPC,
   plus `fs.stat` for the read-only flag (§11.2). Reading a 500 MB file into an
   `ArrayBuffer` and posting it over IPC is a structured-clone copy — measure it; if it is
   material, the alternative is reading in the renderer, and that is a decision to report
   rather than take silently.
2. **Renderer:** `parseInWorker`, then hold the result — `SourceBuffer`, `NodeStore`,
   `rowIndex`, diagnostics, encoding — as the document session.
3. **App state:** `{ selectedNode: NodeRef, caretOffset: number }` per §4, exposed via
   `useSyncExternalStore`. One source of truth; every view is a producer and a consumer.
4. **Size limits (§11.2):** soft cap at 500 MB showing the estimated cost using the
   measured 2.5× rule — *"this file needs ~1.25 GB; continue?"*, a confirmation and never a
   refusal. Hard ceiling ~2 GB, refused with the reason stated, because `Int32Array` spans
   cannot address beyond it.
5. **Progress** during parse, with cancellation — which works now, per M0c C5.
6. **Invalid documents (§11.1):** parse to the point of failure, present the partial tree,
   mark the error node, open Raw at the error position with a diagnostic banner. A partial
   tree beats an error screen.

Tabs (§11.4) are in v1 but **not in M1** — build the session so that more than one can
exist (no module-level singletons holding the current document), and ship a single one.

**Acceptance:** `cars-200mb.xml` opens end to end with the UI responsive throughout —
this is where B11's deferred `requestAnimationFrame` check finally runs for real (D15).
A malformed file opens to a partial tree with a banner. Cancelling a parse leaves no worker
and no half-built state. A read-only file sets `isReadOnly`.

## D7 — Layout shell

**File:** `src/renderer/components/Layout/`

§4.1: **two independent toggles**, one keystroke each — show/hide Tree, show/hide Raw —
rather than a single key cycling fixed modes. Reachable layouts: Tree+Detail (default),
Tree+Detail+Raw, Tree+Raw, Detail+Raw, Detail alone.

**Raw stacks below Detail, never beside it.** Both are width-hungry for the same reason and
side-by-side starves both. Horizontal divider, each pane full width. Tree is a narrow,
collapsible left column.

One elevated command bar at top; thin **flat** header strips per pane (§9.4).

Panes are draggable-resizable with persisted sizes. Toggles are registry commands (D3).

**Acceptance:** all five layouts reachable by keyboard, sizes persist across restart, no
layout produces a horizontally scrolling window.

## D8 — Tree View

**File:** `src/renderer/components/Tree/`

Virtualized via `@tanstack/react-virtual`, lazy child expansion, one row per visible node.

- **Rows are `NodeRef`s.** See hard rule 1. The virtualizer's item list is a flat array of
  visible `NodeRef`s maintained on expand/collapse — never a materialized tree of objects.
- Icon per node kind; inline value preview on leaves, decoded on demand from the
  `SourceBuffer` for **visible rows only** (invariant 1)
- Full keyboard navigation: arrows, `Home`/`End`, type-ahead jump, expand/collapse all
- **ARIA `tree` pattern (§11.5), and this constrains the virtualizer:** `aria-setsize` and
  `aria-posinset` must report **document** counts, not rendered-row counts. Far cheaper to
  build in than to retrofit.
- Expand-all on a 6.6 M-node document must not attempt to expand 6.6 M nodes. Bound it and
  say so in the UI.

YAML alias nodes (§4.2) are M8; the `IsAlias` flag exists and nothing sets it.

**Acceptance:** scrolls smoothly through `cars-200mb.xml`'s tree with no frame over 32 ms.
Selecting a row updates `selectedNode` and every other view. Keyboard-only navigation
reaches any node. `aria-setsize` reports the true sibling count on a node with 2 M children.

## D9 — Detail View, list mode

**File:** `src/renderer/components/Detail/`

§4.3's sections, stacked: breadcrumb path (clickable, copyable as XPath or JSON Pointer) ·
node header (kind, name, child count, source range — line numbers where the document has
meaningful lines, byte offsets otherwise) · comment block · value block · scalar facets
table (`Name | Value`) · children section.

**Children section is list mode only:** `Name | Kind | Preview | # Children`, one row per
child. Virtualized — a node with two million children is the normal case here, not the
edge case.

The scalar facets table is where `FormatCapabilities.hasAttributes` earns its place: it
shows XML attributes and is absent for JSON, without either the component or anything above
it knowing which format is loaded (invariant 8).

Comment attachment (§5.3) is not implemented — the block renders when a `Comment` node is
adjacent, and nothing more.

**Acceptance:** every section renders correctly for: an XML element with attributes, an
XML element with mixed content, a JSON object, a JSON array, a folded scalar property
(D-030 — the value is on the property itself, with no child node), and a bare array
element. Breadcrumb copy produces a valid path for both formats.

## D10 — Raw View: the window

**File:** `src/renderer/components/Raw/`

The hard task, and the reason M0a and A6b exist. **Read `CONCEPT.md` §4.4 in full and
`spike/RESULTS.md`'s A6/A6b sections before writing any code.** The mechanism is measured,
not theoretical, and the measurements say things that are counter-intuitive.

**Read-only in M1.** `EditorState.readOnly.of(true)`.

- A window is ~1 MB around the current position, sliced at **row boundaries** (the row
  index, from M0c C2) and snapped to character boundaries (`snapToCharBoundary`).
- Every offset the editor reports is `origin + localOffset`. **Nothing above the Raw View
  learns a window exists** — the rest of the application works in absolute byte offsets.
- **Re-windowing dispatches exactly two edge changes:** drop `[oldStart, newStart)` from
  the front, append `[oldEnd, newEnd)` at the back, shared middle untouched. With **no**
  selection effect, **no** `scrollIntoView`, and **no** `scrollTop` reset. CodeMirror maps
  scroll position and selection through the `ChangeSet` itself and its scroll anchor
  compensates for edits above the viewport.

  A6b measured **0 bytes of caret drift and 0 bytes of viewport drift across 60 crossings,
  at 16.8 ms median**. Repositioning by hand is not merely unnecessary — it is what
  produced drift in the first place. If you find yourself calling `scrollIntoView` to fix a
  jump, the fix is to remove an effect, not add one.
- **Full replacement is the fallback for the no-overlap case only** — a large jump via
  `Locate in source` where old and new windows share nothing. Never the steady-state
  scrolling mechanism.
- **Floor every derived offset.** `bytes[12.5]` is `undefined` and `undefined & 0xc0` is
  `0`, so boundary snapping passes silently and surfaces as an asynchronous throw far from
  its cause. This cost the spike a debugging session; `snapToCharBoundary` already guards
  it, and arithmetic that feeds it should too.
- No line numbers matching document lines unless they are real — §3.1's rows are not lines.
  Decide what the gutter shows and record it.

**Acceptance:** scrolling through `cars-500mb.xml` never loads more than ~1 MB into the
editor (assert on `EditorState.doc.length`). Sixty consecutive window crossings produce
zero caret drift and zero viewport drift, measured as A6b measured them — port that
harness rather than reinventing it. Renderer memory delta after opening 500 MB stays within
noise of A6's −3.1 MB.

## D11 — Raw View: decorations

Syntax highlighting driven by NodePad's parse tree, not a separate tokenizer.

- **Decorations are built for the viewport only.** Binary search `spanStart` for the first
  visible node, walk forward — spans are in document order, which is what makes this
  possible. Windowing bounds the worst case, but the viewport-driven provider is still the
  right shape and must be built this way from the start.
- The selected node's span is a **decoration over an absolute byte range**, clipped to the
  window, simply absent when the node lies outside it. The document layer holds it
  regardless. This is the §4.4 distinction between highlight and selection: the caret and
  any text selection live in the editor and exist only inside the window.
- Colours come from D2's token set.

**This task closes an open question.** §13: *"Viewport decoration cost — every M0a latency
figure was measured with syntax highlighting off."* Measure it in D15, on the same fixtures
and the same metrics, so the numbers are comparable.

**Acceptance:** highlighting is correct across a window boundary — a node whose span
straddles the edge renders correctly on both sides. Selecting a node outside the window
changes nothing visible and throws nothing. Scrolling with decorations on stays at the
vsync floor, or the regression is reported with numbers.

## D12 — Raw View: wrap policy

§3.1 and A6b: **soft wrap is load-bearing, not a preference.** A single-line window has no
vertical scroll surface, and the window advances on scroll, so without wrap it can never
move.

- The decision is made **per window**, tested directly (`scrollHeight <= clientHeight`) —
  **not** inferred from a document-wide statistic like mean row length. A file of otherwise
  normal lines can produce a single-line window over one pathological region.
- Wrap costs **~400 ms of first paint** on 1 MB of unbroken text while wrap points are
  computed. Show a loading state; do not assume it away.
- Drives the `isWrapped` context key. A manual toggle command may override, but the
  automatic rule must win when the window cannot otherwise scroll.

**Acceptance:** `cars-100mb.min.json` scrolls end to end. The wrap decision re-evaluates on
each window change and does not thrash on a document that alternates.

**Open question to answer with data (§13):** is a loading state enough, or should the first
window be smaller when wrap is about to be turned on? Try both, record the result.

## D13 — Scrubber

§4.5: **a scrubber, not a scrollbar.** A fixed-height strip whose position is a ratio
resolved through the row index — `y → row → byte offset` — so it never asks the editor how
tall the document is. That is what keeps a 500 MB file off Chromium's ~33.5 M px maximum
element height.

Markers: the selected node's span, and diagnostics. Search hits are M4; leave the marker
layer able to take another source without redesign.

**Navigating is not selecting.** Dragging moves the window; it does not change the selected
node, the breadcrumb, or the Tree. The §5.1 cascade fires on **caret movement, never on
scroll position** — otherwise scrubbing a 200 MB file fires millions of tree updates. The
caret is released when the window moves away from it; the first click in the new location
establishes a new one; `Locate in source` returns to the selection.

**Acceptance:** dragging from top to bottom of a 500 MB file is smooth and lands where the
ratio says. The selection marker stays visible while the selection itself is off-window.
Scrubbing fires zero selection-change events.

## D14 — Synchronization and navigation

Selection changes propagate to all three views (§4.5). Plus:

- Back / forward history
- `Locate in tree` / `Locate in source` commands
- Drill up / drill down: move selection to parent or nearest child, keeping the other views
  anchored on the same source position
- Moving the Raw caret resolves offset → node → selection, **debounced** (§4.4). Scrolling
  does not.
- The palette's `@` and `:` modes from D5

Offset → node is a binary search on `spanStart` followed by a descent; it is the same
primitive D11 uses and should be written once.

**Acceptance:** selecting in any view updates the other two. History is coherent across all
three. `Locate in source` on a node 400 MB into a file lands correctly via the no-overlap
full-replacement path (D10) rather than by scrolling there.

## D15 — Measurement pass

The tasks above defer three numbers. Collect them together, in one harness, against the
`spike/fixtures/` files, and write `docs/plans/M1-RESULTS.md` in the shape of `M0-RESULTS.md`.

1. **B11's main-thread responsiveness** — deferred from M0 for the honest reason that
   Vitest had no real renderer. There is one now. A `requestAnimationFrame` counter must
   stay above ~50 fps while `cars-200mb.xml` parses in the worker.
2. **Viewport decoration cost** (§13) — every A2/A6 latency figure was measured with
   highlighting off. Re-run the A6 measurements with D11's decorations on. Windowing bounds
   the worst case, so this should be undramatic; measure it rather than assuming so.
3. **End-to-end open time** — click to interactive tree, for 10/50/100/200/500 MB. This is
   the number a user experiences, and no bar exists for it yet. It is parse + row index +
   transfer + first paint, and M0's "under 3 s" covers only the first term. **Propose a bar
   from the measurement; do not invent one first.**

Also settle, with data: **window size** (§13 — 1 MB won at A6, but incremental re-windowing
largely removed the pressure that made larger worse) and **row size N** (§13 — 512 is a
starting point; 200 MB yields 7.8 M rows and a 29.7 MB index, so this is a real trade).

**Acceptance:** `docs/plans/M1-RESULTS.md` exists, every figure reproduces, and each §13 question
listed above is either answered or explicitly re-scoped with a reason.

---

# Definition of done for M1

- [ ] Every store and interner array is transferred, not cloned; peak RSS across a real
      200 MB worker transfer measured against the 800 MB bar for the first time
- [ ] No input reachable from a document can leave the open promise unsettled
- [ ] A file opens by dialog, drag-drop, and command; tree, detail and raw all populate
- [ ] All five §4.1 layouts reachable by keyboard
- [ ] Both themes complete, switchable from the palette, with the stylelint rule enforcing
      invariant 9 and a test asserting token-set parity
- [ ] Every command reachable from the palette, enforced by test
- [ ] `cars-200mb.xml`: tree scrolls with no frame over 32 ms; main thread stays above
      ~50 fps during parse
- [ ] `cars-500mb.xml`: the Raw View never holds more than ~1 MB; 60 window crossings with
      zero caret and viewport drift
- [ ] `cars-100mb.min.json` scrolls end to end via per-window wrap
- [ ] Scrubbing fires no selection changes; selection markers stay visible off-window
- [ ] An invalid document opens to a partial tree with the error marked
- [ ] Keyboard-only operation of every feature; Tree implements the ARIA `tree` pattern
      with document-level `aria-setsize`
- [ ] `npm test`, `npm run typecheck`, `npm run lint` clean
- [ ] `docs/plans/M1-RESULTS.md` written; `DECISIONS.md` updated for anything settled here
- [ ] **No editing, no grid mode, no search**

## Report back on any of these

- Any need to change `src/core/types.ts`
- Any place a view needs to know the format id because `FormatCapabilities` cannot express
  what it needs
- The two-edge-change re-window failing to hold zero drift in the real app — A6b proved the
  mechanism in isolation, and the app is where it meets React's render cycle
- Decoration cost pushing scroll or typing measurably off the vsync floor
- End-to-end open time on 200 MB landing somewhere a user would notice
- The palette taking materially longer than building it looked like it would — that
  reverses the cmdk decision, which is fine
- Anything in `CONCEPT.md` §4, §7 or §9 that turns out to be wrong once built. M0b found
  two such things in the parsers; §4 has had less scrutiny than §3 and is a bigger surface.
