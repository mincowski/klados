# M5f — Results

Task **R12**. Plan: `docs/plans/M5f-PLAN.md`. `npm test` (950 tests, node project) and
`npx vitest run --project browser` (19 tests) both pass.

---

## What was built

**The status bar** (`src/renderer/components/StatusBar/StatusBar.tsx`, rewritten). Left group:
`⊗ n` errors (`Severity.Error | Severity.Fatal`), `⚠ n` warnings (`Severity.Warning`), both
clickable to `nodepad.navigate.nextDiagnostic` and disabled (not hidden, D-056) at zero; `ⓘ`,
clickable to open the statistics panel. Right group: `Ln n, Col n` (documents with meaningful
lines, `hasMeaningfulLines`) or `Byte n` (documents without), clickable to open the palette
already in `:` mode; encoding; format display name; size on disk — all three plain text, since
none has a command behind it yet. Every item is unconditional — verified directly
(`test/statusBar.test.tsx`'s first test) that the strip's total item count is identical across a
clean document, a dirty one, a read-only one, and one with diagnostics. `role="status"` is gone
from the container — it was a live region recomputing a memory figure on every render, so a
screen reader announced it continuously; nothing in the new strip needs one.

**`openPalette` takes an optional initial query** (`paletteStore.ts`) — a module-level
`pendingInitialQuery`, consumed once by `PaletteContent`'s own lazy `useState` initializer, the
same pattern `previouslyFocused` already uses for "captured once, at mount." The caret-position
item calls `openPalette(':')`.

**The statistics panel** (`StatisticsPanel.tsx`/`.css`, new). Anchored below the `ⓘ` item
(`position: absolute` inside `.status-bar-info-anchor`, itself `position: relative` — the same
shape `Find.css`'s own floating panel uses, `elev-2-bg`/`elev-2-shadow` per invariant 9's token
*pair*). Dismissible via Escape, an outside click, or its own close button; focus moves into the
panel on open and back to the `ⓘ` button on close. Contents: full path, format, encoding, size on
disk, node count, diagnostic counts by severity, and a memory table (source buffer, node store,
row/line/name indexes, undo history with its own entry count, total with the multiplier). Also a
command, `nodepad.document.statistics` (`StatusBar/commands.ts`), palette-reachable per invariant
10 — the icon is a second surface, not the only way in.

**`nodepad.edit.clearUndoHistory`** (`session/commands.ts`) — frees `undoState`, cancels any
pending burst, and re-runs `syncUndoContext` so `canUndo`/`canRedo` and the panel's own figure
update immediately. Not destructive to the document, so no confirmation. Registered
palette-only, **not** wired to a button in the panel — D-059's own "optional, worth considering"
suggestion, implemented but deliberately not surfaced as UI this round (D-060 records why: the
panel's job this milestone was making the number visible, not adding a second action around it).

**§3a — undo history is now a counted memory component**, done as part of this build rather than
separately (see `docs/plans/M5g-RESULTS.md`'s own §3a section and the commit that landed it): the total
`computeMemoryBudget` reports was wrong by up to ~2× the document right after a Format before
this, since the undo stack was never summed at all.

## What was deliberately not built

- **Format override** and **reopen with encoding** — `UTF-8`/`XML` stay plain text; the commands
  they'd trigger don't exist yet.
- **Cross-tab footprint** (§11.4) — needs tabs; noted in D-060 as belonging in the same panel
  once they exist.
- **Line endings (LF/CRLF)** — not tracked anywhere in the codebase; explicitly out of scope per
  the plan's own §6.
- **The read-only badge** §11.2 asked for — amended away, D-060 §4b.

## Verification

Against real Chromium layout (`test/statusBar.test.tsx`, `vitest`'s `browser` project — the
panel's focus handling and the strip's DOM structure both need real layout, which jsdom fakes):
unconditional item count across document states; zero-diagnostic counters render disabled; a
mixed Error/Fatal/Warning set splits and enables correctly; the container carries no
`role="status"`; the panel opens from `ⓘ` and its memory table includes the undo-history row with
the right entry count; Escape closes the panel and returns focus to `ⓘ`; both new commands are
registered and (for `nodepad.document.statistics`) palette-reachable, (for
`nodepad.edit.clearUndoHistory`) palette-*only*.

`ReadyStatus` is exported from `StatusBar.tsx` specifically so the test can drive it with a
hand-built `OpenDocument`, the same shape `Tree.tsx`'s `TreeContent` export uses (R13's own
`test/treeExpansion.test.tsx`) — `StatusBar`/`Tree` themselves read the `activeSession` singleton
directly, which no test in this codebase stands up from scratch; every component-level browser
test here drives a props-taking inner component instead. `nodepad.navigate.nextDiagnostic`'s
actual navigation effect (moving the caret, changing the selection) is not exercised through the
status bar's click handler for the same reason — it's already covered at the `documentSession`
level (`test/diagnosticNav.test.ts`, `test/diagnosticNavCommands.test.ts`); what's new and
untested-elsewhere here is only the strip's own wiring (disabled state, count, click dispatch),
which the tests above do cover.
