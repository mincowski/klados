/**
 * R21-notifications.md — the notification stack that replaces the alert
 * strip (`M5d-PLAN.md` R3, deleted by R22). `position: fixed`,
 * bottom-right, above the status bar (§3e) — it must never participate in
 * layout, which is the whole point of this round.
 *
 * Renders `derivedNotifications(state)` (§3a — a *view* of pending session
 * state) concatenated with the pushed queue (`notificationStore.ts`).
 * Bottom-right, newest nearest the bottom (§3c): pushed notifications keep
 * insertion order, derived ones are appended last so a live choice tends to
 * survive the three-visible cap even under a burst of transient pushes.
 */
import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react'
import { useSyncExternalStore } from 'react'
import { Severity } from '../../core/types'
import { getContext, subscribeContext } from '../commands/context'
import { getCommand } from '../commands/registry'
import { runCommand } from '../commands/uiHelpers'
import { getActiveTabId, subscribeTabs } from '../session/tabs'
import { useDocumentSession } from '../session/useDocumentSession'
import { activeDocumentId } from './documentId'
import { derivedNotifications } from './derivedNotifications'
import { registerNotificationFocusController } from './notificationFocusController'
import {
  dismissNotification,
  getPushedNotifications,
  notify,
  pauseAutoDismiss,
  resumeAutoDismiss,
  subscribeNotifications,
  type Notification
} from './notificationStore'
import './Notifications.css'

const MAX_VISIBLE = 3

function roleFor(severity: Notification['severity']): 'status' | 'alert' {
  return severity === 'info' ? 'status' : 'alert'
}

/** Fires exactly once per event, at the moment it happens — the standing
 * fact (a partial parse) stays in the status bar's diagnostic counters
 * (R12); this only announces that a parse just landed with one, or that a
 * Format/Minify request turned out to be a no-op. Neither
 * `document.complete` nor `lastTransformWasNoOp` self-clears in a way that
 * would make either one safe to render as a *derived* notification — a
 * derived one would stay on screen for as long as the underlying condition
 * held, which for a partial parse can be indefinite. */
function notifyPartialParse(document: {
  readonly diagnostics: readonly { readonly severity: Severity; readonly message: string }[]
}): void {
  const primary = document.diagnostics.find(
    (d) => d.severity === Severity.Fatal || d.severity === Severity.Error
  )
  notify({
    severity: 'warning',
    message: `Parsing stopped early${primary !== undefined ? `: ${primary.message}` : ''} — showing a partial document.`,
    documentId: activeDocumentId(),
    dedupeKey: 'document.parse.partial'
  })
}

function useTransientDocumentEvents(): void {
  const state = useDocumentSession()
  const prevRef = useRef<{
    readonly filePath: string
    readonly complete: boolean
    readonly lastTransformWasNoOp: boolean
  } | null>(null)

  useEffect(() => {
    if (state.phase !== 'ready') {
      prevRef.current = null
      return
    }
    const { document } = state
    const prev = prevRef.current
    const isNewDocument = prev === null || prev.filePath !== document.filePath

    if (!document.complete && (isNewDocument || prev.complete)) {
      notifyPartialParse(document)
    }
    if (!isNewDocument && !prev.lastTransformWasNoOp && document.lastTransformWasNoOp) {
      notify({
        severity: 'info',
        message: 'Already formatted — no changes made.',
        documentId: activeDocumentId(),
        dedupeKey: 'document.transform.noop'
      })
    }

    prevRef.current = {
      filePath: document.filePath,
      complete: document.complete,
      lastTransformWasNoOp: document.lastTransformWasNoOp
    }
  }, [state])
}

export function Notifications(): JSX.Element {
  const state = useDocumentSession()
  const pushed = useSyncExternalStore(
    subscribeNotifications,
    getPushedNotifications,
    getPushedNotifications
  )
  const activeTabId = useSyncExternalStore(subscribeTabs, getActiveTabId, getActiveTabId)
  // R26: `tabs.ts` already keeps this in sync with "the pending close
  // belongs to the active tab" (`commands/context.ts`'s own doc comment on
  // the key) — reading it here rather than `getPendingCloseTabId() ===
  // activeTabId` directly keeps this component only ever reading through
  // `commands/context`, its one existing dependency on session internals.
  const hasPendingCloseTab = useSyncExternalStore(
    subscribeContext,
    () => getContext().hasPendingCloseTab,
    () => getContext().hasPendingCloseTab
  )
  const hasPendingQuit = useSyncExternalStore(
    subscribeContext,
    () => getContext().hasPendingQuit,
    () => getContext().hasPendingQuit
  )
  useTransientDocumentEvents()

  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // §3f: a command focuses the newest actionable (has `actions`)
  // notification without a pointer; Escape returns focus to wherever it
  // came from.
  useEffect(
    () =>
      registerNotificationFocusController({
        focusNewestActionable(): void {
          const container = containerRef.current
          if (container === null) return
          const buttons = container.querySelectorAll<HTMLButtonElement>('.notification-action')
          const last = buttons[buttons.length - 1]
          if (last === undefined) return
          restoreFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
          last.focus()
        }
      }),
    []
  )

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') return
    const target = restoreFocusRef.current
    restoreFocusRef.current = null
    target?.focus()
  }

  const merged: readonly Notification[] = [
    ...pushed,
    ...derivedNotifications(state, activeTabId, hasPendingCloseTab, hasPendingQuit)
  ].filter((n) => n.documentId === null || n.documentId === activeTabId)
  const visible = merged.slice(-MAX_VISIBLE)
  const hiddenCount = merged.length - visible.length

  function runAction(notification: Notification, commandId: string): void {
    const command = getCommand(commandId)
    if (command === undefined) return
    runCommand(command)
    // Derived notifications disappear on their own once the state they
    // reflect clears (their `id` won't be in `pushed`, so this is a no-op
    // for them). Pushed choice notifications have no other owner, so the
    // action must dismiss it explicitly once resolved.
    dismissNotification(notification.id)
  }

  return (
    <div
      className="notifications"
      ref={containerRef}
      onKeyDown={onKeyDown}
      data-testid="notifications"
    >
      {hiddenCount > 0 && <div className="notifications-more">{hiddenCount} more</div>}
      {visible.map((notification) => (
        <div
          key={notification.id}
          className={`notification notification-${notification.severity}`}
          role={roleFor(notification.severity)}
          onMouseEnter={() => pauseAutoDismiss(notification.id)}
          onMouseLeave={() => resumeAutoDismiss(notification.id)}
          onFocus={() => pauseAutoDismiss(notification.id)}
          onBlur={() => resumeAutoDismiss(notification.id)}
        >
          <p className="notification-message">{notification.message}</p>
          {notification.actions !== undefined && (
            <div className="notification-actions">
              {notification.actions.map((action) => (
                <button
                  key={action.commandId}
                  type="button"
                  className="notification-action"
                  onClick={() => runAction(notification, action.commandId)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
