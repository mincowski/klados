/**
 * R26 (`R24-tabs.md` §4) — `session/quitFlow.ts`, the thin wiring
 * between `session/tabs.ts`'s consolidated quit flow and the main-process
 * IPC seam. A fake `KladosApi.app` stands in for the real preload bridge
 * (unavailable under Vitest, same reasoning every other fake `api` in this
 * suite gives). Same fake-parse infrastructure `test/tabs.test.ts` uses for
 * a genuinely dirty document (real `runParseJob`, no real `Worker`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { runParseJob } from '../src/worker/parse.worker'
import type { KladosApi } from '../src/preload/api'
import {
  createTab,
  getPendingCloseTabId,
  getSessionFor,
  resetTabsForTests
} from '../src/renderer/session/tabs'
import { initQuitFlow, resetQuitFlowForTests } from '../src/renderer/session/quitFlow'
import { resetContextForTests } from '../src/renderer/commands/context'

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

function fakeDocumentApi(text: string): KladosApi['document'] & { read: unknown } {
  const read = vi.fn().mockResolvedValue(utf8(text))
  return {
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

function fakeKladosApi(): { api: KladosApi; triggerQuitRequested: () => void } {
  let quitListener: (() => void) | undefined
  const api = {
    document: fakeDocumentApi('{"a":1}'),
    app: {
      onQuitRequested: (callback: () => void): (() => void) => {
        quitListener = callback
        return () => {
          quitListener = undefined
        }
      },
      confirmQuit: vi.fn(),
      cancelQuit: vi.fn()
    }
  } as unknown as KladosApi
  return { api, triggerQuitRequested: () => quitListener?.() }
}

beforeEach(() => {
  resetTabsForTests()
  resetContextForTests()
  resetQuitFlowForTests()
})

afterEach(() => {
  resetTabsForTests()
  resetContextForTests()
  resetQuitFlowForTests()
  ;(globalThis as { window?: unknown }).window = undefined
})

describe('quitFlow.ts', () => {
  it('confirms the quit immediately when nothing is dirty', () => {
    const { api, triggerQuitRequested } = fakeKladosApi()
    ;(globalThis as { window?: unknown }).window = { api }
    createTab()

    initQuitFlow()
    triggerQuitRequested()

    expect(api.app.confirmQuit).toHaveBeenCalledOnce()
    expect(api.app.cancelQuit).not.toHaveBeenCalled()
  })

  it('does not confirm while a dirty tab is still pending', async () => {
    const { api, triggerQuitRequested } = fakeKladosApi()
    ;(globalThis as { window?: unknown }).window = { api }

    const tab = createTab({
      parse: fakeParse,
      parseFromUrl: fakeParseFromUrl,
      api: { document: api.document }
    })
    await getSessionFor(tab)!.openPath('C:/docs/a.json')
    getSessionFor(tab)!.applyEdit({ start: 0, end: 0, text: ' ' })

    initQuitFlow()
    triggerQuitRequested()

    expect(getPendingCloseTabId()).toBe(tab)
    expect(api.app.confirmQuit).not.toHaveBeenCalled()
  })

  it('is a one-shot — a second initQuitFlow call does not double-register', () => {
    const { api, triggerQuitRequested } = fakeKladosApi()
    ;(globalThis as { window?: unknown }).window = { api }
    createTab()

    initQuitFlow()
    initQuitFlow()
    triggerQuitRequested()

    expect(api.app.confirmQuit).toHaveBeenCalledOnce()
  })

  it('does nothing when window.api is unavailable (no preload bridge)', () => {
    ;(globalThis as { window?: unknown }).window = {}
    expect(() => initQuitFlow()).not.toThrow()
  })
})
