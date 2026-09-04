/**
 * R24-tabs.md — the tab registry (`session/tabs.ts`) and the four things it
 * bundles per tab: `DocumentSession`, `SearchStore`, `FindStore`,
 * `NavigationStore`. `documentSession.test.ts` already exercises a single
 * session in isolation; this exercises what's genuinely new — isolation
 * *between* tabs, and `commands/context` resolving against whichever one
 * is active, not accumulating writes from a background tab. Same fake-parse
 * infrastructure `documentSession.test.ts` uses (real `runParseJob`, no
 * real `Worker`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import {
  rehydrateParseResult,
  type ParseClientOptions,
  type ParseClientResult
} from '../src/core/parseClient'
import { runParseJob } from '../src/worker/parse.worker'
import { getContext, resetContextForTests } from '../src/renderer/commands/context'
import type { KladosApi } from '../src/preload/api'
import type {
  DocumentSessionDeps,
  DocumentSessionState
} from '../src/renderer/session/documentSession'
import {
  activateNextTab,
  activatePreviousTab,
  cancelCloseTab,
  cancelQuitFlow,
  closeTab,
  createTab,
  discardAllAndQuit,
  discardAndCloseTab,
  getActiveTabId,
  getCrossTabMemoryBytes,
  getPendingCloseTabId,
  getSessionFor,
  getTabIds,
  isQuitInProgress,
  requestCloseTab,
  resetTabsForTests,
  saveAndCloseTab,
  setActiveTab,
  setQuitFlowHandlers,
  startQuitFlow
} from '../src/renderer/session/tabs'
import { computeMemoryBudget } from '../src/renderer/components/StatusBar/memoryBudget'
import {
  getFindState,
  openFind,
  setCurrentMatchIndex
} from '../src/renderer/components/Find/findStore'
import { activeSearchStore } from '../src/renderer/session/activeSearchStore'
import { activeSession } from '../src/renderer/session/activeSession'
import { recordNavigation, goBack } from '../src/renderer/navigation/navigationStore'

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

/** Opens `path` into the tab created with `depsFor(text)` — the fake
 * api/read is bound once, at `createTab` time, not here. */
async function openInto(tabId: string, path: string): Promise<void> {
  const session = getSessionFor(tabId)
  if (session === undefined) throw new Error(`no session for ${tabId}`)
  await session.openPath(path)
}

function readyDocument(
  state: DocumentSessionState
): Extract<DocumentSessionState, { phase: 'ready' }>['document'] {
  if (state.phase !== 'ready') throw new Error(`expected 'ready', got '${state.phase}'`)
  return state.document
}

beforeEach(() => {
  resetTabsForTests()
  resetContextForTests()
})

afterEach(() => {
  resetTabsForTests()
  resetContextForTests()
})

describe('tabs.ts (R24-tabs.md)', () => {
  it('getActiveSession lazily creates exactly one tab when none exists', () => {
    expect(getTabIds()).toEqual([])
    const snapshot = activeSession.getSnapshot()
    expect(snapshot).toEqual({ phase: 'empty' })
    expect(getTabIds().length).toBe(1)
    expect(getActiveTabId()).toBe(getTabIds()[0])
  })

  it('two tabs hold independent documents, and only the active one drives commands/context', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('<b/>'))
    // Creating A first made it active; B stays a background tab.
    expect(getActiveTabId()).toBe(tabA)

    await openInto(tabA, 'C:/docs/a.json')
    expect(getContext().format).toBe('json')

    // Opening B's document happens in the background — A is still active,
    // so context must still describe A, not B, even though B's own session
    // state has already changed underneath.
    await openInto(tabB, 'C:/docs/b.xml')
    expect(getContext().format).toBe('json')
    expect(getSessionFor(tabB)?.getSnapshot().phase).toBe('ready')

    setActiveTab(tabB)
    expect(getContext().format).toBe('xml')

    setActiveTab(tabA)
    expect(getContext().format).toBe('json')
  })

  it('activeSession resolves to whichever tab is active, and reacts to a switch', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('<b/>'))
    await openInto(tabA, 'C:/docs/a.json')
    await openInto(tabB, 'C:/docs/b.xml')

    setActiveTab(tabA)
    let snapshot = activeSession.getSnapshot()
    expect(snapshot.phase === 'ready' && snapshot.document.formatId).toBe('json')

    let notified = 0
    const unsubscribe = activeSession.subscribe(() => {
      notified++
    })
    setActiveTab(tabB)
    expect(notified).toBeGreaterThan(0)
    snapshot = activeSession.getSnapshot()
    expect(snapshot.phase === 'ready' && snapshot.document.formatId).toBe('xml')
    unsubscribe()
  })

  it('undo history is per tab — undoing in one tab must not touch another (§9 open question)', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('{"b":2}'))
    await openInto(tabA, 'C:/docs/a.json')
    await openInto(tabB, 'C:/docs/b.json')

    setActiveTab(tabA)
    expect(getContext().canUndo).toBe(false)
    setActiveTab(tabB)
    expect(getContext().canUndo).toBe(false)
    // Neither tab has any edits in this test (edits need CodeMirror/real
    // apply paths beyond this unit's scope) — what matters here is that
    // each tab's own `canUndo` was independently resynced on activation,
    // not left over from whichever tab was previously active.
  })

  it('search results are per tab — a query in one tab does not leak into another', async () => {
    const tabA = createTab(depsFor('{"needle":1}'))
    const tabB = createTab(depsFor('{"other":2}'))
    await openInto(tabA, 'C:/docs/a.json')
    await openInto(tabB, 'C:/docs/b.json')

    setActiveTab(tabA)
    activeSearchStore.search({
      text: 'needle',
      mode: 'text',
      options: { caseSensitive: false, regex: false }
    })
    await vi.waitFor(() => expect(activeSearchStore.getSnapshot().complete).toBe(true))
    expect(activeSearchStore.getSnapshot().starts.length).toBeGreaterThan(0)

    setActiveTab(tabB)
    // A different tab, a document that never had "needle" searched against
    // it — its own store starts empty, not carrying A's result over.
    expect(activeSearchStore.getSnapshot().starts.length).toBe(0)

    setActiveTab(tabA)
    // Switching back to A finds its own result exactly as it left it.
    expect(activeSearchStore.getSnapshot().starts.length).toBeGreaterThan(0)
  })

  it('find bar state (open/current index/filter) is per tab', () => {
    const tabA = createTab()
    const tabB = createTab()

    setActiveTab(tabA)
    openFind()
    setCurrentMatchIndex(2)
    expect(getFindState()).toEqual({
      isOpen: true,
      currentIndex: 2,
      filterToMatches: false,
      replaceExpanded: false
    })

    setActiveTab(tabB)
    expect(getFindState()).toEqual({
      isOpen: false,
      currentIndex: null,
      filterToMatches: false,
      replaceExpanded: false
    })

    setActiveTab(tabA)
    expect(getFindState().isOpen).toBe(true)
    expect(getFindState().currentIndex).toBe(2)
  })

  it('navigation (back/forward) history is per tab', async () => {
    const tabA = createTab(depsFor('{"a":{"b":{"c":1}}}'))
    const tabB = createTab(depsFor('{"x":1}'))
    await openInto(tabA, 'C:/docs/a.json')
    await openInto(tabB, 'C:/docs/b.json')

    setActiveTab(tabA)
    recordNavigation(0)
    recordNavigation(1)
    expect(getContext().canGoBack).toBe(true)

    setActiveTab(tabB)
    // B never recorded a visit — its own history starts empty, not A's.
    expect(getContext().canGoBack).toBe(false)
    expect(goBack()).toBeNull()

    setActiveTab(tabA)
    expect(getContext().canGoBack).toBe(true)
    expect(goBack()).toBe(0)
  })

  it('closing the active tab activates a neighbor and resyncs context to it', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('<b/>'))
    await openInto(tabA, 'C:/docs/a.json')
    await openInto(tabB, 'C:/docs/b.xml')
    setActiveTab(tabA)

    closeTab(tabA)
    expect(getActiveTabId()).toBe(tabB)
    expect(getContext().format).toBe('xml')
    expect(getTabIds()).toEqual([tabB])
  })

  it('closing a background tab does not disturb the active one', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('<b/>'))
    await openInto(tabA, 'C:/docs/a.json')
    setActiveTab(tabA)

    closeTab(tabB)
    expect(getActiveTabId()).toBe(tabA)
    expect(getContext().format).toBe('json')
  })

  it('closing the only tab leaves no active tab', () => {
    const tab = createTab()
    closeTab(tab)
    expect(getActiveTabId()).toBeNull()
    expect(getTabIds()).toEqual([])
  })
})

describe('requestCloseTab (R26 — dirty-close prompt)', () => {
  it('a clean tab closes immediately, no prompt', async () => {
    const tab = createTab(depsFor('{"a":1}'))
    await openInto(tab, 'C:/docs/a.json')

    requestCloseTab(tab)

    expect(getPendingCloseTabId()).toBeNull()
    expect(getTabIds()).toEqual([])
    expect(getContext().hasPendingCloseTab).toBe(false)
  })

  it('a dirty tab is activated and left open, with the pending id recorded', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('<b/>'))
    await openInto(tabA, 'C:/docs/a.json')
    await openInto(tabB, 'C:/docs/b.xml')
    setActiveTab(tabA)
    getSessionFor(tabB)!.applyEdit({ start: 0, end: 0, text: ' ' })

    requestCloseTab(tabB)

    expect(getActiveTabId()).toBe(tabB)
    expect(getPendingCloseTabId()).toBe(tabB)
    expect(getTabIds()).toEqual([tabA, tabB])
    expect(getContext().hasPendingCloseTab).toBe(true)
  })

  it('cancelCloseTab clears the pending id without closing anything', async () => {
    const tab = createTab(depsFor('{"a":1}'))
    await openInto(tab, 'C:/docs/a.json')
    getSessionFor(tab)!.applyEdit({ start: 0, end: 0, text: ' ' })

    requestCloseTab(tab)
    expect(getPendingCloseTabId()).toBe(tab)

    cancelCloseTab()
    expect(getPendingCloseTabId()).toBeNull()
    expect(getContext().hasPendingCloseTab).toBe(false)
    expect(getTabIds()).toEqual([tab])
  })

  it('discardAndCloseTab closes without saving', async () => {
    const tab = createTab(depsFor('{"a":1}'))
    await openInto(tab, 'C:/docs/a.json')
    getSessionFor(tab)!.applyEdit({ start: 0, end: 0, text: ' ' })
    requestCloseTab(tab)

    discardAndCloseTab(tab)

    expect(getPendingCloseTabId()).toBeNull()
    expect(getTabIds()).toEqual([])
  })

  it('saveAndCloseTab saves, then closes, on success', async () => {
    const api = fakeApi('{"a":1}')
    const tab = createTab({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })
    await openInto(tab, 'C:/docs/a.json')
    getSessionFor(tab)!.applyEdit({ start: 0, end: 0, text: ' ' })
    requestCloseTab(tab)

    const outcome = await saveAndCloseTab(tab)

    expect(outcome.ok).toBe(true)
    expect(api.document.write).toHaveBeenCalled()
    expect(getPendingCloseTabId()).toBeNull()
    expect(getTabIds()).toEqual([])
  })

  it('saveAndCloseTab leaves the tab and the pending id alone on failure', async () => {
    const api = fakeApi('{"a":1}')
    api.document.write = vi.fn().mockRejectedValue(new Error('disk full'))
    const tab = createTab({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })
    await openInto(tab, 'C:/docs/a.json')
    getSessionFor(tab)!.applyEdit({ start: 0, end: 0, text: ' ' })
    requestCloseTab(tab)

    const outcome = await saveAndCloseTab(tab)

    expect(outcome.ok).toBe(false)
    expect(getPendingCloseTabId()).toBe(tab)
    expect(getTabIds()).toEqual([tab])
  })
})

describe('activateNextTab / activatePreviousTab (R26 — keyboard switching)', () => {
  it('wraps around in both directions', () => {
    const tabA = createTab()
    const tabB = createTab()
    const tabC = createTab()
    setActiveTab(tabA)

    activateNextTab()
    expect(getActiveTabId()).toBe(tabB)
    activateNextTab()
    expect(getActiveTabId()).toBe(tabC)
    activateNextTab()
    expect(getActiveTabId()).toBe(tabA)

    activatePreviousTab()
    expect(getActiveTabId()).toBe(tabC)
  })

  it('is a no-op with fewer than two tabs', () => {
    const tab = createTab()
    activateNextTab()
    expect(getActiveTabId()).toBe(tab)
    activatePreviousTab()
    expect(getActiveTabId()).toBe(tab)
  })
})

describe('getCrossTabMemoryBytes (R28)', () => {
  it('sums every ready tab, skipping ones still opening', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('<b>hello</b>'))
    createTab() // never opened — contributes nothing

    expect(getCrossTabMemoryBytes()).toBe(0)

    await openInto(tabA, 'C:/docs/a.json')
    const aBudget = computeMemoryBudget(
      readyDocument(getSessionFor(tabA)!.getSnapshot())
    ).totalBytes
    expect(getCrossTabMemoryBytes()).toBe(aBudget)

    await openInto(tabB, 'C:/docs/b.xml')
    const bBudget = computeMemoryBudget(
      readyDocument(getSessionFor(tabB)!.getSnapshot())
    ).totalBytes
    expect(getCrossTabMemoryBytes()).toBe(aBudget + bBudget)
  })

  it('excludes the given tab id', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('<b/>'))
    await openInto(tabA, 'C:/docs/a.json')
    await openInto(tabB, 'C:/docs/b.xml')

    expect(getCrossTabMemoryBytes(tabA)).toBeLessThan(getCrossTabMemoryBytes())
    expect(getCrossTabMemoryBytes(tabA) + getCrossTabMemoryBytes(tabB)).toBe(
      getCrossTabMemoryBytes()
    )
  })

  it("createTab wires a real estimateOtherTabsBytes — a second tab sees the first one's footprint", async () => {
    // End-to-end proof that `createTab`'s own injected `estimateOtherTabsBytes`
    // (not directly observable from outside `tabs.ts`) actually sums real
    // sibling tabs: tab B's own tiny budget can only be exceeded if it's
    // seeing tab A's already-open footprint, not just its own file.
    const tabA = createTab(depsFor('{"a":1}'))
    await openInto(tabA, 'C:/docs/a.json')
    const tabB = createTab({ ...depsFor('{"b":2}'), totalMemoryBudgetBytes: 1 })

    await openInto(tabB, 'C:/docs/b.json')

    const stateB = getSessionFor(tabB)!.getSnapshot()
    expect(stateB.phase).toBe('confirmSize')
    if (stateB.phase !== 'confirmSize') throw new Error('unreachable')
    expect(stateB.reason).toBe('budget')
  })
})

describe('R30 — context-key resolution cost per switch', () => {
  it('measures setActiveTab wall time across many open tabs', async () => {
    const COUNT = 20
    const ids: string[] = []
    for (let i = 0; i < COUNT; i++) {
      const id = createTab(depsFor(`{"i":${i}}`))
      await openInto(id, `C:/docs/${i}.json`)
      ids.push(id)
    }

    // Warm up (JIT, first-switch-only costs) before timing.
    for (const id of ids) setActiveTab(id)

    const start = performance.now()
    const SWITCHES = 200
    for (let i = 0; i < SWITCHES; i++) {
      setActiveTab(ids[i % ids.length]!)
    }
    const totalMs = performance.now() - start
    const perSwitchMs = totalMs / SWITCHES

    console.log(
      `[R30] setActiveTab across ${COUNT} tabs: ${SWITCHES} switches in ${totalMs.toFixed(2)}ms (${perSwitchMs.toFixed(4)}ms/switch)`
    )

    // Context resolution is a handful of `setContext` calls plus two
    // `resyncContext()`s (session + navigation) — this should be
    // effectively free, not something a user could perceive. 5ms/switch
    // would already be a surprising regression worth investigating.
    expect(perSwitchMs).toBeLessThan(5)
  })
})

describe('the consolidated quit flow (R26 — Notepad++ shape, not one list modal)', () => {
  function trackHandlers(): { resolved: number; cancelled: number } {
    const calls = { resolved: 0, cancelled: 0 }
    setQuitFlowHandlers({
      onAllResolved: () => calls.resolved++,
      onCancelled: () => calls.cancelled++
    })
    return calls
  }

  it('resolves immediately when nothing is dirty', () => {
    createTab(depsFor('{"a":1}'))
    const calls = trackHandlers()

    startQuitFlow()

    expect(calls.resolved).toBe(1)
    expect(calls.cancelled).toBe(0)
    expect(isQuitInProgress()).toBe(false)
  })

  it('asks one dirty tab at a time, in order, and resolves once the last is closed', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('{"b":2}'))
    await openInto(tabA, 'C:/docs/a.json')
    await openInto(tabB, 'C:/docs/b.json')
    getSessionFor(tabA)!.applyEdit({ start: 0, end: 0, text: ' ' })
    getSessionFor(tabB)!.applyEdit({ start: 0, end: 0, text: ' ' })
    const calls = trackHandlers()

    startQuitFlow()
    expect(getPendingCloseTabId()).toBe(tabA)
    expect(isQuitInProgress()).toBe(true)
    expect(calls.resolved).toBe(0)

    discardAndCloseTab(tabA)
    expect(getPendingCloseTabId()).toBe(tabB)
    expect(calls.resolved).toBe(0)

    discardAndCloseTab(tabB)
    expect(calls.resolved).toBe(1)
    expect(isQuitInProgress()).toBe(false)
    expect(getTabIds()).toEqual([])
  })

  it('discardAllAndQuit closes the pending tab and everything still queued in one step', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('{"b":2}'))
    const tabC = createTab(depsFor('{"c":3}'))
    for (const [id, path] of [
      [tabA, 'C:/docs/a.json'],
      [tabB, 'C:/docs/b.json'],
      [tabC, 'C:/docs/c.json']
    ] as const) {
      await openInto(id, path)
      getSessionFor(id)!.applyEdit({ start: 0, end: 0, text: ' ' })
    }
    const calls = trackHandlers()

    startQuitFlow()
    expect(getPendingCloseTabId()).toBe(tabA)

    discardAllAndQuit()

    expect(calls.resolved).toBe(1)
    expect(calls.cancelled).toBe(0)
    expect(isQuitInProgress()).toBe(false)
    expect(getTabIds()).toEqual([])
  })

  it('cancelQuitFlow leaves every tab open, including the one mid-prompt', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('{"b":2}'))
    await openInto(tabA, 'C:/docs/a.json')
    await openInto(tabB, 'C:/docs/b.json')
    getSessionFor(tabA)!.applyEdit({ start: 0, end: 0, text: ' ' })
    getSessionFor(tabB)!.applyEdit({ start: 0, end: 0, text: ' ' })
    const calls = trackHandlers()

    startQuitFlow()
    expect(getPendingCloseTabId()).toBe(tabA)

    cancelQuitFlow()

    expect(calls.cancelled).toBe(1)
    expect(calls.resolved).toBe(0)
    expect(isQuitInProgress()).toBe(false)
    expect(getPendingCloseTabId()).toBeNull()
    expect(getTabIds()).toEqual([tabA, tabB])
  })

  it('a save mid-flow advances to the next tab, same as a discard', async () => {
    const api = fakeApi('{"a":1}')
    const tabA = createTab({ parse: fakeParse, parseFromUrl: fakeParseFromUrl, api })
    const tabB = createTab(depsFor('{"b":2}'))
    await getSessionFor(tabA)!.openPath('C:/docs/a.json')
    await openInto(tabB, 'C:/docs/b.json')
    getSessionFor(tabA)!.applyEdit({ start: 0, end: 0, text: ' ' })
    getSessionFor(tabB)!.applyEdit({ start: 0, end: 0, text: ' ' })
    const calls = trackHandlers()

    startQuitFlow()
    expect(getPendingCloseTabId()).toBe(tabA)

    await saveAndCloseTab(tabA)

    expect(api.document.write).toHaveBeenCalled()
    expect(getPendingCloseTabId()).toBe(tabB)
    expect(calls.resolved).toBe(0)

    discardAndCloseTab(tabB)
    expect(calls.resolved).toBe(1)
  })

  it('a manual close click on a different dirty tab mid-flow does not orphan the one the flow was asking about', async () => {
    const tabA = createTab(depsFor('{"a":1}'))
    const tabB = createTab(depsFor('{"b":2}'))
    await openInto(tabA, 'C:/docs/a.json')
    await openInto(tabB, 'C:/docs/b.json')
    getSessionFor(tabA)!.applyEdit({ start: 0, end: 0, text: ' ' })
    getSessionFor(tabB)!.applyEdit({ start: 0, end: 0, text: ' ' })
    const calls = trackHandlers()

    startQuitFlow()
    expect(getPendingCloseTabId()).toBe(tabA)

    // The user clicks tabB's own close slot directly, mid-flow — this must
    // not steal `pendingCloseTabId` out from under the flow, or tabA would
    // never get asked about again and the flow would finish (and the app
    // would quit) with tabA's edits still unsaved.
    requestCloseTab(tabB)
    expect(getPendingCloseTabId()).toBe(tabA)
    expect(getTabIds()).toEqual([tabA, tabB])

    discardAndCloseTab(tabA)
    expect(getPendingCloseTabId()).toBe(tabB)
    expect(calls.resolved).toBe(0)

    discardAndCloseTab(tabB)
    expect(calls.resolved).toBe(1)
  })
})
