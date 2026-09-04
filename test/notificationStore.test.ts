/**
 * R21-notifications.md §3b/§3c — the pushed queue's own dismissal timing,
 * tested against the store directly with fake timers. Node environment
 * deliberately, not the browser project: no rendering involved, and
 * combining fake timers with real-Chromium's `requestAnimationFrame`
 * (`test/notifications.test.tsx`'s `paint` helper) reliably hung rather
 * than resolving — the two don't compose, so timer precision is verified
 * here and DOM wiring is verified there instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissNotification,
  getPushedNotifications,
  notify,
  pauseAutoDismiss,
  resumeAutoDismiss,
  resetNotificationsForTests
} from '../src/renderer/notifications/notificationStore'

beforeEach(() => {
  resetNotificationsForTests()
  vi.useFakeTimers()
})

afterEach(() => {
  resetNotificationsForTests()
  vi.useRealTimers()
})

describe('notificationStore (R21-notifications.md §3b)', () => {
  it('auto-dismisses a plain info/warning notification after ~5s', () => {
    notify({ severity: 'info', message: 'transient', documentId: null })
    expect(getPushedNotifications().length).toBe(1)
    vi.advanceTimersByTime(5001)
    expect(getPushedNotifications().length).toBe(0)
  })

  it('never auto-dismisses an error notification', () => {
    notify({ severity: 'error', message: 'stays', documentId: null })
    vi.advanceTimersByTime(60_000)
    expect(getPushedNotifications().length).toBe(1)
  })

  it('never auto-dismisses a notification with actions, even at info severity', () => {
    notify({
      severity: 'info',
      message: 'choose',
      documentId: null,
      actions: [{ label: 'Go', commandId: 'x' }]
    })
    vi.advanceTimersByTime(60_000)
    expect(getPushedNotifications().length).toBe(1)
  })

  it('pauseAutoDismiss stops the timer; resumeAutoDismiss restarts it fresh', () => {
    const id = notify({ severity: 'info', message: 'hover me', documentId: null })
    vi.advanceTimersByTime(4000)
    pauseAutoDismiss(id)
    vi.advanceTimersByTime(60_000)
    expect(getPushedNotifications().length).toBe(1)

    resumeAutoDismiss(id)
    vi.advanceTimersByTime(4999)
    expect(getPushedNotifications().length).toBe(1)
    vi.advanceTimersByTime(2)
    expect(getPushedNotifications().length).toBe(0)
  })

  it('a repeat dedupeKey restarts the auto-dismiss timer', () => {
    notify({ severity: 'info', message: 'first', documentId: null, dedupeKey: 'k' })
    vi.advanceTimersByTime(4000)
    notify({ severity: 'info', message: 'second', documentId: null, dedupeKey: 'k' })
    vi.advanceTimersByTime(4000)
    // 8s since the first push, but only 4s since the repeat — still alive.
    expect(getPushedNotifications().length).toBe(1)
    expect(getPushedNotifications()[0]!.message).toBe('second')
    vi.advanceTimersByTime(1001)
    expect(getPushedNotifications().length).toBe(0)
  })

  it('dismissNotification clears any pending timer, so it cannot double-fire', () => {
    const id = notify({ severity: 'info', message: 'bye', documentId: null })
    dismissNotification(id)
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
    expect(getPushedNotifications().length).toBe(0)
  })
})
