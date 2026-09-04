# R58–R59 — content zoom

<!-- status: built -->

**Both built.** R58 folded into R51's commit (`docs/plans/R51-main-process.md`); R59 built separately,
below. Register: `docs/TASKS.md`.

The question: does Electron give us a zoom-in out of the box, since the built app's content
sometimes looks larger than `npm run dev`'s?

Two answers, and the second one is the interesting one. Electron does ship zoom, and we are already
getting it — but the size difference between the built app and dev is **not** somebody having
zoomed. It is there on a fresh launch, and it is a real defect.

---

## 1. The built app starts at 125% and dev starts at 100%

Measured against the built bundle (`out/main/index.js`) driven by Playwright `_electron`, on this
machine:

| Loaded URL | `webContents.getZoomFactor()` | `devicePixelRatio` | `window.innerWidth` (900px window) |
|---|---|---|---|
| `file:///…/out/renderer/index.html` — **production** | **1.25** | 1.25 | 720 |
| `http://localhost:5599/index.html` — the same bundle over HTTP, **dev's shape** | 1.0 | 1.0 | 900 |
| `about:blank` | 1.0 | 1.0 | — |
| `data:text/html,…` | 1.0 | 1.0 | — |

Each row is a **fresh, never-navigated `BrowserWindow`** in one launch, so nothing carries over
between them. `1.25` is not a rounding artefact: the zoom *level* reads `1.2239`, which is
exactly `log₁․₂(1.25)`.

That is the whole reported symptom, and it is not a perception: production renders every CSS pixel
25% larger than dev, so the window fits 720 CSS pixels of content where dev fits 900.

### It also means every `_electron` measurement this project has taken was at 125%

Worth stating separately, and easy to get backwards. An element's own CSS-pixel size is
**unaffected** — a 160px column measures 160 under either zoom. What changes is the viewport
(`innerWidth` 720 where dev has 900) and the device-pixel density of a screenshot (1.25 rather than
1.0). So every past probe that sampled rendered pixel colours did so at 1.25× device scale, and
every conclusion about *how much fits* — column counts, virtualization windows, overflow, wrap —
was drawn against a viewport 25% narrower in CSS pixels than dev's. None of the findings those
probes produced are invalidated by this (they were about colours being equal, or about which
element overlapped which), but it is the reason the entry is in `docs/FINDINGS.md` rather than only
here.

### What it is not

Each of these was checked rather than assumed, because each is the obvious first guess:

- **Not the display.** `screen.getPrimaryDisplay().scaleFactor` is `1`, bounds 1920×1080. The
  `devicePixelRatio` of 1.25 above is a *consequence* of the zoom (dpr = scale × zoom), not its
  cause — the `http://` row has dpr 1 on the same display in the same launch.
- **Not `--force-device-scale-factor`.** Unset (`app.commandLine.getSwitchValue`).
- **Not the harness.** A second `BrowserWindow` that Playwright never attached to shows the same
  1.25, and Electron's `process.argv` under Playwright is just `[electron.exe, out/main/index.js]`
   — no injected switches.
- **Not us.** Nothing in `src/` calls `setZoomFactor`, `setZoomLevel` or `webFrame`; there is no
  `zoomFactor` in `webPreferences` (`main/index.ts:138`).
- **Not a persisted user zoom.** `%APPDATA%/nodepad/Preferences` contains only devtools state and
  spellcheck settings — no `partition.default_zoom_level`, no per-host zoom map. So a stray
  Ctrl+scroll in some earlier session is ruled out, which was the leading theory before the file
  was read.

**What produces the 1.25 for `file://` specifically is not identified.** It is stated here as an
unexplained, reproducible fact rather than given a plausible cause, because the fix in §3 does not
depend on knowing it and a guessed mechanism in this document would be indistinguishable from a
measured one later. The one thing the table does establish is that it is **scheme-dependent within
a single session**, which is what makes it survive into a packaged build: a packaged NodePad always
loads `file://`.

## 2. Yes, Electron already ships zoom — we just never touched it

`main/index.ts` never calls `Menu.setApplicationMenu`, so Electron's **default application menu is
present** (hidden behind `autoHideMenuBar: true`, reachable with Alt). Its View submenu, read out
of the running app:

| Label | Role | Accelerator |
|---|---|---|
| Actual Size | `resetzoom` | `CommandOrControl+0` |
| Zoom In | `zoomin` | `CommandOrControl+Plus` |
| Zoom Out | `zoomout` | `CommandOrControl+-` |

So the literal question — "is there something built in we can just use out of the box" — is yes,
and it is already wired.

**Whether those accelerators fire for a real keypress is unverified here**, and the two attempts
both failed for reasons that are about the harness, not the app: Playwright's `keyboard.press`
delivers key events to the renderer over CDP, which never reaches a native menu; and invoking the
`MenuItem`s programmatically left the factor at 1.25, but a role handler receives its target window
as a click argument, so a bare `.click()` is not a valid test of the role either. What *is* verified
is that the underlying API moves this window: `setZoomLevel(0)` → 1.0, `setZoomFactor(1.5)` → 1.5,
`setZoomFactor(1)` → 1.0, with `devicePixelRatio` following each time. **Press Ctrl+0 in the built
app to settle it in a second** — if the content snaps smaller, the default menu works and §1 is
purely a startup-value bug.

## 3. R58 — start at the zoom we mean

**Set the zoom explicitly on first load rather than inheriting whatever Chromium picks for the
scheme.** In `createWindow`, on the first `did-finish-load` (not on every one — a reparse never
reloads, but a future reload should not stomp a user's own zoom):

```ts
mainWindow.webContents.setZoomLevel(0)
```

Small, but worth its own task for three reasons:

- It is the difference between a shipped app that renders at 100% and one that renders at 125% on
  an unknown fraction of machines, with no visible cause and no obvious remedy for the user.
- `file://` is exactly what a packaged build loads, so this is a defect that **only exists in the
  shipped artefact** — dev never shows it. That is the worst shape for a bug to have before
  publication.
- It must be written so that R59 can replace the constant with a restored setting rather than fight
  it (§4).

**Acceptance:** a `_electron` test asserting `getZoomFactor() === 1` after load of the built bundle.
This is the first thing `src/main` will have a test for, so it lands naturally alongside R51 —
whose plan already says to rebuild `out/` first (`docs/FINDINGS.md`), which applies here too: every
number in §1 came from a `npx electron-vite build` immediately beforehand.

## 4. R59 — zoom as a real command

R58 makes the app start at a known zoom. R59 is the feature the question implies: a zoom the user
owns.

- **Commands**: `nodepad.view.zoomIn`, `nodepad.view.zoomOut`, `nodepad.view.resetZoom`. **Invariant
  10 applies** — every command reachable from any surface must be in the palette, and it is
  enforced by test, so a keybinding-only zoom fails the suite.
- **Persisted**, next to the theme. `theme.ts` is the shape to copy — `localStorage`, applied
  before first paint, no React state — and `settings.ts` is where a non-theme setting belongs.
- **Applied through the existing preload seam**, not `webFrame` in the renderer: the zoom level
  lives on `webContents`, and `preload/api.ts` is already how the renderer asks main for
  window-level things.
- **Bounded.** Chromium will happily go to 500%; the app's own drawn title bar and status bar are
  fixed-height chrome. Clamp to something like 50–200% and confirm the title bar survives the ends.

### The trap R59 has to check: what was measured once

Zoom changes CSS pixel geometry underneath code that measures it. Three places sample geometry and
cache the result, and each needs checking under a zoom change — not under a resize, which is a
different event:

- **`gridColumnWidth.ts`** (R43, D-071) sizes columns from sampled text width. Sampled when?
- **`Grid.tsx` / `Grid.css`** row height — R40 fixed a mismatch between a virtualized cell's height
  and the row's real height. A zoom change is exactly the input that could reopen it.
- **`Raw.tsx:755`**'s character-width measurement, whose own comment claims it "stays correct across
  font-size/zoom changes." That claim is now testable and should be tested rather than trusted; the
  Scrubber and the gutter both depend on it.

None of this is a reason to skip R59. It is the reason R59 is a task and not a two-line change, and
it is worth landing after R51 gives `src/main` a test file to put R58's assertion in.

---

**Not in scope, but noticed while reading:** the default application menu also carries Reload,
Force Reload and Toggle Developer Tools, with their accelerators live in a packaged build. That is a
publication question (does a shipped NodePad want Ctrl+R to reload the renderer?), not a zoom
question, and it belongs in the publication round rather than here.

---

## R59 Results

Built as scoped: three palette-reachable commands, a persisted bounded factor, applied through the
preload seam — plus one thing §4's own trap list under-diagnosed, found by actually testing rather
than trusting the claim it named.

**Commands** — `nodepad.view.zoomIn`/`zoomOut`/`resetZoom` (`commands/builtins.ts`), `surfaces:
['palette']` so invariant 10's own test (`test/commands.test.ts`) covers them automatically. Bound to
`Ctrl+=`/`Ctrl+-`/`Ctrl+0` (`commands/keybindings.ts`) — the conventional, unshifted combos. **Whether
these actually reach the renderer given Electron's default menu binds the identical combos to its own
built-in zoom roles is left exactly as unverified as §2 already found it for the menu's own
accelerators** — this task didn't resolve that ambiguity, and didn't touch the menu to avoid it either
(reconstructing a correct default template per-platform, blind, with no display to check it against,
is a larger and riskier change than R59's own scope asked for). The palette is what invariant 10
actually guarantees; the keybindings are a best-effort convenience on top.

**Persistence** — split the way `theme.ts` and `settings.ts` already divide the work between them:
`settings.ts` gained `getZoomFactor`/`setZoomFactor`/`clampZoomFactor` (pure storage, `localStorage`,
clamped to `MIN_ZOOM_FACTOR`/`MAX_ZOOM_FACTOR` = 50%/200%, the same shape as its two existing entries),
and a new `renderer/zoom.ts` owns the in-memory `current` value, the step table `zoomIn`/`zoomOut`
walk, and applying a change — `theme.ts`'s own shape (eager apply at module load, no React state, a
subscribe list), except `apply` can't be a synchronous DOM write the way `theme.ts`'s is: Chromium's
zoom lives on `webContents`, main-process-only, so it goes through the preload seam instead
(`preload/api.ts`'s new `view.setZoomFactor`, a `BrowserWindow.fromWebContents(event.sender)` handler
in `main/index.ts`, the same per-window-not-closed-over pattern `titleBar:setOverlayColors` already
uses).

**R58's own `did-finish-load` handler is gone, not kept alongside this.** `zoom.ts`'s eager
`apply(current)` call — defaulting to `1` when nothing is persisted, exactly what the old handler did
— is a strict superset of it, reached a different way (an `ipcRenderer.invoke` round trip during
renderer module load, not a `webContents` event in main). Keeping both would race: a persisted zoom
applied by the renderer before `did-finish-load` fires would be silently stomped back to 1.0 by the
old constant. R58's own plan named this exact requirement ("must be written so R59 can replace the
constant with a restored setting rather than fight it") — done here, not discovered as a surprise.
`test/mainElectron.test.ts`'s R58 acceptance test (`getZoomFactor() === 1` after a fresh `file://`
load) now polls briefly rather than asserting immediately, since the mechanism is an async IPC round
trip racing `waitForLoadState('load')` rather than a synchronous main-process handler — still passes
against the built app.

**§4's own trap list, checked one at a time, not assumed:**

- **`gridColumnWidth.ts`'s "sampled text width"** turned out not to be a live measurement at all —
  `CHAR_WIDTH_PX = 7` is a hardcoded CSS-pixel guess (the file's own comment already says so: "a
  character count is an estimate, not a measurement"), never derived from `getBoundingClientRect`/
  `measureText`/anything else zoom could make stale. Chromium's page zoom scales the whole layout
  together, so a fixed CSS-pixel constant stays proportionally correct at any zoom by construction.
  **Not a trap; no code change.**
- **`Grid`/`Detail`/`Tree`'s `ROW_HEIGHT = 23`** is the same shape — a hardcoded CSS-pixel constant
  matched against a CSS rule (R40's own fix), not a cached measurement. Zoom scales both sides of that
  match together; it doesn't introduce a new one. **Not a trap; no code change.**
- **`Raw.tsx`'s character/line-height measurement (`handle.view.defaultLineHeight`, the line the plan
  pointed at moved to 777 as the file grew)** is a genuinely different case, and the one place the
  plan's instinct was right: it's CodeMirror's own live getter, not cached by this project's code, but
  **"live getter" turned out not to mean "always current" — measured directly** (a bare `EditorView`,
  a CSS `zoom` change, `defaultLineHeight` read again): the value did not change at all, even ~100ms
  later, until `view.requestMeasure()` was called explicitly. CodeMirror does not treat a page zoom as
  something its own `ResizeObserver` reacts to on its own, at least not on the timescale this measured.
  (The probe used CSS `zoom`, not `webContents.setZoomFactor` — the two are different mechanisms, and
  real Electron zoom might drive `ResizeObserver` differently; nothing here depends on hoping so.)
  **Fixed**: `Raw.tsx` now subscribes to `zoom.ts` and calls `handleRef.current?.view.requestMeasure()`
  on every change, for whichever `EditorView` is currently mounted — cheap, and correct across a
  same-document reparse (R41) since that never recreates the view. `test/rawZoomRemeasure.test.tsx`
  pins the wiring down (confirmed to fail without it, by reverting the change and re-running).

**Verified**: `test/zoom.test.ts` (12 tests — `settings.ts`'s clamp-on-read/clamp-on-write, `zoom.ts`'s
eager-apply-on-load, the step-table walk in both directions, never overshooting the bound after 20
repeated calls, notifying on a real change and not a no-op one, degrading without throwing when no
preload api is present); `test/rawZoomRemeasure.test.tsx` (2 tests, browser project, real Chromium);
`test/mainElectron.test.ts`'s updated preload-shape and zoom-factor-1 tests, against a freshly rebuilt
`out/`. Full suite: 113 files, 1277 tests, all green. `npm run typecheck` and `npm run lint` both
clean (3 known warnings, unchanged).
