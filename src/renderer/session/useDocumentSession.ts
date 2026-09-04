/**
 * Subscribes a component to `activeSession` (D6). Pulled out once two
 * components needed the identical three-argument `useSyncExternalStore`
 * call — every pane (`Tree`, `Detail`, `Raw`) does now, plus
 * `notifications/Notifications.tsx`.
 */
import { useSyncExternalStore } from 'react'
import { activeSession } from './activeSession'
import type { DocumentSessionState } from './documentSession'

export function useDocumentSession(): DocumentSessionState {
  return useSyncExternalStore(
    activeSession.subscribe,
    activeSession.getSnapshot,
    activeSession.getSnapshot
  )
}
