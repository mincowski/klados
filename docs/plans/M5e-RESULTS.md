# M5e — results

R8–R11, `docs/plans/M5e-PLAN.md`, built in the plan's stated order: R10 → R8 → R11. (R9, the
pretty-print button itself, is intentionally not part of this pass — the plan's own §2 flags it
as needing a placement/UX decision first.)

## R10 — renderer test tooling

Two new dev dependencies, both approved in advance by the plan: `@vitest/browser@3.2.7` (pinned
to match the project's existing `vitest@3.2.7` — the unpinned `^` range resolves to `4.x`, which
is not installable alongside `vitest@3`) and `playwright` (`^1.62`), which supplies both the
Chromium `@vitest/browser` drives and the `_electron` launcher for 10b. `npm install` needed
`--legacy-peer-deps`: current npm (11.12.1) hits a known arborist bug
(`Cannot read properties of null (reading 'explain')`) resolving this peer set, unrelated to the
packages themselves.

- **10a.** `vitest.config.ts` now defines two `test.projects`: `node` (unchanged include glob,
  unchanged speed — still the unmodified 841-test suite, confirmed with a timed run before and
  after) and `browser` (`test/**/*.test.tsx`, real Chromium via the bundled Playwright provider,
  `@vitejs/plugin-react` so JSX compiles). `npm test` now runs `vitest run --project node`
  explicitly rather than the bare `vitest run`, so a future third project can't silently join the
  default run. `npm run test:browser` runs the browser project. No `jsdom`/`happy-dom` — the plan
  is explicit about why (confident-green tests on CodeMirror layout that doesn't exist there).
  `test/browserSmoke.test.tsx` proves the setup: renders a sized `<div>` with `createRoot`,
  asserts `getBoundingClientRect()` returns the real 120×40 — a jsdom environment would return
  all-zero rects here, so the assertion is meaningful, not decorative.
- **tsconfig.** `.test.tsx` files needed a project with `jsx` enabled; added to
  `tsconfig.web.json`'s `include` (already has `jsx: react-jsx`) and excluded from
  `tsconfig.lib.json` (no `jsx` option, would fail to compile `.tsx`). Both `typecheck:web` and
  `typecheck:lib` pass.
- **10b.** `scripts/electron-screenshot.mjs` launches the actual production build
  (`out/main/index.js`, from `npm run build`) with `playwright`'s `_electron.launch()`, waits for
  the window to settle, and writes a PNG to `docs/screenshots/`. `npm run screenshot:electron`
  runs it. Confirmed working against a real build; `docs/screenshots/title-bar.png` (committed) is
  the "before R8" capture — taken with no document open, which is why Save reads disabled already
  (8b's bug only shows once a document is open and clean).
- **10c.** R8's tests are written and land with each R8 fix, per the plan's own acceptance
  criterion ("a test that fails before the fix and passes after") — see the R8 section below for
  where each one lives.

**What this still cannot cover**, unchanged from the plan's own list: Snap Layouts, the taskbar
icon, native caption-button painting, macOS traffic lights and fullscreen, Windows high-contrast.

## Post-R8 follow-up (user feedback, second session)

Two more issues, found by hand after R8 shipped — both fixed, both now covered by real-Chromium
tests.

- **8a's header stopped being dimmed.** The children table's header row reuses each column's own
  `.detail-child-*` class for width alignment (`Detail.tsx`), so giving `.detail-child-name`/
  `.detail-child-preview` `--surface-fg` also lit up the *header's own* copies of those classes —
  the two rules tie on specificity and the later one in the file wins regardless of where the
  element sits. Also requested: the "children" (count) column should read at full strength too,
  not just name/preview. Fixed with a higher-specificity override
  (`.detail-children-header .detail-child-*`) that keeps every header cell dimmed regardless of
  column, plus `.detail-child-count` → `--surface-fg` in the body. `test/r8Layout.test.tsx`'s R8a
  block was rewritten with scoped queries (`.detail-children-header .detail-child-name` vs
  `.detail-child-row .detail-child-name`) — the original version queried `.detail-child-name`
  globally, which matched the *header's* span first (DOM order) and so never actually compared a
  body row against the header; confirmed both new assertions fail against the pre-fix CSS and
  pass after.
- **The mark and title text looked vertically misaligned**, though every element's *box* measured
  centered on the same 18px line exactly (`getBoundingClientRect`). The real cause was optical,
  not layout: the mark's artwork ink is 12px tall and already ink-centered in its own box (top 12,
  bottom 24 — measured via `SVGGraphicsElement.getBBox()`), while the "N" glyph's cap-height ink is
  only 9px and sits low in its line box (top 14.5, bottom 23.5 — measured via canvas
  `TextMetrics.actualBoundingBox{Ascent,Descent}`, since a capital letter has no descender but the
  font still reserves descender space below the baseline). Ink centers were 1px apart (18 vs 19).
  `.title-bar-mark` now carries `transform: translateY(1px)`, matching the two ink centers exactly
  — verified by rebuilding and re-measuring, not just eyeballing a screenshot.
  `test/titleBarInkAlignment.test.tsx` renders the real `Mark` component next to real
  `.title-bar-title` text and asserts the ink centers are within 0.5px; confirmed failing (1px
  apart) before the fix and passing after.
- **Raw's scroll-to-caret centered the target line.** 8f wired the mechanism up but chose
  `EditorView.scrollIntoView(pos, { y: 'center' })`, landing the selection mid-viewport with no
  visual anchor to where the view scrolled from. Changed to `y: 'start'` with
  `yMargin: view.defaultLineHeight`, landing the target as the *second* visible row (one line of
  leading context) instead — `defaultLineHeight`, not a hardcoded pixel value, so it stays correct
  across font-size/zoom. `test/rawScrollPosition.test.tsx` drives a real `EditorView` in real
  Chromium (the exact CodeMirror call `jumpTo` now makes) and measures actual scroll geometry —
  jsdom has no layout to check this against at all.

## R8 — six fixes from the first real session

All six built as described; nothing needed a different approach than the plan's own diagnosis.

- **8a.** `.detail-child-name`/`.detail-child-preview` → `--surface-fg` (were
  `--surface-fg-secondary`, same as the header). `test/r8Layout.test.tsx`'s first case renders
  the real `Detail.css` classes in real Chromium and asserts the row's computed `color` differs
  from the header's and matches `--surface-fg` resolved — confirmed failing before the fix
  (`'rgb(84, 93, 110)' not to be 'rgb(84, 93, 110)'`, i.e. row and header were identical) and
  passing after.
- **8b.** `nodepad.document.save`'s `enabledWhen` is now `'isDirty && !isReadOnly'` (was
  `'!isReadOnly'` alone); `when` is untouched, per D-056's "disabled, not hidden."
  `test/commands.test.ts`'s new `R8 fixes` block checks `isCommandEnabled` on the *real*
  registered command (via `builtins.ts`, not a synthetic fixture) for both a clean and a dirty
  context.
- **8c.** `.title-bar`'s `border-bottom` is gone; `.layout` (`Layout.css`) carries a `border-top`
  instead — one pixel below the row Windows' `titleBarOverlay` paints over, and on an element that
  carries none of `.title-bar-win32`'s 138px caption-button reservation, so it spans the window's
  full width. `test/r8Layout.test.tsx`'s second case confirmed this failing before (`'1px' to be
  '0px'` — the border was still on `.title-bar`) and passing after; visible in
  `docs/screenshots/title-bar.png`'s full-width divider line under the bar.
- **8d.** Toggle Detail Pane's icon is `apps-list-detail` (was `document`, now unused and removed
  from `commands/icons.ts`). `test/commands.test.ts` asserts the real command's icon resolves and
  differs from Tree's and Raw's own; visible in the screenshot (middle title-bar icon, no longer a
  plain document glyph).
- **8e.** The Find bar moved from `position: fixed` (viewport-relative, landing under Windows'
  caption buttons) to `position: absolute` inside `.raw-container` (`Raw.tsx` now mounts
  `<FindBar>` there instead of `App.tsx`). `flex-wrap` is gone; the footnote now sits on its own
  row via a `.find-bar-row` wrapper (flex-column outer, flex-row inner) rather than relying on
  wrap to push it down — `flex-wrap` alone would have made the bar reflow *mid-control* once wrap
  was dropped without also restructuring where the footnote sits. `test/r8Layout.test.tsx`'s two
  Find cases confirmed the wrap regression failing before (`expected 2 to be less than 2` — the
  footnote's row candidates weren't level) and passing after.
- **8f.** `DocumentSession.setSelectedNode` now takes `{ moveCaret?: boolean }` (default `true`)
  and moves the caret to the node's span start via `store.spanOf(node).start` — `selectNode.ts`
  (the shared Tree/Detail/Raw entry point) forwards a new `SelectNodeOptions.moveCaret`, and
  `rawCaretSync.ts` passes `{ moveCaret: false }` since that selection *is* the caret moving.
  `test/documentSession.test.ts` gained two cases directly on `setSelectedNode` (moves the caret
  by default; leaves it alone with `moveCaret: false`) — both against the real state-update logic,
  not a mock. **Not covered by an automated test**: the actual Raw-view scroll this produces
  (mounting CodeMirror + a live Tree click) — `selectNode.ts`'s hardcoded `activeSession` singleton
  makes it hard to substitute a test session the way `documentSession.test.ts`'s harness normally
  does, and building a second harness for just this wasn't attempted. Flagged rather than silently
  assumed working, the same way `M5c-RESULTS.md`'s J9 and `M5d-PLAN.md`'s R6 flag their own
  GUI-only gaps; `docs/screenshots/title-bar.png` doesn't exercise this path either (no document is
  open in that capture).

All four typecheck projects, `npm test` (909 passing, unchanged file count from before R8 —
2 new cases in `documentSession.test.ts`, 2 in `commands.test.ts`), `npm run test:browser` (both
`browserSmoke.test.tsx` and the new `r8Layout.test.tsx`) and `npm run lint:css` pass.
`docs/screenshots/title-bar.png` was recaptured after R8 through the real Electron build.

## R11 — the XML formatter (reopens D-045)

Built as `docs/DECISIONS.md` D-058 records in full; summarized here. `xmlCapabilities.canFormat`
is `true`; `xmlFormatModule.format` is a two-pass conservative pretty-printer in
`src/formats/xml/index.ts`, added without touching `src/core/types.ts`.

- **Pass 1** (`collectFormatInfo`) runs the module's own real `parse()` through a recording
  `NodeSink`, producing a `Map<Offset, FormatInfo>` (`isMixed`, `preserve`,
  `hasStructuralChildren`) keyed by element span-start — the same verdicts a real parse's
  `NodeFlags.IsMixed`/`Frame.preserve` would give, because it's the same parse.
- **Pass 2** (`emitChild`/`formatElement`) re-walks the identical grammar via the same tokenizer
  primitives `parse` itself uses (`scanName`, `scanAttributes`, `skipWhitespace`,
  `matchesLiteral`, `scanUntilLiteral`), looking each element up in pass 1's map rather than
  re-deriving anything. A mixed or `xml:space="preserve"` element is copied byte-identical and
  never recursed into, via `captureVerbatimSpan` — `runParser`'s own `stopAtStackLength` resume
  shape (`parseRange`'s own mechanism), not a new one.
- **A real bug, caught by the invariant suite rather than a hand-written example**: the Document
  root's span starts at byte 0, the same offset as its first child whenever there's no leading
  content — pass 1's map briefly keyed only by span-start, so the root's own entry (recorded
  after its child's, since it closes last) silently clobbered the child's correct verdict.
  `test/xmlFormat.test.ts`'s 300-sample generated-corpus round-trip check failed on this before
  the fix (never storing a `NodeKind.Document` entry, since neither `formatElement` nor
  `emitChild` ever look one up) and passes after. D-058 has the full account.
- **Encoding**: BOM-then-declared-then-UTF-8 (`core/encoding.ts`'s own order), refused — thrown,
  caught by `documentSession.ts`'s existing `applyTransform` error handling, surfaced as
  `pendingParseError` — for anything but UTF-8. Currently unreachable from the UI (Format is
  gated on `!isReadOnly`, and every UTF-16 document already opens read-only), so this is a
  `format()`-as-a-function guarantee, not something a user can currently trigger.
- **Whitespace-insertion gate**: `!isMixed && !preserve && hasStructuralChildren` — an element
  whose only children are elements/comments/PIs/DOCTYPE gets each on its own indented line; a
  leaf's own text or CDATA-and-text-only content is always verbatim, one line, never split.

**Verification.** `test/xmlFormat.test.ts`: a 300-sample generated corpus (random depth,
attributes, comments, CDATA, PIs, mixed content, `xml:space` scopes, whitespace) checked against
three invariants — `format(format(x)) === format(x)`, re-parsing the output yields a
structurally-identical tree (kind/name/value/attrs, compared independent of byte offsets), and
every `IsMixed`-flagged span survives byte-identical somewhere in the output — plus eleven named
cases for the acceptance criteria's specific shapes (leaf-never-split, self-close, empty,
whitespace-only leaf, CDATA leaf, XML declaration, BOM, attribute spacing). Two pre-existing tests
that asserted the *old* D-045 behavior (`test/parseWorker.test.ts`,
`test/documentSession.test.ts`) were updated to assert the new one — both now exercise real XML
formatting through the same worker/session path JSON already used, not a mock.

`npm run build` + `npm run screenshot:electron` still succeed (unrelated to R11's own surface, but
confirms nothing broke end-to-end after the `core/types.ts`-adjacent import changes).

### Follow-up: R11 re-aligned against the plan's own later amendment

`docs/plans/M5e-PLAN.md` was amended (commit `ffff2db`) to make the skip rule's subtree scope explicit
and to ask for a skip count in the alert strip. Checked against the implementation above:

- **Subtree-scoped skip: already correct in behaviour, now also correct in mechanism.** The
  `<p>Text <b><a>with a link</a></b> and more text</p>` trap (mixed `<p>`, non-mixed `<b>`/`<a>`
  nested inside it) already round-tripped byte-identical, since `captureVerbatimSpan` never
  recursed into a mixed/preserve element to begin with. Changed anyway: `FormatInfo` now carries
  the element's own `end` (pass 1's `spanEnd`, free at `closeNode`), and `formatElement`'s
  mixed/preserve branch copies straight to that offset instead of calling `captureVerbatimSpan`
  (which re-tokenizes) — matching the plan's explicit "pass 1 records the end offset... so pass 2
  can jump," and avoiding double-tokenizing a mixed subtree's own bytes. The trap case is now a
  named test in `test/xmlFormat.test.ts`, not just something the generated corpus might happen to
  cover (it needs a non-mixed element nested inside a mixed one — an unlikely shape for a random
  generator to hit reliably).
- **Skip-count reporting: deliberately not built.** `format()`'s signature is fixed by
  `core/types.ts`, with no room to return anything besides bytes, and that file is off limits
  without stopping to report — which is what happened rather than picking a workaround under time
  pressure. `docs/plans/M5e-PLAN.md`'s "Report what was skipped" section carries the open question and
  four sketched routes; `docs/DECISIONS.md` D-058's addendum has the short version. This does not
  block R9 below — Format/Minify both work fully without the message; it's a status enhancement
  layered on top, not a correctness requirement.

## R9 — the pretty-print button

Built. `nodepad.document.format` (`src/renderer/session/commands.ts`) now carries `surfaces:
['palette', 'paneHeader']` and `pane: 'raw'` (was `['palette']` only), plus a new icon —
`code-text` (`code_text_20_regular`, `commands/icons.ts`). No component changes were needed:
`Layout.tsx`'s `PaneShell` already renders whatever's registered for `paneHeader` on a given pane
(the exact mechanism Tree's Expand All/Collapse All and Raw's own Toggle Soft Wrap already use),
so registering the command correctly is the whole implementation.

- **Placement**: D-057's already-settled call — Raw pane header, beside Toggle Soft Wrap.
- **Visibility**: `when: 'canFormat && !isReadOnly'` (unchanged from before R9) — hidden, not
  disabled, matching every other existing `paneHeader` command's own convention (unlike the title
  bar's D-056 "disabled, not hidden" rule, which is specific to document-scope commands there).
- **Minify** stays palette-only, per the plan's own explicit call — not an oversight.

**Verification.** `test/commands.test.ts`'s new `R9 — Format button in the Raw pane header` block
checks the real registered command against the real registry: it's reachable from the palette
(invariant 10), resolves a real icon, appears in Raw's `paneHeader` list when
`canFormat && !isReadOnly`, is absent (not just disabled) when either condition fails, and never
appears in Tree's or Detail's own pane headers. `npm run build` and `npm run screenshot:electron`
both succeed. **Not verified**: the button's live rendering with an actual XML document open —
Playwright's `_electron` can drive the built app generically, but opening a specific file needs
either the native Open dialog (not scriptable) or a real OS-level drag event (`webUtils
.getPathForFile` returns nothing for a JS-constructed `File`, so a synthetic drop doesn't work
either); no session building this had a way around it. Same category of gap `M5c-RESULTS.md`'s J9
and `M5d-PLAN.md`'s R6 already flag rather than smooth over — the registry-level check above is
what a real Chromium session *can* verify, and it's what R10's own tooling is built to catch a
regression in.
