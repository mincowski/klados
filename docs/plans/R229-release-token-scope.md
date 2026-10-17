# R229 — no write token where third-party code runs, locked actions, and immutable releases

<!-- status: open -->

**Open.** Planned from the security review of 2026-10-16, finding 1 (medium), and widened by the
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
