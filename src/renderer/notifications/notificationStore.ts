/**
 * R21-notifications.md §3 — the pushed half of the notification system.
 * "Pushed" notifications are fire-and-forget events (`notify({...})`
 * returns, the notification lives its life, nothing owns it afterwards);
 * the derived half (`derivedNotifications.ts`) is a *view* of pending
 * session state, not a copy of it, and is not stored here at all.
 *
 * A single mutable array plus a listener set — same shape as
 * `commands/context.ts`'s `state`, for the same `useSyncExternalStore`
 * reason: a snapshot must be referentially stable when nothing changed.
 */
import type { DocumentId } from './documentId'

export type NotificationSeverity = 'info' | 'warning' | 'error'

export interface NotificationAction {
  readonly label: string
  /** A registered command id — §3g: "a notification action that resolves
   * pending state must also be a command." Invariant 10 falls out of this
   * for free: every action is, by construction, palette-reachable. */
  readonly commandId: string
}

export interface Notification {
  readonly id: string
  readonly severity: NotificationSeverity
  readonly message: string
  readonly actions?: readonly NotificationAction[]
  /** Which document this belongs to; `null` is application-scoped. */
  readonly documentId: DocumentId | null
  /** A repeat with the same key replaces rather than stacks (§3c). */
  readonly dedupeKey?: string
}

export interface NotifyInput {
  readonly severity: NotificationSeverity
  readonly message: string
  readonly actions?: readonly NotificationAction[]
  readonly documentId: DocumentId | null
  readonly dedupeKey?: string
}

/** §3b: "actions ⇒ sticky, errors ⇒ sticky, everything else auto-dismisses
 * after ~5 s." */
const AUTO_DISMISS_MS = 5000

let notifications: readonly Notification[] = []
let nextId = 0
const listeners = new Set<() => void>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getPushedNotifications(): readonly Notification[] {
  return notifications
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function isSticky(notification: Notification): boolean {
  return notification.severity === 'error' || notification.actions !== undefined
}

function clearTimer(id: string): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

function armTimer(notification: Notification): void {
  clearTimer(notification.id)
  if (isSticky(notification)) return
  timers.set(
    notification.id,
    setTimeout(() => dismissNotification(notification.id), AUTO_DISMISS_MS)
  )
}

/** Pushes a notification and returns its id. A repeat `dedupeKey` replaces
 * the existing notification with that key (and restarts its timer) rather
 * than stacking a duplicate — Tree's truncation notice firing on every
 * Expand All is the case this exists for (§3c). */
export function notify(input: NotifyInput): string {
  const id = input.dedupeKey !== undefined ? `dedupe:${input.dedupeKey}` : `pushed:${nextId++}`
  if (input.dedupeKey !== undefined) {
    clearTimer(id)
    notifications = notifications.filter((n) => n.id !== id)
  }
  const notification: Notification = { ...input, id }
  notifications = [...notifications, notification]
  armTimer(notification)
  emit()
  return id
}

export function dismissNotification(id: string): void {
  if (!notifications.some((n) => n.id === id)) return
  clearTimer(id)
  notifications = notifications.filter((n) => n.id !== id)
  emit()
}

/** §3b: "Hovering or focusing pauses the timer." Resumed on
 * blur/mouse-leave via `resumeAutoDismiss`. A no-op for a sticky
 * notification, which never had a timer to pause. */
export function pauseAutoDismiss(id: string): void {
  clearTimer(id)
}

export function resumeAutoDismiss(id: string): void {
  const notification = notifications.find((n) => n.id === id)
  if (notification !== undefined) armTimer(notification)
}

/** Test-only: restores the module to its initial state between test cases
 * — a module-level singleton, same reasoning as `resetContextForTests`. */
export function resetNotificationsForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  notifications = []
  nextId = 0
}
