# NodePad — M3 Implementation Plan

<!-- status: built -->

**Audience:** the coding agent implementing this milestone.
**Reference:** `CONCEPT.md` §5 (editing model — read all of it before F1), §4.4 (windowing),
§11.1/§11.3 (invalid and externally-modified documents), §11.6 (testing strategy).
`DECISIONS.md` D-007 to D-012, D-031.

---

## How to use this plan

Work through tasks **in order**. Each has explicit acceptance criteria — do not move on
until they pass. Where a task says "stop and report," stop and report.

> **M2b (fit and finish) comes first.** `CONCEPT.md` §12 places it between M2 and M3
> deliberately: editing adds chrome of its own — dirty indicators, save affordances, undo
> feedback, `isReadOnly` becoming visible for the first time — and that is much cheaper to
> build onto settled conventions than to retrofit into them. **Do not start F1 until M2b has
> landed.** Its plan is written against `docs/plans/UI-FEEDBACK.md`, which is still collecting.

> **M2 left three performance defects open** (`docs/plans/M2-RESULTS.md`, review addendum). None
> block M3, but F-tasks touching the grid will meet them: `isNumericColumn` scanning every
> member, `collectColumns` allocating per member, and ungated grid export.

### What M3 is

Editing, and everything that makes editing safe: debounced reparse, incremental subtree
splicing, the pending-delta list, selection re-resolution, one undo stack, and a save path
that writes bytes rather than regenerating them.

This is the milestone that tests the project's central architectural bet. §5.1 is the
decision the rest of the design hangs on, and until a user can type into the Raw View it
has never been executed.

### What M3 is not

- **No Transforms.** Format, minify, sort-keys and format conversion are M5 with the
  chunked write path (§5.5), and the minified-file banner goes with them. `canFormat` stays
  false for XML. M3 builds the *Save* path only — the one that never generates text.
- **No structural edit commands.** §5.4 puts insert-node/delete-node post-v1, and specifies
  that when they come they are text edits at computed span offsets, never model mutations.
  Building them now would reintroduce the serialization subsystem §5.1 exists to eliminate.
- **No editing outside the Raw View.** §5.1 is unconditional. The Detail view's cells and
  the grid stay read-only in M3; a cell that looks editable because the document is now
  editable is a bug.
- **No search.** Still M4.

### Hard rules

The standing invariants apply, and three of them are this milestone's whole subject:

1. **Save writes the byte buffer. It never regenerates the document from the model**
   (invariant 6). There is no serialization path and none may be added. If something seems
   to need one, that is a design signal — stop and report.
2. **Save preserves the original encoding** (invariant 7). Never silently convert to UTF-8.
   Where re-encoding an edited region would be lossy for a legacy code page, the edit is
   **refused with an explanation**, not silently substituted (§5.5).
3. **The pending-delta list is mandatory, not an optimization** (D-010). M0a measured a
   naive bulk offset shift at **231.5 ms** at the density actually shipped — far past viable
   for a per-edit fixup. Anyone who finds the delta list fiddly and considers just rewriting
   the offsets should read that number first.
4. **CodeMirror's history extension stays disabled** (§5.6). The document layer owns the
   single undo stack. Windowing makes this not merely preferable but necessary: CodeMirror
   holds ~1 MB of a document that may be 500 MB, so its history could not cover an edit
   outside the current window even in principle.
5. **Every offset crossing the Raw View's boundary is absolute.** The editor reports
   window-local positions; `origin + localOffset` is the only form the document layer ever
   sees (§4.4). This already holds for reads — editing is where getting it wrong starts
   corrupting files rather than mis-highlighting them.

---

# Tasks

## F1 — The document is mutable

**Files:** `src/renderer/session/documentEdits.ts`, `documentSession.ts`

Before anything can type, the document layer needs a mutation primitive. §5.6's shape,
verbatim:

```ts
interface Patch { start: number; end: number; replacement: Uint8Array }
```

Absolute byte offsets, always. Applying a patch produces a new source buffer; whether that
is a copy, a rope, or a gap buffer is this task's main design decision and it is
**measurement-gated** — a naive `Uint8Array` splice of a 200 MB document per edit burst is
200 MB of copying per keystroke burst, which F10 will show is untenable. Start with the
simple version, measure it in F10, and report before choosing a structure.

**Encoding round-trip** (§5.5): the editor works in decoded text, the buffer holds bytes.
An edited region round-trips through decode and re-encode, which is lossless for UTF-8 and
UTF-16 and may not be for a legacy code page. Detect the lossy case and **refuse that edit
with an explanation**. `SourceBuffer` already carries the resolved encoding (M0c C1).

**Acceptance:** a patch applied to a document produces exactly the expected bytes, with
offsets outside the patch untouched. A patch containing a character outside the document's
declared code page is refused, with the reason reaching the UI. `bomLength` is respected —
spans are absolute in the file as read (D-032), and a patch at offset 0 must not eat the BOM.

## F2 — The pending-delta list

**File:** `src/core/deltaList.ts`

```ts
interface Delta { position: number; delta: number }   // few entries, ascending
```

§5.2's mechanism:

- Span reads binary-search the list and apply the accumulated shift
- **The row index shifts by the same mechanism** — it suffers identical invalidation, and
  M0c's line index (`LineIndex`) does too, so all three go through one implementation
- The list folds into the arrays on the next full reparse, and **always before save** (§5.5)
- Past ~64 entries, a background full reparse folds it back to empty

**The read overhead is the thing to watch.** Every span read in the application now goes
through this — the Tree reads spans per visible row, the grid reads them per visible cell,
the Raw View's decorations read them per viewport node. §5.2 names it as one of the two
things M0a should have measured and did not. F10 measures it; if a binary search per span
read is too much, the fallback is a cached "shift valid up to offset X" fast path for the
common case of a single trailing delta, **not** abandoning the list.

**Acceptance:** a span read after N deltas returns the same offset a full rewrite would
have. Folding is idempotent. The row index and line index shift consistently with the node
store — a test that edits, shifts, and then asserts `lineAtOffset` still agrees with a
linear newline count.

## F3 — Debounced reparse and the last-good tree

**Files:** `src/renderer/session/reparse.ts`, `documentSession.ts`

~200 ms idle, **never per keystroke** (§5.1). While the document is temporarily invalid,
the **last known-good tree is retained** — the Tree and Detail keep showing the previous
structure rather than collapsing to an error state, which is §11.1's principle applied
mid-edit rather than at open.

The reparse runs in the worker, on the same seam D6 built. Cancellation matters more here
than at open: a reparse superseded by continued typing must not land.

**Acceptance:** typing a burst produces exactly one reparse. Typing through a
temporarily-invalid state (a half-typed tag) keeps the last good tree visible and marks the
document as having a parse error, without losing the user's place. A superseded reparse
never overwrites a newer one — the same `activeAbort`-supersede discipline `documentSession`
already uses for opens, which had a real bug in it once (`174606f`).

## F4 — Incremental reparse: subtree splicing

**Files:** `src/renderer/session/subtreeSplice.ts`

Reparse only the innermost node whose span fully contains the edit, via
`FormatModule.parseRange` — which exists, is implemented for both formats, and has been
covered by B12's invariant 4 ("subtree reparse equivalence") since M0. This task is the
first real consumer.

Splice the resulting nodes into the store. Fall back to a full reparse when the edit
crosses the node's boundaries or breaks well-formedness, retaining the last-good tree until
it completes.

`resumeContextFor` rebuilds the format state (XML's namespace and `xml:space` scope) from
the ancestor chain — also already implemented, also never yet called in anger.

**This task owns §13's oldest open question.** *"Subtree reparse latency — §5.2 says M0a
must measure this and it did not. Whether editing a 200 MB file feels instant is still an
assumption, and M3 is where it gets tested."* F10 measures it. If it is not instant, that
is a "stop and report" — the design has no fallback below this one.

**Also §13: subtree splice granularity.** *"Reparsing the innermost containing node is the
obvious unit, but for a document whose root has one enormous child that degenerates to a
full reparse. Is a size-bounded ancestor search worth it?"* Answer it with the measurement,
not in advance.

**Acceptance:** editing a leaf value in `cars-200mb.xml` reparses that node's subtree only,
and the resulting store is structurally identical to a full reparse of the same text —
assert it, do not eyeball it. An edit that breaks well-formedness falls back cleanly.

## F5 — Selection re-resolution

**File:** `src/renderer/navigation/reresolve.ts`

Node indices are invalidated by a reparse. §5.1's three-step cascade, in order:

1. **Structural path** (`/root/books/book[3]/title`) — exact match
2. **Caret offset** — the innermost node whose span contains the caret
3. **Nearest surviving ancestor** of the old path, falling back to the document root

**Steps 2 and 3 change the selection, so the change is never silent**: the Tree scrolls to
the new node and the breadcrumb updates.

All three work in **absolute byte offsets** and are therefore independent of the Raw View's
window. Restoring a selection may move the window; it is never constrained by where the
window happens to be.

D9's `pathSegmentsOf`/`toXPath` already build step 1's path, and D14 already has
offset → node for step 2. This is mostly composition, which is the point of having built
them that way.

**Acceptance:** editing text before the selected node keeps the same node selected (step 1).
Deleting the selected node selects its nearest surviving ancestor and scrolls the Tree there
(step 3). A selection restored after a reparse is never left pointing at a stale ref — the
`NO_SELECTION` discipline from D6 applies.

## F6 — The undo stack

**File:** `src/renderer/session/undoStack.ts`

The document layer owns it (§5.6, D-011). One stack, every mutation expressed as a `Patch`.

- **Typing coalesces into one entry per burst**, on the same debounce as reparse
- Each entry **records the selection and caret at the time it was made**, and undo restores
  them via F5's cascade. "Undo that returns the text but not the user's place in the
  document is disorienting in a large file" — and at 200 MB it is worse than disorienting
- Redo, and a bounded stack depth with the bound recorded as a tunable

**Acceptance:** type, undo, redo returns byte-identical text and the same selection. A burst
of 50 keystrokes is one undo entry. Undo across a window boundary restores correctly —
CodeMirror's own history being disabled is what makes this testable rather than a race.

## F7 — Save

**Files:** `src/main/documents.ts` (write side), `src/renderer/session/save.ts`

- **Fold pending deltas first** (§5.5), so the buffer written is fully materialized rather
  than a buffer plus a correction list
- Write the byte buffer. **Never generate text.**
- **Preserve the original encoding**, including the BOM if there was one
- Save As, and a dirty indicator; `isReadOnly` (already wired since D6) gates both
- §11.2's read-only files open normally with editing disabled — that path now has something
  to disable

**Acceptance — and this is the important one.** §11.6 calls the round-trip invariant *"the
single most valuable test in the project,"* and M0 could not run it because there was no
save path:

> **For every test document, parse then save with no edit must produce a byte-identical
> file.**

Run it across every fixture and every golden file, both formats, including the BOM'd and
CRLF cases M0c added. It protects the §5 fidelity guarantee directly, and it is the reason
invariant 6 exists.

## F8 — External modification (§11.3)

The file may change on disk while open. This becomes real the moment saving does.

- **No unsaved edits** — reload silently, restoring selection via F5's cascade
- **Unsaved edits** — a non-blocking banner offering *Reload and discard* / *Keep mine*.
  Never auto-reload over unsaved work, and never block on a modal

**Acceptance:** an external change with no local edits reloads and keeps the user's place.
An external change with local edits never discards them without an explicit choice.

## F9 — Editing UI

Read-only comes off the Raw View. `EditorState.readOnly.of(true)` becomes conditional on
`isReadOnly`, and the `isWrapped`/`isReadOnly` context keys finally gate something.

Everything M2b settled about chrome applies here — dirty indicator, save affordance, undo
feedback. If M2b established a convention, follow it rather than inventing a second one.

Commands: Undo, Redo, Save, Save As, Revert — all in the palette (invariant 10), all with
keybindings.

**Acceptance:** keyboard-only editing, save and undo. A read-only file cannot be edited and
says why. Both themes checked for the dirty and error states.

## F10 — Measurement pass

`docs/plans/M3-RESULTS.md`. The numbers this milestone owes are the ones the whole design has
been deferring:

1. **Subtree reparse latency** (§13, §5.2) at 10/50/100/200/500 MB — the question M0a was
   supposed to answer and didn't. This decides whether editing a large file feels instant.
2. **Delta-list read overhead** (§5.2), on the read paths that matter: Tree row rendering,
   grid cell rendering, Raw decorations.
3. **Patch application cost** (F1) — whether a naive buffer splice survives, and at what
   size it stops.
4. **The round-trip invariant** across every fixture (F7).
5. **Delta list threshold** (§13) — "folding at ~64 pending deltas is a guess; the right
   value depends on the measured cost of a background full reparse at each file size."
   Measure that cost and set it.

**Inherited and still unmeasured**, carried forward again rather than quietly dropped:
**Grid and Tree scroll frame time** and **wrap's first-paint cost** (§13, D12). Both need a
harness that mounts real React components under a real rAF loop; M2's E10 explains why it
could not be built there. If it cannot be built here either, say so in the same terms —
but it has now been deferred twice, and a third deferral should be a decision rather than a
consequence.

---

# Definition of done for M3

- [ ] Typing in the Raw View edits the document; Tree, Detail and Grid follow after the
      debounce
- [ ] A temporarily-invalid document keeps its last-good tree and the user's place
- [ ] Subtree splicing produces a store structurally identical to a full reparse
- [ ] Selection survives an edit; when it cannot, it moves visibly, never silently
- [ ] One undo stack; a typing burst is one entry; undo restores text *and* selection
- [ ] **Parse then save with no edit is byte-identical, for every fixture, both formats**
- [ ] Save preserves encoding and BOM; a lossy re-encode is refused with an explanation
- [ ] External modification never discards unsaved work
- [ ] Read-only files cannot be edited and say why
- [ ] Keyboard-only editing, save, undo, redo; all commands in the palette
- [ ] `npm test`, `npm run typecheck`, `npm run lint` clean
- [ ] `docs/plans/M3-RESULTS.md` written; `DECISIONS.md` updated for anything settled
- [ ] **No Transforms, no structural edits, no editing outside the Raw View**

## Report back on any of these

- **Subtree reparse latency not feeling instant at 200 MB.** This is the assumption the
  editing design rests on and it has never been tested. There is no fallback below it, so
  finding out early is worth more than finding out politely.
- Delta-list read overhead showing up in Tree or grid scrolling — it is on every span read
  in the application now
- Patch application needing a rope or gap buffer rather than a splice, and at what size
- Any need to generate text on the save path. That is invariant 6 failing, and it is the
  single most serious thing this milestone could discover.
- Any edit that cannot round-trip its encoding, beyond the legacy-code-page case §5.5
  already anticipates
- Anything in `CONCEPT.md` §5 that turns out to be wrong once built. It is the section with
  the most load-bearing claims and the least contact with reality so far.
