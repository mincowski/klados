# R236–R238 — Save stops failing blind, the watcher follows the path, and a watch race

<!-- status: open -->

**Open.** Planned from the review of 2026-10-16, and rescoped by the project lead on 2026-10-17:
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
