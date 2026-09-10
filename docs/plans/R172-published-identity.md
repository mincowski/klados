# R172–R174 — freeze the published identity before the first release

<!-- status: open -->

**Open.** Register: `docs/TASKS.md`. **No winget submission happens here.** The goal is that when
one is decided on, it needs *zero changes to this repository* — every field a package manager
correlates against is already correct and already frozen.

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
