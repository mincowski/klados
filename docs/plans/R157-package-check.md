# R157 — CI packages the app, instead of only bundling it

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Results in §7.

One step: `npx electron-builder --dir` on all three platforms, after the existing bundler run.

---

## 1. The gap, and how it was found

`ci.yml` runs `npx electron-vite build`. That is a **bundler** — it produces `out/` and stops. It
never invokes `electron-builder`, so **until this round nothing on a pull request executed a single
line of the packaging toolchain.**

This was not a theoretical hole. Dependabot opened two security PRs, both bumping packages beneath
`app-builder-lib`:

```
fast-uri        ← ajv   ← app-builder-lib ← electron-builder
@xmldom/xmldom  ← plist ← app-builder-lib ← electron-builder
```

Both went **green on all three platforms**, and the natural reading — "1,834 tests passed, so the
bump is safe" — was wrong. The suite cannot reach either package. Green meant *the dependency tree
still installs*, and nothing more.

The only thing that exercised them was `release.yml`'s `npm run package`, which fires on a `v*`
tag. So the real test of a build-tooling change happened **after** a version had been committed to
and a tag pushed — precisely the ordering R151 exists to correct, and precisely how R141 spent four
release attempts and two deleted drafts.

## 2. What `--dir` covers, and what it deliberately does not

`--dir` produces the unpacked application and stops before the installer targets.

**Covered:** configuration validation (through `ajv`), the asar and file-copy stage, the Windows
executable rename, macOS `Info.plist` generation (through `plist`), and asar integrity.

**Not covered:** NSIS, dmg, AppImage and fpm/deb.

**Both packages that prompted the round are inside the covered half**, which was checked in
`node_modules` rather than assumed:

- `ajv` is reached from `app-builder-lib/out/util/config/schemaValidator.js`, called by
  `validateConfiguration` — which runs on *every* electron-builder invocation, `--dir` included.
- `plist` is reached from `app-builder-lib/out/electron/electronMac.js`, the macOS framework step,
  which runs during `--dir` on a Mac.

## 3. Why not full packaging

Running the real targets would also catch installer-shaped defects — R141's dmg filename collision
was exactly one of those, and `--dir` would not have caught it.

It is still the wrong trade at this point:

- **NSIS and dmg are slow**, and the local `--dir` measurement is already 123 s. Full packaging on
  Windows in `release.yml` measures 360–501 s per job including upload.
- **The installer configuration barely changes.** `electron-builder.yml`'s NSIS and dmg sections
  have moved twice since the project began, both times in a deliberate release round that was
  going to run the real thing anyway. Dependency bumps, which is what this round is about, do not
  touch them.
- **The failure modes differ in kind.** A packaging-toolchain regression breaks *every* target and
  `--dir` sees it; an installer-naming defect breaks one artifact's filename and only the real
  target sees it. This buys the first cheaply and leaves the second to the release, where the draft
  is inspected by a human before publishing.

Revisit if an installer-only defect ever ships. One has (R141's collision), but it was found by
looking at the asset list, which is the check that already exists.

## 4. Cost

**123 s measured locally** (`electron-builder 26.15.3`, Windows, the 2013 desktop CPU
`docs/spikes/M0a-codemirror-and-parsers.md` describes — so read it as an upper bound), exit 0,
producing `dist/win-unpacked/Klados.exe`. The Electron zip download dominates.

Against current CI wall clock — ubuntu 119 s, macOS 133 s, Windows 360 s — this is a meaningful
addition, and Windows sets the wall clock either way. Real per-platform figures go in §7 from the
pull request's own run.

**Not done: caching `~/.cache/electron` and electron-builder's cache.** It would cut most of the
download, and it is deliberately left out of this round — a cache key is a correctness surface of
its own, and there is no point tuning a step before its true cost has been observed even once.
Recorded here so the option is not lost.

## 5. The one thing the local run could not settle

On Windows the local run logged `signing with signtool.exe path=dist\win-unpacked\Klados.exe` and
exited 0. Nothing is code-signed in this project and no certificate is configured, so this is
expected to be a no-op — but a *local* Windows machine and a *runner* do not necessarily have the
same signing environment, and `CSC_IDENTITY_AUTO_DISCOVERY: false` is documented for macOS keychain
discovery rather than for signtool.

Flagged rather than assumed. If the Windows job fails on signing, the fix is to disable it
explicitly for the check rather than to configure a certificate, since unsigned is what this project
ships and the README says so.

## 6. Acceptance criteria

1. `ci.yml` runs `npx electron-builder --dir` on all three platforms, after `electron-vite build`.
2. `CSC_IDENTITY_AUTO_DISCOVERY: false`, no `GH_TOKEN`, no `--publish` — this builds and discards.
3. All three jobs green on the pull request that introduces it, **including Windows** (§5).
4. Per-platform wall-clock cost recorded in §7 against the pre-change figures.
5. The step runs before the test step, so a packaging break fails ahead of the slower stage.

## 7. Results

**Built** as planned. `ci.yml` gains one step between `electron-vite build` and the Playwright
install, so the ten-step job becomes eleven.

Local verification: `--dir` exits 0 in **123 s** and produces `Klados.exe` — the executable rename
is real, not merely configured, which also confirms `win.executableName` works outside a full
package run. Config validation loads through `ajv` on the way, which is the `fast-uri` path this
round exists to cover.

**Per-platform CI cost and the §5 signing question are answered by this pull request's own run**,
and recorded here once it lands. That is the same shape as R151: the criteria a CI change cannot
verify locally are exactly the ones its own run exists to settle.

**Review pass, per `CLAUDE.md`.** Read as `git diff`. Nothing found — the change is one step and one
environment variable, the step order was checked by parsing the workflow rather than by reading it,
and both package reachability claims in §2 were verified against `node_modules` rather than
reasoned from the dependency tree.
