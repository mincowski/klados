# R225 — what this repository needs for winget

<!-- status: built-caveat -->

**Built in part, for 1.2.2: § 3, the installer.** § 6, the README line, is owed until the package is
approved, and the submission itself (§ 5) happens outside this repository after 1.2.2 is published.
The project lead asked what *this repository* has to change for Klados to be in winget; it was more
than the README (§ 3). **Decided:** § 3 lands in 1.2.2, the first submission is 1.2.2, and interactive
installs also stop killing Klados (§ 3's recommendation, not its alternative). Results: § 9.

The package itself is not part of the repository. It is a set of manifest files in Microsoft's
`microsoft/winget-pkgs`, submitted by pull request from the project lead's account (§ 5).

## 1. Why winget — measured

**A winget install never reaches SmartScreen.** Verified three ways:

- **The mechanism, in winget's source** (`src/AppInstallerCLICore/Workflows/DownloadFlow.cpp` in
  `microsoft/winget-cli`):
  1. Every download is first marked as coming from the Internet.
  2. When the installer's hash matches its manifest, *and* the package comes from a source with
     trust level `Trusted`, winget re-marks the file as trusted. The comment reads *"We know the
     installer already went through multiple scans and we can trust it."*
  3. Those scans are the validation every submission to `microsoft/winget-pkgs` goes through.
- **The source's trust level, on the development machine:** `winget source export` shows the default
  `winget` source as `"TrustLevel":["Trusted","StoreOrigin"]`.
- **A real case:** SourceGit, an unsigned open-source desktop app installed through winget, raised no
  SmartScreen prompt on first launch.
  - Its `SourceGit.exe` is unsigned (`Get-AuthenticodeSignature`).
  - Its files carry **no** `Zone.Identifier` stream, while a browser download in the same profile
    carries `ZoneId=3`.
  - SmartScreen's application check only looks at files marked as downloaded.

**What it costs the project:** nothing in money, no subscription, no certificate, and no name. It
covers every future version, at the cost of one manifest pull request per release (§ 5).

**What it does not fix:**
- **Smart App Control.** Its *"signature checks apply to all executable files, not just those
  downloaded from the Internet"* (Microsoft). Where it is on, unsigned Klados is blocked however it
  was installed. It was off on the development machine, so this was not observable there. Only a
  certificate or the Microsoft Store's own signature gets past it.
- **GitHub downloads through a browser.** They keep SmartScreen's prompt.

## 2. What is already in place — R172–R174

`docs/plans/R172-published-identity.md` froze every field winget correlates on, *"so that when one is
decided on it needs zero changes to this repository"*, and `test/` enforces them (R173):

- the identifier `klados.Klados` (R172e), which lives only in the manifest;
- the publisher and display name the installer writes to Add/Remove Programs;
- the pinned NSIS GUID, the manifest's `ProductCode`, which is what lets winget recognise an
  installed Klados and upgrade it rather than install a second copy;
- per-user, one-click install, so `winget install` needs no elevation (R172d);
- the download URL pattern, stable across versions (`nsis.artifactName`);
- R174's table mapping every manifest field to its source in this repository.

**Read in electron-builder's NSIS templates** (`app-builder-lib/templates/nsis/`), for what winget does
with the installer. winget runs a `nullsoft` installer with `/S`:
- **No prompt in a fresh install.** Every message box carries a `/SD` default, and the progress
  banner is skipped (`installSection.nsh`).
- **Klados is not launched afterwards.** A silent one-click install starts the app only with
  `--force-run` (`installSection.nsh`).
- **R219's "Open with" registration** (`assets/build/installer.nsh`'s `customInstall`) runs the same
  either way.

So a fresh `winget install` needs nothing from this repository. **An upgrade does** (§ 3).

## 3. The change — a running Klados is never killed

**The problem, read in the templates.** Before installing, the installer looks for a running
`Klados.exe` (`include/allowOnlyOneInstallerInstance.nsh`, `_CHECK_APP_RUNNING`):

1. It shows *"Klados is running. Click OK to close it"*, with `/SD IDOK`, so a silent install answers
   OK by itself.
2. It then ends every process under the install folder with PowerShell's `Stop-Process`, which
   terminates at once. Klados's own unsaved-changes prompt (R26, the window's `close` handler in
   `src/main/index.ts`) never runs.

So **`winget upgrade` while Klados is open loses every unsaved edit, without a word.** A manual upgrade
does the same after the OK prompt, but the user at least sees that prompt and can cancel. `winget
upgrade --all` is commonly run with applications open, and Klados is an editor.

**The change, in `assets/build/installer.nsh`:** electron-builder lets the project replace that step
with its own `customCheckAppRunning` macro (`CHECK_APP_RUNNING` inserts it instead of the stock
check). The installer then never terminates Klados:

- **Silent (winget):** if Klados is running, the installer exits without installing, with a dedicated
  exit code. The manifest declares that code under `ExpectedReturnCodes` with `ReturnResponse:
  packageInUse`, so winget reports that the application is running and should be closed first, and
  nothing is lost. The exact message is winget's own; confirm it in the round.
- **Interactive (a download from GitHub):** *"Klados is running. Close it, then click Retry."*, with
  Retry and Cancel. Klados's own prompt then handles unsaved changes, because the user closes it.
  **This changes manual upgrades too**, which today close Klados after one OK. Recommended for the
  same reason: OK currently discards edits without saying so.
  - *Alternative:* keep the stock behaviour for interactive installs and change only the silent path.
- **The uninstaller** goes through the same macro (`uninstaller.nsh` inserts `CHECK_APP_RUNNING`), so
  `winget uninstall` and Settings' uninstall behave the same way.

**To settle in the round, not assumed here:**
- **Include order.** `allowOnlyOneInstallerInstance.nsh` checks `!ifmacrondef customCheckAppRunning`
  when it is included, so `installer.nsh` must be read before it. Verify on the generated script,
  as R219 did for `customInstall`.
- **Finding the process.** The stock check filters by the current user and the install folder. The
  replacement must not miss a Klados started from the install folder, and must not refuse because
  of an unrelated `Klados.exe`, such as a development build or another user's session.
- **The exit code.** NSIS uses 1 for a user cancel and 2 for an abort, so the code must be something
  else. The value goes into the manifest, so it is recorded in R174's table's successor, § 4.
- **The upgrade path from 1.2.1.** The new installer runs the old version's uninstaller, which has
  the stock check. By then the new check has already passed, so the old one should find nothing;
  verify.

## 4. The manifest, beyond R174's table

R174 (`docs/plans/R172-published-identity.md` § 10) still holds, field for field. § 3 adds one entry
to the installer:

```yaml
ExpectedReturnCodes:
  - InstallerReturnCode: <the code chosen in § 3>
    ReturnResponse: packageInUse
```

**The first version submitted must contain § 3's installer.** A manifest for 1.2.1 would point at an
installer that still kills a running Klados. So the first submission is the first release carrying
§ 3, not 1.2.1.

## 5. Outside this repository — the submission

Recorded so the sequence is clear. None of it is a commit here.

1. **The first manifest**, written from R174 and § 4, checked with `winget validate`, and submitted
   to `microsoft/winget-pkgs`.
   - The pull request is opened from the project lead's account, through a fork, and only on their
     explicit go-ahead.
   - It goes through automated validation (a malware scan, an install in a sandbox) and a moderator's
     review, which can take days and may come with questions.
2. **Each later release:** a new manifest version, with the release's installer URL and the
   SHA-256 from `SHA256SUMS.txt`. `wingetcreate update` does it in one command.
3. **Not in scope: automating step 2 in `release.yml`.** It needs a standing GitHub token, created by
   the project lead and stored as a repository secret, to open pull requests against Microsoft's
   repository. Releases are rare and the manual step is minutes. Revisit if that changes.

## 6. The README — after approval

Only once `winget show klados.Klados` finds the package:
- `winget install klados.Klados` listed first under Windows, noting it avoids SmartScreen's prompt;
- the direct download stays.

This part cannot land with § 3. Writing the command before the package exists would send people to an
error.

## 7. When it lands — the decision this plan asks for

Two parts with different timing:

| Part | Can land | Depends on |
|---|---|---|
| § 3, the installer | any release; **the first winget submission waits for it** | nothing |
| § 6, the README | after the package is approved | the submission (§ 5) |

**Recommended:** § 3 in 1.2.2, the first submission is 1.2.2, and § 6 lands as a small follow-up once
it is approved, with no release needed since the README is read on GitHub.

## 8. Verification

- **§ 3, on the built installer.** Using the development machine's per-user install, only with the
  project lead's go-ahead since it is their installed Klados, or a Windows Sandbox if they enable
  one:
  1. With Klados running and an unsaved edit, `klados-<version>-setup.exe /S` exits with the
     dedicated code. Klados is still running, with the edit.
  2. Interactively, the Retry/Cancel prompt appears. Cancel leaves Klados untouched; closing Klados
     shows its own unsaved-changes prompt; Retry then installs.
  3. With Klados not running, `/S` installs and returns 0. The installed app and its file
     associations match R221's baseline method.
  4. An upgrade from 1.2.1 with Klados not running succeeds, leaving one entry in Add/Remove Programs.
  5. The uninstaller with Klados running behaves as in 1 and 2.
- **The generated NSIS script** contains the custom macro and not the stock `Stop-Process` line.
- **After approval (§ 5):**
  1. `winget install klados.Klados` raises no SmartScreen prompt.
  2. `winget show klados.Klados` lists R174's values.
  3. `winget upgrade` with Klados open reports the application as running and changes nothing.

## 9. Results

### What landed

- **`assets/build/installer.nsh` defines `customCheckAppRunning`**, which electron-builder inserts in
  place of its own check, in the installer and the uninstaller alike.
  - If Klados is running, a silent run exits with **3** (`KLADOS_RUNNING_EXIT_CODE`).
  - An interactive run asks the user to close Klados and click Retry; Cancel exits with 3.
  - It never ends a process. Finding one reuses the stock `FIND_PROCESS`: a process under
    `$INSTDIR`, or, without PowerShell, a `Klados.exe` of the current user.
- **The prompt is electron-builder's own translated `appCannotBeClosed`**, not a new sentence.
  - The first build used an English sentence of our own. On the development machine's German Windows,
    it appeared in a German dialog, with German title and buttons.
  - `appCannotBeClosed` exists in 46 languages and ends with the instruction wanted: close it manually,
    and click Retry. Its opening, "cannot be closed", is looser than the truth, since the installer
    chooses not to close it. Accepted as the smaller cost.
- **`test/installerRunningApp.test.ts`** reads electron-builder's template as well as Klados's file, because
  the override works only while electron-builder still asks for it by name.
  - It asserts that `CHECK_APP_RUNNING` still inserts `customCheckAppRunning` in place of the stock check.
  - It asserts that the reused helpers exist, that the replacement never kills or stops a process,
    and that it uses exit code 3 on both paths.
  - **Mutation:** renaming the hook in the template turns the first assertion red.
- **§ 3's open questions, settled:**
  - The include order works: `installer.nsh` is included in the script's common header
    (`NsisTarget.js`, `computeCommonInstallerScriptHeader`), ahead of the templates.
  - Exit code 3 is unused: NSIS itself uses 1, and the templates use 0, 2 and `0x666666`.
  - With warnings treated as errors, both installer and uninstaller compile.

### Verified on the built installer, on the development machine

With the project lead's go-ahead, against their per-user install of 1.2.1 (no Windows Sandbox is
available there). Klados ran on temporary profiles, except where noted. Each step was read off the
process's exit code, the dialogs' text and buttons (read from the windows themselves), the installed
`Klados.exe`'s hash, and the Add/Remove Programs entry.

| # | Run | Result |
|---|---|---|
| 1 | `/S` with Klados open | exit 3 in 5 s; Klados still running; nothing changed |
| 2 | interactive with Klados open, Cancel | the prompt, in German; exit 3; Klados still running; nothing changed |
| 3 | interactive with Klados open; Klados then closed normally; Retry | exit 0; installed, an upgrade from 1.2.1; one Add/Remove Programs entry |
| — | `/S` with Klados open on the project lead's own profile | exit 3 (see below) |
| 4 | `/S` with Klados closed | exit 0; installed; Klados not launched |
| 5a | the new uninstaller, `/S`, Klados open | exit 3; Klados still running; still installed |
| 5b | the new uninstaller, interactive, Klados open: OK, then Cancel | "Are you sure" first, then the prompt; exit 3; still installed |
| 6 | `/S` uninstall with Klados closed, then a fresh `/S` install | removed: Klados's "Open with" entries gone, others untouched; reinstalled with every extension's associations **identical** to the baseline taken before step 1 |

**A finding along the way, stock behaviour and unchanged:** an *interactive* one-click install starts
Klados when it finishes (`installSection.nsh`, `RUN_AFTER_FINISH` unless silent). After step 3 that
started Klados on the project lead's own profile. The first attempt at step 4 therefore ran with Klados
open and was refused with 3, which is the row marked "—". That copy was closed normally, through its
window, and step 4 repeated.

**Not verified here:** a Klados with unsaved changes showing its own prompt when closed at step 3. That
is R26's quit flow, unchanged and tested in its own round. What this round changes is that the
installer no longer bypasses it.

### Owed

- **§ 6, the README line,** once `winget show klados.Klados` finds the package.
- **§ 8's post-approval checks:**
  - `winget install` without SmartScreen;
  - `winget show` listing R174's values;
  - `winget upgrade` with Klados open, reporting it as running.

### Review

Read from `git diff` after the work. One finding was fixed before committing: the English-only prompt,
found by running it on this machine, not by reading. Nothing else:

- No invariant is touched; the change is the Windows installer script.
- The stock check is replaced only through electron-builder's documented hook, and a test fails if that
  hook disappears.
