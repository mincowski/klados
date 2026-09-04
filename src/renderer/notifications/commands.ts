/**
 * R21-notifications.md §3g: every notification action that resolves
 * pending state must also be a command — invariant 10's minimum bar.
 * Before this, `confirmTransformAnyway`/`cancelTransform`/
 * `dismissMinifiedBanner`/`keepMine` were session methods called directly
 * from `DocumentStatus.tsx`'s own `onClick` handlers, with zero palette
 * presence. Imported once, for its registration side effect, by
 * `commands/builtins.ts` — not from a view component, per D3.
 */
import { registerCommand } from '../commands/registry'
import { focusNewestNotification } from './notificationFocusController'

registerCommand({
  id: 'klados.document.confirmTransformAnyway',
  title: 'Continue Pending Transform',
  category: 'Edit',
  when: 'hasPendingTransform',
  surfaces: ['palette'],
  run: (ctx) => ctx.session.confirmTransformAnyway()
})

registerCommand({
  id: 'klados.document.cancelTransform',
  title: 'Cancel Pending Transform',
  category: 'Edit',
  when: 'hasPendingTransform',
  surfaces: ['palette'],
  run: (ctx) => ctx.session.cancelTransform()
})

// No context key tracks "the minified banner is currently showing" — it's
// computed live from `rowIndex`/`sourceBuffer` (`derivedNotifications.ts`),
// not stored. `canFormat` is the closest meaningful gate (same looseness
// `klados.edit.clearUndoHistory` already accepts); the session method
// itself is a safe no-op when there's nothing to dismiss.
registerCommand({
  id: 'klados.document.dismissMinifiedBanner',
  title: 'Keep Document As-Is (Dismiss Minified Offer)',
  category: 'Edit',
  when: 'canFormat',
  surfaces: ['palette'],
  run: (ctx) => ctx.session.dismissMinifiedBanner()
})

// R23 (CONCEPT.md §11.3): resolves the external-change choice notification.
// Distinct from `klados.document.revert` (F8's "Revert File," gated on
// `isDirty` alone) — this one is specifically the *reload* half of the
// external-change prompt, gated on the prompt actually being up.
registerCommand({
  id: 'klados.document.reloadExternalChange',
  title: 'Reload and Discard (External Change)',
  category: 'File',
  when: 'hasExternalChange',
  surfaces: ['palette'],
  run: (ctx) => void ctx.session.reloadAndDiscard()
})

registerCommand({
  id: 'klados.document.keepMine',
  title: 'Keep Mine (Ignore External Change)',
  category: 'File',
  when: 'hasExternalChange',
  surfaces: ['palette'],
  run: (ctx) => ctx.session.keepMine()
})

registerCommand({
  id: 'klados.notifications.focusNewest',
  title: 'Focus Newest Notification',
  category: 'View',
  surfaces: ['palette'],
  run: () => focusNewestNotification()
})
