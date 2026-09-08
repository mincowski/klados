/**
 * R26 (`R24-tabs.md` §4) — the dirty-close prompt end to end: the
 * strip's own close slot, `session/tabs.ts`'s `requestCloseTab`, the
 * derived `derived:pendingCloseTab` notification, and the three commands
 * that resolve it, all wired together and mounted for real (real Chromium,
 * real clicks) rather than exercised piecemeal.
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
  resetTabsForTests
} from '../src/renderer/session/tabs'
import { POLL_MS, TIMEOUT_MS } from './support/wait'
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

function depsFor(text: string): Omit<DocumentSessionDeps, 'isActive'> {
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

describe('the dirty-close prompt, end to end (R26)', () => {
  it('closing a clean tab shows no notification', async () => {
    const tab = createTab(depsFor('{"a":1}'))
    await getSessionFor(tab)!.openPath('C:/docs/a.json')
    await paint()

    container.querySelector<HTMLElement>('.tab-close-slot')!.click()
    await paint()

    expect(container.querySelector('[data-testid="notifications"]')?.textContent ?? '').toBe('')
    // Not `[]` — `Notifications`' own `useDocumentSession()` read after the
    // close lazily mints a fresh empty tab, the same "there is always
    // exactly one" guarantee `getActiveSession` has given every consumer
    // since R24. The real assertion is that it isn't the tab just closed.
    expect(getTabIds()).not.toEqual([tab])
  })

  it('closing a dirty tab shows a Save/Discard/Cancel notification, and Cancel leaves it open', async () => {
    const tab = createTab(depsFor('{"a":1}'))
    const session = getSessionFor(tab)!
    await session.openPath('C:/docs/a.json')
    session.applyEdit({ start: 0, end: 0, text: ' ' })
    await paint()

    container.querySelector<HTMLElement>('.tab-close-slot')!.click()
    await paint()

    const message = container.querySelector('.notification-message')
    expect(message?.textContent).toContain('unsaved changes')
    expect(getTabIds()).toEqual([tab])

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.notification-action')]
    const cancelButton = buttons.find((b) => b.textContent === 'Cancel')!
    cancelButton.click()
    await paint()

    expect(getTabIds()).toEqual([tab])
    expect(container.querySelector('.notification-message')).toBeNull()
  })

  it('Discard closes the tab without saving', async () => {
    const api = fakeApi('{"a":1}')
    const tab = createTab({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })
    const session = getSessionFor(tab)!
    await session.openPath('C:/docs/a.json')
    session.applyEdit({ start: 0, end: 0, text: ' ' })
    await paint()

    container.querySelector<HTMLElement>('.tab-close-slot')!.click()
    await paint()

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.notification-action')]
    buttons.find((b) => b.textContent === 'Discard')!.click()
    await paint()

    expect(getTabIds()).not.toEqual([tab])
    expect(api.document.write).not.toHaveBeenCalled()
  })

  it('Save writes the file, then closes the tab', async () => {
    const api = fakeApi('{"a":1}')
    const tab = createTab({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })
    const session = getSessionFor(tab)!
    await session.openPath('C:/docs/a.json')
    session.applyEdit({ start: 0, end: 0, text: ' ' })
    await paint()

    container.querySelector<HTMLElement>('.tab-close-slot')!.click()
    await paint()

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.notification-action')]
    buttons.find((b) => b.textContent === 'Save')!.click()
    // R160 (`docs/plans/R159-fixed-duration-waits.md` §5): the comment here
    // used to say "wait for it to actually land rather than racing" above one
    // macrotask hop, which is a duration however short. The save landing *is*
    // the condition, so wait for it.
    await vi.waitFor(() => expect(api.document.write).toHaveBeenCalled(), {
      interval: POLL_MS,
      timeout: TIMEOUT_MS
    })
    await paint()

    expect(api.document.write).toHaveBeenCalled()
    expect(getTabIds()).not.toEqual([tab])
  })
})
