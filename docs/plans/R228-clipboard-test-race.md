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

On macOS, then, the page's promise can settle before the system pasteboard shows the new contents to
another reader. The test passed on macOS in every run before this one, including #53, #54 and #55, so
it is a race and not a constant.

**Klados is not affected.** Its copy buttons write and never read back. A user pastes long after the
write has landed.

## 2. The change

The read is polled with `expect.poll` (Vitest's default: 1 s, retried every 50 ms) instead of read
once. Nothing else in the test changes.

## 3. Verification

- `test/mainElectron.test.ts` passes against the built app on Windows (10 tests).
- **The poll can still fail.** Expecting a string that is never written fails with
  `expected 'written by R222' to be 'never written'`. The test does not pass vacuously, and a write that
  never lands still fails at the poll's timeout.
- **Not reproduced here:** the failure needs macOS. CI's macOS job is the check, on this pull request and
  on every one after it.

## 4. Review

One assertion changed, read in `git diff`. The other two clipboard tests have no read-after-write and
are unchanged. Nothing to fix.
