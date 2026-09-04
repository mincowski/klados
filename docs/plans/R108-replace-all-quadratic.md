# R108–R110 — Replace All is quadratic, and so is undoing it

<!-- status: built-caveat -->

**Built, with a scope narrowing R109 found empirically — see §7's Results.** Register:
`docs/TASKS.md`. Reported against R90 as built: confirming a ~65,000-match
Replace All on a 10 MB file froze the app — the notification stayed on screen, the replace never
appeared to happen, and only mouse-wheel scrolling still worked. Follow-up to
`docs/plans/R86-find-as-query-surface.md`. Results at the end of this file.

**Every question in this document is settled — nothing here is waiting on a decision.** The cause
is one loop, it was measured rather than inferred, and the fix makes the operation ~3,850× faster
without any new UI.

---

## 1. The app did not crash. It was going to finish in about three and a quarter minutes

`applyReplaceAll` (`documentSession.ts:1814`) ends with:

```ts
let bytes = oldBytes
for (const patch of patchesDescending) bytes = applyPatch(bytes, patch)
```

and `applyPatch` (`documentEdits.ts:89`) allocates **a whole new `Uint8Array` of the entire
document** on every call — three `subarray`s and one full-length copy. The module's own header
comment is honest about this ("a full `Uint8Array` splice per patch, not a rope or gap buffer") and
M3-PLAN F10 marked it as the thing to revisit; what nobody revisited is that R90 then called it
**once per match**.

So the loop is **O(document × matches)**. Measured, replicating the loop exactly:

| document | matches | wall time | bytes copied | allocations |
|---|---|---|---|---|
| 10 MB | 250 | 0.73 s | 2.5 GB | 250 × ~10 MB |
| 10 MB | 1,000 | 2.97 s | 10 GB | 1,000 × ~10 MB |
| 10 MB | 2,000 | 5.93 s | 20 GB | 2,000 × ~10 MB |
| 10 MB | 4,000 | 12.95 s | 40 GB | 4,000 × ~10 MB |
| 10 MB | 8,000 | 24.08 s | 80 GB | 8,000 × ~10 MB |

Dead linear in match count at **~3.0 ms per match**. The reported case — 10 MB, ~65,000 matches —
extrapolates to **~196 seconds**, and that is in bare Node without the renderer's GC pressure from
65,000 live 10 MB allocations. **The app was not hung; it was working.** Nobody waits three minutes
at a frozen window, so nobody found out.

**Every detail of the report follows from that one loop, which is how we know nothing else is
involved:**

- **The notification stayed.** `Notifications.tsx:162`'s `runAction` calls `runCommand(command)`
  and only *then* `dismissNotification(...)`. The command runs to completion synchronously, so the
  dismissal is not even reached until the splice finishes — and once reached it only schedules a
  React render, which cannot paint on a blocked main thread either.
- **The mouse wheel still scrolled.** Chromium scrolls on the compositor thread, independently of a
  blocked main thread. This is the signature of a synchronous main-thread stall specifically, not of
  a crash or a deadlock, and it is what rules out the alternatives.
- **Nothing else responded.** Same cause.

**And it is only this loop.** The two other expensive things Replace All triggers were checked and
are both already off the critical path: the reparse runs on a worker (`runReparse`, ~45 MB/s
including row index and transfer per `FINDINGS.md`, so ~220 ms for 10 MB and not on this thread),
and Find's own re-run is a chunked job that yields (`searchStore.ts:157`, `runChunkedJob`).
`inversePatchOf` allocates 65,000 six-byte slices, which is nothing.

## 2. The confirmation is working as designed — no change

Answering the question directly: it is **not** shown every time. `FindBar.tsx:450` shows it when
either

- the match count exceeds `REPLACE_ALL_CONFIRM_MATCHES` = **50,000** (`FindBar.tsx:53`, deliberately
  the same figure as `GRID_EXPORT_CONFIRM_ROWS`), **or**
- the replace would push the undo stack past the memory budget, in which case the wording gains
  *"This cannot be undone."*

The reported case hit the first gate and not the second: 65,000 × (6 + 3) bytes ≈ **585 KB** of undo
entry, far inside the budget — which is why the message said "Continue?" rather than warning about
undo.

**It stays as it is.** The threshold is about *how many places in your document are about to change*,
which is a fact about the edit, not about how long it takes. Once §3 lands the operation is fast, and
the temptation will be to drop the confirmation as no longer necessary — it is still necessary, for
the reason it was added.

## 3. R108 — one allocation, not one per match

The splice does not need to be repeated. Every patch's offsets are already in `oldBytes`'s own
coordinates and none of them overlap, so the whole rewrite is a **single ascending pass**: total the
length delta, allocate the output once, then alternate untouched gap and replacement.

```ts
let read = 0, write = 0
for (const p of patchesAscending) {
  const gap = bytes.subarray(read, p.start)
  out.set(gap, write); write += gap.length
  out.set(p.replacement, write); write += p.replacement.length
  read = p.end
}
out.set(bytes.subarray(read), write)
```

Measured against the same cases:

| document | matches | shipped | single pass | |
|---|---|---|---|---|
| 5 MB | 20,000 | **28.9 s** | **7.5 ms** | ~3,850× |
| 10 MB | 65,000 | ~196 s (extrapolated) | **24.4 ms** | ~8,000× |
| 200 MB | 500,000 | — | 175 ms | |
| 200 MB | 5,000,000 | — | 765 ms | |

The reported operation becomes **24 ms**. Note the last two rows: this is not "fast enough for
10 MB", it is fast enough that the feature stops having a size story at all.

**Where it goes: `documentEdits.ts`, next to `applyPatch`, not inside `applyReplaceAll`.** That
module is where the top comment already promises the splice strategy can change without anything
above `createEdit`/`applyPatch` noticing, and §4 needs the same primitive from a different caller.
`applyPatch` itself stays — it is the right shape for the single-patch case and `createEdit` uses it.

**The precondition has to be stated in the signature's own doc comment and checked in dev**, because
§4 is about a caller for which it is false: *every patch's offsets are in the input buffer's
coordinates, ascending, non-overlapping.* Reuse `applyPatch`'s existing `import.meta.env?.DEV`
pattern — a loop that also asserts `p.start >= previous.end`.

`applyReplaceAll` then keeps `sortedAscending` (the defensive sort stays — its comment is still
correct about why) and drops both the `reverse()` calls and the loop. The undo entry still stores
`patchesDescending`/`inversesDescending`, which §4 depends on.

## 4. R109 — undo has the identical loop, and it is *not* the identical problem

`applyUndoEntry` (`documentSession.ts:1468`) is the same line:

```ts
for (const patch of patches) bytes = applyPatch(bytes, patch)
```

so **undoing a 65,000-match Replace All freezes for just as long as making it did** — and undo is
precisely what somebody reaches for after a large replace they regret. Fixing §3 alone would leave a
user able to make the edit in 24 ms and unable to take it back for three minutes. Both, or neither.

**But the coordinate spaces differ, and that is the whole risk in this task.** The three callers are
not interchangeable:

| caller | patch list | coordinates |
|---|---|---|
| `applyReplaceAll` | ascending | all in the input buffer — **directly usable** |
| redo (`entry.patches`, descending) | reverse to ascending | all in the input buffer — **directly usable** |
| undo (`[...entry.inverses].reverse()`, ascending) | ascending | **sequential** — patch *i* is only valid once 0…*i*−1 have been applied |

Undo's inverses work today *because* they are applied one at a time: restoring match 0 shifts
everything after it back by exactly the amount match 1's stored offset is out by, so each one comes
due exactly when it becomes correct. It is a genuinely elegant invariant and it is completely
incompatible with a single pass.

**This was verified, not reasoned about.** Feeding undo's inverses to the §3 primitive unchanged
threw `RangeError: offset is out of bounds` on the first trial input — loud in that case, but the
same mistake on a different shape (a replacement *longer* than what it replaces) silently writes
wrong bytes into the user's document. That is the failure mode this codebase cares most about.

**So undo rebases first**, converting a sequentially-valid ascending list into input coordinates with
a running total:

```ts
let shift = 0
for (const p of ascending) {
  emit({ start: p.start - shift, end: p.end - shift, replacement: p.replacement })
  shift += p.replacement.length - (p.end - p.start)
}
```

Confirmed round-tripping a real replace-then-undo byte-for-byte. Redo needs no rebase — its patches
were built against the buffer it is being applied to.

**The rebase must be a named function with that reasoning in its comment**, not three inline lines,
because the next person to touch `applyUndoEntry` will otherwise see two ascending patch lists
treated differently and "simplify" it.

## 5. Why there is no progress bar, no dimmed UI, and no background job

The report offers these, and they were the right instinct given the symptom — but they solve the
wrong problem, and the measurement is what says so.

**Rejected: run the splice as a chunked job with a progress bar.** A progress bar over 24 ms is a
flash of chrome nobody can read, and the machinery is not free: cancellation semantics mid-splice
(a half-rewritten buffer is not a state this app has anywhere else), a fourth `JobSlot`, and a
document that is neither old nor new while it runs. **We would be building a progress indicator for
an operation whose entire cost is an artefact of the loop we are deleting.**

**Rejected: dim the UI during the replace.** Same objection, plus it makes a 24 ms operation *look*
expensive.

**Rejected: progress only if it turns out to be slow.** Deferring the indicator until some elapsed
threshold means the slow path stays untested and appears for the first time in front of a user, on
the largest documents, which is the worst place to discover it is wrong.

**Kept, unchanged: the confirmation** (§2). It was always about the size of the change, not its
duration.

The general form: **a synchronous main-thread stall does not by itself say whether the work is slow
or merely quadratic, and the two want opposite fixes.** The instinct is to make the slow thing
asynchronous and show progress — which is the right answer often enough that this project has
already chosen it twice, for chunked search (D-041) and for the splice graft, where chunking cut the
block from ~400–960 ms to ~23 ms (`DECISIONS.md`, D-036's addendum). What separates this case from
those is the measurement, not the symptom: there the work was genuinely that large, here 10 MB of
output was being copied 65,000 times. **Measure the shape before choosing the machinery** — async
machinery over a quadratic loop is permanent complexity papering over a bug.

## 6. R110 — the regression test, and why it can be a timing test here

Normally a wall-clock assertion is a flaky test. This one is not, because the gap is not marginal:
at **5 MB / 20,000 matches** the shipped code takes **28.9 s** and the fix takes **7.5 ms**.

**A 2-second bound fails the current implementation by 14× and passes the fix by 260×.** No plausible
CI machine sits in that band. Use `test:node`, not the browser project — this is pure `Uint8Array`
work with no DOM.

**And assert correctness at the same size in the same test**, not only the time: the output bytes
must equal the same replace computed the slow way. A performance test that does not check the answer
is how a fast wrong implementation ships.

## 7. Definition of done

- [x] R108 — the new primitive lives in `documentEdits.ts` beside `applyPatch`, with its
      precondition (ascending, non-overlapping, **input-buffer coordinates**) in the doc comment and
      checked under `import.meta.env?.DEV`.
- [x] R108 — `applyReplaceAll` allocates the result buffer **once**, whatever the match count. The
      defensive ascending sort stays.
- [x] R108 — replacing every match in a document produces byte-identical output to the current
      implementation, asserted against a fixture with matches at the first byte, the last byte, and
      adjacent to each other.
- [x] R109 — **narrowed, see §8**: `applyUndoEntry` uses the fast primitive only for an entry marked
      `independent` (a Replace All or a Transform); an ordinary typing burst keeps the original
      per-patch loop. Undo's inverses are still **rebased** through a named function whose comment
      explains the sequential-coordinates invariant, for the entries where that's sound.
- [x] R109 — **replace-all → undo → redo → undo on a multi-match document round-trips to the
      original bytes exactly.** Both a shrinking replacement (`engine`→`eng`) and a **growing** one
      (`eng`→`engine`), since the growing case is the one where a missing rebase corrupts silently
      instead of throwing.
- [x] R110 — 5 MB / 20,000 matches completes **under 2 seconds** and produces the correct bytes,
      in `test:node`.
- [x] The confirmation threshold and wording are unchanged (§2), and the reason it survives a
      ~8,000× speed-up is recorded where the constant is defined — otherwise it reads as vestigial.
- [x] `docs/FINDINGS.md` gains the trap: **`applyPatch` allocates the whole document per call, so
      calling it in a loop is O(document × patches).** It is the correct primitive for one patch and
      the wrong one for a batch; both batch call sites (`applyReplaceAll`, `applyUndoEntry`) had it,
      and the symptom is a frozen window with a working scroll wheel, which reads as a crash.

## 8. Results

R108 and R110 built exactly as specified. **R109 built with one narrowing this document didn't
anticipate, found by a failing test, not by inspection.**

The plan's §4 table treats `applyUndoEntry`'s three callers (`applyReplaceAll`, `redo`'s
`entry.patches`, `undo`'s `entry.inverses`) as if every `UndoEntry` they might ever see has the same
shape a Replace All produces: patches built as one batch against a single baseline buffer, so
non-overlapping by construction. That's true for a Replace All (every match comes from Find, which
never returns overlapping spans) and trivially true for a Transform (always exactly one patch) — but
`applyUndoEntry` is also the *general* undo/redo machinery for ordinary typing, where `UndoEntry`s are
built **incrementally**, one edit at a time, each against the buffer the previous edit in the same
burst had already produced. That shape can, and routinely does, touch the *same* byte range more than
once — correcting one character three times in a row, the plainest possible edit, produces three
overlapping patches over the same `[5, 6)` span.

Applying `applyPatchesAscending`'s single ascending pass to an overlapping list isn't slower, it's a
different and wrong operation, and this was **not** caught by reasoning about it — it was caught by
`test/documentSession.test.ts`'s existing "a burst of many edits is one undo entry" test failing with
`applyPatchesAscending: invalid or out-of-order range [5, 6) over 7 bytes` the one time the fast path
was tried unconditionally on every `applyUndoEntry` call. A second, related trap the same investigation
surfaced: even *non*-overlapping same-burst patches can't be uniformly "just reversed" either —
`undoStack.ts`'s own doc comment ("patches replayed in this order for redo," "inverses walked back to
front") already states two *different* replay conventions depending on how an entry was built, which
the plan's table collapsed into one.

**Fix: `UndoEntry` gains `independent: boolean`** (`undoStack.ts`), set `true` only by
`applyReplaceAll` and the Transform push, `false` by `flushUndoBurst`. `applyUndoEntry` takes an
explicit `fast` flag; `undo()`/`redo()` decide it from `entry.independent` and only rebase/reverse in
the branch where that's sound. The general (typing-burst) path is byte-for-byte the pre-R109 code —
a plain per-patch loop, `applyPatch` in the given order, no rebase, nothing new to get wrong.

So the fast, O(1)-allocation undo/redo path this round set out to build **does** land, and gets
exactly the case that mattered (Replace All's own large-N undo/redo, verified by the shrinking/growing
round-trip test). What doesn't land is the plan's stated shape of the fix — "the same primitive for
all three callers," unconditionally — because that shape is unsound for the caller the plan didn't
separately consider. Recorded here rather than silently narrowed, per this project's own review
discipline.

`test/documentEdits.test.ts` gained: `applyPatchesAscending` (six tests — multiple non-overlapping
patches, byte-identity against the old descending-loop reference, first/last-byte matches, adjacent
matches, an empty list, and the DEV-only throw on overlap) and `rebaseSequentialPatches` (three tests
— a single-patch no-op, a shrinking shift, a growing shift) as focused unit tests, plus the R110
5 MB / 20,000-match timing-and-correctness test. `test/documentSession.test.ts` gained a
`replace-all → undo → redo → undo` round-trip test parameterized over shrinking and growing
replacements. Full node suite (101 files, 1432 tests) and full browser suite (40 files, 201 tests)
pass; `npm run lint` (eslint + stylelint) clean; `npm run typecheck` shows the same nine pre-existing,
unrelated failures present before this round.
