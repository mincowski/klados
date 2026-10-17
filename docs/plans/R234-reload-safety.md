# R234–R235 — a reload must not destroy edits, and must pass the open-time checks

<!-- status: built-caveat -->

**Built, with one gap owed** (§5): above the soft cap or the memory budget a reload refuses
rather than asks, because the open path's confirmation cannot be used from an open document. Planned
from the review of 2026-10-16, findings 5 (high: data loss) and 7 (medium). Both are about
`reloadFromDisk` in `src/renderer/session/documentSession.ts`. **R234 is first**: it is the one
that silently loses work.

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

## 5. Results

**Built** on branch `r234-reload-safety`, one commit per id. **One gap is owed** (§5.3): above the
soft cap or the memory budget a reload refuses rather than asks.

### 5.1 R234

`reloadFromDisk` takes `const baseline = …sourceBuffer` as its first statement and, just before
committing, returns `{ ok: true, cancelled: true }` if `state.document.sourceBuffer !== baseline`.
The refused commit raises `externalChangeDetected` and `hasExternalChange`, lowers
`reloadPending`, and leaves `dirty`, the buffer and the undo stack alone. Nothing else changed:
`applyEdit`, `applyReplaceAll`, `undo`, `redo` and `applyTransform` are untouched (criterion 2).

**Criterion 1, red before the fix**, as written in `documentSession.test.ts`, CRLF throughout
(criterion 5). Five tests failed; the fifth is criterion 3's explicit reload:

```
× an edit typed while an automatic reload is held survives it (criterion 1) 175ms
× so does a Replace All (criterion 2) 141ms
× so does an Undo (criterion 2) 211ms
× so does a Format that completes during the hold (criterion 2) 186ms
× an explicit Reload and Discard yields to an edit typed after the click (criterion 3) 6ms

AssertionError: expected SourceBuffer{ …(5) } to be SourceBuffer{ …(5) } // Object.is equality
-     57,      ← the typed '9'
+     50,      ← the file's '2'
```

The criterion 3 failure was `expected { ok: true } to deeply equal { ok: true, cancelled: true }`:
the explicit reload committed over the edit and reported success. Criterion 4 (no edit, the reload
commits, `dirty` false, undo empty) passed before and after, and every existing reload test passed
unmodified.

**Criterion 6, mutation.** `if (false && state.document.sourceBuffer !== baseline)`, the line located
by number and checked to be inside `reloadFromDisk` (FINDINGS: *verify that a mutation landed*):
all five tests above go red again.

**Criterion 7, in the built app.** `mainElectron.test.ts` opens a generated ~10 MB CRLF JSON file,
rewrites it from the test process, and types into Raw from **inside the page's own
`onExternalChange` listener**, subscribed after the session's. `ipcRenderer` calls listeners in
registration order from one message, so the session has already started its reload, which is
waiting on IPC, when the text is typed. No sleep, and no dependence on how long a 10 MB parse
takes. It asserts the typed text is in the editor, the title shows the dirty dot, and the banner is
up. **Checked by mutation, not assumed:** with the identity check disabled and the app rebuilt,
the test fails, because the reload commits, the text is gone and the banner never appears. It then
saves, so the app exits cleanly and `afterAll` can remove the profile (a dirty document turned the
close into the quit prompt, the process was killed, and the profile was still locked).

### 5.2 R235

`reloadFromDisk` now `stat`s the file after the snapshot and before minting a token.
`reloadRefusalFor` applies the open path's three limits: the hard ceiling, the soft cap, and this
file's new estimate plus every *other* tab's (`estimateOtherTabsBytes` already excludes the tab
asking) against the budget. On a refusal nothing is read, the document is left as it is, and a new
`OpenDocument.reloadRefusal` carries the banner's text, which names the size. The banner shows it in
place of its question and offers only Keep Mine. An explicit reload returns `{ ok: false }` with the
open path's own message at the ceiling (`pastCeilingMessage`, now shared) and a sentence naming the
size otherwise. A successful reload takes `readOnly` from the stat and sets `isReadOnly`. A failed
stat reports like a failed read did (R220's words where the error is tagged).

**The `confirmSize` gate was read before building, and cannot be reused.** Its phase is
`{ phase: 'confirmSize', fileName, fileBytes, … }`, with no document, and `cancel()` from it goes to
`empty`. Entering it from a ready document would drop the document the reload exists to keep, so
§2's fallback applies: a refusal with the size in it.

**One deviation from §2, deliberate.** §2 said an automatic reload above the soft cap raises
`externalChangeDetected` "so the user decides through the existing banner". With no confirmation
available, the existing banner's Reload and Discard would only be refused again, which is R169's
dead button. So the banner says why instead and offers Keep Mine. Closing the file and opening it
again reaches the open path's confirmation. Recorded in D-118.

**A consequence worth knowing:** `externalChangeDetected` can now be `true` on a clean document,
while `reloadRefusal` is set. Its doc comment said "always `false` when `dirty` is `false`", and now
names the exception. Nothing read the old invariant: the flag's only consumers are the banner and
the `hasExternalChange` context key.

**Criteria 8–12**, all in `documentSession.test.ts`, red before the change (criterion 11 hung,
because no reload called `stat` yet):

| # | Asserted | Mutation, and what went red |
|---|---|---|
| 8 | `stat` at 2,147,483,647: no token minted, one parse (the open's), buffer unchanged, the banner names `2.00 GB` and says "cannot open"; an explicit reload returns the open path's exact message | ceiling branch `if (false)`: both tests |
| 9 | above `SOFT_CAP_BYTES`: no parse, `externalChangeDetected`, the banner and an explicit reload's message name the size; a budget of 1,000 bytes against a 1,000-byte file: no parse, the banner names the budget | soft-cap branch: its test; budget branch: its test |
| 10 | `readOnly: true` from the reload's stat: the document and `isReadOnly` follow, `save()` returns *This file is read-only.*; and back to writable, where `save()` succeeds | `readOnly: info.readOnly` removed: its test |
| 11 | criterion 1 with `stat` held instead of the parse: the edit survives | the snapshot moved to just after the stat: its test |

**One test was strengthened by its mutation.** Removing the ceiling branch first turned only the
explicit test red: the soft cap also refuses a 2 GB file without reading it, so the automatic test
could not tell the two apart. It now also asserts the ceiling's own wording.

`externalChangeBanner.test.ts` covers the banner with a refusal set: its text, and Keep Mine as the
only action.

### 5.3 Owed

**An in-place confirmation for a reload above the soft cap or the budget.** Today the user closes
the file and opens it again. The likely shape is a `reloadAndDiscard({ sizeConfirmed: true })` and a
"Reload Anyway" banner action, which also needs a registered command (invariant 10).

### 5.4 Review

Each id's `git diff` was read as its own pass before its commit. **R234's review found one thing**,
fixed before committing: `reloadFromDisk`'s doc comment still said it discards "whatever unsaved
edits exist", with no mention of the new exception. **R235's review found no defect.** It confirmed
the deviation above was a choice rather than a slip, and that nothing else relied on
`externalChangeDetected` implying `dirty`.
