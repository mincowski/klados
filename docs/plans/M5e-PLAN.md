# M5e — title bar fixes, renderer test tooling, and the XML formatter

<!-- status: built-caveat -->

**Status: R10, R8, R11 and R9 all built** (`docs/plans/M5e-RESULTS.md`). One R11 item stays open — see
"Report what was skipped" in §5 below — but it doesn't block R9, which is complete. Tasks
**R8–R11**. Source: hands-on feedback after M5d shipped the NodePad-drawn title bar. Register:
`docs/TASKS.md`.

R8 is six unrelated defects grouped as one task because they are each small and all came from
the same session. R9 is separate because **it is not the small task it looks like** — see §2.
**R10** (§4) builds the renderer test tooling this project has never had, and proves it on R8's
six fixes. **R11** (§5) is the XML formatter, which is what R9 is actually blocked on.

**Order: R10 → R8 → R11 → R9.** The tooling first so R8's fixes are verified rather than
asserted; R11 before R9 so the button is not shipped permanently disabled.

Every cause below was traced in the code, not guessed.

---

## 1. R8 — Six fixes from the first real session with the drawn title bar

### 8a. Children rows are as dim as their own header

`Detail.css`: every `.detail-child-*` cell is `--surface-fg-secondary` — name, kind, preview
and count alike — and so is `.detail-children-header`. The Attributes table next to it gets
this right by accident of using a real `<table>`: `.detail-facets-table th` is explicitly
secondary while `td` inherits `--surface-fg`, so the data reads as more present than its
labels. That contrast is the intended shape and the children list, rebuilt as a div grid in
J5, lost it.

**Fix.** `.detail-child-name` and `.detail-child-preview` → `--surface-fg`. Kind and count stay
secondary — they are metadata, not the row's content. Header stays secondary.

### 8b. Save is enabled with nothing to save

`src/renderer/session/commands.ts:70` — `enabledWhen: '!isReadOnly'`. The dirty state is
already a context key (`setContext('isDirty', …)`, set on open, on edit and on save), so this
is a one-line fix: `enabledWhen: 'isDirty && !isReadOnly'`.

Leave `when` as `!isReadOnly`. D-055's rule is **disabled, not hidden** — a Save button that
vanishes on a clean document is exactly the reflow that rule exists to prevent, and D-056 built
the second gate specifically so the two can differ.

### 8c. The title bar's bottom border stops at the caption buttons

Correctly diagnosed in the report: Windows' `titleBarOverlay` paints its own opaque strip at
the window's top-right, **on top of** the web content. `.title-bar { border-bottom }` is inside
that rectangle, so the last ~138px of it is covered.

**Fix.** Move the rule off the title bar and onto the top edge of whatever sits below it. One
pixel lower puts it outside the overlay's rectangle, so it spans the full window width. Do not
try to fix this by shortening the overlay or extending the padding — the overlay's geometry is
the OS's, and `.title-bar-win32`'s 138px reservation is about content placement, not paint.

### 8d. The Detail toggle's icon reads as "new page"

`commands.ts` uses `document` for `nodepad.layout.toggleDetail`, against `panel-left` for Tree
and `panel-bottom` for Raw — so one of the three is from a different family, and the one that
is happens to look like a document-creation action.

**Fix.** `apps_list_detail_20_regular` from the vendored Fluent set — it depicts a master/detail
layout, which is literally what the pane is. `panel_right_20_regular` is the family-consistent
alternative but is geometrically wrong (Detail is the top of the right-hand column, not a right
sidebar; Fluent has no plain `panel_top`). Recommend the first; either beats `document`.

### 8e. The Find bar is mispositioned and wraps

`Find.css`: `position: fixed; top: var(--space-3); right: var(--space-4)` — fixed to the
*viewport*, which since M5d means it lands under the Windows caption buttons at the top-right,
the one region of the window the OS paints over. `flex-wrap: wrap` plus
`max-width: calc(100vw - …)` is the rest of the report: on a wide window it stretches, and when
it wraps the controls land in unpredictable places.

The file's own header already says what it should be — *"floating over the Raw pane rather than
inline in the layout"* — and `position: fixed` is not that.

**Fix.** Anchor it inside the Raw pane's own positioned container (`.raw-container` already has
`position: relative`), so it can never collide with OS chrome and is scoped to the pane it
searches. Give it an intrinsic width rather than a viewport-derived one, and drop `flex-wrap`
— a find bar that reflows under the pointer is worse than one that scrolls or truncates.

Check it against the scrubber's 15px strip at the same right edge, and against the vertical
overlay scrollbar J4 added.

### 8f. Selecting a node in the Tree doesn't scroll the Raw view

The real one. `documentSession.ts:1078`:

```ts
function setSelectedNode(node: NodeRef): void {
  if (state.phase !== 'ready') return
  setContext('hasSelection', node !== NO_SELECTION)
  setState({ ...state, selection: { ...state.selection, selectedNode: node } })
}
```

`{ ...state.selection }` **preserves `caretOffset`**. `Raw.tsx`'s scroll effect is keyed on
`[caretOffset]` and guards with `lastPositionedOffsetRef.current === caretOffset`, so selecting
a node changes `selectedNode` (the highlight updates — which is why it looks half-working) and
never fires the jump. "Locate in Source" works because it sets the offset explicitly; ordinary
selection never has.

That contradicts `documentSession.ts`'s own header, which describes
`{ selectedNode, caretOffset }` as the state *"every view is meant to be both"* a source and a
consumer of.

**Fix.** `selectNode` (the shared entry point for Tree, Detail and Raw) sets the caret to the
selected node's span start alongside the selection.

**The trap, and why this is not a one-liner.** `rawCaretSync` calls `selectNode` when the user
moves the caret in Raw — so moving the caret would select a node, which would move the caret to
that node's start, which would scroll the view out from under the person typing. `selectNode`
needs to not do this when the selection *originated* from the caret. `SelectNodeOptions`
already has exactly this shape for the analogous history case (`recordHistory: false` for
`goBack`/`goForward`), so add a second option in the same style rather than inventing a
mechanism.

**Acceptance for 8f specifically.** Clicking a node in the Tree scrolls Raw to that node's
first byte; clicking in the Raw text still selects the containing node and does **not** move
the caret or scroll; `goBack`/`goForward` scroll to their target.

---

## 2. R9 — Pretty-print in the Raw view

The request: a pretty-print button in Raw, treated as an edit, so the user can then save.

**The mechanism already exists.** `nodepad.document.format` is a Transform (M5 H4–H8): it
rewrites the byte buffer, marks the document dirty, is undoable below
`TRANSFORM_CONFIRM_BYTES`, asks first above it (D-046), and saves like any other edit. So
"qualifies as an edit and the user can choose to save that way" is already true today.

**But it does nothing for XML, which is the format being tested.**
`src/formats/xml/index.ts:54` — `canFormat: false`, and the command is gated `when: 'canFormat
&& !isReadOnly'`. **D-045 settled this deliberately in M5: Format ships JSON-only.** A
pretty-print button added today would be permanently disabled on every XML document.

So R9 is really "build the XML formatter D-045 deferred" — **split out as R11, §5**, where the
prerequisites turn out to be in better shape than D-045's own note suggests. R9 itself is then
just the button, and D-057 has already settled where it goes.

**Split, decided.** The XML formatter is **R11** with its own id and its own decision record —
D-045 is a settled decision being reopened, which should not be absorbed into a UI task. R9 is
the button alone. Sequence R11 before R9 so it never ships permanently disabled on XML.

**Placement — settled as D-057: the Raw pane header.** Not an exception to D-055 but a
sharpening of it. Formatting's effect really is confined to Raw, and by design: D-030 does not
model insignificant whitespace, so the Tree is *literally unchanged* by a format, and Detail
changes only its source-range labels. The rule D-057 records is that a command belongs to a
pane when **the pane's subject is what the command acts on** — Raw's subject is the source
bytes, and Format changes the source representation while provably not changing the model.
Undo (subject: the edit history) and Save (subject: the file) stay in the title bar, so the
rule doesn't leak.

Minify is the same category but stays **palette-only** — header budget, rarity, and its own
confirmation flow. Recorded so its absence reads as a decision.

**No auto-formatting**, per the same decision: Raw shows the file as it is. Already true —
`settings.ts`'s "Format minified files on open" is off by default and the banner is an offer,
not an imposition (§5.7). Nothing to change; noted so a future auto-format path reads as a
regression.

---

## 3. Order and scope

R8's six items are independent; do them in any order. **8f is the highest-value one** — it is a
broken interaction between two panes, not a cosmetic defect, and the caret-feedback trap means
it should not be rushed.

R9 waits on the split decision in §2.

**Out of scope:** everything already listed in `M5c-PLAN.md` §4 and `M5d-PLAN.md` §5, unchanged
— in particular the five `M4-RESULTS.md` second-addendum findings and the flaky
`documentSession.test.ts` test, both still for the fine-tuning pass.

---

## 4. R10 — Renderer test tooling

**The gap, stated plainly.** `vitest.config.ts` includes `test/**/*.test.ts` — not `.tsx` —
with no DOM environment. **No React component in this project has ever been tested.** Every UI
claim across six milestones was verified by reading code or by the project lead running the
app, which is why "no session building this had a display to drive" keeps appearing in results
documents (`M5c-RESULTS.md` J9, `M5d-PLAN.md` R6, `M2-RESULTS.md`'s scroll-frame gap).

Two additions, both dev-only. **New dependencies — approved in advance for this task, and
listed here so the set is explicit rather than growing quietly:**

| Package | For |
|---|---|
| `@vitest/browser` | Vitest browser mode |
| `playwright` | supplies the Chromium the above drives, and the Electron launcher below |

Deliberately **not** added: `jsdom`/`happy-dom` (CodeMirror has no layout there — it would
produce confident green tests for exactly the measurements that matter), and any
testing-library. Render with `createRoot` into a container; the suite's style is
invariant-testing, not component-DSL testing.

### 10a. Vitest browser mode — real layout for component tests

Real Chromium, so real `scrollHeight`, real computed styles, real `requestAnimationFrame`.

- **Two Vitest projects**, not one changed config. The existing node suite (841 tests) stays
  exactly as it is and must not get slower — that speed is why it gets run. Browser tests are
  a second project with its own include glob, adding `.tsx`.
- This is what `M2-RESULTS.md`'s flagged gap actually needs: *"grid and Tree scroll frame time
  need a real `requestAnimationFrame` loop driving real rendered React components."* J9's items
  1–2 are blocked on the same thing.

### 10b. Playwright + Electron — the real app, and screenshots

`_electron.launch()` runs the actual built app: open a fixture, drive the UI, capture PNGs.

The screenshots matter beyond assertions — **a PNG on disk is something a coding agent can
read back**, which is the difference between "I can't check this" and checking it. Treat them
as **artifacts for review, not pixel-diff assertions**: visual-regression suites are a
maintenance tax that ends up disabled.

### 10c. Prove it on R8

Do not write hello-world tests. R8's six fixes are the acceptance criteria, and four of them
are exactly what this tooling exists to catch:

| R8 item | Test it should have caught it with |
|---|---|
| 8a children row colour | computed `color` on a row cell vs its header |
| 8c title bar border | bounding box of the border against window width |
| 8e Find bar position | Find bar's rect vs the caption-button region and the pane bounds |
| 8f scroll sync | click a Tree row, assert Raw's first visible byte offset |
| 8b Save enablement | `disabled` on the title-bar button, clean vs dirty |
| 8d icon swap | the rendered `<svg>`'s identity |

**What this still cannot cover**, so the existing flags stay rather than looking resolved:
Snap Layouts, the taskbar icon, native caption-button painting, macOS traffic lights and
fullscreen, Windows high-contrast. Those are OS shell behaviour — no framework verifies them,
and they need a human on the platform. `M5d-PLAN.md` R6 already says so and keeps saying so.

**Acceptance.** `npm test` still runs the node suite at its current speed; a new script runs
the browser suite; the six R8 fixes each have a test that fails before the fix and passes
after; one Electron screenshot of the title bar is produced and committed to the results doc.

---

## 5. R11 — The XML formatter (reopens D-045)

`canFormat: false` lives at `src/formats/xml/index.ts:54`. Flipping it is the last line of this
task, not the first.

### What already exists — more than D-045's own note suggests

The two things D-045 called out as hard are **built, and load-bearing for other features**:

- **Mixed content is already detected per element.** `nodeStore.ts`'s `closeNode` sets
  `NodeFlags.IsMixed` when a node saw *both* a text child and a non-text child. Checked:
  `openNode` classifies `NodeKind.Text` **and `NodeKind.CData`** as text children, so
  `<a><![CDATA[x]]><b/></a>` is correctly mixed.
- **`xml:space="preserve"` is already inherited, overridable scope.** `Frame.preserve` inherits
  from the parent frame, is overridden where the attribute appears, and
  `XmlResumeContext.preserveWhitespace` rebuilds it at an arbitrary resume point for M3's
  subtree splicing.

And the answer to "how do we handle reading spaces" (§6 below) is the third: whitespace-only
text between children is **dropped from the model but recorded as a flag**
(`NodeFlags.DroppedWhitespace`), never silently discarded — and never lost from the file,
because the model holds spans and Save writes the buffer (invariant 6).

### The one thing that is genuinely awkward

**`format()` receives bytes, not the store.** The contract is
`format?(source: Uint8Array, options: FormatOptions): Uint8Array` (`types.ts:277`), invoked in
the worker at `parse.worker.ts:282`. So the formatter **cannot read `NodeFlags.IsMixed`** —
that flag lives in a `NodeStore` the formatter is never handed.

And mixed-content detection needs lookahead: you cannot know an element is mixed until you have
seen all of its children, so a single streaming pass cannot decide whether to indent as it goes.

**Do not change the contract for this.** `src/core/types.ts` is off limits, and this does not
need it — the formatter does **two passes over the bytes**: pass 1 records, per element start
offset, whether it is mixed and whether it is in preserve scope; pass 2 emits. Buffering output
per element instead would be unbounded on a large root element, which is the wrong trade.

**A good test falls out of this**: pass 1's mixed-content verdicts must equal `NodeFlags.IsMixed`
from a real parse of the same document. The store becomes the formatter's oracle without the
formatter depending on it.

### The judgement call §5.7 has to make

*Reflowing* whitespace that already exists is plainly safe. *Introducing* it where there was
none — turning `<a><b/><c/></a>` into an indented tree — adds character data that was not
there. In element-only content that is insignificant by the XML spec **only when a DTD or
schema says the content model is element-only**, and NodePad has neither.

Every other pretty-printer (xmllint, XMLSpy, VS Code) introduces it anyway, and the minified
case is precisely the one users want formatted — so refusing would make the feature useless for
its main purpose. Recommend introducing it, gated on `!IsMixed && !preserve && the element has
element children and no text value of its own`, and recording the reasoning in the decision that
reopens D-045 rather than leaving it implicit.

### The skip rule is subtree-scoped, not element-scoped

**The single easiest thing to get wrong here.** When the walk reaches an element flagged mixed
(or inside `preserve`), it copies that element's **entire span verbatim — open tag to close tag,
descendants included — and does not recurse into it.**

Why it matters, with the case that exposes it:

```xml
<p>Text <b><a>with a link</a></b> and more text</p>
```

`<p>` is mixed (text *and* element children). `<b>` is **not** — its only child is `<a>`. `<a>`
is not either — it is a leaf holding its own text. So an element-scoped skip would freeze `<p>`,
then happily descend and reindent `<b>`/`<a>`:

```xml
<p>Text <b>
    <a>with a link</a>
  </b> and more text</p>
```

— inserting whitespace into mixed content, which is exactly the corruption the flag exists to
prevent. Pass 1 therefore records the mixed element's **end** offset as well as its start, so
pass 2 can copy the span and jump.

**Accepted consequence: this is deliberately conservative.**
`<div>text <table>…500 rows…</table></div>` leaves the table unformatted, because `<div>` is
mixed. Reformatting non-mixed descendants *inside* a mixed ancestor is a possible later
refinement; it is **not** in R11, and the conservative version must not be quietly widened into
it without its own decision record.

### Report what was skipped

Do not gate the command on mixed content — one `<p>Hello <b>x</b>!</p>` would make most
real-world XML unformattable, and per-element skipping is the whole point. But the document-level
count is the right thing to *surface*, and pass 1 has it for free:

> Formatted. 7 elements left unchanged (mixed content or `xml:space="preserve"`).

…and, when the answer is nothing:

> Nothing to format — this document is mixed content throughout.

Goes in the alert strip R3 built. This is §5.7's "offer, never impose" and D-057's "the user
decides" applied to the outcome rather than only the trigger: a formatter that silently declines
to touch two thirds of a file, with no way to tell, is the version people mistrust.

**Status: implemented except this section.** The subtree-scoped skip rule itself is built and
verified (`captureVerbatimSpan`'s replacement — pass 1 now records each element's `spanEnd`
alongside its `isMixed`/`preserve` verdict, so a frozen subtree is copied by jumping straight to
that offset rather than re-tokenizing bytes pass 1 already walked; the `<p>Text
<b><a>with a link</a></b> and more text</p>` trap is a hand-written acceptance test in
`test/xmlFormat.test.ts`, passing). **Surfacing the count is not** — blocked on an open contract
question, below, deliberately left unresolved rather than worked around.

**Open question, for the architecture agent: how does the skip count reach the alert strip?**
`format()`'s signature is fixed by `src/core/types.ts` — `(source, options) => Uint8Array`, no
room to return anything else — and `core/types.ts` is the one file `CLAUDE.md` says not to modify
without stopping to report first. Pass 1 (`collectFormatInfo`) already computes exactly the count
needed (`isMixed || preserve` per element), so the number exists; the question is purely how it
gets from there to `DocumentStatus`. Four options were on the table, none chosen yet:

1. **Extend `FormatModule`** with an optional method (e.g. `countUnformattedSpans?(source,
   options): number`), mirroring `format?`'s own optional-capability pattern exactly — checked by
   presence, not by testing a format id, so invariant 8 stays intact. JSON never needs to
   implement it. The actual cost is touching the one contract file marked off-limits; would need
   recording as a deliberate, narrow, documented exception rather than routine editing.
2. **A `formatId === 'xml'` branch inside `parse.worker.ts`'s `runTransformJob`**, calling a plain
   function exported from `formats/xml/index.ts` (not part of `FormatModule`). No contract change,
   but it is a literal format-id test in a file that currently dispatches everything through the
   shared interface — brushes against invariant 8's letter even though the module lookup one line
   above it already switches on `formatId` by necessity.
3. **Approximate from `NodeFlags.IsMixed` alone**, re-parsing the pre-format bytes in the renderer
   (already-supported `parse()` call, no contract or worker change at all). Genuinely simplest and
   fully rule-respecting, but **undercounts**: a non-mixed element frozen only by inherited
   `xml:space="preserve"` scope (`<a xml:space="preserve"><b/>   <c/></a>` — `<a>` itself isn't
   mixed) has no flag to detect it by, since `preserve` scope is Frame-local during parsing and
   never persisted to the `NodeStore`. Reporting a number known to be low, silently, is arguably
   worse than the D-057 "no way to tell" problem this section exists to fix.
4. **Don't build it this round.** Format/Minify work fully without it; the message is a nice-to-
   have layered on top, not a blocker for R9.

Raised and left open deliberately (2026-08-10 session) rather than picked under time pressure —
whichever way this goes changes either `core/types.ts` or `parse.worker.ts`'s dispatch shape, both
worth a considered call rather than a default.

### Acceptance

- **The subtree rule, tested directly**: the `<p>Text <b><a>…</a></b> and more text</p>` case
  above must come back byte-identical, `<b>` and `<a>` included. This is a hand-written example
  precisely because it is the known trap; the invariants below are the general safety net.
- **Round-trip invariants, not examples** (M0-PLAN B12's rule): formatting is idempotent
  (`format(format(x)) === format(x)`); re-parsing formatted output yields a **structurally
  identical tree** — same node count, kinds, names and attribute values as the original; any
  element flagged `IsMixed` or inside `xml:space="preserve"` is **byte-identical** to its input.
- A leaf with its own text (`<a>text</a>`) is never split across lines.
- Encoding is preserved (invariant 7) — the formatter emits in the document's own encoding, and
  a document whose encoding has no encoder is refused rather than converted.
- Only then does `canFormat` become `true`, and R9's button lights up (D-057).
