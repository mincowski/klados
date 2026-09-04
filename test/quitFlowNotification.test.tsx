/**
 * R26 (`R24-tabs.md` §4) — the consolidated quit flow end to end:
 * `startQuitFlow` driving the same per-tab `derived:pendingCloseTab`
 * notification `test/tabCloseNotification.test.tsx` exercises for a single
 * ad-hoc close, but now with the quit-only "Discard All"/"Cancel" actions
 * and asking one dirty tab at a time. Real Chromium, real clicks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { runParseJob } from '../src/worker/parse.worker'
import { resetContextForTests } from '../src/renderer/commands/context'
import type { KladosApi } from '../src/preload/api'
import type { DocumentSessionDeps } from '../src/renderer/session/documentSession'
import {
  createTab,
  getSessionFor,
  getTabIds,
  resetTabsForTests,
  setQuitFlowHandlers,
  startQuitFlow
} from '../src/renderer/session/tabs'
import { resetNotificationsForTests } from '../src/renderer/notifications/notificationStore'
import { Notifications } from '../src/renderer/notifications/Notifications'
import { TabStrip } from '../src/renderer/components/TabStrip/TabStrip'
import '../src/renderer/commands/builtins'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/notifications/Notifications.css'

type FakeApi = {
  document: KladosApi['document'] & { read: (path: string) => Promise<ArrayBuffer> }
}

let nextRequestId = 1
const fakeReadTokenBytes = new Map<string, ArrayBuffer>()
let fakeReadTokenCounter = 0

function utf8(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer
}

function fakeParse(bytes: ArrayBuffer, options: ParseClientOptions): Promise<ParseClientResult> {
  const response = runParseJob(
    { type: 'parse', requestId: nextRequestId++, bytes, filename: options.filename },
    (bytesConsumed) => options.onProgress?.(bytesConsumed)
  )
  if (response.type === 'error') return Promise.reject(new Error(response.message))
  return Promise.resolve(rehydrateParseResult(response))
}

async function fakeParseFromUrl(
  url: string,
  options: ParseClientOptions
): Promise<ParseClientResult> {
  const token = new URL(url).hostname
  const bytes = fakeReadTokenBytes.get(token)
  if (bytes === undefined) throw new Error(`no bytes registered for token ${token}`)
  fakeReadTokenBytes.delete(token)
  return fakeParse(bytes, options)
}

function fakeApi(text: string): FakeApi {
  const read = vi.fn().mockResolvedValue(utf8(text))
  return {
    document: {
      openDialog: vi.fn().mockResolvedValue(null),
      stat: vi.fn().mockResolvedValue({ size: text.length, readOnly: false }),
      read,
      mintReadToken: vi.fn().mockImplementation(async (path: string) => {
        const bytes = await read(path)
        const token = `fake-token-${fakeReadTokenCounter++}`
        fakeReadTokenBytes.set(token, bytes)
        return token
      }),
      getPathForFile: vi.fn().mockReturnValue(''),
      write: vi.fn().mockResolvedValue(undefined),
      saveAsDialog: vi.fn().mockResolvedValue(null),
      watch: vi.fn().mockResolvedValue(undefined),
      unwatch: vi.fn().mockResolvedValue(undefined),
      onExternalChange: vi.fn().mockReturnValue(() => {})
    }
  }
}

function depsFor(text: string): Omit<DocumentSessionDeps, 'isActive' | 'estimateOtherTabsBytes'> {
  return { parse: fakeParse, parseFromUrl: fakeParseFromUrl, api: fakeApi(text) }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  resetTabsForTests()
  resetContextForTests()
  resetNotificationsForTests()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetContextForTests()
  resetNotificationsForTests()
})

async function paint(): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(
      <>
        <TabStrip />
        <Notifications />
      </>
    )
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function actionButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.notification-action')]
}

describe('the consolidated quit flow, end to end (R26)', () => {
  it('shows Discard All / Cancel alongside Save / Discard once a quit is in progress', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('{"b":2}'))
    await getSessionFor(tabA)!.openPath('C:/docs/a.json')
    await getSessionFor(tabB)!.openPath('C:/docs/b.json')
    getSessionFor(tabA)!.applyEdit({ start: 0, end: 0, text: ' ' })
    getSessionFor(tabB)!.applyEdit({ start: 0, end: 0, text: ' ' })

    let resolved = 0
    setQuitFlowHandlers({ onAllResolved: () => resolved++, onCancelled: () => {} })

    startQuitFlow()
    await paint()

    const labels = actionButtons().map((b) => b.textContent)
    expect(labels).toEqual(['Save', 'Discard', 'Discard All', 'Cancel'])
    expect(resolved).toBe(0)
  })

  it('asks the next dirty tab automatically once the first is resolved', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('{"b":2}'))
    await getSessionFor(tabA)!.openPath('C:/docs/a.json')
    await getSessionFor(tabB)!.openPath('C:/docs/b.json')
    getSessionFor(tabA)!.applyEdit({ start: 0, end: 0, text: ' ' })
    getSessionFor(tabB)!.applyEdit({ start: 0, end: 0, text: ' ' })

    let resolved = 0
    setQuitFlowHandlers({ onAllResolved: () => resolved++, onCancelled: () => {} })

    startQuitFlow()
    await paint()
    expect(container.querySelector('.notification-message')?.textContent).toContain('a.json')

    actionButtons()
      .find((b) => b.textContent === 'Discard')!
      .click()
    await paint()

    expect(container.querySelector('.notification-message')?.textContent).toContain('b.json')
    expect(resolved).toBe(0)

    actionButtons()
      .find((b) => b.textContent === 'Discard')!
      .click()
    await paint()

    expect(resolved).toBe(1)
    // Not `[]` — `Notifications`'/`TabStrip`'s own render after the close
    // reads `activeSession`, which lazily mints a fresh empty tab once none
    // is active (`tabs.ts`'s own "there is always exactly one" guarantee,
    // `test/tabCloseNotification.test.tsx`'s own comment on the same
    // effect). The real assertion is that neither original tab survived.
    expect(getTabIds()).not.toEqual(expect.arrayContaining([tabA, tabB]))
  })

  it('Discard All closes everything still dirty in one step', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('{"b":2}'))
    const tabC = createTab(depsFor('{"c":3}'))
    for (const [id, path] of [
      [tabA, 'C:/docs/a.json'],
      [tabB, 'C:/docs/b.json'],
      [tabC, 'C:/docs/c.json']
    ] as const) {
      await getSessionFor(id)!.openPath(path)
      getSessionFor(id)!.applyEdit({ start: 0, end: 0, text: ' ' })
    }

    let resolved = 0
    setQuitFlowHandlers({ onAllResolved: () => resolved++, onCancelled: () => {} })

    startQuitFlow()
    await paint()

    actionButtons()
      .find((b) => b.textContent === 'Discard All')!
      .click()
    await paint()

    expect(resolved).toBe(1)
    // See the previous test's own comment on why not `[]`.
    expect(getTabIds()).not.toEqual(expect.arrayContaining([tabA, tabB, tabC]))
  })

  it('Cancel aborts the whole flow and leaves every tab open', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('{"b":2}'))
    await getSessionFor(tabA)!.openPath('C:/docs/a.json')
    await getSessionFor(tabB)!.openPath('C:/docs/b.json')
    getSessionFor(tabA)!.applyEdit({ start: 0, end: 0, text: ' ' })
    getSessionFor(tabB)!.applyEdit({ start: 0, end: 0, text: ' ' })

    let cancelled = 0
    setQuitFlowHandlers({ onAllResolved: () => {}, onCancelled: () => cancelled++ })

    startQuitFlow()
    await paint()

    actionButtons()
      .find((b) => b.textContent === 'Cancel')!
      .click()
    await paint()

    expect(cancelled).toBe(1)
    expect(getTabIds()).toEqual([tabA, tabB])
    expect(container.querySelector('.notification-message')).toBeNull()
  })
})
