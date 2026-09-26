# R220 — file errors in words, not in Node's and Electron's

<!-- status: built -->

**Built** — see § 6 for what landed, including two places it differs from this plan: a failed Save
or Save As used to show nothing at all (§ 1's table assumed a notification), and the lock wording
changed to name the action. Raised by the project lead after a launch showed, as the whole error
banner:

> Error invoking remote method 'document:stat': Error: ENOENT: no such file or directory, stat
> 'C:\Users\chris\AppData\Local\Temp\r219-probe\probe.json'

*"It's ok to open Klados with a file that doesn't exist anymore. But that error message reads not
very user friendly."* The file was a leftover of R219's own Windows verification (§ 7), which
launched the installed Klados on a temporary file and so put it in the real profile's session; the
message is the defect, and it is not specific to that file.

## 1. What happens today — verified, not assumed

Every failure on the way to or from the file system reaches the user as raw text, through three
different routes:

| Route | Where | What the user reads |
|---|---|---|
| IPC: `document:stat` (open, reopen, reload) | `documentSession.ts:602` `describeError` → the error banner (`DocumentArea.tsx:237`) | `Error invoking remote method 'document:stat': Error: ENOENT: no such file or directory, stat '…'` |
| IPC: `document:write` (save, save as) | `save.ts:56` → `Couldn't save: …` (`TabStrip/commands.ts:90`) and the notifications | the same shape, from `writeFile` — **only when saving from the close prompt; plain Save and Save As showed nothing** (§ 6) |
| The read itself: the worker fetches the file through Klados's read-token protocol | `readTokenProtocol.ts:31,37` answers `404` for any failure; `parse.worker.ts:375-380` | `Could not read the document (HTTP 404)` — the same for a locked file, a missing one, and one without permission |

**The error's code does not survive IPC.** Measured with a real `ipcMain.handle` throwing
`fs.stat`'s `ENOENT`: the renderer's error has `name: "Error"`, **no `code`, no `errno`, no own
properties**, and only the message — prefixed by Electron with `Error invoking remote method
'<channel>': `. Electron documents this ("only the `message` property from the original error is
provided"). So **the renderer cannot classify an error today**, and parsing Node's wording out of a
message behind Electron's wording is exactly the fragility to avoid. The classification has to happen
where the code still exists: in the main process, and in the protocol handler.

## 2. The messages

The file's **name** leads; the full path is a second, quieter line, so the reader still sees which
folder was meant without a 90-character path in the sentence.

| Kind | Node codes | Opening / reopening | Saving |
|---|---|---|---|
| `missing` | `ENOENT`, `ENOTDIR` | *probe.json can't be opened: it no longer exists.* | *probe.json can't be saved: its folder no longer exists.* |
| `denied` | `EACCES`, `EPERM` | *Klados isn't allowed to open probe.json.* | *Klados isn't allowed to save probe.json.* |
| `folder` | `EISDIR` | *probe.json is a folder, not a file.* | *probe.json is a folder, not a file.* |
| `locked` | `EBUSY` | ~~*probe.json is in use by another program.*~~ *probe.json can't be opened: another program is using it.* | ~~*probe.json is in use by another program.*~~ *probe.json can't be saved: another program is using it.* |
| `full` | `ENOSPC`, `EDQUOT` | — | *probe.json can't be saved: the disk is full.* |
| `readOnlyDisk` | `EROFS` | — | *probe.json can't be saved: the drive is read-only.* |
| `other` | anything else | *probe.json can't be opened:* + the system's own message, without Electron's prefix | *probe.json can't be saved:* + the same |

- **`locked` needs measuring, not assuming.** On Windows a file another program holds without
  sharing (Excel does this to a CSV) should fail `open` with `EBUSY` — libuv maps
  `ERROR_SHARING_VIOLATION` to it. The round confirms it with a real exclusively held file before
  the message ships; if Windows reports something else, the table follows the measurement.
- **`missing` on save** is a vanished folder, since `writeFile` creates a missing file.
- Wording is a draft for the project lead; the table is the place to change it.

**Rendered before settled** (`PLANNING.md` §1): the banner with its two lines — name sentence, path
line — in both themes, with a long path, before the layout is written down as final.

## 3. The mechanism

- **`src/core/fileErrors.ts`**, imported by main and renderer: `classifyFileError(err)` → a kind
  from the code; an **encoding** for crossing IPC; `fileErrorFrom(err)`, which decodes it
  **wherever it sits in the message** — before or after Electron's prefix, which is therefore never
  parsed; and `describeFileError(kind, action, path)` for the words.
- **Main:** the `document:stat` and `document:write` handlers catch, classify and rethrow an `Error`
  whose message is the encoding plus the original message as detail.
- **The read protocol:** `handleReadTokenRequest` opens the file before answering and, on failure,
  answers with a status per kind and the kind in a header; `runParseFromUrlJob` turns that into the
  same encoding. A stream that fails after the response began still arrives as an ordinary fetch
  failure and falls to `other`.
- **Renderer:** `describeError` in `documentSession.ts` and `save.ts` goes through `fileErrorFrom`,
  so every banner and notification that shows one of these errors gets the words. The banner renders
  the second line.

**Rejected: typed results instead of throwing** (`stat` returning `{ ok: false, kind }`). The more
explicit shape, but it changes `KladosApi`'s signatures, and **31 test files fake `stat` and 28 fake
`write`** — every one would change for no behaviour. With the encoding, the API is unchanged, a fake
that rejects with a plain `Error` still produces a readable `other` message, and the one real risk —
the encoding not surviving real IPC — is covered by a test against the built app.

**Rejected: parsing Node's messages in the renderer** (`/ENOENT/`). Works today and ties the user's
text to two libraries' wording.

## 4. Not in this round

- **Keeping or dropping a restored tab whose file is gone.** The project lead: opening Klados with a
  missing file is fine. The tab shows the message; closing it drops the file from the session, as
  now.
- **Messages from parsing** (malformed content) — those are diagnostics with their own wording.

## 5. Verification

- Unit: every code in § 2's table classified, encoded and decoded, including with Electron's prefix
  in front; `describeFileError` for every kind and action; an unknown code falls to `other` with the
  system's message and no prefix.
- The protocol handler: missing, denied and locked files answered with their kind.
- **Built app:** a real `document:stat` of a missing file, through real IPC, produces the `missing`
  message — the check that the encoding survives what the probe in § 1 showed IPC does to errors.
- **Windows, measured:** a file held open without sharing, read and saved — `locked`, or whatever it
  turns out to be.
- The banner rendered in both themes.

## 6. Results

**Built.** Every file system failure on the three routes now reaches the user as a sentence that leads
with the file's name. The banner shows the path on a line of its own. The report that raised the round
is covered by a test against the built app: a restored file that no longer exists shows
*probe.json can't be opened: it no longer exists.* above its path.

### Measured before the messages shipped

On Windows, with a file held open without sharing by a second process (PowerShell's
`[IO.File]::Open(…, 'None')`, as Excel holds a CSV), and with a folder and missing paths:

| | `stat` | `open` | read stream | `writeFile` |
|---|---|---|---|---|
| locked file | ok | `EBUSY` | `EBUSY` | `EBUSY`, contents untouched |
| folder | ok | **ok** | `EISDIR` | `EISDIR` |
| missing file | `ENOENT` | `ENOENT` | `ENOENT` | — (creates it) |
| missing folder | `ENOENT` | `ENOENT` | `ENOENT` | `ENOENT` |

- **`locked` is `EBUSY`**, as § 2 expected, but **`stat` succeeds**, so a locked file gets past
  `document:stat` and fails only when read. That makes the read protocol the route that has to report it.
- **Windows opens a folder without complaint.** "Open before answering" alone would not have caught a
  folder, so both `statDocument` and the protocol handler ask `isDirectory()`.

### What landed

- `src/core/fileErrors.ts`: the classification (§ 2's codes), the tag `[klados-file-error:<kind>]`
  written in front of the system's message, `fileErrorFrom` (finds the tag wherever it sits),
  `describeFileError` (the words), and `folderError`. No Node or DOM import, so main, worker and
  renderer share it.
- **Main:** `statDocument` and `writeDocument` (`core/mainDocumentIO.ts`) tag their own
  rejections, so both IPC handlers carry the kind without a change in `main/documents.ts`.
  `statDocument` refuses a folder.
- **The read protocol** opens a handle, refuses a folder, and streams from that same handle. On failure
  it answers with a status per kind (404, 403, 409, 423, 500) and **the tagged message as the body**.
  § 3 said "a header"; the body was chosen instead because the worker's `fetch` is cross-origin, and a
  custom header is invisible to it without `Access-Control-Expose-Headers`, while the body is
  already read. The worker passes a tagged body on as its error message; a refused token keeps
  *Could not read the document (HTTP 404)*.
- **Renderer:** open, reopen and restore failures (`documentSession.ts`'s `openFailure`) put the
  sentence and the path in the error phase; the banner renders the path as a second line. A reload
  that fails on the file says so with the action **reload**, a column § 2 did not have. A save failure
  is a sentence naming the file in every case, tagged or not.
- **Save and Save As report failure** (`session/commands.ts`). § 1's table assumed a notification;
  in fact both commands discarded their outcome (`void ctx.session.save()`), so a failed save
  looked like a successful one apart from the dirty mark staying. The close prompt's save was the only
  one that reported, prefixed *Couldn't save:*. That prefix is gone, because the message now names the
  failure itself.

### The wording, as landed

| Kind | Open | Reload | Save |
|---|---|---|---|
| `missing` | *probe.json can't be opened: it no longer exists.* | *…can't be reloaded: it no longer exists.* | *…can't be saved: its folder no longer exists.* |
| `denied` | *Klados isn't allowed to open probe.json.* | *…to reload probe.json.* | *…to save probe.json.* |
| `folder` | *probe.json is a folder, not a file.* | same | same |
| `locked` | *probe.json can't be opened: another program is using it.* | *…can't be reloaded: …* | *…can't be saved: …* |
| `full` / `readOnlyDisk` | — | — | *…can't be saved: the disk is full.* / *…: the drive is read-only.* |
| `other` | *probe.json can't be opened:* + the system's message | same shape | same shape |

**`locked` changed from the plan's** *probe.json is in use by another program.* That sentence does
not say what failed, and in a save notification it reads as information rather than as a failed save.
This is a draft for the project lead, like the rest of the table.

### The banner, rendered

Rendered in both themes with a 120-character path before settling. Two findings changed the CSS:
- **A monospace path read louder than the sentence** above it: same size, wider and heavier. It uses
  the UI font.
- **Fading the path could not stay readable.** The banner's colours give 5.2:1 (light) and 5.3:1
  (dark). The path at 75% opacity measured 3.5:1 and 3.6:1, and at 85% 4.1:1 and 4.3:1, all under
  4.5:1 for text this size. So the sentence leads by weight (semibold) and the path keeps the full
  colour. A long path wraps inside the banner (`overflow-wrap: anywhere`).

### Verification

- `test/fileErrors.test.ts`: every code classified, tagged and found again, bare and behind Electron's
  prefix; every kind and action's words exactly; untagged errors stay untagged.
- `test/mainDocuments.test.ts`:
  - `stat` tags a missing file and refuses a folder.
  - `writeFile` tags a vanished folder, and a locked file (Windows), leaving it untouched.
  - The protocol answers missing (404), folder (409), denied (403, POSIX, skipped as root) and locked
    (423, Windows) with the kind in the body.
- `test/parseWorker.test.ts`: a tagged body becomes the message; an untagged 404 keeps its words.
- `test/documentSession.test.ts`: a missing file over IPC, a locked read, an untagged error that keeps
  its words, and a reload that fails on the file. `test/save.test.ts` covers tagged and untagged save
  failures; `test/saveFailureNotice.test.ts` covers Save and Save As notifying, and staying silent on
  success and on a closed dialog. The last one was checked to fail against the old command.
- **Built app** (`test/fileErrorsElectron.test.ts`):
  - A restored file that no longer exists shows the sentence and the path, through real IPC.
  - On Windows, a file held by another program shows the locked sentence, through the real read
    protocol.
  - The first version closed the app as soon as the tab showed the file's name. The tab shows the name
    while the file is still opening, and the session records a tab only once it is ready, so the
    relaunch restored nothing. It now waits for the tree.
- Not run locally: the browser project, whose headless Chromium for the installed Playwright is not
  downloaded on this machine. CI runs it.

### Review

Read as a diff after the tests passed. Findings, all fixed before the commit:
- **Backticks lost from comments.** A PowerShell here-string ate the backticks in code spans in
  three source files, and turned one into a form feed, which ESLint caught as irregular whitespace.
- **One helper written twice.** The file-holding test helper existed in two test files; it now lives
  in `test/support/holdWithoutSharing.ts`.
- **Checked and fine:**
  - The protocol's error body carries the path. It answers only a minted, single-use token for a path
    the user chose, and an unknown token still gets a bare 404, so it is not a path oracle.
  - A dropped link cannot reach `stat` with `''` (`dropGuard.ts` returns first). A dropped
    folder now reads *‹name› is a folder, not a file.* instead of *HTTP 404*.
  - The worker reads a response as text only when it is not ok: a short error body, never the document
    (invariant 1).
