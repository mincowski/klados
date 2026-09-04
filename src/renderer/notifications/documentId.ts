/**
 * R21-notifications.md §3d: every notification carries the document it
 * belongs to, so the container can render only what's relevant to the
 * active document plus application-scoped ones (`documentId: null`).
 *
 * `R24-tabs.md` made this real: a `TabId` (`session/tabs.ts`) *is* a
 * document identity now, one per open tab, so `DocumentId` is that type
 * directly rather than a separate concept needing its own registry.
 * `activeDocumentId()` reads whichever tab is active at call time — Tree's
 * truncation notices, Raw's edit refusals and Grid's export confirm all
 * call this at the moment they push, so a notification is tagged with
 * whichever tab's pane the user was actually interacting with.
 */
import { getActiveTabId } from '../session/tabs'

export type DocumentId = string

export function activeDocumentId(): DocumentId | null {
  return getActiveTabId()
}
