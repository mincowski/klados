/**
 * R219 (`docs/plans/R219-open-with.md` §4) — files the operating system asks
 * Klados to open: a new active tab each, except a file already open, which is
 * focused instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  getActiveTabId,
  getSessionFor,
  getTabIds,
  resetTabsForTests
} from '../src/renderer/session/tabs'
import {
  openPathsFromSystem,
  rememberOpenedPath,
  resetOpenFromSystemForTests
} from '../src/renderer/session/openFromSystem'
import { POLL_MS, TIMEOUT_MS } from './support/wait'

let nextRequestId = 1

function parseNow(bytes: ArrayBuffer, options: ParseClientOptions): Promise<ParseClientResult> {
  const response = runParseJob(
    { type: 'parse', requestId: nextRequestId++, bytes, filename: options.filename },
    () => {}
  )
  if (response.type === 'error') return Promise.reject(new Error(response.message))
  return Promise.resolve(rehydrateParseResult(response))
}

type Deps = Omit<DocumentSessionDeps, 'isActive' | 'estimateOtherTabsBytes' | 'watchKey'>

/** A session whose file opens, or — `never` — stays parsing forever. */
function depsFor(text: string, parse: 'now' | 'never' = 'now'): Deps {
  const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer
  const api = {
    document: {
      openDialog: vi.fn().mockResolvedValue(null),
      stat: vi.fn().mockResolvedValue({ size: text.length, readOnly: false }),
      read: vi.fn().mockResolvedValue(bytes),
      mintReadToken: vi.fn().mockResolvedValue('token'),
      getPathForFile: vi.fn().mockReturnValue(''),
      write: vi.fn().mockResolvedValue(undefined),
      saveAsDialog: vi.fn().mockResolvedValue(null),
      watch: vi.fn().mockResolvedValue(undefined),
      unwatch: vi.fn().mockResolvedValue(undefined),
      onExternalChange: vi.fn().mockReturnValue(() => {})
    }
  } as unknown as Pick<KladosApi, 'document'>
  const parseFromUrl = (_url: string, options: ParseClientOptions): Promise<ParseClientResult> =>
    parse === 'never'
      ? // Never finishes, but honours an abort as the real client does.
        new Promise<ParseClientResult>((_resolve, reject) =>
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        )
      : parseNow(bytes, options)
  return { parse: parseNow, parseFromUrl, api, reparseDelayMs: 20 } as Deps
}

const deps = (path: string): Deps => depsFor(path.endsWith('.json') ? '{"a":1}' : '<a/>')

function phaseOf(id: string): string | undefined {
  return getSessionFor(id)?.getSnapshot().phase
}

async function untilReady(id: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (phaseOf(id) !== 'ready') throw new Error(`tab ${id} is ${phaseOf(id)}`)
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
}

/** Just enough of `window.api` for `openFromSystem.ts`'s platform check —
 * there is no preload bridge under Vitest. */
function setPlatform(platform: string | null): void {
  if (platform === null) Reflect.deleteProperty(window, 'api')
  else Object.assign(window, { api: { titleBar: { platform } } })
}

beforeEach(() => {
  resetTabsForTests()
  resetContextForTests()
  resetOpenFromSystemForTests()
})

afterEach(() => {
  setPlatform(null)
  resetTabsForTests()
  resetContextForTests()
  resetOpenFromSystemForTests()
})

describe('openPathsFromSystem (R219)', () => {
  it('opens each file into a new tab and activates the last', async () => {
    openPathsFromSystem(['C:/docs/a.xml', 'C:/docs/b.json'], deps)
    const ids = getTabIds()
    expect(ids).toHaveLength(2)
    expect(getActiveTabId()).toBe(ids[1])
    await untilReady(ids[0]!)
    await untilReady(ids[1]!)
  })

  it('focuses a tab that already holds the file instead of opening it twice', async () => {
    openPathsFromSystem(['C:/docs/a.xml', 'C:/docs/b.json'], deps)
    const [first] = getTabIds()
    await untilReady(first!)

    openPathsFromSystem(['C:/docs/a.xml'], deps)
    expect(getTabIds()).toHaveLength(2)
    expect(getActiveTabId()).toBe(first)
  })

  it('matches a restored tab before its stat has even returned — where startup finds it', () => {
    // `main.tsx` matches the launch paths in the same synchronous step that
    // session restore starts its opens, so the restored tab is still `empty`.
    const restored = createTab(depsFor('<a/>', 'never'))
    rememberOpenedPath(restored, 'C:/docs/a.xml')
    void getSessionFor(restored)!.openPath('C:/docs/a.xml')
    expect(phaseOf(restored)).toBe('empty')
    const other = createTab(deps('C:/docs/b.json'))

    openPathsFromSystem(['C:/docs/a.xml'], deps)
    expect(getTabIds()).toEqual([restored, other])
    expect(getActiveTabId()).toBe(restored)
  })

  it('matches a restored tab that is parsing', async () => {
    const restored = createTab(depsFor('<a/>', 'never'))
    rememberOpenedPath(restored, 'C:/docs/a.xml')
    void getSessionFor(restored)!.openPath('C:/docs/a.xml')
    await vi.waitFor(() => expect(phaseOf(restored)).toBe('parsing'), {
      interval: POLL_MS,
      timeout: TIMEOUT_MS
    })

    openPathsFromSystem(['C:/docs/a.xml'], deps)
    expect(getTabIds()).toEqual([restored])
  })

  it('does not reuse a tab whose open was cancelled', async () => {
    const cancelled = createTab(depsFor('<a/>', 'never'))
    rememberOpenedPath(cancelled, 'C:/docs/a.xml')
    void getSessionFor(cancelled)!.openPath('C:/docs/a.xml')
    await vi.waitFor(() => expect(phaseOf(cancelled)).toBe('parsing'), {
      interval: POLL_MS,
      timeout: TIMEOUT_MS
    })
    getSessionFor(cancelled)!.cancel()
    await vi.waitFor(() => expect(phaseOf(cancelled)).toBe('empty'), {
      interval: POLL_MS,
      timeout: TIMEOUT_MS
    })

    openPathsFromSystem(['C:/docs/a.xml'], deps)
    expect(getTabIds()).toHaveLength(2)
    expect(getActiveTabId()).not.toBe(cancelled)
  })

  it('does not reuse a tab whose open failed', async () => {
    const failed = createTab({
      ...deps('C:/docs/a.xml'),
      api: {
        document: {
          ...(deps('C:/docs/a.xml').api as KladosApi).document,
          stat: vi.fn().mockRejectedValue(new Error('ENOENT'))
        }
      }
    } as Deps)
    rememberOpenedPath(failed, 'C:/docs/a.xml')
    await getSessionFor(failed)!.openPath('C:/docs/a.xml')
    expect(phaseOf(failed)).toBe('error')

    openPathsFromSystem(['C:/docs/a.xml'], deps)
    expect(getTabIds()).toHaveLength(2)
    expect(getActiveTabId()).not.toBe(failed)
  })

  it('compares paths case-insensitively on Windows and macOS, and exactly on Linux', async () => {
    setPlatform('win32')
    openPathsFromSystem(['C:/docs/a.xml'], deps)
    const [first] = getTabIds()
    await untilReady(first!)
    openPathsFromSystem(['C:/DOCS/A.XML'], deps)
    expect(getTabIds()).toHaveLength(1)

    setPlatform('linux')
    openPathsFromSystem(['C:/DOCS/A.XML'], deps)
    expect(getTabIds()).toHaveLength(2)
  })
})
