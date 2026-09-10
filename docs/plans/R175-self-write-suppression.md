# R175–R178 — the app's own save is detected as an external change

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Saving a document made the file watcher fire, so the app
reacted to its own write as though another program had edited the file. The visible symptom was two
banners flashing; the invisible one was that **every save silently discarded the undo stack and
re-parsed the whole document**.

Found by a user exercising R169 by hand on `main`, in the same manual pass that produced R168–R171.
§16 records what landed; the residual race §12 names is settled as `DECISIONS.md` D-092.

---

## 1. What was observed

Reported verbatim:

> When I just edit a file (regularly, no dirty state, the file has not been edited by another
> tool), then save the file: I see quickly the selection dialog flashing of keeping or discarding
> my changes (at least that's what I believe, it just flashes) and then I see the "reloading
> changes from disk" dialog as if the file was written and saved and if that triggers a reload.

No other program touched the file. R169's own behaviour is correct throughout — every banner shown
is the banner the state asks for. The defect is that the state is reached at all.

## 2. What the code does — there is no concept of "our own write" anywhere

`createDocumentWatcherRegistry` (`src/core/documentWatchers.ts`) decides whether an OS event is a
real change by comparing `mtimeMs` against a baseline captured when the watch was established:

```ts
const current = await deps.stat(path)
if (current === null || current.mtimeMs === fresh.lastKnownMtimeMs) return
fresh.lastKnownMtimeMs = current.mtimeMs
for (const [watchingKey, notify] of fresh.keys) notify(watchingKey)
```

Nothing updates that baseline except the watcher itself. `document:write`
(`src/main/documents.ts:141`) is a bare `await writeDocument(path, bytes)` that does not reference
`watchers` at all, and the renderer's `save()` (`src/renderer/session/documentSession.ts:2056`)
does not re-arm the watch either. **A save is therefore indistinguishable, by construction, from a
third-party write.** The registry is not malfunctioning; it is answering the only question it was
given.

`main/documents.ts`'s own module comment states the intent that §3 disproves:

> `mtimeMs` comparison … is what turns "the watcher noticed something" into "the file's contents
> actually changed since we last knew."

That holds for a save arriving from *outside* the app. It does not hold for our own, because "what
we last knew" is never updated when we are the writer.

## 3. Measured: one save fires the notification twice, the first time before the write resolves

Probed against a real `fs.watch` on a real file, driving exactly the `writeFile` call
`core/mainDocumentIO.ts:37` makes, with the registry's own stat-and-compare logic reproduced around
it. Environment: Windows 11 Pro 10.0.26100, Node v24.15.0, file on the NTFS user temp volume.
Timings are milliseconds from the start of the write.

```
save 1: document:write resolved +6.93 ms   -> IPC reply, renderer clears dirty
  notify sent to renderer      +2.63 ms
  notify sent to renderer      +7.33 ms

save 2: document:write resolved +1.41 ms
  notify sent to renderer      +0.68 ms

save 3: document:write resolved +3.80 ms
  notify sent to renderer      +1.73 ms
  notify sent to renderer      +4.00 ms
```

Two facts, both load-bearing:

- **One `writeFile` produces two `change` events with different mtimes**, 1 ms apart — `…707465.2207`
  then `…707466.242`, recorded by a companion run of the same probe that reported the mtimes rather
  than the timings, so the two figures above and this pair come from separate runs. The mtime guard exists precisely to collapse a
  multi-operation Windows save into one logical change, and it does not, because the intermediate
  mtime genuinely differs from the final one.
- **The first notification is sent before the write resolves.** Main sends
  `document:externalChange` while the renderer is still awaiting `document:write`'s reply, so the
  renderer processes the external change *before* it clears `dirty`.

The event count varies between saves (save 2 produced one, saves 1 and 3 produced two). Both counts
are defective; §4 gives the two sequences.

**This is not Windows-only.** A single event with a changed mtime is sufficient to trigger the whole
sequence, and every platform produces at least one. Only the specific two-banner flash depends on
the double event.

## 4. Why that produces exactly the reported sequence

With two notifications:

1. Notification 1 arrives while `dirty` is still `true`. `handleExternalChange` takes the dirty
   branch and sets `externalChangeDetected` → the banner reads
   *"`<file>` changed on disk. Reload and discard your unsaved edits, or keep what you have?"* with
   **Reload and Discard** and **Keep Mine**. This is the flash.
2. The write's IPC reply lands and `save()` sets `dirty: false`. It does **not** clear
   `externalChangeDetected` — its `setState` spreads `{ ...state.document, dirty: false }` — so the
   banner stays up.
3. Notification 2 arrives with `dirty` now `false`. `handleExternalChange` takes the clean branch and
   auto-reloads → `reloadPending` → the banner becomes *"Reloading `<file>` from disk…"* with only
   **Keep Mine**, then the reload commits and clears both.

With one notification, step 1 happens and steps 2–3 do not: **the two-button banner appears and
stays**, because after `dirty` goes false nothing ever clears `externalChangeDetected`. The user
must click a button to dismiss a prompt about a change that never happened.

## 5. What it costs beyond the flash

The auto-reload in step 3 is a real reload, so on every save it also:

- **Discards the undo stack.** `reloadFromDisk` sets `undoState = EMPTY_UNDO_STACK` and cancels the
  burst scheduler — correct for a genuine reload (`reloadAndDiscard also clears the undo stack`
  asserts it deliberately), and wrong here. **After any save, `Ctrl+Z` does nothing.** This is
  reproducible by hand on `main` and is the most serious consequence: the flash is cosmetic, losing
  the undo history is not.
- **Re-reads and fully re-parses the document** — mints a read token, refetches the entire buffer
  through `parseFromUrl`, and rebuilds the store, row index, line index and name index. On a large
  file that is the whole open cost, paid on every save.
- **Increments `externalRewrites`**, rebuilding the Raw editor from the new buffer (R100), and
  **resets selection** with a `requestReveal`.

There is also a data-loss path, not merely an annoyance. Edit → save → edit again quickly, and
notification 2 finds `dirty` true again: the two-button prompt stays up, and **Reload and Discard**
then destroys a real unsaved edit in favour of content byte-identical to what the user already had.
R169 exists because that button destroyed edits it was meant to protect; this is a second route to
the same outcome, reached without any external change at all.

## 6. Why no test caught it

`test/documentSession.test.ts` has `save/saveAs (F7)` at line 1596 and `external modification (F8)`
at line 2714. Save is tested with no watcher attached; the watcher is tested with no save. Both
halves are covered thoroughly and **the interaction between them is covered by nothing** — the same
blind spot that produced R171, where the suite covered that watching works and never what happens
when the platform says no. R178 exists to close it as a stated deliverable rather than a side effect.

## 7. R175 — main holds the watcher across its own write

`document:write` runs the write inside a window during which the registry treats that path's events
as its own, and re-establishes the baseline before the window closes.

`DocumentWatcherRegistry` gains one method:

```ts
selfWrite<T>(path: string, write: () => Promise<T>): Promise<T>
```

which, in order: marks `path` as self-writing; awaits `write()`; re-stats `path` and commits the
result as that path entry's `lastKnownMtimeMs`; unmarks. A watcher callback firing while the mark is
set is dropped rather than compared, because the re-baseline at release covers every event the write
produced. A callback firing after release stats the final mtime, finds it equal to the new baseline,
and is quiet on its own.

The window must cover the re-stat, not just the write — §3 shows an event arriving 0.4 ms after the
write resolved, which would otherwise be compared against the stale baseline.

Required properties:

- **A path nobody watches is a no-op** that still performs the write (Save As to a new file).
- **The write's result and its rejection both propagate**; the mark is released either way, or a
  failed save disables external-change detection for the rest of the session.
- **Concurrent writes to one path nest** — a count, not a boolean.
- **Only the written path is affected.** Another document changing on disk during our save still
  notifies.
- Errors from the re-stat are tolerated the way `deps.stat` already tolerates them; a stat that
  fails leaves the baseline alone rather than throwing inside a save.

`main/documents.ts:141` becomes `watchers.selfWrite(path, () => writeDocument(path, bytes))`. The
registry stays Electron-free and the wiring stays thin, exactly as R52 and R171 left them.

## 8. R176 — a successful save resolves the external-change state

Independent of R175, and still needed once it lands. If a genuine external change is pending and the
user responds by saving, their bytes are now the file's contents: the prompt asking whether to
discard "your unsaved edits" is stale, there are no unsaved edits, and **Keep Mine** is a no-op while
**Reload and Discard** reloads their own content.

A successful `save()` therefore clears `externalChangeDetected` and the `hasExternalChange` context
key, and **cancels an in-flight reload the way `keepMine` does** — `reloadAbort?.abort(); reloadAbort
= null` — so a reload started before the save cannot land after it and re-apply §5's costs. This is
the same failure R169 fixed for Keep Mine, in the one other place a reload can be superseded.

Scoped by the same guards `save()` already applies after its await: only when the document is still
`ready`, still the same `filePath`, and still the same `sourceBuffer` identity.

`saveAs` gets the same treatment, since it reaches the same state through a different path.

## 9. R177 — Save As re-watches the new path

Found while verifying §2. **`api.document.watch` has exactly one call site in the entire renderer**
— `openPath`, at `documentSession.ts:882`. `saveAs` updates `filePath` and `fileName` in place and
never re-watches, so after a Save As the session is **still watching the file it was opened from**.

Two consequences, both real: an external change to the newly-written file is never detected, and an
external change to the *old* file triggers a reload of the *new* path, because `reloadFromDisk`
reads `state.document.filePath`. The registry already handles the rebind correctly — `watch()`
releases the key's previous registration first — so this is a missing call, not a missing mechanism.

Included here rather than given its own document because it is the same defect class: the watch does
not follow what the app itself writes.

## 10. R178 — the regression test that spans both halves

A test in which a session with a **live watcher** saves, and asserts:

- no reload occurs — no second `mintReadToken`, no second parse, `externalRewrites` unchanged;
- **the undo stack survives the save** and `Ctrl+Z`'s command remains enabled;
- no banner is derived at any point during the sequence;
- selection and caret are unchanged.

Driven with a fake whose notification timing reproduces §3 — including the notification that arrives
**before** the write resolves, which is the ordering the whole defect depends on and the one a naive
fake gets wrong by delivering events after the save has settled.

Plus a real-filesystem test alongside `test/fsWatcherDeps.test.ts`'s pattern, asserting that a real
`writeFile` through `selfWrite` produces **zero** notifications where the unpatched path produces
one or two — the R171 discipline of inducing the real failure rather than asserting against fakes
only. It must tolerate the platform's event count varying (§3 saw both 1 and 2), so the assertion is
"zero notifications", never "exactly two events were suppressed".

## 11. What the implementation must not do

- **Not a timer.** "Ignore watcher events for N ms after a save" is the fixed-duration wait R159–R163
  removed from four separate places, and it is both leaky (a slow write outlives the window) and slow
  (a genuine external change is delayed by N ms). The window here is bounded by a *condition* — the
  write and its re-stat having completed — not by a duration.
- **Not a content hash.** Comparing a digest of the file against what we wrote is exact, and costs a
  full re-read of the document on every save. Invariant 1's reasoning applies directly: this is the
  one place a 200 MB file must not be pulled through memory to answer a bookkeeping question.
- **Not a re-read of any kind.** The re-baseline is one `stat`.
- **Not a change to the clean-document auto-reload.** Reloading silently on a genuine external change
  is F8/§11.3's specified behaviour and is correct; the defect is that a save reaches it.

## 12. The one race that stays open, to be recorded rather than closed

A third-party write landing *inside* our own write window is absorbed: the post-write stat reads
their mtime and commits it as the baseline, so the change is never reported. The window is the
duration of a `writeFile` plus a `stat` — single-digit milliseconds by §3's measurements — and
closing it properly needs the content comparison §11 rules out.

The round should decide this explicitly and record it in `DECISIONS.md` rather than leave it
unstated. The cheap partial mitigation available for free, since the release path already stats: if
the post-write `size` differs from the byte length just written, someone else wrote and the
notification should fire. It does not catch a same-size third-party write, and the entry should say
so rather than claim the race is closed.

## 13. Acceptance

1. A save with a live watcher produces **no** external-change notification, demonstrated against a
   real filesystem and not only against fakes.
2. **The undo stack survives a save** — asserted directly, as the symptom that matters most.
3. A genuine external change is still detected, still auto-reloads a clean document, and still
   prompts on a dirty one; a change to a *different* open document during a save is unaffected.
4. A failed save leaves external-change detection working.
5. A successful save clears any pending external-change state and cancels an in-flight reload.
6. After Save As, the watch follows the document to its new path, and the old path is no longer
   watched on the document's behalf.
7. §12's residual race is written down in `DECISIONS.md` with what was rejected and why.

## 14. Out of scope

Whether the auto-reload should preserve the undo stack for a *genuine* external change (it should
not — the entries are patches against a buffer that no longer exists, and D-036/F10's reasoning is
unchanged). Debouncing or coalescing watcher events in general. Any change to what the banners say.

Nothing here is a visual decision, so `PLANNING.md` §1's render-before-deciding rule has nothing to
act on: the round's whole effect on screen is that two banners which should never have appeared stop
appearing. §3 is the measurement this plan's claims rest on instead, per §2 of the same document.

## 15. Version

No bump implied — defect fixes against unreleased `1.0.0`, consistent with R168–R171.

## 16. Results

All four tasks landed, in one commit each.

| | |
|---|---|
| **R175** | `DocumentWatcherRegistry.selfWrite`; `document:write` routes through it |
| **R176** | `save`/`saveAs` clear the external-change state and cancel an in-flight reload |
| **R177** | `saveAs` re-watches the path it just wrote |
| **R178** | the seam between saving and watching, in two test files |
| **D-092** | the design, its four rejected alternatives, and the accepted race |

Suite **1921 → 1941**: 1936 passed, 5 skipped, 163 files. `typecheck` clean; `lint` unchanged at
its ratcheted 3 warnings, 0 errors.

### What the acceptance criteria have

1. **A save with a live watcher produces no notification, against a real filesystem.**
   `test/selfWriteSuppression.test.ts` — a bare `writeFile` notifies, the same write through
   `selfWrite` produces zero. The bare half asserts the mtime moved *before* asserting the watcher
   reported it, because that is the registry's own criterion for "changed": a run whose timestamp
   did not move had nothing to detect, and finding that out from a failed assertion beats a green
   test that proved nothing.
2. **The undo stack survives a save** — asserted directly, and twice: that `canUndo` is still true,
   and that `undo()` actually returns the buffer to its pre-edit bytes rather than only looking
   enabled.
3. **A genuine external change is still detected**, including specifically *after* a save through
   `selfWrite` — the failure this design could most easily have is external-change detection going
   quietly dead once the baseline moves. A change to a *different* open document during a save is
   covered in `documentWatchers.test.ts`.
4. **A failed save leaves detection working** — the mark is released in a `finally`, and a later
   genuine change still notifies. Mutation-verified.
5. **A successful save clears pending external-change state and cancels an in-flight reload.**
6. **After Save As the watch follows the document**, and the old path stops being watched on this
   session's behalf — main's `watch` releases the key's previous registration first, so the
   re-watch *is* the unwatch.
7. **§12's race is D-092**, with what was rejected and why.

### The reproduction is a test, not a comment

`documentSession.test.ts`'s R178 block runs the same session **without** `selfWrite` and asserts the
defect: `externalRewrites` rises, and `canUndo` is false. That test only reproduces because the fake
models §3's measured ordering rather than an idealised one:

- **the first notification arrives before `document:write` resolves**, so the renderer handles it
  while `dirty` is still `true` — which is what puts the two-button prompt up;
- **the second arrives after**, once `save()` has cleared `dirty` — which is what sends the
  clean-document branch into an auto-reload.

Deliver both inside the write and the reload never happens. Deliver both after it and the prompt
never does. A first attempt did the former and produced two green tests asserting nothing, which is
how the ordering earned its own paragraph here.

### Mutation-verified, and one mutation initially escaped

Eleven mutations across the two source files, applied one at a time with the suite run after each.
Ten were red immediately. The one that was not:

**Releasing the mark before the re-baseline instead of after.** The code comment claimed the
ordering mattered and no test proved it — precisely the shape of claim this project's review
agreement exists to catch. Closing it needed a way to act *while a stat is in flight*, so the
registry's fake `stat` gained an `onStat` hook; the test fires a watcher event during the re-stat,
which is the instant a premature release re-opens the window. §3's "an event arrived 0.4 ms after
the write resolved" is that instant, measured.

The others: removing the drop, removing the re-baseline, a flag instead of a count, not releasing on
a rejected write, skipping the reload abort, leaving `externalChangeDetected` set, leaving
`reloadPending` raised, not clearing at all, dropping R177's re-watch, and moving that re-watch
before the dialog result is checked so a *cancelled* Save As re-watches anyway.

### One honest limit on the real-filesystem test

Removing the drop from the registry turns the session tests red and leaves
`selfWriteSuppression.test.ts` **green**: a 32-byte write's events land after `writeFile` resolves
there, where the re-baseline alone silences them. The drop covers events arriving *during* the
write, and that ordering is controllable only in a fake. Both tests are load-bearing and neither
subsumes the other — recorded because a reader who assumes the real-filesystem test covers
everything would be wrong.

### Review, per `R` id

- **R175** — the plan's §12 offered a "free" mitigation: fire a notification when the post-write
  `size` differs from the bytes just written. **It does not work as described**, and the finding is
  in D-092 rather than left for someone to re-derive: events inside the window are *dropped*, not
  deferred, so there is no pending event left to fire. Making it work needs `size` on
  `DocumentWatcherDeps.stat`, the expected length threaded through `selfWrite`, and a synthesised
  notification with no watcher event behind it — a feature, for the different-size subset of a
  sub-10 ms window. Not built; recorded.
- **R176** — `clearExternalChangeAfterSave` both mutates session state and returns a document to
  spread, which reads purer than it is. Kept, because it is the shape and order `keepMine` already
  uses and splitting it would separate the abort from the state it invalidates; its doc comment now
  says so explicitly.
- **R177** — nothing found. The call is one line and its two tests bracket it on both sides.
- **R178** — the first draft of the session fake delivered both notifications inside the write,
  which made the reproduction test pass while reproducing nothing. Caught by running it: the
  reproduction was green when it had to be red.
- **D-092 rode with R178 rather than with R175**, which is where `CLAUDE.md`'s "record decisions in
  the same commit" would have put it. Named rather than quietly tidied.

### Not done, and deliberately

§14's exclusions hold: nothing changed about what the banners say, nothing about the undo stack on a
*genuine* external change (D-036/F10's reasoning is unchanged — the entries are patches against a
buffer that no longer exists), and no general debouncing of watcher events. **No version bump**, per
§15 and consistent with R168–R171.
