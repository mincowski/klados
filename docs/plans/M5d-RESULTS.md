# M5d — results

R1–R7, `docs/plans/M5d-PLAN.md`, all built and committed in order (R1 → R2 → R7 → R3 → R4 → R5 → R6).
Two gaps found while building are recorded in `docs/DECISIONS.md` D-056 rather than re-derived
here: the registry had no way to express "disabled, not hidden" (R7), and `nodepad.document.open`
would have collided with an icon already in use (R4).

## What was built

- **R1.** Windows: `titleBarStyle: 'hidden'` + a `titleBarOverlay` recoloured over IPC
  (`titleBar:setOverlayColors`) whenever the renderer's theme changes, seeded on startup from a
  small persisted `titlebar-theme.json` in `userData` so the first paint doesn't flash light
  chrome. macOS: `titleBarStyle: 'hiddenInset'` with a 78px reserved inset that collapses in
  fullscreen. Linux: untouched — still `frame: true`, no overlay, no inset; `TitleBar` still
  renders its own content there, just without either platform's reserved space. Focus/blur and
  fullscreen state reach the renderer over two narrow new preload channels. `TITLE_BAR_HEIGHT_PX`
  (`src/shared/titleBar.ts`) is the one number feeding both `titleBarOverlay.height` and the
  drawn bar's own height.
- **R2.** `nodepad.layout.toggle{Tree,Detail,Raw}` moved from `commandBar` to the new `titleBar`
  Surface — verified these three were its only users before moving them, per the plan's own
  instruction to check rather than assume.
- **R7.** Save/Undo/Redo render in the title bar beside the filename, **disabled rather than
  hidden** when unavailable. This needed `Command.enabledWhen` — a second, independent gate from
  `when` — plus `commandsForSurfaceUnfiltered`/`isCommandEnabled`, so the palette's existing
  "hide when it would be a no-op" behaviour (M3-PLAN.md F9) stays exactly as it was. D-056 has
  the full reasoning for why this was a real gap rather than something to route around.
- **R3.** `CommandBar` and `.command-bar*` are deleted; `'commandBar'` is gone from `Surface`.
  `DocumentStatus` is now the alert strip under the title bar and renders nothing at all — not an
  empty padded row — unless there's a partial-parse warning, a minified-file offer, or a pending
  Transform confirmation. Its old "Open Another File…" button is gone; the title bar's own Open
  button (R4) replaced it.
- **R4.** `nodepad.document.open` gained a `titleBar` surface and its own icon
  (`folder_open_20_regular` — not `document`, already `nodepad.layout.toggleDetail`'s icon and
  visible in the bar at the same time). Always enabled: opening a second file is legal in every
  `DocumentSessionState` phase. Placed first in the document-scope group, where a tab strip's "+"
  would go later.
- **R5.** The title is the open document — leading-aligned after the mark (recorded, not left to
  CSS accident), middle-truncated via a new standalone `textTruncate.ts` (a fixed-length tail
  stays fully visible, the head shrinks and ellipsis-truncates — a shared helper so `CONCEPT.md`
  §11.4's tab strip inherits it rather than growing its own copy), the amber unsaved-changes dot,
  and a full-path tooltip.
- **R6.** Added an explicit `forced-colors` border on the drawn title-bar buttons (they'd
  otherwise have no visible boundary once High Contrast overrides `background`/`color` but
  leaves an authored `border-style: none` alone). Everything else in the pass — drag/no-drag
  regions, `user-select: none` on the title text, real `<button>`s with labels and no focus trap,
  the macOS fullscreen inset collapse, Linux's untouched native frame — was already correct from
  R1's own build; this pass also removed a duplicate accessible name (the mark and the adjacent
  title text both said "NodePad").

## What was verified, and how

Every task's typecheck/lint/test suite passes (905 tests, 0 lint errors) after each commit and
again at the end. Structural and CSS behaviour — the title bar renders, pane toggles and
Save/Undo/Redo appear with correct enabled/disabled state, Open File reaches every phase, the
command-bar chrome is gone entirely when there's nothing to say, the middle-truncation flexbox
mechanism actually shrinks and ellipsis-truncates the head under a forced narrow width, the theme
toggle recolours the mark to the exact D-054a/D-054b hex pair — was checked against the running
renderer through `electron-vite dev`'s own Vite dev server, reachable in this environment's
browser tooling.

**Not verified: the actual Electron window-chrome behaviour**, on any platform — dragging,
double-click-to-maximize, Snap Layouts appearing on maximize hover, `titleBarOverlay` recolouring
a real native caption strip, the macOS traffic-light inset and fullscreen transition, Linux's
native frame alongside the drawn bar. None of that exists in a plain browser tab; it needs a real
Electron window under a real display, which no session building this had — the same gap
`M5c-RESULTS.md`'s J9 flagged rather than smoothed over, for the same reason. R1's own acceptance
criterion ("verify by running the app") and R6's platform pass are therefore code-reviewed and
structurally exercised, not run.
