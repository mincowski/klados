/**
 * R21-notifications.md — the notification stack. Real Chromium via
 * `react-dom/client` (`test/statusBar.test.tsx`'s own pattern), since
 * hover/focus pausing auto-dismiss and the geometry claim below both need
 * real layout, which jsdom fakes.
 *
 * `Notifications` itself reads `useDocumentSession()` — the tab-aware
 * `activeSession` (`session/tabs.ts`, R24-tabs.md) — so these tests
 * exercise the pushed half of the system directly (`notify()`/
 * `dismissNotification()`), which doesn't need a document open at all
 * (§3d's scope filter is `documentId === null || documentId ===
 * <active tab id>`, unconditional on session phase). `resetTabsForTests()`
 * keeps each test's lazily-created tab from leaking into the next.
 * The derived half (`derivedNotifications.ts`) is exercised structurally,
 * not through a real `activeSession.openPath` — no existing test in this
 * suite stands up a real document through the full session/IPC path, and
 * building that harness wasn't attempted here; disclosed rather than
 * silently assumed covered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { getAllCommands } from '../src/renderer/commands/registry'
import { Notifications } from '../src/renderer/notifications/Notifications'
import {
  dismissNotification,
  notify,
  resetNotificationsForTests
} from '../src/renderer/notifications/notificationStore'
import { resetTabsForTests } from '../src/renderer/session/tabs'
// Static, once per file — see `test/statusBar.test.tsx`'s own comment on
// why this can't be reset-and-reimported per test.
import '../src/renderer/commands/builtins'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/notifications/Notifications.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetNotificationsForTests()
  resetTabsForTests()
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetNotificationsForTests()
  resetTabsForTests()
  vi.useRealTimers()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

describe('Notifications (R21-notifications.md)', () => {
  it('renders nothing extra when the queue is empty', async () => {
    await paint(<Notifications />)
    expect(container.querySelectorAll('.notification').length).toBe(0)
  })

  it('a pushed notification announces itself with the right role', async () => {
    notify({ severity: 'info', message: 'hello', documentId: null })
    await paint(<Notifications />)
    const el = container.querySelector('.notification-info')!
    expect(el.getAttribute('role')).toBe('status')

    notify({ severity: 'warning', message: 'careful', documentId: null })
    await paint(<Notifications />)
    const warn = container.querySelector('.notification-warning')!
    expect(warn.getAttribute('role')).toBe('alert')
  })

  it('the container itself carries no role (R12s defect, not repeated)', async () => {
    notify({ severity: 'info', message: 'hello', documentId: null })
    await paint(<Notifications />)
    expect(container.querySelector('.notifications')?.getAttribute('role')).toBeNull()
  })

  it('a repeat dedupeKey replaces rather than stacks', async () => {
    notify({ severity: 'info', message: 'first', documentId: null, dedupeKey: 'k' })
    notify({ severity: 'info', message: 'second', documentId: null, dedupeKey: 'k' })
    await paint(<Notifications />)
    const messages = Array.from(container.querySelectorAll('.notification-message')).map(
      (n) => n.textContent
    )
    expect(messages).toEqual(['second'])
  })

  it('shows at most three, collapsing the rest into "N more"', async () => {
    for (let i = 0; i < 5; i++) {
      notify({ severity: 'info', message: `n${i}`, documentId: null })
    }
    await paint(<Notifications />)
    expect(container.querySelectorAll('.notification').length).toBe(3)
    expect(container.querySelector('.notifications-more')?.textContent).toBe('2 more')
    // Newest nearest the bottom — the DOM's last notification is the most
    // recently pushed one still visible.
    const messages = Array.from(container.querySelectorAll('.notification-message')).map(
      (n) => n.textContent
    )
    expect(messages).toEqual(['n2', 'n3', 'n4'])
  })

  // Auto-dismiss's actual ~5s timer, and pause/resume's effect on it
  // (§3b), are exercised with fake timers against the store directly in
  // `test/notificationStore.test.ts` — fake timers and this suite's
  // real-Chromium browser-mode `requestAnimationFrame` wait (`paint`'s own
  // double-rAF) don't compose (both attempts here timed out at the
  // runner's 15s ceiling rather than resolving), and vitest's browser mode
  // can't spy on an ESM export to verify the wiring indirectly either
  // ("Module namespace is not configurable"). So this only confirms the
  // event handlers are attached and don't throw; the pause/resume
  // semantics themselves are the other file's job.
  it('hover/leave and focus/blur wire to the notification without erroring, and the notification survives a hover', async () => {
    notify({ severity: 'info', message: 'hover me', documentId: null, dedupeKey: 'h' })
    await paint(<Notifications />)
    const el = container.querySelector<HTMLDivElement>('.notification')!

    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    el.dispatchEvent(new FocusEvent('focus', { bubbles: false }))
    el.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
    await paint(<Notifications />)

    expect(container.querySelectorAll('.notification').length).toBe(1)
  })

  it('an action button runs its command and dismisses the notification', async () => {
    let ran = false
    const { registerCommand } = await import('../src/renderer/commands/registry')
    registerCommand({
      id: 'test.notifications.action',
      title: 'Test Action',
      category: 'Edit',
      surfaces: ['palette'],
      run: () => {
        ran = true
      }
    })
    notify({
      severity: 'warning',
      message: 'choose one',
      documentId: null,
      actions: [{ label: 'Go', commandId: 'test.notifications.action' }],
      dedupeKey: 'choice'
    })
    await paint(<Notifications />)
    const button = container.querySelector<HTMLButtonElement>('.notification-action')!
    button.click()
    await paint(<Notifications />)
    expect(ran).toBe(true)
    expect(container.querySelectorAll('.notification').length).toBe(0)
  })

  it('dismissNotification removes a notification directly', async () => {
    const id = notify({ severity: 'info', message: 'bye', documentId: null })
    await paint(<Notifications />)
    expect(container.querySelectorAll('.notification').length).toBe(1)
    dismissNotification(id)
    await paint(<Notifications />)
    expect(container.querySelectorAll('.notification').length).toBe(0)
  })
})

describe('R21 §3g — every action-resolving command is registered and palette-reachable', () => {
  const ids = [
    'klados.document.confirmTransformAnyway',
    'klados.document.cancelTransform',
    'klados.document.dismissMinifiedBanner',
    'klados.document.keepMine',
    'klados.document.reloadExternalChange',
    'klados.notifications.focusNewest',
    'klados.grid.confirmExport',
    'klados.grid.cancelExport'
  ]

  for (const id of ids) {
    it(`${id} is registered and palette-reachable`, () => {
      const command = getAllCommands().find((c) => c.id === id)
      expect(command).toBeDefined()
      expect(command!.surfaces).toContain('palette')
    })
  }
})

describe('R22 — the notification layer never participates in layout', () => {
  it('`.notifications` is position: fixed, so its presence cannot shift a sibling in flow', async () => {
    await paint(
      <div style={{ display: 'flex', flexDirection: 'column', height: '400px' }}>
        <div className="layout-body" style={{ flex: 1 }}>
          body
        </div>
        <div className="status-bar" style={{ height: '24px' }}>
          status
        </div>
        <Notifications />
      </div>
    )
    const bodyEmpty = container.querySelector('.layout-body')!.getBoundingClientRect()

    for (let i = 0; i < 3; i++) {
      notify({
        severity: 'warning',
        message: `alert number ${i} with a reasonably long message to force wrapping`,
        documentId: null
      })
    }
    await paint(
      <div style={{ display: 'flex', flexDirection: 'column', height: '400px' }}>
        <div className="layout-body" style={{ flex: 1 }}>
          body
        </div>
        <div className="status-bar" style={{ height: '24px' }}>
          status
        </div>
        <Notifications />
      </div>
    )
    expect(container.querySelectorAll('.notification').length).toBe(3)
    const bodyWithNotifications = container.querySelector('.layout-body')!.getBoundingClientRect()

    expect(bodyWithNotifications.top).toBe(bodyEmpty.top)
    expect(bodyWithNotifications.height).toBe(bodyEmpty.height)
    expect(bodyWithNotifications.width).toBe(bodyEmpty.width)
  })
})

// R57 (`R57-notification-emphasis.md` §4): severity moved from a full
// background fill to a 3px left edge on a shared neutral surface — asserted
// on computed style through real Chromium, same reasoning
// `test/scrollbarContrast.test.tsx` gives for not eyeballing a contrast
// claim.
function parseRgb(color: string): [number, number, number] {
  const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(color)
  if (match === null) throw new Error(`unparseable color: ${color}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(parseRgb(a))
  const l2 = relativeLuminance(parseRgb(b))
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

describe('notification severity is a left edge, not a fill (R57)', () => {
  it('all three severities resolve the same background-color', async () => {
    notify({ severity: 'info', message: 'i', documentId: null, dedupeKey: 'i' })
    notify({ severity: 'warning', message: 'w', documentId: null, dedupeKey: 'w' })
    notify({ severity: 'error', message: 'e', documentId: null, dedupeKey: 'e' })
    await paint(<Notifications />)

    const backgrounds = ['info', 'warning', 'error'].map(
      (severity) =>
        getComputedStyle(container.querySelector(`.notification-${severity}`)!).backgroundColor
    )
    expect(new Set(backgrounds).size).toBe(1)
  })

  it('border-left-color differs between info, warning and error', async () => {
    notify({ severity: 'info', message: 'i', documentId: null, dedupeKey: 'i' })
    notify({ severity: 'warning', message: 'w', documentId: null, dedupeKey: 'w' })
    notify({ severity: 'error', message: 'e', documentId: null, dedupeKey: 'e' })
    await paint(<Notifications />)

    const edges = ['info', 'warning', 'error'].map(
      (severity) =>
        getComputedStyle(container.querySelector(`.notification-${severity}`)!).borderLeftColor
    )
    expect(new Set(edges).size).toBe(3)
  })

  for (const theme of ['light', 'dark'] as const) {
    // Scoped to the two severities that actually carry a diagnostic colour
    // — `R57-notification-emphasis.md` §4's own worked table only ever
    // computed warning's contrast (4.10:1 light, 5.54:1 dark), and measuring
    // 'info' here found why: its edge is plain `--surface-border`, which is
    // *not* a severity colour and does not clear 3:1 against `--elev-2-bg`
    // in either theme (1.31:1 light; **exactly 1:1 in dark**, where
    // `--surface-border` and `--elev-2-bg` are the literal same token,
    // `--gray-700` — the edge is genuinely invisible there). Not a
    // regression R57 introduced (`info` never had a severity colour to draw
    // a border from, and relied on the shadow alone before this round too)
    // and not fixed here — recorded in this file's own describe block below
    // and in `R57-notification-emphasis.md`'s Results, since silently
    // narrowing the assertion without saying why would hide a real,
    // previously-undiscovered gap instead of disclosing it.
    it(`severity-edge-vs-surface contrast is >= 3:1 for warning and error in ${theme}`, async () => {
      document.documentElement.dataset.theme = theme
      notify({ severity: 'warning', message: 'w', documentId: null, dedupeKey: 'w' })
      notify({ severity: 'error', message: 'e', documentId: null, dedupeKey: 'e' })
      await paint(<Notifications />)

      for (const severity of ['warning', 'error']) {
        const el = container.querySelector(`.notification-${severity}`)!
        const style = getComputedStyle(el)
        const ratio = contrastRatio(style.borderLeftColor, style.backgroundColor)
        expect(ratio, `${severity} in ${theme}`).toBeGreaterThanOrEqual(3)
      }
    })

    // R60 (`R60-dark-elevation.md` §5, acceptance 1): light theme is
    // untouched by R60 (`--surface-border` and `--elev-2-bg` were never the
    // same token there) and stays at its known 1.31:1. Dark is the one that
    // changes: before R60 this pinned dark's ratio at exactly 1:1 —
    // `--surface-border` and `--elev-2-bg` were the literal same token, so
    // 'info's plain hairline was genuinely invisible. R60 moves
    // `--elev-2-bg` to `--gray-850` in dark (leaving `--surface-border`
    // untouched), which is why the border now reads even with no severity
    // colour behind it. Still sub-3:1 in both (neither has a severity
    // colour to draw a strong border from).
    it(`'info' has no severity colour, so its plain hairline is sub-3:1 in ${theme}`, async () => {
      document.documentElement.dataset.theme = theme
      notify({ severity: 'info', message: 'i', documentId: null, dedupeKey: 'i' })
      await paint(<Notifications />)

      const el = container.querySelector('.notification-info')!
      const style = getComputedStyle(el)
      const ratio = contrastRatio(style.borderLeftColor, style.backgroundColor)
      expect(ratio).toBeLessThan(3)
      if (theme === 'dark') {
        // No longer the same token — genuinely visible now.
        expect(ratio).toBeGreaterThanOrEqual(1.5)
      } else {
        expect(ratio).toBeCloseTo(1.31, 1)
      }
    })

    // §2's own trap, checked directly rather than assumed fixed: in light
    // theme `--elev-2-bg` *is* `--surface-bg` (both `--gray-0`), and §4's
    // own diff doesn't touch either token — measured directly (`getComputedStyle`
    // before writing this test) that a notification's `background-color`
    // is therefore still pixel-identical to the pane behind it in light
    // theme, edge or no edge. R57's own plan text asks for this pair to
    // "differ… in both themes," which is not achievable without a token
    // change outside this round's own diff (bumping `--elev-2-bg` away from
    // `--surface-bg`, the "step the shadow" territory §4 explicitly defers)
    // — recorded as a plan/measurement mismatch rather than silently
    // satisfied by a weaker assertion. What the border actually buys instead
    // — a real, non-zero, rendered boundary independent of whether the two
    // backgrounds happen to match — is what this test guards.
    it(`the notification renders a real border even where its background matches the pane exactly, in ${theme}`, async () => {
      document.documentElement.dataset.theme = theme
      notify({ severity: 'info', message: 'i', documentId: null, dedupeKey: 'i' })
      await paint(
        <div style={{ background: 'var(--surface-bg)' }}>
          <Notifications />
        </div>
      )

      const pane = container.firstElementChild as HTMLElement
      const notification = container.querySelector('.notification')! as HTMLElement
      const style = getComputedStyle(notification)

      expect(style.borderTopWidth).not.toBe('0px')
      expect(style.borderTopColor).not.toBe('rgba(0, 0, 0, 0)')
      // The known, disclosed limitation: in light theme this pair is equal.
      // Asserted explicitly (not skipped) so a future token change that
      // *does* separate them is a change this test notices, not one that
      // silently stops testing anything.
      if (theme === 'light') {
        expect(getComputedStyle(notification).backgroundColor).toBe(
          getComputedStyle(pane).backgroundColor
        )
      } else {
        expect(getComputedStyle(notification).backgroundColor).not.toBe(
          getComputedStyle(pane).backgroundColor
        )
      }
    })
  }
})

describe('R60-dark-elevation.md — the elevated-surface tier gets a hairline, and dark stops over-stepping', () => {
  it('the notification panel is a tint of the pane in dark, not a separate surface (< 1.2:1)', async () => {
    document.documentElement.dataset.theme = 'dark'
    notify({ severity: 'info', message: 'i', documentId: null, dedupeKey: 'i' })
    await paint(
      <div style={{ background: 'var(--surface-bg)' }}>
        <Notifications />
      </div>
    )

    const pane = container.firstElementChild as HTMLElement
    const notification = container.querySelector('.notification')! as HTMLElement
    const ratio = contrastRatio(
      getComputedStyle(notification).backgroundColor,
      getComputedStyle(pane).backgroundColor
    )
    expect(ratio).toBeLessThan(1.2)
  })

  // The other six `--elev-2-bg` consumers (§4's table) are covered by
  // `test/elevationBorders.test.ts`, which checks the actual source CSS
  // rather than a synthetic element — Find, the palette, the statistics
  // panel, the tab-strip overflow menu and both grid dropdowns don't have
  // an existing real-Chromium mount harness in this suite, and building one
  // per component just to re-assert the same token pair this suite already
  // measures on `.notification` wasn't worth doing.
})

describe('R24-tabs.md — document-scoped notifications resolve against the real active tab', () => {
  it('a notification tagged for a background tab does not show while a different tab is active', async () => {
    const { createTab, setActiveTab } = await import('../src/renderer/session/tabs')
    const tabA = createTab()
    const tabB = createTab()
    setActiveTab(tabA)

    notify({ severity: 'info', message: 'belongs to tab A', documentId: tabA })
    await paint(<Notifications />)
    expect(container.querySelectorAll('.notification-message')[0]?.textContent).toBe(
      'belongs to tab A'
    )

    setActiveTab(tabB)
    await paint(<Notifications />)
    expect(container.querySelectorAll('.notification').length).toBe(0)

    setActiveTab(tabA)
    await paint(<Notifications />)
    expect(container.querySelectorAll('.notification-message')[0]?.textContent).toBe(
      'belongs to tab A'
    )
  })

  it('an application-scoped notification (documentId: null) shows regardless of which tab is active', async () => {
    const { createTab, setActiveTab } = await import('../src/renderer/session/tabs')
    const tabA = createTab()
    const tabB = createTab()
    setActiveTab(tabA)

    notify({ severity: 'info', message: 'app-wide', documentId: null })
    await paint(<Notifications />)
    expect(container.querySelectorAll('.notification').length).toBe(1)

    setActiveTab(tabB)
    await paint(<Notifications />)
    expect(container.querySelectorAll('.notification').length).toBe(1)
  })
})
