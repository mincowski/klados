# R228 — R222's clipboard test raced the macOS pasteboard

<!-- status: built -->

**Built**, for 1.2.2. A test-only change; the application is untouched.

## 1. What failed

Dependabot's brace-expansion pull request (#57) went red on macOS, in a test unrelated to its lockfile
change. `test/mainElectron.test.ts`, *R222: the clipboard › a write from the page reaches the system
clipboard*:

```
AssertionError: expected 'before' to be 'written by R222'
```

- **The page's write had succeeded:** the assertion before it, that `navigator.clipboard.writeText`
  resolved, passed.
- **The read failed.** It came from the main process (`clipboard.readText()`), straight after the
  write, and returned the text the test had put there beforehand.

**Why, read in Chromium's source:**
- **The promise resolves before the write happens.** Blink's `ClipboardPromise::HandleWriteTextWithPermission`
  calls `WritePlainText`, then `CommitWrite()`, then resolves the promise.
- **`CommitWrite` is a one-way mojo message** in `clipboard.mojom`. Unlike `ReadText`, which is `[Sync]`
  with a reply, it has no reply, so nothing waits for the browser process to apply it.

A read from the main process straight after the promise settles races that message. It usually wins.
The test passed on every platform from R222 until 2 October, including #53, #54 and #55. Under a loaded
CI runner it can lose.

**Klados is not affected.** Its copy buttons write and never read back. A user pastes long after the
write has landed.

## 2. The change

The read is polled with `expect.poll` instead of read once, with the project's standard 5 s
(`TIMEOUT_MS`, `test/support/wait.ts`). Nothing else in the test changes.

**The first version used Vitest's default, 1 s, and that was not enough.** It passed on all three
platforms in #59, then failed on Linux in #58's next run on the same code:
`expect.poll() function didn't resolve in time`. Five seconds is a margin chosen from that, not a
measured bound; a later failure at 5 s would point at something other than this race.

## 3. Verification

- **The mechanism** is read in Chromium's source (§ 1), not inferred from the failures alone.
- `test/mainElectron.test.ts` passes against the built app on Windows (10 tests).
- **The poll can still fail.** Expecting a string that is never written fails with
  `expected 'written by R222' to be 'never written'`. The test does not pass vacuously, and a write that
  never lands still fails at the poll's timeout.
- **Not reproduced here:** the failure needs macOS. CI's macOS job is the check, on this pull request and
  on every one after it.

## 4. Review

One assertion changed, read in `git diff`. The other two clipboard tests have no read-after-write and
are unchanged. Nothing to fix.
