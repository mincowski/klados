# R21–R23 — notifications

<!-- status: built -->

**Built.** Register: `docs/TASKS.md`. Decision: `docs/DECISIONS.md` D-062.

Replaces the alert strip that currently sits under the title bar and reflows the panes when it
appears. **The strip is deleted, not shrunk** — that is the point of the round, and it is what
makes the pane layout finally stable.

Sequenced first of the three topics planned together (notifications → tabs → CSV) because it is
self-contained, it closes a real gap, and designing document scope in now means `docs/plans/R24-tabs.md`
inherits it rather than retrofitting it.

---

## 1. Why this is more than a layout fix

**CONCEPT.md §11.3's external-change prompt was never built, because there was nowhere to put
it.** `documentSession.ts` sets `externalChangeDetected` and exposes `hasExternalChange` as a
context key; `keepMine` exists and has **no caller anywhere outside that file**; no component
reads either. So when a file changes on disk *while there are unsaved edits* — the one case §11.3
says must never be silent — the user is told nothing and offered nothing. A clean document
auto-reloads silently, which is why this has never been visible.

That is the shape of the problem: the alert strip is a fixed row under the title bar, so anything
that does not fit its shape simply did not get built.

### Everything that currently speaks to the user

| Where | What | Becomes |
|---|---|---|
| Alert strip | partial-parse warning | status bar counters + one transient notification (R22) |
| Alert strip | "Already formatted — no changes made" | transient notification |
| Alert strip | Format/Minify size confirm (`pendingTransform`) | choice notification |
| Alert strip | minified-file offer | choice notification |
| `Raw.tsx` | read-only banner | **stays** — a standing condition, see §2 |
| `Raw.tsx` | edit refusal (already auto-clears at 4 s) | transient notification |
| `Tree.tsx` | three truncation notices | transient notification, deduped |
| `Grid.tsx` | export soft-cap confirm | choice notification |
| `DocumentArea.tsx` | empty / confirmSize / parsing / error | **stays** — pane content, not a message |
| *nowhere* | external change with unsaved edits | choice notification (R23) |

---

## 2. The rule that decides what moves

**Events and choices become notifications. Standing conditions stay where they are.**

A notification is something that *happened*, or a decision that is *pending*. A standing condition
describes what the document *is*, indefinitely — and a surface that auto-dismisses is exactly the
wrong home for it, because dismissal removes the only indication.

So the read-only banner stays in Raw. D-060/4b already worked this through for the status bar and
the reasoning is unchanged: invariant 6 means editing happens only in the Raw view, so the warning
belongs in the one pane where the failure it warns about can originate.

The partial-parse warning is the interesting case, and it is why the strip can go entirely. It is a
standing condition — but one the status bar **already renders**, as R12's `⊗`/`⚠` counters, each
clickable through to `nodepad.navigate.nextDiagnostic`. The strip's banner was a second display of
a fact already on screen. R22 drops it and adds one transient notification at the moment the parse
lands, so the event is announced once and the standing fact stays in the status bar.

---

## 3. R21 — the notification system

### 3a. Two kinds, and this is the main design decision

**Pushed notifications** are fire-and-forget events: `notify({...})` returns, the notification
lives its life, nothing owns it afterwards.

**Derived notifications are a view of pending session state, not a copy of it.** `pendingTransform
!== null`, `externalChangeDetected`, minified-and-not-dismissed — each is already a field that
means "a decision is outstanding." The notification renders *from* that field and disappears when
it clears.

Deriving rather than pushing is what stops the two from drifting: a pushed choice notification can
be dismissed while the state it described stays pending forever (exactly the failure mode
`externalChangeDetected` is in today, minus the UI), and a state that clears by another route —
a command, an undo, a second reparse — leaves a stale prompt on screen. `DocumentStatus.tsx`
already derives, and gets this right; the mechanism should survive the component.

Practically: the notification container renders `derivedNotifications(document)` concatenated with
the pushed queue. Choice notifications are not independently dismissible — resolving them means
resolving the state.

### 3b. Shape

```ts
interface Notification {
  readonly id: NotificationId
  readonly severity: 'info' | 'warning' | 'error'
  readonly message: string
  readonly actions?: readonly NotificationAction[]
  /** Which document this belongs to; `null` is application-scoped. See §3d. */
  readonly documentId: DocumentId | null
  /** A repeat with the same key replaces rather than stacks (§3c). */
  readonly dedupeKey?: string
}
```

**Dismissal rule** — actions ⇒ sticky, errors ⇒ sticky, everything else auto-dismisses after
~5 s. That is VS Code's model and it is the right one: a message you might need to act on must not
vanish while you read it.

**Hovering or focusing pauses the timer.** Without it a notification that appears while you are
reading the previous one is unreadable, which is the most common complaint about toast systems.

### 3c. Stacking and dedupe

Bottom-right, above the status bar, newest nearest the bottom. **At most three visible**; beyond
that, collapse into a "*N more*" affordance rather than growing a column that covers the grid.

`dedupeKey` matters more here than in a general-purpose toast library: Tree's truncation notice
can fire on every Expand All, and three identical messages stacked up is noise, not information.
A repeat replaces the existing notification and restarts its timer.

### 3d. Document scope — build it now, with one document

Every notification carries the document it belongs to, and the container renders only those
matching the active document plus application-scoped ones (`documentId: null`).

There is exactly one document today, so this is a constant. **Build it anyway.** `docs/plans/R24-tabs.md`
makes it load-bearing, and retrofitting scope onto a queue that never had it means auditing every
call site later instead of choosing correctly once. This is the one piece of tab-readiness in this
round; §4 of `M5d-PLAN.md` made the same call for the title bar and it paid off.

### 3e. Placement, elevation, and what it must not cover

`position: fixed`, anchored above the status bar, inset from the right edge. **It must never
participate in layout** — that is the whole complaint being fixed.

Elevated per `CONCEPT.md` §9.4, which already lists transient surfaces as the elevated tier. An
elevation **token pair** (background + shadow), not a shadow alone — invariant 9, because a shadow
does not read on dark surfaces.

**Verify what it overlaps**, with R10's real-Chromium tooling rather than by inspection: the
Scrubber sits on the right edge of the Raw pane and the grid has its own horizontal scrollbar.
Bottom-right is the least valuable real estate on screen, but "least valuable" is not "empty."

### 3f. Accessibility

- **The container is not a live region.** R12 shipped exactly that defect — a `role="status"`
  wrapper around a value that recomputed on every render, so a screen reader announced it
  continuously. Each notification announces itself once on mount instead: `role="status"` for
  info, `role="alert"` for warning and error.
- **Choice notifications must be keyboard-reachable** without a pointer. A command that focuses
  the newest actionable notification, and Escape returning focus where it came from.
- Auto-dismiss must not steal focus, and must not remove a notification while focus is inside it.

### 3g. Commands, and invariant 10

A notification action that resolves pending state **must also be a command**. Today
`confirmTransformAnyway`, `cancelTransform`, `dismissMinifiedBanner` and `keepMine` are session
methods with no palette route — as buttons on a strip that was always visible that was tolerable;
as buttons on a surface that can be scrolled past or collapsed into "*N more*", it is not.
Invariant 10 is enforced by test, so this is a hard requirement, not a nicety.

---

## 4. R22 — migrate the existing messages and delete the strip

Move every row of §1's table that is marked "becomes", then **delete
`src/renderer/components/DocumentStatus/`** and its mount point in `Layout.tsx`.

Acceptance is behavioural, not structural: with a document open and a partial parse, a pending
transform, and a minified document, **the three panes' pixel geometry is identical to a document
with none of those** — asserted directly against real Chromium layout, in the same style
`test/statusBar.test.tsx` asserts the strip never reflows. That assertion is the round's whole
purpose and should fail loudly if a future banner creeps back into flow.

`minifiedDetection.ts` lives under `components/DocumentStatus/` — it is logic, not presentation,
and moves rather than dies.

---

## 5. R23 — the external-change prompt (§11.3)

The gap in §1. Build the choice notification, wire `keepMine` (currently uncalled), and give both
resolutions commands per §3g.

§11.3's requirements, restated because they are easy to get subtly wrong:

- **Never auto-reload over unsaved work**, and **never block on a modal.** A derived, sticky,
  non-blocking notification satisfies both.
- A clean document still reloads silently, restoring selection through §5.1's cascade. That path
  works today and is not touched.
- *Reload and discard* → `reloadAndDiscard`; *Keep mine* → `keepMine`, which clears the flag and
  leaves the buffer alone. The file may then change again — a second change must re-raise the
  prompt, so `keepMine` must not latch permanently.

**Worth testing explicitly**, because it is the case that made this a gap rather than a bug: the
notification must appear when the change lands while the window is *not* focused, and still be
there when the user comes back.

---

## 6. Deliberately not now

- **A notification centre / history** (VS Code's bell). Natural home is the status bar's left
  group beside `ⓘ`, and the store makes it cheap later. Not needed while the total inventory is
  eight messages.
- **Progress notifications.** Parse progress has its own surface in `DocumentArea`, and
  Transform's is a modal-ish confirm; neither should move here without evidence.
- **Do-not-show-again persistence.** `minifiedBannerDismissed` is per-session by design
  (`M5-PLAN.md` H8) and stays that way.
- **Cross-document notifications** (e.g. "3 files failed to reopen") — needs tabs.

---

## 7. CONCEPT.md amendments (D-062)

- **§5.7** — the minified offer is "a non-intrusive banner"; it becomes a choice notification.
- **§11.3** — "a non-blocking banner offering *Reload and discard* / *Keep mine*"; same.
- **§9.4** — the elevation budget lists "the minified-file banner" as an elevated transient
  surface; the notification layer replaces it in that list.

None of these change intent — every one of them asked for non-blocking, non-modal messaging, which
is what this builds. They are recorded because `CLAUDE.md`'s working agreement is that a deviation
from the concept gets written down with its reason, including when the deviation is an improvement.

---

## Results (R21–R23, built)

All three landed together — R23 turned out to be a small addition once R21's derived-notification
shape existed, not a separate effort.

**R21 — the system.** `src/renderer/notifications/`: `notificationStore.ts` (the pushed queue —
`notify`/`dismissNotification`/dedupe/auto-dismiss with hover-and-focus pause, sticky on
`actions`/`error`), `derivedNotifications.ts` (a pure function of `DocumentSessionState`, per §3a),
`documentId.ts` (`DocumentId = string`, `ACTIVE_DOCUMENT_ID` — the one constant §3d asked to build
now rather than retrofit later — **superseded by `docs/plans/R24-tabs.md`**: R24's own review found the
constant was never wired to the real per-tab id it built, which made every document-scoped
notification implicitly application-scoped; `documentId.ts` now exports `activeDocumentId()`
reading `session/tabs.ts`'s real `TabId` instead, see R24's own Results section), `Notifications.tsx`
+ `.css` (the container: `position: fixed`,
bottom-right above the status bar, `--elev-2-*` per invariant 9, at most three visible plus an
"*N more*" line, newest nearest the bottom), and `commands.ts` (§3g's action-resolving commands).
`Notifications` is mounted in `Layout.tsx` as a sibling of `StatusBar`, never inside `.layout-body`
— §4's acceptance criterion (pane geometry identical with/without a message) is asserted directly
in `test/notifications.test.tsx`, not just designed that way.

**One deviation from §3b worth recording**: `hasPendingTransform` is a genuine new context key
(`commands/context.ts`), not something the plan named. `confirmTransformAnyway`/`cancelTransform`
need a `when` gate that's actually false when nothing is pending — `hasExternalChange` already
existed for `keepMine`, but nothing mirrored `pendingTransform`. `dismissMinifiedBanner` did *not*
get an equivalent key: whether the minified banner is showing is a live computation over
`rowIndex`/`sourceBuffer` (`isPathologicallyMinified`), never stored, and adding a context key just
to gate one command's visibility wasn't worth a new field kept in sync at every call site — its
`when` is `canFormat` instead, the same looseness `nodepad.edit.clearUndoHistory` already accepts
elsewhere; the session method itself is a safe no-op with nothing to dismiss.

**R22 — migration.** Every row of §1's table moved. `minifiedDetection.ts` moved to
`session/minifiedDetection.ts` (logic, not presentation, per §4) rather than dying with
`DocumentStatus/`. `Raw.tsx`'s edit-refusal message and its own 4s local timer are gone — a pushed
`severity: 'warning'` notification with `dedupeKey: 'raw.editRefused'` replaces both (`'warning'`,
not `'error'`: the store treats `'error'` as sticky, which would have made a refusal that used to
clear itself in 4s permanent). Tree's three truncation notices are pushed with per-notice dedupe
keys, cleared explicitly on a document switch rather than waiting out their own auto-dismiss (a
fresh document shouldn't show a stale notice for even a few seconds). Grid's export confirm is the
one case that isn't a straight port: `pendingExport` stays local `Grid` state (there's exactly one
mounted instance), but the confirmation itself is a pushed choice notification whose two actions
are new commands (`nodepad.grid.confirmExport`/`cancelExport`) resolved through `gridController.ts`
— the same "component registers a live handle with a module-level singleton" shape
`copyGridAs`/`focusGridQuickFilter` already used, extended rather than duplicated. `DocumentStatus/`
is deleted; `data-testid="document-status"` stays on `DocumentArea.tsx`'s own root (it still owns
every non-`ready` phase) since existing test setup keys off that name, not because a
`DocumentStatus` component exists to share it with anymore.

**The partial-parse and no-op-Format events don't fit either bucket cleanly**, which is why they
aren't in `derivedNotifications.ts` despite reading document fields: `document.complete` and
`document.lastTransformWasNoOp` don't self-clear, so rendering them as *derived* would leave them
on screen for as long as the condition held — indefinite for a genuinely partial document, which
contradicts "transient." `Notifications.tsx`'s own `useTransientDocumentEvents` hook instead diffs
consecutive `DocumentSessionState` snapshots and pushes a notification exactly on the
false→true transition (`!complete`) or the flip (`lastTransformWasNoOp`), each with its own
`dedupeKey` so a burst of edits during a still-broken document doesn't stack duplicates.

**R23 — the external-change prompt.** `derivedNotifications.ts` renders a choice notification
whenever `document.externalChangeDetected` is true; its two actions
(`nodepad.document.reloadExternalChange` / `nodepad.document.keepMine`) are new commands gated on
`hasExternalChange`, which already existed and was already accurate — the gap really was only "no
UI reads it," exactly as diagnosed. `keepMine`'s existing implementation already only clears the
flag rather than latching a permanent dismissal, so a second external change re-raises the prompt
for free; no change needed there. `nodepad.document.reloadExternalChange` is deliberately a
separate command from the pre-existing `nodepad.document.revert` (same underlying
`reloadAndDiscard()`, different `when`) — conflating them would have made Revert File disappear
from the palette depending on *why* the document was dirty, which isn't what F8 or R23 asked for.

**Verified**: `npm run typecheck`, `npm run lint` (no new errors; only pre-existing CRLF warnings
elsewhere in the tree) and the full suite (`npm test`, 1047 tests) all pass, including
`test/commands.test.ts`'s invariant-10 registry test picking up every new command. New tests:
`test/notifications.test.tsx` (real-Chromium — roles, dedupe, the three-visible cap, action
dispatch + dismissal, the position-fixed geometry claim) and `test/notificationStore.test.ts`
(node, fake timers — the actual ~5s auto-dismiss, sticky-on-`actions`/`error`, pause/resume,
dedupe-restarts-the-timer). **Not verified**: the real Electron window — same no-display gap
`M5c-RESULTS.md`'s J9 and every milestone since M5d have flagged rather than smoothed over. Also
not exercised: `derivedNotifications.ts`'s three branches through a real `activeSession.openPath`
end to end (large-file Transform confirm, an actually-minified fixture, a real filesystem change
notification from the main process) — `test/notifications.test.tsx` exercises the pushed half of
the system directly and the derived half structurally (its output shape, not the live session
plumbing feeding it), since no existing test in this suite stands up a real document through the
full session/IPC path and building that harness wasn't attempted here.
