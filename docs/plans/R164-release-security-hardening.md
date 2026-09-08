# R164–R167 — security hardening before the first public release

<!-- status: built-caveat -->

**Built, with four things owed — see §9.** Register: `docs/TASKS.md`. Results in §8. A security review run against the whole Electron surface and
the parser layer, ahead of the first public 1.0.0 release. Motivated by a threat model of *a
malicious actor who knows the victim uses Klados and hands them a crafted input file, or a link
they are asked to drag into the app.*

The review's conclusion is the shape of this plan: **the malicious-file → parser surface is
already sound** (§1, a finding, not a task), and **the real exposure is an Electron navigation
gap that turns the deliberately-powerful main-process IPC into an arbitrary file read *and* write
primitive reachable by remote content** (§2, R164). §3–§5 are the lower-severity items and the
release-integrity work the review also surfaced.

A second review agent ran in parallel over the same tree; this document is written to stand on its
own regardless of what that one reported.

**Reviewed before implementation, and the review's changes are marked in place.** Every fact in §2a
and §2b was re-derived from the code rather than taken on the page's word, and §1 — the "no task"
half, and so the claim that scopes this whole round — was re-run rather than re-read. All of it
held. Four things changed: **sender validation joins R164** (§2d), because the plan reached
`will-navigate` and stopped while the same chain has a second chokepoint at the IPC seam that
**not one of 14 handlers guards**; a **blanket permission deny joins R165**; **R167's hashing moves
to one final job** over the published assets rather than a step per runner; and §1's
`process.argv` sentence is corrected. Nothing was removed, and no severity moved.

---

## 1. What the review verified is safe — the parser layer (no task)

This is recorded because it is the half of the threat model the user asked about first, and
because a later reader deciding where to spend hardening effort should not re-investigate it. Every
claim here was **run**, not read, through the `npm run inspect` CLI against crafted fixtures.

| Attack | Fixture | Result |
|---|---|---|
| XXE / external entity | `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///c:/windows/win.ini">]>` | **Not resolved.** DOCTYPE is an opaque token; `&xxe;` is left literal in the element value. No file read, no network fetch. |
| Billion laughs / entity amplification | nested `&lol4;` … `&lol;` entity chain | **No expansion.** Entities are never expanded; the reference stays literal. No memory amplification. |
| Deep nesting, stack overflow | `<a>`×200 000 / `[`×200 000 (XML, JSON) | **Capped.** `DEFAULT_MAX_DEPTH = 10_000` (`core/parseDefaults.ts`); parse stops with `complete: false` and one diagnostic. Iterative parser (invariant 4), no recursion, no overflow. |
| Pathological CSV | 500 000 columns on one row; a 5 MB unterminated quoted field | **Handled.** Diagnostic emitted, bounded time, no OOM, no hang. |
| Oversized document | — | Gated **before any byte is read**: `stat` first, then `SOFT_CAP_BYTES` (500 MB, confirm) / `HARD_CEILING_BYTES` (~2 GB, refuse) in `documentSession.ts`. |

Two structural facts back this up and are worth stating so they are not re-litigated:

- **No XSS path from file content.** Node names, values and grid cells render as React text
  (escaped). The only `dangerouslySetInnerHTML` in the tree, `Icon.tsx:19`, is fed
  `resolveIcon`'s static build-time SVG imports — never document-derived content
  (verified: `icons.ts` is a fixed static-import list).
- **No OS-shell entry point.** No `fileAssociations`/`protocols` in `electron-builder.yml`, no
  `app.setAsDefaultProtocolClient`, no `open-file`/`second-instance` handler, and `process.argv`
  is never read **in `src/main`, `src/renderer` or `src/preload`** — it is read in
  `src/cli/inspect.ts:84` and `src/cli/bench-format.ts:153`, which are development harnesses that
  never ship inside the app. (Corrected in review: the original sentence said "never read", and a
  reader who greps finds two hits and loses confidence in a table that is otherwise exactly right.)
  The shell never launches Klados with an attacker-controlled path; a malicious file enters *only*
  via the Open dialog or drag-drop.

The parser layer needs no change. The exposure is entirely in the window/IPC layer, below.

**Re-verified in review, by running rather than reading**, since "no task" is the highest-leverage
claim in this document — if §1 is wrong the whole round is scoped wrong. Through `npm run inspect`
against freshly built fixtures: the XXE case parses to `value="&xxe;"` with the DOCTYPE an opaque
token and no read attempted; a six-level entity chain goes in at 529 B and produces **3 nodes and
122 B of store**, so there is no amplification; and 200 000 nested elements stop at **10 001 nodes,
`complete: false`, one diagnostic, 13.9 ms**, with no overflow. All three tables above hold.

---

## 2. R164 — the navigation gap (HIGH)

### 2a. The mechanism, as read from the code

Three facts combine into one exploitable chain. Each was read from the current tree at the line
cited.

1. **There is no navigation guard anywhere.** `src/main/index.ts` sets
   `mainWindow.webContents.setWindowOpenHandler` (index.ts:186) — which governs *new* windows — but
   nothing constrains top-level navigation of the existing `webContents`. Grep for `will-navigate`,
   `will-redirect`, `web-contents-created` across `src/` returns nothing.

2. **The drag-drop `preventDefault` is scoped to one subtree.** `onDragOver`/`onDrop`
   (`components/Layout/Layout.tsx:136,140`) are attached only to the `.layout` div
   (`Layout.tsx:201`). But `App.tsx` renders `<TitleBar />` and `<TabStrip />` as **siblings above**
   `<Layout />` — roughly 64px of window chrome (two 32px strips, per `TitleBar.css` /
   `TabStrip.css`) that is not under `.layout` and has no drop handler. A file or link dropped there
   is not `preventDefault`-ed.

3. **`window.api` is exposed on every loaded origin.** `preload/index.ts` calls
   `contextBridge.exposeInMainWorld('api', api)` unconditionally, with no origin check. The
   preload runs per-`webContents`, so it re-attaches after any navigation. The renderer's CSP
   (`default-src 'self'; script-src 'self'`) is a `<meta>` tag in `index.html` only — it does not
   travel with the `webContents` across a navigation to a remote page, which carries its own (or
   no) CSP.

### 2b. Why it is HIGH — the amplifier

The main-process IPC is, by design, a pair of powerful primitives that trust the renderer:

- `document:mintReadToken(path)` (`main/documents.ts:88`) mints a single-use token for **any**
  path with no validation; the worker then `fetch`es `klados-file://<token>/`. The scheme is
  registered `standard, secure, supportFetchAPI, corsEnabled, stream` (documents.ts) — fetchable
  from any script in the renderer, not just the worker. → **arbitrary file read.**
- `document:write(path, bytes)` (`main/documents.ts:138` → `core/mainDocumentIO.ts`
  `writeDocument`) writes **any** bytes to **any** path, and its own comment says it *"overwrites
  unconditionally; the caller (`isReadOnly`) is what keeps this from ever being invoked against a
  file the user can't write to."* A remote page calls the IPC directly and never runs that caller.
  → **arbitrary file write** (e.g. a payload into a startup / autorun location → code execution).

The token model's stated security premise — *"the token is the whole security model … a token is
minted only … for a path the user has actually chosen"* (`documents.ts` header) — holds **only
while the renderer cannot be navigated away from `index.html`.** Nothing enforces that today. So
the correct reading is: the token design is sound, and R164 is what makes its premise true.

**Full chain:** attacker page presents "drag this to Klados" → user drops the dragged link onto
the title bar / tab strip (unguarded) → Chromium's default drop action navigates the top frame to
the attacker origin → the preload re-exposes `window.api` there → the page reads and writes
arbitrary files on the victim's machine.

### 2c. What is verified vs. asserted — honesty about the trigger

Per `PLANNING.md` §2: facts (1)–(3) above are **read from the code and are certain**. The specific
claim that *Chromium performs a default top-frame navigation when a link/file is dropped on an
unguarded region* is **taken from Electron's documented default and its security checklist, not
reproduced in this app** — native drag-drop cannot be driven from the test harness or the in-app
browser, both of which are separate from the real Electron window.

This is deliberately not the load-bearing part. **The `will-navigate` guard closes the hole
regardless of whether drag-drop is the trigger**, because it denies *every* unexpected top-frame
navigation whatever its cause (a dropped resource, a stray `window.location` assignment, a future
feature, a bug). That is exactly why Electron's own checklist lists the handler as the mitigation
rather than listing each trigger. R164's acceptance (§2e) therefore does not hinge on reproducing
the drop.

### 2d. The fix

**Primary (load-bearing) — a navigation guard in main.** In `src/main/index.ts`, under
`app.on('web-contents-created', …)` (or on the window's `webContents` directly), deny any
top-frame navigation whose destination is not the app's own origin:

- Dev: the destination must equal `process.env['ELECTRON_RENDERER_URL']`.
- Production: the destination's protocol must be `file:` (the `loadFile` origin). `klados-file:`
  is a `fetch` scheme, never a navigation target, so it is not on the allowlist.
- Cover both `will-navigate` and `will-redirect`; `e.preventDefault()` on a miss.

**Use the app-level `web-contents-created` form, not the window's `webContents` directly**
(settled in review, where the plan offered both). The whole value of this guard is that it catches
triggers nobody enumerated — §2c's own argument — and a guard attached to one `webContents` covers
only the contexts that exist at the moment it runs. The app-level form covers every context the app
ever creates, including ones a future round adds without remembering this document.

**Also load-bearing, added in review — validate the sender of every IPC message.** The plan reached
`will-navigate` and stopped; the same chain has a second chokepoint it did not consider.
**There are 14 `ipcMain` registrations across `main/index.ts` and `main/documents.ts`, and not one
checks who is calling.** `event.sender` appears six times and every use is
`BrowserWindow.fromWebContents(...)` to find a window — never to establish an origin.

This is **not** §6's rejected path validation wearing a different hat, and the distinction is the
reason it belongs here: path validation asks *which file may this caller touch*, needs real state
about what the user has chosen, and fights three legitimate flows. Sender validation asks *may this
caller speak at all*, needs no state, and fights nothing — every legitimate caller is the app's own
renderer. It is Electron's own standing recommendation, and it is the belt to `will-navigate`'s
braces: if any future path ever reaches a context the navigation guard misses, the IPC still
refuses. One shared guard applied at the handler seam, not fourteen copies.

**Secondary (defence-in-depth + a UX gain) — a window-level drop guard in the renderer.** Move the
`dragover`/`drop` `preventDefault` off the `.layout` div and onto a window-level listener (a small
module armed from `App`, or `#root`), so **no** region of the window is ever an unguarded drop
target. Route a dropped file to the existing `openPathInNewTab` from wherever it lands — today,
dropping on the title bar does nothing useful even in the benign case, so this also fixes a real
papercut. `Layout.tsx`'s handler collapses into the window-level one; `onDragOver`/`onDrop` come
off the `.layout` JSX.

### 2e. Acceptance

- A unit/integration test asserts the `will-navigate` predicate: the dev URL and a `file:` URL are
  allowed; `https://example.com`, `file:` to an unrelated path pattern if we choose to narrow it,
  and any other scheme are denied. This is the piece that must go **red** before the guard exists.
- With the window-level drop guard, a `drop` event dispatched anywhere on the window (title bar
  region included) is `preventDefault`-ed and, for a file, routes to `openPathInNewTab`; the
  existing "drop opens in a new tab" behaviour on the body is unchanged.
- Manual confirmation on a real build that dropping a link on the title bar no longer navigates
  the window — flagged as manual because the harness cannot dispatch native DnD (§2c).
- A test on the sender guard: a frame at the app's own origin is accepted, one at
  `https://example.com` is refused, and the refusal is a rejected IPC call rather than a silent
  no-op — a handler that quietly returns nothing on a hostile call is indistinguishable from one
  that worked.

### 2f. Cost

Small and localised: one `web-contents-created` block in `main/index.ts`, one shared sender guard at
the IPC seam, one window-level listener module in the renderer, and the deletion of `Layout.tsx`'s
two handlers. No change to the token design, the protocol handler, or any parser. No new dependency.

---

## 3. R165 — `setWindowOpenHandler` passes any scheme to the OS (LOW)

`index.ts:186` calls `shell.openExternal(details.url)` for **any** URL a new-window request
carries, with no scheme check. `openExternal` hands the string to the OS handler, so a
`file:`, `smb:`, or other-scheme URL would be actioned by the OS.

**Currently unreachable** — the review found no external links, no `window.open`, and no
`target="_blank"` anywhere in the renderer (grep for `https?://` / `window.open` / `location.` in
`src/renderer` returns only comments). So this is pure defence-in-depth and future-proofing:
the moment someone adds an external link, or if any `window.open` slips past R164, this becomes
live.

**Fix:** allowlist the scheme before delegating — `http:`, `https:`, `mailto:` only — and keep the
`{ action: 'deny' }` return. **Acceptance:** a test on the handler function that a
`https://` URL is forwarded and a `file://` URL is dropped. **Cost:** a three-line guard, one
test.

**Added in review — deny web permissions outright, in the same block.** Nothing in the app calls
`setPermissionRequestHandler` or `setPermissionCheckHandler`, so Chromium's defaults apply and any
page loaded in the renderer may *ask* for camera, microphone, geolocation, notifications, clipboard
read, and the rest. **Klados is a local file viewer and editor: the correct answer to every one of
them is no**, permanently, with no prompt to misread. A blanket deny is smaller than R165's own
allowlist, sits in the same file for the same reason, and — like R165 — is unreachable today and
becomes live the moment R164's premise is ever broken. Acceptance is a test that the registered
handler denies a representative permission; cost is a two-line handler.

---

## 4. R166 — re-enable the renderer sandbox (LOW, defence-in-depth)

`webPreferences` in `index.ts:151` sets `sandbox: false`. `contextIsolation` is on and
`nodeIntegration` off (both defaults, unchanged), so the renderer's main world already has no Node
— but `sandbox: false` keeps the *preload* running with full Node access, and drops the renderer
out of Chromium's OS-level sandbox.

The preload's imports are all sandbox-compatible: `contextBridge`, `ipcRenderer`, `webUtils` from
`electron`, plus `@electron-toolkit/preload`'s `electronAPI` (bundled by electron-vite at build
time, not a runtime `require`). There is no obvious blocker to `sandbox: true`.

This is the principled answer to "the renderer holds powerful IPC" — a sandboxed renderer is a
smaller blast radius if any renderer-side compromise ever occurs — and it is a better use of effort
than trying to path-validate `mintReadToken`/`write` (see §6).

**This is framed as verify-then-enable, not "flip it," per `PLANNING.md` §2**: set `sandbox: true`
and confirm the full document lifecycle still works end to end — Open dialog, drag-drop open,
`getPathForFile`, the `klados-file://` worker fetch, Save / Save As, file watching, keybindings
read/write, zoom, title-bar overlay. **Acceptance:** the app opens, reads, edits, saves, and
watches a file on a real dev run with `sandbox: true`; if any preload seam breaks under the
sandbox, R166 reports that rather than shipping a half-working sandbox. **Cost:** one option, plus
a manual lifecycle pass on a real build. Scoped last of the code tasks because it is the one most
likely to surface a surprise.

---

## 5. R167 — publish SHA-256 checksums with each release

The builds are unsigned by design — `notarize: false`, `CSC_IDENTITY_AUTO_DISCOVERY: false` in
both `ci.yml` and `release.yml`, documented at `README.md:30`. That is a distribution-trust
property, not a code bug, and (per the README) it is expected to stay true because certificates
cost money. But an unsigned artifact with **no** integrity signal gives a downloader nothing to
verify against a tampered mirror or a man-in-the-middle — and Klados ships no auto-updater, so the
download is the whole trust decision.

The free, proportionate mitigation is a **published SHA-256 for every release artifact**, so a
user (or a package definition, or a script) can verify what they downloaded is byte-for-byte what
the release produced.

**Fix, in `release.yml`:** after the artifacts are built and before/at the point they are attached
to the GitHub release, compute a SHA-256 for each artifact and publish them — either as a
`SHA256SUMS.txt` asset attached alongside the artifacts, or rendered into the release body. Prefer
a `SHA256SUMS.txt` file in the standard `<hash>␣␣<filename>` format so `sha256sum -c` /
`Get-FileHash` verification is mechanical. The hashes must be computed **in the workflow** from the
exact uploaded files, never typed by hand.

**Settled in review: one final job that hashes the assembled release, not a step on each runner.**
The plan offered "on each runner (or gathered from all three)"; per-runner is the fiddly branch and
the wrong one. Three platforms means three shells — `sha256sum`, `shasum -a 256`, `Get-FileHash`,
each with its own output format — so a per-runner step is three code paths that must agree on a
byte-exact file format, plus a fourth to merge them. **And it would hash what each runner built
rather than what was actually published**, which is the thing a downloader is comparing against. A
single Linux job that runs after the matrix, gathers the artifacts, and emits one `SHA256SUMS.txt`
is one code path over the real assets. This matters more than it looks because, by this document's
own R141/R151 argument, **the first genuine exercise of any of it is a `v*` tag** — where a mistake
costs a deleted draft release and a moved tag.

**README:** add a short "Verifying your download" section next to the existing unsigned-build note
(`README.md:30`) showing the one-line verification command per platform (`sha256sum -c
SHA256SUMS.txt`, `Get-FileHash -Algorithm SHA256`, `shasum -a 256`).

**Acceptance:** a dry-run / workflow-syntax check that the hashing step runs and produces one line
per artifact; a manual read that the emitted `SHA256SUMS.txt` lists every published asset.
Because the release workflow only truly runs on a tag (the R141/R151 ordering lesson), R167 states
plainly that its first *real* exercise is the 1.0.0 tag, and the step is written to fail the job —
not silently skip — if it finds no artifacts to hash.

**Cost:** a workflow step (a few lines of `sha256sum` / `shasum` / `Get-FileHash`) and a README
section. No dependency, no code change.

---

## 6. Deliberately not doing — path validation on `mintReadToken` / `write`

The tempting adjacent task is to make `document:mintReadToken` and `document:write` validate their
`path` argument — refuse anything the user did not choose this session. **Rejected, with the
reason stated rather than assumed:**

- It fights the design. Both handlers legitimately serve paths the renderer chose: a Save-As
  target the user just picked, a dropped file's path, a session-restore path. A correct allowlist
  would have to track "paths surfaced through a dialog / mint this session," which is real state
  and a real chance to break Save or restore for a benign user — a high-risk change to defend
  against a threat R164 already closes at its root.
- It is the wrong layer. Once R164 stops the renderer from being navigated to hostile content, the
  renderer *is* the trusted party again, exactly as the token model assumes. R166's sandbox is the
  proportionate residual-risk reduction. Adding a brittle path allowlist on top buys little over
  those two and risks a benign regression.

If a future round still wants it, it belongs in its own document with its own measurement of what
paths the renderer legitimately presents — not smuggled into this one.

---

## Task summary

| Task | Severity | Area | Load-bearing? |
|---|---|---|---|
| **R164** | HIGH | `main/index.ts` navigation guard + IPC sender validation + renderer window-level drop guard | yes — closes the read+write exposure |
| **R165** | LOW | `setWindowOpenHandler` scheme allowlist + blanket permission deny | defence-in-depth (currently unreachable) |
| **R166** | LOW | `sandbox: true`, verify-then-enable | defence-in-depth (blast radius) |
| **R167** | release | SHA-256 `SHA256SUMS.txt` in `release.yml` + README verify section | integrity signal for unsigned builds |

---

## 8. Results

**Built, all four ids.** The marker is `built-caveat` and §9 says what is owed — none of it because
something failed, all of it because the last mile of a security change is a manual or tag-time
check.

### 8a. What landed

**R164** — three controls, one rule (`core/mainSecurity.ts`'s `isAppUrl`, asked at two
chokepoints):

- `app.on('web-contents-created')` denying `will-navigate` and `will-redirect` to anything that is
  not the app's own page. The app-level form, per §2d as amended.
- **All 13 `ipcMain` registrations** behind a sender check (`main/trustedRenderer.ts`). The plan
  said 14; the review's own count included a comment line, and the corrected number is 7 in
  `documents.ts` plus 4 `handle` and 2 `on` in `index.ts`.
- The drop `preventDefault` moved from `.layout` to the window (`renderer/dropGuard.ts`).

`isAppUrl` compares by **origin** in dev and by **exact file** in production — deliberately not
"protocol is `file:`", and that distinction is tested: mutating it to the looser rule turns
`test/mainSecurity.test.ts` red on the case the plan declined.

**R165** — an `http:`/`https:`/`mailto:` allowlist before `shell.openExternal`, and a blanket
permission deny.

**R166** — `sandbox: true`, and §8b is what it took.

**R167** — a `checksums` job that reads the assembled release back with `gh release download`,
hashes it, and uploads `SHA256SUMS.txt`; plus a README "Verifying your download" section.

Suite: **1,837 → 1,857 tests**, all passing, lint at its 3-warning ratchet.

### 8b. Three things the plan asserted that turned out to be false

Recorded prominently because §2c's whole discipline is separating what was read from what was
assumed, and each of these was on the assumed side.

**1. `sandbox: true` is not a one-line change — it broke the application outright.** The plan:
*"`@electron-toolkit/preload`'s `electronAPI` (bundled by electron-vite at build time, not a
runtime `require`). There is no obvious blocker."* electron-vite **externalizes declared
dependencies**, so the built preload still contained `require("@electron-toolkit/preload")`, and a
sandboxed preload's `require` resolves only a handful of built-in Electron modules:

```
Unable to load preload script: out\preload\index.js
Error: module not found: @electron-toolkit/preload
```

The whole script failed, `window.api` was `undefined`, and the app was inert. **This is exactly
what "verify-then-enable" was written to catch**, and it is the strongest argument in the round for
that framing over "flip it".

Fixed by **removing** `electronAPI` rather than bundling it: `window.electron` has no reader
anywhere in `src/renderer`, and the exposed-surface test only ever described `window.api`. Smaller
bridge, working sandbox, and R51's "no accidental passthrough" applied to something that had been
passing through since the project was scaffolded.

**2. `klados-file://` is not "fetchable from any script in the renderer."** §2b said it was.
Probed against the real app from page context:

```
Connecting to 'klados-file://…' violates the following Content Security Policy directive:
"default-src 'self'". Note that 'connect-src' was not explicitly set … The action has been blocked.
```

`index.html`'s own CSP blocks it; the parse worker, loaded from a bundled script with no CSP of its
own, is unaffected. **A second control on the read primitive that neither the plan nor the review
had noticed**, now pinned by a test so that widening the CSP for an unrelated reason cannot remove
it silently. **It does not weaken R164** — a page the renderer is *navigated to* carries its own CSP
or none, which is §2a.3's point exactly.

**3. The permission deny was not tidying — the default was "granted".** With the handlers removed
from a real build, `Notification.requestPermission()` returns **`granted`** — not a prompt, and not
a refusal. §3's "pure defence-in-depth" undersold it.

### 8c. Verification — what was run, not argued

Every guard in this round was checked by breaking it and watching a test fail:

| Mutation | Result |
|---|---|
| `isAppUrl`'s production branch → "protocol is `file:`" | the local-file case goes red |
| `setAppUrl` → a wrong URL, rebuilt | the real-app IPC round trip rejects with *Refused `keybindings:read` from an untrusted frame*, while both pre-existing real-app tests still pass |
| permission handlers removed, rebuilt | `Notification.requestPermission()` returns `granted` |

The second is the one that mattered most. **The sender guard is the single change in this round
that can brick the application**: if `event.senderFrame.url` and the recorded URL ever fail to
agree, every handler refuses and the renderer can neither read a file nor save one — and no unit
test of the predicate could see it, because the predicate would be entirely correct. So
`mainElectron.test.ts` now performs a real IPC round trip against the built app, and the mutation
above is the proof that the test has power over it.

§1's "no task" conclusion was re-run rather than re-read before any of this: XXE stays literal, a
six-level entity chain yields 3 nodes and 122 B, and 200 000 nested elements stop at 10 001 nodes
with one diagnostic in 13.9 ms.

**R167 was dry-run** rather than left to the tag, since by R141/R151's argument the first real
exercise is a `v*` tag where a mistake costs a deleted draft and a moved tag: three fake assets
produce three lines, a stale `SHA256SUMS.txt` is excluded rather than hashed into its own
successor, `sha256sum -c --ignore-missing` round-trips, an empty asset list fails the job with an
error annotation, the workflow is valid YAML, and the step's script parses under `bash -n`.

### 8d. Review pass, per `CLAUDE.md`

Read as `git diff` per id. Beyond §8b, it found:

- **The `.layout` drop comment already claimed what the code did not do** — *"A file dropped
  anywhere on the window opens it"* — while `TitleBar` and `TabStrip` sat above it with no handler
  at all. The same species as R159–R163's entire round: a comment describing behaviour its body
  lacks. Its D6/R26 rationale was carried across to `dropGuard.ts` rather than deleted with the
  code.
- **`secureOn` can only drop, not reject**, and one of its two channels is `app:confirmQuit` — the
  renderer's signal that every dirty tab is resolved and the window may close. A wrongly refused
  send there would present as a window that will not close, with no explanation anywhere, so the
  denial logs.
- The plan's "14 handlers" is 13 (§8a).

## 9. Owed

- **R164 — manual confirmation on a real build** that dropping a *link* on the title bar no longer
  navigates the window. Flagged as manual by §2e from the start: native drag-drop cannot be
  dispatched from the harness. The navigation guard is tested at the decision level and the drop
  guard at the event level; what stays unverified is the OS gesture that produces the event.
- **R166 — the full manual lifecycle under `sandbox: true`.** Automated coverage reaches the
  preload surface, an IPC round trip and the document read path (`stat`, `mintReadToken`). **Save,
  Save As, file watching and an edit cycle are not exercised.** Nothing suggests they are broken
  and the seam they share — the contextBridge — is proven, but §4 asked for the lifecycle and this
  is not the whole of it.
- **R167 — its first genuine exercise is the `v1.x` tag.** The dry-run covers the hashing logic;
  `gh release download` against a real draft release cannot be rehearsed without making one.
**Not owed, resolved:** `@electron-toolkit/preload` was left declared when R166 removed its only
import, on the grounds that a lockfile change before a release is the user's call. Asked and
answered — **removed**, one dependency line and one lockfile entry, no transitive fallout since its
only edge was a peer dependency on `electron` it shared with the app. `@electron-toolkit/utils` is
a different package, still imported by `main/index.ts`, and stays. This is R155's point applied
rather than deferred: a dead dependency is a permanent Dependabot signal, not a cosmetic one.
