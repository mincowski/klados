# R195 — the installer carries 54 languages the application does not have

<!-- status: open -->

**Open.** Found answering a question about install size after R190: the packaged application is
356 MiB, of which **45 MiB is `locales/` — 55 Chromium `.pak` files, one per language.**

## 1. What this is and is not

R190 cut the asar from 1202 MB to 31 MB, which was the part that was *ours*. What remains is
Electron, and most of it is irreducible:

```
202 MB  Klados.exe          Chromium + V8 + Node
 45 MB  locales/            55 .pak files          ← this round
 30 MB  resources/          our asar
 25 MB  dxcompiler.dll      DirectX shader compiler
 15 MB  LICENSES.chromium.html
 10 MB  icudtl.dat
  9 MB  libGLESv2.dll       ANGLE
```

**The application is 8.4% of its own install and that is normal for Electron.** This round is not
an attack on that; it is the one line item that is *unambiguously* unused. Klados has no
translations. These files localize Chromium's own surfaces — context menus, error pages — into 54
languages the application never speaks.

**Deliberately not touched**, and worth recording so nobody revisits them hoping for an easy win:

- **`dxcompiler.dll` + `dxil.dll`, 27 MB.** The DirectX 12 shader path. Removable in principle;
  cutting 8% at the risk of breaking GPU acceleration on hardware not represented here is a bad
  trade made blind.
- **`vk_swiftshader.dll`, 6 MB.** The software renderer — what makes the app work at all on a
  machine with broken GPU drivers. Deleting it swaps a rare degradation for a rarer total failure.
- **`LICENSES.chromium.html`, 15 MB.** A condition of distributing Chromium.
- **~10 MB inside our own asar**: React's development and server builds, which an Electron renderer
  never loads. Noted in R190 § 9; pruning a dependency tree by hand is a different class of risk
  from a config line.

## 2. R195

```yaml
electronLanguages:
  - en-US
```

**Measured, on a real `--dir` build**: `locales/` 45 MiB → **1 MiB**, one file (`en-US.pak`);
the unpacked application **356 MiB → 312 MiB**. The packaged app launches — main, renderer, GPU and
utility processes, nothing on stderr.

## 3. The value must be `en-US`, and `en` silently destroys the build

This is the finding, and it is not visible from the option's name.
`ElectronFramework.js`'s `removeUnusedLanguagesIfNeeded` keeps a file when:

```js
wantedLanguage === language ||
wantedLanguage.startsWith(`${language}-`) ||
wantedLanguage.startsWith(`${language}_`)
```

Read the direction carefully: it asks whether the **wanted** string starts with the **file's**
name, not the other way round. On Windows there is no `en.pak` — Electron ships `en-GB.pak` and
`en-US.pak`. So:

| configured | `en-US.pak` | result |
|---|---|---|
| `en-US` | `"en-us" === "en-us"` | **kept** |
| `en` | `"en" === "en-us"` false; `"en".startsWith("en-us-")` false | **deleted** |

**Verified by building it both ways.** `electronLanguages: [en]` leaves the `locales/` directory
with **zero files** — every one of the 55 removed, including English.

**And nothing tells you.** The "no locales found matching wanted languages" warning fires only when
*nothing* was deleted; deleting everything is the silent path. The build succeeds, and **the
resulting application launches cleanly with nothing on stderr** — also verified. The failure would
surface later, as a missing string in a Chromium-drawn menu, with nothing pointing back here.

`en-US` also covers macOS, where the framework ships `en.lproj`: the file's name is then `en`, and
`"en-us".startsWith("en-")` is true, so it is kept. The asymmetry that makes `en` wrong is what
makes `en-US` right on both.

## 4. R195's guard

`test/electronLanguages.test.ts` reimplements the predicate above and runs it against the **real**
locale filenames in `node_modules/electron/dist/locales/`, asserting that the configured languages
leave a non-empty set and that it includes English.

**Why a test rather than a comment.** § 3 is a footgun with no feedback: the wrong value builds
successfully, ships, and launches. A comment warns whoever reads it; this fails whoever does not.
It is the same argument as R191's packaging guard, in a place with the same property — a
configuration whose mistakes are invisible at build time.

**What it proves and what it does not.** It proves the configured value selects a locale that
exists. It does not run electron-builder, so it does not prove the *pack* — § 2's measurement did
that once, and every `--dir` build repeats it. Stated here rather than left for the file name to
overclaim.

**Nothing automated launches a packaged build**, on any platform: `mainElectron.test.ts` starts
`out/main/index.js` under the development Electron, which has its own full `locales/` and is
untouched by this option. `ci.yml` runs `electron-builder --dir` on all three platforms, so an
invalid option fails there — but "the app still works with one locale" is confirmed by hand, on
Windows, and the plan says so rather than implying three-platform coverage it does not have.

## 5. Acceptance

1. A `--dir` build leaves exactly one file in `locales/`, and it is `en-US.pak`.
2. The unpacked application is under 320 MiB, down from 356.
3. The packaged application launches.
4. `test/electronLanguages.test.ts` fails when the value is changed to `en` — by mutation, not by
   a green suite.
5. `npm test`, `npm run typecheck`, `npm run lint` clean.

## 6. Version

**No bump.** Packaging configuration; no application code changes.
