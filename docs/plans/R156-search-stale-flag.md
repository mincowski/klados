# R156 — a Find result marked stale after it has been recomputed

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Results in §6. Was carried in the Owed table from R154,
which found it and deliberately did not fix it; that row is now removed.

`searchStore` marks a Find result `stale` when the buffer moves under it, clears the flag when the
reparse lands and the query re-runs — and then marks it stale again, permanently, on the next
session notification, and stays that way until the next edit. **Not user-visible** — §1 records why
the plan was wrong about that — but a public field holding the wrong answer under a correct name.

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

**Correction, made while implementing: this is not user-visible.** The plan as first written said
the Find count would show as stale while being correct. It would not — **`SearchResult.stale` has
no readers in `src/` at all.** R126 removed the `(stale)` suffix from the Find bar (`FindBar.tsx`
§"the exact reservation"), on the grounds that the label moved every control sideways and the
moment the count is genuinely unknown it already says "Searching…". Nothing has read the flag
since.

What the defect actually costs, then:

- **The flag is wrong**, on a public field of `SearchResult` whose name says otherwise. The next
  consumer to read it — and the field exists to be read — inherits the bug rather than finds it.
- **One spurious `setResult` per edit cycle.** It calls `notify()`, so every Find subscriber
  (`FindBar`, the Raw decorations) re-renders with identical match data. Once, not continuously:
  the guard's own `!result.stale` stops it repeating.

That is a smaller defect than the plan claimed, and worth fixing anyway — a correctly-named field
holding the wrong answer is the kind of thing this project keeps paying for later, and R154 only
found it because a test happened to watch the flag continuously.

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

**Confirmed on implementation.** `reparsePending: true` is set by all four buffer-mutating paths
— `applyEdit`, `applyUndoEntry`, `applyTransform` and `applyReplaceAll` — and cleared only by
`applyReparseResult` and `reloadFromDisk`, so it covers every route by which the buffer can move.

**`transformInProgress` is deliberately excluded**, and this is the §3 question settled. It does
cover an extra window that `reparsePending` does not: from the moment `applyTransform` starts until
`sourceBuffer` is actually swapped. But in that window the displayed result still matches the
buffer, and `stale` means "may not match the current buffer" — marking it there would be this same
defect over again, merely briefer.

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

---

## 6. Results

**Built**, as one word plus the reasoning around it: `document.dirty` → `document.reparsePending`.
All four items of §4 done. `searchStore.ts`'s module header is corrected too — it opened by saying
the result is marked stale "the moment the document goes dirty", which was an accurate description
of the bug.

**The test asserts the mechanism, not a duration, and that is the point.** R154 found this by
watching the flag for 205 ms, but a test that waits for a particular moment repeats the mistake that
hid it: every test in this file waited 50 or 90 ms and asserted inside the window where the flag was
briefly correct. Instead, after the edit and its re-run, the test issues **a session notification
that provably cannot have moved a byte** — `setCaretOffset` — and asserts snapshot *identity*:

```ts
session.setCaretOffset(7)
expect(store.getSnapshot()).toBe(fresh)
```

Deterministic, instant, and it isolates the exact confusion the defect was made of. Verified to fail
first, on the real defect: `expected { starts: Int32Array[ 6 ], …(4) } to be { … }` — a new object
where identity should have held.

**A correction the round had to make about itself.** §1 records it: the plan claimed the Find count
would display as stale, and it would not, because **nothing in `src/` reads `SearchResult.stale`** —
R126 removed the `(stale)` suffix from the Find bar and left no other reader. Found by grepping for
consumers before writing the Results section rather than after, which is the only reason it is a
correction and not a shipped false claim. The defect is real but smaller: a wrong value on a public
field, and one spurious re-render per edit cycle.

**Review pass, per `CLAUDE.md`.** Read as `git diff`. Two findings, both fixed before commit: the
stale module header above, and the plan's own user-visibility claim. Nothing else — the change
touches one condition, and the surrounding branches were traced rather than assumed (§3).

Verification: the new test fails before and passes after; `searchStore.test.ts` 13/13; full suite
1833 pass, 0 fail; typecheck and lint clean.
