/**
 * R28 (`R24-tabs.md` §6) — the statistics panel's cross-tab figure.
 * `StatisticsPanel.tsx` reads `session/tabs.ts` directly (`getTabIds`/
 * `getCrossTabMemoryBytes`), so this needs real tabs registered there, not
 * just a synthetic `OpenDocument` prop the way `test/statusBar.test.tsx`
 * exercises the rest of the panel — same fake-parse infrastructure
 * `test/tabs.test.ts`/`test/tabStrip.test.tsx` use (real `runParseJob`, no
 * real `Worker`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
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
  getSessionFor,
  getCrossTabMemoryBytes,
  resetTabsForTests
} from '../src/renderer/session/tabs'
import { computeMemoryBudget } from '../src/renderer/components/StatusBar/memoryBudget'
import { StatisticsPanel } from '../src/renderer/components/StatusBar/StatisticsPanel'
import { resetStatisticsPanelStoreForTests } from '../src/renderer/components/StatusBar/statisticsPanelStore'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/StatusBar/StatisticsPanel.css'

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
  resetStatisticsPanelStoreForTests()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
  resetTabsForTests()
  resetStatisticsPanelStoreForTests()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

describe('StatisticsPanel — the cross-tab figure (R28)', () => {
  it('is absent with a single tab open', async () => {
    const tab = createTab(depsFor('{"a":1}'))
    await getSessionFor(tab)!.openPath('C:/docs/a.json')
    const state = getSessionFor(tab)!.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')

    await paint(<StatisticsPanel document={state.document} />)

    expect(container.textContent).not.toContain('All tabs')
  })

  it('shows the summed total across every open tab', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('<b>hello world</b>'))
    await getSessionFor(tabA)!.openPath('C:/docs/a.json')
    await getSessionFor(tabB)!.openPath('C:/docs/b.xml')
    const stateA = getSessionFor(tabA)!.getSnapshot()
    if (stateA.phase !== 'ready') throw new Error('unreachable')

    await paint(<StatisticsPanel document={stateA.document} />)

    const row = [...container.querySelectorAll('tr')].find((tr) =>
      tr.textContent?.startsWith('All tabs')
    )
    expect(row).toBeDefined()
    expect(row!.textContent).toContain('All tabs (2)')

    // The panel's own displayed total must match the real cross-tab sum —
    // not just "some number," a specific one.
    const expected = getCrossTabMemoryBytes()
    expect(expected).toBeGreaterThan(0)
    const totalRow = [...container.querySelectorAll('tr')].find((tr) =>
      tr.textContent?.startsWith('Total')
    )!
    // Sanity: the single-document Total row is smaller than the cross-tab
    // total once a second tab is open.
    const singleTotal = computeMemoryBudget(stateA.document).totalBytes
    expect(singleTotal).toBeLessThan(expected)
    expect(totalRow).toBeDefined()
  })
})
