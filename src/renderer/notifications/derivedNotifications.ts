/**
 * R21-notifications.md §3a: "Derived notifications are a view of pending
 * session state, not a copy of it." Each of these renders from a field on
 * `OpenDocument` that already means "a decision is outstanding" and
 * disappears the moment that field clears — no separate dismiss path, no
 * risk of a stale prompt surviving the state it described (the exact
 * failure `externalChangeDetected` was in before R23, minus the UI).
 *
 * Every action here names a registered command (§3g) — see
 * `notifications/commands.ts` for `confirmTransformAnyway`,
 * `cancelTransform`, `dismissMinifiedBanner`, `keepMine`, and the
 * external-change reload command.
 *
 * `documentId` is passed in rather than read via `activeDocumentId()`
 * internally — `state` and the tab it came from are already the same
 * lookup the caller (`Notifications.tsx`) just made for its own filter, so
 * this stays a pure function of its two arguments instead of a second,
 * possibly-inconsistent read of `session/tabs.ts`.
 */
import { formatBytes, type DocumentSessionState } from '../session/documentSession'
import { isPathologicallyMinified } from '../session/minifiedDetection'
import type { DocumentId } from './documentId'
import type { Notification } from './notificationStore'

export function derivedNotifications(
  state: DocumentSessionState,
  documentId: DocumentId | null,
  // R26 (`R24-tabs.md` §4): `true` exactly when `session/tabs.ts`'s
  // `getPendingCloseTabId()` is this tab and this tab is active — see
  // `commands/context.ts`'s `hasPendingCloseTab` for why that's the right
  // condition. A plain boolean, not read from `tabs.ts` directly, for the
  // same reason `documentId` is passed in rather than looked up here: the
  // caller already made this exact check for its own filter.
  pendingClose: boolean = false,
  // R26 §4: `pendingClose && isQuitInProgress()` — the consolidated quit
  // flow reuses this exact notification (Notepad++'s "ask per file," not a
  // separate list-view modal) but adds a "Discard All" bulk action once
  // more than one tab is in line, and its own "Cancel" needs to abort the
  // whole flow rather than just this one prompt.
  pendingQuit: boolean = false
): readonly Notification[] {
  if (state.phase !== 'ready') return []
  const { document } = state
  const notifications: Notification[] = []

  if (document.pendingTransform !== null) {
    const { kind, estimatedBytes } = document.pendingTransform
    notifications.push({
      id: 'derived:pendingTransform',
      severity: 'warning',
      message: `${kind === 'format' ? 'Format' : 'Minify'} Document on ${formatBytes(estimatedBytes)} — this cannot be undone. Continue?`,
      actions: [
        { label: 'Continue', commandId: 'klados.document.confirmTransformAnyway' },
        { label: 'Cancel', commandId: 'klados.document.cancelTransform' }
      ],
      documentId
    })
  }

  // See the doc comment on `transformInProgress`/`reparsePending` in
  // `documentSession.ts` for why both must be clear before this check is
  // trustworthy (`DocumentStatus.tsx`'s own reasoning, carried over verbatim).
  const showMinifiedBanner =
    document.pendingTransform === null &&
    !document.transformInProgress &&
    !document.reparsePending &&
    !document.minifiedBannerDismissed &&
    isPathologicallyMinified(document.rowIndex.length, document.sourceBuffer.byteLength)
  if (showMinifiedBanner) {
    notifications.push({
      id: 'derived:minifiedBanner',
      severity: 'info',
      message: 'This file looks minified — format it for readability?',
      actions: [
        { label: 'Format Document', commandId: 'klados.document.format' },
        { label: 'Keep As-Is', commandId: 'klados.document.dismissMinifiedBanner' }
      ],
      documentId
    })
  }

  // R23 / CONCEPT.md §11.3: a file changed on disk while there were unsaved
  // edits. Never auto-reload over unsaved work, never a modal — a derived,
  // sticky, non-blocking notification satisfies both, and re-raises on its
  // own the next time the flag flips true, since `keepMine` only clears it
  // rather than latching a "don't ask again" of its own.
  if (document.externalChangeDetected) {
    // R169 (`docs/plans/R169-external-change-reload.md`): while the reload the
    // user just asked for is in flight, **the same banner says so** rather than
    // sitting there unchanged.
    //
    // The reported symptom was that Reload looked like a dead button: the
    // reload never leaves `phase: 'ready'`, so nothing on screen moved between
    // the click and the parse completing, and the banner itself was the most
    // visible thing insisting nothing had happened.
    //
    // **Changing the existing banner rather than showing a new indicator is
    // what lets this have no threshold and no timer** (§5: "do not make the
    // reload slower to make it visible"). A new element appearing would flash
    // for the few milliseconds a small file takes, so it would have needed a
    // delay before it could appear — and a delay is exactly what the plan
    // forbids. An element already on screen changing its text cannot flash.
    //
    // **Keep Mine stays, and is now the cancel.** It reads correctly during a
    // reload — the user is still choosing between disk and their own edits —
    // and R169 made it genuinely revocable, so offering it here is not a
    // decoration: clicking it aborts the in-flight read and keeps the buffer.
    // Reload is dropped, because it is the thing already happening.
    const reloading = document.reloadPending
    notifications.push({
      id: 'derived:externalChange',
      severity: 'warning',
      message: reloading
        ? `Reloading ${document.fileName} from disk…`
        : `${document.fileName} changed on disk. Reload and discard your unsaved edits, or keep what you have?`,
      actions: reloading
        ? [{ label: 'Keep Mine', commandId: 'klados.document.keepMine' }]
        : [
            { label: 'Reload and Discard', commandId: 'klados.document.reloadExternalChange' },
            { label: 'Keep Mine', commandId: 'klados.document.keepMine' }
          ],
      documentId
    })
  }

  // §11.4: "closing a dirty tab prompts Save / Discard / Cancel." Pushed
  // last, not first — `Notifications.tsx`'s own `merged.slice(-MAX_VISIBLE)`
  // keeps the *last* three, so this is the one most likely to survive the
  // cap under a burst of other pushes, which is right: this is the user's
  // own explicit request (a close click), not ambient document state.
  if (pendingClose) {
    notifications.push({
      id: 'derived:pendingCloseTab',
      severity: 'warning',
      message: pendingQuit
        ? `${document.fileName} has unsaved changes. Save before quitting?`
        : `${document.fileName} has unsaved changes. Save before closing?`,
      actions: pendingQuit
        ? [
            { label: 'Save', commandId: 'klados.tabs.saveAndCloseActive' },
            { label: 'Discard', commandId: 'klados.tabs.discardAndCloseActive' },
            { label: 'Discard All', commandId: 'klados.tabs.discardAllAndQuit' },
            { label: 'Cancel', commandId: 'klados.tabs.cancelQuit' }
          ]
        : [
            { label: 'Save', commandId: 'klados.tabs.saveAndCloseActive' },
            { label: 'Discard', commandId: 'klados.tabs.discardAndCloseActive' },
            { label: 'Cancel', commandId: 'klados.tabs.cancelClose' }
          ],
      documentId
    })
  }

  return notifications
}
