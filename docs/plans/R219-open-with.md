# R219 — Klados in the operating system's "Open with"

<!-- status: built-caveat -->

**Built, with a caveat.** Klados is offered in "Open with" on all three platforms and opens the file
it is launched with, into a new tab or by focusing the tab that already holds it. Verified end to
end on Windows by installing and uninstalling the real installer; **macOS and Linux are verified
only as configuration** — this machine cannot build their packages, and whether Finder and a Linux
file manager list Klados is owed (`docs/TASKS.md`). **The Windows half landed differently from this
plan**, twice, each time on a measurement and a decision by the project lead: see § 2's corrections
and § 8.

Raised by the project lead: *"When installing Klados on a machine, it doesn't automatically
associate itself with supported file extensions. I think that is ok, I don't want to be too
intrusive. But e.g. on Windows, when I right-click an XML file, I can select 'open with' and it
would be great if Klados would show up there."* And, on defaults: *"If a default was never picked
for xml, then using Klados there is maybe not a problem. But we shouldn't overwrite existing
defaults the user might have picked already."*

Two halves, and the second is not optional: **announcing the file types** to each operating system,
and **Klados opening the file it is launched with** — before this round it ignored anything it was
handed, so a menu entry alone would have opened an empty window.

## 1. What was there

Nothing, deliberately. `docs/plans/R164-release-security-hardening.md` §1 recorded it as a security
property: *"No OS-shell entry point. No `fileAssociations`/`protocols` in `electron-builder.yml`, no
`open-file`/`second-instance` handler, and `process.argv` is never read in `src/main`"* — a file
entered only through the Open dialog or drag-and-drop. This round changes that property on purpose;
§ 6, and a note in place in R164, record why it stays acceptable.

## 2. Announcing the file types

**Electron has no runtime API for file types** — `app.setAsDefaultProtocolClient` is for URL
schemes. Declaring them is an install-time concern, and electron-builder's `fileAssociations` is the
cross-platform form: one list becomes Windows registry entries (`NsisTarget.js:630-661`,
`templates/nsis/include/FileAssociation.nsh`), macOS `CFBundleDocumentTypes`
(`electronMac.js:160-180`) and a Linux `MimeType=` line (`LinuxTargetHelper.js`).

*Planned:* one top-level `fileAssociations` list for all three. *Landed:* **a platform-level list
per platform** — `mac.fileAssociations`, `linux.mimeTypes`, and a Windows installer script — because
electron-builder's Windows and Linux handling both do more than "Open with" (below). Three lists
where one was planned, so **`test/fileAssociations.test.ts` holds all three to the format modules'
own extensions**: `.xml`, `.json`, `.toml`, `.csv`, `.tsv`, `.tab` (`supportedExtensionsList()`). A
format gaining an extension fails that test until every platform offers it.

### Windows

*Planned:* electron-builder's `APP_ASSOCIATE`, relying on `UserChoice` to protect an explicit
choice, plus a `customUnInstall` fix for its uninstall.

*Corrected before building, on a measurement.* `APP_ASSOCIATE` (`FileAssociation.nsh:61-69`) also
writes each extension's own default value, and a per-user default outranks whatever an extension
falls back to when nobody chose. On this machine `.json`, `.toml` and `.csv` opened in VS Code with
no `UserChoice` at all — VS Code was simply the only registered app — and all three would have
switched to Klados. The project lead: register for "Open with" only. So **`assets/build/installer.nsh`
registers Klados itself**, writing what VS Code's own per-user install writes: a class `Klados.<ext>`
with its open command, and that class's name in the extension's `OpenWithProgids`. Never the
extension's default value, never `UserChoice`. Its uninstall deletes exactly Klados's value and class
and **no key** — `DeleteRegKey /ifempty` checks subkeys only, not values, so on `OpenWithProgids` it
would delete every other application's entry too. The planned uninstall fix became unnecessary: there
is no default value to leave dangling.

*Corrected again, by installing it.* "Open with" only is **not** "never changes double-click".
Windows chooses among an extension's `OpenWithProgids` when nobody chose, so joining that list alone
changed `.json` from VS Code to Klados — confirmed with a real `ShellExecute`, not only
`AssocQueryString` — and `.tsv`/`.tab` from "choose an app" to Klados. An explicit choice survived
(`.xml` stayed Edge). The alternative that never touches double-click was measured too:
`Applications\Klados.exe\SupportedTypes` left `.toml` opening in VS Code, but Klados then appears in
the submenu only after being picked once through "Choose another app". Put to the project lead with
both measured, who chose the submenu: **`OpenWithProgids`, as built** — the usual Windows
convention, and where nobody chose, Klados may become what a double-click opens.

**The file icon.** A registered type's icon is what Explorer shows wherever Klados is the default,
and it had been `Klados.exe,0` — the dark app tile, which down a file list reads as a column of
program shortcuts. The project lead asked for a lighter one; three were rendered in a mock Explorer
(the tile, the bare mark, a page with the mark) and **a page with the mark** chosen, then its 16px
frame redrawn sharper and larger (four candidates rendered with resvg at 1× and 8×). It is
`assets/document-16.svg` (16, 24, 32px — a 1px outline on half-pixel coordinates and a 2px stem,
sharp at 16 and doubled at 32) and `assets/document.svg` (48px up), generated into
`assets/build/document.ico` by `tools/generate.py` and shipped by `win.extraResources`. The mark is
`#A9701E`: the brand amber is 2.15:1 on a white page (`assets/README.md`'s own table).

### macOS

`mac.fileAssociations` at **`rank: Alternate`** — offered in Finder's "Open With", never a candidate
for the default. At `Default`, where nobody chose, LaunchServices picks among the apps claiming a type
unpredictably, so a fresh Mac's `.json` could flip to Klados without anyone deciding it. `role:
Editor`, since Klados saves. Declared by extension (`CFBundleTypeExtensions`), which is how
electron-builder writes it; `.toml` has no system type identifier anyway. No document icon: at
`Alternate` Klados is never a default, so it would never be shown.

### Linux

`linux.mimeTypes` — only the `.desktop` file's `MimeType=` line, which never sets a default
(defaults live in `mimeapps.list`). *Not* `mimeType` on a file association: electron-builder turns
that into a MIME definition file (`computeMimeTypeFiles`) that redefines `application/xml` and the
others system-wide with its own icon and comment. `.tab` has no registered MIME type and so no line.
Effective for the `.deb`; **the AppImage has no install step**, and integrates only through a tool
such as AppImageLauncher.

## 3. Opening the file Klados is launched with — main process

- **Windows and Linux:** the path is a command-line argument — the registered command is
  `"…\Klados.exe" "%1"`. **macOS:** an `open-file` event, registered at module load since it fires
  before `ready`.
- **Reading the arguments defensively** (`src/core/launchPaths.ts`, pure, tested): skip the
  executable; under `electron .` (`process.defaultApp`) skip the app path too — **the first non-switch
  argument, not `argv[1]`**, because `second-instance` delivers the second process's command line
  with Chromium's switches moved to the front (measured:
  `[electron, --user-data-dir=…, --allow-file-access-from-files, app, file]`), which the first version
  missed and the end-to-end test caught by opening `out/main/index.js` as a document; skip every
  argument starting with `-`; resolve against the *launching* process's working directory; keep only
  what `stat` says is a regular file.
- **One instance.** `app.requestSingleInstanceLock()`; a second launch hands its arguments to the
  first through `second-instance` and quits, and the running window restores and comes forward. The
  lock is per `userData` directory, so test harnesses with their own `--user-data-dir` are separate
  instances. **Not taken under the development server**: `npm run dev` shares `userData` with an
  installed Klados and would otherwise hand its launch to that one and quit.
- **Handing paths to the window.** Main queues paths until the renderer takes them once at startup
  (`app:takeLaunchPaths`); later ones are pushed (`app:openPaths`). The renderer opens each through
  the existing read-token path — **the security model of reads is unchanged**.

## 4. Opening them — renderer

- **Before the first render.** `main.tsx` takes the launch paths before `beginSessionRestore()` and
  the first render, so a launched file does not leave the lazily-created empty tab beside it. One IPC
  round trip on every launch, answering from a queue main already holds.
- **Into a new tab, made active** — drag-and-drop's and `klados.document.open`'s rule (R26).
- **A file already open is focused, not opened twice** (`session/openFromSystem.ts`), compared
  case-insensitively on Windows and macOS. The common case is double-clicking a file that was open
  last time, and **its restored tab is still `empty` when the launch paths are matched** — session
  restore has called `openPath`, but its `stat` has not returned, and a tab exposes no path before
  `ready`. The first version skipped `empty` tabs and so opened that file twice; its unit test caught
  it. Now the path each tab is opening is kept **while the open is in flight** and dropped once it
  settles: `ready` (the document answers from then on, following a Save As), failed, or cancelled back
  to `empty`.

## 5. Not in this round

- **Becoming the default, or asking to.** No "make Klados the default" command.
- **Deduplicating drag-and-drop and Ctrl+O.** They still open a second tab of an open file, as they
  did before.
- **More extensions** (`.xsd`, `.svg`, `.jsonc`, …), and **URL protocols** (`klados://`).

## 6. Security

A double-click becomes a way in, and R164 §1 carries a note in place. What keeps it acceptable: the
launch is user-initiated; only existing regular files are taken, never a switch, and a shell-supplied
path is absolute; the path goes through the same `stat`, size caps, read token and hardened parsers as
the Open dialog; the registered command quotes `"%1"`; no protocol is registered.

## 7. Verification, as planned

Unit tests for the argument parser, the extension lists and the renderer's open-or-focus logic; the
built app launched with files; and on Windows, install, inspect, launch and uninstall, comparing each
extension's effective handler before and after. macOS and Linux at build level only.

## 8. Results

### Windows, end to end on this machine

Each extension's per-user registry values, `UserChoice`, `Klados.*` classes and effective handler
(`AssocQueryString`) recorded before installing, after installing, and after uninstalling; the
"Open with" list read through `SHAssocEnumHandlers`, the API behind the submenu; the icon read back
through `IShellItemImageFactory`, the API Explorer draws with.

| Extension | Before | Installed | Uninstalled |
|---|---|---|---|
| `.xml` | Edge (explicit `UserChoice`) | Edge | see below |
| `.json` | VS Code (no choice) | **Klados** — confirmed by `ShellExecute` | VS Code |
| `.toml` | VS Code (no choice) | "choose an app" | VS Code |
| `.csv` | VS Code (no choice) | VS Code | VS Code |
| `.tsv`, `.tab` | "choose an app" | **Klados** | "choose an app" |

- **Klados is in "Open with" for all six**, recommended, beside the apps already there.
- **The explicit choice survived the install.** Between the install and the uninstall, `.xml`'s
  Windows 11 `UserChoiceLatest` changed to VS Code, and the uninstall did not revert it. Its key was
  written at 21:03:14 and `.xml`'s recent-apps list at 21:02:55, nineteen seconds apart and minutes
  before the uninstall ran — the shape of "Open with → VS Code → Always" chosen in Explorer.
  Nothing Klados ships can write that key (it is hash-protected), and nothing in this round opened an
  `.xml` file. Recorded as observed, not as a Klados effect.
- **Uninstall leaves no Klados value or class.** One difference remains by design: `.tab` had no key
  before, and keeps an empty `OpenWithProgids` key — deleting keys is what § 2 rules out.
- **The icon**: Windows returns the document icon for a `.json` file at 16, 32, 48 and 256px.
- The installed command opens a file: `ShellExecute` of a `.json` file started the installed Klados.

### Tests

- `test/launchPaths.test.ts` — 8: executable and app path skipped, the app path found after the
  switches of a second instance's `argv`, switches skipped even when one names a file, relative paths
  resolved against the launching directory, non-files dropped, order kept and repeats dropped.
- `test/openFromSystem.test.tsx` — 7: new active tabs; a `ready` tab focused; a restored tab matched
  while still `empty` and while `parsing`; a failed and a cancelled open not reused; case-insensitive
  on Windows, exact on Linux. Removing the forget-on-cancel rule turns the cancelled case red.
- `test/fileAssociations.test.ts` — 7: the three platform lists against the formats, rank `Alternate`
  only, no top-level list, no Linux MIME definition, every Windows type registered and removed, **no
  extension default or `UserChoice` written** (checked to fail on the exact line `APP_ASSOCIATE`
  writes), and `document.ico` shipped with all seven frames.
- `test/openWithElectron.test.ts` — 4, the built app: launched with a file, one tab and no empty one;
  a second launch hands its file over and exits 0; a second launch with an open file focuses it; a
  relaunch whose file the restored session holds gives one tab.
- `test/mainElectron.test.ts`'s preload-surface test lists the two new `app` functions.

### Owed

macOS and Linux, on real machines: whether Finder lists Klados under "Open With" for the six types,
and whether a Linux file manager does for the `.deb`. Short of that, `Info.plist`'s
`CFBundleDocumentTypes` and the `.desktop` file's `MimeType=` can be read out of the artifacts the
next release rehearsal builds.

### Review

Read from `git diff` before committing.

- **Found and fixed:** `main/index.ts` sent the reader to "that plan's §6" right after naming R164, so
  it read as R164's §6 — it meant this one's. `sessionRestore.ts` said restored tabs are matched
  "while still parsing", when the case that matters is before their `stat` returns.
  `assets/README.md` still listed file-type icons as to do, and did not know the new sources.
- **Found and fixed while building:** a YAML comment lost two backslashes to shell quoting, one
  becoming a carriage return inside the line — found by reading the bytes, since it rendered as
  plain text.
- **Found and fixed while testing, recorded above:** the first-non-switch rule, and matching restored
  tabs while `empty`.
- **Also recorded, not a Klados defect:** `.xml`'s Windows 11 `UserChoiceLatest` changed during the
  round, by what its timestamps show to be a choice made in Explorer (§ 8).
- Invariants: nothing format-specific above `src/formats/` (the extension list comes from the
  registry); no literal colours in components (the icon colours live in asset SVGs, as the app icon's
  do).
