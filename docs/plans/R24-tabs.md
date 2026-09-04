# R24–R30 — tabs

<!-- status: built-caveat -->

**Built — R29's own per-tab view state not restored.** Register: `docs/TASKS.md`. Second of the
three topics planned together (notifications → tabs → CSV).

**`CONCEPT.md` §11.4 already designs this completely** — per-tab state, a fixed 2–3 worker pool,
context keys resolving against the active tab, session restore, and a full tab anatomy down to the
format icon's per-format tint, middle truncation, same-name disambiguation, the ~120px minimum
before the strip scrolls, and the shared dirty/close slot. **Read it before implementing any task
here; it does not need re-deriving, and this document does not repeat it.**

What §11.4 does not say is what tabs cost *this* codebase. That is what this plan is for.

---

## 1. The actual cost: twelve singletons

`M5d-PLAN.md` §4 recorded it and it has not changed. The renderer has **twelve module-level
singletons that assume exactly one open document**:

`documentSession`, `findStore`, `findController`, `activeSearchStore`, `navigationStore`,
`rawController`, `rawViewportStore`, `treeController`, `gridController`, `paletteStore`,
`commands/context`, `layoutStore`.

§11.4's "all document state is per tab" turns most of those into per-document instances behind an
active-document lookup. **This is a refactor of the renderer's spine**, and it is the single
reason tabs is a milestone rather than a task.

Not all twelve are equal, and the split matters for sequencing:

| Singleton | Per document? | Note |
|---|---|---|
| `documentSession` | **yes** | the root of it — everything else follows |
| `findStore`, `findController`, `activeSearchStore` | **yes** | §11.4: search results are per tab |
| `navigationStore` | **yes** | back/forward history is per document |
| `treeController`, `gridController`, `rawController`, `rawViewportStore` | **yes** | view state; registered by a mounted pane, so lifetime follows the *active* tab, not the tab set |
| `commands/context` | **derived** | §11.4: context keys resolve against the active tab. Not per-tab storage — a projection of the active document |
| `layoutStore` | **no** | §11.4 says only preferences and theme are global; pane visibility is a window property, not a document one. **Ambiguous in §11.4 — decide explicitly in R24** |
| `paletteStore` | **no** | one palette, one window |

The controllers are worth calling out: they are registered by a mounted component and unregistered
on unmount, so switching tabs already unmounts and remounts the panes. They may need no per-tab
storage at all — only correct teardown. **Check before generalizing them**; three of the twelve
may be free.

---

## 2. R24 — de-singleton the renderer spine

The one that has to come first, and the one that carries all the risk.

`activeSession` becomes a lookup against the active document rather than a module-level instance.
Every consumer keeps its current shape as far as possible — the goal is that panes and commands do
not learn about tabs at all.

**Fold R20 in here.** `docs/plans/R19-document-props.md` §5 splits `OpenDocument` into model / file /
status slices with slice-scoped subscriptions; that is a smaller version of the reshaping this task
performs anyway, and doing it twice is waste. **R20's measurement (§5a there) still runs first and
still stands alone** — if the extra renders turn out cheap, this task inherits a recorded figure
and no obligation, rather than an unproven refactor.

**Keep the outer/inner component split.** `test/statusBar.test.tsx` and `test/treeExpansion.test.tsx`
drive the inner components directly, and those tests caught real defects in R12 and R13. The
active-document lookup belongs in the outer component, exactly where `useDocumentSession()` sits.

**Acceptance: the entire existing test suite passes unmodified, with one document open.** This is
a restructuring of working code; the suite is the safety net, the same role it played for R18's
control-flow rewrite. A test that needs changing is a signal to look, not a line to edit.

---

## 3. R25 — the tab strip

§11.4's anatomy, implemented. Nothing in it needs re-deciding.

Two things already exist and should be used rather than rebuilt: **R5's middle-truncation helper**
is the one §11.4 asks for, and **R4's Open button already sits where "+" goes** — `M5d-PLAN.md`
§4's "leave room for the strip" instruction was written for this moment.

The format icon is chosen by a **UI-side map keyed on `capabilities.id`** (§11.4), never supplied
by the format module — invariant 8's line, and the same reason the parser layer does not own syntax
token classes.

Same-name disambiguation (`data/config.yaml` beside `test/config.yaml`) is not an edge case and
should not be deferred: §11.4 is explicit that `config.yaml` open three times is ordinary.

---

## 4. R26 — lifecycle: open, close, switch

Open into a new tab; close with the §11.4 prompts; switch with keyboard and pointer.

- Closing a **dirty** tab prompts *Save* / *Discard* / *Cancel*; a clean tab closes silently.
- Quitting with several dirty tabs presents **one consolidated list with per-file choices**, not a
  sequence of modals. This is the piece most likely to be built as a modal sequence by accident.
- No autosave, ever — §11.4 is explicit that it would conflict with the byte-identical guarantee by
  writing at moments the user did not choose.

**Depends on `docs/plans/R21-notifications.md`.** The close-dirty prompt is a choice, and R21 §3a's rule
applies: derived from state, not pushed. The consolidated quit list is the one case that genuinely
warrants a modal — it blocks quitting, which is already blocking — and should be justified as such
rather than assumed.

---

## 5. R27 — the worker pool

§11.4: **a small fixed pool (2–3) with a queue, not one worker per tab.** Per-tab workers scale
badly and sit idle.

Today the codebase spawns a fresh `Worker` per parse and per transform and terminates it. That is
already close to a pool of one; the change is a queue and a small fixed set of long-lived workers.

Sequenced after R26 rather than before: the pool only matters once several documents can be
parsing, and building it early means building it against a single-document world that cannot
exercise it.

---

## 6. R28 — memory across tabs

§11.4 calls memory **the binding constraint** — three 200 MB files is ~1.5 GB at §8's ~2.5×.

- Opening a document that would exceed a configurable budget **prompts rather than silently
  degrading** — the same soft-cap shape §11.2 and `TRANSFORM_CONFIRM_BYTES` already use.
- The **statistics panel** gains the cross-tab figure. D-060 already recorded that §11.4's
  cross-tab footprint lands there once tabs exist, so this is a promise being kept, not a new
  decision.
- `computeMemoryBudget`'s O(1) property must survive summing across tabs — D-060/§3a's constraint.
- The Raw view adds ~1 MB per tab regardless of file size and stays out of the calculation, which
  is only true because it is windowed (D-031).

*Post-v1 and explicitly not here:* evicting background node stores while retaining byte buffers.

---

## 7. R29 — session restore

Reopen the previous tab set on launch. Store paths and per-tab view state; never store document
content.

**A file may be gone, changed, or grown past the budget since last launch.** Restore must degrade
per tab rather than failing wholesale, and must not turn "one missing file" into "no session." The
notification for a partial restore is application-scoped — `documentId: null` in R21 §3b's shape,
which is what that field exists for.

---

## 8. R30 — measurement pass

The milestone's own numbers, because §11.4's design rests on figures nobody has taken here:

- Peak RSS with three and six documents open, against §8's ~2.5× budget per document.
- Tab-switch latency with large documents — the pane remount cost, which today is paid only on
  open. **This is the figure most likely to be bad**, since switching remounts every pane including
  Raw's `EditorView`, and `M5g-RESULTS.md`'s deferred half of O4 is exactly that remount.
- Worker pool queueing behaviour with several parses in flight.
- Whether context-key resolution against the active tab costs anything measurable per switch.

---

## 9. Open questions for the implementer to raise, not guess

- **`layoutStore` per tab or global** (§1's table). §11.4 says only preferences and theme are
  global, which reads as per-tab; but pane visibility feels like a window property, and per-tab
  pane layout means the window rearranges itself as you switch tabs. **Report rather than decide.**
- **Does tab switching preserve Raw scroll position per tab?** §11.4 says scroll is per tab. With
  a windowed Raw view that means retaining the window bounds too, or re-slicing on activation.
- **Undo across tabs** — §11.4 says the undo stack is per tab, so `Ctrl+Z` in tab B must not undo
  an edit made in tab A. Straightforward once `documentSession` is per document; worth an explicit
  test because it is silently wrong if the lookup is missed.

---

## 10. Not in scope

**Tabs are not a workspace** (§1 non-goal, restated in §11.4): no folder tree, no cross-file
search, no project configuration. A tab is one independently opened file. This is the boundary most
likely to erode once a tab strip exists, so it is written here as well as in the concept.

---

## Results — R24 (built); R25–R30 still open

Scoped to R24 alone, deliberately: R25–R30 (the strip, lifecycle, worker pool, memory budget,
session restore, measurement) are unbuilt and unattempted this round — R24 is large enough on its
own, per its own §2 framing ("the one that carries all the risk"), to be worth landing and
verifying in isolation before building UI on top of it.

**Before R24, two of §9's own open questions were put to the project lead rather than guessed**:
`layoutStore` stays global (not per tab), and R20's §5a measurement ran first as the plan itself
required. Both recorded in D-064 and D-063 respectively; §5a's own figure (~3.3ms of render time,
summed across all five panes, for a ten-keystroke burst) meant R20's slice split was never built —
R24 inherited a number, not an obligation, exactly as `docs/plans/R19-document-props.md`'s own redirect
anticipated.

### What was built

`src/renderer/session/tabs.ts` is new: a registry of `TabEntry { id, session, searchStore,
findStore, navigationStore }`, one active-tab pointer, `createTab`/`closeTab`/`setActiveTab`, and
accessors (`getActiveSession`, `getActiveSearchStoreInstance`, `getActiveFindStore`,
`getActiveNavigationStore`) that lazily mint the first tab on first access — the same "there is
always exactly one" guarantee `activeSession.ts` used to provide by eager module-load construction,
preserved so every existing call site keeps working with zero tab UI yet to create a second one.

Four modules became **lookups against the active tab** rather than module-level singletons, each
keeping its exact public call shape so panes and commands don't learn about tabs at all (§2's own
goal):

- **`activeSession.ts`** — `documentSession.ts`'s factory was already tab-ready (its own header
  comment said so since M1); only the one-line singleton wrapper needed replacing. `getSnapshot`/
  `subscribe` compose a tab switch as a first-class event a `useSyncExternalStore` consumer reacts
  to, not just changes within one tab's own session — `useDocumentSession.ts` itself needed **zero**
  changes, since it only ever consumed `activeSession.subscribe`/`getSnapshot` as stable references.
- **`activeSearchStore.ts`** — `searchStore.ts`'s own header already said "each tab gets its own
  `createSearchStore(session)`"; this round is where that sentence became true. `dispose()` on the
  delegate is a deliberate no-op — disposal is `tabs.ts`'s own job (`closeTab`) now, not something a
  caller holding "whichever tab is active" should be able to trigger.
- **`findStore.ts`** — converted to a `createFindStore()` factory; bar open/current-index/filter-
  mode moved to per-tab for the same reason `activeSearchStore` did: this state describes *that
  tab's* search result, and showing tab A's "match 3 of 12" against tab B's (possibly empty) result
  after a switch would be a real, visible bug, not just an architectural nicety.
- **`navigationStore.ts`** — converted to `createNavigationStore(session, isActive)`; back/forward
  history is genuinely per-document, and the one thing beyond plain per-tab isolation it needed —
  gating its own `commands/context` writes — is covered below.

**`commands/context` is a derived projection of the active tab, not a fifth per-tab store** — per
§1's table, and the one place the plan's two-shapes model ("yes"/"no"/"derived") turned out to need
a third mechanism once actually built. `documentSession.ts` and `navigationStore.ts` both write
directly into the shared `commands/context` store from deep inside their own control flow (`setCtx`,
a small wrapper gated on a new `DocumentSessionDeps.isActive`/`createNavigationStore`'s own
`isActive` parameter — default always-true, so `documentSession.test.ts`'s ~60 direct
`createDocumentSession()` calls and `navigationStore.test.ts` are both unaffected). Gating alone
isn't enough: the moment a tab *becomes* active, its own view of context is stale (every write while
backgrounded was suppressed), so both gained a `resyncContext()` method that writes for real,
unconditionally — `tabs.ts`'s `setActiveTab`/`createTab`/`closeTab` call it on the newly active
entry immediately after flipping the pointer.

**Confirmed needing no change at all, by reading rather than assuming**: the four "controllers"
(`treeController`, `gridController`, `rawController`, `rawViewportStore`) already re-register (or,
for `rawViewportStore`, explicitly clear) on the same `[store]`-keyed effect/cleanup that already
fires on any document change — a tab switch is indistinguishable from today's in-place reparse to
that effect. `layoutStore` and `paletteStore` needed nothing either — neither ever referenced
`documentSession`/`activeSession` in the first place. D-064 has the full accounting, including one
correction to §1's own table (`rawViewportStore` doesn't share the other three's register/unregister
shape, though it lands on the identical lifecycle moment).

### Verification

`test/tabs.test.ts` is new — ten tests exercising genuine multi-tab behavior a "nothing broke"
check can't: two tabs with independent documents where only the active one drives
`commands/context`; a background tab's `openPath` not leaking into active context; `activeSession`
resolving to and reacting to a switch; undo/search/find/navigation isolation between tabs; closing
the active tab activating a neighbor and resyncing; closing a background tab leaving the active one
undisturbed; closing the only tab leaving none active. All passed on first run against the real
`createDocumentSession`/`createSearchStore`/`createFindStore`/`createNavigationStore` factories (the
same fake-parse harness `documentSession.test.ts` uses — a real `runParseJob`, no real `Worker`),
not mocks standing in for the architecture being tested.

**Acceptance held**: the full existing suite (1047 tests before R24, 1057 after — the ten new
`tabs.test.ts` tests) passes unmodified, confirmed on two separate full runs (one transient failure
on a first run was a pre-existing real-`setTimeout`-based timing test — `documentSession.test.ts`'s
own "restore-triggered reparse" case, using a fixed 30ms margin over a 5ms injected delay —
reproducing on neither an isolated re-run nor a second full-suite run, i.e. load-sensitive flake,
not a regression; not investigated further since it predates this round and touches no file R24
changed). `npm run typecheck` and `npm run lint` are both clean (no new errors; the app was also
confirmed booting with no console errors in a live dev-server session, `.notifications` and the
rest of `Layout` mounting correctly through the new tab-backed `activeSession`).

**A genuine circular import** exists between `session/tabs.ts` and both `components/Find/findStore.ts`
and `navigation/navigationStore.ts` (each imports the other's factory/accessor). Deliberate, not
accidental: `tabs.ts` needs each module's `createX` factory to build a `TabEntry`, and each module
needs `tabs.ts`'s `getActiveX` to implement its own free-function delegate. Safe here because
neither side calls into the other at module-evaluation time — every use is inside a function body
invoked later — confirmed by the full suite actually running (a cycle used at eval time would fail
immediately, not subtly), not just reasoned about. Flagged because it's the one part of this round
that would reward care in a code review, not because it's suspected broken.

### Left for R25 and later, disclosed rather than silently assumed

- **No tab strip, no way to open a second tab from the UI.** `createTab`/`setActiveTab`/`closeTab`
  are exercised only from `test/tabs.test.ts` and the module-internal lazy-create path. R25 is where
  a command (`nodepad.tabs.new` or similar) and the visible strip (§11.4's anatomy — format icon,
  middle truncation, same-name disambiguation, dirty/close slot) land.
- **The main process's file-watcher is still single-document.** `documentSession.ts`'s
  `getApi()?.document.onExternalChange(...)` is called once per tab (once per `createTab`), but
  `main/documents.ts`'s own `document:watch` replaces whatever it was watching on every call — R19's
  own doc comment already says this ("one watcher at a time"). Two tabs open today would mean
  whichever opened *second* silently steals the first tab's external-change detection. Not a
  regression (there was never more than one document to watch before this round), but a real gap a
  second tab can now theoretically create — main-process work, out of R24's renderer-only scope,
  and worth flagging before R25 makes opening a second tab something a user can actually do.
- **R26's lifecycle prompts, R27's worker pool, R28's memory budget, R29's session restore, R30's
  measurement pass** are all still exactly as `docs/plans/R24-tabs.md` originally described them —
  untouched by this round.

### Review pass, per `CLAUDE.md`'s own working agreement — four real findings, all fixed

Reading the diff as a separate pass, not from memory of writing it, found four defects — one
significant, three real but narrower — none caught by the suite because nothing in it exercised the
paths involved.

**Notifications were never actually wired to the per-tab id R24 built (significant).**
`notifications/documentId.ts` still exported the fixed `ACTIVE_DOCUMENT_ID` constant from R21, and
every call site (`Tree.tsx`, `Raw.tsx`, `Grid.tsx`, `derivedNotifications.ts`, `Notifications.tsx`'s
own filter) tagged and matched against that same hardcoded string — meaning `documentId`-based
scoping was inert: every document-scoped notification always matched, regardless of which tab was
actually active, because both sides of the comparison were the same constant. Not observable yet
(no tab strip means only one tab's panes are ever mounted, so nothing could push a notification on
a background tab's behalf to demonstrate the leak) — but the mechanism was inert, not merely
untested, and it contradicted `docs/plans/R21-notifications.md`'s own §3d comment about R24 making it
real. Fixed: `activeDocumentId()` now reads `session/tabs.ts`'s `getActiveTabId()` at push time,
`derivedNotifications` takes the id as a parameter instead of a hidden import, and
`Notifications.tsx` subscribes to the live active tab (`useSyncExternalStore(subscribeTabs,
getActiveTabId, ...)`) for its filter. Two new tests in `test/notifications.test.tsx` push a
notification tagged for one tab and assert it's invisible while a different tab is active — they
fail against the pre-fix code (confirmed: a hardcoded constant can't distinguish two tabs), which a
"just re-run the suite" check wouldn't have shown, since the suite never created two tabs before
this pass added tests that do.

**`resyncContext()`'s own contract had a gap in the exact scenario it exists for.** It documents
"forces every context key this session owns... to be rewritten," but `nodeKind` was never among
them — a pre-existing gap in the single-document world (never wrong there, since a selection change
always sets it fresh) that becomes a real bug once switching tabs is real: tab A selects an
`Element`, tab B has nothing selected, switching to B left `nodeKind` reading `'Element'` from A.
Fixed by clearing it explicitly in the ready branch's `else`.

**The non-ready branch of the same function was gated when it needs not to be.** It delegated to
`resetContextForNoDocument()`, which goes through `setCtx` — gated on `isActive()`. Harmless when
called through the one path that ever calls it in practice (`tabs.ts` always flips `activeTabId`
*before* calling `resyncContext`), but it directly contradicts the function's own "writes for real,
unconditionally" doc comment, and a future caller that didn't happen to match that ordering would
get silent no-ops instead of a reset. Fixed by writing the resets directly with the real
`setContext`, matching the ready branch's own style.

**`resetContextForNoDocument()` itself was incomplete for reuse.** Before tabs, it only needed to
reset the keys that could plausibly be stale when leaving `ready` — `canUndo`/`canRedo`/
`hasExternalChange`/`nodeKind` were always already at their defaults by the time it ran (a fresh
open resets the undo stack, `openPath` resets `hasExternalChange` itself). Reused via `resyncContext`
for a tab that was never opened or is still opening, those defaults can no longer be assumed —
switching to an empty background tab from one with undo history left `canUndo` reading stale
`true`. Fixed by resetting all four there too.

**A fifth item, found and fixed but not a defect in the R24 diff itself**: `documentSession.ts`'s
`onExternalChange` registration discarded its own unsubscribe function — harmless before this round
(exactly one session ever existed, for the app's whole lifetime), but `tabs.ts`'s `closeTab` can now
discard a `DocumentSession` while that subscription stays registered with the preload layer, keeping
the closed session's entire closure alive and able to fire a stale `handleExternalChange` against a
document nothing displays. Fixed: `DocumentSession` gained a `dispose()` method (captures and calls
the unsubscribe), `tabs.ts`'s `closeTab`/`resetTabsForTests` call it alongside the existing
`searchStore.dispose()`.

All four (five, counting the pre-existing line touched by the last one) fixed in the same commit as
the R24 work they belong to, per the working agreement's "committing first is deliberate" — these
were caught reading the diff as a whole, which the milestone's own size made worth doing before
committing at all rather than after. Full suite (1057 tests, 2 new) passes; `npm run typecheck` and
`npm run lint` are clean.

---

## Results — R25 (built)

The tab strip, per §3's own framing: anatomy and pointer-driven switch/close/new. Dirty-close
prompts, keyboard switching, "open into a new tab" for the existing `nodepad.document.open`
command, and the consolidated quit-time list are still R26 — deliberately not attempted here,
matching R24's own "one round at a time" precedent.

### What was built

`src/renderer/components/TabStrip/` is new:

- **`TabStrip.tsx`** — subscribes to `session/tabs.ts`'s `subscribeTabs`/`getTabIds`/
  `getActiveTabId`, rendering one `[role="tab"]` per open tab plus a trailing "+" (`openNewTab`,
  `commands.ts`). Clicking a tab calls `setActiveTab`; each tab's own close slot calls `closeTab`
  directly (bare — no dirty prompt yet, R26's job).
- **`tabDisplay.ts`** — pure logic, no React (the same `*Model.ts`/`*Logic.ts` split
  `wrapperDescent.ts`/`gridDetection.ts` use): `tabDisplayInfoOf` derives what a tab shows from a
  `DocumentSessionState` regardless of phase, `formatGlyphOf` is the UI-side `capabilities.id` map
  §11.4 asks for (invariant 8 — never supplied by the format module), and `tabLabelsOf` implements
  same-name disambiguation (the smallest distinguishing path segment, one directory level up).
  Directly tested (`test/tabDisplay.test.ts`), no DOM needed.
- **`commands.ts`** — `nodepad.tabs.new`, palette-only (invariant 10: the strip's own "+" is a
  plain UI affordance like Detail's breadcrumb buttons, but the *action* still needs a
  palette-reachable entry point). Exports `openNewTab` so the command and the "+" button share one
  implementation rather than two copies that could drift.
- Mounted in `App.tsx` between `TitleBar` and `Layout` — the row R4 already reserved
  (`M5d-PLAN.md` §4's "leave room for the strip"); `#root main`'s existing flex column absorbs it
  for free, no layout math needed.

**Format icons reuse existing syntax-hue tokens** (`--syntax-tag-name` for XML, `--syntax-attr-name`
for JSON, `--syntax-number` for TOML) rather than inventing a parallel set of tab-icon tokens —
already desaturated/theme-aware, and §11.4's own reasoning ("muted... a rainbow of saturated icons
would compete with the active tab's amber") is satisfied by reuse, not by a new palette.

**The active tab's marker is `--mark-fg`** (the brand mark's own amber, D-054a), not `--accent` —
§11.4 says "the brand amber marks the active tab" specifically, and using the blue accent instead
would read as an ordinary selection highlight rather than brand identity.

### A real defect, found and fixed while building this

**`getTabIds()` returned a fresh array on every call** — harmless for R24 (nothing consumed it
through `useSyncExternalStore`; `test/tabs.test.ts` only ever called it directly) but a genuine bug
the moment `TabStrip.tsx` became the first real consumer: React's contract for a snapshot getter is
that it returns a referentially stable value when nothing has changed, and `tabs.map(...)` violates
that on every call regardless. The result was an immediate "Maximum update depth exceeded" — caught
by `test/tabStrip.test.tsx` (real Chromium, real render), not reasoned about in advance. Fixed in
`session/tabs.ts`: a cached `tabIds` array, recomputed only where `tabs` itself is reassigned
(`createTab`/`closeTab`/`resetTabsForTests`) — the same "stable until it actually changes" contract
every other per-tab lookup in that module already gives its own consumers.

**A second, narrower staleness gap** surfaced during review, not by a failing test: same-name
disambiguation was computed once per `TabStrip` render from each tab's own `getSnapshot()`, which
only re-runs when the tab *set* changes (`subscribeTabs`) — a background tab's document changing
(e.g. Save As onto a name that now collides with another open tab) wouldn't have re-triggered it.
Fixed with `useTabDisplayInfos`, a small hook that subscribes to every open tab's own session
(resubscribed only when the tab set changes) and forces a re-render on any of their changes, so the
label the strip shows can't drift from what each tab's session actually holds.

### Verification

`test/tabDisplay.test.ts` (10 tests, pure logic) and `test/tabStrip.test.tsx` (4 tests, real
Chromium via the browser project: two tabs render with the active one marked, clicking a background
tab switches it, closing one tab leaves the other, same-name disambiguation renders correctly).
Full suite green (92 files, 1116 tests — up from 1106 before this round); `npm run typecheck`,
`npm run lint`, and `npx stylelint` all clean.

**A real screenshot**, not just component tests — `npm run build` then
`node scripts/electron-screenshot.mjs` (Playwright driving the actual packaged app,
`docs/screenshots/title-bar.png`, deliberately committed) — confirms the strip actually renders
correctly in the real app: below the title bar, the amber active-tab underline, the "+" affordance,
no layout shift.

### Left for R26 and later

- **Dirty-close prompts, keyboard switching, "open into a new tab" for the existing
  `nodepad.document.open` command, the consolidated quit-time list, "no autosave" statement** — all
  exactly as this document's own §4 (R26) describes, untouched by this round.
- **The main-process single-document file watcher gap** (flagged when R24 landed, repeated in
  `docs/FINDINGS.md`) is now trivially reachable — the "+" button makes a second tab something a
  user can actually create. Still main-process work, still out of this round's renderer-only scope.
- **R27's worker pool, R28's memory budget, R29's session restore, R30's measurement pass** —
  untouched.

---

## Results — R26 (built, including the consolidated quit flow — see the addendum after R30's own results)

### What was built

- **Dirty-close prompts (§4/§11.4).** `session/tabs.ts` gained `requestCloseTab` — a clean tab (or
  one mid-open) closes immediately via the existing `closeTab`; a dirty one is activated (so the
  prompt appears where it was requested, not on a tab the user isn't looking at) and left open,
  recorded in a new `pendingCloseTabId`. `cancelCloseTab`/`discardAndCloseTab`/`saveAndCloseTab`
  resolve it — the last saves first and only closes on success, leaving a failed save's tab and
  prompt exactly where they were. Rendered per R21-notifications.md §3a's rule (**derived**, not
  pushed): a new `hasPendingCloseTab` context key (`commands/context.ts`, kept in sync from
  `tabs.ts`'s own `emit()`) gates a `derived:pendingCloseTab` notification
  (`derivedNotifications.ts`) with Save/Discard/Cancel actions, each a real command
  (`components/TabStrip/commands.ts`, invariant 10) reading `getPendingCloseTabId()` directly
  rather than "whatever's active" — the two only disagree if the user switches tabs while the
  prompt is up, in which case `hasPendingCloseTab` (and so the notification) simply isn't showing
  for the newly-active tab, exactly as a non-blocking prompt should behave.
- **"Open into a new tab" (§4).** `nodepad.document.open` (Ctrl+O, the title bar, the palette) and
  `Layout.tsx`'s drag-drop handler both used to replace the active tab's own document — R24's own
  test comment said so explicitly ("no tabs in M1"). Both now call `session/tabs.ts`'s new
  `openNewTab`/`openPathInNewTab`, which always create a fresh tab — including for the very first
  document opened into an otherwise-empty app; CONCEPT.md §11.4 names no "reuse an empty tab"
  exception, and inventing one wasn't attempted. R25's own `nodepad.tabs.new` command, which did
  exactly this under a different name before this change, is removed — one command
  (`nodepad.document.open`) now covers what used to be two.
- **Keyboard switching (§4/"switch with keyboard and pointer").** `activateNextTab`/
  `activatePreviousTab` (`tabs.ts`) wrap around and are no-ops with fewer than two tabs; bound to
  the platform-conventional `Ctrl+Tab`/`Ctrl+Shift+Tab`. `Ctrl+W` closes the active tab through
  `requestCloseTab`, so it prompts exactly like clicking the tab's own close slot.
- **"No autosave, ever."** Already true — nothing in the codebase writes on a timer or on blur;
  Save/Save As are both explicit user actions. Nothing to build; recorded as checked, not skipped.

### A real ordering bug, found in review rather than by a failing test

`derivedNotifications.ts` originally pushed the pending-close notification **first**, reasoning (in
its own comment) that the user's explicit close click made it "the most prominent item." That
reasoning was backwards: `Notifications.tsx`'s own `merged.slice(-MAX_VISIBLE)` keeps the **last**
three entries, so an item pushed first is the *first* one dropped once three other notifications are
showing — the opposite of prominent. Moved to the end, matching the module's own established rule
("derived ones are appended last... so a live choice tends to survive the three-visible cap") that
the original placement quietly violated. No test caught this — a single-notification scenario can't
distinguish the two orderings — so it's disclosed here rather than assumed exercised.

### Verification

New tests: `test/tabs.test.ts` gained 12 (`requestCloseTab`/`cancelCloseTab`/`discardAndCloseTab`/
`saveAndCloseTab` including the save-failure path, `activateNextTab`/`activatePreviousTab`'s wrap
and no-op cases). `test/tabCloseNotification.test.tsx` is new — real Chromium, `TabStrip` and
`Notifications` mounted together: a clean-tab close shows nothing, a dirty-tab close shows the
notification and Cancel leaves it open, Discard closes without writing, Save writes then closes.
`test/commands.test.ts` updated for the new `hasPendingCloseTab` context key. Full suite green (93
files, 1128 tests); `npm run typecheck`, `npm run lint`, and `npx stylelint` all clean. Re-confirmed
visually with a fresh `docs/screenshots/title-bar.png` via the real-Electron screenshot script.

### Left undone, disclosed rather than silently dropped

**The consolidated quit-time list (§4's "one consolidated list with per-file choices, not a
sequence of modals") was not attempted.** The plan's own text flags this as "the piece most likely
to be built as a modal sequence by accident" and "the one case that genuinely warrants a modal" —
it is real, separable work: main-process `before-quit`/window-close interception (nothing currently
intercepts either — `window-all-closed` just quits, a pre-existing gap this round did not make
worse), a new preload/IPC contract to ask the renderer whether anything is dirty and to block the
quit pending an answer, and a genuinely modal renderer component distinct from the non-blocking
notification stack the rest of this round deliberately stayed inside. Building it shallow and
unverified (no display to drive a real quit-and-confirm interaction, and the Playwright-screenshot
tool this round used for the rest of its verification can't drive a multi-step modal flow the same
way) was judged worse than reporting it — per `CLAUDE.md`'s own "report rather than work around."
Left as its own follow-up rather than folded into R27.

**R27's worker pool, R28's memory budget, R29's session restore, R30's measurement pass** —
untouched, exactly as before.

---

## Results — R27 (built)

### What was built

`src/core/workerPool.ts` is new: `POOL_SIZE = 3` long-lived workers, created lazily on the first
`acquireWorker()` call (not at module load — constructing a `Worker` is not something an import
should have as a side effect, and it keeps `parseInWorker`'s already-aborted check ahead of ever
touching the pool, which `test/parseClient.test.ts` depends on). `acquireWorker()` resolves
immediately from the free list or queues; `releaseWorker()` clears the worker's `onmessage`/
`onerror` and either hands it straight to the next queued waiter or returns it to the free list;
`replaceWorker()` — cancellation or a worker-thread crash — terminates the untrustworthy worker and
swaps a freshly spawned one into its pool slot, so the pool stays at `POOL_SIZE` rather than
shrinking.

`parseInWorker`, `parseFromUrlInWorker` (`core/parseClient.ts`) and `transformInWorker`
(`core/transformClient.ts`) all moved from "spawn a `Worker`, terminate it on completion or cancel"
to "acquire from the pool, `releaseWorker` on a clean finish, `replaceWorker` on cancel/crash." Each
function's own `claimed`/`settled` dedup logic (D0.2) is otherwise unchanged — this is a resource
lifecycle change, not a protocol change. One addition all three needed: the wait for a free worker
is itself async, so a signal that aborts *while queued* needs the same already-aborted check redone
right after `acquireWorker()` resolves, or a queued-then-cancelled request would run anyway the
moment a worker frees up.

### Verification

**This is also the first real coverage of the worker-client path itself** — before this round,
`parseInWorker`/`transformInWorker` had exactly one test (`test/parseClient.test.ts`'s
already-aborted-signal check, which explicitly never constructs a `Worker`, since Vitest's node
project has no such global), and every other test drove `runParseJob`/`fakeParse` directly instead.
`test/workerPool.test.tsx` is new — real Chromium via the browser project, real `Worker`s: a single
parse resolves and releases its worker; seven concurrent parses against a 3-worker pool all resolve
correctly and the pool ends up fully free (proving the queue actually runs queued jobs rather than
dropping them); aborting mid-parse rejects with `AbortError` and the pool self-heals (a later,
unrelated parse still succeeds); a transform runs through the same pool. `npm run build` also
confirms the production bundle still builds cleanly.

Full suite green (94 files, 1132 tests, up from 93/1128); `npm run typecheck` and `npm run lint`
clean. **Not verified**: an actual six-tab, many-concurrent-parse session in the packaged app — no
display to drive that interaction, the same gap this project's own `docs/FINDINGS.md` already
names. R30's measurement pass is the place that's supposed to close it, not this round.

### Deliberately not built

- **A `cancel` message that actually interrupts an in-flight job.** Both worker-client functions
  keep posting one (wired for §6.6's eventual persistent-worker design, per the pre-existing
  comment this round carried over), but `replaceWorker`'s terminate-and-respawn remains what
  actually stops work promptly — unchanged from before pooling, since a synchronous parse/format
  inside a single-threaded worker was never interruptible mid-call to begin with.
- **Priority or fairness in the queue.** `acquireWorker`'s waiters are a plain FIFO array; §11.4
  says nothing about ordering, and no caller in this codebase needs one job to jump the line.
- **Exposing `getWorkerPoolStats()` anywhere yet.** Added for R30's measurement pass to read, not
  read by anything today.

---

## Results — R28 (built)

### What was built

- **The configurable budget itself.** `settings.ts` gained `getTotalMemoryBudgetBytes()`/
  `setTotalMemoryBudgetBytes()` (same persisted-`localStorage` shape as `getFormatMinifiedOnOpen`),
  defaulting to 4 GiB — headroom past §8's own worked example ("three 200 MB files is ~1.5 GB").
- **The cross-tab check.** `session/tabs.ts` gained `getCrossTabMemoryBytes(excludeId?)`, summing
  `computeMemoryBudget(...).totalBytes` (already O(1) per document, per D-060/§3a) across every
  *ready* tab — a tab still opening contributes nothing, since its own estimate is exactly what the
  caller is folding in separately. `documentSession.ts` gained two new `DocumentSessionDeps`
  (`estimateOtherTabsBytes`, `totalMemoryBudgetBytes`, both defaulted so every existing test and
  direct call site is unaffected) and a second confirm check in `openPath`, run after the existing
  per-file `SOFT_CAP_BYTES` check: a file under its own soft cap can still push the *total* across
  every open tab past budget, and now confirms rather than silently degrading — same shape §11.2
  and `TRANSFORM_CONFIRM_BYTES` already use. `createTab` (`tabs.ts`) injects the real
  `estimateOtherTabsBytes`, excluding the tab asking (it doesn't exist yet at the moment its own
  `DocumentSession` is constructed, but the closure reads live `tabs` state at call time, which is
  what matters).
- **`confirmSize`'s state gained `reason: 'size' | 'budget'`** and `totalEstimatedBytes` (`null` for
  `'size'`) — one phase, one confirm/cancel UI shape, a different message depending on which
  threshold triggered it. `DocumentArea.tsx` renders the two messages; `confirmOpenAnyway`/`cancel`
  are unchanged, since both reasons resolve through the same `pendingOpen`.
- **The statistics panel's cross-tab figure** — the promise D-060 recorded. `StatisticsPanel.tsx`
  reads `getTabIds()`/`getCrossTabMemoryBytes()` directly (via `useSyncExternalStore(subscribeTabs,
  ...)`, re-subscribed on tab set/active changes only — a deliberately coarser subscription than
  the always-visible tab strip's own per-session one, since this is a transient popover opened on
  demand, not something that needs to track a background tab's every keystroke). A new "All tabs
  (N)" row appears only once a second tab exists; with one tab it would just repeat "Total".

### Verification

New tests: `test/settings.test.ts` (default, persistence, corrupted/non-positive fallback),
`test/tabs.test.ts` (`getCrossTabMemoryBytes` summing/exclusion/skipping not-yet-ready tabs, and an
end-to-end proof that `createTab`'s injected dependency is wired to real sibling tabs — a second
tab's own tiny budget can only be exceeded by seeing the first tab's real footprint),
`test/documentSession.test.ts` (the budget-confirm path, other-tabs bytes counting toward it,
`confirmOpenAnyway` proceeding past a budget confirm the same way it does a size confirm), and
`test/statisticsPanelCrossTab.test.tsx` (real Chromium: absent with one tab, present with the right
count and a total that's actually larger than any single document's own). Full suite green (95
files, 1143 tests, up from 94/1132); `npm run typecheck`, `npm run lint`, `npx stylelint` all clean;
`npm run build` confirms the production bundle still builds.

### Deliberately not built

- **A settings UI for the numeric budget.** `setTotalMemoryBudgetBytes` exists and is tested, but
  nothing in the app calls it yet — this codebase has no numeric-setting UI pattern anywhere
  (`getFormatMinifiedOnOpen`'s own UI is a palette toggle command, not a form), and inventing one
  for a single number wasn't judged worth it here. The setting is real and reachable
  programmatically; it just has no in-app editor.
- **Evicting background documents' node stores** while retaining byte buffers — explicitly
  post-v1 per §6's own text, unchanged.

---

## Results — R29 (built; per-tab view state disclosed as not restored)

### What was built

`src/renderer/session/sessionRestore.ts` is new:

- **`persistSessionState()`** captures every *ready* tab's own `filePath`, in strip order, plus
  which one is active, to `localStorage` (same persisted-JSON shape `titlebar-theme.json`'s
  renderer-side counterparts already use) — **paths only, never document content**, per §7's own
  instruction. A tab still opening (empty/parsing/confirmSize/error) has no confirmed path yet and
  is simply omitted.
- **`beginSessionRestore()`** reads that back and recreates the tab set: `createTab()` for every
  persisted path (synchronous), then `openPath()` on each (async), then activates whichever one was
  persisted as active. **Must run before React's first render, not from a `useEffect`** — every
  pane/store reads `getActiveSession()`, which lazily mints an empty tab the instant nothing is
  active yet (`tabs.ts`'s own `getActiveEntry`); an effect fires after the first commit, by which
  point that lazy tab already exists and restore would land its own tabs alongside a stray blank
  one. Wired into `main.tsx`, called before `createRoot(...).render(...)` — `createTab()` itself is
  synchronous, so every restored tab exists by the time anything else runs, even though the actual
  file reads that follow are not.
- **Degrades per tab, per §7.** Each restored path opens independently — `openPath` never throws
  (every failure, including a gone or now-too-large file, degrades to the `'error'` phase, which is
  exactly the R28 budget-confirm/soft-cap machinery already built doing its job unchanged). One
  missing file never turns into "no session": the other tabs open normally regardless. If any failed,
  **one** summary notification is pushed (`"N of your M previously open files could not be
  reopened"`), application-scoped (`documentId: null`, R21-notifications.md §3b's own field for
  exactly this) — not one notification per failed tab.
- **Persistence keeps running after restore** — `startSessionPersistence()` subscribes to the tab
  set (`subscribeTabs`) *and* to every individual tab's own session (a plain `subscribeTabs` alone
  would miss the moment a tab actually reaches `ready`, which is the one moment its path becomes
  persistable), resubscribing whenever the tab set changes. A fresh app with nothing to restore
  still starts this, so it begins recording a session to restore *next* launch from its very first
  tab.

### A real bug, found in review rather than by a failing test

The first version of `startSessionPersistence()` called `subscribeTabs(...)` without keeping the
returned unsubscribe function. `subscribeTabs` never expires on its own, and `tabs.ts`'s own
`resetTabsForTests()` does not clear its module-level `listeners` set — so every test in
`sessionRestore.test.ts` would have left one more stray listener registered, permanently, for the
rest of the process. Not something a single test run's assertions would ever surface (each stray
listener still does the right thing when it fires; the bug was accumulation, not incorrectness),
which is exactly why this is disclosed as a review finding rather than something a red test caught.
Fixed: the unsubscribe is now captured (`unsubscribeTabsForPersistence`) and torn down by
`resetSessionRestoreForTests()`, mirroring `persistenceUnsubscribes`' own handling of the per-session
subscriptions right next to it.

### Verification

`test/sessionRestore.test.ts` is new (6 tests): `persistSessionState` captures ready tabs in order
with the right active index and omits ones still opening; `beginSessionRestore` is a no-op with
nothing persisted, reopens every path and activates the right one, degrades per tab with exactly one
summary notification when a file is gone, and is a genuine one-shot (a second call does nothing).
Full suite green (96 files, 1149 tests, up from 95/1143); `npm run typecheck`, `npm run lint` clean.
**A real screenshot** (`npm run build` + `node scripts/electron-screenshot.mjs`) confirms the app
still boots cleanly with no persisted session present (a fresh Electron profile) — the ordinary
"no document open" screen, not a crash from `beginSessionRestore()` running before render.

### Disclosed, not silently dropped

- **Per-tab view state (scroll position, layout) is not restored.** §7 says "store paths and
  per-tab view state"; only paths (plus which tab was active) are persisted here. Raw's scroll
  position, the Tree's expansion state, and layout toggles are not currently held anywhere durable
  per tab to restore *from* — building that storage was judged separate, real work (each pane's own
  view state lives in a different controller, several of which — `rawViewportStore`,
  `treeController` — are explicitly transient/re-derived per R24's own review), not a one-line
  addition to this round.
- **A changed-but-still-present file is not specially detected on restore.** It opens through the
  ordinary `openPath` path and reads whatever is on disk *now* — correct behaviour (§7 never asks
  for a diff against the old content, which was never stored), but worth stating since "changed
  since last launch" is one of §7's own named cases.

---

## Results — R30 (built)

Per §8's own framing, this round's deliverable is numbers, not production code — nothing in
`src/` changed. Two new tests produce them: `test/tabSwitchMeasurement.test.tsx` (real Chromium,
real `Worker`s) and a new `describe` block in `test/tabs.test.ts`.

### The numbers

- **Tab-switch remount cost** (§8's "most likely to be bad" figure): switching the active tab
  between two real ~2 MB/30k-node documents — mounting `TreeContent`/`DetailContent`/`RawContent`/
  `ScrubberContent`/`ReadyStatus` with a new `document` prop, the same swap `activeSession`'s own
  subscription composes a tab switch into — measured **~60–75ms wall time**, of which React's own
  profiled render time is **~29–32ms** (almost entirely `DetailContent`, ~28–30ms; every other
  pane is sub-millisecond). The gap between wall time and profiled render time is Raw's
  `EditorView` teardown/rebuild (`M5g-RESULTS.md`'s deferred O4 half, confirmed here to still be
  the dominant *non-React* cost) — not itself instrumented by `React.Profiler`, since it runs in a
  `useEffect`, not a render. **Not obviously bad** — under the ~100ms threshold usually cited for
  "feels instant" — but real, and `DetailContent`'s own ~28ms (virtualized-list layout for 30,000
  rows) is the next thing worth profiling in isolation if a future round needs to shave this down.
- **Worker pool queueing**: six concurrent 5,000-item parses against the 3-worker pool completed
  in two visible bands in every isolated run — e.g. ~104–125ms for the first three (a free worker
  immediately) vs. ~121–129ms for the last three (one wait cycle) — confirming the queue actually
  queues rather than either serializing everything or ignoring the pool limit. **Not asserted as a
  hard ordering** in the committed test (see the finding below) — the numbers above are what an
  isolated run actually produced, recorded here as the deliverable itself.
- **Context-key resolution per switch**: `setActiveTab` across 20 open tabs, 200 switches —
  **~0.0024ms/switch** (200 switches in 0.47ms total). Effectively free, as expected: it's a
  handful of `setContext` calls plus two `resyncContext()`s (session, navigation), none of them
  touching the document itself.
- **Peak memory with three vs. six documents open**: **not produced as OS-level process RSS**,
  disclosed below rather than reported as something it isn't. `performance.memory
  .usedJSHeapSize` (the only heap figure reachable from the browser project, Chromium-only and
  non-standard) showed **no measurable delta** holding three or six ~2 MB documents — not because
  memory didn't grow, but because Chromium quantizes this API's precision for fingerprinting
  resistance and it isn't a reliable read at this granularity. §8's real question (process RSS
  against §8's own ~2.5× per-document budget) needs main-process instrumentation
  (`app.getAppMetrics()`) this round did not build — see below.

### A real defect, found by the measurement infrastructure itself, not by what it was measuring

The very first attempt at the tab-switch measurement **hung for over three minutes and then
crashed Chromium with an out-of-memory error** — not a real finding about tab-switch cost, but
R19's own defect (`docs/plans/R19-document-props.md`): React's DEV build walks the entire `NodeStore`'s
typed arrays for its performance-track logging on every render, and `devPerformanceTracks.ts`
disables it — but only because `main.tsx` imports it *first*, before `react-dom` ever evaluates.
This test file doesn't go through `main.tsx` at all, so nothing disabled the walk, and a
~30,000-node `NodeStore` (the size this round's documents needed to be a meaningful remount cost)
is exactly large enough to turn that walk catastrophic. `documentPropsRenderCost.test.tsx` never
hit this because its own fixture is ~45 bytes. Fixed by importing `devPerformanceTracks` first in
the new test file too, dropping the wall time from >180,000ms to ~60ms — confirming R19's own
warning ("re-check it by hand after any React upgrade — the failure is silent and catastrophic")
generalizes to *any* test that profiles a realistically large document, not just the packaged app.
Worth a `docs/FINDINGS.md` line for the next person who writes one.

A second, unrelated fixture mistake compounded the first attempt: the synthetic document was
minified (a single ~2 MB line), a known CodeMirror pathology independent of R19 — fixed by
pretty-printing it, matching how every real fixture in this repo is actually shaped.

A third issue, found under full-suite load rather than in isolation: the worker-pool queueing
test's original hard assertion (queued jobs finish no faster than immediate ones, on average)
inverted once when run alongside the rest of the suite — six real OS threads contending with
everything else running concurrently is enough scheduling noise to occasionally invert which batch
finishes first, the same "load-sensitive timing, not a regression" class R24's own results section
already named for a different test. Loosened to assert the structural invariant that survives
noise (the pool stays at its configured size and every worker is released) — the comparative
timing became something the test *reports*, not something it *enforces*.

### Left for a later round, disclosed rather than guessed at

- **Real OS-level process RSS** (`app.getAppMetrics()`) with three/six tabs open in the packaged
  app. This round's browser-project numbers are real but are JS-heap/render-time proxies, not the
  literal figure §8 asks for — main-process instrumentation is separate work.
- **`DetailContent`'s ~28ms virtualized-list cost**, named above as the next thing worth profiling
  in isolation if tab-switch latency ever needs to come down further — not attempted here, since
  this round's job was to produce the top-line number, not chase it.
- **A `docs/FINDINGS.md` entry for the "any large-document test needs `devPerformanceTracks`
  first" trap** — the kind of thing that bites the next person working on something unrelated,
  which is exactly `FINDINGS.md`'s own bar (`CLAUDE.md`'s working agreement).

---

## Addendum — R26's consolidated quit flow (built)

Landed after R30, once the project lead settled the one open design question: not a single
list-view modal, but **Notepad++'s shape** — one dirty tab asked about at a time, through the
existing per-tab Save/Discard/Cancel prompt, plus a bulk "No to All"-equivalent action. This
changes only the UI shape from the plan's original "one consolidated list"; the main-process
interception and the IPC round trip §4 always needed are identical either way, so nothing here
invalidates the "Left undone" section above's own reasoning about what real, separable work this
was — it's just now been done.

### What was built

- **Main-process interception** (`src/main/index.ts`). The window's own `close` event is now held
  open (`event.preventDefault()`) unless a `WeakSet<BrowserWindow>` says this window's quit was
  already confirmed — a `WeakSet`, not a boolean, so a second window (`app.on('activate')` on
  macOS) never inherits the first window's answer. Two new `ipcMain.on` handlers:
  `app:confirmQuit` (marks the window confirmed and actually calls `win.close()`, which then
  passes the guard and proceeds exactly as before this round existed) and `app:cancelQuit` (a
  documented no-op — `preventDefault()` already did the only thing needed).
- **The IPC seam** (`preload/api.ts`'s new `app` namespace, wired in `preload/index.ts`):
  `onQuitRequested`/`confirmQuit`/`cancelQuit`. Main decides *when* a quit is being attempted;
  the renderer decides *whether* it's actually safe yet.
- **The flow itself** (`session/tabs.ts`): `startQuitFlow` collects every currently dirty tab (in
  strip order) and prompts the first one through the *same* `derived:pendingCloseTab` notification
  a single ad-hoc close already used — no new UI component. `advanceQuitQueue` (called after every
  close that happens while a flow is active) moves to the next queued tab, or reports completion.
  `discardAllAndQuit` is the bulk "No to All"; `cancelQuitFlow` backs out of the whole thing,
  leaving every tab — including the one mid-prompt — exactly as it was. `session/quitFlow.ts` is a
  small orchestrator (mirroring `sessionRestore.ts`'s own split) that wires `tabs.ts`'s flow to the
  IPC seam without giving `tabs.ts` itself an IPC/preload dependency; mounted from `App.tsx`'s own
  mount effect (no "before first render" constraint here, unlike session restore).
- **`derivedNotifications.ts`/`commands/context.ts`** gained a `hasPendingQuit` key (`
  hasPendingCloseTab && isQuitInProgress()`) that swaps the notification's three actions for four
  (`Save`/`Discard`/`Discard All`/`Cancel`) and its message text, and two new commands
  (`nodepad.tabs.discardAllAndQuit`, `nodepad.tabs.cancelQuit`) gated on it, invariant 10.

### Two real bugs, both found in review before committing

**A manual close on a *different* dirty tab, mid-flow, would silently orphan the tab the flow was
actually waiting on.** `requestCloseTab` unconditionally overwrote `pendingCloseTabId` — clicking
some other tab's own close slot while a quit-flow prompt was up would point it at the new tab
instead, and the original tab (no longer `pendingCloseTabId`, never added to `quitQueue`) would
never be asked about again. The flow would finish, `onAllResolved` would fire, and the app would
quit with that tab's edits genuinely lost — the exact failure R26's whole dirty-close mechanism
exists to prevent. Fixed by splitting `requestCloseTab` (guarded: refuses to steal the prompt from
an in-progress flow asking about a different tab) from a new internal `promptOrSkip` (unguarded —
it *is* the flow driving itself, and additionally closes-and-advances if a queued tab turned clean
in the meantime rather than stalling on it). Caught by a new regression test
(`test/tabs.test.ts`), not by manual use.

**The fix above's first draft broke the flow's own first prompt.** `startQuitFlow` sets `quitQueue`
*before* asking about the first tab, so the guard (`quitQueue !== null && pendingCloseTabId !== id`)
was true on the very first call — `quitQueue` was already a (possibly empty) array by then, and
`pendingCloseTabId` was still `null`. Caught immediately by the existing quit-flow test suite going
red across the board, not a subtle miss — the `promptOrSkip` split above is what actually resolved
it, by giving the flow's own internal transitions a path that never touches the guard at all.

### Verification

New tests: `test/quitFlow.test.ts` (4, the IPC wiring — confirms immediately with nothing dirty,
withholds confirmation while a dirty tab is pending, is a one-shot, degrades safely with no preload
bridge), `test/quitFlowNotification.test.tsx` (4, real Chromium — the four-action notification
shape, asking tabs one at a time, Discard All, Cancel), and two additions to
`test/tabs.test.ts`'s own quit-flow suite (now 6 tests) for the orphaning bug specifically. Full
suite green (99 files, 1167 tests, up from 96/1149 after R30). `npm run typecheck`, `npm run lint`,
`npx stylelint` all clean.

**A real end-to-end check against the packaged app**, not just component tests: a scratch
Playwright script (not committed) launched the real built app, called `window.close()` in the
renderer, and confirmed the app actually closes after the quit flow resolves with nothing dirty —
proving the full `close` → `preventDefault` → IPC → `startQuitFlow` → `confirmQuit` → real close
round trip, not just its pieces in isolation. The blocking case (a real dirty tab holding the
window open) is covered by the component tests above rather than the same live script — driving a
real native open-file dialog through Playwright to get a genuinely dirty document in the packaged
app wasn't attempted, the same scope boundary the original "Left undone" section drew around
main-process/dialog automation.
