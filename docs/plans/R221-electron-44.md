# R221 — Electron 39 to 44

<!-- status: open -->

**Open.** Raised by the investigation of the two open Dependabot alerts after 1.2.0 shipped. It is
meant to ship as **1.2.1**, as decided by the project lead.

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
