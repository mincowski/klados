# R229 — no write token where third-party code runs, locked actions, and immutable releases

<!-- status: built-caveat -->

**Built, with checks owed** (§5). The token, the lockfile, `--ignore-scripts` and the documentation
landed and were measured. Immutability can only be measured on the first tagged release after this
round, and two settings and the first Dependabot actions PR come after the merge (§5.5). GitHub
enforces the lockfile at run time without the *Require lockfile* policy (§5.2). Planned from the security review of 2026-10-16, finding 1 (medium), and widened by the
project lead on 2026-10-17 to cover the whole release supply chain: the token (§2A, B, D, E), the
actions the workflows run (§2C, a lockfile), and the published release itself (§2F, immutability).
Touches `.github/`, the README's download section and D-095. The application does not change.

**Two settings are the project lead's to switch**, in the repository's settings and not in any file:
release immutability (§2F), and the *Require lockfile* policy if this repository is offered it
(§2C). Each is switched only after the merge, in the order §2 gives.

## 1. The finding

`release.yml` grants `permissions: contents: write` **at workflow level**, so every step of every job
holds a token that can create and edit releases, upload and delete release assets, and push commits
and tags. Inside that same job:

1. `actions/checkout@v7` runs with its default `persist-credentials: true`, which writes the token
   into `.git/config` as an `http.https://github.com/.extraheader`. **Any process in the job can read
   it from there**, not only the steps that are given `GH_TOKEN` explicitly.
2. `npm ci` runs the install scripts of every package in the lockfile. Measured on this lockfile, six
   packages declare one (`esbuild` ×3, `fsevents` ×2, `electron-winstaller`), plus the project's own
   `postinstall` (`electron-builder install-app-deps`).
3. Then `npm run typecheck`, `npm run lint`, `npx playwright install`, the whole test suite and the
   whole build run, all of them third-party code. The last step hands the token to electron-builder
   directly, as `GH_TOKEN`.

So **a compromised version of any dev dependency, transitive or direct, can replace a release's
installer** and its `SHA256SUMS.txt` in the same move (R167's checksums are made in the same
workflow, by a job with the same write scope). The binaries are unsigned (R224 closed), so nothing
downstream would notice. This is the scenario R226 named and then closed as not worth attestations.
This round makes the token unreachable instead, which costs nothing at download time.

`ci.yml` has the same checkout default but no `permissions:` block, so its token is the repository
default. **Read on 2026-10-17, that default is read-only** (`gh api repos/mincowski/klados/actions/permissions/workflow`
→ `"default_workflow_permissions": "read"`), so `ci.yml` holds no write token today. It would get one if
that setting were ever switched to *read and write*, a change made in the repository settings that
is invisible in the workflow file. §2D makes the file say `read` itself. That is a guard, not a fix
for a live exposure.

**A tag is not a version, shown in this repository's own logs.** Every `uses:` names a movable tag
(`@v7`). The CI run of 2026-10-03 records
`Download action repository 'actions/setup-node@v7' (SHA:820762786026…)`, which is v7.0.0. On
2026-10-17, `v7` resolves to `949feb2413d6…`, which is v7.1.0, released 2026-10-08. The next run executes
different code with no commit here. This time the update is legitimate. A tag moved by someone who
compromised the action's repository looks exactly the same, and that is how the `tj-actions/changed-files`
compromise of March 2025 reached its users.

**And a published release can be changed afterwards.** Release immutability is off
(`gh api repos/mincowski/klados/immutable-releases` → `{"enabled":false}`), and v1.2.2 reports
`immutable: false`. Anyone holding a write token, now or later, can replace a published release's
files, or move its tag. D-095 forbids moving a tag after publication, but only as a rule written
down, with nothing enforcing it.

## 2. The change

**A. Build without publishing, then publish in a job that runs no third-party code.**
- The matrix job gets `permissions: contents: read` and runs `electron-builder --publish never`, then
  `actions/upload-artifact` with the files R198 left in the release (installer, dmgs, AppImage, deb).
- A new `publish` job, `needs: release`, holds `contents: write`. It runs **no `npm`, `npx`,
  `node_modules` or checkout of the code**. It downloads the artifacts and uses `gh release`
  (preinstalled on the runner) to create or reuse the draft and upload to it. The `checksums` job
  merges into it, hashing the downloaded artifacts *before* uploading, so the sums never round-trip
  through the release. **Every file, `SHA256SUMS.txt` included, is on the draft before anyone can
  publish it**, which §2F depends on.
- **The draft behaviour R141 and D-095 depend on is preserved**: a draft named for the tag (or for
  the version on `workflow_dispatch`), reused if it exists, never published by the workflow.

**B. `persist-credentials: false` on every `actions/checkout`**, in both workflows. No step pushes.

**C. Every action locked by a workflow lockfile, and kept current by Dependabot.**

*What it is.* GitHub's workflow dependency lockfiles have been in public preview since 2026-10-14
(changelog of that date). GitHub's secure-use reference ranks them above SHA pinning: "the strongest
protection available, and supersedes SHA pinning for repositories that adopt it". It works like
`package-lock.json` or `uv.lock`:
- `.github/workflows/actions.lock` records, for every action every workflow uses, the exact commit,
  plus the numeric owner and repository ids. The ids catch a repository that was deleted and
  re-registered under the same name. Actions that the listed actions call in turn are recorded too.
- **The workflows keep readable version tags**, and the run uses the locked commit "even if a tag or
  branch moves" (changelog).
- The file is generated by the `gh actions-lock` CLI extension (`github/gh-actions-lock`, v0.2.0 of
  2026-10-12, pre-1.0) and is never edited by hand.

*Why the lockfile rather than SHAs in `uses:`.* Both pin the commit. The lockfile keeps `uses:` on an
exact version tag (`@v7.0.1`), and GitHub documents that Dependabot "only creates alerts for vulnerable
actions that use semantic versioning" and "will not create alerts for actions pinned to SHA values".
**SHA pins would switch off security alerts for actions. The lockfile keeps them**, because what the
workflows reference is still a version.

*The steps.*
1. **Dependabot first**, as GitHub's how-to recommends. Add `.github/dependabot.yml`, **confirmed by
   the project lead on 2026-10-17** with exactly this content, and unchanged by the lockfile:
   ```yaml
   version: 2
   updates:
     - package-ecosystem: github-actions
       directory: /
       schedule:
         interval: monthly
       groups:
         actions:
           patterns: ["*"]
   ```
   Monthly and grouped means at most one pull request a month, covering every action that has
   released. There is **no `npm` entry, deliberately.** npm security updates keep arriving through
   the repository setting as today (#56, #57), and routine npm version updates would be a weekly
   stream of development-dependency PRs.
2. **Every `uses:` names the latest release of its action's current major.** On 2026-10-17 that is
   `actions/checkout@v7.0.1`, `actions/setup-node@v7.1.0`, `actions/upload-artifact@v7.0.2` and
   `actions/download-artifact@v8.0.2`. These are read again from each action's *Releases* page when
   the round is built, since the lockfile locks whatever is current then. **Measured:** of the four,
   only `setup-node` v7.1.0 is itself an immutable release, so the other three exact tags can still
   be moved by their owners. That is why they are locked.
3. **Install the extension at a pinned version** and generate:
   ```bash
   gh extension install github/gh-actions-lock --pin v0.2.0
   ```
   ```bash
   gh actions-lock
   ```
   **Review the whole diff, not only the lockfile.** The extension also rewrites `uses:` lines (`@v7`
   → `@v7.0.1`). Each locked commit is checked against the action's release page.
4. **A `lockfile` job in `ci.yml`** (ubuntu only, read token) runs on every pull request and push:
   ```bash
   gh extension install github/gh-actions-lock --pin v0.2.0
   ```
   ```bash
   gh actions-lock --verify
   ```
   with `GH_TOKEN: ${{ github.token }}`. `--verify` writes nothing. It fails when a workflow uses an
   action the lockfile does not cover, and when a locked commit is no longer in its tag's history.
   - **The extension's version is pinned here as well.** Unpinned, CI would download whatever binary
     is latest on every run, which is this round's own finding in a new place. Dependabot does not
     update this pin; it is raised by hand, and the step's comment says so.
   - **Rejected: GitHub's suggested `update` job**, which regenerates the lockfile on push and
     commits it with `contents: write`. It is a write token committing to `main`, past the
     pull-request rule, which is the opposite of this round.

*Dependabot with the lockfile.*
- **Version updates** (monthly, from the file above): GitHub documents that for an onboarded
  workflow, Dependabot "regenerates the matching lockfile entry in the same pull request". Nothing
  changes in its configuration.
- **Security alerts and security updates** do not follow the monthly schedule. They arrive when an
  advisory is published, as npm's do today: alerts are enabled (`vulnerability-alerts` → 204) and
  so are security updates (`automated-security-fixes` → `enabled: true`). GitHub documents lockfile
  regeneration for *version* updates. **Whether a security update PR regenerates the lockfile too is
  not documented.** If it does not, §2C.4's job fails on that PR, so it cannot merge with a stale
  lockfile. It is fixed by running `gh actions-lock` on the PR's branch. Recorded in Results at the
  first such PR, and in `docs/FINDINGS.md` if it turns out to need that manual step.

*The policy, and one setting dropped.*
- **The *Require lockfile* policy** blocks runs of workflows with no valid lockfile. Whether it is
  offered to a personal repository on the Free plan is not documented. Its *Evaluate* mode is
  Enterprise-only. **The project lead checks the repository's Actions settings after the merge**,
  and enables it once the `lockfile` job is green on `main`. Results records whether it was
  available.
- **The *require actions pinned to a full-length commit SHA* setting is not used.** It requires SHAs
  in `uses:`, which is exactly what the lockfile approach does not write.

*Risk accepted by choosing a preview.* The format and flags may change before 1.0. A change shows up
as a red `lockfile` job, not as a silent pass. If GitHub withdrew run-time locking altogether, the
workflows would fall back to resolving their exact version tags. That is still better than today's
`@v7`, but three of the four are movable (step 2's measurement).

**D. `permissions: contents: read` at the top of `ci.yml`**, so its token is read-only whatever the
repository setting says.

**E. Measured, not assumed: can `npm ci --ignore-scripts` build and test?** If it can, use it in both
workflows, since it removes the install-time half of the exposure. The six scripts look skippable
(esbuild's is a binary check, fsevents is macOS-optional, electron-winstaller is unused, R221 already
installs Electron explicitly), but `postinstall` and esbuild's platform package must be checked on all
three runners. **If any runner fails, record it here and leave scripts on.** A and B already remove
the token, so E only narrows the exposure further.

**F. Immutable releases.** Generally available since 2025-10-28. Switched on by the project lead in
*Settings → General → Releases → Enable release immutability*, **after this round merges and before
the next tag**. Once a release is **published**:
- its files can't be added to, changed or deleted, and its tag can't be moved or deleted.
- its tag name can't be reused, even after the release is deleted.
- its title, notes and *latest* or *pre-release* status stay editable.

What this does to the release flow:
- **Drafts are not affected**, so §2A's draft, the uploads to it and D-095's rehearsals work as
  today. GitHub's recommended sequence for immutable releases is draft, attach every file, publish,
  which is this project's flow already (§2A guarantees the second step).
- **It applies only to releases published after it is switched on.** v1.2.2 and earlier stay
  mutable; they are not republished.
- **A published mistake costs a version number.** A broken release can no longer be fixed in place:
  a new patch version is released instead. That is what D-095 already asks for, and is now also
  the only option.
- **A signed release attestation** is created on publication, recording the tag, the commit and every
  file. A downloader can check it with `gh release verify v<version>` and
  `gh release verify-asset v<version> <file>` (GitHub CLI 2.81 or later). It is **not** R226's build
  provenance: it proves the files are the release's files, unchanged since it was published, not
  that `release.yml` built them. R226 stays closed.

Documentation changes:
- **D-095** gains a note: moving a tag after publication is now refused by GitHub, not only forbidden
  by the decision. The rehearsal rule stays, for its other reason, which is now sharper: a published
  mistake can only be corrected with a new version.
- **The README's download section** (`README.md:41`, the `SHA256SUMS.txt` paragraph) gains the two
  `gh release verify` commands, for releases from this one on. `SHA256SUMS.txt` stays, since it
  needs no GitHub CLI.

## 3. Acceptance criteria

1. **A node test reads both workflows** the way `test/packagedFiles.test.ts` reads
   `electron-builder.yml`, and asserts all of the following. Each one is mutation-checked by
   reverting it in a scratch copy and watching the test fail.
   - The top-level `permissions` of both files is `contents: read`.
   - Exactly one job in `release.yml` has `contents: write`, and **no step of that job** contains
     `npm`, `npx`, `node`, `electron-builder` or `actions/checkout`.
   - Every `actions/checkout` step sets `persist-credentials: false`.
   - Every `uses:` names an **exact** version (`@v\d+\.\d+\.\d+`), never a major-only tag, a branch
     or a SHA, **and appears in `.github/workflows/actions.lock`** under that workflow's file, with
     a 40-hex `commit`.
   - Every `gh extension install github/gh-actions-lock` carries `--pin`.
   - A matcher that meets a step shape it does not understand **throws** (FINDINGS: *a test helper
     that returns `false` for input it does not recognize*).
2. **These print nothing** (run at the repository root):
   ```bash
   grep -nE "uses: [^ ]+@" .github/workflows/*.yml | grep -vE "@v[0-9]+\.[0-9]+\.[0-9]+$"
   ```
   ```bash
   grep -n "contents: write" .github/workflows/ci.yml
   ```
   And `gh actions-lock --verify` exits 0 locally and in the `lockfile` job.
3. **The lockfile is enforced at run time, not only checked.**
   - A run's log shows each action downloaded at its lockfile commit
     (`Download action repository 'actions/checkout@v7.0.1' (SHA:<the lockfile's commit>)`), quoted
     in Results for one job.
   - **The `lockfile` job is shown to bite:** on a scratch branch, a `uses:` changed to a version
     missing from the lockfile turns it red. Quoted in Results, and the branch is deleted.
4. **The token is gone from a build job.** A temporary step in the build job of a `workflow_dispatch`
   rehearsal runs both of the following, and both must fail. The step is removed before merge, and
   its log is quoted in Results.
   ```bash
   git config --get-regexp 'http\..*\.extraheader'
   ```
   (exit 1, nothing printed), and
   ```bash
   gh release create r229-probe --draft --title probe
   ```
   with `GH_TOKEN: ${{ github.token }}` (HTTP 403, *Resource not accessible by integration*).
5. **A `workflow_dispatch` rehearsal produces the same draft as 1.2.2**: the same asset names and
   count (compare `gh release view v1.2.2 --json assets`), plus `SHA256SUMS.txt` whose lines verify
   with `sha256sum -c` against the downloaded draft assets. The rehearsal draft is deleted afterwards,
   per D-095.
6. §2E's outcome is recorded with the per-runner result, whichever way it went.
7. `.github/dependabot.yml` exists with exactly §2C's content. After the merge, Dependabot's own
   check of it (*Insights → Dependency graph → Dependabot*) reports no configuration error, and
   Results says so.
8. **Immutability, measured on the first tagged release after this round**, since a draft cannot show
   it. Until that release exists, this round is `built-caveat` with an entry in `docs/TASKS.md`'s
   Owed table. On that release:
   - `gh api repos/mincowski/klados/immutable-releases` reports `"enabled": true`, and the release's
     own `immutable` field is `true`.
   - `gh release verify v<version>` passes, and `gh release verify-asset v<version> <installer>`
     passes for a downloaded installer.
   - `gh release upload v<version> SHA256SUMS.txt --clobber` is **refused**. The refusal is quoted.
9. **Dependabot and the lockfile**: Results records, for the first Dependabot pull request touching
   an action, whether it changed `actions.lock` in the same PR and whether the `lockfile` job was
   green. If it is a security update and it did not regenerate the lockfile, `docs/FINDINGS.md`
   gains the manual step (§2C).
10. **Documentation describes what landed**: `docs/plans/R164-release-security-hardening.md`'s R167
    section and the comments in `release.yml` describe the two-job shape, the README has §2F's
    verification commands, and D-095 has §2F's note. A comment that still says "electron-builder
    uploads the artifacts itself" is a failure of this round.

## 4. Not in scope

- Signing, build-provenance attestations (R224, R226 closed) and any change to which files are
  published.
- Restricting `workflow_dispatch` to `main`: D-095 relies on it running from any ref for rehearsals.
- Making earlier releases immutable. They are not republished.
- Routine npm version updates through Dependabot (§2C.1).

## 5. Results

Landed on branch `r229-release-token-scope` (PR #63), as §2 describes, with the details below.
**`built-caveat`**: immutability can only be measured on the first tagged release, and three checks
can only happen after the merge (§5.5, and `docs/TASKS.md`'s Owed table).

### 5.1 What landed

- **`release.yml`, two jobs.**
  - **The build matrix (`release`)** holds `contents: read`. It runs
    `npm run package -- … --publish never` and uploads exactly `dist/*-setup.exe`, `dist/*.dmg`,
    `dist/*.AppImage` and `dist/*.deb` with `actions/upload-artifact` (`if-no-files-found: error`,
    seven days).
  - **`publish`** holds the only `contents: write`. It downloads the four artifacts and writes
    `SHA256SUMS.txt` from them. It then creates the draft (tag `v<version>`, title `<version>`, as
    electron-builder named it) or reuses one, and uploads every file with the sums.
  - **The version** comes from the build jobs as a job output, since `publish` checks nothing out.
  - **Two failures `publish` refuses to paper over:**
    - a release of that tag that is **already published**;
    - a `gh release view` that failed for any reason other than "release not found". Without this, a
      second draft of the same name would be created.
  - **Workflow level:** `contents: read`.
- **`ci.yml`** says `contents: read` at the top, and gains the `lockfile` job.
- **`persist-credentials: false`** on all four checkouts.
- **`uses:` lines** are on exact tags: `actions/checkout@v7.0.1`, `actions/setup-node@v7.1.0`,
  `actions/upload-artifact@v7.0.2`, `actions/download-artifact@v8.0.2`. Each was read again from its
  *Releases* page when the round was built, and each was still the latest.
- **`.github/workflows/actions.lock`**, generated by `gh actions-lock` v0.2.0. Each locked commit
  was checked against the commit its tag points to (`gh api repos/<action>/commits/<tag>`), and all
  four agree:

  | Action | Locked commit |
  |---|---|
  | `checkout` | `3d3c42e5aac5…` |
  | `setup-node` | `949feb2413d6…` |
  | `upload-artifact` | `cf430e030ddb…` |
  | `download-artifact` | `9000827ccba6…` |

  The extension rewrote only the `uses:` lines, and the whole diff was read. The lockfile writes a
  commit as `sha1-<40 hex>`, which the test expects.
- **`.github/dependabot.yml`**, with exactly §2C's content. Prettier would rewrite its `["*"]` to
  single quotes, so it is in `.prettierignore` beside the generated lockfile, with the reason.
- **`npm ci --ignore-scripts`** in both workflows (§5.3).
- **Documentation:**
  - D-095 amended: the dispatch path now gets `SHA256SUMS.txt` too, and §2F's note is added.
  - D-121 is new.
  - R164's R167 section gains a "reshaped by R229" paragraph.
  - The README gains the two `gh release verify` commands.

**A setup trap, recorded for the next person.** On the development machine,
`gh extension install github/gh-actions-lock --pin v0.2.0` stopped every time at exactly
6,222,593 of the 11,922,944 bytes of `windows-amd64.exe` (`unexpected EOF`). It then left a
truncated binary that Windows refuses to run ("not a valid Win32 application"). `gh release download`
of the same asset completed, and matched the release's published digest (`sha256:b2531829…`). That
binary was copied over the truncated one. CI's Linux install was not affected.

### 5.2 Criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Node test reads both workflows; each assertion mutation-checked; unknown shapes throw | `test/workflowSecurity.test.ts`, 23 tests. Eleven mutations are kept as tests and must each be found (below). A reader without YAML dependencies throws on anchors, flow mappings, tabs, a second document, unreadable lines, duplicate keys and escapes, and on an unknown step key |
| 2 | The two greps print nothing; `--verify` exits 0 | Both print nothing. `--verify`: "All 2 workflows valid", locally and in the `lockfile` job |
| 3 | Locked commit in a run's log; the job shown to bite | Below |
| 4 | Token gone from a build job | Below |
| 5 | Rehearsal draft matches 1.2.2 | Below |
| 6 | §2E recorded per runner | §5.3 |
| 7 | `dependabot.yml` exact; no configuration error after merge | Content exact. The check after the merge is owed (§5.5) |
| 8 | Immutability on the first tagged release | Owed (§5.5) |
| 9 | First Dependabot actions PR | Owed (§5.5) |
| 10 | Documentation describes what landed | §5.1. No comment still says electron-builder uploads the artifacts |

**Criterion 1's mutations**, each applied to a copy of the real file, with the finding the test
requires:
- the workflow-level token raised to write;
- `ci.yml` without its `permissions:` block;
- the build job given `contents: write` ("2 jobs hold contents: write");
- a checkout added to `publish`;
- `npm ci` added to `publish`'s script;
- a checkout without `persist-credentials: false`;
- `setup-node@v7`, a major-only tag;
- `upload-artifact@v7.0.1`, a version missing from the lockfile;
- the extension installed without `--pin`;
- a locked commit cut short.

**The mutation pass found a defect in the test itself.** The step text was built with
`JSON.stringify`, which writes a newline as the two characters `\n`. `npm` at the start of a script
line then read as `nnpm`, `\bnpm\b` never matched, and **the `npm ci` in `publish` mutation passed
unnoticed**. The text is now the step's own strings, joined with newlines.

**Criterion 3, enforcement at run time.**
- The `lockfile` job's log on PR #63:
  ```
  Using locked action versions from the workflow's lockfile
  Download action repository 'actions/checkout@v7.0.1' (SHA:3d3c42e5aac5ba805825da76410c181273ba90b1)
  ```
  That is the lockfile's commit.
- **The bite was stronger than the plan expected.** On a scratch branch (PR #64, closed, branch
  deleted), `ci.yml`'s `setup-node@v7.1.0` was changed to `@v7.0.0`, which the lockfile does not
  cover. **GitHub refused to start the workflow at all**: `startup_failure`, with an annotation on
  `actions.lock` line 1, "Invalid lockfile: The lockfile could not be validated. Regenerate it by
  running `gh actions-lock`." No job ran, so the lockfile is enforced by GitHub before the `lockfile`
  job is reached, even without the *Require lockfile* policy.
- **The job's own check, separately.** `gh actions-lock --verify` on the same change exits 1:
  ```
  ✗ Unused lockfile entry actions/setup-node@v7.1.0
    lockfile pins actions/setup-node@v7.1.0 but no uses: in this workflow references it
  ```

**Criterion 4, the token gone from a build job.** A temporary step in the build job of the
`workflow_dispatch` rehearsal (run 39099858543), removed before merge, printed the same on all four
legs:
```
git config --get-regexp exit: 1
HTTP 403: Resource not accessible by integration (https://api.github.com/repos/mincowski/klados/releases)
gh release create exit: 1
```
`git config --get-regexp 'http\..*\.extraheader'` printed nothing.

**Criterion 5, the rehearsal draft.** `package.json` is at 1.2.2, which is published. So the
rehearsal's draft tag carried a temporary `-r229-rehearsal` suffix, removed before merge, and
`publish` did not need to refuse. The draft `v1.2.2-r229-rehearsal` had the same six asset names as v1.2.2 (`klados-1.2.2-mac-intel.dmg`, `klados-1.2.2-mac.dmg`,
`klados-1.2.2-setup.exe`, `klados-1.2.2.AppImage`, `klados_1.2.2_amd64.deb`, `SHA256SUMS.txt`).
Sizes differed from v1.2.2 by a few kilobytes, as builds of a later commit do. All five files were
downloaded from the draft, and `sha256sum -c SHA256SUMS.txt` reported `OK` for each, exit 0.
**No git tag was created** (`git ls-remote --tags` shows none). The draft was deleted afterwards,
per D-095.

*The download itself needed care on this machine*, the same trap as the extension's: `gh release
download` failed with `tls: bad record MAC` after about 2 MB of each file. `curl -C -` against the
asset API, one file at a time and resuming, completed all five.

### 5.3 §2E — `npm ci --ignore-scripts`, measured on every runner

Run on PR #63's CI and on the four legs of the rehearsal, which package as well as test:

| Runner | CI (install, typecheck, lint, build, `electron-builder --dir`, all tests) | Release rehearsal (tests, then the installer) |
|---|---|---|
| `ubuntu-latest` | pass | pass (AppImage, deb) |
| `macos-latest` | pass | pass (both dmgs) |
| `windows-latest` | pass | pass (NSIS) |

**Adopted in both workflows.** None of the six install scripts was needed, nor the project's own
`postinstall` (`electron-builder install-app-deps`: `npmRebuild: false`, no native modules).
Electron is installed explicitly by `npx install-electron` already (R221).

### 5.4 Review

The workflow diff was read before the first commit. Findings, all fixed before that commit:
- **`publish` would have created a duplicate draft** whenever `gh release view` failed for a reason
  other than "release not found". It now distinguishes the two; `gh`'s exact wording was checked.
- **The test's step text hid `npm` behind JSON escaping** (§5.2). This one came from the mutation
  pass, not the reading.
- **The test's YAML reader rejected `pull_request:` with no value**, which is valid YAML (null), and
  now reads it as empty.

**Two temporary pieces were removed before merge, and the final diff was read for both:**
- the token probe step;
- the `-r229-rehearsal` suffix on the draft's tag.

### 5.5 Checked after the merge, and still owed

**Checked on 2026-10-18:**
- **Release immutability is on.** The project lead switched it on, and
  `gh api repos/mincowski/klados/immutable-releases` reports `{"enabled":true,"enforced_by_owner":false}`.
  What it does to a published release is still criterion 8, below.
- **Criterion 7: Dependabot reads the configuration.** Its tab under *Insights → Dependency graph*
  lists the monitored files `.github/workflows/ci.yml`, `release.yml` and `actions.lock`, with no
  error banner. `dependabot.yml` itself is not listed, and is not expected to be: the page lists
  the manifests a configuration makes Dependabot watch, not the configuration file.
- **§2C: *Require lockfile* is not offered** to this repository: not found in its settings. Nothing
  depends on it. GitHub already refuses to start a workflow whose lockfile does not cover it (§5.2).

**Still owed:**

- **Criterion 8, on the first tagged release after this round.**
  - `gh api repos/mincowski/klados/immutable-releases` reports `"enabled": true`, and the release's
    own `immutable` field is `true`.
  - `gh release verify` and `gh release verify-asset` pass.
  - `gh release upload … SHA256SUMS.txt --clobber` is refused, and the refusal is quoted here.

  Immutability was switched on after the merge (above), so the README's description holds.
- **Criterion 9, at the first Dependabot pull request for an action:**
  - whether it changed `actions.lock` in the same PR;
  - whether the `lockfile` job was green;
  - if it was a security update that left the lockfile alone, the manual step goes in
    `docs/FINDINGS.md`.

  Note §5.2's finding: a PR whose lockfile is stale is refused by GitHub before any job runs, so that
  failure will look like `startup_failure`, not like a red `lockfile` job.

