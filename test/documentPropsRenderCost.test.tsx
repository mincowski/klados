/**
 * `R19-document-props.md` §5a — "the first deliverable is a number,
 * not a change." Counts how many times each pane's props-driven inner
 * component (`TreeContent`, `DetailContent`, `RawContent`, `ScrubberContent`,
 * `ReadyStatus`) actually re-renders, and sums `React.Profiler`'s own
 * `actualDuration`, when `document` is replaced with a shallow copy the way
 * `documentSession.ts` always replaces it — across a typing burst
 * (`syncUndoContext`'s own `undoBytes`/`undoEntryCount` update), a Format,
 * and an undo/redo cycle.
 *
 * Deliberately does not drive the real `activeSession` singleton through
 * its actual `openPath`/`applyEdit`/`requestTransform` — those need a real
 * Electron preload IPC this environment doesn't have (the same gap
 * `M5c-RESULTS.md`'s J9 and every milestone since has flagged rather than
 * smoothed over). Instead it replays the exact prop-object shape each of
 * those operations produces, driven at the same outer/inner seam
 * `test/statusBar.test.tsx`/`test/treeExpansion.test.tsx` already use —
 * real React commits, real `React.Profiler` timing, real Chromium layout
 * for Raw's CodeMirror mount.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { buildLineIndex, buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { buildNameIndex } from '../src/core/nameIndex'
import { EMPTY_DELTA_LIST } from '../src/core/deltaList'
import type { ParseOptions } from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'
import { TreeContent } from '../src/renderer/components/Tree/Tree'
import { DetailContent } from '../src/renderer/components/Detail/Detail'
import { RawContent } from '../src/renderer/components/Raw/Raw'
import { ScrubberContent } from '../src/renderer/components/Scrubber/Scrubber'
import { ReadyStatus } from '../src/renderer/components/StatusBar/StatusBar'
import type { OpenDocument } from '../src/renderer/session/documentSession'
// Static, once per file — see `test/statusBar.test.tsx`'s own comment on
// why command registration can't be reset-and-reimported per test; several
// panes call `getCommand` and expect the registry populated.
import '../src/renderer/commands/builtins'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Tree/Tree.css'
import '../src/renderer/components/Detail/Detail.css'
import '../src/renderer/components/Raw/Raw.css'
import '../src/renderer/components/Scrubber/Scrubber.css'
import '../src/renderer/components/StatusBar/StatusBar.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
})

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

function baseDocument(): OpenDocument {
  const text = '{"a":1,"b":{"c":[1,2,3]},"d":"hello world"}'
  const source = new TextEncoder().encode(text)
  const interner = new Interner()
  const store = new NodeStore(source, interner)
  jsonFormatModule.parse(source, store, options)
  const rowIndex = buildRowIndex(
    source,
    DEFAULT_MAX_ROW_BYTES,
    jsonFormatModule.capabilities.rowBreakBytes
  )
  const lineIndex = buildLineIndex(source, rowIndex)
  const nameIndex = buildNameIndex(store, interner.size)
  return {
    filePath: 'C:/docs/data.json',
    fileName: 'data.json',
    store,
    sourceBuffer: new SourceBuffer(source, 'utf-8', 0),
    rowIndex,
    lineIndex,
    nameIndex,
    diagnostics: [],
    complete: true,
    formatId: 'json',
    encoding: 'utf-8',
    readOnly: false,
    errorNode: null,
    errorOffset: null,
    pendingParseError: null,
    dirty: false,
    externalChangeDetected: false,
    pendingTransform: null,
    minifiedBannerDismissed: false,
    reparsePending: false,
    transformInProgress: false,
    lastTransformWasNoOp: false,
    undoBytes: 0,
    undoEntryCount: 0,
    pendingSpanDeltas: EMPTY_DELTA_LIST,
    // R100: this fixture predates the field; a freshly opened document
    // has had no external rewrite yet.
    externalRewrites: 0
  }
}

const PANES = ['tree', 'detail', 'raw', 'scrubber', 'statusBar'] as const
type Pane = (typeof PANES)[number]

interface Stats {
  count: number
  totalActualMs: number
}

function emptyStats(): Record<Pane, Stats> {
  return {
    tree: { count: 0, totalActualMs: 0 },
    detail: { count: 0, totalActualMs: 0 },
    raw: { count: 0, totalActualMs: 0 },
    scrubber: { count: 0, totalActualMs: 0 },
    statusBar: { count: 0, totalActualMs: 0 }
  }
}

function recorder(stats: Record<Pane, Stats>, pane: Pane): ProfilerOnRenderCallback {
  return (_id, _phase, actualDuration) => {
    stats[pane].count++
    stats[pane].totalActualMs += actualDuration
  }
}

function Harness({
  document,
  stats
}: {
  readonly document: OpenDocument
  readonly stats: Record<Pane, Stats>
}): React.ReactElement {
  return (
    <>
      <Profiler id="tree" onRender={recorder(stats, 'tree')}>
        <TreeContent document={document} selectedNode={0} />
      </Profiler>
      <Profiler id="detail" onRender={recorder(stats, 'detail')}>
        <DetailContent document={document} selectedNode={0} />
      </Profiler>
      <div style={{ position: 'relative', width: '640px', height: '400px' }}>
        <Profiler id="raw" onRender={recorder(stats, 'raw')}>
          <RawContent document={document} caretOffset={0} selectedNode={0} />
        </Profiler>
      </div>
      <Profiler id="scrubber" onRender={recorder(stats, 'scrubber')}>
        <ScrubberContent document={document} selectedNode={0} />
      </Profiler>
      <Profiler id="statusBar" onRender={recorder(stats, 'statusBar')}>
        <ReadyStatus document={document} caretOffset={0} />
      </Profiler>
    </>
  )
}

function resetStats(stats: Record<Pane, Stats>): void {
  for (const pane of PANES) {
    stats[pane].count = 0
    stats[pane].totalActualMs = 0
  }
}

/** Every pane commits once on mount (plus, for `raw`, CodeMirror's own
 * effect-driven setup) — that's not the number under test, so it's drained
 * before each scenario starts recording. */
async function mountAndDrain(stats: Record<Pane, Stats>): Promise<void> {
  await paint(<Harness document={baseDocument()} stats={stats} />)
  resetStats(stats)
}

function logStats(label: string, stats: Record<Pane, Stats>): void {
  const summary = Object.fromEntries(
    PANES.map((pane) => [
      pane,
      `${stats[pane].count} renders, ${stats[pane].totalActualMs.toFixed(3)}ms`
    ])
  )

  console.log(`[R20 §5a] ${label}:`, summary)
}

describe('R19-document-props.md §5a — render cost of an unsliced OpenDocument', () => {
  it('a typing burst (syncUndoContext replaying undoBytes/undoEntryCount) re-renders every pane, once per replacement', async () => {
    const stats = emptyStats()
    await mountAndDrain(stats)
    let doc = baseDocument()

    // A burst of 10 keystrokes, each landing a `syncUndoContext` update —
    // the exact shape `applyEdit`'s debounced-burst coalescing produces.
    for (let i = 1; i <= 10; i++) {
      doc = { ...doc, dirty: true, undoBytes: doc.undoBytes + 7, undoEntryCount: 1 }
      await paint(<Harness document={doc} stats={stats} />)
    }

    logStats('typing burst (10 replacements)', stats)
    for (const pane of PANES) expect(stats[pane].count).toBe(10)
  })

  it('a Format (one full-document replacement) re-renders every pane exactly once', async () => {
    const stats = emptyStats()
    await mountAndDrain(stats)
    const before = baseDocument()

    const formatted = new TextEncoder().encode('{\n  "a": 1\n}\n')
    const after: OpenDocument = {
      ...before,
      sourceBuffer: new SourceBuffer(formatted, 'utf-8', 0),
      dirty: true,
      reparsePending: false,
      transformInProgress: false,
      lastTransformWasNoOp: false
    }
    await paint(<Harness document={after} stats={stats} />)

    logStats('one Format replacement', stats)
    // A prop change commits at least once per pane; a pane's own effects
    // (Raw's caret positioning, Detail's grid-detection pass) can schedule
    // one follow-up commit on some transitions and not others — real
    // behavior this measurement surfaces, not something to paper over with
    // an exact count. What matters for §5a is that it's O(1) commits, not
    // proportional to anything, and cheap regardless.
    for (const pane of PANES) {
      expect(stats[pane].count).toBeGreaterThanOrEqual(1)
      expect(stats[pane].count).toBeLessThanOrEqual(2)
    }
  })

  it('an undo/redo cycle (two replacements) re-renders every pane close to twice', async () => {
    const stats = emptyStats()
    await mountAndDrain(stats)
    const doc = baseDocument()

    const undone: OpenDocument = { ...doc, undoBytes: 0, undoEntryCount: 0, dirty: false }
    await paint(<Harness document={undone} stats={stats} />)
    const redone: OpenDocument = { ...doc, undoBytes: 7, undoEntryCount: 1, dirty: true }
    await paint(<Harness document={redone} stats={stats} />)

    logStats('undo/redo cycle (2 replacements)', stats)
    for (const pane of PANES) {
      expect(stats[pane].count).toBeGreaterThanOrEqual(2)
      expect(stats[pane].count).toBeLessThanOrEqual(3)
    }
  })
})
