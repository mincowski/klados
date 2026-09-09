# R171 — a file watcher error crashes the main process

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Results in §10; the decisions are D-089.
**§3 was wrong about the trigger and §10a corrects it:** deleting the watched *file* is quiet,
but deleting its parent **directory** raises the reported `EPERM` every time.
A user hit an Electron *"A JavaScript error occurred in the main process"* dialog while exercising
the app by hand. The cause is a missing three-line listener, and its absence meant **any** watcher
error was an uncaught main-process exception.

---

## 1. What was observed

Reported with a screenshot, verbatim:

```
A JavaScript error occurred in the main process

Uncaught Exception:
Error: EPERM: operation not permitted, watch
    at FSWatcher._handle.onchange (node:internal/fs/watchers.ts:214:21)
```

The window stayed open behind the dialog. The document was a 10 MB XML fixture the app had under
an active watch.

## 2. What is certain

**`fs.watch` has no `'error'` listener anywhere in `src/`**, and there is no
`process.on('uncaughtException')` either — both confirmed by grep across the tree. The whole of the
watcher construction is `main/documents.ts`:

```ts
watch: (path, onEvent) => {
  const fsWatcher = fsWatch(path, { persistent: false }, onEvent)
  return { close: () => fsWatcher.close() }
}
```

`fs.FSWatcher` is an `EventEmitter`, and **an `'error'` event with no listener throws**. In the main
process that is an uncaught exception, which is precisely the dialog above. The stack confirms where
it came from: `FSWatcher._handle.onchange` is the watcher's own change callback, so the error arose
while the watch was live rather than at registration.

**This does not depend on knowing which event produced it.** The listener is missing; every watcher
error therefore takes the same path. That is the same argument R164 made for `will-navigate`: a
guard's value is that it covers the triggers nobody enumerated, so the fix should not wait on
enumerating them.

## 3. What is *not* established, and should not be guessed

**The trigger was not reproduced.** A probe that launched the real app, watched a file, and deleted
the file *and its directory* out from under the watcher produced **no error at all** — clean main
process output, no exception. So the obvious hypothesis ("delete the watched file") is, at least on
its own and on this machine, wrong.

Candidates worth trying in R171, none of them confirmed:

- A watched path on a **removable or network drive** that becomes unavailable.
- A **permission change** on the file or its directory mid-watch.
- Windows-specific replacement patterns — some editors' atomic saves, an installer, a `git checkout`
  that swaps the file while a handle is open.
- Interaction with the app being **killed and relaunched** repeatedly while watches on the same path
  are outstanding, which is what the machine in question had been doing all day.

**R171's first job is to find a reliable trigger**, because the *behaviour* to add on error depends
on which class of failure it is — a vanished file and a transiently locked one deserve different
answers.

## 4. What the handler should do, which is a real decision

Attaching an empty listener stops the crash and silently drops the watch: from then on the document
is unwatched and nothing says so, which trades a loud failure for a quiet one. At least three
answers exist and R171 should choose deliberately:

- **Release the watch and tell the renderer**, so the session knows it is no longer being watched.
  Most honest, most work — it needs a new IPC signal and a decision about what the UI says.
- **Release the watch silently**, accepting that external-change detection stops for that document.
  Cheapest, and arguably fine given watching is a convenience rather than a correctness feature.
- **Retry with backoff**, which suits a transient lock and is wrong for a deleted file.

Whatever is chosen, **the watch must not be left in a state that throws again on the next event**,
and it must be released rather than leaked (`keySenderIds` and the registry's refcount both need to
agree with reality).

## 5. Should main have an `uncaughtException` handler at all?

Worth settling once rather than each time this shape recurs. Electron's default for an uncaught
main-process exception is the dialog the user saw, which is the worst of both worlds in a shipped
app: it blames the app in front of the user and says nothing useful to a developer.

Arguments both ways, and R171 should record the decision in `DECISIONS.md` either way:

- **For:** a last-resort handler that logs and keeps the app alive turns a fatal dialog into a
  degraded feature, which for a *file viewer* is almost always the better outcome.
- **Against:** a catch-all is exactly how a real defect becomes invisible, and this project's whole
  culture is the opposite — R47's buried lint signal, R155's buried Dependabot alerts.

A defensible middle: handle the specific error where it arises (§4) **and** add a global handler
that logs loudly without suppressing the process's exit code in development.

## 6. Non-functional expectation (`PLANNING.md` §3)

**A failing watcher must not spin.** If the error repeats — a path that keeps failing, a watcher
re-registered on every event — the handler must not produce a retry loop that logs on every
filesystem tick. Release, or back off; do not re-arm unconditionally.

`PLANNING.md` §1 applies only if §4 chooses the "tell the renderer" answer, which introduces
something the user sees. Render it before settling it.

## 7. Acceptance criteria

1. **A reliable trigger, or a documented failure to find one.** If R171 cannot reproduce the error,
   it says so plainly and fixes the missing listener anyway — §2 stands without §3.
2. A watcher error **cannot** produce an uncaught main-process exception. Demonstrated by a test
   that induces one, not by reading the code.
3. The failed watch is released, and the registry's bookkeeping (`keySenderIds`, the refcount)
   matches reality afterwards.
4. Whatever §4 chooses is written down in `DECISIONS.md`, including what was rejected.
5. §5's question is answered explicitly, not left implicit in whatever the code happens to do.
6. No retry loop (§6).

## 8. How it was found, which is worth keeping

Not by a test, and not by the round that owns this area. **A user ran the app by hand, and the app
told them.** The suite has no coverage of watcher failure modes at all — it tests that watching
*works*, never what happens when the platform says no.

That is the same shape as `docs/FINDINGS.md`'s entry on this project's blind spot: the failure paths
of the real application, on a real filesystem, are where the untested axes are.

## 9. Not in scope

R168's CRLF corruption, R169's reload affordance and R170's tree scrolling — three other defects
from the same manual pass, each with its own document. Also out of scope: the test-side defect that
made this surface during a test run (watchers leaked onto deleted temp files), already fixed in
R164–R167's branch, since a test that can pop a modal dialog on a CI runner is a separate problem
from a product that can pop one at all.

---

## 10. Results

**Built.** The trigger §3 said it could not find was found, the missing listener is in place, and
both §4's and §5's decisions are recorded in `DECISIONS.md` as D-089.

### 10a. The trigger, which §3 got wrong in both directions

§3 reported that a probe deleting the watched file *and its directory* produced no error at all, and
concluded the obvious hypothesis was wrong. Re-probed across seven scenarios:

```
   delete the watched file                    error=(none)
>> delete file and its directory              error=EPERM: operation not permitted, watch
   rename the watched file away, recreate it  error=(none)
   deny all access to the file (icacls)       error=(none)
   deny all access to the directory (icacls)  error=(none)
   rapid write burst then delete              error=(none)
```

**Deleting the file alone is quiet; losing its parent directory is what raises `EPERM`** — the
reported error, matching on `code`, `syscall` and message. So §3 was half right: the hypothesis it
tested ("delete the watched file") really is wrong, and the conclusion it drew from that — that the
directory case produces nothing either — was wrong too. The earlier probe most likely closed its
watcher before the event arrived, or never attached a listener to observe it.

**One candidate was credited and then withdrawn.** *Renaming* the parent directory appeared to
reproduce, until it was noticed that the probe went on to delete the renamed directory — the
deletion was doing the work. Driven alone it produces nothing within four seconds, so it is not
claimed and not tested: a scenario that reproduces once and then does not is a flaky test, not a
finding.

### 10b. What landed

- **`src/main/fsWatcherDeps.ts`**, new. The `fs`-backed `DocumentWatcherDeps`, moved out of
  `main/documents.ts` — which imports `electron` at module scope, so the one place `fs.watch` was
  actually constructed was the one place no test could reach. The same split `mainSecurity.ts`,
  `mainQuitFlow.ts` and `mainDocumentIO.ts` already use, for the same reason.
- **The `'error'` listener**, three lines, in that module.
- **`DocumentWatcherDeps.watch` gains a required `onError`**, and the registry handles it by
  releasing the path entry: the handle closed, every key that was watching it dropped from
  `keyToPath`, the entry removed from `pathEntries`.
- **`PathEntry.handle` becomes `WatchHandle | null`.** It was `null as unknown as WatchHandle`, a
  lie that worked only because nothing could observe the window between constructing the entry and
  `deps.watch` returning. The error callback *can* fire inside that window, so the type is now
  honest and `closeQuietly` tolerates it.
- **`closeQuietly`**, because closing an already-failed watcher can itself throw — which would be
  the same uncaught exception in a new place.

### 10c. Verified by inducing the real failure, not by reading the code

Acceptance 2 asked for exactly this, and it is the difference between the two test files.
`test/fsWatcherDeps.test.ts` drives the real `fs.watch` against a real directory. With the listener
removed again, the suite does not merely fail — it reports the defect verbatim:

```
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯
Error: EPERM: operation not permitted, watch
Serialized Error: { errno: -4048, syscall: 'watch', code: 'EPERM', filename: null }
```

That is the reported crash, reproduced inside the test runner. Three of the four tests go red.

`test/documentWatchers.test.ts` covers the consequence with fakes — that a failed watcher is
released, closed, its keys forgotten, nobody notified, nothing re-armed, and that a *stale* failure
from a replaced watcher cannot take its successor down. Removing the registry's release turns the
end-to-end case red.

**One of those tests was vacuous and was rewritten.** The first version asserted that `unwatch` did
not throw after a failure — which it never does, released or not, so it passed either way and proved
nothing. The release *is* observable: a released path builds a fresh watcher next time, where a
surviving entry would simply be joined. Counting constructions is the assertion that distinguishes
them.

### 10d. §4 and §5, decided rather than defaulted (D-089)

**§4 — release and log.** External-change detection stops for that document; nothing else changes.
"Tell the renderer" was rejected as deferred work, not dismissed: it is the more honest answer and
needs an IPC signal, a preload surface, a session hook and a UI decision `PLANNING.md` §1 would want
rendered. What makes deferring defensible is that the confirmed trigger is the directory being
deleted — the document is gone, the user finds out at save, and the watcher is reporting the world
rather than a fault. "Retry with backoff" was rejected outright: nothing to retry against, and §6
forbids the spin.

**§5 — no global `uncaughtException` handler, and the reason is this defect.** The crash is *how the
bug was found*. Nothing in the suite covered watcher failure, no test would have caught it, and a
catch-all installed earlier would have turned a loud, dated, screenshotted report into a watcher that
silently stopped working forever. That is R47's buried lint signal and R155's buried Dependabot
alerts in a third place. Handle failures at the seam that knows what they mean; leave the process's
own error behaviour alone.

### 10e. Acceptance, criterion by criterion

1. **A reliable trigger** — found (§10a), and the withdrawn candidate is recorded too.
2. **A watcher error cannot produce an uncaught exception, demonstrated by inducing one** — §10c.
3. **The failed watch is released and the bookkeeping matches** — asserted by re-watching, which is
   what makes it observable.
4. **§4's choice written down with what was rejected** — D-089.
5. **§5 answered explicitly** — D-089.
6. **No retry loop** — asserted: after a failure the watcher count stays at one, and nothing is
   notified.

Suite **1887 → 1896**, lint at its 3-warning ratchet, typecheck clean.

### 10f. Review pass

Reviewed as a separate pass over `git diff`. Two findings, both fixed:

- R163's own lint rule rejected four bare durations in the new test — the rule working exactly as
  intended on the first file to touch it since it landed. Both surviving durations are legitimate (a
  timeout that turns a hang into a failure; the margin for the one negative assertion) and now have
  names saying so.
- Removing the watcher deps from `main/documents.ts` left `stat` imported and unused; removed.

### 10g. Not done

**The renderer is not told.** D-089 records why, and the alternative with it. If the "changed on
disk" banner silently never appearing turns out to matter, that is a follow-up with a UI decision in
it, not a line of code.
