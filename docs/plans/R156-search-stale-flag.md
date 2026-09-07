# R156 — a Find result marked stale after it has been recomputed

<!-- status: open -->

**Open.** Register: `docs/TASKS.md`. Carried in the Owed table since R154, which found it and
deliberately did not fix it.

`searchStore` marks a Find result `stale` when the buffer moves under it, clears the flag when the
reparse lands and the query re-runs — and then marks it stale again, permanently, on the next
session notification. The result the user is looking at is correct and labelled otherwise.

---

## 1. The defect

`src/renderer/session/searchStore.ts`, in the session subscription's last branch:

```ts
// Store hasn't changed yet, but the buffer has — an edit landed and the
// debounced reparse (and this store's own re-run) hasn't caught up.
if (activeQuery !== null && document.dirty && result.complete && !result.stale) {
  setResult({ ...result, stale: true })
}
```

**The comment states the intended condition correctly and the code tests a different one.**
`document.dirty` is *unsaved*, not *the buffer moved since the search ran* — from
`documentSession.ts`:

> **`dirty`** — `true` from the first successful `applyEdit`/`undo`/`redo` after open (or after the
> last successful `save`) **until the next successful `save`**.

So it goes true on the first keystroke and stays true for the rest of the editing session. Any
later notification that reaches this branch — same document, same `store` identity — re-marks a
result that has already been recomputed.

Measured through the real `searchStore` and a real `documentSession` (only the transport faked):

| | |
|---|---|
| `+1 ms` | edit applied — store changed, result marked `stale` (correct) |
| `+48 ms` | debounced reparse landed — store changed, re-run cleared `stale` (correct) |
| `+205 ms` | a further notification, **store unchanged**, `dirty` still true → `stale` again |

and it stays that way, because nothing else will change the store until the next edit.

**User-visible effect:** after any edit, the Find count and match highlighting are marked stale
while being correct, until the user edits again or saves. Cosmetic, but it is the indicator whose
entire job is to say whether the number can be trusted.

## 2. Why it went unseen

Every test in `test/searchStore.test.ts` waited a fixed 50 or 90 ms and asserted inside the
`+48…+205 ms` window. R154 replaced those waits and the polling loop looked at the flag
continuously for the first time. The tests now use `awaitReparsed`, which waits for
`!stale && complete` and returns immediately — so they read in the same window on purpose, and
**this defect is currently untested in either direction.**

## 3. The fix, and the reason it is one word

`OpenDocument` already carries the exact condition, three fields below `dirty`:

> **`reparsePending`** — `true` from the moment `sourceBuffer` changes until `applyReparseResult`
> commits a store built from it; `false` at open and whenever nothing is pending.

That is the comment's intent verbatim. Proposed:

```ts
if (activeQuery !== null && document.reparsePending && result.complete && !result.stale) {
```

**This field exists because two other consumers hit the same trap.** Its own doc comment records
that M5's H8 minified-file banner and H9 memory budget both read store-derived figures during a
window where `sourceBuffer` described a different document, and `reparsePending` was added so a
consumer could tell. `searchStore` is the third such consumer and reached for the wrong flag.

Tracing the four branches: a buffer change that has *not* been parsed sets `reparsePending`, so the
result is marked stale as before; a buffer change that *has* been parsed arrives on the earlier
`document.store !== lastStore` branch, which re-runs the query properly; and the `+205 ms`
notification finds `reparsePending` false and leaves the result alone.

**Not yet verified.** This is read from the code, not run. R156 must confirm it against the real
session before claiming it, and check that no case wants the current behaviour — in particular
whether a Transform (`transformInProgress`, which covers the window *before* `sourceBuffer` swaps)
needs including, since `reparsePending` by its own definition does not cover that part.

## 4. What this round owes

1. The change, with the reasoning above recorded at the call site rather than a bare field swap.
2. **A test that fails before it and passes after** — the missing half of R154. It must assert the
   flag is still clear *after* the window the old fixed sleeps read in; a test that only checks
   `!stale && complete` at `+48 ms` cannot see this defect, which is exactly how it survived.
3. Remove the Owed row in `docs/TASKS.md`.
4. Decide the `transformInProgress` question in §3 explicitly, either way.

## 5. Deliberately not in scope

Widening `dirty` itself, or adding a buffer generation counter to `OpenDocument`. `reparsePending`
already answers this question and has two other consumers depending on its current meaning; a new
field would need to justify itself against a field that already exists.
