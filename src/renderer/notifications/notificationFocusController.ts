/**
 * R21-notifications.md §3f: "A command that focuses the newest actionable
 * notification" — keyboard reachability for a choice notification without
 * a pointer. Same "component registers a live handle with a module-level
 * singleton" shape as `Tree/treeController.ts` and `Detail/gridController.ts`,
 * for the same reason: a palette command has no direct handle on the
 * mounted `Notifications` component's DOM.
 */
export interface NotificationFocusController {
  focusNewestActionable(): void
}

let current: NotificationFocusController | null = null

export function registerNotificationFocusController(
  controller: NotificationFocusController
): () => void {
  current = controller
  return () => {
    if (current === controller) current = null
  }
}

/** A no-op if no notification stack is mounted or nothing actionable is
 * showing — same tolerance `treeController.ts`'s own commands have. */
export function focusNewestNotification(): void {
  current?.focusNewestActionable()
}
