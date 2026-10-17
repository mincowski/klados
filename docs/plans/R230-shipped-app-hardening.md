# R230–R231 — the shipped binary: Electron fuses, and the `file:` host

<!-- status: open -->

**Open.** Planned from the security review of 2026-10-16, findings 2 (low–medium) and 3 (low, defence
in depth). Both are about what the packaged `Klados` executable accepts from outside its own page.
R230 is packaging, R231 is one line in a runtime guard, and they share a verification harness (§3).

## 1. R230 — the packaged binary is a general-purpose Node runtime

`electron-builder.yml` sets no `electronFuses`, so every fuse keeps Electron's default. **Measured on
the 1.2.2 build** (`dist/win-unpacked/Klados.exe`, built 2026-10-03):

```
$ ELECTRON_RUN_AS_NODE=1 dist/win-unpacked/Klados.exe -e "console.log('RAN AS NODE', process.versions.electron)"
RAN AS NODE 44.4.5
```

`NODE_OPTIONS="--require …"` is honoured as well: the probe failed resolving the module, which means
it tried to load it. So anyone who can set an environment variable or a command line for a user's
process can run arbitrary JavaScript **under Klados's identity and path**. That matters because:

- **Windows' per-user NSIS install puts `Klados.exe` in a user-writable folder**, and an allowlisting
  rule that trusts "Klados" by path or publisher trusts arbitrary scripts.
- **The app code itself is not integrity-checked.** `resources/app.asar` can be edited on disk and the
  app runs the edit.

Nothing in Klados uses `ELECTRON_RUN_AS_NODE`, `process.fork`, `NODE_OPTIONS` or the inspector in
production, so none of this is load-bearing.

### The change

Add to `electron-builder.yml` (supported by the installed electron-builder 26.15.3, verified in
`app-builder-lib`'s `configuration.d.ts`):

| Fuse | Value | Expectation |
|---|---|---|
| `runAsNode` | `false` | safe: nothing forks |
| `enableNodeOptionsEnvironmentVariable` | `false` | safe |
| `enableNodeCliInspectArguments` | `false` | safe for users. **It breaks Playwright's `_electron` against the packaged binary**, which attaches through `--inspect`. `mainElectron.test.ts` launches the *stock* Electron against `out/`, which no fuse touches, so the existing suite is unaffected. The packaged check below therefore does not use Playwright. |
| `enableCookieEncryption` | `true` | no cookies are used; harmless |
| `onlyLoadAppFromAsar` | `true` | safe: `asar` is on by default and the build has `resources/app.asar` |
| `enableEmbeddedAsarIntegrityValidation` | `true` | **verify-then-enable, per platform** (below) |
| `grantFileProtocolExtraPrivileges` | `false` | **verify-then-enable**. The page is loaded with `loadFile`, so this is the one fuse that touches how Klados itself runs. |

**Two of these fuses can brick the app, and that is R166's lesson again.** Asar integrity needs the
build to embed the hash. electron-builder does this for macOS, and whether 26.15.3 also embeds the
Windows `Integrity` resource has to be **read off a built `Klados.exe`, not from the docs**.
`grantFileProtocolExtraPrivileges: false` changes what a `file://` page may do, and the renderer, its
module worker and the `klados-file://` fetch all start from one. **If either breaks the packaged
smoke test on any platform, that fuse stays at its default on that platform**, and the reason is
recorded here and in `DECISIONS.md`. Shipping a fuse that bricks one OS is not an option, and nor is
silently dropping it.

## 2. R231 — `isAppUrl` ignores the host of a `file:` URL

`src/core/mainSecurity.ts:53` compares `protocol` and `pathname` only. Measured in Node:

```
new URL('file://evil.example/C:/Program%20Files/Klados/resources/app.asar/out/renderer/index.html').pathname
  === new URL('file:///C:/Program%20Files/Klados/resources/app.asar/out/renderer/index.html').pathname   // true
```

So a UNC-shaped `file://host/…` URL with the app's path passes **both** the navigation guard and the
IPC sender guard. No reachable trigger is known, because a share named `C:` cannot exist. The guard's
own doc comment, though, promises "the same **file**", and it cannot keep that promise while the host
is unchecked.

### The change

Compare `parsedTarget.host === parsedApp.host` as well in the `file:` branch. The production app URL
has an empty host, so the only effect is that any URL *with* a host is refused.

**Not changed:** the case of the path. `file:///c:/…` vs `file:///C:/…` is currently refused, and
widening the comparison is the wrong direction for a guard. If Electron ever reports the app's own
URL in a different case, the IPC test in `mainElectron.test.ts` goes red, and it would be noticed.

## 3. Acceptance criteria

All commands are run against a fresh `npx electron-vite build && npx electron-builder --dir`. The
paths below are Windows; the same checks run on the macOS and Linux `--dir` output with their own
binary paths. CI already runs `electron-builder --dir` on all three (`ci.yml`), so the packaged checks
become a test file that runs after that step, not a manual pass.

### R230

1. **These must not run code.** The exact Windows commands follow. In each, the probe's output or
   marker file is what must be absent. The process is killed after 10 s, because with the fuses off
   it starts the GUI instead.
   ```bash
   ELECTRON_RUN_AS_NODE=1 dist/win-unpacked/Klados.exe -e "require('fs').writeFileSync('r230-runasnode.txt','x')"
   ```
   → no `r230-runasnode.txt`.
   ```bash
   NODE_OPTIONS="--require ./r230-probe.cjs" dist/win-unpacked/Klados.exe
   ```
   where `r230-probe.cjs` writes `r230-nodeoptions.txt` → no such file.
   ```bash
   dist/win-unpacked/Klados.exe --inspect=9229
   ```
   → `curl -s http://127.0.0.1:9229/json/list` fails to connect.
2. **The fuse state is read back**, not inferred from the config:
   ```bash
   npx @electron/fuses read --app dist/win-unpacked/Klados.exe
   ```
   (`@electron/fuses` is already in `node_modules` through electron-builder, so this adds no
   dependency.) The output matches the table in §1, with any per-platform exception from §1 recorded.
3. **Tampering is refused** if asar integrity was enabled on a platform: change one byte inside a
   string literal in `resources/app.asar`, and the app refuses to start (non-zero exit, no window).
   This is run on a copy of the `--dir` output.
4. **The packaged app still works.** It is launched with a fresh temp
   `--user-data-dir=<tmp>` and one fixture path on the command line. Within 15 s, `<tmp>/titlebar-theme.json`
   must exist. The renderer writes it through IPC on first render
   (`TitleBar.tsx`'s `useTitleBarOverlaySync`), so the file proves the preload loaded, the sender
   guard accepted the page and the renderer mounted. It is checked on all three platforms. A
   screenshot of the opened document on Windows goes in Results as well, because the file does not
   prove the read-token fetch worked under `grantFileProtocolExtraPrivileges: false`.
5. **Each fuse is shown to matter**: with `runAsNode` flipped back to `true`, criterion 1's first
   command creates its file. The test is not vacuous.

### R231

6. `test/mainSecurity.test.ts` gains, for an app URL of
   `file:///C:/Program%20Files/Klados/resources/app.asar/out/renderer/index.html`:
   - `isAppUrl('file://evil.example/C:/Program%20Files/Klados/resources/app.asar/out/renderer/index.html', app)` → `false`
   - `isAppUrl('file://localhost/C:/…/index.html', app)` → `false`, unless Electron is measured
     to report its own page with `localhost`, in which case that is recorded and the test says so.
   - The existing same-file case still → `true`.
   - Mutation: dropping the host comparison turns the first case red.
7. `isPermissionGranted` inherits the fix through `isAppUrl`, with one test case for it. The real-app
   IPC round trip in `mainElectron.test.ts` stays green, which is the check that the guard did not
   brick the app (R164's own warning).

## 4. Not in scope

- Signing (R224 closed). Integrity validation is not a substitute for it, only a check that what runs
  is what was packaged.
- Moving the renderer off `file://` to a custom scheme. It is the direction Electron recommends, but
  a larger change; worth its own round only if §1's `grantFileProtocolExtraPrivileges` measurement
  shows it is needed.
