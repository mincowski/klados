# R234–R235 — a reload must not destroy edits, and must pass the open-time checks

<!-- status: open -->

**Open.** Planned from the review of 2026-10-16, findings 5 (high: data loss) and 7 (medium). Both are
about `reloadFromDisk` in `src/renderer/session/documentSession.ts`. **R234 is first**: it is the
one that silently loses work.

## 1. R234 — an automatic reload overwrites edits typed while it runs

**The path, read in the code at `fa2e9df`:**

1. `handleExternalChange` (`documentSession.ts:2402`) reloads **without asking** when the document is
   not dirty. That is §11.3's intended behaviour for a clean document.
2. `reloadFromDisk` (`:2230`) mints a token, then awaits `parseFromUrl`. **This can take seconds**:
   it is a full read and parse, 4.3–4.6 s at 200 MB (FINDINGS: *the worker seam costs nothing*).
3. Nothing stops editing during that time. `applyEdit` (`:1664`) checks only `phase` and `readOnly`
   and never touches `reloadAbort`, so the user can type in Raw, Replace, Format or Undo.
4. Before committing, the reload checks only that `reloadAbort` is still its controller and that
   `filePath` is unchanged (`:2319–2324`). It then replaces `store` and `sourceBuffer`, sets
   `dirty: false` and empties the undo stack (`undoState = EMPTY_UNDO_STACK`).

**Result:** every edit made during the reload is gone, the document shows as clean, and Undo cannot
recover them. The user gets no notification, because the reload "succeeded".

**What already handles the sibling cases, and is the pattern to follow:**
- `save()` re-checks `sourceBuffer` identity after its await (`:2124–2127`), for exactly this reason:
  "a newer edit to this same document landing mid-write".
- *Keep Mine* and *Save* both cancel an in-flight reload (R169, `clearExternalChangeAfterSave`), and
  `documentSession.test.ts` has tests for both: *Keep Mine cancels a reload already in flight*
  (`:3071`) and *a save cancels a reload already in flight* (`:3244`).

An **edit** is the third way the user can say "I am working on this version", and it is the one that
was missed.

### The change

**Capture `sourceBuffer` at the start of `reloadFromDisk`, and refuse to commit if it changed.** On a
refused commit:
- The reload's result is discarded.
- `externalChangeDetected` is raised, as `handleExternalChange` does for a dirty document. The user
  gets the existing banner (*Reload and Discard* / *Keep Mine*) and the decision, because the document
  now is dirty and the file did change.
- The outcome is `{ ok: true, cancelled: true }`, so no failure notification is shown.

**This applies to automatic reloads only.** An explicit *Reload and Discard* means "throw my edits
away", and an edit typed after clicking it is the ambiguous case. **Decided here:** the same check
applies to it too, so typing after the click wins and the banner comes back. Losing typed text
silently is never the right resolution of an ambiguity.

The obvious alternative, aborting the reload from `applyEdit` the way *Keep Mine* does, was
considered. Rejected because `applyEdit` is the hot path for every keystroke. A pointer comparison at
commit time costs nothing, and it also catches every other buffer-replacing operation (Replace,
Format, Undo, Redo) **without each of them having to remember to cancel**. That is R101's lesson:
per-caller fixes miss the caller added later.

## 2. R235 — a reload skips every check an open makes

`openPath` (`:1292`) stats the file and applies three limits:
- the ~2 GB hard ceiling (`HARD_CEILING_BYTES`), because every span is a 32-bit byte offset
  (invariant 3, D-004)
- the 500 MB confirmation (`SOFT_CAP_BYTES`)
- the cross-tab memory budget (R28)

It also records `readOnly` from the stat. `reloadFromDisk` does **none of this**: it mints and
parses straight away. Since reloads are triggered automatically by a file changing (R234 §1), a file
that grows on disk, such as a log or an export being written, is re-read and re-parsed in full on
every change with no ceiling:
- **Past 2 GB, offsets overflow `Int32Array`**. This is outside every invariant the parsers were
  built on, so it must be refused, not tested.
- Past the budget, the tab can take the renderer down.

A file whose permissions changed on disk also keeps its old `readOnly`, so Save is offered and then
fails, or is refused for a file that has since become writable.

### The change

`reloadFromDisk` stats first, through the same `api.document.stat`. Then:
- **At or above the hard ceiling**, it refuses with the open path's message and leaves the current
  document as it is. The banner says the file on disk can no longer be opened.
- **Above the soft cap or the budget, an automatic reload does not proceed.** It raises
  `externalChangeDetected` instead, so the user decides through the existing banner. An explicit
  *Reload and Discard* goes through the same `confirmSize` gate the open path uses. **Whether that
  gate can be reused from a `ready` document without losing the document is to be read in the code
  before building**. If it cannot, a refusal with the size in the message is acceptable for this
  round, and the gap is recorded.
- `readOnly` is updated from the stat on every successful reload, and `isReadOnly` with it.

**Ordering with R234, which is easy to get wrong.** The stat is a new `await` at the very start of
`reloadFromDisk`, so R234's `sourceBuffer` snapshot must be taken **before** it, as the first
statement of the function. Taken after the stat, the snapshot would miss an edit that lands while the
stat is in flight, and the reload would discard that edit exactly as before.

## 3. Acceptance criteria

### R234

1. **A test that reproduces the loss before the fix**, written first and seen red. In
   `documentSession.test.ts`, using the fake API the two existing in-flight tests use:
   - Open a clean document and hold `parseFromUrl` on a deferred promise.
   - Fire `document:externalChange`, which starts an automatic reload.
   - Call `applyEdit` while the reload is held, then release the reload.
   - **Before the fix this must fail**: the edit is gone and `dirty` is `false`. Its red output is
     quoted in Results.
   - **After the fix**: the edited bytes are the session's `sourceBuffer`, `dirty` is `true`,
     `externalChangeDetected` is `true`, and `undoEntryCount` is unchanged by the reload. These are
     per-session assertions, not the context projection (FINDINGS: *`commands/context` is a
     projection of the active session*).
2. The same test, with the edit replaced in turn by `applyReplaceAll`, `undo` and an `applyTransform`
   that completes during the hold, passes **without any of those methods being changed**. This is
   §1's claim that one check covers every caller.
3. An explicit `reloadAndDiscard` with an edit landing during it behaves the same (§1's decision).
4. An automatic reload with **no** edit during it still commits, clears `dirty` and empties undo,
   exactly as today. The existing reload tests pass unmodified.
5. **The test uses a CRLF fixture or varies line endings** (FINDINGS: every Raw edit fixture was
   LF-only until R168).
6. Mutation: deleting the identity check turns criterion 1 red (verify the mutation landed in
   `reloadFromDisk`, per FINDINGS R169).
7. **In the built app**, in `mainElectron.test.ts`:
   - Open a 10 MB fixture, rewrite it from the test process, and type into Raw before the reload
     lands.
   - The typed text is still in the editor afterwards and the title shows the dirty dot.
   - If the reload is too fast to type into reliably, the test says so and the unit test stands
     alone. **It does not sleep to widen the window** (FINDINGS: *wait for the condition, never for a
     duration*).

### R235

8. With `stat` faked at `2_147_483_647` bytes, an automatic reload neither mints a token nor calls
   `parseFromUrl`. The document is unchanged, and a notification names the size.
9. With `stat` faked above `SOFT_CAP_BYTES`, an automatic reload does not parse and raises
   `externalChangeDetected`.
10. A reload after `stat` starts reporting `readOnly: true` leaves the document read-only, `save()`
    returns *This file is read-only.*, and the reverse case holds too.
11. **The snapshot precedes the stat** (§2's ordering): criterion 1's test, with the edit landing
    while `stat` is held on a deferred promise instead of `parseFromUrl`, keeps the edit. Mutation:
    moving the snapshot after the stat turns it red.
12. Each of 8–10 is mutation-checked by removing its branch.

## 4. Not in scope

- Debouncing reloads of a file that changes continuously. After R235 a large growing file no longer
  reparses unbounded, and a small one reparsing is cheap. Recorded as a possible follow-up if it is
  ever observed to matter.
- Merging external changes with local edits. The banner's two choices stay the model (§11.3).
