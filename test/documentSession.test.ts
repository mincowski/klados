/**
 * D6 — the document session. `parse` is injected as a wrapper around
 * `runParseJob` (the transport-agnostic core `parseInWorker` itself calls
 * inside a real `Worker`) plus `rehydrateParseResult` (the exact
 * reconstruction `parseClient.ts`'s real `postMessage` path uses) — a real
 * parse of real bytes, without needing an actual `Worker`, which Vitest's
 * node environment doesn't have.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { runParseJob, runTransformJob } from '../src/worker/parse.worker'
import type { TransformClientOptions } from '../src/core/transformClient'
import { buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { jsonFormatModule } from '../src/formats/json/index'
import { getContext, resetContextForTests } from '../src/renderer/commands/context'
import { computeMemoryBudget } from '../src/renderer/components/StatusBar/memoryBudget'
import { consumePendingReveal } from '../src/renderer/components/Tree/treeController'
import { previewOf } from '../src/renderer/nodeDisplay'
import type { KladosApi } from '../src/preload/api'
import {
  createDocumentSession,
  NO_SELECTION,
  type DocumentSession,
  type DocumentSessionDeps
} from '../src/renderer/session/documentSession'

/** Test-only extension of the real `KladosApi['document']` shape — `read`
 * isn't part of the production interface (M5-PLAN.md H12 replaced it with
 * `mintReadToken` + a worker fetch), but every existing test configures a
 * document's content via `read`, and `fakeApi`'s own `mintReadToken`
 * implementation delegates to it below, so nothing about that ergonomic
 * needs to change at each of the ~60 call sites that use it. */
type FakeApi = {
  document: KladosApi['document'] & { read: (path: string) => Promise<ArrayBuffer> }
}

let nextRequestId = 1

/** Runs a real parse synchronously via `runParseJob`, then rehydrates it
 * through the exact same path the real worker's `postMessage` response
 * would — the fake's only difference from `parseInWorker` is "no thread". */
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

/** M5-PLAN.md H12 — the test double for `parseFromUrlInWorker`. Module-
 * level and parameter-free (matching `fakeParse`'s own shape) so it can be
 * injected at every `createDocumentSession` call site uniformly: the fake
 * `mintReadToken` below already resolved the bytes (via whichever
 * `fakeApi()` instance minted the token) and stashed them here keyed by
 * token, so this needs no awareness of which api instance was involved. */
const fakeReadTokenBytes = new Map<string, ArrayBuffer>()
let fakeReadTokenCounter = 0

async function fakeParseFromUrl(
  url: string,
  options: ParseClientOptions
): Promise<ParseClientResult> {
  // `documentSession.ts` builds `url` via `readTokenUrl(token)`
  // (`klados-file://<token>/`) before calling this — unwrap it the same
  // way `main/documents.ts`'s real protocol handler does
  // (`new URL(request.url).hostname`), not the raw token `mintReadToken`
  // handed back.
  const token = new URL(url).hostname
  const bytes = fakeReadTokenBytes.get(token)
  if (bytes === undefined) {
    throw new Error(`fakeParseFromUrl: no bytes registered for token ${token} (url ${url})`)
  }
  fakeReadTokenBytes.delete(token) // single-use, mirrors the real token's own lifecycle
  return fakeParse(bytes, options)
}

function utf8(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer
}

/** M5-PLAN.md H4 — same "no thread" relationship to `transformInWorker`
 * that `fakeParse` has to `parseInWorker`: runs the real, transport-
 * agnostic `runTransformJob` directly. */
function fakeTransform(
  bytes: ArrayBuffer,
  options: TransformClientOptions
): Promise<ArrayBuffer | null> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException('Transform aborted', 'AbortError'))
  }
  const response = runTransformJob({
    type: 'transform',
    requestId: nextRequestId++,
    bytes,
    formatId: options.formatId,
    options: options.options
  })
  if (response.type === 'transformError') return Promise.reject(new Error(response.message))
  return Promise.resolve(response.bytes)
}

function fakeApi(overrides: Partial<FakeApi['document']> = {}): FakeApi {
  const read = overrides.read ?? vi.fn().mockResolvedValue(utf8('{"a":1}'))
  return {
    document: {
      openDialog: vi.fn().mockResolvedValue(null),
      stat: vi.fn().mockResolvedValue({ size: 100, readOnly: false }),
      read,
      // M5-PLAN.md H12: mints a token by reading now (via this instance's
      // own `read`, above) and stashing the bytes for `fakeParseFromUrl` to
      // pick up by token — mirrors the real mint-then-fetch split closely
      // enough that every existing `read: vi.fn()...` override still
      // configures a document's content exactly as before.
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

describe('createDocumentSession (D6)', () => {
  beforeEach(() => resetContextForTests())
  afterEach(() => resetContextForTests())

  /** Waits for the session to stop changing, rather than for a fixed
   * duration.
   *
   * This was `setTimeout(resolve, 40)` — a guess at how long a near-zero
   * debounce timer plus the graft's own `setTimeout(0)` chain take
   * (M5-PLAN.md H2d: a splice's graft runs through `runChunkedJob`, which
   * yields at least one extra macrotask even when it finishes in its first
   * slice). The guess held on a development machine and failed on a Windows
   * CI runner, where the reparse had not landed yet and `storeChanges` read
   * 0 instead of 1. It failed the v1.0.0 release build.
   *
   * A duration cannot be picked correctly here: too short flakes on a loaded
   * runner, too long makes thirteen call sites slow. Quiescence is the real
   * condition every one of them wants — settle, *then* assert — and it is
   * also what keeps the "exactly one reparse" assertions meaningful, since a
   * burst that wrongly produced three would still be quiet by the time this
   * returns and the count would still catch it. */
  async function flushReparse(session: { getSnapshot: () => unknown }): Promise<void> {
    const QUIET_MS = 40 // the settle window the old fixed wait assumed
    const POLL_MS = 5
    const TIMEOUT_MS = 5000
    const deadline = Date.now() + TIMEOUT_MS
    let last = session.getSnapshot()
    let quietFor = 0
    while (quietFor < QUIET_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      const current = session.getSnapshot()
      if (current === last) {
        quietFor += POLL_MS
      } else {
        last = current
        quietFor = 0
      }
      if (Date.now() > deadline) {
        throw new Error(`flushReparse: session still changing after ${TIMEOUT_MS}ms`)
      }
    }
  }

  it('starts empty', () => {
    const session = createDocumentSession()
    expect(session.getSnapshot()).toEqual({ phase: 'empty' })
  })

  it('opens a well-formed document end to end: parsing -> ready', async () => {
    const api = fakeApi({
      stat: vi.fn().mockResolvedValue({ size: 100, readOnly: false }),
      read: vi.fn().mockResolvedValue(utf8('{"a":1}'))
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })

    const openPromise = session.openPath('C:/docs/data.json')
    // The 'parsing' phase is entered synchronously, before any await — see
    // documentSession.ts's own comment on why that ordering matters.
    await openPromise

    const state = session.getSnapshot()
    expect(state.phase).toBe('ready')
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.document.fileName).toBe('data.json')
    expect(state.document.formatId).toBe('json')
    expect(state.document.complete).toBe(true)
    expect(state.document.readOnly).toBe(false)
    expect(state.document.errorNode).toBeNull()
    expect(state.document.errorOffset).toBeNull()
    // R33/D-065: the initial selection is the wrapper-descent destination,
    // not the raw root — `{"a":1}`'s Document node is a transparent wrapper
    // around its one Object child (node 1), which is where every other pane
    // (Detail, breadcrumb, Raw) already lands.
    expect(state.selection).toEqual({ selectedNode: 1, caretOffset: 0 })

    expect(getContext().format).toBe('json')
    expect(getContext().isReadOnly).toBe(false)
  })

  it('a malformed document opens to a partial tree with the error marked', async () => {
    const api = fakeApi({
      stat: vi.fn().mockResolvedValue({ size: 100, readOnly: false }),
      read: vi.fn().mockResolvedValue(utf8('{"a":'))
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })

    await session.openPath('C:/docs/broken.json')

    const state = session.getSnapshot()
    expect(state.phase).toBe('ready')
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.document.complete).toBe(false)
    expect(state.document.diagnostics.length).toBeGreaterThan(0)
    expect(state.document.errorNode).not.toBeNull()
    expect(state.document.errorOffset).not.toBeNull()
    // The initial selection lands on the error, not the root — §11.1's
    // "open the Raw View at the error position" depends on this.
    expect(state.selection.selectedNode).toBe(state.document.errorNode)
    expect(state.selection.caretOffset).toBe(state.document.errorOffset)
  })

  it('a read-only file sets the isReadOnly context key', async () => {
    const api = fakeApi({
      stat: vi.fn().mockResolvedValue({ size: 100, readOnly: true }),
      read: vi.fn().mockResolvedValue(utf8('{}'))
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })

    await session.openPath('C:/docs/locked.json')

    expect(getContext().isReadOnly).toBe(true)
    const state = session.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.document.readOnly).toBe(true)
  })

  it('a file at or past the soft cap asks for confirmation rather than opening immediately', async () => {
    const SOFT_CAP = 500 * 1024 * 1024
    const api = fakeApi({ stat: vi.fn().mockResolvedValue({ size: SOFT_CAP, readOnly: false }) })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })

    await session.openPath('C:/docs/big.xml')

    const state = session.getSnapshot()
    expect(state.phase).toBe('confirmSize')
    if (state.phase !== 'confirmSize') throw new Error('unreachable')
    expect(state.fileBytes).toBe(SOFT_CAP)
    // §8's measured 2.5x rule of thumb.
    expect(state.estimatedBytes).toBe(Math.round(SOFT_CAP * 2.5))
    expect(state.reason).toBe('size')
    expect(state.totalEstimatedBytes).toBeNull()
    expect(api.document.read).not.toHaveBeenCalled()
  })

  it('confirmOpenAnyway proceeds past the soft cap and opens the file', async () => {
    const SOFT_CAP = 500 * 1024 * 1024
    const api = fakeApi({
      stat: vi.fn().mockResolvedValue({ size: SOFT_CAP, readOnly: false }),
      read: vi.fn().mockResolvedValue(utf8('{}'))
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })

    await session.openPath('C:/docs/big.xml')
    expect(session.getSnapshot().phase).toBe('confirmSize')

    session.confirmOpenAnyway()
    // Entered synchronously (documentSession.ts's comment on startParse).
    expect(session.getSnapshot().phase).toBe('parsing')

    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe('ready'))
    expect(api.document.read).toHaveBeenCalledOnce()
  })

  it('cancel during a pending confirmation dismisses it without opening', async () => {
    const api = fakeApi({
      stat: vi.fn().mockResolvedValue({ size: 500 * 1024 * 1024, readOnly: false })
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })

    await session.openPath('C:/docs/big.xml')
    expect(session.getSnapshot().phase).toBe('confirmSize')

    session.cancel()
    expect(session.getSnapshot()).toEqual({ phase: 'empty' })
    expect(api.document.read).not.toHaveBeenCalled()

    // A stale confirm doesn't leak into a later confirmation.
    session.confirmOpenAnyway()
    expect(session.getSnapshot()).toEqual({ phase: 'empty' })
  })

  it('R28: a file under the per-file soft cap still confirms if it would push the cross-tab total over budget', async () => {
    const size = 10 * 1024 * 1024 // well under SOFT_CAP
    const api = fakeApi({ stat: vi.fn().mockResolvedValue({ size, readOnly: false }) })
    const session = createDocumentSession({
      parse: fakeParse,
      parseFromUrl: fakeParseFromUrl,
      api,
      // Smaller than this file's own 2.5x estimate, so opening it alone
      // already exceeds the budget — the point is this isn't SOFT_CAP.
      totalMemoryBudgetBytes: 1024,
      estimateOtherTabsBytes: () => 0
    })

    await session.openPath('C:/docs/small.json')

    const state = session.getSnapshot()
    expect(state.phase).toBe('confirmSize')
    if (state.phase !== 'confirmSize') throw new Error('unreachable')
    expect(state.reason).toBe('budget')
    expect(state.totalEstimatedBytes).toBe(Math.round(size * 2.5))
    expect(api.document.read).not.toHaveBeenCalled()
  })

  it("R28: other tabs' own footprint counts toward the budget check", async () => {
    const size = 1024
    const api = fakeApi({ stat: vi.fn().mockResolvedValue({ size, readOnly: false }) })
    const otherTabsBytes = 10 * 1024 * 1024 * 1024 // already way over any real budget
    const session = createDocumentSession({
      parse: fakeParse,
      parseFromUrl: fakeParseFromUrl,
      api,
      totalMemoryBudgetBytes: 4 * 1024 * 1024 * 1024,
      estimateOtherTabsBytes: () => otherTabsBytes
    })

    await session.openPath('C:/docs/tiny.json')

    const state = session.getSnapshot()
    expect(state.phase).toBe('confirmSize')
    if (state.phase !== 'confirmSize') throw new Error('unreachable')
    expect(state.reason).toBe('budget')
    expect(state.totalEstimatedBytes).toBe(Math.round(size * 2.5) + otherTabsBytes)
  })

  it('R28: confirmOpenAnyway proceeds past a budget confirm exactly like a size confirm', async () => {
    const api = fakeApi({
      stat: vi.fn().mockResolvedValue({ size: 1024, readOnly: false }),
      read: vi.fn().mockResolvedValue(utf8('{}'))
    })
    const session = createDocumentSession({
      parse: fakeParse,
      parseFromUrl: fakeParseFromUrl,
      api,
      totalMemoryBudgetBytes: 1,
      estimateOtherTabsBytes: () => 0
    })

    await session.openPath('C:/docs/tiny.json')
    expect(session.getSnapshot().phase).toBe('confirmSize')

    session.confirmOpenAnyway()
    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe('ready'))
    expect(api.document.read).toHaveBeenCalledOnce()
  })

  it('a file at the hard ceiling is refused outright, never opened', async () => {
    const HARD_CEILING = 2_147_483_647
    const api = fakeApi({
      stat: vi.fn().mockResolvedValue({ size: HARD_CEILING, readOnly: false })
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })

    await session.openPath('C:/docs/huge.xml')

    const state = session.getSnapshot()
    expect(state.phase).toBe('error')
    if (state.phase !== 'error') throw new Error('unreachable')
    expect(state.message).toMatch(/2 GB/)
    expect(api.document.read).not.toHaveBeenCalled()
  })

  it('cancelling an in-progress parse leaves no half-built state', async () => {
    let resolveRead!: (bytes: ArrayBuffer) => void
    const api = fakeApi({
      stat: vi.fn().mockResolvedValue({ size: 100, readOnly: false }),
      read: vi.fn(() => new Promise<ArrayBuffer>((resolve) => (resolveRead = resolve)))
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })

    const openPromise = session.openPath('C:/docs/data.json')
    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe('parsing'))

    session.cancel()
    resolveRead(utf8('{}')) // let the stalled read settle after cancellation

    await openPromise
    expect(session.getSnapshot()).toEqual({ phase: 'empty' })
    expect(getContext().format).toBeNull()
    expect(getContext().isReadOnly).toBe(true)
  })

  it('cancel is a no-op when nothing is open or opening', () => {
    const session = createDocumentSession()
    expect(() => session.cancel()).not.toThrow()
    expect(session.getSnapshot()).toEqual({ phase: 'empty' })
  })

  it('openFileDialog opens whatever the dialog returns, and no-ops if cancelled', async () => {
    const api = fakeApi({
      openDialog: vi.fn().mockResolvedValue({ path: 'C:/docs/data.json', fileName: 'data.json' }),
      stat: vi.fn().mockResolvedValue({ size: 100, readOnly: false }),
      read: vi.fn().mockResolvedValue(utf8('{}'))
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })

    await session.openFileDialog()
    expect(session.getSnapshot().phase).toBe('ready')

    const api2 = fakeApi({ openDialog: vi.fn().mockResolvedValue(null) })
    const session2 = createDocumentSession({
      parse: fakeParse,
      parseFromUrl: fakeParseFromUrl,
      api: api2
    })
    await session2.openFileDialog()
    expect(session2.getSnapshot()).toEqual({ phase: 'empty' })
  })

  it('reports an error state, not a throw, without the document API', async () => {
    const session = createDocumentSession({ parse: fakeParse })
    await expect(session.openFileDialog()).resolves.toBeUndefined()
    expect(session.getSnapshot().phase).toBe('error')
  })

  it('a rejected openDialog() call resolves to an error state, not an unhandled rejection', async () => {
    const api = fakeApi({ openDialog: vi.fn().mockRejectedValue(new Error('dialog boom')) })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })

    await expect(session.openFileDialog()).resolves.toBeUndefined()
    const state = session.getSnapshot()
    expect(state.phase).toBe('error')
    if (state.phase !== 'error') throw new Error('unreachable')
    expect(state.message).toBe('dialog boom')
  })

  it('setSelectedNode/setCaretOffset update the selection only once ready', async () => {
    const session = createSession()
    session.setSelectedNode(5)
    expect(session.getSnapshot()).toEqual({ phase: 'empty' }) // no-op, nothing to select

    await session.openPath('C:/docs/data.json')
    session.setSelectedNode(3)
    session.setCaretOffset(12)

    const state = session.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.selection).toEqual({ selectedNode: 3, caretOffset: 12 })
  })

  // M5e-PLAN.md R8f: `setSelectedNode` used to spread `...state.selection`,
  // which preserves `caretOffset` — selecting a node in the Tree changed
  // `selectedNode` but never moved the caret, so Raw's scroll-to-caret
  // effect (keyed on `[caretOffset]`) never fired. Fixed by moving the
  // caret to the node's own span start by default.
  it('setSelectedNode moves the caret to the node span start by default', async () => {
    const session = createSession()
    await session.openPath('C:/docs/data.json')

    const readyState = session.getSnapshot()
    if (readyState.phase !== 'ready') throw new Error('unreachable')
    const expectedStart = readyState.document.store.spanOf(3).start

    session.setCaretOffset(999) // parked somewhere unrelated first
    session.setSelectedNode(3)

    const state = session.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.selection).toEqual({ selectedNode: 3, caretOffset: expectedStart })
  })

  // The trap the plan calls out: `rawCaretSync` calls `selectNode` when the
  // caret itself moved, and must not have that selection change scroll the
  // view out from under the person typing — `{ moveCaret: false }` is the
  // opt-out.
  it('setSelectedNode({ moveCaret: false }) leaves the caret where it was', async () => {
    const session = createSession()
    await session.openPath('C:/docs/data.json')

    session.setCaretOffset(999)
    session.setSelectedNode(3, { moveCaret: false })

    const state = session.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.selection).toEqual({ selectedNode: 3, caretOffset: 999 })
  })

  describe('applyEdit (F1)', () => {
    it('refuses with no document open', () => {
      const session = createSession()
      const outcome = session.applyEdit({ start: 0, end: 0, text: 'x' })
      expect(outcome).toEqual({
        ok: false,
        reason: { kind: 'not-ready' },
        message: 'No document is open.'
      })
    })

    it('refuses on a read-only document without touching the buffer', async () => {
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: 100, readOnly: true }),
        read: vi.fn().mockResolvedValue(utf8('{"a":1}'))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/locked.json')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      const outcome = session.applyEdit({ start: 5, end: 6, text: '2' })

      expect(outcome).toEqual({
        ok: false,
        reason: { kind: 'read-only' },
        message: 'This file is read-only.'
      })
      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.sourceBuffer).toBe(before.document.sourceBuffer)
    })

    it('applies a successful edit and replaces the source buffer with the new bytes', async () => {
      const session = createSession()
      await session.openPath('C:/docs/data.json')

      const outcome = session.applyEdit({ start: 5, end: 6, text: '2' })
      expect(outcome.ok).toBe(true)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":2}')
      // Same encoding/bomLength carried over — an edit changes content, not identity.
      expect(state.document.sourceBuffer.encoding).toBe('utf-8')
      expect(state.document.sourceBuffer.bomLength).toBe(0)
    })

    it('refuses on a document in a declared encoding with no encoder (real XML prolog, not synthetic)', async () => {
      const xml = '<?xml version="1.0" encoding="shift_jis"?><root>x</root>'
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: xml.length, readOnly: false }),
        read: vi.fn().mockResolvedValue(utf8(xml))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/legacy.xml')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      expect(before.document.encoding).toBe('shift_jis')

      const outcome = session.applyEdit({ start: 0, end: 0, text: 'y' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.reason).toEqual({ kind: 'unsupported-encoding', encoding: 'shift_jis' })
      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.sourceBuffer).toBe(before.document.sourceBuffer)
    })

    it('applies an edit on a windows-1252 document and leaves its encoding unchanged (R125)', async () => {
      const xml = '<?xml version="1.0" encoding="windows-1252"?><root>x</root>'
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: xml.length, readOnly: false }),
        read: vi.fn().mockResolvedValue(utf8(xml))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/legacy.xml')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      expect(before.document.encoding).toBe('windows-1252')
      const rootTextStart = xml.indexOf('<root>') + '<root>'.length

      const outcome = session.applyEdit({
        start: rootTextStart,
        end: rootTextStart + 1,
        text: 'é'
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) throw new Error('unreachable')
      expect(outcome.patch.replacement).toEqual(new Uint8Array([0xe9]))

      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.encoding).toBe('windows-1252')
      expect(new TextDecoder('windows-1252').decode(after.document.sourceBuffer.bytes)).toBe(
        '<?xml version="1.0" encoding="windows-1252"?><root>é</root>'
      )
    })

    it('refuses an edit inserting 日 into a windows-1252 document, naming the character', async () => {
      const xml = '<?xml version="1.0" encoding="windows-1252"?><root>x</root>'
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: xml.length, readOnly: false }),
        read: vi.fn().mockResolvedValue(utf8(xml))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/legacy.xml')
      const rootTextStart = xml.indexOf('<root>') + '<root>'.length

      const outcome = session.applyEdit({
        start: rootTextStart,
        end: rootTextStart + 1,
        text: '日'
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.reason).toEqual({
        kind: 'unrepresentable-character',
        encoding: 'windows-1252',
        character: '日'
      })
      expect(outcome.message).toContain('日')
    })

    it('a refused edit (e.g. the BOM guard) leaves the document state unchanged', async () => {
      const bom = new Uint8Array([0xef, 0xbb, 0xbf])
      const body = new Uint8Array(utf8('{"a":1}'))
      const bytes = new Uint8Array(bom.length + body.length)
      bytes.set(bom, 0)
      bytes.set(body, bom.length)
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: bytes.length, readOnly: false }),
        read: vi.fn().mockResolvedValue(bytes.buffer as ArrayBuffer)
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/bom.json')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      const outcome = session.applyEdit({ start: 0, end: 1, text: 'X' })

      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.reason).toEqual({ kind: 'bom' })
      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.sourceBuffer).toBe(before.document.sourceBuffer)
    })
  })

  describe('pendingSpanDeltas (R42/D-070)', () => {
    /** The project lead's own `abcdef` → `axxxbc` report, reproduced: an
     * edit lands, the buffer is current, and `document.store`'s spans are
     * still the previous parse's — `document.pendingSpanDeltas` is what a
     * view translates a span through before decoding, closing exactly the
     * window `applyEdit`'s own doc comment used to flag as "flagged, not
     * fixed" (`R42-stale-spans.md` §2's two symptoms). */
    it("an edited node's preview shows the full new text, not a same-length prefix, and a following sibling's preview stays clean, entirely within the debounce window", async () => {
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: 100, readOnly: false }),
        read: vi.fn().mockResolvedValue(utf8('{"a":"foo","b":"bar"}'))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/data.json')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      const { store } = before.document
      const object = [...store.childrenOf(0)][0]!
      const propA = [...store.childrenOf(object)].find((n) => store.nameOf(n) === 'a')!
      const propB = [...store.childrenOf(object)].find((n) => store.nameOf(n) === 'b')!

      // `"foo"` → `"fooXXX"` — insert just before the closing quote, which
      // JSON's own value span includes (`gridCell.ts`'s own doc comment).
      const spanA = store.valueOf(propA)!
      const insertAt = spanA.end - 1
      session.applyEdit({ start: insertAt, end: insertAt, text: 'XXX' })

      // Deliberately not awaiting anything — this is the mid-edit window
      // itself, before the debounced reparse (or splice) has any chance to
      // land. `store` is still `before.document.store`; only the buffer and
      // `pendingSpanDeltas` have moved.
      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.store).toBe(store) // still the stale store — the window this tests

      const previewA = previewOf(
        after.document.store,
        after.document.sourceBuffer,
        propA,
        after.document.pendingSpanDeltas
      )
      expect(previewA).toBe('"fooXXX"') // not `"fooX"` — a same-length prefix would be symptom 1

      const previewB = previewOf(
        after.document.store,
        after.document.sourceBuffer,
        propB,
        after.document.pendingSpanDeltas
      )
      expect(previewB).toBe('"bar"') // unchanged content, not markup that slid into it (symptom 2)
    })

    it('resets to empty once the debounced reparse lands, against the fresh store it was built from', async () => {
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: 100, readOnly: false }),
        read: vi.fn().mockResolvedValue(utf8('{"a":"foo","b":"bar"}'))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      const { store } = before.document
      const object = [...store.childrenOf(0)][0]!
      const propA = [...store.childrenOf(object)].find((n) => store.nameOf(n) === 'a')!
      const spanA = store.valueOf(propA)!
      session.applyEdit({ start: spanA.end - 1, end: spanA.end - 1, text: 'XXX' })

      const mid = session.getSnapshot()
      if (mid.phase !== 'ready') throw new Error('unreachable')
      expect(mid.document.pendingSpanDeltas.length).toBeGreaterThan(0)

      await new Promise((resolve) => setTimeout(resolve, 60))

      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.store).not.toBe(store) // the reparse actually landed
      expect(after.document.pendingSpanDeltas).toEqual([])
    })
  })

  describe('debounced reparse (F3)', () => {
    it('a burst of edits produces exactly one reparse', async () => {
      let parseCalls = 0
      const countingParse: typeof fakeParse = (bytes, options) => {
        parseCalls++
        return fakeParse(bytes, options)
      }
      const session = createDocumentSession({
        parse: countingParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi(),
        reparseDelayMs: 20
      })
      await session.openPath('C:/docs/data.json')
      parseCalls = 0 // only count reparses, not the initial open

      const openSnapshot = session.getSnapshot()
      if (openSnapshot.phase !== 'ready') throw new Error('unreachable')
      let storeChanges = 0
      let lastStore: unknown = openSnapshot.document.store
      session.subscribe(() => {
        const snapshot = session.getSnapshot()
        if (snapshot.phase !== 'ready') return
        if (snapshot.document.store !== lastStore) {
          storeChanges++
          lastStore = snapshot.document.store
        }
      })

      // A burst: several edits close together, each restarting the debounce.
      session.applyEdit({ start: 5, end: 6, text: '2' })
      session.applyEdit({ start: 5, end: 6, text: '3' })
      session.applyEdit({ start: 5, end: 6, text: '4' })

      await flushReparse(session)
      // F10/D-036: this plain value edit now splices instead of reaching
      // the worker — `parseCalls` staying 0 is the proof, not a
      // regression. `storeChanges` is what actually verifies the burst
      // still coalesces into one reparse attempt (splice or full) rather
      // than one per edit — a store reference changing 3 times would mean
      // the debounce stopped coalescing, regardless of which mechanism
      // handled each individual reparse.
      expect(parseCalls).toBe(0)
      expect(storeChanges).toBe(1)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":4}')
    })

    it('retains the last-good tree and reports a pending parse error on an invalid edit, without losing the caret', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi(),
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      expect(before.document.complete).toBe(true)
      const goodStore = before.document.store
      session.setCaretOffset(3)

      // Delete the closing brace — '{"a":1}' -> '{"a":1', malformed.
      session.applyEdit({ start: 6, end: 7, text: '' })
      await flushReparse(session)

      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.store).toBe(goodStore) // last-good tree retained
      expect(after.document.complete).toBe(true) // unchanged — still describes the retained tree
      expect(after.document.pendingParseError).not.toBeNull()
      expect(after.selection.caretOffset).toBe(3) // the user's place is not lost
    })

    it('recovers once the buffer becomes valid again', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi(),
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')

      session.applyEdit({ start: 6, end: 7, text: '' }) // '{"a":1' — broken
      await flushReparse(session)
      const broken = session.getSnapshot()
      if (broken.phase !== 'ready') throw new Error('unreachable')
      expect(broken.document.pendingParseError).not.toBeNull()

      session.applyEdit({ start: 6, end: 6, text: '}' }) // repair it
      await flushReparse(session)

      const fixed = session.getSnapshot()
      if (fixed.phase !== 'ready') throw new Error('unreachable')
      expect(fixed.document.pendingParseError).toBeNull()
      expect(fixed.document.complete).toBe(true)
      expect(new TextDecoder().decode(fixed.document.sourceBuffer.bytes)).toBe('{"a":1}')
    })

    it('re-resolves selection via the caret offset after a successful reparse (F3\u2019s minimal step of F5\u2019s cascade)', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi(),
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')
      session.setCaretOffset(5) // inside the value "1"

      session.applyEdit({ start: 5, end: 6, text: '99' }) // '{"a":1}' -> '{"a":99}'
      await flushReparse(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.complete).toBe(true)
      expect(state.document.store.nodeCount).toBeGreaterThan(0)
      // A node was (re-)selected in the *new* store — not left pointing at
      // a ref from the store that no longer exists.
      expect(state.selection.selectedNode).not.toBe(NO_SELECTION)
      expect(state.selection.selectedNode).toBeLessThan(state.document.store.nodeCount)
    })

    it('a document already broken at open always accepts the next reparse — no "better broken tree" to prefer', async () => {
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: 100, readOnly: false }),
        read: vi.fn().mockResolvedValue(utf8('{"a":')) // truncated — already incomplete at open
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/broken.json')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      expect(before.document.complete).toBe(false)
      const firstBrokenStore = before.document.store

      // Edit it into a *different* still-malformed shape.
      session.applyEdit({ start: 5, end: 5, text: '1,"b":' })
      await flushReparse(session)

      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.complete).toBe(false)
      // Accepted, not retained: an already-broken document has no prior
      // "known-good" tree for retention to fall back to, so every reparse
      // — better or worse — replaces the last one.
      expect(after.document.store).not.toBe(firstBrokenStore)
      expect(after.document.pendingParseError).toBeNull()
    })

    it("surfaces a reparse's own rejection (not just AbortError) via pendingParseError", async () => {
      // M5-PLAN.md H12: the initial open goes through `parseFromUrl`, not
      // `parse` — `parse` is only ever called for a full reparse, so
      // rejecting unconditionally is enough to simulate "the worker
      // crashed" for the specific reparse this test triggers below,
      // without needing to count calls to tell open and reparse apart
      // the way this test used to.
      const flakyParse: typeof fakeParse = () => Promise.reject(new Error('worker crashed'))
      const session = createDocumentSession({
        parse: flakyParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi(),
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')
      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      const goodStore = before.document.store

      // F10/D-036: a plain value edit now splices instead of reaching the
      // worker at all — this test is specifically about the worker
      // rejecting, so the edit needs to break well-formedness first
      // (spliceSubtree's own 'malformed' refusal, already covered by
      // test/subtreeSplice.test.ts), forcing the fall-through to the full
      // reparse path this flaky fake is standing in for.
      session.applyEdit({ start: 6, end: 7, text: '' }) // '{"a":1}' -> '{"a":1'
      await flushReparse(session)

      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.pendingParseError).toBe('worker crashed')
      // The pipeline failing outright is not a malformed-document result —
      // there is nothing to accept-or-retain, so the last-good tree simply
      // stays exactly as it was.
      expect(after.document.store).toBe(goodStore)
    })

    it('a reparse superseded by opening a different document never runs at all', async () => {
      // M5-PLAN.md H12: opening a document goes through `parseFromUrl`
      // (the token-mint + worker-fetch route), not `parse` — `parse` is
      // only ever called for a *full* reparse of the live, in-memory
      // buffer. The edit below on `{"a":1}` is splice-eligible (H2b/H2d),
      // so it was never going to call `parse` either; this test's own
      // point is that a still-pending *full* reparse (if one were
      // scheduled) must not survive a document switch — asserted by
      // `parseCalls` staying 0 throughout, since nothing here ever
      // triggers one.
      let parseCalls = 0
      const countingParse: typeof fakeParse = (bytes, options) => {
        parseCalls++
        return fakeParse(bytes, options)
      }
      let parseFromUrlCalls = 0
      const countingParseFromUrl: typeof fakeParseFromUrl = (url, options) => {
        parseFromUrlCalls++
        return fakeParseFromUrl(url, options)
      }
      const session = createDocumentSession({
        parse: countingParse,
        parseFromUrl: countingParseFromUrl,
        api: fakeApi(),
        reparseDelayMs: 30
      })
      await session.openPath('C:/docs/data.json')
      session.applyEdit({ start: 5, end: 6, text: '2' }) // schedules a reparse (30ms)
      parseCalls = 0 // only count what happens after this point
      parseFromUrlCalls = 0

      // Opens a second document well before the pending reparse's 30ms
      // timer would fire — openPath cancels the scheduler synchronously,
      // before its own await, so the stale reparse should never even start.
      await session.openPath('C:/docs/other.json')
      expect(parseFromUrlCalls).toBe(1) // just the second document's own open
      expect(parseCalls).toBe(0) // no full reparse ever ran for either document

      await new Promise((resolve) => setTimeout(resolve, 50)) // past the original 30ms window
      expect(parseFromUrlCalls).toBe(1)
      expect(parseCalls).toBe(0) // still none — the stale reparse never ran

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.fileName).toBe('other.json')
    })
  })

  describe('incremental reparse via subtree splicing (F10/D-036)', () => {
    it('a plain value edit reparses via splice, never reaching the worker', async () => {
      let parseCalls = 0
      const countingParse: typeof fakeParse = (bytes, options) => {
        parseCalls++
        return fakeParse(bytes, options)
      }
      const session = createDocumentSession({
        parse: countingParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi(),
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json') // '{"a":1}'
      parseCalls = 0

      session.applyEdit({ start: 5, end: 6, text: '99' }) // '{"a":1}' -> '{"a":99}'
      await flushReparse(session)

      expect(parseCalls).toBe(0)
      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":99}')
      expect(state.document.complete).toBe(true)
    })

    it('produces a store structurally identical to what a full reparse of the same bytes would', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":{"b":1,"c":2},"d":3}')) }),
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')

      session.applyEdit({ start: 22, end: 23, text: '99' }) // "d":3 -> "d":99
      await flushReparse(session)

      const spliced = session.getSnapshot()
      if (spliced.phase !== 'ready') throw new Error('unreachable')
      const splicedBytes = spliced.document.sourceBuffer.bytes

      const fresh = await fakeParse(
        splicedBytes.buffer.slice(
          splicedBytes.byteOffset,
          splicedBytes.byteOffset + splicedBytes.byteLength
        ) as ArrayBuffer,
        { filename: 'data.json' }
      )

      function flatten(store: typeof fresh.store, node: number): unknown[] {
        const result: unknown[] = []
        const stack = [node]
        while (stack.length > 0) {
          const n = stack.pop()!
          const span = store.spanOf(n)
          result.push({
            kind: store.kindOf(n),
            name: store.nameOf(n),
            spanStart: span.start,
            spanEnd: span.end,
            childCount: [...store.childrenOf(n)].length
          })
          for (const child of [...store.childrenOf(n)].reverse()) stack.push(child)
        }
        return result
      }

      expect(flatten(spliced.document.store, 0)).toEqual(flatten(fresh.store, 0))
    })

    it('falls back to a full reparse when the edit breaks well-formedness', async () => {
      let parseCalls = 0
      const countingParse: typeof fakeParse = (bytes, options) => {
        parseCalls++
        return fakeParse(bytes, options)
      }
      const session = createDocumentSession({
        parse: countingParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi(),
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json') // '{"a":1}'
      parseCalls = 0

      session.applyEdit({ start: 6, end: 7, text: '' }) // '{"a":1}' -> '{"a":1'
      await flushReparse(session)

      expect(parseCalls).toBe(1) // the splice attempt refused; the full path ran once
      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.pendingParseError).not.toBeNull()
    })

    it('undo always uses a full reparse, never a stale or mistargeted splice', async () => {
      let parseCalls = 0
      const countingParse: typeof fakeParse = (bytes, options) => {
        parseCalls++
        return fakeParse(bytes, options)
      }
      const session = createDocumentSession({
        parse: countingParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi(),
        reparseDelayMs: 5,
        undoDelayMs: 5
      })
      await session.openPath('C:/docs/data.json') // '{"a":1}'
      session.applyEdit({ start: 5, end: 6, text: '9' }) // splices — parseCalls stays 0
      await flushReparse(session)
      parseCalls = 0

      session.undo()
      await flushReparse(session)

      expect(parseCalls).toBe(1)
      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":1}')
    })

    it('a burst with edits in reverse document order (a later position first) still splices to the correct result', async () => {
      let parseCalls = 0
      const countingParse: typeof fakeParse = (bytes, options) => {
        parseCalls++
        return fakeParse(bytes, options)
      }
      const session = createDocumentSession({
        parse: countingParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":11111,"b":22222}')) }),
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')
      parseCalls = 0

      // "b"'s value edited first (the later position in the document),
      // then "a"'s (the earlier one) — the reverse of the common
      // sequential-typing order, exercising recordEditForSplice's
      // "entirely before the tracked region" case.
      session.applyEdit({ start: 15, end: 20, text: '9' }) // "b":22222 -> "b":9
      session.applyEdit({ start: 5, end: 10, text: '8' }) // "a":11111 -> "a":8
      await flushReparse(session)

      expect(parseCalls).toBe(0) // still handled entirely via splice
      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":8,"b":9}')
      expect(state.document.complete).toBe(true)
    })

    // M5-PLAN.md H2b's own risk: `recordEditForSplice`'s translation
    // arithmetic (not `incrementalRowIndex` itself, already unit-tested in
    // rowIndex.test.ts) is what a multi-edit burst actually exercises —
    // the row index after a burst must still match a full rebuild of the
    // final bytes, not just the bytes themselves.
    it('the row index after a multi-edit burst matches a full rebuild of the final bytes', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":11111,"b":22222,"c":33333}')) }),
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')

      session.applyEdit({ start: 25, end: 30, text: '9' }) // "c":33333 -> "c":9  (later position first)
      session.applyEdit({ start: 15, end: 20, text: '8' }) // "b":22222 -> "b":8
      session.applyEdit({ start: 5, end: 10, text: '7' }) // "a":11111 -> "a":7 (earliest, last)
      await new Promise((resolve) => setTimeout(resolve, 20))

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      const bytes = state.document.sourceBuffer.bytes
      expect(new TextDecoder().decode(bytes)).toBe('{"a":7,"b":8,"c":9}')

      const expectedRowIndex = buildRowIndex(
        bytes,
        DEFAULT_MAX_ROW_BYTES,
        jsonFormatModule.capabilities.rowBreakBytes
      )
      expect(Array.from(state.document.rowIndex)).toEqual(Array.from(expectedRowIndex))
    })

    // M5-PLAN.md H2d's own acceptance criterion: "a splice superseded
    // mid-graft leaves the previous store intact and visible." Needs fake
    // timers to land reliably — the graft's own `runChunkedJob` yields via
    // a real `setTimeout(0)`, and a tiny test document finishes its first
    // (only) slice almost instantly, leaving no reliable window to
    // interleave a supersede with real timers.
    it('a splice superseded mid-graft (by opening a different document) never lands', async () => {
      vi.useFakeTimers()
      try {
        const session = createDocumentSession({
          parse: fakeParse,
          parseFromUrl: fakeParseFromUrl,
          api: fakeApi({
            read: vi
              .fn()
              .mockResolvedValueOnce(utf8('{"a":1}'))
              .mockResolvedValueOnce(utf8('{"other":true}'))
          }),
          reparseDelayMs: 5
        })
        await session.openPath('C:/docs/data.json')
        session.applyEdit({ start: 5, end: 6, text: '99' })

        // Let the debounce fire — `runReparse` starts, the decide phase
        // runs synchronously, and `graftChunked` schedules its first slice
        // via `setTimeout(0)` without having run it yet.
        await vi.advanceTimersByTimeAsync(5)

        // Supersede before that first slice ever runs — `openPath`'s reset
        // block calls `spliceJobSlot.cancel()` synchronously.
        const openPromise = session.openPath('C:/docs/other.json')
        await vi.advanceTimersByTimeAsync(0)
        await openPromise

        const state = session.getSnapshot()
        if (state.phase !== 'ready') throw new Error('unreachable')
        expect(state.document.fileName).toBe('other.json')
        expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"other":true}')

        // Let any leftover cancelled-job timers run out harmlessly — must
        // not throw, must not resurrect the old document.
        await vi.runAllTimersAsync()
        const finalState = session.getSnapshot()
        if (finalState.phase !== 'ready') throw new Error('unreachable')
        expect(finalState.document.fileName).toBe('other.json')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // A UTF-16 document is refused at offset 0 (the worker's
  // `klados.encoding.unsupported`), so it reaches 'ready' with an empty
  // store. Defaulting `selectedNode` to 0 there handed every consumer a ref
  // to a node that does not exist — and `[...store.childrenOf(0)]`, which is
  // what a tree view does, then walked undefined links until the heap gave
  // out rather than yielding nothing.
  it('a document that parses to zero nodes has no selection, not node 0', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x61, 0x00, 0x2f, 0x00, 0x3e, 0x00])
    const api = fakeApi({
      stat: vi.fn().mockResolvedValue({ size: utf16.length, readOnly: false }),
      read: vi.fn().mockResolvedValue(utf16.slice().buffer as ArrayBuffer)
    })
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })

    await session.openPath('C:/docs/utf16.xml')
    const state = session.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')

    expect(state.document.store.nodeCount).toBe(0)
    expect(state.selection.selectedNode).toBe(NO_SELECTION)
    expect(getContext().hasSelection).toBe(false)
    expect([...state.document.store.childrenOf(state.selection.selectedNode)]).toEqual([])
  })

  it('hasSelection tracks a real selection and clears when the document goes away', async () => {
    const session = createSession()
    expect(getContext().hasSelection).toBe(false)

    await session.openPath('C:/docs/data.json')
    expect(getContext().hasSelection).toBe(true)

    session.setSelectedNode(NO_SELECTION)
    expect(getContext().hasSelection).toBe(false)
  })

  // Superseding an in-flight parse must not surface the aborted one's own
  // transition to 'empty' — the abort rejects on a microtask while the new
  // open is still awaiting `stat`, so it would otherwise be observable as a
  // flash of the no-document state for the width of that IPC call.
  it('opening while a parse is in flight never passes through the empty phase', async () => {
    let parseCall = 0
    // The first open's read+parse hangs until aborted, then rejects with
    // AbortError — exactly what `parseFromUrlInWorker` does when its
    // signal fires. Overrides `parseFromUrl` (M5-PLAN.md H12's mint+fetch
    // route), not `parse` — the disk-read step this test is actually
    // exercising cancellation timing for.
    const parseFromUrl = (url: string, options: ParseClientOptions): Promise<ParseClientResult> => {
      parseCall++
      if (parseCall > 1) return fakeParseFromUrl(url, options)
      return new Promise<ParseClientResult>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () =>
          reject(new DOMException('Parse aborted', 'AbortError'))
        )
      })
    }
    const session = createDocumentSession({ parse: fakeParse, parseFromUrl, api: fakeApi() })

    const phases: string[] = []
    session.subscribe(() => phases.push(session.getSnapshot().phase))

    const first = session.openPath('C:/docs/data.json')
    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe('parsing'))

    const second = session.openPath('C:/docs/other.json')
    await Promise.all([first, second])

    expect(phases).not.toContain('empty')
    expect(session.getSnapshot().phase).toBe('ready')
  })

  it('subscribers are notified on every phase transition and unsubscribe stops delivery', async () => {
    const session = createSession()
    const listener = vi.fn()
    const unsubscribe = session.subscribe(listener)

    await session.openPath('C:/docs/data.json')
    expect(listener).toHaveBeenCalled()

    unsubscribe()
    listener.mockClear()
    session.setSelectedNode(1)
    expect(listener).not.toHaveBeenCalled()
  })

  it('opening a second document while one is ready replaces it (no tabs in M1)', async () => {
    const session = createSession()
    await session.openPath('C:/docs/data.json')
    const first = session.getSnapshot()
    if (first.phase !== 'ready') throw new Error('unreachable')
    expect(first.document.fileName).toBe('data.json')

    await session.openPath('C:/docs/other.json')
    const second = session.getSnapshot()
    if (second.phase !== 'ready') throw new Error('unreachable')
    expect(second.document.fileName).toBe('other.json')
  })

  describe('undo/redo (F6)', () => {
    /** Same reasoning as `flushReparse` above, but also long enough for the
     * (separately debounced) undo-burst timer plus the immediate reparse
     * `undo`/`redo` themselves trigger. */
    /**
     * R154 (`docs/plans/R151-ci-matrix.md` §4a): delegates to the
     * quiescence-based `flushReparse` above instead of sleeping 30 ms.
     *
     * The release round replaced this file's *other* fixed-sleep helper after
     * one broke a release build, and left this one — a third helper, scoped to
     * this describe block — untouched, so 44 call sites kept waiting a fixed
     * 30 ms for a 5 ms undo debounce plus a 5 ms reparse debounce plus the
     * work itself. It failed under full-suite load on
     * "a restore-triggered reparse that comes back incomplete does not leak
     * its restore request into a later, unrelated edit".
     *
     * Fourth instance of this defect in the project, and the second in this
     * file.
     */
    async function flush(session: { getSnapshot: () => unknown }): Promise<void> {
      await flushReparse(session)
    }

    it('type, undo, redo returns byte-identical text and the same selection', async () => {
      const session = createSession({ reparseDelayMs: 5, undoDelayMs: 5 })
      await session.openPath('C:/docs/data.json') // '{"a":1}'

      const ready = session.getSnapshot()
      if (ready.phase !== 'ready') throw new Error('unreachable')
      const propertyA = [
        ...ready.document.store.childrenOf(ready.document.store.firstChildOf(0))
      ][0]!
      session.setSelectedNode(propertyA)
      session.setCaretOffset(5)

      session.applyEdit({ start: 5, end: 6, text: '99' }) // '{"a":1}' -> '{"a":99}'
      session.setCaretOffset(7) // where the editor would leave the caret after typing "99"
      await flush(session)

      const edited = session.getSnapshot()
      if (edited.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(edited.document.sourceBuffer.bytes)).toBe('{"a":99}')
      expect(edited.document.store.nameOf(edited.selection.selectedNode)).toBe('a')
      expect(edited.selection.caretOffset).toBe(7)

      session.undo()
      await flush(session)
      const undone = session.getSnapshot()
      if (undone.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(undone.document.sourceBuffer.bytes)).toBe('{"a":1}')
      expect(undone.document.store.nameOf(undone.selection.selectedNode)).toBe('a')
      expect(undone.selection.caretOffset).toBe(5)

      session.redo()
      await flush(session)
      const redone = session.getSnapshot()
      if (redone.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(redone.document.sourceBuffer.bytes)).toBe('{"a":99}')
      expect(redone.document.store.nameOf(redone.selection.selectedNode)).toBe('a')
      expect(redone.selection.caretOffset).toBe(7)
    })

    it('a burst of many edits is one undo entry', async () => {
      const session = createSession({ reparseDelayMs: 5, undoDelayMs: 20 })
      await session.openPath('C:/docs/data.json') // '{"a":1}'

      // Three edits close together, each restarting the undo-burst debounce.
      session.applyEdit({ start: 5, end: 6, text: '2' })
      session.applyEdit({ start: 5, end: 6, text: '3' })
      session.applyEdit({ start: 5, end: 6, text: '4' })
      await flush(session)

      const beforeUndo = session.getSnapshot()
      if (beforeUndo.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(beforeUndo.document.sourceBuffer.bytes)).toBe('{"a":4}')

      session.undo()
      await flush(session)
      const afterUndo = session.getSnapshot()
      if (afterUndo.phase !== 'ready') throw new Error('unreachable')
      // One undo unwinds the whole burst back to the original text — not
      // just the last of the three edits.
      expect(new TextDecoder().decode(afterUndo.document.sourceBuffer.bytes)).toBe('{"a":1}')
    })

    it('undo is a no-op with nothing to undo', async () => {
      const session = createSession({ reparseDelayMs: 5, undoDelayMs: 5 })
      await session.openPath('C:/docs/data.json')
      const before = session.getSnapshot()
      session.undo()
      expect(session.getSnapshot()).toBe(before)
    })

    it('redo is a no-op with nothing to redo', async () => {
      const session = createSession({ reparseDelayMs: 5, undoDelayMs: 5 })
      await session.openPath('C:/docs/data.json')
      const before = session.getSnapshot()
      session.redo()
      expect(session.getSnapshot()).toBe(before)
    })

    it('undo/redo do not throw on a read-only document', async () => {
      const api = fakeApi({ stat: vi.fn().mockResolvedValue({ size: 100, readOnly: true }) })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5,
        undoDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')
      // applyEdit itself refuses on a read-only document (F1), so there is
      // nothing to undo in the first place — this only confirms undo/redo
      // degrade gracefully rather than assuming a mutable document.
      expect(() => session.undo()).not.toThrow()
      expect(() => session.redo()).not.toThrow()
    })

    it('canUndo/canRedo context keys track the stack', async () => {
      const session = createSession({ reparseDelayMs: 5, undoDelayMs: 5 })
      await session.openPath('C:/docs/data.json')
      expect(getContext().canUndo).toBe(false)
      expect(getContext().canRedo).toBe(false)

      session.applyEdit({ start: 5, end: 6, text: '2' })
      await flush(session)
      expect(getContext().canUndo).toBe(true)
      expect(getContext().canRedo).toBe(false)

      session.undo()
      await flush(session)
      expect(getContext().canUndo).toBe(false)
      expect(getContext().canRedo).toBe(true)
    })

    it('opening a different document clears the undo stack', async () => {
      const session = createSession({ reparseDelayMs: 5, undoDelayMs: 5 })
      await session.openPath('C:/docs/data.json')
      session.applyEdit({ start: 5, end: 6, text: '2' })
      await flush(session)
      expect(getContext().canUndo).toBe(true)

      await session.openPath('C:/docs/other.json')
      expect(getContext().canUndo).toBe(false)

      // The stale entry, which still referenced the previous document's
      // bytes, must not get applied to the new one.
      session.undo()
      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.fileName).toBe('other.json')
    })

    it('a restore-triggered reparse that comes back incomplete does not leak its restore request into a later, unrelated edit', async () => {
      const session = createSession({ reparseDelayMs: 5, undoDelayMs: 5 })
      await session.openPath('C:/docs/data.json') // '{"a":1}', complete

      const ready = session.getSnapshot()
      if (ready.phase !== 'ready') throw new Error('unreachable')
      const propertyA = [
        ...ready.document.store.childrenOf(ready.document.store.firstChildOf(0))
      ][0]!
      session.setSelectedNode(propertyA)
      session.setCaretOffset(5)

      // One entry whose forward patch *breaks* the document (removing the
      // closing brace) and whose inverse repairs it.
      session.applyEdit({ start: 6, end: 7, text: '' }) // '{"a":1}' -> '{"a":1'
      await flush(session)

      // undo (repairs it — complete) then redo (re-breaks it — incomplete)
      // is what gets a *restore-triggered* reparse to land on the
      // early-return branch: redo's own forced reparse sets
      // `pendingSelectionRestore` right before producing an incomplete
      // result, which is exactly the leak scenario.
      session.undo()
      await flush(session)
      session.redo()
      await flush(session)

      const broken = session.getSnapshot()
      if (broken.phase !== 'ready') throw new Error('unreachable')
      expect(broken.document.pendingParseError).not.toBeNull()

      // A later, ordinary edit — unrelated to the undo/redo pair above —
      // repairs the document again, with the selection deliberately reset
      // to the same node beforehand. Its own structural identity never
      // changed (still the sole property, still named "a"), so a correct
      // resolution is silent and must not request a Tree reveal. If the
      // restore request leaked, this reparse would incorrectly treat
      // itself as a restore and force one regardless.
      session.setSelectedNode(propertyA)
      session.setCaretOffset(6)
      session.applyEdit({ start: 6, end: 6, text: '}' }) // '{"a":1' -> '{"a":1}'
      await flush(session)

      const refixed = session.getSnapshot()
      if (refixed.phase !== 'ready') throw new Error('unreachable')
      expect(refixed.document.complete).toBe(true)
      expect(consumePendingReveal(refixed.document.store)).toBeNull()
    })

    // M5f-PLAN.md §3a: clearUndoHistory frees the stack without touching
    // the document, and re-runs syncUndoContext so canUndo/canRedo (and
    // the memory total) reflect it immediately.
    it('clearUndoHistory empties the stack and updates canUndo/undoBytes', async () => {
      const session = createSession({ reparseDelayMs: 5, undoDelayMs: 5 })
      await session.openPath('C:/docs/data.json') // '{"a":1}'
      session.applyEdit({ start: 5, end: 6, text: '2' })
      await flush(session)

      const beforeClear = session.getSnapshot()
      if (beforeClear.phase !== 'ready') throw new Error('unreachable')
      expect(beforeClear.document.undoEntryCount).toBeGreaterThan(0)
      expect(getContext().canUndo).toBe(true)

      session.clearUndoHistory()

      const afterClear = session.getSnapshot()
      if (afterClear.phase !== 'ready') throw new Error('unreachable')
      expect(afterClear.document.undoEntryCount).toBe(0)
      expect(afterClear.document.undoBytes).toBe(0)
      expect(getContext().canUndo).toBe(false)
      // The document itself is untouched — only reversibility was lost.
      expect(new TextDecoder().decode(afterClear.document.sourceBuffer.bytes)).toBe('{"a":2}')

      // Undo is now genuinely a no-op.
      session.undo()
      await flush(session)
      const afterUndo = session.getSnapshot()
      if (afterUndo.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(afterUndo.document.sourceBuffer.bytes)).toBe('{"a":2}')
    })

    it('clearUndoHistory is a no-op with no document open', () => {
      const session = createSession()
      expect(() => session.clearUndoHistory()).not.toThrow()
    })
  })

  describe('save/saveAs (F7)', () => {
    const UTF8_BOM = [0xef, 0xbb, 0xbf]
    const UTF16LE_BOM = [0xff, 0xfe]

    function withUtf8Bom(bytes: Uint8Array): Uint8Array {
      const out = new Uint8Array(UTF8_BOM.length + bytes.length)
      out.set(UTF8_BOM, 0)
      out.set(bytes, UTF8_BOM.length)
      return out
    }

    function utf16le(s: string): Uint8Array {
      const out = new Uint8Array(UTF16LE_BOM.length + s.length * 2)
      out.set(UTF16LE_BOM, 0)
      const view = new DataView(out.buffer)
      for (let i = 0; i < s.length; i++) {
        view.setUint16(UTF16LE_BOM.length + i * 2, s.charCodeAt(i), true)
      }
      return out
    }

    /** §11.6's own words: "the single most valuable test in the project."
     * For each variant, parse then save with no edit — the written bytes
     * must be byte-identical to what was read, regardless of encoding,
     * BOM, or line ending. */
    const variants: { readonly name: string; readonly path: string; readonly bytes: Uint8Array }[] =
      [
        {
          name: 'plain UTF-8 JSON',
          path: 'C:/docs/a.json',
          bytes: new TextEncoder().encode('{"a":1}')
        },
        {
          name: 'plain UTF-8 XML',
          path: 'C:/docs/a.xml',
          bytes: new TextEncoder().encode('<root><a>1</a></root>')
        },
        {
          name: 'UTF-8 with BOM, XML',
          path: 'C:/docs/bom.xml',
          bytes: withUtf8Bom(new TextEncoder().encode('<root><a>1</a></root>'))
        },
        {
          name: 'UTF-8 with BOM, JSON',
          path: 'C:/docs/bom.json',
          bytes: withUtf8Bom(new TextEncoder().encode('{"a":1}'))
        },
        { name: 'UTF-16LE with BOM, JSON', path: 'C:/docs/u16.json', bytes: utf16le('{"a":1}') },
        {
          name: 'CRLF line endings, XML',
          path: 'C:/docs/crlf.xml',
          bytes: new TextEncoder().encode('<root>\r\n  <a>1</a>\r\n</root>')
        }
      ]

    for (const variant of variants) {
      it(`round-trips byte-identically with no edit: ${variant.name}`, async () => {
        let written: ArrayBuffer | null = null
        const api = fakeApi({
          stat: vi.fn().mockResolvedValue({ size: variant.bytes.length, readOnly: false }),
          read: vi.fn().mockResolvedValue(variant.bytes.buffer as ArrayBuffer),
          write: vi.fn().mockImplementation(async (_path: string, bytes: ArrayBuffer) => {
            written = bytes
          })
        })
        const session = createDocumentSession({
          parse: fakeParse,
          parseFromUrl: fakeParseFromUrl,
          api
        })
        await session.openPath(variant.path)
        expect(session.getSnapshot().phase).toBe('ready')

        const outcome = await session.save()

        expect(outcome).toEqual({ ok: true })
        expect(written).not.toBeNull()
        expect(new Uint8Array(written!)).toEqual(variant.bytes)
      })
    }

    it('saves the edited bytes, not the originally-opened ones', async () => {
      let written: ArrayBuffer | null = null
      const api = fakeApi({
        write: vi.fn().mockImplementation(async (_path: string, bytes: ArrayBuffer) => {
          written = bytes
        })
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json') // '{"a":1}'
      session.applyEdit({ start: 5, end: 6, text: '99' })

      const outcome = await session.save()

      expect(outcome).toEqual({ ok: true })
      expect(new TextDecoder().decode(written!)).toBe('{"a":99}')
    })

    it('clears the dirty flag on a successful save', async () => {
      const api = fakeApi()
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')
      session.applyEdit({ start: 5, end: 6, text: '2' })

      const dirty = session.getSnapshot()
      if (dirty.phase !== 'ready') throw new Error('unreachable')
      expect(dirty.document.dirty).toBe(true)
      expect(getContext().isDirty).toBe(true)

      await session.save()

      const clean = session.getSnapshot()
      if (clean.phase !== 'ready') throw new Error('unreachable')
      expect(clean.document.dirty).toBe(false)
      expect(getContext().isDirty).toBe(false)
    })

    it('refuses to save a read-only document', async () => {
      const api = fakeApi({ stat: vi.fn().mockResolvedValue({ size: 100, readOnly: true }) })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/data.json')

      const outcome = await session.save()

      expect(outcome).toEqual({ ok: false, message: 'This file is read-only.' })
    })

    it('does not clear dirty if a newer edit lands while an earlier save is still writing', async () => {
      let resolveWrite: (() => void) | null = null
      const api = fakeApi({
        write: vi.fn().mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              resolveWrite = resolve
            })
        )
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json') // '{"a":1}'
      session.applyEdit({ start: 5, end: 6, text: '2' }) // dirty, sourceBuffer #1

      const savePromise = session.save() // captures sourceBuffer #1's bytes; write() gated

      // A newer edit to the same document lands while the save is still
      // in flight — the bytes eventually written are the pre-edit ones.
      session.applyEdit({ start: 5, end: 6, text: '3' })

      resolveWrite!()
      const outcome = await savePromise

      expect(outcome).toEqual({ ok: true })
      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      // Must NOT be cleared — the newer edit is still unsaved even though
      // the earlier save "succeeded".
      expect(state.document.dirty).toBe(true)
    })

    it('does not stamp a different document with a path chosen while its own Save As dialog was still open', async () => {
      let resolveDialog: ((value: { path: string; fileName: string } | null) => void) | null = null
      const api = fakeApi({
        saveAsDialog: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveDialog = resolve
            })
        )
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/data.json') // document A

      const saveAsPromise = session.saveAs() // dialog gated, still "open" for A

      await session.openPath('C:/docs/other.json') // switches to document B mid-dialog

      resolveDialog!({ path: 'C:/docs/a-renamed.json', fileName: 'a-renamed.json' })
      const outcome = await saveAsPromise

      expect(outcome.ok).toBe(false)
      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      // B's own identity must be untouched — not silently redirected to
      // the path A's dialog resolved with.
      expect(state.document.fileName).toBe('other.json')
      expect(state.document.filePath).toBe('C:/docs/other.json')
    })

    it('save() with no document open refuses cleanly', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi()
      })
      const outcome = await session.save()
      expect(outcome).toEqual({ ok: false, message: 'No document is open.' })
    })

    it('saveAs writes to the chosen path and updates filePath/fileName', async () => {
      let written: { path: string; bytes: ArrayBuffer } | null = null
      const api = fakeApi({
        saveAsDialog: vi
          .fn()
          .mockResolvedValue({ path: 'C:/docs/renamed.json', fileName: 'renamed.json' }),
        write: vi.fn().mockImplementation(async (path: string, bytes: ArrayBuffer) => {
          written = { path, bytes }
        })
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/data.json')

      const outcome = await session.saveAs()

      expect(outcome).toEqual({ ok: true })
      expect(written).not.toBeNull()
      expect(written!.path).toBe('C:/docs/renamed.json')

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.filePath).toBe('C:/docs/renamed.json')
      expect(state.document.fileName).toBe('renamed.json')
      expect(state.document.dirty).toBe(false)
    })

    it('saveAs on a read-only document succeeds and clears readOnly', async () => {
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: 100, readOnly: true }),
        saveAsDialog: vi
          .fn()
          .mockResolvedValue({ path: 'C:/docs/copy.json', fileName: 'copy.json' })
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/data.json')
      const opened = session.getSnapshot()
      if (opened.phase !== 'ready') throw new Error('unreachable')
      expect(opened.document.readOnly).toBe(true)

      const outcome = await session.saveAs()

      expect(outcome).toEqual({ ok: true })
      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.readOnly).toBe(false)
      expect(getContext().isReadOnly).toBe(false)
    })

    it('cancelling the Save As dialog is not a failure and writes nothing', async () => {
      const write = vi.fn()
      const api = fakeApi({ saveAsDialog: vi.fn().mockResolvedValue(null), write })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/data.json')

      const outcome = await session.saveAs()

      expect(outcome).toEqual({ ok: true, cancelled: true })
      expect(write).not.toHaveBeenCalled()
    })
  })

  describe('Transforms — Format/Minify Document (M5-PLAN.md H4/H5/H7)', () => {
    async function flush(session: { getSnapshot: () => unknown }): Promise<void> {
      // R154: delegates to the quiescence-based `flushReparse` at the top of
      // this file. See the copy in `undo/redo (F6)` for the full account —
      // this file had *five* of these, one per describe block, and the release
      // round replaced only one of them.
      await flushReparse(session)
    }

    it('format runs immediately on a small document, reparses, and pushes exactly one undo entry', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":1,"b":2}')) })
      })
      await session.openPath('C:/docs/data.json')

      session.requestTransform('format')
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe(
        '{\n  "a": 1,\n  "b": 2\n}\n'
      )
      expect(state.document.complete).toBe(true)
      expect(state.document.pendingTransform).toBeNull()

      // Proves an undo entry exists (rather than reading `getContext()`,
      // a module-level singleton shared across every session in this
      // file — a still-settling async chain from an unrelated, earlier
      // test can race a read of it, per the "read-only document" test's
      // own note below) by actually undoing and checking the result.
      session.undo()
      await flush(session)
      const undone = session.getSnapshot()
      if (undone.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(undone.document.sourceBuffer.bytes)).toBe('{"a":1,"b":2}')
    })

    // M5f-PLAN.md §7's own regression guard: the whole point of §3a is that
    // `computeMemoryBudget`'s total was *wrong* before it counted the undo
    // stack — a test that only checks the row renders would miss that
    // regression coming back. A Format's undo entry holds the old document
    // as `inverses[0].replacement` and the new one as `patches[0].replacement`
    // (`applyTransform`'s own doc comment: "a full copy of the old document
    // and a full copy of the new one"), so the total should grow by roughly
    // the sum of both — not quite exactly 2x the pre-Format size, since the
    // formatted output is somewhat larger than the minified input.
    it('the memory total includes undo history after a Format (M5f-PLAN.md §3a)', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":1,"b":2}')) })
      })
      await session.openPath('C:/docs/data.json')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      const budgetBefore = computeMemoryBudget(before.document)
      expect(budgetBefore.undoBytes).toBe(0)
      expect(budgetBefore.undoEntryCount).toBe(0)

      session.requestTransform('format')
      await flush(session)

      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      const budgetAfter = computeMemoryBudget(after.document)

      expect(budgetAfter.undoEntryCount).toBe(1)
      const oldSize = before.document.sourceBuffer.byteLength
      const newSize = after.document.sourceBuffer.byteLength
      // The undo entry retains both the pre- and post-Format buffers.
      expect(budgetAfter.undoBytes).toBe(oldSize + newSize)
      // The regression this guards: before §3a, `totalBytes` never
      // included `undoBytes` at all, so this would previously have held
      // even though real bytes were retained the total didn't count.
      expect(budgetAfter.totalBytes).toBeGreaterThanOrEqual(budgetAfter.undoBytes)
    })

    it('minify runs immediately and produces zero-whitespace output', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8('{ "a" : 1 }')) })
      })
      await session.openPath('C:/docs/data.json')

      session.requestTransform('minify')
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":1}')
    })

    it('is a no-op on a read-only document', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        api: fakeApi({
          stat: vi.fn().mockResolvedValue({ size: 100, readOnly: true }),
          read: vi.fn().mockResolvedValue(utf8('{"a":1}'))
        })
      })
      await session.openPath('C:/docs/data.json')

      session.requestTransform('format')
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":1}')
      // Not `getContext().canUndo` — `context.ts` is a module-level singleton
      // shared across every session in this file, so a still-settling async
      // chain from a *previous* test's own Transform can race a read of it
      // here. Bytes staying unchanged already proves nothing ran.
    })

    // M5e-PLAN.md R11 reopens D-045: XML now has a real `format()` and
    // `canFormat: true`, so this is no longer a no-op — it's the same
    // "Transform actually runs" shape the JSON case above already covers.
    it('formats an XML document (R11 reopens D-045)', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8('<a><b/></a>')) })
      })
      await session.openPath('C:/docs/data.xml')

      session.requestTransform('format')
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe(
        '<a>\n  <b/>\n</a>\n'
      )
    })

    // M5g-PLAN.md O1: `format()` on an already-canonical document returns
    // its input byte-identical — the reported sluggishness with "no visible
    // change to the document" was exactly this case. The regression guard
    // for O1: the no-op path must not swap the buffer, mark the document
    // dirty, push an undo entry, or trigger a reparse.
    it('a no-op Format does not touch the buffer, dirty flag, undo stack, or trigger a reparse', async () => {
      let parseCalls = 0
      const countingParse: typeof fakeParse = (bytes, options) => {
        parseCalls++
        return fakeParse(bytes, options)
      }
      const alreadyFormatted = '<a>\n  <b/>\n</a>\n'
      const session = createDocumentSession({
        parse: countingParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8(alreadyFormatted)) })
      })
      await session.openPath('C:/docs/data.xml')
      parseCalls = 0

      session.requestTransform('format')
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe(alreadyFormatted)
      expect(state.document.dirty).toBe(false)
      expect(state.document.lastTransformWasNoOp).toBe(true)
      expect(parseCalls).toBe(0)

      // No undo entry was pushed — undo is a no-op.
      session.undo()
      await flush(session)
      const afterUndo = session.getSnapshot()
      if (afterUndo.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(afterUndo.document.sourceBuffer.bytes)).toBe(alreadyFormatted)
    })

    it('a Transform triggers a full reparse, never a splice', async () => {
      let parseCalls = 0
      const countingParse: typeof fakeParse = (bytes, options) => {
        parseCalls++
        return fakeParse(bytes, options)
      }
      const session = createDocumentSession({
        parse: countingParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":1}')) })
      })
      await session.openPath('C:/docs/data.json')
      parseCalls = 0

      session.requestTransform('format')
      await flush(session)

      expect(parseCalls).toBe(1)
    })

    it('above the confirm threshold, sets pendingTransform instead of running immediately', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        transformConfirmBytes: 5,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":1,"b":2}')) })
      })
      await session.openPath('C:/docs/data.json')

      session.requestTransform('format')

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.pendingTransform).toEqual({
        kind: 'format',
        estimatedBytes: '{"a":1,"b":2}'.length
      })
      // Nothing ran yet.
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":1,"b":2}')
    })

    it('D-046: confirming a Transform above the confirm threshold runs it but does not push an undo entry', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        transformConfirmBytes: 5,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":1,"b":2}')) })
      })
      await session.openPath('C:/docs/data.json')
      session.requestTransform('format')

      session.confirmTransformAnyway()
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.pendingTransform).toBeNull()
      const formatted = '{\n  "a": 1,\n  "b": 2\n}\n'
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe(formatted)

      // D-046's whole point: the run happened, but it's not undoable — undo
      // is a no-op, proven directly rather than via `getContext()` (a
      // module-level singleton shared across every session in this file;
      // see the "read-only document" test's own note on why that's fragile
      // here).
      session.undo()
      await flush(session)
      const afterUndo = session.getSnapshot()
      if (afterUndo.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(afterUndo.document.sourceBuffer.bytes)).toBe(formatted)
    })

    it('cancelTransform dismisses a pending confirmation without running it', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        transformConfirmBytes: 5,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8('{"a":1,"b":2}')) })
      })
      await session.openPath('C:/docs/data.json')
      session.requestTransform('format')

      session.cancelTransform()
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.pendingTransform).toBeNull()
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":1,"b":2}')
    })

    it('dismissMinifiedBanner sets minifiedBannerDismissed and is a no-op with no document', () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi()
      })
      expect(() => session.dismissMinifiedBanner()).not.toThrow()
    })

    // A pre-transform size under the confirm threshold does not guarantee
    // the *result* stays under it — Format can grow a minified document
    // substantially (indentation, newlines). requestTransform only sees
    // the input size, so it runs immediately without asking; applyTransform
    // must re-check the actual output size before deciding to push an undo
    // entry, or a "small enough to skip confirmation" document could still
    // produce an oversized, silently-undoable entry — exactly the memory
    // problem D-046 exists to bound.
    it('does not push an undo entry when formatting grows the document past the confirm threshold, even though the input was small enough to run immediately', async () => {
      const original = '{"a":1}' // 7 bytes — under the threshold below
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        transformConfirmBytes: 10, // formatted output ('{\n  "a": 1\n}\n', 13 bytes) exceeds this
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8(original)) })
      })
      await session.openPath('C:/docs/data.json')

      session.requestTransform('format')
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      // It still ran — requestTransform never asked, since the *input* was
      // small enough.
      const formatted = new TextDecoder().decode(state.document.sourceBuffer.bytes)
      expect(formatted).toBe('{\n  "a": 1\n}\n')
      expect(formatted.length).toBeGreaterThan(10)

      // But it must not be undoable — the result grew past the threshold.
      session.undo()
      await flush(session)
      const afterUndo = session.getSnapshot()
      if (afterUndo.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(afterUndo.document.sourceBuffer.bytes)).toBe(formatted)
    })
  })

  describe('Replace All (R90)', () => {
    async function flush(session: { getSnapshot: () => unknown }): Promise<void> {
      // R154: delegates to the quiescence-based `flushReparse` at the top of
      // this file. See the copy in `undo/redo (F6)` for the full account —
      // this file had *five* of these, one per describe block, and the release
      // round replaced only one of them.
      await flushReparse(session)
    }

    it('refuses with no document open', () => {
      const session = createSession()
      const outcome = session.applyReplaceAll([{ start: 0, end: 3 }], 'x')
      expect(outcome).toEqual({
        ok: false,
        reason: { kind: 'not-ready' },
        message: 'No document is open.'
      })
    })

    it('refuses on a read-only document without touching the buffer', async () => {
      const content = '{"a":"cat"}'
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: content.length, readOnly: true }),
        read: vi.fn().mockResolvedValue(utf8(content))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/locked.json')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      const catStart = content.indexOf('cat')
      const outcome = session.applyReplaceAll([{ start: catStart, end: catStart + 3 }], 'dog')

      expect(outcome).toEqual({
        ok: false,
        reason: { kind: 'read-only' },
        message: 'This file is read-only.'
      })
      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.sourceBuffer).toBe(before.document.sourceBuffer)
    })

    it('refuses on a document in a genuinely multi-byte encoding with no encoder', async () => {
      const xml = '<?xml version="1.0" encoding="shift_jis"?><root>cat cat</root>'
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: xml.length, readOnly: false }),
        read: vi.fn().mockResolvedValue(utf8(xml))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/legacy.xml')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      expect(before.document.encoding).toBe('shift_jis')

      const outcome = session.applyReplaceAll([{ start: 0, end: 3 }], 'dog')
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.reason).toEqual({ kind: 'unsupported-encoding', encoding: 'shift_jis' })
    })

    it('applies a Replace All on a windows-1252 document, round-tripping through bytes (R125)', async () => {
      const xml = '<?xml version="1.0" encoding="windows-1252"?><root>cat cat</root>'
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: xml.length, readOnly: false }),
        read: vi.fn().mockResolvedValue(utf8(xml))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/legacy.xml')

      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')
      expect(before.document.encoding).toBe('windows-1252')

      const catOffsets: { start: number; end: number }[] = []
      let index = xml.indexOf('cat')
      while (index !== -1) {
        catOffsets.push({ start: index, end: index + 3 })
        index = xml.indexOf('cat', index + 1)
      }
      const outcome = session.applyReplaceAll(catOffsets, 'gatö')
      expect(outcome).toEqual({ ok: true, replacedCount: 2, undoable: true })

      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.encoding).toBe('windows-1252')
      expect(new TextDecoder('windows-1252').decode(after.document.sourceBuffer.bytes)).toBe(
        '<?xml version="1.0" encoding="windows-1252"?><root>gatö gatö</root>'
      )
    })

    it('refuses a Replace All whose replacement text has an unrepresentable character', async () => {
      const xml = '<?xml version="1.0" encoding="windows-1252"?><root>cat cat</root>'
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: xml.length, readOnly: false }),
        read: vi.fn().mockResolvedValue(utf8(xml))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api
      })
      await session.openPath('C:/docs/legacy.xml')

      const catStart = xml.indexOf('cat')
      const outcome = session.applyReplaceAll([{ start: catStart, end: catStart + 3 }], '日')
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.reason).toEqual({
        kind: 'unrepresentable-character',
        encoding: 'windows-1252',
        character: '日'
      })
      expect(outcome.message).toContain('日')
    })

    it('is a no-op success for an empty match list', async () => {
      const session = createSession()
      await session.openPath('C:/docs/data.json')
      const before = session.getSnapshot()
      if (before.phase !== 'ready') throw new Error('unreachable')

      const outcome = session.applyReplaceAll([], 'x')
      expect(outcome).toEqual({ ok: true, replacedCount: 0, undoable: true })
      const after = session.getSnapshot()
      if (after.phase !== 'ready') throw new Error('unreachable')
      expect(after.document.sourceBuffer).toBe(before.document.sourceBuffer)
    })

    // Every offset below is computed from the actual JSON string, not
    // hand-counted, since `{"value":"..."}` puts the searchable text after
    // a prefix whose exact length isn't the point of any of these tests.
    function allOffsets(haystack: string, needle: string): { start: number; end: number }[] {
      const result: { start: number; end: number }[] = []
      let from = 0
      for (;;) {
        const i = haystack.indexOf(needle, from)
        if (i === -1) return result
        result.push({ start: i, end: i + needle.length })
        from = i + needle.length
      }
    }

    it('replaces every match, reparses, and pushes exactly one undo entry', async () => {
      const content = '{"value":"cat and cat and cat"}'
      const api = fakeApi({ read: vi.fn().mockResolvedValue(utf8(content)) })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/cats.json')

      // "cat" appears three times, ascending — the shape `SearchResult.
      // starts` is always in.
      const outcome = session.applyReplaceAll(allOffsets(content, 'cat'), 'dog')
      expect(outcome).toEqual({ ok: true, replacedCount: 3, undoable: true })
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe(
        '{"value":"dog and dog and dog"}'
      )
      expect(state.document.dirty).toBe(true)

      session.undo()
      await flush(session)
      const undone = session.getSnapshot()
      if (undone.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(undone.document.sourceBuffer.bytes)).toBe(content)
    })

    it('is correct when the replacement text is a different length than every match (offsets would break if applied ascending)', async () => {
      const content = '{"value":"a-cat-b-cat-c-cat-d"}'
      const api = fakeApi({ read: vi.fn().mockResolvedValue(utf8(content)) })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/cats.json')

      // A longer replacement means applying ascending (without adjusting
      // later offsets) would splice the second and third replacements at
      // the wrong positions; back-to-front (R90's own rule) is what keeps
      // every match's original offset valid.
      const outcome = session.applyReplaceAll(allOffsets(content, 'cat'), 'elephant')
      expect(outcome.ok).toBe(true)
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe(
        '{"value":"a-elephant-b-elephant-c-elephant-d"}'
      )
    })

    it('drops the undo entry when it would exceed the memory budget, but still runs the replace', async () => {
      const content = '{"value":"cat"}'
      const api = fakeApi({
        stat: vi.fn().mockResolvedValue({ size: content.length, readOnly: false }),
        read: vi.fn().mockResolvedValue(utf8(content))
      })
      // The budget has to clear the *file's own* open-time estimate
      // (`ESTIMATED_MEMORY_MULTIPLIER` × its tiny byte size) or `openPath`
      // itself would land on `confirmSize` instead of `ready` — so this
      // isn't shrunk to next-to-nothing; the replacement text is grown
      // instead, past what the budget leaves for the undo entry once the
      // document's own footprint is already accounted for.
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5,
        totalMemoryBudgetBytes: 100
      })
      await session.openPath('C:/docs/cats.json')

      const longReplacement = 'x'.repeat(200)
      const outcome = session.applyReplaceAll(allOffsets(content, 'cat'), longReplacement)
      expect(outcome).toEqual({ ok: true, replacedCount: 1, undoable: false })
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe(
        `{"value":"${longReplacement}"}`
      )

      // Not undoable — same "prove it by undoing" approach the Transform
      // tests above use rather than reading the module-level context
      // singleton (this file's own note on why: a still-settling async
      // chain from an unrelated test can race a bare read of it).
      session.undo()
      await flush(session)
      const afterUndo = session.getSnapshot()
      if (afterUndo.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(afterUndo.document.sourceBuffer.bytes)).toBe(
        `{"value":"${longReplacement}"}`
      )
    })

    // R109 (`R108-replace-all-quadratic.md` §4): undo's own single-pass
    // path rebases sequentially-valid inverses into one shot valid against
    // the *current* buffer — verified here with a real replace-then-undo-
    // then-redo-then-undo round trip on a multi-match document, for both a
    // shrinking and a growing replacement, since a missing/wrong rebase
    // corrupts bytes silently on a growing replacement rather than
    // throwing (the plan's own §4 finding).
    it.each([
      ['shrinking', 'engine', 'eng'],
      ['growing', 'eng', 'engine']
    ] as const)(
      'replace-all → undo → redo → undo round-trips to the original bytes exactly (%s replacement)',
      async (_label, needle, replacementText) => {
        const content = `{"value":"${needle}-a-${needle}-b-${needle}-c-${needle}"}`
        const api = fakeApi({ read: vi.fn().mockResolvedValue(utf8(content)) })
        const session = createDocumentSession({
          parse: fakeParse,
          parseFromUrl: fakeParseFromUrl,
          api,
          reparseDelayMs: 5
        })
        await session.openPath('C:/docs/round-trip.json')

        const outcome = session.applyReplaceAll(allOffsets(content, needle), replacementText)
        expect(outcome.ok).toBe(true)
        await flush(session)

        const replaced = session.getSnapshot()
        if (replaced.phase !== 'ready') throw new Error('unreachable')
        const replacedBytes = new TextDecoder().decode(replaced.document.sourceBuffer.bytes)
        expect(replacedBytes).toBe(content.split(needle).join(replacementText))

        session.undo()
        await flush(session)
        const undone = session.getSnapshot()
        if (undone.phase !== 'ready') throw new Error('unreachable')
        expect(new TextDecoder().decode(undone.document.sourceBuffer.bytes)).toBe(content)

        session.redo()
        await flush(session)
        const redone = session.getSnapshot()
        if (redone.phase !== 'ready') throw new Error('unreachable')
        expect(new TextDecoder().decode(redone.document.sourceBuffer.bytes)).toBe(replacedBytes)

        session.undo()
        await flush(session)
        const undoneAgain = session.getSnapshot()
        if (undoneAgain.phase !== 'ready') throw new Error('unreachable')
        expect(new TextDecoder().decode(undoneAgain.document.sourceBuffer.bytes)).toBe(content)
      }
    )
  })

  describe('the minified-file banner and "Format minified files on open" (M5-PLAN.md H8)', () => {
    async function flush(session: { getSnapshot: () => unknown }): Promise<void> {
      // R154: delegates to the quiescence-based `flushReparse` at the top of
      // this file. See the copy in `undo/redo (F6)` for the full account —
      // this file had *five* of these, one per describe block, and the release
      // round replaced only one of them.
      await flushReparse(session)
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
    afterEach(() => {
      ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
    })

    it('does not auto-format a minified document when the setting is off (the default)', async () => {
      ;(globalThis as { localStorage?: Storage }).localStorage = fakeStorage()
      const minified = '{"a":1,"b":2,"c":[1,2,3,4,5]},'.repeat(50) // one long row
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8(minified)) })
      })
      await session.openPath('C:/docs/data.json')
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe(minified)
    })

    it('auto-formats a minified document on open when the setting is on', async () => {
      const storage = fakeStorage()
      storage.setItem('klados.formatMinifiedOnOpen', 'true')
      ;(globalThis as { localStorage?: Storage }).localStorage = storage

      const minified = '{"a":1,"b":2,"c":[1,2,3,4,5]},'.repeat(50)
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8(minified)) })
      })
      await session.openPath('C:/docs/data.json')
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      const decoded = new TextDecoder().decode(state.document.sourceBuffer.bytes)
      expect(decoded).not.toBe(minified)
      expect(decoded).toContain('\n')
    })

    // Review finding: an auto-triggered Format on open left the document
    // reading as "still minified" (stale rowIndex vs. the already-swapped
    // sourceBuffer, or simply nothing changed yet during the worker round
    // trip) for the whole duration of the transform + reparse, which would
    // let DocumentStatus.tsx's banner flash even though formatting was
    // already in progress. `transformInProgress`/`reparsePending` exist to
    // let a consumer suppress exactly that window.
    it('transformInProgress is true during the worker round trip, then reparsePending covers the tail until reparse lands', async () => {
      const storage = fakeStorage()
      storage.setItem('klados.formatMinifiedOnOpen', 'true')
      ;(globalThis as { localStorage?: Storage }).localStorage = storage

      let resolveTransform!: (bytes: ArrayBuffer) => void
      const controlledTransform: typeof fakeTransform = () =>
        new Promise((resolve) => {
          resolveTransform = resolve
        })

      // The reparse the Transform triggers must also stay pending past the
      // check below, or `reparsePending` flips back to `false` before this
      // test ever observes it as `true`. M5-PLAN.md H12: the initial open
      // goes through `parseFromUrl` exclusively — `parse` is only ever
      // called for a full reparse, and the only one in this test is the
      // one the auto-triggered Transform kicks off, so it hangs
      // unconditionally rather than needing to special-case "the first
      // call" the way this test did before H12 (when `parse` doubled as
      // the open path too).
      const controlledParse: typeof fakeParse = () =>
        new Promise(() => {
          /* never resolves within this test */
        })

      const minified = '{"a":1,"b":2,"c":[1,2,3,4,5]},'.repeat(50)
      const session = createDocumentSession({
        parse: controlledParse,
        parseFromUrl: fakeParseFromUrl,
        transform: controlledTransform,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8(minified)) })
      })
      await session.openPath('C:/docs/data.json')

      // The worker round trip is still pending — transformInProgress must
      // be true, reparsePending still false (the buffer hasn't swapped yet).
      let state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.transformInProgress).toBe(true)
      expect(state.document.reparsePending).toBe(false)

      resolveTransform(utf8('{\n  "a": 1\n}\n'))
      // Let the transform's own continuation run (buffer swap + reparse
      // trigger) without waiting out the full reparse itself — a real
      // macrotask boundary drains the whole microtask queue first, which
      // is more reliable than counting an exact number of `Promise.resolve()`
      // ticks (flaky in practice: the exact hop count depends on
      // incidental `await` depth inside `applyTransform`/`runReparse`,
      // not anything this test should have to track).
      await new Promise((resolve) => setTimeout(resolve, 0))

      state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.transformInProgress).toBe(false)
      expect(state.document.reparsePending).toBe(true)
      // The other H8 tests (auto-format completing, undo/redo settling)
      // already confirm reparsePending returns to false once a real
      // reparse actually lands — this test's own point is the transition
      // *into* reparsePending, which the assertion above covers.
    })

    it('does not auto-format a normally-formatted document even when the setting is on', async () => {
      const storage = fakeStorage()
      storage.setItem('klados.formatMinifiedOnOpen', 'true')
      ;(globalThis as { localStorage?: Storage }).localStorage = storage

      const pretty = '{\n  "a": 1,\n  "b": 2\n}\n'
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        api: fakeApi({ read: vi.fn().mockResolvedValue(utf8(pretty)) })
      })
      await session.openPath('C:/docs/data.json')
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe(pretty)
    })

    it('dismissMinifiedBanner is remembered until the next document is opened', async () => {
      ;(globalThis as { localStorage?: Storage }).localStorage = fakeStorage()
      const minified = '{"a":1,"b":2,"c":[1,2,3,4,5]},'.repeat(50)
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        transform: fakeTransform,
        api: fakeApi({
          read: vi.fn().mockResolvedValue(utf8(minified))
        })
      })
      await session.openPath('C:/docs/data.json')

      let state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.minifiedBannerDismissed).toBe(false)

      session.dismissMinifiedBanner()
      state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.minifiedBannerDismissed).toBe(true)

      // A fresh open resets it — a different (or even the same, reopened)
      // document gets its own offer.
      await session.openPath('C:/docs/other.json')
      state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.minifiedBannerDismissed).toBe(false)
    })
  })

  describe('external modification (F8)', () => {
    async function flush(session: { getSnapshot: () => unknown }): Promise<void> {
      // R154: delegates to the quiescence-based `flushReparse` at the top of
      // this file. See the copy in `undo/redo (F6)` for the full account —
      // this file had *five* of these, one per describe block, and the release
      // round replaced only one of them.
      await flushReparse(session)
    }

    // R52: main now keys watch registrations per session (`watchKey`), and
    // `onExternalChange`'s callback receives that key so a session can tell
    // its own file's change apart from another tab's. Fixed here rather
    // than relying on the auto-generated fallback (which increments across
    // the whole file and isn't predictable per test) — every session this
    // describe block creates passes this explicitly.
    const TEST_WATCH_KEY = 'test-watch-key'

    /** Captures the callback `onExternalChange` was subscribed with, so a
     * test can simulate the main process's own push notification by
     * calling `triggerChange()` directly. */
    function fakeApiWithChangeCapture(overrides: Partial<FakeApi['document']> = {}): {
      api: FakeApi
      triggerChange: () => void
    } {
      let listener: ((key: string) => void) | null = null
      const api = fakeApi({
        onExternalChange: vi.fn().mockImplementation((cb: (key: string) => void) => {
          listener = cb
          return () => {
            listener = null
          }
        }),
        ...overrides
      })
      return { api, triggerChange: () => listener?.(TEST_WATCH_KEY) }
    }

    it('watches the file on open, and switches the watch when a different document opens', async () => {
      const { api } = fakeApiWithChangeCapture()
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        watchKey: TEST_WATCH_KEY
      })
      await session.openPath('C:/docs/data.json')
      expect(api.document.watch).toHaveBeenCalledWith('C:/docs/data.json', TEST_WATCH_KEY)

      await session.openPath('C:/docs/other.json')
      expect(api.document.unwatch).toHaveBeenCalledWith(TEST_WATCH_KEY)
      expect(api.document.watch).toHaveBeenCalledWith('C:/docs/other.json', TEST_WATCH_KEY)
    })

    it("a clean document reloads silently on an external change, keeping the user's place", async () => {
      const { api, triggerChange } = fakeApiWithChangeCapture({
        read: vi.fn().mockResolvedValueOnce(utf8('{"a":1}')).mockResolvedValueOnce(utf8('{"a":2}'))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        watchKey: TEST_WATCH_KEY
      })
      await session.openPath('C:/docs/data.json')
      const ready = session.getSnapshot()
      if (ready.phase !== 'ready') throw new Error('unreachable')
      const propertyA = [
        ...ready.document.store.childrenOf(ready.document.store.firstChildOf(0))
      ][0]!
      session.setSelectedNode(propertyA)

      triggerChange()
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":2}')
      expect(state.document.externalChangeDetected).toBe(false)
      expect(getContext().hasExternalChange).toBe(false)
      // Still on the same conceptual node ("a" persists structurally).
      expect(state.document.store.nameOf(state.selection.selectedNode)).toBe('a')
    })

    it('a dirty document does not auto-reload — it sets externalChangeDetected instead', async () => {
      const { api, triggerChange } = fakeApiWithChangeCapture()
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5,
        watchKey: TEST_WATCH_KEY
      })
      await session.openPath('C:/docs/data.json')
      session.applyEdit({ start: 5, end: 6, text: '9' })

      triggerChange()
      await flush(session)

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.externalChangeDetected).toBe(true)
      expect(getContext().hasExternalChange).toBe(true)
      // The unsaved edit is not discarded just because a change was seen.
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":9}')
    })

    it('reloadAndDiscard replaces the buffer, clears the notice, and restores selection via F5', async () => {
      const { api } = fakeApiWithChangeCapture({
        read: vi.fn().mockResolvedValueOnce(utf8('{"a":1}')).mockResolvedValueOnce(utf8('{"a":99}'))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')
      const ready = session.getSnapshot()
      if (ready.phase !== 'ready') throw new Error('unreachable')
      const propertyA = [
        ...ready.document.store.childrenOf(ready.document.store.firstChildOf(0))
      ][0]!
      session.setSelectedNode(propertyA)
      session.applyEdit({ start: 5, end: 6, text: '2' }) // local, unsaved edit

      await session.reloadAndDiscard()

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":99}')
      expect(state.document.dirty).toBe(false)
      expect(state.document.externalChangeDetected).toBe(false)
      expect(state.document.store.nameOf(state.selection.selectedNode)).toBe('a')
    })

    it('reloadAndDiscard also clears the undo stack', async () => {
      const { api } = fakeApiWithChangeCapture({
        read: vi.fn().mockResolvedValueOnce(utf8('{"a":1}')).mockResolvedValueOnce(utf8('{"a":5}'))
      })
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5,
        undoDelayMs: 5
      })
      await session.openPath('C:/docs/data.json')
      session.applyEdit({ start: 5, end: 6, text: '2' })
      await flush(session)
      expect(getContext().canUndo).toBe(true)

      await session.reloadAndDiscard()

      expect(getContext().canUndo).toBe(false)
    })

    it('keepMine dismisses the notice without reloading', async () => {
      const { api, triggerChange } = fakeApiWithChangeCapture()
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api,
        reparseDelayMs: 5,
        watchKey: TEST_WATCH_KEY
      })
      await session.openPath('C:/docs/data.json')
      session.applyEdit({ start: 5, end: 6, text: '9' })
      triggerChange()
      await flush(session)

      session.keepMine()

      const state = session.getSnapshot()
      if (state.phase !== 'ready') throw new Error('unreachable')
      expect(state.document.externalChangeDetected).toBe(false)
      expect(getContext().hasExternalChange).toBe(false)
      // Still showing the local edit — keepMine doesn't touch the buffer.
      expect(new TextDecoder().decode(state.document.sourceBuffer.bytes)).toBe('{"a":9}')
    })

    it('keepMine is a no-op with nothing pending', () => {
      const session = createSession()
      expect(() => session.keepMine()).not.toThrow()
    })

    it('reloadAndDiscard is a no-op with no document open', async () => {
      const session = createDocumentSession({
        parse: fakeParse,
        parseFromUrl: fakeParseFromUrl,
        api: fakeApi()
      })
      await expect(session.reloadAndDiscard()).resolves.toBeUndefined()
    })
  })
})
