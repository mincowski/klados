/**
 * R25 built the strip; R26 (`R24-tabs.md` §4) adds the lifecycle
 * commands the dirty-close prompt and keyboard switching need. Invariant
 * 10: every command reachable from any surface must also be reachable from
 * the palette.
 *
 * R25 originally registered a separate `klados.tabs.new` here, since
 * opening a file still replaced the active tab's document back then (R24's
 * "no tabs in M1"). R26 makes `klados.document.open` itself open into a
 * new tab (`session/commands.ts`), which made that a second command doing
 * the exact same thing under a different name — removed in favor of the
 * one command, `session/tabs.ts`'s own `openNewTab`, that both `TitleBar`'s
 * Ctrl+O and this strip's "+" button now share.
 */
import { registerCommand } from '../../commands/registry'
import { notify } from '../../notifications/notificationStore'
import {
  activateNextTab,
  activatePreviousTab,
  cancelCloseTab,
  cancelQuitFlow,
  discardAllAndQuit,
  discardAndCloseTab,
  getActiveTabId,
  getPendingCloseTabId,
  getTabIds,
  requestCloseTab,
  saveAndCloseTab,
  setActiveTab
} from '../../session/tabs'

// R26 (`R24-tabs.md` §4): "switch with keyboard and pointer." Pointer
// switching is `TabStrip.tsx`'s own `onClick` (R25) — these are the
// keyboard half, bound to Ctrl+Tab/Ctrl+Shift+Tab in `keybindings.ts`
// (`Ctrl+PageDown`/`Ctrl+PageUp` are equally conventional; Ctrl+Tab was
// picked as the primary binding, consistent with every other tabbed app on
// the platform). No `when` gate — switching with fewer than two tabs is
// already a no-op inside `activateNextTab`/`activatePreviousTab`
// themselves, the same looseness `klados.edit.clearUndoHistory` accepts.

registerCommand({
  id: 'klados.tabs.next',
  title: 'Next Tab',
  category: 'File',
  surfaces: ['palette'],
  run: () => activateNextTab()
})

registerCommand({
  id: 'klados.tabs.previous',
  title: 'Previous Tab',
  category: 'File',
  surfaces: ['palette'],
  run: () => activatePreviousTab()
})

// R26: Ctrl+W closes the active tab — through `requestCloseTab`, so a dirty
// active tab prompts exactly like clicking its own close slot would.
registerCommand({
  id: 'klados.tabs.closeActive',
  title: 'Close Tab',
  category: 'File',
  surfaces: ['palette'],
  run: () => {
    const id = getActiveTabId()
    if (id !== null) requestCloseTab(id)
  }
})

// R26 (`R24-tabs.md` §4): resolve the pending-close choice notification
// (`derivedNotifications.ts`'s `derived:pendingCloseTab`). All three read
// `getPendingCloseTabId()` directly rather than `ctx.session` — the tab a
// close is pending for, not necessarily whatever's active by the time the
// palette command actually runs (`when: 'hasPendingCloseTab'` keeps them
// hidden whenever the two would disagree, per that key's own doc comment).

registerCommand({
  id: 'klados.tabs.saveAndCloseActive',
  title: 'Save and Close Tab',
  category: 'File',
  when: 'hasPendingCloseTab',
  surfaces: ['palette'],
  run: () => {
    const id = getPendingCloseTabId()
    if (id === null) return
    void saveAndCloseTab(id).then((outcome) => {
      if (!outcome.ok) {
        notify({
          severity: 'error',
          message: `Couldn't save: ${outcome.message}`,
          documentId: id
        })
      }
    })
  }
})

registerCommand({
  id: 'klados.tabs.discardAndCloseActive',
  title: 'Discard Changes and Close Tab',
  category: 'File',
  when: 'hasPendingCloseTab',
  surfaces: ['palette'],
  run: () => {
    const id = getPendingCloseTabId()
    if (id !== null) discardAndCloseTab(id)
  }
})

registerCommand({
  id: 'klados.tabs.cancelClose',
  title: 'Cancel Closing Tab',
  category: 'File',
  when: 'hasPendingCloseTab',
  surfaces: ['palette'],
  run: () => cancelCloseTab()
})

// R26 (`R24-tabs.md` §4): the consolidated quit flow's own two
// actions, on top of the three above — Notepad++'s "No to All"/"Cancel"
// shape. `when: 'hasPendingQuit'` (not `hasPendingCloseTab`) keeps these
// out of the palette for a plain ad-hoc close, which has nothing to bulk-
// discard and no whole flow to cancel out of.

registerCommand({
  id: 'klados.tabs.discardAllAndQuit',
  title: 'Discard All and Quit',
  category: 'File',
  when: 'hasPendingQuit',
  surfaces: ['palette'],
  run: () => discardAllAndQuit()
})

registerCommand({
  id: 'klados.tabs.cancelQuit',
  title: 'Cancel Quit',
  category: 'File',
  when: 'hasPendingQuit',
  surfaces: ['palette'],
  run: () => cancelQuitFlow()
})

// R37 (`R35-tab-overflow.md` §4): `Alt+1`…`Alt+9`, Firefox's own
// mapping — a keyboard route to a *specific* tab that doesn't cost O(n)
// keypresses the way `Ctrl+Tab` does once there are many. Nine fixed
// commands, not a dynamic per-tab registration: `registerCommand` has no
// unregister (`commands/registry.ts`), so one command per open tab would
// leave a dead entry behind for every tab ever closed — reported rather
// than worked around, per the plan's own "what was considered and
// rejected." A no-op past the end of `getTabIds()` is the same looseness
// `activateByOffset` already accepts for fewer than two tabs.
function selectTabAt(index: number): void {
  const ids = getTabIds()
  const id = index < 0 ? ids[ids.length - 1] : ids[index]
  if (id !== undefined) setActiveTab(id)
}

for (let i = 0; i < 8; i++) {
  const oneBased = i + 1
  registerCommand({
    id: `klados.tabs.select${oneBased}`,
    title: `Go to Tab ${oneBased}`,
    category: 'File',
    surfaces: ['palette'],
    run: () => selectTabAt(i)
  })
}

registerCommand({
  id: 'klados.tabs.selectLast',
  title: 'Go to Last Tab',
  category: 'File',
  surfaces: ['palette'],
  run: () => selectTabAt(-1)
})
