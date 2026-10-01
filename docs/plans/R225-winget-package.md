# R225 — Klados in winget's community repository

<!-- status: open -->

**Open — recorded, not scheduled.** Written at the project lead's request after R224 (SignPath)
closed, so the finding and the route are on record. Whether it is built, and for which release, is
undecided; the plan may change.

## 1. Why — measured

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
covers every future version, at the cost of one manifest pull request per release (§ 3).

**What it does not fix:**
- **Smart App Control.** Its *"signature checks apply to all executable files, not just those
  downloaded from the Internet"* (Microsoft). Where it is on, unsigned Klados is blocked however it
  was installed. It was off on the development machine, so this was not observable there. Only a
  certificate or the Microsoft Store's own signature gets past it.
- **GitHub downloads through a browser.** They keep SmartScreen's prompt.

## 2. What already exists — R172–R174

`docs/plans/R172-published-identity.md` froze every field winget correlates on, *"so that when one is
decided on it needs zero changes to this repository"*:
- the identifier `klados.Klados` (R172e);
- the publisher string;
- the pinned NSIS GUID as `ProductCode`, which is what lets winget detect installs and upgrades;
- per-user scope, so installing needs no elevation;
- a field-by-field mapping from the manifest to this repository (R174), so the manifest is
  transcribed, not re-derived.

## 3. The change

1. **The first manifest**, submitted to `microsoft/winget-pkgs` with Microsoft's `wingetcreate`, for
   the then-current release:
   - installer type `nullsoft`, scope `user`;
   - the GitHub release asset's URL and SHA-256;
   - R174's fields.

   It goes through automated validation (a malware scan, and an install in a sandbox) and a
   moderator's review.
2. **Every later release**, automated from `release.yml` after the release is published, since the
   manifest needs the published URL and hash. Either `wingetcreate update --submit`, or a maintained
   action built on it.
   - Either way, the workflow needs a **GitHub token able to open pull requests from a fork of
     `winget-pkgs`**.
   - Only the project lead can create that token, and it is stored as a repository secret. It is the
     one standing credential this adds, and its scope is limited to that fork.
3. **The README** lists `winget install klados.Klados` first for Windows, noting it avoids SmartScreen's
   prompt. The direct download stays.

**Nothing in Klados changes.** winget runs the same NSIS installer, so R219's "Open with"
registration, the document icon and the settings location are identical.

## 4. Open questions

- **Whether the first submission needs anything a new publisher lacks.** winget-pkgs moderators can
  ask for evidence a package is legitimate. The README and release history should be enough, but
  that is unconfirmed.
- **Whether to automate before the first release has gone through by hand.** Recommended: submit by
  hand once, automate from the second.

## 5. Verification

- After the manifest is merged, on the development machine:
  1. `winget install klados.Klados`, with no SmartScreen prompt.
  2. The installed app and its file associations checked against R221's baseline method.
  3. `winget upgrade` from one release to the next, once a second manifest exists.
- `winget show klados.Klados` lists the publisher, licence and version from R174's mapping.
