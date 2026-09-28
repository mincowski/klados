# R221 — Electron 39 to 44

<!-- status: built-caveat -->

**Built, with checks owed to a person** (§ 7): dragging a file from Explorer, Snap Layouts, and
anything on a real Mac or Linux desktop. The installer upgrade was verified after R222. Raised by the
investigation of the two open Dependabot alerts after 1.2.0 shipped. It is meant to ship as **1.2.1**,
as decided by the project lead. Testing it found a defect that predates it: copying to the clipboard
has been refused since R165 (§ 7).

## 1. Why

**Electron 39 reached end of life on 5 May 2026.** Electron supports "the latest three stable major
versions" (`electronjs.org/docs/latest/tutorial/electron-timelines`), and 39's last release, 39.8.10,
came out that day. Klados 1.2.0 ships it, so Chromium 142 and Node 22 are about five months behind on
security fixes. Dependabot shows no open Electron alert, but that proves nothing: an advisory names
fixed versions, and 39 no longer gets any.

| Electron | Chromium | Node | End of life (releases.electronjs.org/schedule) |
|---|---|---|---|
| 39 (today) | 142 | 22.20 | **5 May 2026** |
| 42 | 148 | 24.15 | 20 Oct 2026 |
| 43 | 150 | 24.17 | 5 Jan 2027 |
| **44** (44.4.5, the target) | **152** | **24.18** | **2 Mar 2027** |

**The two Dependabot alerts close as a side effect.** #1 (GHSA-jmr9-qjv8-65gv) and #29
(GHSA-7pqw-9j4j-h8q3) are both `extract-zip` 2.0.1, which has no fixed release. Its only path into the
project is `electron@39`'s install script. Electron 40 and later depend on
`@electron-internal/extract-zip` instead (measured with `npm view` for the newest release of each
major). **Neither alert reaches users:**
- A packaged `app.asar` holds only the UI dependencies. Measured on a Windows `--dir` build: no
  `extract-zip`, and no `electron` package.
- The one archive `extract-zip` unpacks is the Electron zip, whose SHA-256 is pinned in the `electron`
  package's own `checksums.json` and checked before extraction.

The alerts say "runtime" only because `@electron-toolkit/utils`, a runtime dependency, lists
`electron` as a peer, which puts it in npm's production tree.

**44, not 42.** 42 is the smallest supported jump, but its support ends on 20 Oct 2026, three weeks
out.

## 2. What changed between 39 and 44, against what Klados uses

Every entry in Electron's `docs/breaking-changes.md` for 40.0 through 44.0 (read from the source file,
not a summary), checked against `src/main`, `src/preload` and the build configuration.

| Version | Change | Klados | Action |
|---|---|---|---|
| 40 | `clipboard` from the renderer deprecated | Renderer copies through `navigator.clipboard` (`Detail.tsx`, `Grid.tsx`), not Electron's module | Test copy by hand (§ 5): main denies every permission request, and Chromium's clipboard permissions have moved on since 142 |
| 40 | macOS dSYMs as tar.xz | Not used | — |
| 41 | PDFs in the same WebContents; cookie change causes; `showHiddenFiles` on Linux deprecated | Not used | — |
| 42 | **`electron` no longer downloads its binary in `postinstall`** | CI, electron-vite, Playwright's `_electron` and the tests all get the binary through `require('electron')` | § 3.1 |
| 42 | macOS notifications, offscreen rendering scale, `clearStorageData` quotas, `createFromNamedImage` | Not used | — |
| 43 | **Dialogs without `defaultPath` open in Downloads, and the OS stops remembering the last folder** | `document:openDialog` passes no `defaultPath` | § 3.2 |
| 43 | Linux: window-controls overlay follows the native layout; frameless windows get rounded corners | Linux keeps its native frame (`titleBarWindowOptions` returns `{}`) | — |
| 43 | `NativeImage.toBitmap`, `chrome.scripting` | Not used | — |
| 44 | **macOS 12 no longer supported** | Klados has published macOS builds | § 3.3 |
| 44 | ANGLE statically linked; `libEGL`/`libGLESv2` no longer shipped | Nothing in `electron-builder.yml` names them | Compare package sizes (§ 5) |
| 44 | `clipboard` module removed from the renderer, and made async | As in 40 | As in 40 |
| 44 | Windows ia32 and Linux armv7l dropped | Klados builds x64 and arm64 only | — |
| 44 | `select-client-certificate`, `net.request` modes, Unity, pre-13 login items | Not used | — |

**Node 22 → 24 in the main process.** Main uses `fs/promises` (including `FileHandle.createReadStream`
since R220), `stream`'s `Readable.toWeb` and `child_process`, all still present in 24. `@types/node`
moves to `^24` to match, since type-checking the main process against 22 while it runs on 24 would
hide an API that no longer exists.

**Toolchain compatibility is verified by running it, not by reading changelogs:**
- electron-vite 5 derives its build targets from the installed Electron.
- electron-builder 26.15 downloads its own copy of the target Electron for packaging.
- Playwright 1.62's `_electron` drives the built app in eight test files.

## 3. The changes

### 3.1 Installing the binary once, explicitly

**Verified by reading Electron 44's `index.js`:** when the binary is missing, `require('electron')`
runs `install.js` synchronously and returns the path, and later calls find it. So nothing breaks
outright. But on a fresh CI checkout, several `_electron` test files start in parallel workers, and
**each would start the same download and extraction into the same `dist/` folder**.

- `ci.yml` and `release.yml` run `npx install-electron` once, right after `npm ci`, before any tool
  asks for the path. It keeps 39's checksum pinning (`install.js` passes `checksums.json` to
  `@electron/get`).
- Locally, the first `npm run dev` or test run after an install downloads the binary. That is
  Electron's intended behaviour and needs no change; the README's setup steps say so.

### 3.2 The Open dialog remembers its folder again

**Verified on this machine:** Windows' `ComDlg32\LastVisitedPidlMRU` has an entry for `Klados.exe`.
That is how the Open dialog reopens in the last folder today, across restarts. macOS's open panel
remembers per application in the same way. From 43, Electron passes Downloads whenever `defaultPath`
is absent, so this would silently stop.

- Main remembers **the folder of the last file chosen in the Open or Save As dialog** and passes it as
  the Open dialog's `defaultPath`. It is persisted in `userData` (`dialog-state.json`), beside
  `keybindings.json` and `titlebar-theme.json`, so it survives a restart as the OS's own memory did. If
  nothing is remembered, or the folder no longer exists, `defaultPath` stays unset and Electron's
  Downloads default applies.
- **Save As is unchanged.** It already passes the document's own path (R194), which beats any
  remembered folder.
- Only a folder the user chose in a dialog is written: no file content, and nothing from the renderer.

### 3.3 macOS 13 or later

- `electron-builder.yml` sets `mac.minimumSystemVersion: '13.0'`. electron-builder writes it as
  `LSMinimumSystemVersion` (`app-builder-lib/out/macPackager.js:392`). Without it the value is whatever
  Electron's bundle carries. With it, a Mac on 12 shows the system's standard "needs a newer macOS"
  refusal instead of a failed launch.
- The README says which systems Klados runs on, which it has never stated. Windows 10+ (64-bit),
  macOS 13+, and 64-bit Linux, as Chromium 152 supports.

### 3.4 Versions

`electron` `^44.4.5` and `@types/node` `^24`; nothing else moves unless § 5 shows it has to. The
application version becomes **1.2.1** in a separate pull request after this one lands, as 1.2.0 was.

## 4. Non-functional expectations

**No measurable regression**: each figure within ±15% of 39's, where 15% is about the spread between
runs of the same build. The baseline was measured before the upgrade, against the built app, on the
same machine, as the median of three launches. "Until ready" runs from launch to the Tree's first row
(or, with no file, the start page). Memory is `app.getAppMetrics()` summed once ready.

| Case | 39: until ready | 39: total | 39: renderer |
|---|---|---|---|
| Startup, no file | 760 ms | 429 MB | 101 MB |
| `cars-100mb.xml` | 4.60 s | 837 MB | 470 MB |
| `cars-100mb.json` | 4.16 s | 847 MB | 483 MB |
| `cars-200mb.xml` | 7.68 s | 1,081 MB | 724 MB |

Machine: Windows 11 Pro 26100, the project lead's development machine. Electron 39.8.10, Chromium
142.0.7444.265, Node 22.22.1. A regression beyond 15% is reported, not accepted.

## 5. Verification

**Automated:**
- Typecheck, lint, both test projects (node and real-Chromium browser), and `npm run test:large`.
- The eight built-app test files, which cover the sandbox, CSP refusal, navigation guard, permission
  denial, zoom, preload surface, "Open with" and file errors.
- CI on all three platforms, then a release rehearsal by `workflow_dispatch` (D-095). It uploads
  nothing while `v1.2.0` is published at 1.2.0; see the 1.2.0 rehearsal in `docs/LOG.md`.

**Driven by hand in the built application** (Playwright against `out/`, with screenshots, on
Windows):
- Start page in both themes, Windows title-bar overlay colours, and the recolour on theme switch.
- Zoom in, out and reset, and whether it persists.
- Open by launch argument; tabs; session restore; recent files.
- Tree, Detail, grid with its tabs, and Raw, including selection sync and the leaf glyph.
- Edit in Raw, undo and redo, Save, and an external change with reload.
- Find and replace, grid filter, and the palette.
- Copy a cell and a Detail value, checked by reading the system clipboard from main.
- Quit with unsaved changes; error banners (R220); `cars-500mb.xml` open and scroll.

**Native dialogs, driven through Windows UI Automation:**
- Open: pick a file in another folder, restart, and check the next Open starts there (§ 3.2).
- Save As.

**Installer, on Windows:** install the packaged 1.2.1 over 1.2.0. Check:
- "Open with" still lists Klados, and the document icon (R219).
- Double-click and a second launch hand files over.
- Uninstall restores every extension's handler.

**Left to a person, stated as such in the results:**
- Dragging a file from Explorer onto the window. `webUtils.getPathForFile` needs a real OS drag, which
  automation here cannot produce.
- Windows Snap Layouts on hovering the maximize button.
- macOS and Linux beyond CI and the rehearsal's builds, as R219 already owes.

## 6. Not in this round

- Electron 45 or later. 44 is the newest stable today.
- Moving CI's own Node from 22 to 24. The toolchain runs on 22; only the app's embedded Node changes.
- Anything the § 2 table marks "not used".

## 7. Results

**Built.** Klados runs on Electron 44.4.5 (Chromium 152.0.7977.130, Node 24.21.0). Every change in § 3
landed as planned, and nothing else in the code had to move. **Both Dependabot alerts close with it**:
`extract-zip` and its five helper packages are gone from the lockfile. The lockfile changes are
exactly Electron's own dependency tree and `@types/node`.

### Automated

- Typecheck, lint (the usual 3 warnings), and both test projects: 189 files, 2,314 tests.
  `npm run test:large`: 2,356 tests. The one skipped file is `pathPredicateBudget.test.ts`, whose
  fixture is not generated; it skips identically on 39.
- The 13 built-app tests all ran against 44, not skipped: sandbox, preload surface, trusted IPC, CSP,
  permission denial, zoom, file watching, "Open with", file errors.
- `test/dialogFolder.test.ts` (9) covers § 3.2's memory against a real file system:
  - nothing remembered;
  - remembered across a restart;
  - the latest choice wins;
  - a deleted folder is forgotten;
  - four malformed state files;
  - a failed write that never fails the open.

### § 3.1, measured

`npm install` of 44 left no binary (no `path.txt`, no `dist/`), as § 3.1 read from the source.
`npx install-electron` installed it with the pinned checksums, and every later `require('electron')`
found it.

### § 4: performance, 39 against 44

Same machine, same fixtures, built app, median of three launches. **No regression; 44 is faster and
smaller everywhere:**

| Case | Until ready, 39 → 44 | Total memory, 39 → 44 | Renderer, 39 → 44 |
|---|---|---|---|
| Startup, no file | 760 → 584 ms (−23%) | 429 → 314 MB (−27%) | 101 → 86 MB |
| `cars-100mb.xml` | 4.60 → 3.91 s (−15%) | 837 → 683 MB (−18%) | 470 → 419 MB |
| `cars-100mb.json` | 4.16 → 3.58 s (−14%) | 847 → 731 MB (−14%) | 483 → 474 MB |
| `cars-200mb.xml` | 7.68 → 6.74 s (−12%) | 1,081 → 973 MB (−10%) | 724 → 707 MB |
| `cars-500mb.xml`, after the size prompt | 16.5 → 15.4 s | 1,939 → 1,936 MB | — |

**The installer grows 17.5%** (`klados-1.2.0-setup.exe` 81.3 → 95.6 MB). Compared file by file,
all of it is Electron's own:
- `electron.exe` +33.5 MiB, with ANGLE now linked in, while the separate 8 MiB `libGLESv2.dll`
  is gone.
- `resources.pak` +5.8 MiB, and Chromium's license file +5.1 MiB.

R195's locale trim still holds (`en-US.pak` only).

### By hand, in the built application

A scripted session drove the built app as a person would: keyboard, clicks, screenshots. **It ran
identically on 39 as a control**, so a difference between them would be the upgrade's, and a failure on
both would be something else. Every step gave the same result on both. Passed:
- The start page in both themes, and the title-bar theme persisted.
- Zoom in, out and reset.
- The palette and F1.
- Opening a file into the Tree, Detail, the grid and Raw.
- The grid quick filter and Find.
- Editing in Raw, then undo and redo after a typing pause, as the burst debounce intends. Pressed
  immediately after typing, undo removes one character, on 39 too.
- Save to disk, and a clean document reloading after an external change.
- The unsaved-changes prompt on close.
- Session restore.
- `cars-500mb.xml` through the size prompt, then scrolled.

**§ 3.2 in the real Windows dialogs**, driven through UI Automation and window messages:
- With nothing remembered, Open starts in **Downloads** (Electron 43's new default, confirmed).
- Picking a file in another folder opens it and remembers the folder.
- Save As through the real dialog writes a byte-identical copy, and its folder becomes the remembered
  one.
- **After a restart, Open starts in that folder.**
- With the remembered folder deleted, Open starts in Downloads again, without an error.
- Save As's own dialog starts on the document's file, as before (R194).

**The packaged `Klados.exe`** (`electron-builder --win`, outside Playwright):
- It opened a file, and a second launch handed over its file and exited with code 0.
- It closed normally with both files in its saved session. Klados records a tab there only once the
  file is open.

### Found while testing: copying to the clipboard is refused, since R165

**This predates the round, and 39 fails identically.** The grid's CSV, TSV and Markdown buttons and
Detail's "Copy path" call `navigator.clipboard.writeText`. It rejects with *"Write permission
denied"*: R165's handler refuses every permission request, and this one needs
`clipboard-sanitized-write`. Allowing only that permission at runtime made the write succeed on
both versions, and it was the only permission Chromium asked for.

- **Why no test saw it:** the browser-project tests that cover copying run in a plain Chromium, without
  the app's handlers.
- **Not fixed here:** it relaxes a security decision. The fix is proposed to the project lead as its own
  round, targeted at the same release.

### Owed

- Dragging a file from Explorer onto the window. `webUtils.getPathForFile` needs a real OS drag.
- Snap Layouts on hovering the maximize button.
- ~~Installing the new build over an installed 1.2.0, then "Open with" and uninstall.~~ Done after R222
  merged, with the project lead's agreement; see "The installer, on the development machine" below.
- A real Mac, including macOS 12's refusal, and a real Linux desktop. CI and the release rehearsal
  build and test them; nobody has launched them.

### The installer, on the development machine

Done after R222 merged, as the last step before 1.2.1. It was run on the project lead's own
installation with their agreement. The installer was built from `main` (R221 and R222) with
`--config.extraMetadata.version=1.2.1`, so it was a real upgrade, and the repository was left
unchanged. **The installed copy was 1.1.0, not 1.2.0:** the build installed from R219's branch
before `main` moved to 1.2.0.

| Step | Result |
|---|---|
| Baseline, recorded first | `.xml` → Klados (an explicit choice), `.json`/`.tsv`/`.tab` → Klados, `.csv` → VS Code, `.toml` no default; all six list Klados for "Open with", with the document icon |
| Install 1.2.1 over it (`/S`) | One uninstall entry, at 1.2.1; the Electron 39 `libGLESv2.dll` did not survive. **Every handler, user choice, "Open with" entry and icon identical to the baseline** |
| The installed `Klados.exe`, run with the registered command plus a temporary profile | A second launch handed over its file and exited with 0; both files were in the session when the app closed normally. The real profile was not touched, which is how R219's own check left its probe file behind |
| Uninstall (`/currentuser /S`) | Program folder, uninstall entry and all six `Klados.<ext>` classes gone; no "Open with" list names Klados; defaults fell back to VS Code, or to none for `.tsv`/`.tab` |
| Reinstall | Every extension identical to the baseline again |

### Review

Read as a diff after the tests passed. **No defect found in the round's own changes.** Checked:
- The lockfile moves only Electron's tree and the Node types.
- The CI step's comment claims checksum pinning; it is true of Electron 44's `install.js`.
- An Open dialog with nothing remembered gets no `defaultPath` key at all, not `undefined`.
- `remember` writes only a folder the user chose in a native dialog, and never fails an open or a
  save.

The harness had faults of its own, each found against the Electron 39 control rather than reported as
a regression:
- The Raw pane was hidden by default, and the grid's virtualized rows can't be counted.
- CodeMirror renders only the lines on screen.
- The undo check didn't allow for the typing debounce.
- A relaunch collided with R219's single-instance lock while the previous instance was still exiting.
- The Save dialog's name box ignores `WM_SETTEXT`.
