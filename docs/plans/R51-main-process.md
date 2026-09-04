# R51–R52 — the main process: untested, and one known-wrong behaviour

<!-- status: built -->

**Built.** R51, with R58 folded into its commit per `CLAUDE.md`'s own "Next" pointer; R52 in its own
commit after. Register: `docs/TASKS.md`.

Prompted by the pre-publication audit. `src/main` and `src/preload` are 666 lines with **no test
file of their own**, and they hold the parts an outside reviewer looks at first: file access, IPC,
the window lifecycle and the quit flow. R52 is a `docs/FINDINGS.md` "known-wrong" entry that lives
in the same file and is best fixed with R51's tests already in place.

| file | lines | covered by |
|---|---|---|
| `src/main/documents.ts` | 247 | — |
| `src/main/index.ts` | 230 | — |
| `src/preload/api.ts` | 105 | — |
| `src/preload/index.ts` | 75 | — |

---

## R51 — tests for the main-process seam

### What is already fine, so the round does not re-do it

**The security model's core logic is extracted and tested.** `documents.ts`'s own header is explicit
that "the token is the whole security model" — a protocol handler mapping a *token* to a path rather
than a URL to a path, single-use, TTL-swept, because the alternative "would be an arbitrary-file-read
oracle reachable from any script that ends up running in the renderer." That registry lives in
`src/core/readTokenRegistry.ts` and has `test/readTokenRegistry.test.ts`.

So this round is **not** about the token algorithm. It is about the Electron wiring around it, which
is where the registry's guarantees can be undone without the registry's tests noticing.

### What to cover

Worth stating as behaviours rather than as files, since the point is what must stay true:

- **`document:mintReadToken` mints only for a path the user actually chose.** The registry can be
  perfect and the handler can still hand a token to an arbitrary path.
- **The protocol handler refuses an unknown, expired or already-consumed token**, and refuses a URL
  that tries to name a path directly. This is the arbitrary-file-read oracle in the header comment;
  it deserves a test that would fail loudly if someone "simplified" the handler.
- **`stat` precedes read, and an oversized file is refused without reading a byte** (D6's rule, and
  the reason a 2 GB file does not take the app down).
- **Save writes and reports failure honestly** — a read-only target, a vanished directory, a
  permission error.
- **The `close` interception holds the window open until the renderer resolves every dirty tab**
  (R26's quit flow), and does not hold it open forever if the renderer never answers.
- **`preload/api.ts` exposes exactly the surface it means to** — a snapshot-style assertion over the
  exposed namespace, so adding an accidental passthrough shows up as a test change rather than
  silently widening the bridge.

### How, given Electron

**Do not stand up a real `BrowserWindow` for these.** The two practical routes, and the
recommendation:

- **Extract-and-test.** Most handlers are a thin shell over logic that can move into a plain module
  taking `fs`/`dialog` as parameters — exactly what `readTokenRegistry.ts` already did successfully.
  Test the extracted logic in the node project. **Recommended for the majority.**
- **Playwright `_electron` against the built app** for the few behaviours that are genuinely about
  Electron itself — the `close` interception in particular. `scripts/electron-screenshot.mjs` is the
  existing precedent for launching it.

**A caution worth writing down**: the `_electron` route needs `out/` to be current, and
`docs/FINDINGS.md` already records that nothing in the normal workflow rebuilds it. Any such test
must build first or assert against a freshly built tree, or it will silently test an old binary.

**Report rather than work around** if a handler turns out not to be extractable without changing the
IPC contract in `preload/api.ts` — that is a design signal, and the contract is deliberately narrow.

---

## R52 — the file watcher is single-document, and the app has tabs

From `docs/FINDINGS.md`'s known-wrong list:

> **The main process's file watcher is single-document.** `document:watch` replaces whatever it was
> watching — a real gap now that tabs exist below the UI (R24).

`documents.ts` keeps `let watcher: FSWatcher | null` and `let watchedPath: string | null` at module
scope. The comment says why, and it was right when written: M1 had one document. R24–R29 put tabs
underneath a UI that still assumes one.

**The user-visible behaviour today:** open two files in two tabs, change the first on disk, and
nothing happens — the second `document:watch` call silently replaced the first watcher. R23's
external-change notification, which exists precisely to offer "reload or keep mine," never fires for
any tab but the most recently watched one.

**Fix: a map keyed by the same identity the renderer uses for a tab**, with `document:unwatch`
taking the same key, and teardown on window close covering all of them.

Three things to get right rather than discover:

- **The existing callback guards are load-bearing.** `fsWatch`'s callback re-checks `watchedPath !==
  path` before acting, because "fs.watch's own close is not synchronous." A map does not remove that
  need — each entry needs the equivalent generation check, or a late callback from a closed watcher
  fires against whatever now occupies its key.
- **Two tabs can watch the same path.** Same file opened twice is legal, and refcounting one watcher
  per path is the sane shape — but then `unwatch` must decrement rather than close.
- **Watchers are a finite OS resource.** Bounded by tab count, which R28's budget already bounds, so
  this is a note rather than a risk — but say so in the code rather than leaving the next reader to
  wonder.

**This is where R51's tests pay for themselves**, which is why the two share a document: the failure
mode is "a notification silently stops firing," and that is invisible in manual testing unless you
think to check it.

---

## R51 — Results

Built via the plan's own "extract-and-test" route for everything except the two behaviours that are
genuinely about Electron itself.

**Extracted, three new plain modules, none importing `electron`:**

- `src/core/mainDocumentIO.ts` — `statDocument`/`writeDocument`, pulled out of the
  `document:stat`/`document:write` handlers verbatim (they never touched `electron` in the first
  place; they just weren't importable on their own before).
- `src/core/readTokenProtocol.ts` — `handleReadTokenRequest`, the `nodepad-file://` protocol
  handler's actual logic (stat-then-stream, single-use consumption, 404 on unknown/expired/consumed
  or on a vanished file), pulled out of `registerReadTokenProtocol`'s inline closure. Testable with
  Node's own global `Request`/`Response`/`ReadableStream` — no Electron `protocol` API needed.
- `src/core/mainQuitFlow.ts` — `handleWindowClose`/`confirmQuit`, R26's `close`-interception guard,
  pulled out of the `mainWindow.on('close', ...)` handler and `app:confirmQuit`'s IPC listener.
  **Not in the original plan** — added after the finding below made it necessary.

`src/main/documents.ts` and `src/main/index.ts` are now thin wiring calling into these; the doc
comments explaining *why* each handler exists stayed where they were, since the plumbing is still
Electron-specific even though the logic behind it isn't.

New tests: `test/mainDocuments.test.ts` (11 — `statDocument`/`writeDocument` against real temp
files, including a write-bit-cleared read-only file and a missing target directory;
`handleReadTokenRequest` against real temp files and a real `ReadTokenRegistry`, including the
single-use and vanished-file cases), `test/mainQuitFlow.test.ts` (4 — intercept/proceed/confirm
sequencing against plain objects, and the `WeakSet`'s per-window isolation), plus
`test/mainElectron.test.ts` covering what only a real Electron process can (below).

**Finding, not in the plan: Playwright's `_electron` cannot test the `close`-interception behaviour
at all.** The plan recommended it explicitly ("Playwright `_electron` against the built app for the
few behaviours that are genuinely about Electron itself — the `close` interception in particular").
Measured directly: a `BrowserWindow.close()` call issued through `_electron`'s automation tears the
window down regardless of `event.preventDefault()` in the `close` handler. Isolated with a
standalone, non-Playwright Electron script running the *identical* prevent-default logic against a
`data:` URL window — outside Playwright's automation, the window correctly stays open. So this is
`_electron`'s own limitation (plausibly: Playwright force-tears-down windows it's driving to keep
its own automation lifecycle deterministic), not a bug in `main/index.ts`. **Report rather than work
around**: rather than accept a test that cannot pass for the right reason, `handleWindowClose`/
`confirmQuit` were extracted into `src/core/mainQuitFlow.ts` and unit-tested directly instead —
`test/mainQuitFlow.test.ts` covers the sequence `_electron` couldn't (first close intercepted →
`confirmQuit` marks the window → second close proceeds), plus the `WeakSet`-per-window guarantee.
This is now `docs/FINDINGS.md`'s own trap for anyone reaching for `_electron` to test this area
again.

**`test/mainElectron.test.ts`** — the two behaviours left that are genuinely only testable against a
real Electron process, via Playwright's `_electron` (the same route `scripts/electron-screenshot.mjs`
already uses):

- **The preload bridge's exposed surface**, snapshotted as a shape assertion (function/string/nested
  object) over `window.api` — an accidental passthrough now shows up as a test diff instead of
  silently widening the bridge, per the plan's own "What to cover" list.
- **R58's zoom acceptance** (folded in — see below): `getZoomFactor() === 1` after a fresh
  `file://` load of the built app.

Per `docs/FINDINGS.md`'s existing "`out/` is not rebuilt by anything you normally run" trap, this
suite checks for `out/main/index.js` first and **skips with an explanatory `console.warn`, not a
silent pass**, when it's missing — run `npx electron-vite build` first (CI already does, as its own
step before `npm test`).

**What R51's plan asked for and this round does not cover, on purpose:** `document:openDialog` and
`document:saveAsDialog` still call `dialog.show*Dialog` directly — genuinely Electron-only (a native
dialog cannot run headless, in `_electron` or otherwise) and not exercised here. The plan's mint
handler bullet ("`document:mintReadToken` mints only for a path the user actually chosen") is
addressed by testing the registry's own mint/take/TTL mechanics (already covered by
`test/readTokenRegistry.test.ts`) and the protocol handler's refusal of anything not minted through
it; the IPC surface itself trusts whatever path the renderer passes, same as `document:stat` and
`document:write` — this project's renderer is first-party bundled code, never remote or
user-supplied content, so that trust boundary is the existing, accepted design, not a gap this round
introduces or should quietly narrow. Flagged here rather than silently expanded past the plan's own
scope.

**Review.** Read as a separate pass over the diff before this commit: the extraction changes nothing
about *what* each handler does (same size/write-access/stream/single-use logic, same error
propagation), only *where* it lives — confirmed by diffing `documents.ts`'s and `index.ts`'s
behaviour before and after against the new tests. `npm run typecheck` and `npm run lint` both clean
(3 known warnings, unchanged). Full node suite (1139 tests, 88 files) still green.

---

## R58 — Results (folded into this commit)

`createWindow` now calls `mainWindow.webContents.setZoomLevel(0)` inside a `once('did-finish-load',
...)` listener, added right after the window-open handler — `once`, not `on`, so a future reload
(R59 doesn't reload the page) never stomps a user's own zoom back to 1.0.

Verified via `test/mainElectron.test.ts`'s first test: `getZoomFactor()` reads `1` on a freshly built
app's first `file://` load, where it read `1.25` before this fix (re-confirmed against the exact
measurement route `docs/plans/R58-zoom.md` §1 used). The document's own root cause is still not
identified, and this fix doesn't depend on knowing it — it sets the value explicitly rather than
inheriting whatever Chromium picks for the scheme.

`docs/FINDINGS.md`'s "The built app renders at zoom factor 1.25" entry is retired by this fix (see
that file) — it recorded a defect this round closes, not an ongoing fact to keep checking.

---

## R52 — Results

Built as the plan specified, in its own commit after R51/R58: a map keyed by the renderer's own tab
identity, one real OS watcher per unique path underneath, refcounted.

**`src/core/documentWatchers.ts`** (new, no Electron/`fs` import — `stat`/`watch` are injected, the
same pattern R51's other extractions used) — `createDocumentWatcherRegistry` owns two maps: `key →
path` and `path → { handle, lastKnownMtimeMs, keys }`. `watch(key, path, onChange)` releases `key`'s
previous registration first (one key watches at most one path — the per-key version of the
predecessor's "watch replaces whatever it was watching"), then joins or creates the path's entry.
`unwatch(key)` decrements; the underlying watcher only closes when a path's last key leaves.
`unwatchMatching(predicate)` releases every key a predicate accepts, for main's own window-close
teardown.

**The three things the plan called out to get right, each addressed directly:**

- **The stale-callback guard**, generalized from "is this still the watched path" (a `string`
  comparison) to "is this still the watching entry" (`pathEntries.get(path) !== fresh`, an object-
  identity comparison) — necessary because a path can now be re-watched under a *fresh* entry (a
  different key picks it up after the first one unwatched) while an old callback for the *closed*
  entry is still in flight. `test/documentWatchers.test.ts`'s "a stale callback from a torn-down-
  and-replaced watcher... does not fire" pins this down directly — it failed on a first draft that
  compared only `path` (not entry identity), because a same-path rewatch legitimately does have the
  same `path` string, and the old check couldn't tell the two entries apart.
- **Refcounting, not duplicating, a shared path.** `test/documentWatchers.test.ts` — two keys on one
  path produce exactly one call to `deps.watch`; unwatching one leaves the shared watcher open for
  the other; unwatching the last one closes it.
- **Bounded by tab count** (R28's budget) — noted in `documentWatchers.ts`'s own header rather than
  left implicit.

**`main/documents.ts`** is the thin wiring: `document:watch`/`document:unwatch` now take a `key`
alongside `path`, and a `keySenderIds: Map<key, webContents.id>` — outside the registry itself, since
the registry has no reason to know about `BrowserWindow` — is what lets `app.on('browser-window-
created', ...)`'s `webContents.once('destroyed', ...)` release every watch a closing window owned
(the plan's "teardown on window close covering all of them"), via `watchers.unwatchMatching`.

**The IPC contract and the renderer side both changed to carry `key` through:**

- `preload/api.ts`/`preload/index.ts`: `watch(path, key)`, `unwatch(key)`,
  `onExternalChange(callback: (key: string) => void)` — every session in the renderer process shares
  the one `document:externalChange` channel (each `DocumentSession` calls `ipcRenderer.on` for
  itself), so without the key every open tab's session would react to every other tab's file change.
- `documentSession.ts` gained `DocumentSessionDeps.watchKey` (a fallback auto-generated key for every
  direct/test call, so the dependency only matters where `tabs.ts` actually injects one — same shape
  as `isActive`/`estimateOtherTabsBytes`), and its `onExternalChange` subscription now filters:
  `if (key === watchKey) void handleExternalChange()`.
- **`dispose()` now calls `unwatch(watchKey)`, which it never needed to before.** Under the single
  shared watcher, a closed tab's registration was harmless to leave — the next `document:watch` call
  from any tab silently overwrote it. Per-key registration means skipping this would leak that key's
  entry in main's registry forever, growing without bound as tabs open and close. Caught by writing
  the extraction, not by a test that failed — worth stating since it is exactly the kind of thing an
  extraction is supposed to surface.
- `tabs.ts`'s `createTab` injects `watchKey: id`, and excludes `watchKey` from the `Omit<...>` a
  caller of `createTab` can override — the same treatment `isActive`/`estimateOtherTabsBytes` already
  get, for the same reason: this is `tabs.ts`'s own identity to assign, not a caller's.

**Verified:** `test/documentWatchers.test.ts` (10 new tests against fake `stat`/`watch`, covering
every behaviour above), `test/documentSession.test.ts`'s existing F8 suite updated to thread a fixed
test key through (three tests needed the change: one asserting `watch`/`unwatch`'s exact arguments,
two whose `triggerChange()` helper now needs to notify under the right key to reach the session at
all — all three failed correctly before the fix and pass after). Full node suite: 1149 tests, 89
files. Full browser suite: 94 tests, 20 files. `npm run typecheck` and `npm run lint` both clean (3
known warnings, unchanged).

`docs/FINDINGS.md`'s "The main process's file watcher is single-document" entry is retired by this
fix — see that file.
