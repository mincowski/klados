# R225 — what this repository needs for winget

<!-- status: open -->

**Open — scoped, not yet scheduled.** The project lead asked what *this repository* has to change
for Klados to be in winget. If it was only the README, that would be R225, landing after the package is
approved. It is not only the README (§ 3). When R225 lands is decided once this plan has been read.

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
