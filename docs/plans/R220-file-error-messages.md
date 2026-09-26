# R220 — file errors in words, not in Node's and Electron's

<!-- status: open -->

**Open.** Raised by the project lead after a launch showed, as the whole error banner:

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
| IPC: `document:write` (save, save as) | `save.ts:56` → `Couldn't save: …` (`TabStrip/commands.ts:90`) and the notifications | the same shape, from `writeFile` |
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
| `locked` | `EBUSY` | *probe.json is in use by another program.* | *probe.json is in use by another program.* |
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
