/**
 * R29 (`R24-tabs.md` §7) — session restore. `beginSessionRestore`
 * itself must run before React's first render (its own header explains
 * why), so nothing here drives it through `main.tsx`; it's called
 * directly, same as `createDocumentSession`/`createTab` are exercised
 * directly elsewhere. Same fake-parse infrastructure `test/tabs.test.ts`
 * uses (real `runParseJob`, no real `Worker`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { runParseJob } from '../src/worker/parse.worker'
import type { KladosApi } from '../src/preload/api'
import type { DocumentSessionDeps } from '../src/renderer/session/documentSession'
import {
  createTab,
  getActiveTabId,
  getSessionFor,
  getTabIds,
  resetTabsForTests,
  setActiveTab
} from '../src/renderer/session/tabs'
import {
  beginSessionRestore,
  persistSessionState,
  resetSessionRestoreForTests
} from '../src/renderer/session/sessionRestore'
import {
  getPushedNotifications,
  resetNotificationsForTests
} from '../src/renderer/notifications/notificationStore'
import { resetContextForTests } from '../src/renderer/commands/context'

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

/** `stat` rejects (simulating a gone/unreadable file) when `text` is
 * `null` — everything else behaves like a normal successful open. */
function fakeApi(text: string | null): FakeApi {
  const read = vi.fn().mockResolvedValue(utf8(text ?? ''))
  return {
    document: {
      openDialog: vi.fn().mockResolvedValue(null),
      stat:
        text === null
          ? vi.fn().mockRejectedValue(new Error('ENOENT'))
          : vi.fn().mockResolvedValue({ size: text.length, readOnly: false }),
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

function depsFor(
  text: string | null
): Omit<DocumentSessionDeps, 'isActive' | 'estimateOtherTabsBytes'> {
  return { parse: fakeParse, parseFromUrl: fakeParseFromUrl, api: fakeApi(text) }
}

function fakeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    }
  } as Storage
}

const originalLocalStorage = globalThis.localStorage

beforeEach(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = fakeStorage()
  resetTabsForTests()
  resetContextForTests()
  resetNotificationsForTests()
  resetSessionRestoreForTests()
})

afterEach(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
  resetTabsForTests()
  resetContextForTests()
  resetNotificationsForTests()
  resetSessionRestoreForTests()
})

describe('persistSessionState (R29)', () => {
  it('persists only ready tabs, in strip order, with the active index', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('<b/>'))
    await getSessionFor(tabA)!.openPath('C:/docs/a.json')
    await getSessionFor(tabB)!.openPath('C:/docs/b.xml')
    setActiveTab(tabB)

    persistSessionState()

    const raw = localStorage.getItem('klados.sessionRestore')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.paths).toEqual(['C:/docs/a.json', 'C:/docs/b.xml'])
    expect(parsed.activeIndex).toBe(1)
  })

  it('omits a tab that never finished opening', () => {
    createTab() // never opened
    persistSessionState()

    const raw = localStorage.getItem('klados.sessionRestore')
    const parsed = JSON.parse(raw!)
    expect(parsed.paths).toEqual([])
    expect(parsed.activeIndex).toBe(-1)
  })
})

describe('beginSessionRestore (R29)', () => {
  it('does nothing when there is no persisted session', () => {
    beginSessionRestore()
    expect(getTabIds()).toEqual([])
  })

  it('reopens every persisted path and activates the persisted active one', async () => {
    localStorage.setItem(
      'klados.sessionRestore',
      JSON.stringify({ paths: ['C:/docs/a.json', 'C:/docs/b.xml'], activeIndex: 1 })
    )

    beginSessionRestore((path) => depsFor(path.endsWith('a.json') ? '{"a":1}' : '<b/>'))
    // `beginSessionRestore` creates tabs synchronously; the opens are async.
    expect(getTabIds().length).toBe(2)
    await vi.waitFor(() => {
      const states = getTabIds().map((id) => getSessionFor(id)!.getSnapshot().phase)
      expect(states.every((phase) => phase === 'ready')).toBe(true)
    })

    const activeId = getActiveTabId()
    const activeSnapshot = getSessionFor(activeId!)!.getSnapshot()
    expect(activeSnapshot.phase === 'ready' && activeSnapshot.document.filePath).toBe(
      'C:/docs/b.xml'
    )
  })

  it('degrades per tab — one missing file does not prevent the others from opening, and pushes one summary notification', async () => {
    localStorage.setItem(
      'klados.sessionRestore',
      JSON.stringify({ paths: ['C:/docs/gone.json', 'C:/docs/b.xml'], activeIndex: 0 })
    )

    beginSessionRestore((path) => (path.includes('gone') ? depsFor(null) : depsFor('<b/>')))

    await vi.waitFor(() => {
      expect(getPushedNotifications().length).toBeGreaterThan(0)
    })

    const phases = getTabIds().map((id) => getSessionFor(id)!.getSnapshot().phase)
    expect(phases).toContain('error')
    expect(phases).toContain('ready')

    const notification = getPushedNotifications()[0]!
    expect(notification.documentId).toBeNull()
    expect(notification.message).toContain('1 of your 2')
  })

  it('is a one-shot — a second call does nothing even with a persisted session present', () => {
    localStorage.setItem(
      'klados.sessionRestore',
      JSON.stringify({ paths: ['C:/docs/a.json'], activeIndex: 0 })
    )
    beginSessionRestore(() => depsFor('{"a":1}'))
    const afterFirst = getTabIds().length

    beginSessionRestore(() => depsFor('{"a":1}'))
    expect(getTabIds().length).toBe(afterFirst)
  })
})
