# R140–R144 — publication: history, releases, the rename, and a README for users

<!-- status: built-caveat -->

**R144 (§7, the rename) built — see §9's Results. R140–R142 are still open.** Register:
`docs/TASKS.md`. The round `ci.yml`'s own header comment defers to by name — *"Deliberately not in
scope: release/packaging automation, signing or notarization. Those belong to the publication
round."* Four tasks: reset the published history and scope the identity (R140), build and publish
platform artifacts from a tag (R141), rewrite the README for people who will never read `docs/`
(R142), and **rename the application to Klados** (R144, §7) — done first, per the ordering note
below.

**The name question is now answered, and the answer changed the product's name.** `CONCEPT.md`
§13's first open question — *"check GitHub, npm and trademark registers for 'NodePad' before
committing"* — was finally checked, and **NodePad does not survive it** (§6). The application
becomes **Klados** (D-086), with a new mark (D-087). **R144 must land before R140's push**: every
cost of renaming is paid in published artifacts — the repository URL, the release URLs, `appId`,
`productName`, every screenshot and every external link.

**Every question in this document is settled.**

---

## 1. What is actually left before a release

Worth stating plainly, because the answer is "not features".

`docs/TASKS.md`'s board now shows every range built except `R84–R85` (a Settings category) and this
document. `R132` and `R138–R139` landed the predicate work, `R134–R136` the namespace work. That
covers `CONCEPT.md` §12's **M0 through M7 in full**. What remains of the concept is **M8 (YAML)** —
opened as `R143`, whose investigation landed but whose parser did not — and the "Later" bucket:
XPath, schema validation, structural edits, per-column expansion, stacked grids, background
eviction, a plugin API.

So the gap between "today" and "a first release" is publication mechanics, not code. The Owed table
is the honest list of what ships imperfect, and none of it blocks the release:

- **`npm run test:large` fails** (worker timeout, ~21 min run). It is not in CI and not in the
  release path. Disclose it in the developer section rather than fixing it under release pressure.
- **Activating a minified 10 MB document's tab takes ~2.5 s.** Real, user-visible, and the fix is a
  live `EditorView` per tab — a larger change than a first release should carry.
- **`.github/workflows/ci.yml` has never run.** R141's first push closes this Owed row, which is the
  one item on the list that publication *fixes* rather than defers.

Two more arrived with the namespace round and are worth stating here rather than leaving in the
Owed table, because they are the only entries a *user* of `1.0.0` can hit:

- **A prefixed path query does not resolve against the document's declarations** (R137, not built),
  so `//inv:price` matches on the raw spelling rather than the URI. It fails as "no matches", not as
  a wrong answer.
- **Namespace resolution silently reverts after an edit.** R134–R135's state survives opening a
  document but not `subtreeSplice.ts`'s incremental-reparse graft, so an edited document falls back
  to raw names until it is reopened. This one deserves a line in the README's limits section — it
  looks like a bug because it is one, and a user who hits it with no disclosure will report it as
  data corruption rather than a known gap.

## 2. R140 — reset the history, scope the identity

**The repository is published starting from a fresh history, with commit identity scoped to a
GitHub `@users.noreply.github.com` alias.** This section is the mechanics of doing that once,
correctly, and the traps found doing it.

**Facts, measured rather than assumed** (re-checked after R144): several hundred commits, all from a
single author; `.git` under 10 MB; no remote configured; `LICENSE` names no individual.

**A contact address in a test fixture is the trap worth naming**, because it is the one thing no
history rewrite reaches. `test/fixtures/toml/cargo-style.toml` carries an `authors = [...]` line
as part of its Cargo-shaped content, and **that is file content, not commit metadata**, so it
survives every mechanism in this section. R144's rename walked past it deliberately — scrubbing it
belongs to this task rather than to a rename (§9).

Generalised, since the specific file matters less than the shape: **before resetting a history,
grep the working tree, not just the log.** Addresses live in fixtures, changelogs, mailmaps,
`package.json` author fields and licence headers, and none of them care what you do to the commit
graph. This document had the same problem in its own draft, and fixing it is why the passage you
are reading no longer quotes anything.

### What it costs, so the choice is made with the number in hand

**22 short commit hashes are referenced across `docs/`** — in `DECISIONS.md`, `LOG.md`, `TASKS.md`
and five plan documents (`a50ceff`, `30f1737`, `c2fae60`, `174606f`, `89a0f94`, …). All 22 resolve
today. **All 22 dangle after any history reset**, whichever mechanism is used. This is not an
argument against resetting; it is an argument for keeping the old history somewhere, because those
references are the evidence behind decisions that are still in force.

**Archive the old history before touching anything**, somewhere outside the working tree:

```
git bundle create <path-outside-the-repo>.bundle --all
```

One file, complete, restorable with `git clone`. It is the difference between "the hashes point at
an archive" and "the hashes point at nothing".

### Mechanism: an orphan commit, not `rm -rf .git`

The two produce **the same published result**. The orphan branch is preferred for three reasons that
are all about the local repo rather than the remote: it is one reversible step until `gc` runs, it
cannot lose local config or hooks, and it leaves the old history reachable while you check the new
tree is complete.

### The identity, and the two mechanisms that set it

**The published identity is:**

```
name:  mincowski
email: 8300485+mincowski@users.noreply.github.com
```

The `@users.noreply.github.com` alias is designed to be public and will appear in every commit
from here on, so recording it here exposes nothing that pushing would not.

**Both mechanisms are used, and they are not alternatives.** The per-repo setting protects *this*
commit; the global rule protects every repository afterwards, including the ones not yet thought of.

**(1) Per repo, and it must happen before the commit exists** — otherwise the one squashed commit
that becomes the entire published history is authored by whatever the global config happens to say,
and the whole operation is redone:

```
git config --local user.name  "mincowski"
git config --local user.email "8300485+mincowski@users.noreply.github.com"
```

`--local`, not `--global`: every other repository on the machine keeps the real identity.

**(2) Globally, by remote URL** — git's conditional include, so any repo with a GitHub remote picks
this up automatically (`hasconfig:` needs **git ≥ 2.36**; 2.54 is installed here):

```
# ~/.gitconfig
[user]
	useConfigOnly = true
[includeIf "hasconfig:remote.*.url:**/*github.com*/**"]
	path = ~/.gitconfig-github
```
```
# ~/.gitconfig-github
[user]
	name  = mincowski
	email = 8300485+mincowski@users.noreply.github.com
```

**The glob is `**/*github.com*/**` and the widely-published one is wrong.** The pattern circulated
in write-ups of this technique is `**/*github.com/**`, described as matching HTTPS and SSH alike.
**It does not match the scp-style form** — `git@github.com:user/repo.git`, which is exactly what
GitHub's own SSH clone button hands you. Measured against all three URL forms:

| pattern | `https://github.com/…` | `git@github.com:…` | `ssh://git@github.com/…` |
|---|---|---|---|
| `**/*github.com/**` (the common advice) | matches | **misses** | matches |
| `**github.com**` | misses | misses | misses |
| **`**/*github.com*/**`** | matches | matches | matches |

The cause is that git matches these with pathname semantics — `*` does not cross `/` and `**`
spans only complete path components — and the scp form has no `/` before the host at all.

**`useConfigOnly = true` is the backstop that makes the miss survivable**, and it was verified
rather than assumed: with no matching remote, git refuses the commit with *"Author identity
unknown"* instead of falling back to the real global identity. One consequence to accept knowingly —
it is global, so **any local-only repository with no remote will refuse commits** until given an
identity.

GitHub → Settings → Emails is where the alias comes from, and where **"Keep my email addresses
private"** and **"Block command line pushes that expose my email"** live. Turn both on; the second
makes GitHub *reject* a push that would expose the address, so a future forgotten `--local` fails
loudly rather than publishing quietly.

**Why keep (1) when (2) exists.** `hasconfig` evaluates against a remote that is already
configured, and this round's order is *commit, then create the repo, then push* — so at the moment
of the only commit that matters there is no remote and the global rule contributes nothing.
Re-ordering (create the empty repo and `git remote add origin` first) would fix that and is a
legitimate alternative; it is not chosen, because the identity on this one commit is worth an
explicit setting that `git config --local user.email` can confirm in one command, rather than a
glob configured minutes earlier whose obvious form has just been shown to have a hole in it.

### The commit itself

```
git checkout --orphan initial
git add -A
git commit -m "Klados 1.0.0"
git branch -D main
git branch -m main
```

Verify before pushing — `git log --format='%an <%ae> | %cn <%ce>'` must show exactly one line, and
it must carry the intended identity in **all four** fields; author and committer are set
separately and it is the committer that a `-m` commit silently fills in from a different place.
Grep the working tree for any address or name that should not ship (see above — fixtures are where
they hide). Then `git reflog expire --expire=now --all && git gc --prune=now` if the old objects
should go locally too. **Do not `gc` until the archive exists and has been test-restored with
`git clone`** — until then the reflog is the only other way back.


### Rejected

- **`git filter-repo` to rewrite the author across the whole history.** Keeps the history —
  genuinely valuable here, since the 22 references stay live. Rejected because rewriting the author
  field leaves everything else: the commit *messages* are a development diary of dates, working
  hours and half-finished reasoning that was written for an audience of one and reads that way.
  Publishing a fresh history is a different decision from rewriting an old one, and this is the
  first. Worth reconsidering only if the 22 dangling references turn out to matter more than
  expected.
- **Squash-merge onto a fresh branch.** Same result as the orphan, more steps, and it briefly
  produces a commit with two parents that has to be reasoned about.

### The commit message

The squashed commit is the only one in the published history, so it is the one place a
`Co-Authored-By:` trailer could sit.

**Correction, found while executing this step: `CLAUDE.md` does not require that trailer and never
did.** An earlier draft of this section said it did. Every commit in the pre-reset history carries
one because the *agent's own environment* adds it, not because the project asked — and that is the
right arrangement: whether to claim co-authorship is a decision for whatever is doing the
implementing, not a rule the repository imposes on it. Nothing in `CLAUDE.md` needs changing.

So the trailer is optional here and accurate if used. **It is not the disclosure**, and should not
be relied on as one: after the reset exactly one commit carries it, where before there were 374.
R142's README section (§5) is what actually tells a reader how this was built.

## 3. R141 — platform builds as GitHub releases

`electron-builder.yml` is already complete: `nsis` for Windows, `dmg` for macOS, `AppImage`/`snap`/
`deb` for Linux, with `artifactName` templates and icons under `assets/build/`. **Nothing about the
packaging configuration needs designing — only the workflow that runs it on three operating
systems.**

A new `.github/workflows/release.yml`, triggered on `v*` tags, matrix over `windows-latest`,
`macos-latest`, `ubuntu-latest`, running `npm ci` then `npm run package -- --publish always` with
`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and `permissions: contents: write`. electron-builder infers
the GitHub provider from the repository, and its default `releaseType` is **draft** — artifacts
accumulate on a draft release from all three runners and you publish it by hand once you have looked
at it. That default is worth keeping rather than overriding.

Four things that are not obvious and each of which produces a bad first release if missed:

**(a) The tag and `package.json` must agree.** electron-builder takes the version from
`package.json` and the release name from the tag; they are not connected, so a `v1.0.0` tag against
a stale `package.json` version produces a release named for one version containing files named for
another. **The version is `1.0.0`, set during R140's pre-reset housekeeping** rather than left to
R141 — the single published commit then reads `Klados 1.0.0` and the tag has something to agree
with before the workflow ever runs.
Assert it as a step, and fail the job — this is a two-line check that prevents a re-tag.

**(b) Drop `snap` from the release targets.** It needs `snapcraft` on the runner, and a `.snap` that
is not in the Snap Store is worse than no `.snap` at all — users cannot install it without
`--dangerous`. AppImage and `.deb` cover Linux for a first release. Leave the target in
`electron-builder.yml` for local builds if wanted, but override on CI.

**(c) macOS ships two architectures or it ships one.** `macos-latest` is arm64; without explicit
`--x64 --arm64` (or a universal build) the release has no build for Intel Macs, silently.

**(d0) The release workflow is the first thing that ever ran this suite on Windows or macOS**,
and that is a gap rather than a detail. `ci.yml` runs only `ubuntu-latest`, so the first `v1.0.0`
tag failed on `windows-latest` with three simultaneous timeouts — `xmlFormat` depth-9000 at
6.2 s, `jsonParser` depth-9000 at 6.8 s, and `pathQueryJob`'s 400,000-candidate suspension at
8.4 s, all against Vitest's 5 s default.

**Fixed in the config, not per test.** Two had already been patched individually and three more
appeared the moment a new platform ran, which is the signature of a mis-sized default rather than
of five bad tests: this project invariant-tests its parsers (M0-PLAN B12), so heavy cases are
normal here. `vitest.config.ts` now sets `testTimeout` and `hookTimeout` to 30 s — ~3.5× the
slowest observed — per project, since `projects` entries carry their own resolved config rather
than inheriting a root value. **No assertion weakens**: none of those tests measures elapsed time,
and where this project does budget performance it does so explicitly with
`expect(elapsed).toBeLessThan(...)`, so the timeout is a hang guard rather than a performance gate.
Verified by a throwaway 7-second test in each project, which the old default would have failed.

**The ordering problem is the real lesson, and it is not fixed here.** Platform-specific failures
are currently discovered by the release workflow, which runs *after* a version tag has been spent.
Making `ci.yml` a three-OS matrix would move that discovery before the tag; it costs roughly three
times the CI minutes, which are free for a public repository. Recorded rather than done, because it
changes what every push costs and that is a call for the maintainer.

**(d1) A fixed sleep is not a wait, and this one blocked the release twice.**
`documentSession.test.ts` flushed a debounced reparse with `setTimeout(resolve, 40)` — a guess at
how long a near-zero debounce timer plus the graft's own `setTimeout(0)` chain take. It held on a
development machine, was recorded as a local-only flake, and then failed the `v1.0.0` build on
`windows-latest` with `storeChanges` reading 0 instead of 1.

**Fixed by waiting for the condition instead of for a duration**: the helper now polls until the
session's snapshot stops changing, with a 40 ms quiet window and a 5 s ceiling that throws rather
than silently passing. No duration is correct here — too short flakes on a loaded runner, too long
makes thirteen call sites slow — and quiescence is what every call site actually wanted. It also
*keeps* the "exactly one reparse" assertions honest: a burst that wrongly produced three would still
be quiet by the time the helper returns, and the count would still catch it.

Two identical copies of the helper existed in different `describe` blocks; the fix is hoisted to one.
Verified with five consecutive runs of the file and two full-suite runs, all green.

**(d) Everything is unsigned, and that is a user-facing fact, not a footnote.** `notarize: false`,
no certificates. Windows shows a SmartScreen warning; macOS refuses the first launch and needs
right-click → Open. **This belongs in the README's install section** (R142), phrased as instructions
rather than an apology. Code signing is a paid certificate and its own round; do not attempt it
here, and do not quietly leave users to discover it.

### Two installer decisions, taken after building one locally

`npm run package` was run before planning this, and the artifacts and paths below are **measured
from the built installer and from the packaged app's own `app.getPath()`**, not read off the
config. What it confirmed: Windows produces `klados-1.0.0-setup.exe` (169 MB) and **no portable
build** — `target` is set only under `linux`, so Windows and macOS take the defaults — installing
per-user to `%LOCALAPPDATA%ProgramsKlados` with `oneClick=true perMachine=false`. Both are
kept deliberately: a portable Windows build is not wanted, and a one-click per-user install (no UAC,
no options page) is the right default for a small free tool.

**(e) No desktop shortcut.** `electron-builder.yml` currently sets
`nsis.createDesktopShortcut: always`, and `always` is the **most intrusive of the three settings**,
not a neutral one — `convertToDesktopShortcutCreationPolicy` maps it to `ALWAYS`, which recreates
the icon **on every update even after the user has deleted it**. (The unset default is
`FRESH_INSTALL`, first install only; `false` is `NEVER`.) Set it to **`false`**: a viewer people
open from a file association or the Start menu does not earn a permanent place on the desktop.

Safe to do because the Start-menu entry is independent and stays —
`isCreateStartMenuShortcut: options.createStartMenuShortcut !== false`, so it is created unless
explicitly disabled, and nothing here disables it. Verified in `app-builder-lib` rather than
assumed, because removing the only way to launch the application would be a bad way to find out.

**(f) `Klados` and `klados` should agree.** The install directory is `Klados` (from
`productFilename`) while the settings directory is `%APPDATA%klados` — confirmed by launching the
packaged app and reading `app.getName()`, which returns `klados` because the packaged manifest
carries `name` and **no `productName`**. Cosmetic, and worth fixing before anyone has a profile.

**Verified rather than assumed, and the declarative fix works.** `productName: "Klados"` moved
*into* `package.json` and *out of* `electron-builder.yml`. Measured on a rebuild: the field
survives electron-builder's manifest filter, and the packaged app reports

```
app.getName()          -> "Klados"
app.getPath('userData') -> %APPDATA%Klados
```

read back from the launched binary, not inferred. `app.setName()` was the fallback and is not
needed.

**One source of truth, not two.** `appInfo.js` resolves
`config.productName || metadata.productName || metadata.name`, so the packager falls through to
`package.json` and produces identical artifacts — verified by rebuilding after the removal and
confirming the executable is still `Klados.exe`. Keeping it only in `electron-builder.yml` was the
actual bug: that file is not shipped inside the app, so the packager saw `Klados` while the
*runtime* never did and fell back to `name`. This is what Electron's own guidance describes —
`name` short and lowercase, `productName` the capitalised display name, preferred by
`app.getName()`.

**A Windows footnote that matters for the next platform.** The on-disk directory is *still*
`klados`: NTFS is case-insensitive, so Windows reused the existing folder rather than creating a
new one. The change is genuinely invisible here — and would not have been on macOS or Linux, which
is the whole argument for doing it before the first release.

**Why before the first release, specifically.** On Windows the filesystem is case-insensitive, so
`klados` and `Klados` are the same directory and the change costs nothing. On macOS and Linux they
are **different directories**, so making this change after people have installed would strand every
setting they have — the same relocation R144 caused deliberately, but this time for a cosmetic
reason and without warning. There are no installs yet; this is the free moment.

## 4. R142 — the README

### What is wrong with the current one, checked against the tree

1. **It says "Pre-alpha — not yet usable."** That was true. Publishing a release under it is a
   contradiction the reader resolves by closing the tab.
2. **`[M0-PLAN.md](M0-PLAN.md)` is a broken link** — the file is at `docs/plans/M0-PLAN.md`.
3. **"Third-party notices are generated at build time into `THIRD-PARTY-NOTICES.txt`" is false.**
   `.gitignore` reserves the path, and **no script anywhere generates it** — not in `scripts/`, not
   in `package.json`, not in `electron-builder.yml`. Either generate it or delete the sentence. A
   README that describes a file the build does not produce is the same class of defect this project
   keeps finding in its own plans.
4. **It never says which formats work today.** XML, JSON and TOML are built; YAML is not. The
   description line in `package.json` ("and later TOML and YAML") is stale on the TOML half.
5. **There are no screenshots.** One exists — `docs/screenshots/title-bar.png` — and it is of the
   title bar. A three-pane tool whose entire proposition is visual needs a picture of the three
   panes with a grid in them, above the fold.
6. **It is developer-first throughout.** Prerequisites and `git clone` are the fourth thing on the
   page. For a released product, "download and run" comes first and the developer material moves to
   its own section, which is what was asked for.

### Structure

Users first, developers second, in this order: what it is (one paragraph, plus the table
proposition, plus a screenshot) → **Download** (three platforms, with the unsigned-build
instructions from §3(d)) → what it does today, with the format table and honest limits → keyboard
essentials → **How this was built** (§5) → **Development** (everything the current README has, kept
almost verbatim — it is good, it is just in the wrong place) → Contributing → License.

The user-facing feature list is written from the board, not from the concept: three synchronized
panes; repeating children as a grid with sorting, filtering, pinned columns and CSV export; find
with text and path-query modes (`cars//price`, `car[@id="c-001"]`, `car[3]`, `*`) and replace;
tabs with session restore; format and minify; byte-identical saves; original encoding preserved,
including single-byte legacy code pages, which are editable as of R125. **Limits stated in the same
voice, not buried**: YAML is not implemented; there is no diff, no schema validation and no
transformation (`CONCEPT.md` §1's non-goals, which are load-bearing for expectations); the 10 MB
minified tab-activation delay from the Owed table.

### Keyboard section

`Ctrl+Shift+P` opens the command palette and **every command is reachable from it** — invariant 10,
enforced by test. That single sentence plus `F1` for the shortcuts panel is worth more than a table
of 40 bindings, because the palette is the discovery mechanism the app was designed around. Give
six or seven bindings (`Ctrl+O`, `Ctrl+F`, `Ctrl+H`, `Ctrl+1`/`2`/`3`, `Ctrl+Shift+L`) and point at
`F1` for the rest.

## 5. The AI-authorship note

**There is no standard clause.** No SPDX identifier, no OSI text, no widely adopted badge or
`AI-DISCLOSURE.md` convention covers "this repository was written by an AI under human supervision".
The nearest real conventions are commit trailers — `Co-Authored-By:` and `Generated with` — which
this project already uses and which R140 reduces to a single commit. So the wording is ours to
choose, and it should be plain rather than legalistic.

Proposed, as a top-level `## How this was built` section between the user and developer halves:

> NodePad was written by AI — Claude, working in Claude Code — under human supervision. Every round
> of work was planned, reviewed and accepted by a human maintainer, and the design, the decisions
> and the priorities are theirs; the great majority of the code, tests and documentation is
> machine-authored.
>
> This is disclosed because it is a reasonable thing to want to know before running an editor on
> your files. It is not a disclaimer about quality: the invariants in `CLAUDE.md`, the test suite,
> and a review pass on every task exist precisely so that supervision means something. Judge it the
> way you would judge any other project — by whether it does what it says on files you care about.

Two properties worth keeping if the wording is changed: it **names what the human did** (rather than
the vague "with human oversight", which could mean anything), and it **does not apologize**. A
hedged disclosure invites the reader to assume the worst about code that has more process behind it
than most.

## 6. The name was checked, and NodePad did not survive it

`CONCEPT.md` §13's first open question, unanswered since the design was written:

> **Name availability** — check GitHub, npm and trademark registers for "NodePad" before committing

**Checked. Three findings, any one of which is disqualifying.**

**(a) Google corrects the query.** Searching "NodePad" returns results for *Notepad*. That is not an
SEO problem with a fix; a search engine actively rewriting your name means you never win it.

**(b) An active, larger project owns it.** `mskayyali/nodepad` is a spatial AI research canvas —
**1.1k stars**, MIT, and backed by a commercial product at **node-pad.com** with paid plans from
$5/month, operated by The Palaz Company. Same word, same channel (GitHub search), a developer-
adjacent audience, and growing.

**(c) The npm name is taken** — `nodepad` v0.1.1, published 2011 by a different author. Irrelevant
for an Electron app that will never be published to npm, but it closes the last free surface.

**Trademark registers remain unchecked and that is not for want of trying.** TMview and EUIPO
refuse programmatic requests outright, WIPO's Global Brand Database is behind an anti-bot
challenge, USPTO's endpoint rejects both GET and POST, and DPMAregister is a session-bound form
that returns only its own search page. **The register check is a manual step that belongs to
whoever runs R144**, against [DPMAregister](https://register.dpma.de/DPMAregister/marke/einsteiger)
and [EUIPO eSearch](https://euipo.europa.eu/eSearch/), filtered to **class 9** (software) and
**class 42** (SaaS / software development) — the only two classes that matter here. A NODUS- or
KLADOS-formative mark in watches or pharma is not a conflict.

**The replacement is `Klados` — see D-086 for the decision and what was rejected.** What matters
to this plan: GitHub is effectively empty (top three hits at 2★), and **`klados.io` and
`klados.app` are both unregistered** (`klados.dev` is taken). Confirm the domains at a registrar
before the push rather than trusting the RDAP check, which can lag.

## 7. R144 — the rename

### 7a. The mark, and the one discrepancy to fix first

The mark stops being a letterform with node dots. **The chosen design is `3b-ii`** from
`Klados icon dot placement exploration/` — a stem, an arm meeting it, and a leg branching off
*the arm* rather than off the stem, so the figure carries **two** branch points. It reads as a mark
before it reads as a K, which is the point (D-087).

**The exploration folder does not contain it.** Its top-level `mark.svg`, `mark-16.svg`,
`icon.svg` and `icon-macos.svg` all carry **`3b-i`** — the same construction with the leg
splitting lower on the arm — and `alternates/` holds only `3a-i` and `3a-ii`. So `3b-ii`
exists **only inside the canvas HTML**, which is untracked and disposable. Its geometry is
therefore recorded here, and this is the authority:

| | Chosen — `3b-ii` | Delivered by mistake — `3b-i` |
|---|---|---|
| 64 grid, `stroke-width="5"` | `M20 18V48M46 17Q33 22 20 33M37.08 21.14Q44 34 49 48` | `M20 18V48M46 17Q33 22 20 33M33 24Q41 35 48 48` |
| 16 grid, `stroke-width="2"` | `M5 4V12M11 4L5 9M9.21 5.49L12 12` | `M5 4V12M11 4L5 9M8 6L12 12` |

The difference is only where the leg leaves the arm — `(37,21)` rather than `(33,24)`, a higher
split and a longer leg. Round caps and joins throughout, unchanged. **Fix the four SVGs to the left
column before moving anything into `assets/`**, then regenerate:

```
uv run --with resvg-py --with pillow tools/generate.py
```

Everything else in `assets/README.md` survives untouched and should be left alone: the tile
gradient, the radius, the border, the bevel, and the two ambers — `#E9A33C` inside the app and
`#A9701E` where the surrounding theme is unknown. **Those amber values are measurements, not
preferences** (3.77 and 3.90 against light and dark; `#E9A33C` fails at 1.94 on light), and the new
mark changes nothing about them. `assets/build/NodePad.iconset/` becomes `Klados.iconset/`, which
`tools/generate.py` writes and must be updated to match.

### 7b. The surfaces, counted rather than estimated

| Where | `NodePad` | Note |
|---|---|---|
| `src/` | 57 | plus **77 `nodepad.*` command ids** and **8 `nodepad.*` `localStorage` keys** |
| `test/` | 78 | |
| `docs/` | 133 | see 7c — not all of these change |
| `assets/` | 15 | includes `aria-label="NodePad"` in all four SVGs |
| `tools/` | 7 | `generate.py`'s iconset path |
| `electron-builder.yml` | 4 | `appId`, `productName`, `win.executableName`, the macOS usage strings |
| `README.md` / `CLAUDE.md` | 3 / 1 | |

`package.json` contains no `NodePad`, but its `name` is `nodepad` and its `description` is
**independently stale** — it still says "and later TOML and YAML" when TOML shipped at R14–R17.
Fix both in the same edit.

**The 77 command ids should be renamed too.** They are internal, but they are the most-read
identifiers in the renderer and would otherwise be a permanent fossil. The rename is well guarded:
invariant 10's "every command reachable from the palette" test is exactly the check that no id was
half-renamed. Do it as its own commit.

**The 8 `localStorage` keys are the non-obvious one, and they cost nothing — for a reason worth
writing down.** `nodepad.layout`, `nodepad.theme`, `nodepad.zoomFactor`,
`nodepad.recentFiles`, `nodepad.sessionRestore`, `nodepad.palette.recency`,
`nodepad.formatMinifiedOnOpen` and `nodepad.totalMemoryBudgetBytes` all reset when renamed. But
**changing `appId`/`productName` relocates Electron's `userData` directory anyway**, which moves
the Chromium profile that holds `localStorage` and orphans `keybindings.json` with it. The stored
state is lost the moment the app is renamed, whatever the key names say — so rename the keys, and
do not write a migration for state that the profile move has already stranded. Nobody is affected
but a developer's own working copy — the application has never shipped.

### 7c. The one judgment call: which documents change

**Product surfaces change; historical records do not.**

Change: `README.md`, `CLAUDE.md`, `docs/CONCEPT.md`, `docs/FINDINGS.md`, `docs/TASKS.md`,
`assets/README.md`, and every string a user or a contributor reads as *current*.

**Leave the old name where a document is describing what happened**: `docs/LOG.md`'s entries,
`docs/DECISIONS.md` entries written before D-086, and the Results sections of plan documents. Those
record a product that was called NodePad at the time, and rewriting them makes them lie about their
own subject. This is the same argument `CLAUDE.md` already makes for never renaming an `R` id —
*"renaming settled history would invalidate every cross-reference for no gain"* — applied to the
product name instead of a task number.

The counter-argument is real and was considered: R140 wipes the git history, so a reader has no
"before" to reconcile against. It loses because **`docs/` is now the only history there is**, which
makes preserving it more important after the reset, not less.

### 7d. Order

1. Fix the four SVGs to `3b-ii` (7a), move them into `assets/`, regenerate, eyeball at 16px.
2. Rename the 77 command ids. Own commit; the palette-reachability test is the check.
3. Rename the 8 `localStorage` keys.
4. `package.json`, `electron-builder.yml`, `tools/generate.py`, the iconset directory.
5. Source and test strings.
6. The documents in 7c's "change" list — R142's README rewrite folds in here rather than being
   done twice.


## 8. Acceptance criteria

1. `git log --format='%an <%ae> | %cn <%ce>'` on the published branch produces exactly one line,
   carrying the intended identity in all four fields.
2. A grep of the whole working tree finds no address or name that should not ship — **fixtures
   included**, since content survives what history rewriting does not.
3. The archive exists and `git clone` from it reproduces a repository in which all 22
   doc-referenced hashes resolve. Asserted by cloning, not by assuming.
4. Pushing to GitHub triggers `ci.yml` and it **passes** — the first time it has ever run
   (`docs/TASKS.md` Owed). If it fails, that is a finding to fix, not a workflow to disable.
5. **The installed application creates no desktop shortcut, and does have a Start-menu entry** —
   checked by installing the built artifact, not by reading the config.
6. **`app.getName()` returns `Klados`** in the packaged app, so the settings directory matches the
   install directory in case. Asserted by launching the built binary and reading the path back.
7. A `v1.0.0` tag produces a draft release carrying, at minimum: an NSIS installer, a `.dmg` for
   **both** macOS architectures, an AppImage and a `.deb`.
6. A version/tag mismatch fails the release job with a message naming both values, asserted by
   pushing a deliberately mismatched tag to a scratch branch once.
7. Each artifact **launches** on its platform and opens a file. Downloaded from the draft release,
   not from a local `dist/` — the point is to exercise what a user gets, including the SmartScreen
   and Gatekeeper prompts the README now describes.
8. The README contains no broken relative link and no claim about the build that the build does not
   satisfy — specifically, `THIRD-PARTY-NOTICES.txt` is either generated by a committed script or
   unmentioned.
9. The README states which formats are implemented today and which are not, and `package.json`'s
   `description` agrees with it.
10. A screenshot of the three panes with a populated grid appears before the download section.
11. **No `NodePad` or `nodepad` remains** in `src/`, `test/`, `assets/`, `tools/`,
    `package.json`, `electron-builder.yml`, `README.md`, `CLAUDE.md`, `docs/CONCEPT.md`,
    `docs/FINDINGS.md` or `docs/TASKS.md` — asserted by `git grep -i nodepad` over that list, not
    by inspection. `docs/LOG.md`, `docs/DECISIONS.md` and plan-document Results sections are
    deliberately excluded (§7c).
12. **The shipped mark is `3b-ii`, not `3b-i`** — the four SVGs match §7a's left column exactly,
    and `mark-16.svg` is rendered at actual size and looked at, not assumed.
13. `npm test` passes with the renamed command ids, **including invariant 10's palette-reachability
    test unmodified** — that test failing is the intended detection for a half-renamed id.
14. The DPMA and EUIPO register searches for `Klados` in classes 9 and 42 have been **run by a
    human** and the outcome recorded in `CONCEPT.md` §13 either way (§6).

## 9. Results — §7 (R144) only

**Built.** R140–R142 are unstarted; this covers only the rename.

**7a, the mark.** The four SVGs (`mark.svg`, `mark-16.svg`, `icon.svg`, `icon-macos.svg`,
`icon-flat.svg` — one more than §7a's table names, kept in sync since it shares the same path data)
now carry `3b-ii`'s path exactly, matching §7a's left column: `M20 18V48M46 17Q33 22 20
33M37.08 21.14Q44 34 49 48` at the 64 grid, `M5 4V12M11 4L5 9M9.21 5.49L12 12` at 16. Regenerated with
`uv run --with resvg-py --with pillow tools/generate.py`, which ran cleanly (`uv` fetched
`resvg-py`/`pillow` into a throwaway environment) and produced `Klados.iconset/` in place of
`NodePad.iconset/`; `tools/generate.py` itself renames the directory it writes and the comments
naming it. `mark-16.svg` rendered at 16×16 and looked at (`assets/build/icons/16.png`): the two
branch points read clearly at that size, not as a letterform.

**7b, the surfaces.** `nodepad.*` → `klados.*` across all 77 command ids and all 8 `localStorage`
keys (`klados.layout`, `klados.theme`, `klados.zoomFactor`, `klados.recentFiles`,
`klados.sessionRestore`, `klados.palette.recency`, `klados.formatMinifiedOnOpen`,
`klados.totalMemoryBudgetBytes`) — done first, as a blanket `nodepad.` → `klados.` substitution
(safe, since every use of that literal prefix in `src/`/`test/` is a command id, a storage key, or
`com.nodepad.app`'s `appId`), then a second pass for `NodePad`/`nodepad` wherever it appeared
outside that prefix: the `NodePadApi` interface and `getNodePadApi`/`fakeNodePadApi` helpers,
`toNodePadPath`, the `nodepad-file://` read-token scheme (`READ_TOKEN_SCHEME`, `main/documents.ts`
and `core/parseClient.ts`), ARIA ids (`nodepad-shortcuts-heading`, `nodepad-palette-*`),
`NODEPAD_TEST_LARGE` (env var gating `test:large`), the `mkdtemp` prefix in
`test/mainDocuments.test.ts`, and the product-name occurrences in `test/fixtures/toml/*.toml`
(the string "NodePad" only — the fixture's real-address line was left untouched, since scrubbing
it from history is R140's job, not this one). `package.json`'s `name` → `klados`; its
`description` was independently stale ("and later TOML and YAML", though TOML shipped at
R14–R17) and is now "XML, JSON and TOML, with YAML in progress." `electron-builder.yml`'s `appId`,
`productName`, `win.executableName`, both macOS usage strings and the Linux `maintainer` field all
changed. `LICENSE`'s "NodePad contributors" → "Klados contributors" and `.claude/launch.json`'s
dev-server config name — both outside §7b's table but the same class of surface, updated for the
same reason.

**7c, which documents change.** `README.md`, `CLAUDE.md`, `docs/CONCEPT.md`, `docs/FINDINGS.md`,
`docs/TASKS.md`, `assets/README.md`. `docs/LOG.md`, `docs/DECISIONS.md`'s pre-D-086 entries and
every plan-document Results section (this one included, above this line) keep `NodePad`.

**A defect the blind substitution introduced and review caught.** `docs/TASKS.md`'s own R144
register row and `docs/CONCEPT.md` §13 both **narrate** the rename — "NodePad fails on three
counts", `mskayyali/nodepad` (a real third party's actual repository name) — and a blanket
`NodePad`→`Klados` pass over those files turned that narrative into nonsense ("Klados becomes
Klados", `mskayyali/klados`, a fabricated GitHub handle). Caught reading the diff before commit,
not after: `docs/TASKS.md`'s register entry and `docs/CONCEPT.md` §13 were hand-corrected to keep
`NodePad` exactly where the sentence is *about* the old name, while every other occurrence in those
same files (which describe the product *as it is now*) stayed `Klados`. Worth recording because it
is exactly the kind of defect a search-and-replace makes invisible to itself — the tool has no way
to distinguish "the current name" from "the name this sentence is naming."

**A second thing fixed in review: a stale measurement, not a stale name.**
`TitleBar.css`'s alignment comment cited `TextMetrics.actualBoundingBox{Ascent,Descent}` "for the
'N' glyph" — measured against NodePad's capital N specifically. The glyph reference now says "K"
(Klados's initial), but **the pixel values themselves (9px cap-height ink, top 14.5/bottom 23.5)
were not re-measured** — carried forward on the assumption that a sans-serif capital K's ink
bounding box matches a capital N's closely enough (both are flat-topped strokes with no overshoot,
unlike a round letter). Not verified against the running app in this session; recorded in the Owed
table rather than asserted as re-confirmed.

**A third defect, caught by actually looking at the running app rather than trusting the source
edit.** `TitleBar/Mark.tsx` does not import `assets/mark-16.svg` — it duplicates its path data
inline in JSX, which `assets/README.md`'s own doc comment names as the reason (`currentColor` plus
a theme token, no raster). Editing the four *files* under `assets/` therefore never touched what
the title bar actually renders: the running app still showed the retired N-with-node-dots mark
after every other change landed. Found by opening the dev server and reading the rendered
`<path d>` back out of the DOM, not by inspecting the diff. Fixed in the same commit — `Mark.tsx`'s
inline path now matches `mark-16.svg`'s `3b-ii` geometry exactly, and the two node circles are
gone. `test/titleBarInkAlignment.test.tsx` passes unmodified against the new geometry.

**Verification.** `npm run typecheck` passes clean across all four projects. `npm test` passes with
the renamed command ids and storage keys — invariant 10's palette-reachability test included,
unmodified, and green — confirming no id was half-renamed. Two full-suite runs in this session each
showed a small, *different* set of failures (timing/render-count assertions in
`documentSession.test.ts`, `jsonParser.test.ts`, `namespaceResolution.test.ts`,
`documentPropsRenderCost.test.tsx`), all of which passed when the same files were run in isolation
or against an unmodified `git stash` of the tree — pre-existing environment flakiness under full
parallel load, not something this round introduced.

**Not done, and not silently dropped.** Criterion 14 (the DPMA/EUIPO manual register search) is a
human step this session cannot perform and remains open. R140–R142 are untouched.

