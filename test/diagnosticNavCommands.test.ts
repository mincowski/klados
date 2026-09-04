/**
 * Integration coverage for the "Next/Previous Diagnostic" commands
 * (navigation/commands.ts) — specifically that repeated invocation
 * actually advances, which the pure-function tests in diagnosticNav.test.ts
 * can't catch on their own since they don't exercise `run()` against a
 * real session. A prior version of this command updated the *node*
 * selection and the Raw view's scroll position but never `caretOffset`
 * itself, so `nextDiagnostic`/`previousDiagnostic` — which read
 * `selection.caretOffset` as "where we are now" — kept recomputing from
 * the same stale starting offset and could never advance past the first
 * diagnostic. This test opens a real (well-formed, zero-diagnostic)
 * document via the same `fakeParse`/`fakeApi` harness `documentSession.test.ts`
 * uses for a real `NodeStore`, then swaps in hand-picked diagnostics —
 * building diagnostics through real parsing isn't practical, since
 * nothing in this codebase's parsers currently emits more than one
 * (fatal, parse-stopping) diagnostic per malformed document.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { Severity, type Diagnostic } from '../src/core/types'
import { runParseJob } from '../src/worker/parse.worker'
import { getContext, resetContextForTests } from '../src/renderer/commands/context'
import type { AppContext } from '../src/renderer/commands/registry'
import { getCommand, resetCommandRegistryForTests } from '../src/renderer/commands/registry'
import type { KladosApi } from '../src/preload/api'
import {
  createDocumentSession,
  type DocumentSession
} from '../src/renderer/session/documentSession'

type FakeApi = { document: KladosApi['document'] }

let nextRequestId = 1

function fakeParse(bytes: ArrayBuffer, options: ParseClientOptions): Promise<ParseClientResult> {
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

/** M5-PLAN.md H12: mints a fixed, single-use-per-call token and hands the
 * document's own bytes back for it directly — this file's `fakeApi` is
 * scoped to one fixed `xml` string per session anyway (unlike
 * `documentSession.test.ts`'s more general fake), so there's no need for
 * a shared token registry here. */
function fakeApi(xml: string): FakeApi {
  return {
    document: {
      openDialog: async () => null,
      stat: async () => ({ size: xml.length, readOnly: false }),
      mintReadToken: async () => 'token',
      getPathForFile: () => '',
      write: async () => {},
      saveAsDialog: async () => null,
      watch: async () => {},
      unwatch: async () => {},
      onExternalChange: () => () => {}
    }
  }
}

function fakeParseFromUrl(
  xml: string
): (url: string, options: ParseClientOptions) => Promise<ParseClientResult> {
  return (_url, options) => fakeParse(utf8(xml), options)
}

function diag(offset: number): Diagnostic {
  return { severity: Severity.Warning, code: 'test', offset, length: 1, message: 'test' }
}

/** Same underlying closures as `session` (spreading copies function
 * references, not values), except `getSnapshot` reports `diagnostics`
 * in place of whatever the real parse produced — lets `setSelectedNode`/
 * `setCaretOffset` still mutate the one real session underneath. */
function withDiagnostics(
  session: DocumentSession,
  diagnostics: readonly Diagnostic[]
): DocumentSession {
  return {
    ...session,
    getSnapshot: () => {
      const state = session.getSnapshot()
      return state.phase !== 'ready'
        ? state
        : { ...state, document: { ...state.document, diagnostics } }
    }
  }
}

async function readySessionOver(xml: string): Promise<DocumentSession> {
  const session = createDocumentSession({
    parse: fakeParse,
    parseFromUrl: fakeParseFromUrl(xml),
    api: fakeApi(xml)
  })
  await session.openPath('C:/docs/data.xml')
  return session
}

describe('Next/Previous Diagnostic commands', () => {
  // Registered once — a dynamic `import()` after `resetCommandRegistryForTests()`
  // only re-runs the module's top-level `registerCommand` calls the first
  // time this specifier loads in this file's isolated module registry.
  beforeAll(async () => {
    resetCommandRegistryForTests()
    await import('../src/renderer/navigation/commands')
  })

  it('advances through diagnostics one at a time rather than getting stuck', async () => {
    resetContextForTests()

    const session = await readySessionOver('<zoo><cat/><dog/><cow/></zoo>')
    const diagnostics = [diag(5), diag(15), diag(25)]
    const ctx: AppContext = {
      context: getContext(),
      session: withDiagnostics(session, diagnostics)
    }

    const next = getCommand('klados.navigate.nextDiagnostic')
    if (next === undefined) throw new Error('command not registered')

    next.run(ctx)
    let state = session.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.selection.caretOffset).toBe(5)

    next.run(ctx)
    state = session.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.selection.caretOffset).toBe(15)

    next.run(ctx)
    state = session.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.selection.caretOffset).toBe(25)

    // No fourth diagnostic — a no-op, not a wrap to the first.
    next.run(ctx)
    state = session.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.selection.caretOffset).toBe(25)
  })

  it('previous mirrors next in the other direction', async () => {
    resetContextForTests()

    const session = await readySessionOver('<zoo><cat/><dog/><cow/></zoo>')
    const diagnostics = [diag(5), diag(15), diag(25)]
    // Start at the end, like arriving there via "next" above.
    session.setCaretOffset(25)
    const ctx: AppContext = {
      context: getContext(),
      session: withDiagnostics(session, diagnostics)
    }

    const previous = getCommand('klados.navigate.previousDiagnostic')
    if (previous === undefined) throw new Error('command not registered')

    previous.run(ctx)
    let state = session.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.selection.caretOffset).toBe(15)

    previous.run(ctx)
    state = session.getSnapshot()
    if (state.phase !== 'ready') throw new Error('unreachable')
    expect(state.selection.caretOffset).toBe(5)
  })
})
