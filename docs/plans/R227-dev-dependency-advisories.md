# R227 — every fixable advisory in the development dependencies, for 1.2.2

<!-- status: built -->

**Built**, for 1.2.2, before its tag was moved to include it. The project lead asked that 1.2.2 not
leave out anything it could reasonably have included. Two advisories remain open because no fixed
release exists for either (§ 3).

## 1. Why

Before 1.2.2 was published, two Dependabot pull requests were open:

- **#56, undici 6.28.0 → 6.29.0**, closing alert #36 (low). Correct, green, merged as it was.
- **#57, brace-expansion 1.1.18 → 1.1.21**, closing alert #45 (medium, GHSA-q2hr-2g5m-vwhr). It was
  correct but partial:
  - The same advisory covers two more lines in the lockfile, 2.1.4 (#44) and 5.0.9 (#43).
  - Both have fixed releases (2.1.7 and 5.0.12) inside the ranges their parents accept
    (`minimatch` `^2.0.1`/`^2.0.2` and `^5.0.8`).

  Closed in favour of this round.

**`npm audit` then reported 16 vulnerabilities, 14 high**, where GitHub listed four alerts. They come
down to five advisories; the other entries are packages that depend on them:

| Advisory | Package | Reached through |
|---|---|---|
| high, GHSA-ch52-4w7c-c8xp | `http-cache-semantics` ≤ 4.2.0 | electron-builder → `@electron/get` → `got` → `cacheable-request` |
| high, GHSA-2v37-7h3g-55p8 | `nanoid` < 3.3.18 | `postcss` (vite, stylelint) |
| moderate, GHSA-2wm5-q62r-hmrv | `colord` < 2.9.4 | stylelint |
| moderate, GHSA-hrr3-gc8f-f4qj | `fast-uri` 3.0.0–3.1.7 | `ajv` (eslint) |
| high, GHSA-vfj7-8cjw-p6xm | `braces` ≤ 3.0.3 | stylelint → `micromatch`, `fast-glob`, `globby` |

**None of it ships.** Every package above is a development dependency: the build, lint and test tooling.
`npm ls --omit=dev --all`, which is the set electron-builder packs into the app, was compared before
and after: identical.

## 2. The change

`package-lock.json` only; `package.json` is unchanged.
- **brace-expansion:** `npm update brace-expansion --package-lock-only` moves all nine copies onto
  fixed releases: 1.1.21, 2.1.7 and 5.0.12.
- **The rest:** `npm audit fix`, which applies only updates inside the ranges already declared. It
  never applies a major version; `--force` would have.

Every version that changed:

| Package | From | To |
|---|---|---|
| `brace-expansion`, six copies of the 1.x line | 1.1.18 | 1.1.21 |
| `brace-expansion`, two copies of the 2.x line | 2.1.4 | 2.1.7 |
| `brace-expansion` (5.x) | 5.0.9 | 5.0.12 |
| `colord` | 2.9.3 | 2.10.0 |
| `fast-uri` | 3.1.7 | 3.1.8 |
| `nanoid` | 3.3.16 | 3.3.19 |
| `postcss` | 8.5.25 | 8.5.28 |
| `postcss-selector-parser` | 7.1.4 | 7.1.6 |
| `stylelint` | 17.14.1 | 17.16.0 |
| `@csstools/css-syntax-patches-for-csstree` | 1.1.7 | 1.1.15 |
| `fastq` | 1.20.1 | 1.20.3 |
| `globby` | 16.2.2 | 16.2.4 |
| `globby`'s `ignore` | 7.0.6 | 7.0.12 |
| `unicorn-magic` | 0.4.0 | 0.4.1 |

The non-advisory entries are what the fixed versions require. Every one is a development dependency.

## 3. What stays open, and why

Both remaining advisories have **no fixed release**. Measured with `npm view`: the latest published
version of each is inside the affected range.

- **`braces` ≤ 3.0.3, high (GHSA-vfj7-8cjw-p6xm)**: 3.0.3 is the latest release.
  - `npm audit`'s only suggestion is `npm audit fix --force` to stylelint **7.7.0**, a downgrade of ten
    major versions. Not taken.
  - It is reached only by stylelint, which reads the project's own CSS files.
- **`http-cache-semantics` ≤ 4.2.0, high (GHSA-ch52-4w7c-c8xp)**: 4.2.0 is the latest release.
  `npm audit`'s first report said a fix was available. After `npm audit fix` it still listed the
  package, and nothing on its path had changed. Recorded as observed, not explained.
  - It is reached only by electron-builder's download path, a cache with a single user on a build
    machine.

Both close by themselves once upstream publishes a fix and Dependabot proposes it.

## 4. Verification

- **The production dependency tree** (`npm ls --omit=dev --all`) is identical before and after.
- `npm ci` from the new lockfile; then:
  - `npm run lint`: eslint, prettier and stylelint 17.16.0. The same 3 warnings as before, no errors.
  - `npm run typecheck`: clean.
  - `npm test`: 191 files, 2,337 tests passed.
- **`electron-builder --win nsis`** builds the installer with the updated tooling.
- **`npm audit` afterwards:** only the two advisories in § 3, and the packages that depend on them.

## 5. Review

The diff is a lockfile, read entry by entry against the table in § 2. Nothing else changed, and nothing
in it reaches the packaged app. Nothing to fix.
