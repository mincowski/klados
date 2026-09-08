/**
 * R95 (`R95-recent-files.md` §2) — the recent-files store, plus the two
 * `documentSession.ts` call sites that record into it and the one (R97)
 * that removes a stale entry. Store tests are pure (`recentFiles.ts` has no
 * dependency on a document session); the recording/removal tests reuse
 * `test/documentSession.test.ts`'s own fake-parse harness so a "successful
 * open" or "a stat that rejects" is real, not simulated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** R163: the window a burst of reparses gets to wrongly re-enter the
 * ready transition in. A negative assertion, so a duration is the right
 * tool — named so it reads as chosen rather than inherited. */
const REPARSE_BURST_WINDOW_MS = 250
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { runParseJob } from '../src/worker/parse.worker'
import type { KladosApi } from '../src/preload/api'
import { resetContextForTests, getContext } from '../src/renderer/commands/context'
import {
  createDocumentSession,
  type DocumentSessionDeps
} from '../src/renderer/session/documentSession'
import {
  clearRecentFiles,
  getRecentFiles,
  recordRecentFile,
  removeRecentFile,
  resetRecentFilesForTests,
  subscribeRecentFiles,
  type RecentFile
} from '../src/renderer/session/recentFiles'

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
  resetRecentFilesForTests()
  resetContextForTests()
})

afterEach(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
  resetRecentFilesForTests()
  resetContextForTests()
})

function entry(path: string): RecentFile {
  return { path, fileName: path.split('/').pop()!, formatId: 'json' }
}

describe('recentFiles store (R95)', () => {
  it('prepends a new entry and notifies subscribers', () => {
    const listener = vi.fn()
    subscribeRecentFiles(listener)
    recordRecentFile(entry('C:/docs/a.json'))
    expect(getRecentFiles()).toEqual([entry('C:/docs/a.json')])
    expect(listener).toHaveBeenCalledOnce()
  })

  it('moves a repeat open to the front instead of duplicating it', () => {
    recordRecentFile(entry('C:/docs/a.json'))
    recordRecentFile(entry('C:/docs/b.json'))
    recordRecentFile(entry('C:/docs/a.json'))
    expect(getRecentFiles().map((e) => e.path)).toEqual(['C:/docs/a.json', 'C:/docs/b.json'])
  })

  it('already at index 0 is a no-op: no write, no notification', () => {
    recordRecentFile(entry('C:/docs/a.json'))
    const listener = vi.fn()
    subscribeRecentFiles(listener)
    recordRecentFile(entry('C:/docs/a.json'))
    expect(listener).not.toHaveBeenCalled()
  })

  it('caps at 6, dropping the oldest', () => {
    for (let i = 0; i < 8; i++) recordRecentFile(entry(`C:/docs/f${i}.json`))
    const paths = getRecentFiles().map((e) => e.path)
    expect(paths).toHaveLength(6)
    expect(paths).toEqual([
      'C:/docs/f7.json',
      'C:/docs/f6.json',
      'C:/docs/f5.json',
      'C:/docs/f4.json',
      'C:/docs/f3.json',
      'C:/docs/f2.json'
    ])
  })

  it('unparseable JSON degrades to an empty list on module load, not a throw', async () => {
    localStorage.setItem('klados.recentFiles', '{ not json')
    vi.resetModules()
    const fresh = await import('../src/renderer/session/recentFiles')
    expect(fresh.getRecentFiles()).toEqual([])
  })

  it('a malformed entry in an otherwise-valid array is dropped, not the whole list', async () => {
    localStorage.setItem(
      'klados.recentFiles',
      JSON.stringify([entry('C:/docs/good.json'), 'not an entry', 42, { path: 'missing fields' }])
    )
    vi.resetModules()
    const fresh = await import('../src/renderer/session/recentFiles')
    expect(fresh.getRecentFiles()).toEqual([entry('C:/docs/good.json')])
  })

  it('clearRecentFiles empties the list', () => {
    recordRecentFile(entry('C:/docs/a.json'))
    clearRecentFiles()
    expect(getRecentFiles()).toEqual([])
  })

  it('removeRecentFile drops one entry and is a no-op for a path not present', () => {
    recordRecentFile(entry('C:/docs/a.json'))
    recordRecentFile(entry('C:/docs/b.json'))
    const listener = vi.fn()
    subscribeRecentFiles(listener)
    removeRecentFile('C:/docs/nope.json')
    expect(listener).not.toHaveBeenCalled()
    removeRecentFile('C:/docs/a.json')
    expect(getRecentFiles().map((e) => e.path)).toEqual(['C:/docs/b.json'])
  })

  it('drives the hasRecentFiles context key', () => {
    expect(getContext().hasRecentFiles).toBe(false)
    recordRecentFile(entry('C:/docs/a.json'))
    expect(getContext().hasRecentFiles).toBe(true)
    clearRecentFiles()
    expect(getContext().hasRecentFiles).toBe(false)
  })
})

// --- documentSession.ts's own call sites ---

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

/** `stat` rejects (a gone/unreadable file) when `text` is `null`. */
function fakeApi(text: string | null, overrides: Partial<FakeApi['document']> = {}): FakeApi {
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
      onExternalChange: vi.fn().mockReturnValue(() => {}),
      ...overrides
    }
  }
}

function depsFor(
  text: string | null,
  overrides: Partial<FakeApi['document']> = {}
): Omit<DocumentSessionDeps, 'isActive'> {
  return { parse: fakeParse, parseFromUrl: fakeParseFromUrl, api: fakeApi(text, overrides) }
}

describe('recording a recent file (R95 §2)', () => {
  it('records once per successful open, and again on a reparse-triggering edit burst', async () => {
    const session = createDocumentSession(depsFor('{"a":1}'))
    const listener = vi.fn()
    subscribeRecentFiles(listener)

    await session.openPath('C:/docs/a.json')
    expect(getRecentFiles().map((e) => e.path)).toEqual(['C:/docs/a.json'])
    expect(listener).toHaveBeenCalledOnce()

    // A burst of edits triggers reparses of the *same* document — these
    // must not re-enter the `ready` transition (documentSession.ts's own
    // `phase: 'ready'` comment: it's a transition, not a state every
    // `setState` re-lands), so the recent-files count must not move either.
    session.applyEdit({ start: 1, end: 1, text: 'x' })
    session.applyEdit({ start: 1, end: 1, text: 'y' })
    await new Promise((resolve) => setTimeout(resolve, REPARSE_BURST_WINDOW_MS))

    expect(listener).toHaveBeenCalledOnce()
  })

  it('a Save As to a new path records it too', async () => {
    const api = fakeApi('{"a":1}', {
      saveAsDialog: vi
        .fn()
        .mockResolvedValue({ path: 'C:/docs/renamed.json', fileName: 'renamed.json' }),
      write: vi.fn().mockResolvedValue(undefined)
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })
    await session.openPath('C:/docs/a.json')

    await session.saveAs()

    expect(getRecentFiles().map((e) => e.path)).toEqual(['C:/docs/renamed.json', 'C:/docs/a.json'])
  })
})

describe('a stale recent file removes itself on a failed open (R97)', () => {
  it('a deleted file (stat rejects) is dropped from the list after the failed open', async () => {
    recordRecentFile({ path: 'C:/docs/gone.json', fileName: 'gone.json', formatId: 'json' })
    const session = createDocumentSession(depsFor(null))

    await session.openPath('C:/docs/gone.json')

    expect(session.getSnapshot().phase).toBe('error')
    expect(getRecentFiles().map((e) => e.path)).not.toContain('C:/docs/gone.json')
  })

  it('does not touch entries unrelated to the failed path', async () => {
    recordRecentFile({ path: 'C:/docs/other.json', fileName: 'other.json', formatId: 'json' })
    recordRecentFile({ path: 'C:/docs/gone.json', fileName: 'gone.json', formatId: 'json' })
    const session = createDocumentSession(depsFor(null))

    await session.openPath('C:/docs/gone.json')

    expect(getRecentFiles().map((e) => e.path)).toEqual(['C:/docs/other.json'])
  })
})
