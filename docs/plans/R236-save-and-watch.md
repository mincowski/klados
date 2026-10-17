# R236–R238 — Save stops failing blind, the watcher follows the path, and a watch race

<!-- status: built -->

**Built** (§6), with two departures from the plan, both recorded there. Windows keeps its file watch,
because a directory watch there turns a deleted folder into a busy loop (D-120). Writes go in 4 MiB
pieces, because one 200 MB `write` call was 4× slower than `writeFile`. Planned from the review of
2026-10-16, and rescoped by the project lead on 2026-10-17:
- **R237** (finding 6, high: data loss) is the reason for the round, and is built first. It stays an
  **in-place write**, made more robust: a free-space check before the file is touched, and an `r+`
  open, truncate, write and flush in place of `writeFile`. That also fixes a bug found while
  planning: **Klados cannot save a hidden file on Windows** (§1).
- **R236** (finding 8, medium, unverified) no longer depends on R237. It was the prerequisite while
  R237 meant saving by rename. An in-place save never replaces the file, so it no longer matters to
  Klados's own saves. It still matters for other programs that save by rename (§2).
- **R238** (finding 11, low) is a small race in the same module.

One topic: what Klados believes about a file on disk while it has the file open.

## 1. R237 — Save empties the original before writing, and fails on hidden files

`writeDocument` (`src/core/mainDocumentIO.ts:50`) is `writeFile(path, Buffer.from(bytes))`. That opens
the target with `O_TRUNC` (Windows: `CREATE_ALWAYS`), **emptying it first**, then writes. If the write
stops part-way, the user is left with a truncated or empty file, and Klados's in-memory copy is the
only intact one. Causes:
- the disk fills (`ENOSPC`). Measured as a kind already: `fileErrors.ts`'s `full`. So the error
  message for this case exists, and **the file it describes has already been destroyed when it is
  shown**.
- a network share drops.
- the process is killed, or the machine loses power.

**Measured on the development machine (Windows 11, Node 24.15.0) while planning:** a file with the
Windows *hidden* attribute cannot be saved at all.
```
writeFile(w): EPERM: operation not permitted, open '…\h.txt'
r+ + ftruncate: OK
```
`CREATE_ALWAYS` refuses an existing hidden file unless the caller passes the same attribute. VS Code
works around exactly this (below), so the fix is known.

Invariant 6 ("Save writes the byte buffer") says *what* is written, not *how*. Nothing below changes
the bytes.

### What other editors do, read in their source or documentation on 2026-10-17

| Editor | How Save writes | Protection against a failed write |
|---|---|---|
| **VS Code** (`diskFileSystemProvider.ts`) | **In place.** On Windows `r+`, then `ftruncate(0)`, falling back to `w`; elsewhere `w`. Its comment: `r+` is there "to prevent issues when saving hidden files or preserving alternate data streams". | Three write retries. Its own comment: if the write fails, "the file remains empty". Atomic temp-and-rename (`.vsctmp`) exists but is used **only for VS Code's own** state, settings and extension files, never for documents. |
| **Notepad++** (`FileInterface.cpp`) | **In place.** `CREATE_ALWAYS` (or `TRUNCATE_EXISTING` when the file has alternate data streams), then restores the creation time and attributes. | `FlushFileBuffers` on close, warning if it fails. No free-space check, no temp file. Its forum has 0-byte files after a save on a full disk. |
| **Vim** (`'backupcopy'`) | `yes` copies a backup and overwrites in place; `no` renames and writes a new file; `auto` renames only "without side effects", which excludes links and files whose owner and group cannot be kept. | The backup, during the write. |
| **Emacs** | Renames by default, but `backup-by-copying-when-mismatch` defaults to `t`: it copies instead whenever renaming would change the owner or group. | A `file~` backup. |
| **Sublime Text** (`atomic_save`) | Temp file and rename. | Users report changed owners and permissions on shared servers, and lost SharePoint version history. |

### Decided by the project lead: in place, with no rename and no backup copy

**Rejected: a temp file in the same folder, renamed over the original.** It was this plan's first
recommendation. It replaces the file with a new one, which:
- changes the **owner** to whoever saved. Editing another user's file makes you its owner. Emacs's
  default exists to prevent exactly this.
- loses an explicit **ACL**, alternate data streams and the file ID.
- breaks **hard links**, and replaces a **symlink** unless it is resolved first.
- puts a temp file inside folders synced by **OneDrive, Dropbox or Synology Drive**, which upload it.
  A rename then reads as delete-and-create, and that risks conflict copies and lost version history.
  Dropbox has no pattern-based ignore list.

Windows' `ReplaceFile` keeps the DACL and streams but not the owner, gives the file the temp file's
ID, and has no Node binding, so it would need a native dependency.

**Rejected: a backup copy of the original before writing** (Vim's `backupcopy=yes`, ideally kept
outside the synced folder). It was the second recommendation. It closes the crash window, but it
needs a recovery flow on the next start and a second full write on every save. VS Code and
Notepad++, the two editors closest to Klados's users, don't do it either. Not worth the plumbing for
the remaining case.

### The change

`writeDocument` becomes:

1. **Check free space before touching the file.** Call `fs.statfs` on the **parent directory**
   (it works for a new file too; `statfs` on a file path is not relied on). Refuse when
   `bytes.byteLength > currentSize + bavail × bsize`, where `currentSize` is the file's size from
   `stat`, or 0 when it does not exist. The refusal rejects with the `full`
   kind, so the renderer shows the existing message, now **with the original untouched**.
   - **A failing `statfs` never blocks a save.** If it throws (an unusual filesystem or a share
     that does not answer), the check is skipped and the write proceeds, as it does today.
   - It is a pre-check, not a guarantee. Quotas, copy-on-write filesystems (APFS, Btrfs, ReFS,
     where rewriting needs new blocks before old ones are freed) and another program writing at the
     same time can still make the write run out of space. That case keeps today's behaviour. The
     check removes the common case: a disk that was already full.
2. **Open the existing file with `r+`, not `w`.** `r+` does not truncate on open. The same file
   object is written, so its owner, ACL, alternate data streams, hidden and system attributes,
   creation time, file ID, hard links and symlinks all stay as they are, with nothing restored
   afterwards.
   - **`ENOENT`** (Save As to a new path, or a file deleted since it was opened) opens with `w`
     instead, which creates it. This is what `writeFile` does today, and the existing tests for a
     new file stay green.
   - **Any other error is reported, with no fallback to `w`.** A locked file (`EBUSY`, R220's
     `locked`) or a permission error fails at the open, **before anything is truncated**, as today.
     `w` would fail the same way, or truncate a file `r+` could not open.
3. **`ftruncate(fd, 0)`, then write all of `bytes` from offset 0** (looping until every byte is
   written; `write` may write fewer).
   - **This order, rather than writing first and truncating to the new length afterwards**, is VS
     Code's. If either order fails part-way, the file is damaged. Truncating first leaves a file
     that is obviously short. Writing first can leave the new head followed by the old tail: a file
     that may still parse and is silently wrong.
4. **`fsync` (Windows: `FlushFileBuffers`) before closing.** Without it, Save can report success
   for data still in the OS cache, which a power cut loses. A failed `fsync` is a failed save, and
   rejects with its kind like any other error. The document stays dirty.
5. **The handle is closed on every path**, including failures, in a `finally`.

**Unchanged:** `documents.ts` still calls `writeDocument` inside `watchers.selfWrite` (D-092). The
flush now happens inside that window, which only widens it by the flush time. The `ftruncate(0)` and
the write produce watcher events, which the window drops exactly as it drops `writeFile`'s today.

**Cost, stated because the flush is the obvious version's hidden price** (PLANNING.md §3): `fsync`
of a 200 MB file waits for the whole file to reach the disk. It is measured on the 200 MB fixture,
on the development machine's SSD, before and after. **If the flush adds more than 1 s, it goes to
the project lead before landing**, not to a silent `fsync`-only-for-small-files rule. The free-space
check is one `statfs`, which costs well under a millisecond.

## 2. R236 — the watcher watches an inode, not a path

`fsWatcherDeps.ts` calls `fs.watch(path)` on the **file**. How long that watch survives the file being
replaced differs by platform:

| Platform | Mechanism (libuv) | After a rename-over |
|---|---|---|
| Windows | `ReadDirectoryChangesW` on the parent, filtered by name | keeps following the **path**. Measured: `mainElectron.test.ts`'s atomic-save test passes |
| Linux | `inotify` on the file's inode | expected to fire once (`rename`), then watch an inode no longer at that path |
| macOS | `kqueue` / FSEvents | expected to behave as Linux; **to be measured** |

`mainElectron.test.ts:510` (R164) proves *one* atomic save is noticed on all three CI runners. It does
not test a **second** change after it, and nothing in the registry re-arms a watch whose file was
replaced.

**Why it matters without R237's rename.** Klados's own Save stays in place (§1), so this is about
**other programs**: Vim's and Emacs's default saves rename, as do Sublime's `atomic_save` and most
programs that write a file "safely". If the watch dies on that rename, then on Linux, and probably
macOS, **every later change to the file goes unnoticed**, including the next one Klados would
otherwise reload.

**First, measure.** Add the second-change test below and run it on CI's three runners before changing
anything. Record which platforms are red. **If Linux and macOS are both green, R236's code change is
dropped**, and the test stays as a guard.

### The change, if the measurement confirms it

**Watch the parent directory and filter events by file name**: the mechanism Windows already uses
underneath, made explicit on every platform.
- The `mtimeMs` comparison and R175's `selfWrite` window are unchanged; they still decide whether
  content changed.
- R171's error handling still applies: losing the *directory* is the confirmed `EPERM` trigger, and
  stays an error.
- One directory watch per directory, refcounted like the per-path entries today. Two open files in
  one folder must not create two directory watchers.

The alternative, re-arming the file watch after every `rename` event, was considered. Rejected
because the file can briefly not exist between the unlink and the rename, and a re-arm that loses
that race leaves no watch at all, silently.

## 3. R238 — `unwatch` during a `watch` leaks the watch

`createDocumentWatcherRegistry().watch` (`src/core/documentWatchers.ts:184`) releases the key, then
awaits `deps.stat(path)`, then registers. An `unwatch(key)` arriving during that await finds nothing
to release. The `watch` then completes and registers anyway, so the key watches a file nobody
displays until the window closes. A tab closed while its document is still opening can do this.

**The change:** a per-key generation counter. `watch` takes a number before its await and registers
only if that number is still the key's current one. `unwatch` and a newer `watch` both bump it.

## 4. Acceptance criteria

### R237

1. **A full disk no longer destroys the original.** A node test drives `writeDocument` with
   `statfs` faked to report less free space than the new bytes need. The rejection carries the
   `full` kind (R220), the file's bytes are byte-identical to before, and no `open` was attempted.
   Seen red against today's `writeFile` first, with the red output quoted in Results.
2. **A failing `statfs` does not block a save**: with `statfs` faked to throw, the write proceeds
   and the bytes are exact.
3. **The boundary is exact**: free space exactly equal to `newSize − currentSize` saves, and one
   byte less refuses. A new file (no current size) needs the whole `newSize`.
4. **A hidden file saves on Windows.** In `test/mainDocuments.test.ts`, `runIf(win32)`: create a
   file, set the hidden attribute with Windows' own `attrib +h` (Node has no API for it), save, and the bytes are exact **and the file is still hidden**. Seen red against today's
   `writeFile` first (`EPERM`, as measured in §1).
5. **The file object is kept**, on the real filesystem in `test/mainDocuments.test.ts`:
   - **Mode bits on POSIX** (create `0o640`, save, `stat` still says `0o640`).
   - **The inode or file ID** is unchanged (`stat(..., { bigint: true }).ino`, which is the file
     ID on Windows).
   - **A hard-linked file keeps its link** (`nlink` stays 2, and both names read the new bytes).
   - **A symlink stays a symlink** and its target holds the new bytes. Run where the OS allows
     creating one, and skipped with a reason on Windows without developer mode.
   - **An alternate data stream survives** on Windows (`path:stream` written before, read after).
6. **The existing `writeDocument` tests pass unmodified**: exact bytes, overwrite rather than
   append, a missing folder tagged `missing`, and **a file another program holds tagged `locked`
   and left untouched**. The last one is what proves the `r+` open fails before any truncation.
7. **A shorter save leaves no old tail**: save 10 bytes over a 1,000-byte file, and the file is
   exactly the 10 bytes. Mutation: dropping the `ftruncate` turns it red.
8. **The flush happens**: with `fs` faked, `fsync` is called on the written handle before `close`,
   and a failing `fsync` rejects the save. Mutation: removing the `fsync` turns it red.
9. **The handle is closed on every failure path**: a write faked to fail part-way still closes the
   descriptor (count opens and closes in the fake).
10. **R175 still holds**: a save does not raise the external-change banner on any of the three
    runners. This is `mainElectron.test.ts`'s existing self-write test, passing unmodified.
11. **Cost**: §1's flush cost is measured on the 200 MB fixture and both numbers go in Results.
12. `DECISIONS.md` records in-place over rename and over a backup copy, with §1's editor survey as
    the evidence and the residual case (a crash or dropped share mid-write) stated as accepted.
    Invariant 6's wording in `CLAUDE.md` needs no change, and Results says it was checked.

### R236

13. **New test in `mainElectron.test.ts`**: watch a file, replace it by rename-over, wait for the
    change; then **write the file in place, and wait for a second change.** Run on all three CI
    runners before the fix, and quote each runner's result in Results.
14. Also: replace by rename-over **twice**, each change noticed. Delete and recreate the file, and the
    recreate is noticed.
15. With the fix (if needed), 13 and 14 pass on all three runners. The existing atomic-save, R171 and
    R175 tests pass unmodified.
16. `test/documentWatchers.test.ts`: two keys on two files in one directory produce **one** directory
    watch, and unwatching both closes it. Mutation: a per-file watch makes this red.

### R238

17. `test/documentWatchers.test.ts`, with a `stat` held on a deferred promise:
    - `watch('k', p)`, then `unwatch('k')`, then release the stat → no OS watch is open and
      a later change to `p` is not delivered to `k`.
    - `watch('k', p1)`, `watch('k', p2)`, release both stats in reverse order → only `p2` is watched.
    - Mutation: removing the generation check turns both red.

## 5. Not in scope

- **A backup copy, and saving by rename**: decided against in §1.
- **Write retries** (VS Code retries three times). A retry after a partial write rewrites a file
  that is already truncated, which changes nothing about the risk. Recorded if a transient failure
  is ever observed.
- Watching for *renames of the open file* to follow it to its new name. A file moved away is
  reported as gone, as today.

## 6. Results

Landed on branch `r236-save-and-watch` in this order: R237, R236's measurement, R238, then R236's fix.

### 6.1 R237 — in place, with a free-space check and a flush

Built as §1 describes:
- `statfs` on the folder;
- `r+`, falling back to `w` only on `ENOENT`;
- `ftruncate(0)`, the write and `fsync`;
- a close on every path.

Two details the plan left open:
- **Symlinks are resolved before the `statfs`**, so the volume asked is the one the bytes land on.
- **A file whose size cannot be read counts as empty.** That only makes the check stricter.

The file system calls are injected (`WriteDocumentFs`). The fakes wrap the real file system, so
every test still writes a real file and reads it back.

**Red first, against `writeFile`** (Windows 11, Node 24.15.0). Ten of the sixteen new tests failed,
among them:
```
× refuses a save the disk has no room for, with the full kind, before opening the file
  Error: expected a rejection
× saves a hidden file on Windows, and it stays hidden
  Error: [klados-file-error:denied] EPERM: operation not permitted, open '…\doc.json'
× keeps an alternate data stream on Windows
  Error: ENOENT: no such file or directory, open '…\doc.json:klados-test'
```
The plan did not predict the third failure. `CREATE_ALWAYS` **deletes a file's alternate data
streams**, so every save before R237 stripped them silently.

| # | Criterion | Result |
|---|---|---|
| 1 | Full disk refuses with `full`, bytes unchanged, no `open` | Pass. Red first (above) |
| 2 | Failing `statfs` does not block | Pass |
| 3 | Boundary exact; a new file needs the whole size | Pass. Mutations each red: `>=` for `>`, and ignoring the current size |
| 4 | Hidden file saves on Windows and stays hidden | Pass. Red first (`EPERM`) |
| 5 | Mode bits, file ID, hard link, symlink, ADS kept | Pass. Mode bits and symlink run on Linux and macOS CI. The symlink test skips, with the reason, on Windows without developer mode |
| 6 | Existing `writeDocument` tests unmodified | Pass, including the held-file test: tagged `locked`, file left untouched |
| 7 | Shorter save leaves no tail | Pass. Mutation red: dropping `truncate` |
| 8 | Flush before close; failing flush rejects | Pass. Mutation red: dropping `sync` |
| 9 | Handle closed on every failure path | Pass. Mutation red: rethrowing before the close |
| 10 | R175 self-write test unmodified on three runners | Pass |
| 11 | Flush cost on the 200 MB fixture | See the cost table below |
| 12 | `DECISIONS.md`; invariant 6 checked | D-119. Invariant 6 says what is written, not how, so its wording needs no change |

**A test the plan did not list.** It was added because a mutation survived without it. Falling back
to `w` on **any** open error, not only `ENOENT`, passed every other test, because a held file refuses
`w` too. A new test fakes an open where only `r+` fails (`EACCES`). It shows that this fallback would
truncate the very file `r+` was refused.

**Cost (criterion 11).** Measured on `spike/fixtures/cars-200mb.xml` (209,715,235 bytes) on the
development machine's SSD. Medians of five runs:

| | ms |
|---|---|
| `writeFile` (before) | 140 |
| in place, one `write` call, no flush | 566 |
| in place, 4 MiB pieces, no flush | 108 |
| in place, 4 MiB pieces, flush (**shipped**) | 580 |

- **The flush adds ~470 ms.** That is under the 1 s threshold, so it was not referred back.
- **Unplanned finding (second row):** a single `write` call for a whole 200 MB buffer is 4× slower
  than `writeFile`, which writes in pieces itself.
- **Piece size**, same file:

  | Piece | ms |
  |---|---|
  | 1 MiB | 120 |
  | 2 MiB | 110 |
  | 4 MiB | 106 |
  | 8 MiB | 106 |
  | 16 MiB | 104 |
  | 32 MiB | **338** |

  4 MiB sits on the flat part, well clear of the cliff. It is `WRITE_CHUNK_BYTES`. A test checks that
  no call exceeds it, and goes red when the cap is removed.

### 6.2 R236 — measured red on Linux and macOS, then fixed there

**Before any change.** These are the three new built-app tests, on PR #62's first CI run (commit
"R236: … (measurement)"):

| Runner | after a rename-over, an in-place write | two rename-overs | delete, then recreate |
|---|---|---|---|
| `ubuntu-latest` | **× 15521 ms** | **× 15536 ms** | **× 15010 ms** |
| `macos-latest` | **× 15529 ms** | **× 15571 ms** | **× 15049 ms** |
| `windows-latest` | ✓ | ✓ | ✓ |

Every other test passed on all three runners, the existing one-rename atomic-save test included. That
is the gap: one replacement is noticed, and nothing after it. Locally, a watch made to close on its
first `rename` event turned the three tests red, while the atomic-save test stayed green.

**Departure: Windows keeps the file watch.** §2 asked for the directory watch "on every platform".
It was probed on Windows before shipping:
- **A directory watch whose directory is deleted never stops firing there.** It sends an unbroken
  stream of `rename` events naming the directory itself, and no error. With the directory watch
  forced on, the guard test below counted 539 events in 300 ms. That is a busy loop in the main
  process, which R171 §6 forbids.
- **A file watch on Windows reports the same deletion once**, as `EPERM`. Under the directory watch,
  R171's three Windows-only tests went red for exactly this reason.
- **Windows does not need the change.** libuv's file watch there already watches the parent and
  filters by name, which is why it was green above.

Recorded as D-120.

**Where it lives: `fsWatcherDeps.ts`, not the registry.** The registry keeps its per-file
`DocumentWatcherDeps` contract, so its R52, R171 and R175 unit tests are unmodified. Sharing a
directory watch is the platform layer's job. Criterion 16's test is therefore in
`test/fsWatcherDeps.test.ts`, against an injected directory watcher.

| # | Criterion | Result |
|---|---|---|
| 13 | Rename-over, then in-place write, noticed; run before the fix | Red on Linux and macOS before the fix (above) |
| 14 | Two rename-overs; delete and recreate | As 13 |
| 15 | 13 and 14 pass with the fix on all three; atomic-save, R171, R175 unmodified | Pass on CI. Also run locally with the directory watch forced on Windows: all 14 built-app tests pass, so the directory code runs end to end on this machine as well |
| 16 | Two files in one directory share one watch, closed with the last | Pass. Mutation red: one directory watch per file |

**Also tested:**
- An event reaches only the file it names, compared without case, or every file when it names none.
  Mutations each red: no filter, a case-sensitive compare.
- A failed directory watch is reported to every file in it, and the next watch opens a new one.
- A failure during construction is still reported.
- A stale handle cannot close its replacement.
- **A real-filesystem guard** on Linux and macOS: deleting a watched directory produces fewer than
  20 events in 300 ms. With the directory watch forced on, it is red on Windows (539).

### 6.3 R238 — a per-key generation

Built as §3 describes. Both criterion 17 tests were red before the fix ("expected [ … ] to have a
length of +0 but got 1").

**Extended to `unwatchMatching`**, which a closing window calls. It had the same hole for a tab still
opening, because that tab's key is not registered yet. It now bumps every matching key ever watched.

**Generations are never deleted.** A deleted one would restart at 1 and match a stale `watch` still
holding 1.

Mutations, each red:
- no generation check: three tests;
- `unwatch` not bumping the generation: one test;
- `unwatchMatching` over registered keys only: one test.

### 6.4 Review

Each R id's `git diff` was read before its commit:
- **R237:**
  - Two stale comments still described `writeFile`; one was `fileErrors.ts`'s `missing` case. Fixed.
  - The `stat` fallback's strictness was not written down. Fixed.
  - The surviving `w`-fallback mutation (above) came from the mutation pass, not the review.
- **R236:** the comment on `handle: null` claimed the error callback can fire during construction.
  Had it done so, the code would have attached the listener to a dead entry. The case is now handled
  and tested.
- **R238:** nothing found.
