# R172–R174 — freeze the published identity before the first release

<!-- status: built-caveat -->

**Built, with one check owed.** Register: `docs/TASKS.md`. **No winget submission happened here**,
and none is implied.
The goal was that when one is decided on it needs *zero changes to this repository* — every field a
package manager correlates against already correct, already frozen, and now enforced by
`test/publishedIdentity.test.ts` rather than by a comment. §11 records what landed, including the
one thing this plan got wrong about itself — and what it owes: nobody has run the installer and read
the values back out of a real machine's registry, which is what acceptance 1 asks for.

---

## 1. Why this is a round, and why now

A package manager does not install a file; it adopts an *identity*. Once a release ships, four
strings become the handle everything downstream uses to recognise Klados as Klados: the uninstall
registry key, the Publisher and DisplayName written beside it, and the installer's URL. Change any
of them afterwards and existing installs are orphaned — no upgrade detection, no matching uninstall
entry, and a package manager that believes the old and new versions are different products.

**This project has already had that thought once and acted on it.** `electron-builder.yml`'s
`nsis.guid` is pinned rather than derived, under a comment that says exactly why: *"Package
managers and updaters key installed state off that name, so changing `appId` later would silently
orphan every existing install."* R172 is the rest of that same argument applied to the fields the
GUID comment did not reach.

The trigger was a question about winget's `PackageIdentifier` — whether to be `klados.Klados`
(project as publisher, the common convention) or `mincowski.Klados`. That question turned out to be
the least binding part of it: **the identifier is not a repository artifact at all**, it lives in
`microsoft/winget-pkgs`. What binds is everything the identifier has to correlate with, and that is
all in here.

**No release has shipped yet, so all of this is free today and expensive after.** That asymmetry is
the whole reason to do it now rather than when a submission is actually wanted.

## 2. What a package manager actually keys off — verified, not assumed

Resolved by constructing electron-builder's own `AppInfo` against this repository's real
`package.json` and reading the values it computes, rather than by reading its source and inferring
(`PLANNING.md` §2). The NSIS registry write was traced to
`app-builder-lib/templates/nsis/include/installer.nsh:133`.

| What lands on the user's machine | Current value | Where it comes from |
|---|---|---|
| Uninstall registry key name | `318f6304-c1a1-5b48-8b0d-d9b77e332a6b` | `nsis.guid` — **already pinned** |
| ARP `DisplayName` | `Klados` | `nsis.uninstallDisplayName` ← `productName` |
| ARP `Publisher` | **`mincowski`** | `AppInfo.companyName` ← `package.json` `author.name` |
| Debian `Maintainer` | `mincowski <8300485+mincowski@users.noreply.github.com>` | `author.name` + `author.email` |
| Copyright resource | `Copyright © 2026 mincowski` | `AppInfo.copyright` — `config.copyright` when set, **else** `Copyright © <build year> <companyName>` |
| Installer URL | `klados-<version>-setup.exe` | `nsis.artifactName` — **already stable by construction** |
| Install scope | per-user (`%LOCALAPPDATA%`, HKCU) | `oneClick` defaults true, `perMachine` defaults false |

**The finding that makes this round non-trivial: `author.name` answers three different questions at
once.** *Who publishes this software*, *who is responsible for the Debian package*, and *who holds
the copyright* have three different right answers, and one field is currently giving the same answer
to all three. That is the actual problem R172 solves; the winget question merely exposed it.

Three questions, but more than three outputs — the table above lists what a package manager keys
off, not everything the field reaches:

| Output | Path |
|---|---|
| ARP `Publisher` | `companyName` → `COMPANY_NAME` (`NsisTarget.js:492`) → `installer.nsh:133` |
| `Klados.exe` version resource, `CompanyName` | `companyName` (`winPackager.js:147`) |
| Installer `.exe` version resource, `CompanyName` | `companyName` (`NsisTarget.js:399`) |
| `Klados.exe` version resource, `LegalCopyright` | `copyright` (`winPackager.js:141`) |
| Installer `.exe` version resource, `LegalCopyright` | `copyright` (`NsisTarget.js:390`) |
| macOS `Info.plist`, `NSHumanReadableCopyright` | `copyright` (`macPackager.js:400`) |
| Debian `Maintainer` | `author.name` + `author.email` (`FpmTarget.js:85`) |

A Start-menu folder named after the company is an eighth, reached only when `nsis.menuCategory` is
`true` (`CommonWindowsInstallerConfiguration.js:12`). It is unset here, so it is not in play — noted
so that turning it on later is understood as adopting the publisher string, not a layout preference.

**Two of the three questions have an explicit override; one does not.** `linux.maintainer` and the
top-level `copyright` are both settable and both win before any derivation runs. `companyName` has
no override at all (`appInfo.js:90` reads `author.name` and nothing else), which is why R172a is a
`package.json` edit rather than a config line, and why R172b and R172c are the two pins that keep
that edit from reaching the other two answers.

## 3. The decisions to settle

### R172a — the publisher string

**`Publisher` should be `Klados`, not `mincowski`.** The project is what publishes the software;
this repository already made that call once, in `appId: com.klados.app`, which is namespaced to the
project rather than the maintainer. A user reading Add/Remove Programs is looking for the thing they
installed.

It also matches where a winget identifier would land (`klados.Klados`), which removes the one
inconsistency a reviewer would otherwise ask about.

### R172b — the maintainer string, which must *not* follow it

Debian's `Maintainer` field means *the person responsible for the package*, and its grammar is
`Name <email>`. It is correct today and would be quietly degraded by R172a, because both read the
same source. **`linux.maintainer` must therefore be set explicitly** to
`mincowski <8300485+mincowski@users.noreply.github.com>`, decoupling it from `author.name` before
that field changes meaning.

`FpmTarget.js:85` reads `options.maintainer` in preference to deriving one, so the override exists
and is the supported path. Note that `electron-builder.yml` currently carries a comment explaining
why `maintainer:` is deliberately *absent* — **that comment becomes wrong and must be rewritten**,
not left standing next to a line it now contradicts.

### R172c — the copyright string, which must not follow it either

**`copyright: Copyright © 2026 Klados contributors`**, pinned explicitly, exactly as R172b pins the
maintainer.

An earlier draft of this section said the copyright *"falls out of R172a"* and named the result
`Copyright © <year> Klados`. Both halves were wrong, and the correction is the reason this section
now exists as a decision rather than as a note.

**It does not fall out of anything.** `AppInfo.copyright` (`appInfo.js:129`) reads `config.copyright`
first and only derives `Copyright © <build year> <companyName || productName>` when that is unset.
`copyright` is a documented top-level electron-builder option, so this is a third *decision*, not a
side effect to be accepted.

**And `Klados` alone is the wrong holder.** Copyright vests in a person, natural or legal. There is
no Klados entity — no company, no foundation — so the notice would name a holder that does not
exist. A notice has not been a condition of protection since Berne, and the US dropped the
requirement in 1989, so this is inaccuracy rather than forfeiture; but it is inaccuracy that
**contradicts the repository's own operative document**, and that is the part that matters:

```
LICENSE:3:  Copyright (c) 2026 Klados contributors
```

Shipping a binary whose version resource says `Klados` beside a licence file that says `Klados
contributors` is two documents disagreeing about who holds the rights, one of them the one that
actually grants the licence.

`Klados contributors` is the ordinary convention for a project with no entity behind it — the same
shape as `Node.js contributors`, `Electron contributors`, `The Rust Project Developers` — and reads
as a collective handle for the natural persons who each hold copyright in their own contribution.

**Rejected: `mincowski`.** Strictly true today, since there is exactly one contributor, and a
pseudonym is no obstacle to it. Rejected because it contradicts `LICENSE` just as `Klados` does, only
in the other direction, and goes stale on the first outside pull request — at which point the notice
in the shipped binary is not merely unconventional but false.

**The year is frozen at 2026, deliberately.** The derived form recomputes it with
`new Date().getFullYear()` at build time; an explicit string cannot, because electron-builder's macro
expander has `${author}`, `${productName}`, `${version}`, `${arch}`, `${platform}` and `${channel}`
and **no year token** (`macroExpander.js`). So pinning trades a value that tracks the build clock for
one that states a fact: 2026 is when Klados was first published, which is what a copyright notice is
for. It matches `LICENSE`, and it is the value R173 asserts, so it cannot drift silently in either
direction.

### R172d — install scope and installer shape, which are also permanent

Not raised by the winget question, but in scope by the same argument, and **this is the item most
likely to be regretted if it is not decided deliberately**:

- **`perMachine`** — per-user today. Moving it later relocates the uninstall key from `HKCU` to
  `HKLM`, which is precisely the orphaning the GUID pin exists to prevent, and would additionally
  require winget's `Scope` to change.
- **`oneClick`** — a one-click installer today. Turning it off later changes the install directory
  from `%LOCALAPPDATA%\Programs` to `Program Files`.

The recommendation is to **keep both defaults** — per-user, one-click — because a file viewer does
not need administrative rights and per-user install is what lets `winget install` work without
elevation. What R172 asks for is that this is *recorded as a decision* in `DECISIONS.md` rather than
remaining an unexamined default, since its cost is entirely in changing it later.

### R172e — the identifier itself

`klados.Klados`. **Nothing in this repository changes for it**, which is the point worth recording:
it lives in the winget-pkgs manifest, matching is case-insensitive, and the exact casing is
confirmed against that repository at submission time. It is written down here so the decision is not
re-litigated later.

## 4. R173 — lock the values with a test

Every value in §2 is a string in a config file that reads like a formatting preference and is
actually a compatibility contract. `nsis.guid` has a four-line comment saying "**Never change it**"
and nothing enforces it.

**This project's own rule is "enforced by test, not discipline"** (invariant 10's wording), and
`test/docsStatus.test.ts` is the precedent for a test whose whole job is to stop documentation and
configuration drifting apart. R173 is the same shape for the identity fields: a node-project test
asserting the pinned GUID, the artifact-name patterns, `productName`, the resolved publisher and
maintainer strings, and the install-scope flags — each with the consequence of changing it named in
the failure message, so someone who breaks one is told why it matters rather than being told a
string does not match.

**It must assert the *resolved* values, not the literal config.** Reading `author.name` back out of
`package.json` proves nothing about what the installer writes; the assertion has to go through
`AppInfo` the way §2's verification did, or it is a test of its own fixture.

## 5. R174 — record the mapping, so submission is mechanical

A short section appended to this document — **not a new file, and not `FINDINGS.md`**, which is for
traps rather than reference — giving the winget manifest field → repo source mapping, so that
whoever writes the manifest transcribes it instead of re-deriving it:

`PackageIdentifier`, `Publisher`, `PackageName`, `License`, `InstallerType`, `Scope`,
`InstallerUrl`, `InstallerSha256`, and `AppsAndFeaturesEntries.ProductCode`.

**`ProductCode` is the one that matters and the one most often left out.** Set to the pinned GUID it
gives winget exact install-and-upgrade correlation, independent of every display string above it —
which means even if the Publisher decision is revisited some day, correlation does not break. It is
the belt to §3's braces.

## 6. What this round does not change

- **`appId` (`com.klados.app`)** — reviewed and kept. It is the macOS bundle identifier as well, the
  GUID pin has already made the uninstall key independent of it, and the `com.` prefix implying a
  domain is a cosmetic objection not worth an orphaning risk.
- **`nsis.guid`, `artifactName`, `differentialPackage`, the target lists** — already correct and
  already reasoned about in place.
- **`productName` (`Klados`)** — already the right answer.
- **The version.** `package.json` stays at `1.0.0` unless decided otherwise; this round implies no
  bump, and the standing decision is to hold `1.0.0` until the first release.

## 7. Not in scope

- **Submitting to winget.** No manifest is written, no PR is opened to `microsoft/winget-pkgs`, and
  nothing here commits the project to doing so.
- **Code signing.** Unsigned artifacts are a real winget consideration and a much larger decision
  (a certificate, its cost, its renewal); R167's checksums are the integrity story for now.
- **Moving the `v1.0.0` tag**, which is an operational step outside the repository's contents.
- **Other package managers** (Homebrew, Scoop, Flatpak). The fields R172 freezes are the ones they
  would want too, but none of their specifics are researched here and the plan should not imply they
  were.

## 8. Non-functional expectation

`PLANNING.md` §1 does not apply — nothing here is a visual decision. §3 does not apply — nothing
here is on a hot path; the entire round is build-time configuration and one test.

§2 is the substance of §2 above, and it is worth naming what it caught — twice, because the second
catch was of the first.

Resolving the claim *"the Publisher comes from `author.name`"* through electron-builder's own
`AppInfo` is what revealed the copyright string as a third answer to the same field. Reading the
source alone would have produced a plan that changed one output and silently changed two others.

**Then the same rule caught this plan.** Having established that the copyright derives from
`companyName`, §3 wrote down that it therefore *"falls out of R172a"* — a claim about a mechanism,
asserted rather than checked. `appInfo.js:129` reads `config.copyright` first, so the derivation
this plan had verified is the *fallback*, not the path, and the field is independently pinnable.
That is `PLANNING.md` §2 exactly: **verifying a mechanism once does not license an inference drawn
from it later.** The correction cost one `grep` of the getter; leaving it would have shipped a
version resource naming a copyright holder that does not exist, in a field nobody opens.

## 9. Acceptance criteria

1. A fresh Windows install writes ARP `Publisher` = `Klados` and `DisplayName` = `Klados`, under the
   uninstall key named for the pinned GUID. **Verified against a real built installer**, not against
   the config — §2's whole lesson is that the config is one resolution step away from the truth.
2. The `.deb`'s `Maintainer` field is unchanged from today's value and is well-formed
   `Name <email>`.
3. The copyright resource reads `Copyright © 2026 Klados contributors` on every artifact that
   carries one — both Windows version resources and macOS's `NSHumanReadableCopyright` — and names
   the same holder and year as `LICENSE` line 3. The two differ in the symbol only: `LICENSE` keeps
   the ASCII `(c)` conventional in a licence file, the version resource uses `©`. R173 normalises
   that one difference and asserts the rest, so changing the holder in either place alone is caught.
4. `electron-builder.yml`'s comment about deliberately omitting `maintainer:` is rewritten to
   describe what the file now does.
5. R173's test fails if any of the pinned values changes, and its failure message names the
   consequence rather than only the mismatch.
6. `DECISIONS.md` carries the per-user / one-click decision with its reasoning, and the publisher
   decision with the `author.name`-has-three-consumers finding.
7. §5's mapping table exists and every row cites its source in this repository.
8. **The whole suite still passes and the packaged app still installs and runs** — this round
   touches the identity of a shipped artifact, and the one failure mode that would be embarrassing
   is an installer that no longer builds.

## 10. R174 — the winget manifest, field by field

**Nothing here is a commitment to submit.** This section exists so that whoever writes the manifest
one day transcribes it instead of re-deriving it, and so that a field whose value lives in this
repository cannot be filled in from memory and quietly disagree with what the installer writes.

Every row cites where the value comes from. Three of them are *correlation* fields — the ones winget
uses to decide that an installed Klados is this Klados — and those are the rows that must be copied
exactly rather than approximated.

### The version manifest (`klados.Klados.locale.en-US.yaml`, `klados.Klados.yaml`)

| winget field | Value | Source in this repository |
|---|---|---|
| `PackageIdentifier` | `klados.Klados` | **Nowhere.** It lives only in `microsoft/winget-pkgs`; R172e settles it so it is not re-litigated. Matching is case-insensitive; the exact casing is confirmed against that repository at submission time. |
| `PackageVersion` | `1.0.0` | `package.json` `version`. `release.yml` already fails the build when the `v*` tag disagrees with it, so the tag is a safe second reading. |
| `Publisher` | `Klados` | `package.json` `author.name` → `AppInfo.companyName` (R172a). **Correlation field** — must equal the ARP `Publisher` the installer writes. |
| `PackageName` | `Klados` | `package.json` `productName` → `nsis.uninstallDisplayName`. **Correlation field** — must equal the ARP `DisplayName`. |
| `License` | `MIT` | `package.json` `license`, and `LICENSE`. |
| `Copyright` | `Copyright © 2026 Klados contributors` | `electron-builder.yml` `copyright` (R172c), which is also `LICENSE` line 3's holder. |
| `ShortDescription` | `package.json` `description` | Verbatim. It is already one sentence and already the app's own words. |
| `PublisherUrl`, `PackageUrl` | `https://github.com/mincowski/klados` | `package.json` `homepage`. |

### The installer entry

| winget field | Value | Source in this repository |
|---|---|---|
| `InstallerType` | `nullsoft` | `electron-builder.yml` `nsis`, with `oneClick` unset (D-091). |
| `Scope` | `user` | `perMachine` unset, so the install goes to `%LOCALAPPDATA%\Programs` under `HKCU` (D-091). Changing this after publication requires a new manifest *and* orphans every existing install. |
| `Architecture` | `x64` | `release.yml`'s `windows` job passes no architecture flag, so electron-builder builds the runner's — and `windows-latest` is x64. A local `--win nsis` run reports `archs=x64`. There is no arm64 Windows artifact to declare. |
| `InstallerUrl` | `https://github.com/mincowski/klados/releases/download/v<version>/klados-<version>-setup.exe` | `nsis.artifactName` (`${name}-${version}-setup.${ext}`), stable across versions by construction, uploaded by `release.yml`'s `Build and publish` step. |
| `InstallerSha256` | from `SHA256SUMS.txt` | `release.yml`'s `checksums` job hashes every published asset and uploads `SHA256SUMS.txt` to the release in `sha256sum -c` format (R167). Read the line for the setup executable; do not re-hash a local build, which is a different file. |

### The correlation entry, which is the one usually left out

```yaml
AppsAndFeaturesEntries:
  - ProductCode: 318f6304-c1a1-5b48-8b0d-d9b77e332a6b
    DisplayName: Klados
    Publisher: Klados
    InstallerType: nullsoft
```

No `UpgradeCode`: it is an MSI concept and this is a Nullsoft installer.

`ProductCode` is `nsis.guid` **verbatim, with no braces**, because that is literally the name of the
registry key it has to match. `NsisTarget.js:157–163` passes the GUID through as
`UNINSTALL_APP_KEY` unchanged — read in the source rather than assumed — so the key is

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\318f6304-c1a1-5b48-8b0d-d9b77e332a6b
```

with the bare GUID as its final segment. A `{braced}` form — the MSI convention, and the shape most
manifests carry — is a different string, so winget would find no match and treat an already-installed
Klados as absent.

**Why this block is the belt to §3's braces.** Every display string above it is a string someone
might change: a Publisher can be revisited, a DisplayName reworded. `ProductCode` correlates on the
one value this repository has pinned since before its first release and enforces by test, so
install-and-upgrade detection survives a decision above it being reopened. Leaving it out is what
produces the familiar winget failure where an upgrade installs a second copy beside the first.

### What still has to be decided at submission time, not here

- **Code signing.** Unsigned installers are accepted, and winget's validation reports them; whether
  that is acceptable is a decision with a certificate and a renewal behind it (§7).
- **`ReleaseDate`, `ReleaseNotesUrl`** — per-version, read off the release itself.
- **The exact `ManifestVersion`** — whatever the schema in `microsoft/winget-pkgs` is on the day.

## 11. Results

**All three tasks landed.** `electron-builder.yml` and `package.json` carry the pinned identity,
`test/publishedIdentity.test.ts` holds it there in eight tests, and §10 is the mapping.

### What changed

| | |
|---|---|
| `package.json` `author.name` | `mincowski` → `Klados` (R172a) |
| `electron-builder.yml` `copyright` | added: `Copyright © 2026 Klados contributors` (R172c) |
| `electron-builder.yml` `linux.maintainer` | added: `mincowski <8300485+mincowski@users.noreply.github.com>` (R172b) |
| `electron-builder.yml` linux comment | rewritten — it explained why `maintainer:` was deliberately absent, which stopped being true (§9 acceptance 4) |
| `docs/DECISIONS.md` | D-090 (the identity split), D-091 (per-user, one-click). D-089 also got the index row it never had |
| `test/publishedIdentity.test.ts` | new, 8 tests (R173) |
| §10 above | new (R174) |

### The plan was wrong about the copyright, and the correction is the round's finding

The first commit on this branch changed the plan before a line of it was implemented. §3's R172c had
said the copyright *"falls out of R172a"* and would become `Copyright © <year> Klados`.

**Both halves were wrong.** `AppInfo.copyright` (`appInfo.js:129`) reads `config.copyright` first
and derives from `companyName` only when it is unset, so the field is independently pinnable rather
than a side effect to accept — and `Klados` alone names a copyright holder that does not exist,
contradicting `LICENSE` line 3, which has read `Copyright (c) 2026 Klados contributors` since the
project was published.

**How the error was made is the part worth keeping.** §2's verification was real: `AppInfo` was
resolved against the actual `package.json`, which is what revealed the copyright as a third answer
to `author.name` at all. The plan then reasoned *forward* from that verified derivation — if the
copyright derives from `companyName`, changing `companyName` changes the copyright — without going
back to the getter. `PLANNING.md` §2 says verify a mechanism before asserting it; the sharper form
this round produced is that **verifying a mechanism once does not license an inference drawn from it
later.** The check cost one `grep`.

### Verified against real artifacts, not against the config

§9 acceptance 1 asks for a real build rather than a config reading, on the grounds that the config is
one resolution step away from the truth — which is the same step that produced the error above.

`npx electron-vite build && npx electron-builder --dir`, then the version resource of
`dist/win-unpacked/Klados.exe`:

```
CompanyName     : Klados
ProductName     : Klados
LegalCopyright  : Copyright © 2026 Klados contributors
InternalName    : Klados
FileVersion     : 1.0.0
```

Then `npx electron-builder --win nsis`, and the version resource of the installer it produced —
`dist/klados-1.0.0-setup.exe`, 166,075,235 bytes:

```
CompanyName     : Klados
ProductName     : Klados
LegalCopyright  : Copyright © 2026 Klados contributors
FileVersion     : 1.0.0
```

**That second reading is the one that matters.** The installer's `CompanyName` is the same
`AppInfo.companyName` that `NsisTarget.js:492` hands to NSIS as the `COMPANY_NAME` define, and
`installer.nsh:133` writes that define to ARP `Publisher` verbatim. So the string is confirmed to
have reached the artifact that performs the registry write, one step short of the write itself.
electron-builder's own log line for the target reports `oneClick=true perMachine=false`, which is
D-091's claim stated by the tool rather than inferred from two absent keys.

**Reading the wrong file nearly produced a false contradiction here.** A first attempt read
`dist/klados-1.0.0-setup.exe` while the NSIS run was still packaging and got
`CompanyName: mincowski` — the app executable apparently disagreeing with its own installer. The
file was three days old; electron-builder leaves the previous build in place until the new one is
written. Caught by its mtime, and `docs/FINDINGS.md` now carries `dist/` beside the `out/` entry
that already described this trap in the other directory.

**Not verified, and named rather than glossed:** the ARP registry write itself, and the `.deb`'s
`Maintainer` field. Both need an install performed — one on Windows, one on a Debian machine — and
neither was done here. The values feeding them are asserted at their source, which is a weaker claim
than acceptance 1's literal wording and is what this round actually has.

### R173, mutation-verified

A test that passes is not evidence that it would fail. Ten mutations were applied one at a time
against the real files, the suite run after each, and every one turned it red:

| Mutation | |
|---|---|
| `author.name` reverted to a person | red |
| `copyright` line removed | red |
| `linux.maintainer` removed | red |
| `nsis.guid` changed | red |
| `nsis.artifactName` loses `${version}` | red |
| `perMachine: true` added | red |
| `oneClick: false` added | red |
| `appId` changed | red |
| `win.executableName` changed | red |
| `LICENSE` holder changed | red |

The last is the cross-check: `LICENSE` line 3 and the pinned `copyright` must name the same holder
and year, normalised for `(c)` versus `©`, so changing one alone cannot pass.

**The test reads `electron-builder.yml` with a 20-line scalar reader rather than a YAML parser.**
No YAML parser is a declared dependency here, every value it needs is a one-line scalar at depth 0
or 1, and adding one to the manifest to read seven strings is a dependency bought for a test. The
reader is capped at one level of nesting deliberately: a key that moves deeper makes it throw
"not found", which is the right answer to a restructure. If a parser is wanted later, `js-yaml` is
already in the tree transitively and would need declaring.

### Review, per `R` id

- **R172** — the new `electron-builder.yml` comment claimed the copyright *"matches `LICENSE` line 3
  exactly"*. It does not: the two differ in the copyright symbol. Corrected in the comment and in §9
  acceptance 3, and R173 asserts the normalised form rather than an equality that was never true.
- **R173** — the first draft handed `AppInfo` the whole flattened scalar map, including
  `nsis.*`/`linux.*` keys that mean nothing at the config root. Inert, but it read like a real
  config and invited someone to assert against one; narrowed to the file's top-level keys.
- **R174** — the first draft carried an `UpgradeCode` beside `ProductCode`. `UpgradeCode` is an MSI
  concept and this is a Nullsoft installer; removed rather than shipped as plausible-looking filler
  in a document whose entire purpose is that it can be transcribed without re-deriving.

### The suite, and the two acceptance criteria that are not fully met

`npm test`: **1913 → 1921 tests**, 1916 passed and 5 skipped across 162 files, exit 0. `typecheck`
clean; `lint` at its ratcheted 3 warnings and 0 errors, unchanged.

`electron-builder --dir` and `electron-builder --win nsis` both completed, the second producing a
166 MB installer carrying the new identity in its own version resource — so acceptance 8's real
failure mode, an installer that no longer builds, is ruled out.

**What is not met is the *installed* half of acceptance 1 and 8.** Acceptance 1 asks for the ARP
`Publisher` read back from a fresh Windows install; acceptance 8 asks that the packaged app still
installs and runs. Both need the installer executed against the real registry of a real machine, and
neither was done. What this round has instead is the value inside the installer that would perform
the write, which is one step short of the thing the criterion names. The same applies to the `.deb`'s `Maintainer`, which needs a
Debian machine.

That is why this round's marker is `built-caveat` and not `built`, and the check is in
`docs/TASKS.md`'s Owed table rather than left as a sentence in a results section.

### Not done, and deliberately

§7's exclusions all hold: no manifest was written, no code signing, the `v1.0.0` tag was not moved,
and no other package manager was researched. **No version bump** — `package.json` stays at `1.0.0`
under the standing decision to hold it until the first release, and nothing here changes behaviour.

---

## 12. Verified on an installed machine (2026-09-11)

§11 landed the values and `test/publishedIdentity.test.ts` holds them at their source. What it could
not do is confirm that electron-builder's *resolution* — config value to installer to registry —
produces them. That is now done for Windows.

A local `npm run package` build (no release needed; the NSIS installer is the same artifact a tag
produces) was installed and the uninstall key read back:

```
HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\318f6304-c1a1-5b48-8b0d-d9b77e332a6b
    DisplayName       REG_SZ  Klados
    Publisher         REG_SZ  Klados
    DisplayVersion    REG_SZ  1.0.0
    Comments          REG_SZ  A desktop viewer and source-level editor for hierarchical data files …
    EstimatedSize     REG_DWORD  0x58b8d
```

| owed | expected from | observed | |
|---|---|---|---|
| ARP `Publisher` | `package.json` `author.name` | `Klados` | ✓ |
| ARP `DisplayName` | `productName` via `uninstallDisplayName` | `Klados` | ✓ |
| uninstall key name | `nsis.guid`, **unbraced** | `318f6304-c1a1-5b48-8b0d-d9b77e332a6b` | ✓ |
| hive | per-user, one-click (D-091) | `HKEY_CURRENT_USER` | ✓ |

**The unbraced key name is the one worth calling out.** §10 records that `nsis.guid` passes through
as `UNINSTALL_APP_KEY` unchanged (`NsisTarget.js:157–163`), and the observed key has no braces
around it. That is the property the whole pin exists for: anything keying installed state off this
name — a package manager, an updater, an upgrade check — finds the same string across versions
regardless of what `appId` ever becomes.

**An unplanned cross-check came free.** `EstimatedSize` is `0x58b8d` = **354.9 MiB**, against a
post-R190 `win-unpacked` measured locally at 356 MiB. A build made before R190's packaging
allowlist would have carried an additional 1.16 GB of `spike/fixtures/`, so the registry value is
independent evidence that R190 reaches a real installer and not only the `--dir` output the round
measured.

### Still owed

**The `.deb`'s `Maintainer`.** Narrower than §11 assumed, and it needs neither a Debian machine nor
an install: `release.yml` builds the package, and `dpkg-deb -I klados_1.0.0_amd64.deb` prints the
control fields from the artifact. Expect `Maintainer: mincowski <8300485+mincowski@users.noreply.github.com>`
— deliberately *not* `author.name`, which is the split R172b exists to make.

macOS's `NSHumanReadableCopyright` is readable the same way, from `Info.plist` inside the `.app`,
and is already covered at its source by `test/publishedIdentity.test.ts`.
