# M5f — the status bar

<!-- status: built -->

**Status: built.** Task **R12**. Register: `docs/TASKS.md`. Results: `docs/plans/M5f-RESULTS.md`.
`nodepad.edit.clearUndoHistory` (§3a's own "optional" suggestion) is implemented and
palette-reachable, but deliberately not wired to a button in the panel this round — see
`docs/DECISIONS.md` D-060.

Layout follows VS Code's, decided against a screenshot of it: a left group for document *state*
and a right group for document *facts*. Only items whose command already exists become
clickable — the rest are plain text until there is something for a click to do.

---

## 1. What it looks like

```
⊗ 0  ⚠ 3  ⓘ                                  Ln 4,912, Col 8   UTF-8   XML   198 MB
   └ clickable  └ clickable                        └ clickable
```

### Left group — document state

| Item | Behaviour |
|---|---|
| `⊗ n` errors, `⚠ n` warnings | **Clickable** → `nodepad.navigate.nextDiagnostic` (exists today, and has had no visible affordance anywhere — the same discoverability gap D-055 found for back/forward). |
| `ⓘ` info | **Clickable** → opens the statistics panel (§3). |

Two counters, not one total: `Severity` is `Warning | Error | Fatal`, so errors and fatals sum
into `⊗` and warnings into `⚠`, exactly VS Code's split. **Both show at zero.** A parser-based
viewer saying "0 errors" is real information (§11.1 ships partial trees), and a fixed-width
group does not shift under the pointer.

Every item in both groups is unconditional, so nothing in the strip ever reflows — see §4 for
the read-only badge that was considered and dropped.

### Right group — document facts

| Item | Behaviour |
|---|---|
| `Ln 4,912, Col 8` / `Byte 1,048,576` | **Clickable** → the palette's `:` mode (D14). `hasMeaningfulLines` already decides which of the two to render, and is already exported for exactly this question. |
| `UTF-8` | Plain text. Clicking should eventually mean *reopen with encoding*; that command does not exist, so no click. |
| `XML` | Plain text. Clicking should eventually mean *override the detected format*; likewise. |
| `198 MB` | Plain text — the **file's** size, `sourceBuffer.byteLength`. |

**File size is not memory footprint**, and keeping them apart is what resolves where each goes.
Size on disk is a stable, glanceable document fact and belongs beside encoding and format.
Footprint (`822 MB, ~4.1×`) is a diagnostic that changes as you edit — that goes in the panel.

---

## 2. What leaves the strip

- **Filename** — M5d R5 put it in the title bar.
- **"unsaved changes"** — the title bar's amber dot, same task.
- **Node count** — a number you read once. → panel.
- **Memory footprint** — → panel. See §4.
- **`role="status"` on the container.** The strip is an ARIA live region today, and the memory
  figure recomputes on every render, so a screen reader announces it continuously. Remove it
  from the container. If any single item should announce, it is the diagnostic count, and it
  can carry its own live region — the whole bar should not.

---

## 3. The statistics panel

Opened by the `ⓘ` item, and — invariant 10 — **also a command**,
`nodepad.document.statistics`, so it is palette-reachable. The parity test enforces that; the
icon is a second surface for a command, never a command's only home.

Contents:

- Full absolute path (the status bar no longer shows even the filename).
- Format, encoding, size on disk.
- Node count.
- **Memory breakdown** — source buffer, node store, row/line/name indexes, **undo history**,
  total, and the multiplier.
- Diagnostic counts by severity.

### 3a. Undo history is a missing component of the budget, not a new curiosity

`computeMemoryBudget` today sums source buffer + node store + row/line/name indexes + interner.
It does **not** include the undo stack — so the total NodePad reports is not merely incomplete,
it is **wrong**, and by a lot at exactly the moments that matter.

Concretely (R13 §1.4): one Format on a 10 MB document pushes an entry holding
`patch.replacement` (the whole new document) *and* `inversePatchOf`'s replacement (the whole old
one) — **~20 MB**, against a reported total of ~25 MB. The strip would say 25 MB while the
process held ~45 MB. That is the kind of gap §8's budget exists to prevent, and it is why this
belongs in the same table as every other component rather than off to the side.

**What to count.** `UndoStackState` is `{ entries, index }` — a single array with a cursor, so
**redo entries live above `index` in the same array and are retained too.** Sum
`replacement.byteLength` across every `patch` and every `inverse` of every entry, regardless of
the cursor. Bounded by `DEFAULT_UNDO_MAX_DEPTH`, so the sum is O(entries), not O(bytes).
`RecordedSelection`'s path strings are excluded as genuinely negligible — say so in a comment
rather than leaving a reader to wonder whether they were forgotten.

Redo entries exist only between an undo and the next edit — `pushEntry` truncates
`entries.slice(0, index)` before appending (D-059). Count them anyway rather than reporting only
the undo side: they are real retained bytes for as long as they exist, and the alternative is a
figure that is right most of the time.

**This figure is the prerequisite for a byte-based depth bound.** D-059 records that
`DEFAULT_UNDO_MAX_DEPTH = 500` bounds entry *count*, which stops meaning anything once a single
Transform entry can approach ~100 MB. Choosing a byte budget before anyone has watched the real
number move would be guesswork — so R12 shows it, and the bound is picked afterwards.

**Label: "Undo history", with the entry count.**

```
Undo history          20.1 MB   (3 entries)
```

Not "undo buffer" — it is a stack of patches, not a buffer, and the word would imply a single
allocation that could be resized. The count matters as much as the bytes: it is the only line in
the table whose size is explained by something the user did, and "20.1 MB / 3 entries" answers
the next question ("why?") in the same glance.

**Plumbing constraint.** `computeMemoryBudget(document)` is O(1) today — every field is a
`.byteLength` read — and that is what makes recomputing it on every render acceptable. The undo
stack lives in `documentSession`'s closure, not on `OpenDocument`. **Keep the O(1) property**:
expose `undoBytes` and `undoEntryCount` as fields on `OpenDocument`, recomputed where the stack
changes (`syncUndoContext` already runs at exactly those points), rather than handing
`computeMemoryBudget` the stack to walk on every render.

**Optional, and worth considering while the panel is open:** a `nodepad.edit.clearUndoHistory`
command, surfaced in the panel next to the figure and stating what it would reclaim. On a large
file it is the one component the user can actually free, and the panel is where they will be
looking at the number. It is not destructive to the document — only to reversibility — so no
confirmation, but it must re-run `syncUndoContext` so `canUndo`/`canRedo` update. Palette-
reachable like everything else (invariant 10). **Not required for R12**; if it is skipped, say so
rather than leaving it implied.

There is no popover component in this codebase yet. Build it anchored and dismissible
(Escape, outside click, focus returned to the `ⓘ`) rather than reusing the palette's full-screen
overlay, which is a different weight of thing. Keep it to the elevation token *pair*
(invariant 9) — a shadow alone does not read on dark surfaces.

**Why the `ⓘ` and not behind the file type.** Hanging it off `XML` was considered and rejected:
in VS Code the language item means *change the language*, and NodePad will want precisely that
(open this as XML rather than the detected format) once format override exists. Putting
unrelated content there now would have to be undone. The `ⓘ` sits with the other state items,
reads as "information about this document", and is the natural home for generic file info as
more of it appears.

---

## 4. Decisions to record — two `CONCEPT.md` amendments

Both are deliberate deviations from the concept, so both go in the same `DECISIONS.md` entry
rather than being made quietly. `CLAUDE.md`'s working agreement is explicit that a deviation
gets documented with its reason.

### 4a. Memory moves off the strip, and the figure gains undo history (amends §8)

Two changes to the same figure. The move is below; the correction is §3a — §8's own budget table
omits the undo stack, so the total NodePad reports is understated by up to ~2× the document
after a Transform. The entry should record that §8's table itself needs the extra row, not just
the UI.

§8 says the memory budget is *"tracked and surfaced in the status bar"*, and §11.4 expects
cross-tab footprint there too. Moving the figure into a panel: continuously displaying
`822 MB (~4.1×)` is anxiety-inducing noise during ordinary use, it is the item most likely to be
misread as a problem, and it changes constantly — which is also what made the live-region defect
in §2 audible. It stays *surfaced*, one click away, which is what §8 was protecting.

§11.4's cross-tab footprint should land in the same panel when tabs exist. Note that in the
entry so a future reader does not re-derive it.

### 4b. No read-only badge (amends §11.2)

§11.2 asks for read-only *"shown in the status bar rather than discovered on a failed save."*
There is no badge, by decision.

**The requirement's intent is already met elsewhere.** What §11.2 is guarding against is
learning the document is read-only only when a save fails — and `Raw.tsx` already shows a
standing banner (*"This file is read-only — changes can't be saved here"*) in the one pane where
an edit can be attempted at all. Invariant 6 means editing happens only in the Raw view, so the
warning is present wherever the failure it warns about could originate. A status-bar copy would
restate it in a place you are not editing.

It also buys the layout something real: with no conditional items, the left group never reflows.

**The one gap, recorded rather than hidden**: with the Raw pane hidden, a read-only document
shows only a disabled Save button (R7/8b) and no stated reason. Save As *is* permitted on a
read-only document, so someone could be briefly confused about why Save is dead. Judged small —
you cannot have made an unsaved change without the Raw pane, so the disabled button is the
correct state and the question rarely arises. If it turns out to bite, the fix is a tooltip on
the disabled Save button, not a permanent strip item.

---

## 5. New vs existing

**Exists, just needs wiring:** `nodepad.navigate.nextDiagnostic`, `computeMemoryBudget`,
`hasMeaningfulLines`/`lineAtOffset`, `caretOffset` in session state, `formatBytes`.

**New, and small:** `undoBytes`/`undoEntryCount` on `OpenDocument` plus the `MemoryBudget` field
that consumes them (§3a).

**New, and small:** `openPalette()` currently takes no arguments — the caret-position click
needs it to accept an initial query so it can open in `:` mode. One optional parameter.

**New, and the bulk of the task:** the anchored popover component and the statistics panel.

---

## 6. Deliberately not now

- **Line endings (LF/CRLF).** Not tracked anywhere in the codebase today, and not wanted yet.
  Worth a note that it is genuinely relevant given byte-identical saves are the whole point, and
  cheap to detect by sampling the first block — but it is new work and stays out.
- **Format override** and **reopen with encoding** — the two clicks the right group is
  deliberately leaving inert until the commands exist.
- **Cross-tab footprint** (§11.4) — needs tabs.
- **Git/branch-style items.** VS Code's left group leads with them; NodePad is not a workspace
  tool (§1 non-goal) and has nothing to put there.

---

## 7. Acceptance

- The strip shows the layout in §1. Every item is unconditional, so assert the strip's item
  count is the same for a clean document, a dirty one, one with diagnostics and a read-only one
  — nothing in it reflows.
- Clicking the diagnostic counters advances through diagnostics; clicking the caret position
  opens the palette in `:` mode; clicking `ⓘ` opens the panel and Escape returns focus to it.
- `nodepad.document.statistics` appears in the palette (parity test).
- The memory total **includes** undo history: format a document, then assert the reported total
  grew by roughly twice the document's size and that the undo row shows one entry. This is the
  regression guard for §3a — the whole point is that the number was previously wrong, so a test
  that only checks the row renders would miss it coming back.
- The container no longer carries `role="status"`.
- Verified with R10's tooling — this is a layout-and-computed-style task, which is exactly what
  that tooling was built for, so "verified by reading the code" is not acceptance here.
