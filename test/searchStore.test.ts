/**
 * M4-PLAN.md G4's own acceptance criteria: search survives selection
 * changes and view toggles, does not survive closing the document, and an
 * edit clears/marks-stale the match set visibly rather than leaving stale
 * highlights around. Uses the same real-session-through-fakeParse harness
 * `documentSession.test.ts` uses — a real search store against a real
 * (fake-transport) document session, not a hand-built mock of either.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { runParseJob } from '../src/worker/parse.worker'
import { POLL_MS, TIMEOUT_MS, waitForQuiet } from './support/wait'
import type { KladosApi } from '../src/preload/api'
import {
  createDocumentSession,
  type DocumentSession,
  type DocumentSessionDeps
} from '../src/renderer/session/documentSession'
import { createSearchStore } from '../src/renderer/session/searchStore'

/** M5-PLAN.md H12 — same test-only extension `documentSession.test.ts`
 * uses; see that file's own doc comment on `FakeApi`. */
type FakeApi = {
  document: KladosApi['document'] & { read: (path: string) => Promise<ArrayBuffer> }
}

let nextRequestId = 1

function fakeParse(bytes: ArrayBuffer, options: ParseClientOptions): Promise<ParseClientResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException('Parse aborted', 'AbortError'))
  }
  const response = runParseJob(
    { type: 'parse', requestId: nextRequestId++, bytes, filename: options.filename },
    (bytesConsumed) => options.onProgress?.(bytesConsumed)
  )
  if (response.type === 'error') return Promise.reject(new Error(response.message))
  return Promise.resolve(rehydrateParseResult(response))
}

function utf8(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer
}

/** M5-PLAN.md H12 — same registry-backed test double `documentSession.test.ts`
 * uses; see that file's own doc comment on `fakeParseFromUrl`. */
const fakeReadTokenBytes = new Map<string, ArrayBuffer>()
let fakeReadTokenCounter = 0

async function fakeParseFromUrl(
  url: string,
  options: ParseClientOptions
): Promise<ParseClientResult> {
  // See `documentSession.test.ts`'s own copy of this function for why the
  // token has to be unwrapped from the URL first.
  const token = new URL(url).hostname
  const bytes = fakeReadTokenBytes.get(token)
  if (bytes === undefined) {
    throw new Error(`fakeParseFromUrl: no bytes registered for token ${token} (url ${url})`)
  }
  fakeReadTokenBytes.delete(token)
  return fakeParse(bytes, options)
}

function fakeApi(overrides: Partial<FakeApi['document']> = {}): FakeApi {
  const read = overrides.read ?? vi.fn().mockResolvedValue(utf8('{"a":1}'))
  return {
    document: {
      openDialog: vi.fn().mockResolvedValue(null),
      stat: vi.fn().mockResolvedValue({ size: 100, readOnly: false }),
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

function createSession(deps: Partial<DocumentSessionDeps> = {}): DocumentSession {
  return createDocumentSession({
    parse: fakeParse,
    parseFromUrl: fakeParseFromUrl,
    api: fakeApi(),
    ...deps
  })
}

/**
 * R154 (`docs/plans/R151-ci-matrix.md` §4a): wait for the store to stop
 * changing, not for a fixed number of milliseconds.
 *
 * This was `setTimeout(resolve, ms)` with a default of 50 and two call sites
 * passing 90. The R151 matrix ran the suite on a Windows runner for the first
 * time and line 348 failed — `expected true to be false`, the `stale` flag
 * still set because the 30 ms debounced reparse had not landed inside 90 ms
 * under load. Nothing about the assertion was wrong; the wait was.
 *
 * Third instance of this exact defect: `documentSession.test.ts` (fixed during
 * the release round after it broke a release build) and `tabStrip.test.tsx`
 * (R152) were the first two.
 *
 * **Quiescence alone is wrong for the post-edit sites, and finding out why
 * turned up a product behaviour worth knowing.** After `applyEdit` the store
 * goes `stale` synchronously and then nothing moves until the debounced
 * reparse lands, so a pure "stopped changing" wait returns before the work has
 * started — stable and not-yet-started look identical from outside. Waiting for
 * `stale` to clear *and then* settle is no better, because the flag does not
 * stay clear: measured through the real store and a real session, the edit
 * marks it stale at +1 ms, the reparse lands and the re-run clears it at
 * +48 ms, and at +205 ms a further notification arrives with the store
 * unchanged and `dirty` still true, which re-marks it stale **permanently**.
 * That is a product defect rather than a test artifact — see `docs/TASKS.md`'s
 * Owed table — and the old 90 ms sleep happened to read inside the window
 * without anyone noticing it was a window.
 *
 * So the two post-edit sites use `awaitReparsed`, which waits for exactly the
 * transition the assertion after it is about and returns at once. Everything
 * else uses `flushReparse`, where quiescence is the right question.
 *
 * The quiet window is 50 ms — the old default, comfortably above the 30 ms
 * `reparseDelayMs` these tests configure. Both throw on timeout rather than
 * returning, so a genuinely stuck store fails loudly instead of silently
 * asserting against a snapshot that never arrived.
 *
 * R159: both now delegate to `test/support/wait.ts` rather than carrying their
 * own copy of the loop. The reasoning above is why the two are *different*
 * waits, which is the part worth keeping here; the mechanics belong in one
 * place, because a per-file copy is exactly how this defect survived being
 * fixed four times.
 */
type SearchSnapshotLike = { stale: boolean; complete: boolean }

function flushReparse(store: { getSnapshot: () => SearchSnapshotLike }): Promise<void> {
  return waitForQuiet(() => store.getSnapshot(), { label: 'flushReparse' })
}

/**
 * Waits for the debounced reparse to land *and* the re-run to finish. Both
 * flags are needed: `stale` clears when the re-run **starts**, while `complete`
 * only flips when it has produced its matches, so waiting on `stale` alone
 * returns mid-flight against an incomplete result.
 *
 * A named condition, so `vi.waitFor` rather than quiescence — and it returns at
 * once when the condition already holds, which quiescence cannot do.
 */
async function awaitReparsed(store: { getSnapshot: () => SearchSnapshotLike }): Promise<void> {
  await vi.waitFor(
    () => {
      const snapshot = store.getSnapshot()
      if (snapshot.stale || !snapshot.complete) {
        throw new Error('awaitReparsed: not complete-and-fresh yet')
      }
    },
    { interval: POLL_MS, timeout: TIMEOUT_MS }
  )
}

describe('createSearchStore (G4)', () => {
  it('starts empty with no document open', () => {
    const session = createSession()
    const store = createSearchStore(session)
    expect(store.getSnapshot()).toEqual({
      starts: new Int32Array(0),
      ends: new Int32Array(0),
      complete: true,
      provisional: false,
      stale: false
    })
    store.dispose()
  })

  it('finds matches in the open document', async () => {
    const api = fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":"cat","b":"cats"}')) })
    const sessionWithApi = createDocumentSession({
      parse: fakeParse,
      parseFromUrl: fakeParseFromUrl,
      api
    })
    await sessionWithApi.openPath('C:/docs/data.json')
    const store = createSearchStore(sessionWithApi)

    store.search({ text: 'cat', mode: 'text', options: { caseSensitive: true, regex: false } })
    await flushReparse(store)

    const result = store.getSnapshot()
    expect(result.complete).toBe(true)
    expect(result.starts.length).toBe(2)
    store.dispose()
  })

  it('survives a selection change (nothing here reacts to selection at all)', async () => {
    const api = fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":"cat"}')) })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })
    await session.openPath('C:/docs/data.json')
    const store = createSearchStore(session)
    store.search({ text: 'cat', mode: 'text', options: { caseSensitive: true, regex: false } })
    await flushReparse(store)
    const before = store.getSnapshot()

    session.setSelectedNode(0)

    expect(store.getSnapshot()).toBe(before)
    store.dispose()
  })

  it('an edit marks the result stale before the debounced reparse lands, then clears it', async () => {
    const api = fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":"cat"}')) })
    const session = createDocumentSession({
      parse: fakeParse,
      parseFromUrl: fakeParseFromUrl,
      api,
      reparseDelayMs: 30
    })
    await session.openPath('C:/docs/data.json')
    const store = createSearchStore(session)
    store.search({ text: 'cat', mode: 'text', options: { caseSensitive: true, regex: false } })
    await flushReparse(store)
    expect(store.getSnapshot().stale).toBe(false)

    session.applyEdit({ start: 2, end: 3, text: 'x' }) // "a" -> "x", still has "cat"

    // Stale immediately — before the debounced reparse has had time to run.
    expect(store.getSnapshot().stale).toBe(true)

    await awaitReparsed(store)
    // Once the reparse lands and the store re-runs the same query, it's
    // fresh again (matching the still-present "cat").
    expect(store.getSnapshot().stale).toBe(false)
    expect(store.getSnapshot().complete).toBe(true)
    store.dispose()
  })

  /**
   * R156 (`docs/plans/R156-search-stale-flag.md`). The re-run after an edit
   * cleared `stale`, and then the *next* session notification put it straight
   * back — permanently, since nothing else changes the store until the next
   * edit. The result on screen was correct and labelled otherwise.
   *
   * The cause was `searchStore.ts` testing `document.dirty` where its own
   * comment says "the buffer has [moved]": `dirty` means *unsaved*, true from
   * the first keystroke until the next save, so it stays true long after the
   * reparse it was standing in for has landed.
   *
   * **This asserts the mechanism, not a duration.** R154 found the defect by
   * watching the flag for 205 ms, but a test that waits for a specific moment
   * is the same mistake that hid it — every test in this file waited 50 or
   * 90 ms and asserted inside the window where the flag was briefly correct.
   * A selection change is a notification that provably does not touch the
   * buffer, so it isolates the exact confusion: identity must not move.
   */
  it('a notification that is not a buffer change does not re-stale a fresh result', async () => {
    const api = fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":"cat"}')) })
    const session = createDocumentSession({
      parse: fakeParse,
      parseFromUrl: fakeParseFromUrl,
      api,
      reparseDelayMs: 30
    })
    await session.openPath('C:/docs/data.json')
    const store = createSearchStore(session)
    store.search({ text: 'cat', mode: 'text', options: { caseSensitive: true, regex: false } })
    await flushReparse(store)

    // Edit, then let the debounced reparse land and the query re-run. The
    // document stays dirty from here on — it is never saved.
    session.applyEdit({ start: 2, end: 3, text: 'x' }) // "a" -> "x", still has "cat"
    await awaitReparsed(store)
    const fresh = store.getSnapshot()
    expect(fresh.stale).toBe(false)
    expect(fresh.complete).toBe(true)

    // A selection change: a real notification, and one that cannot have moved
    // a byte. Before R156 this re-entered the "buffer moved" branch on the
    // strength of `dirty` alone and produced a new, stale snapshot.
    session.setCaretOffset(7)
    expect(store.getSnapshot()).toBe(fresh)
    expect(store.getSnapshot().stale).toBe(false)

    store.dispose()
  })

  it("opening a different document on the same session clears the previous document's search", async () => {
    const api = fakeApi({
      read: vi
        .fn()
        .mockImplementation((path: string) =>
          Promise.resolve(path.includes('a.json') ? utf8('{"a":"cat"}') : utf8('{"b":"dog"}'))
        )
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })
    await session.openPath('C:/docs/a.json')
    const store = createSearchStore(session)
    store.search({ text: 'cat', mode: 'text', options: { caseSensitive: true, regex: false } })
    await flushReparse(store)
    expect(store.getSnapshot().starts.length).toBeGreaterThan(0)

    await session.openPath('C:/docs/b.json')

    // The previous document's query and result are both gone — §11.4:
    // search is per document, not per app.
    expect(store.getQuery()).toBeNull()
    expect(store.getSnapshot()).toEqual({
      starts: new Int32Array(0),
      ends: new Int32Array(0),
      complete: true,
      provisional: false,
      stale: false
    })
    store.dispose()
  })

  it('clearing an empty-text query removes the result without leaving a job running', async () => {
    const api = fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":"cat"}')) })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })
    await session.openPath('C:/docs/data.json')
    const store = createSearchStore(session)
    store.search({ text: 'cat', mode: 'text', options: { caseSensitive: true, regex: false } })
    await flushReparse(store)
    expect(store.getSnapshot().starts.length).toBeGreaterThan(0)

    store.search({ text: '', mode: 'text', options: { caseSensitive: true, regex: false } })
    expect(store.getSnapshot().starts.length).toBe(0)
    expect(store.getQuery()).toBeNull()
    store.dispose()
  })

  it('a second search a tick later supersedes the first — only its results land', async () => {
    const api = fakeApi({
      read: vi.fn().mockResolvedValue(utf8('{"a":"cat","b":"dog","c":"catfish"}'))
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })
    await session.openPath('C:/docs/data.json')
    const store = createSearchStore(session)

    store.search({ text: 'cat', mode: 'text', options: { caseSensitive: true, regex: false } })
    store.search({ text: 'dog', mode: 'text', options: { caseSensitive: true, regex: false } })
    await flushReparse(store)

    const result = store.getSnapshot()
    expect(result.starts.length).toBe(1) // only "dog"
    store.dispose()
  })

  // R88 (`R86-find-as-query-surface.md` §4) retired `setDirectResult` and
  // `getDirectResultOrigin` — the palette hands off to Find by prefilling a
  // `mode: 'path'` query instead of publishing a snapshot. What those tests
  // asserted about supersession and clearing still has to be true of a
  // path *query* (`CLAUDE.md`'s own "convert, don't drop" for this
  // conversion) — see the `path mode (R86)` describe block below, which
  // covers finding matches, re-running on an edit instead of going
  // permanently stale, and clearing/superseding a diagnostic. The one
  // assertion that doesn't already have a path-mode equivalent there —
  // that a fresh query of either mode supersedes whatever came before —
  // gets its own case here.
  it('a fresh search() of either mode supersedes a path query already in flight', async () => {
    const api = fakeApi({
      read: vi.fn().mockResolvedValue(utf8('<cars><car id="c-1"><price>100</price></car></cars>'))
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })
    await session.openPath('C:/docs/cars.xml')
    const store = createSearchStore(session)

    store.search({ text: 'cars/car', mode: 'path', options: { caseSensitive: true, regex: false } })
    store.search({ text: '100', mode: 'text', options: { caseSensitive: true, regex: false } })
    await flushReparse(store)

    // Only the text search's own result lands — a stale path result never
    // gets a chance to publish over it.
    expect(store.getQuery()).toEqual({
      text: '100',
      mode: 'text',
      options: { caseSensitive: true, regex: false }
    })
    expect(store.getSnapshot().starts.length).toBe(1)
    store.dispose()
  })

  // R86 (`R86-find-as-query-surface.md` §2): path joins text as a second
  // `SearchQuery` mode — re-runnable through the same `activeQuery`
  // machinery a text search already uses, which is the whole reason it
  // exists (a `setDirectResult` snapshot can never re-run against a new
  // store; a `search({ mode: 'path' })` query does, for free).
  describe('path mode (R86)', () => {
    const CARS_XML =
      '<cars><car id="c-1"><price>100</price></car><car id="c-2"><price>200</price></car></cars>'

    it('finds matches in the open document, the same shape a text search does', async () => {
      const api = fakeApi({ read: vi.fn().mockResolvedValue(utf8(CARS_XML)) })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/cars.xml')
      const store = createSearchStore(session)

      store.search({
        text: 'cars//price',
        mode: 'path',
        options: { caseSensitive: false, regex: false }
      })
      await flushReparse(store)

      const result = store.getSnapshot()
      expect(result.complete).toBe(true)
      expect(result.starts.length).toBe(2)
      expect(store.getQuery()).toEqual({
        text: 'cars//price',
        mode: 'path',
        options: { caseSensitive: false, regex: false }
      })
      store.dispose()
    })

    it('re-runs after an edit instead of going permanently stale', async () => {
      const api = fakeApi({ read: vi.fn().mockResolvedValue(utf8(CARS_XML)) })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 30
      })
      await session.openPath('C:/docs/cars.xml')
      const store = createSearchStore(session)
      store.search({
        text: 'cars/car',
        mode: 'path',
        options: { caseSensitive: false, regex: false }
      })
      await flushReparse(store)
      expect(store.getSnapshot().starts.length).toBe(2)
      expect(store.getSnapshot().stale).toBe(false)

      // Adds a third <car> — an edit landing on a path result that used to
      // be a `setDirectResult` snapshot (never re-run, marked stale forever).
      session.applyEdit({
        start: CARS_XML.indexOf('</cars>'),
        end: CARS_XML.indexOf('</cars>'),
        text: '<car id="c-3"><price>300</price></car>'
      })
      expect(store.getSnapshot().stale).toBe(true)

      await awaitReparsed(store)
      expect(store.getSnapshot().stale).toBe(false)
      expect(store.getSnapshot().starts.length).toBe(3)
      store.dispose()
    })

    it('a query that fails to parse sets a diagnostic and an empty, non-stale result', async () => {
      const api = fakeApi({ read: vi.fn().mockResolvedValue(utf8(CARS_XML)) })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/cars.xml')
      const store = createSearchStore(session)
      expect(store.getPathDiagnostic()).toBeNull()

      store.search({ text: 'cars/', mode: 'path', options: { caseSensitive: false, regex: false } })
      await flushReparse(store)

      expect(store.getPathDiagnostic()).not.toBeNull()
      expect(store.getSnapshot()).toEqual({
        starts: new Int32Array(0),
        ends: new Int32Array(0),
        complete: true,
        provisional: false,
        stale: false
      })
      store.dispose()
    })

    it('getPathDiagnostic is cleared by a fresh search, by clear(), and by opening a different document', async () => {
      const api = fakeApi({
        read: vi
          .fn()
          .mockImplementation((path: string) =>
            Promise.resolve(path.includes('cars.xml') ? utf8(CARS_XML) : utf8('<a><b/></a>'))
          )
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/cars.xml')
      const store = createSearchStore(session)

      store.search({ text: 'cars/', mode: 'path', options: { caseSensitive: false, regex: false } })
      await flushReparse(store)
      expect(store.getPathDiagnostic()).not.toBeNull()

      store.search({
        text: 'cars/car',
        mode: 'path',
        options: { caseSensitive: false, regex: false }
      })
      await flushReparse(store)
      expect(store.getPathDiagnostic()).toBeNull()

      store.search({ text: 'cars/', mode: 'path', options: { caseSensitive: false, regex: false } })
      await flushReparse(store)
      expect(store.getPathDiagnostic()).not.toBeNull()
      store.clear()
      expect(store.getPathDiagnostic()).toBeNull()

      store.search({ text: 'cars/', mode: 'path', options: { caseSensitive: false, regex: false } })
      await flushReparse(store)
      expect(store.getPathDiagnostic()).not.toBeNull()
      await session.openPath('C:/docs/b.xml')
      expect(store.getPathDiagnostic()).toBeNull()
      store.dispose()
    })
  })
})
