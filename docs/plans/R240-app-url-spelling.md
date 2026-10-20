# R240 — the app's own page refused when its path contains `~`, `[`, `]` or `%`

<!-- status: built -->

**Built** (§7): `isAppUrl` compares `file:` pathnames percent-decoded, and the packaged app starts
through an 8.3 alias and from a `~[ ]` folder on all three platforms. One claim of §3 C was wrong:
the URL parser resolves `%2E%2E` itself (§7.2). D-124.

Found by R230's packaged test on `windows-latest` (`docs/plans/R230-shipped-app-hardening.md`
§5.2) and reported there as "an 8.3 short path". **Measured here, the short name is not the cause.**
The cause is the `~` in it. R164's guard compares a URL that Node spelled with one that Chromium
spelled. The two agree on every character except four: `~`, `[`, `]` and `%`. A Klados installed
anywhere whose path contains one of them refuses every IPC call from its own page and never renders,
whether or not 8.3 names are involved.

It fails closed: a blank window, not a hole. It is an availability defect in a security guard, and
the fix must not loosen what the guard accepts (§3).

## 1. The finding, measured

### 1.1 Environment and method

- Windows 11 Pro 10.0.26100, NTFS with 8.3 name generation on (`dir /x` lists `KLADOS~1`).
- **The packaged app.** Built from `7fa4656` (R230–R231 merged) with `npx electron-vite build &&
  npx electron-builder --dir`, so with R230's fuses and asar integrity. It had temporary logging in
  `createWindow` and `isTrustedSender`, written to a file in the profile and removed afterwards (not
  committed). The build was copied to `…\scratchpad\klados-shortname-probe\app\`, whose 8.3 alias is
  `KLADOS~1`. Each launch used its own `--user-data-dir` and ran for 12 s. "Rendered" means
  `titlebar-theme.json` appeared, the same signal `test/packagedApp.test.ts` uses.
- **The character table** (§1.3) used the development Electron from `node_modules`: Electron 44.4.5,
  Node 24.21.0, Chrome 152.0.7977.130. For each character `c`, a folder `a<c>b` holding an
  `index.html` was loaded with `loadFile`. Then `pathToFileURL(file).href`, which is what
  `src/main/index.ts:336` hands `setAppUrl`, was compared with `webContents.getURL()` and
  `mainFrame.url`, using `isAppUrl`'s `file:` rule (protocol, host, pathname).

### 1.2 The packaged app through five spellings of one folder

| Launched as | Rendered | `appUrl` (from `pathToFileURL`) | URL Chromium reports for the page |
|---|---|---|---|
| long path | yes | `…/klados-shortname-probe/app/…` | same |
| **`…\KLADOS~1\app\Klados.exe`** | **no** | `…/KLADOS%7E1/app/…` | `…/KLADOS~1/app/…` |
| whole path in lower case | yes | `file:///C:/Users/chris/appdata/local/temp/…` | same |
| drive letter `c:` | yes | `file:///C:/…` | same |
| `SCRATCHPAD` for `scratchpad` | yes | `…/SCRATCHPAD/…` | same |

The short-path launch logged `refused` for each refused IPC call, every time with this pair (prefix
shortened):

```
refused  file:///C:/…/scratchpad/KLADOS~1/app/resources/app.asar/out/renderer/index.html
     vs  file:///C:/…/scratchpad/KLADOS%7E1/app/resources/app.asar/out/renderer/index.html
```

**Both sides hold the short name.** `__dirname`, and with it `indexPath`, is the path as launched,
and Chromium loads the path it is given. The names never diverge. The *escaping* does: Node's
`pathToFileURL` writes `~` as `%7E`, Chromium leaves it literal, and `new URL()` does not unify the
two, so `pathname` differs.

**Casing alone does not trigger it.** The lower-case and upper-case launches rendered, because both
sides derive their URL from the same string, whatever its casing. (Windows also normalizes part of
it: `process.execPath` came back as `C:\Users\chris\appdata\…`, upper-casing the drive and the
first two segments only.)

`location.href`, `webContents.getURL()` and `mainFrame.url` agreed with each other in every launch.

### 1.3 Which characters differ

| In the folder name | `pathToFileURL` | Chromium | `isAppUrl` |
|---|---|---|---|
| space | `%20` | `%20` | passes |
| `! $ & ' ( ) + , ; = @` | literal | literal | passes |
| `^` `` ` `` `{` `}` `#` | `%5E` `%60` `%7B` `%7D` `%23` | the same | passes |
| `ä` `日` `😀` | UTF-8, `%C3%A4` … | the same | passes |
| **`~`** | `%7E` | `~` | **refused** |
| **`[`** / **`]`** | `%5B` / `%5D` | `[` / `]` | **refused** |
| **`%`** (as `a%%b`) | `%25%25` | `%%` | **refused** |

Chromium's spellings are the WHATWG URL standard's path percent-encode set, which leaves `~`, `[` and
`]` alone. The extra escapes are Node's choice in `pathToFileURL`.

**A `%` followed by two hex digits is a different failure, and not this round's** (§4):

| Folder | `pathToFileURL` | Chromium | Loads? |
|---|---|---|---|
| `a%41b` | `a%2541b` | `a%41b` | **no**, `ERR_FILE_NOT_FOUND` |
| `a%7Eb` | `a%257Eb` | `a%7Eb` | **no**, `ERR_FILE_NOT_FOUND` |
| `a%2Fb` | `a%252Fb` | `a%2Fb` | **no**, `ERR_FAILED` |
| `a%%b` | `a%25%25b` | `a%%b` | yes |

The URL Chromium reports shows that Electron's `loadFile` did not escape the `%`. Chromium then
reads `%41` as an escape, presumably looking for `aAb`.
From such a folder the page never loads, so the guard is never reached. The `%2F` row also shows
that Chromium refuses an encoded `/` outright rather than reading it as a separator.

### 1.4 Who it reaches

- **A launch through an 8.3 path.** GitHub's `windows-latest` sets `TEMP` to
  `C:\Users\RUNNER~1\…`. A user's shortcut, a script or a launcher can pass a short path too.
- **A long path with `~`, `[` or `]`**, with no 8.3 name involved, e.g. `D:\Apps [portable]\Klados`
  or `C:\~tools\Klados`. The table above is that case.
- **macOS and Linux, probably.** `pathToFileURL` and Chromium's canonicalization are not
  Windows-specific, so a folder named `a~b` likely fails there as well. **Not measured**; criterion 6
  measures it.
- **The installer's default path** (`%LOCALAPPDATA%\Programs\Klados`) contains none of these and
  works, which is why this went unnoticed until R230 launched from `%TEMP%`.

## 2. What else uses the value

`isAppUrl` has three callers, all fed `getAppUrl()`: the IPC sender guard
(`src/main/trustedRenderer.ts`), the navigation guard (`will-navigate`/`will-redirect` in
`src/main/index.ts`), and `isPermissionGranted` (R222's clipboard write). The defect therefore also
blocks Copy, and it would block any same-page navigation. One fix in `isAppUrl`, or in the value
passed to it, covers all three. `pathToFileURL` has no other use in `src/`.

## 3. Options

**The guard's question is "is this the same file as our page?"** Chromium answers it by
percent-decoding the URL's path into a file path. An option is acceptable if it accepts exactly the
URLs Chromium would load as that file, and no others.

### A. Derive the app URL from `realpathSync.native` — rejected

The suggestion in R230's notes. `realpathSync.native` turns the short name into the long one
(measured: `KLADOS~1` → `klados-shortname-probe`).
- **It fixes the symptom, not the cause.** A long name containing `~`, `[` or `]` still fails (§1.3).
- **It adds a mismatch.** `realpath.native` also returns the on-disk casing (measured: the lower-case
  launch's `appdata\local\temp` came back as `AppData\Local\Temp`). If `appUrl` comes from the real
  path while `loadFile` gets `indexPath`, any launch whose casing differs from the disk's breaks,
  and today those all work (§1.2). It would only hold if `loadFile` were given the same real path.
  Even then, the long-name case above is unfixed.

### B. Adopt the URL Chromium reports — second choice

Take `appUrl` from `webContents.getURL()` once the page's own load commits, so both sides are
Chromium's spelling.
- **`did-finish-load` is too late.** In the short-path launch, two refusals were logged *before*
  `getURL`. The renderer calls IPC while its modules load: `zoom.ts` applies `view:setZoomFactor` at
  module load time.
- **Commit (`did-navigate`) is early enough only if ordering holds.** The commit and the first IPC
  message arrive over separate channels, and nothing here has measured that the commit is always
  handled first. A refusal at that point is the same blank window, now intermittent.
- **It changes what the guard trusts**: from "the file we chose" to "whatever our first load
  committed to". That is the same thing today, but it needs its own check that the committed URL is
  the expected file, which is option C's comparison anyway.

### C. Compare file URLs as Chromium resolves them — recommended

In `isAppUrl`'s `file:` branch, compare the two pathnames **after percent-decoding both, in one pass,
byte by byte**, instead of comparing the raw strings:
- **Decoded:** every `%XX` with two hex digits, either case, to the byte it names.
- **Never decoded:** `%2F` (`/`), `%5C` (`\`) and `%00`, **in either case** (`%2f` and `%5c` too).
  An encoded separator must not change the path's structure, and Chromium refuses those URLs anyway
  (§1.3's `%2F` row). They are compared as written, so they never match a literal separator.
- **Dot segments are not resolved.** `new URL()` already resolves literal `.` and `..`; an encoded one
  (`%2E%2E`) decodes to the text `..` and is compared as text, so it never equals a path without it.
  That refuses a spelling Chromium might load as the same file, which fails closed and is acceptable.
- **Not `decodeURIComponent` or `decodeURI`.** Measured in Node 24: `decodeURIComponent` *throws* on
  `a%%b` and on `%FF`, and turns `%2F` into `/`. That breaks both rules above, and a throw inside the
  guard would refuse every call. Write the scan by hand: a `%` followed by two hex digits becomes that
  byte, unless it is one of the three exclusions, and every other character stays as it is. Comparing
  the two results as strings of byte values is enough, since `new URL()` has already escaped every
  non-ASCII character on both sides.
- **Unchanged:** a lone `%` not followed by two hex digits stays literal, so Chromium's `a%%b` meets
  Node's decoded `%25%25`. Protocol and host checks stay exact (R231), case stays significant, and the
  development branch (`http:` origin) is untouched.
- **One pass**, so `%257E` decodes to `%7E` and does not equal `~`.

Why this is not a widening: two URLs with the same decoded path are the same file to Chromium's
loader, so the accepted set grows only by other spellings of the app's own file. It is also robust
in a way A and B are not: if a later Node or Chromium changes its escaping, the comparison still holds.

**Cost.** One linear scan of two ~200-character pathnames per IPC call, after the two `new URL()`
parses `isAppUrl` already does on every call. No measurable effect expected. No new dependency.

### D. Serve the renderer from a custom scheme — the class fix, not this round

`klados-app://app/index.html` would make the app URL a constant independent of the install path.
That would remove this whole family, and FINDINGS already notes it as the prerequisite for turning
off `grantFileProtocolExtraPrivileges` (D-122). But it changes the page's **origin**, and with it the
`localStorage` that settings and session restore live in, so it needs a migration. That is its own
round, if ever.

### Case-insensitive comparison — rejected

- **Nothing measured needs it.** Casing alone passes (§1.2), because both URLs come from the same
  string.
- **It accepts a different file wherever case matters**: Linux, case-sensitive macOS volumes, and
  NTFS folders with per-directory case sensitivity on. For a security guard, matching "a file whose
  name differs only in case" is a real widening, unlike C's alternative spellings of one file.

## 4. Not in scope

- **A folder named with `%` plus two hex digits** (`a%41b`). `loadFile` itself cannot load the page
  from there (§1.3), so it fails before any guard runs. That is Electron's escaping, not R164's. It is
  recorded in `docs/FINDINGS.md` by this plan; a fix would be passing `loadURL` a correctly escaped URL,
  and is not proposed until someone meets it.
- **Option D.**

## 5. Acceptance criteria

1. **`isAppUrl` accepts Node's and Chromium's spelling of the same file** for every row of §1.3's
   first table, with each pair taken verbatim from the measurement, in `test/mainSecurity.test.ts`.
   That includes `KLADOS%7E1` against `KLADOS~1`, `%5B`/`%5D` against `[`/`]`, and `%25%25` against
   `%%`.
2. **Still refused**, one test each: another host (R231's tests, unchanged); another path; `%2F` in
   place of a `/`, and the lower-case `%2f`; `%5C` and `%5c`; `%00`; a single `%257E` against `~` (no
   double decode); `%2E%2E` standing for a `..` segment; a path differing only in case; an
   unparseable URL.
3. **`isAppUrl` never throws**, on any input: a target containing `%FF`, a lone `%` at the end of the
   path, and `%%` return `true` or `false` like any other URL. Asserted directly, since a throw in
   the guard refuses every IPC call.
4. **Mutation:** restoring the raw `pathname ===` comparison turns criterion 1's `~` test red.
   Decoding `%2F` turns criterion 2's separator test red. Replacing the hand-written scan with
   `decodeURIComponent` turns criteria 1 (`%%`) and 3 red.
5. **The packaged app starts through an 8.3 path on Windows.** `test/packagedApp.test.ts` gains a
   launch from a copy in a folder with a long name, invoked through its 8.3 alias (taken from
   `dir /x`, never assumed). It must reach `started`. The 8.3 alias must be looked up because 8.3
   generation can be off on a volume; if no alias exists the test is skipped with that reason
   printed, never passed silently.
6. **The packaged app starts from a long folder name containing `~`, `[` and `]`, on all three
   platforms.** This does not depend on 8.3 generation, so it cannot be skipped. It also measures
   §1.4's unmeasured macOS/Linux claim: record in the results whether the pre-fix build failed there.
7. **The workaround goes.** `tempDir` in `test/packagedApp.test.ts` stops calling
   `realpathSync.native`, and its comment goes with it. On `windows-latest` every packaged test then
   runs from `RUNNER~1` again, which is a second regression check at no cost.
8. **Copy works from the short path**: `isPermissionGranted` is green for criterion 1's `~` pair.
   It inherits the fix, but nothing would notice if it did not.
9. **`isAppUrl`'s doc comment** says why the pathname is compared decoded, citing this plan, and why
   not case-insensitively.
10. **`docs/FINDINGS.md`**: the entry for paths containing `~`, `[`, `]` or `%` is removed once
    criteria 5–7 are green. The `%XX` folder entry stays.

## 6. Method notes, and what was wrong before measuring

- **The suspected cause was wrong.** The handover, R230's §5.2 and FINDINGS all said the main
  process and the page "spell the path differently", short name against long name, possibly with
  casing as well. The probe showed both sides holding `KLADOS~1`. No `realpath` or casing step
  happens anywhere on either side. Planning from the hypothesis would have produced option A, which
  §1.3 shows leaves `C:\~tools\` broken and §1.2 shows would break mixed-case launches that work
  today.
- **The first character probe crashed on its own harness**: destroying the only window apparently quit the
  app (`window-all-closed`) before the second load. Worth knowing for anyone repeating it.
- **The table records what was loaded, not just what was spelled.** The first version of the
  `%XX` rows compared URLs without checking whether `loadFile` succeeded. They looked like ordinary
  refusals. Recording the load result is what showed them to be a separate failure.
- Temporary logging was added to `src/main/index.ts` and `src/main/trustedRenderer.ts` for the
  packaged build and reverted before this plan was committed. The probe apparatus lived in the
  session's scratch directory and is not kept.

## 7. Results

**Built as option C.** `isAppUrl`'s `file:` branch compares `decodedFilePath` of both pathnames
(`src/core/mainSecurity.ts`). Protocol and host checks, case sensitivity and the development branch
are unchanged. D-124.

### 7.1 The criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Node's and Chromium's spellings agree, for every §1.3 row | green, 9 pairs in `test/mainSecurity.test.ts`, the first being `KLADOS%7E1` against `KLADOS~1` |
| 2 | Still refused: another path, `%2F`/`%2f`, `%5C`/`%5c`, `%00`, `%257E`, case, unparseable | green, except `%2E%2E`, which §7.2 corrects |
| 3 | Never throws on `%FF`, a trailing `%`, `%%` | green, each asserted both not to throw and to give the expected answer |
| 4 | Mutations | all red: the raw `pathname ===` (9 tests, `~` among them); decoding `%2F` (the separator test); `decodeURIComponent` (8 tests, `%%` and every criterion 3 case) |
| 5 | Packaged launch through a looked-up 8.3 alias, Windows | green after; **red before** (locally and on `windows-latest`), the app's stderr showing `Refused view:setZoomFactor from an untrusted frame` |
| 6 | Packaged launch from `apps~[portable]`, all three platforms | green after; **red before on Windows, macOS and Linux**, which settles §1.4's unmeasured claim |
| 7 | `tempDir` without `realpathSync.native` | done. Before the fix, `windows-latest` then failed the tamper test's control launch too, from `RUNNER~1` |
| 8 | `isPermissionGranted` for the `~` pair | green |
| 9 | `isAppUrl`'s doc comment | says why decoded, citing this plan, and why not case-insensitive |
| 10 | FINDINGS | the `~ [ ] %` entry removed; the `%XX` folder entry kept |

The "before" runs used this branch's tests against the unfixed `mainSecurity.ts`, pushed to the
pull request and then replaced by the fixed commit.

### 7.2 What §3 C had wrong

- **`%2E%2E` is not compared as text.** The URL standard treats `%2E%2E`, `.%2E` and `%2E.`, in any
  case, as a `..` segment, and `new URL()` resolves it before `isAppUrl` sees the pathname.
  Measured: `file:///C:/Apps/a~b/x/%2E%2E/out/…` has the pathname `/C:/Apps/a~b/out/…`. So it names
  the app's file and is accepted, as Chromium would load it. Decoding cannot create a `..` the
  parser did not already resolve: a decoded `%2E` inside a name is just a dot. The test asserts
  that instead.
- **"Compared as written" was not enough for the kept escapes.** Kept as the text `%5C`, an encoded
  `\` would have equalled a decoded `%255C`: a file literally named `%5C`, which Linux allows and
  which is a different file. `decodedFilePath` writes a kept escape as a code unit above 0xFF,
  which nothing else produces. A test covers it. `%2F` and `%2f` now compare equal to each other,
  and still never to a `/`.

### 7.3 Linux and the copied sandbox helper

The first CI run of criterion 6 failed on Linux for a different reason: the copy's `chrome-sandbox`
is not setuid root, so the packaged app aborts before its first window (`docs/FINDINGS.md` already
records the trap). Making a copy setuid needs root. That launch passes `--no-sandbox` on Linux only;
the guard does not depend on the OS sandbox. Run that way, the unfixed build failed with the
untrusted-frame refusals, as on the other two platforms.

### 7.4 Review

The diff was read before the commit. It found the kept-escape collision (§7.2), which the plan's
own tests would not have caught, and the `%2E%2E` claim, which the first test run contradicted.
Nothing else.
