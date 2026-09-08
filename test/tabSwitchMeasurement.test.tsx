/**
 * R30 (`R24-tabs.md` §8) — the measurement pass. "The milestone's own
 * numbers, because §11.4's design rests on figures nobody has taken here."
 * Deliberately produces numbers (recorded in `R24-tabs.md`'s own R30
 * Results section) rather than changing production code — the same
 * "measure first" precedent R20 set (D-063).
 *
 * Real Chromium throughout (real `Worker`s for the pool section, real
 * `React.Profiler` timing for the render section) — the same
 * `test/documentPropsRenderCost.test.tsx`/`test/workerPool.test.tsx`
 * infrastructure this reuses rather than duplicates conceptually.
 */
// MUST stay first — see this file's own import in `main.tsx` and
// `devPerformanceTracks.ts`'s own doc comment. Every other test file in
// this suite gets away without it only because its documents are tiny
// (`documentPropsRenderCost.test.tsx`'s own fixture is ~45 bytes); this
// round's own ~2 MB/30k-node documents hit R19's exact defect — React's
// DEV performance tracks walking the whole `NodeStore` on every render —
// without it, discovered the hard way (a 235-second "render" and an
// out-of-memory crash) before this import was added. See the R30 Results
// section for the write-up.
import '../src/renderer/devPerformanceTracks'
import { describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { waitForQuietFrames } from './support/wait'
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
import { parseInWorker } from '../src/core/parseClient'
import { getWorkerPoolStats } from '../src/core/workerPool'
import '../src/renderer/commands/builtins'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/Tree/Tree.css'
import '../src/renderer/components/Detail/Detail.css'
import '../src/renderer/components/Raw/Raw.css'
import '../src/renderer/components/Scrubber/Scrubber.css'
import '../src/renderer/components/StatusBar/StatusBar.css'

const options: ParseOptions = { maxDepth: 1000, encoding: 'utf-8' }

/** A synthetic ~2 MB document — big enough that Raw's windowed CodeMirror
 * setup and the Tree/Detail virtualizers are doing real work, small enough
 * to keep this a fast, self-contained test with no fixture-file I/O. */
function bigDocumentFor(seed: string): OpenDocument {
  const items = Array.from({ length: 30_000 }, (_, i) => ({
    id: i,
    name: `${seed}-${i}`,
    ok: i % 2 === 0
  }))
  // Pretty-printed, not minified — a single ~2 MB line is a known CodeMirror
  // pathology (D-031's windowing is byte-based, not line-based, so an
  // unbroken line inside the ~1 MB window still has to be laid out as one
  // line) and produced a multi-*minute* hang the first time this measured,
  // nothing like a realistic document. Real fixtures (`cars-10mb.xml`) are
  // formatted; this generator now matches that instead of accidentally
  // measuring an editor defect this round never set out to find.
  const text = JSON.stringify({ items }, null, 2)
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
    filePath: `C:/docs/${seed}.json`,
    fileName: `${seed}.json`,
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

function emptyStats(): Record<Pane, number> {
  return { tree: 0, detail: 0, raw: 0, scrubber: 0, statusBar: 0 }
}

/**
 * R161 (`docs/plans/R159-fixed-duration-waits.md` §6): a commit counter beside
 * the millisecond total, used only by `drainMount` below.
 *
 * The duration total cannot serve as the drain signal on its own — a commit
 * whose `actualDuration` rounds to 0 would look like no commit at all, which is
 * precisely the "stable and not-yet-started are indistinguishable" trap this
 * round keeps finding. Counting is unambiguous.
 */
const commits = { count: 0 }

function recorder(stats: Record<Pane, number>, pane: Pane): ProfilerOnRenderCallback {
  return (_id, _phase, actualDuration) => {
    stats[pane] += actualDuration
    commits.count++
  }
}

function Harness({
  document,
  stats
}: {
  readonly document: OpenDocument
  readonly stats: Record<Pane, number>
}): React.ReactElement {
  return (
    <>
      <Profiler id="tree" onRender={recorder(stats, 'tree')}>
        <TreeContent document={document} selectedNode={0} />
      </Profiler>
      {/* R43 (`R43-grid-sizing-and-scroll.md`, D-071): `.detail-grid-
          container` is now `flex: 1` against its own ancestor chain's real
          height, not a fixed pixel constant — same reason `Raw` already
          gets an explicit-height wrapper here rather than relying on
          `container`'s own (unset) height. In the real app `Layout.tsx`'s
          `PaneShell` always gives Detail a genuine flexed height ("Detail
          always takes the remainder"); without an equivalent here, an
          indefinite ancestor height leaves `flex: 1` nothing to distribute
          against, so `.detail-grid-container` — and the row virtualizer
          inside it — sizes to its own content instead of a viewport,
          which measured as a ~2s-per-switch regression on this file's own
          30,000-row fixture before this wrapper was added. */}
      <div style={{ position: 'relative', width: '640px', height: '400px' }}>
        <Profiler id="detail" onRender={recorder(stats, 'detail')}>
          <DetailContent document={document} selectedNode={0} />
        </Profiler>
      </div>
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

async function paint(jsx: React.ReactNode): Promise<void> {
  await new Promise<void>((resolve) => {
    root.render(jsx)
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

let container: HTMLDivElement
let root: Root

describe('R30 — tab-switch remount cost', () => {
  it('measures the render cost of switching the active tab (a new document identity) between two ~2 MB documents', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    document.documentElement.dataset.theme = 'light'

    const docA = bigDocumentFor('alpha')
    const docB = bigDocumentFor('beta')
    const stats = emptyStats()

    await paint(<Harness document={docA} stats={stats} />)
    // First mount's cost (CodeMirror's own setup included) isn't the
    // number under test — only the *switch* is.
    //
    // R161: and that comment is the reason `paint`'s two `requestAnimationFrame`s
    // cannot be where the zeroing happens. **CodeMirror's setup is
    // effect-driven, not frame-driven**, so it has no obligation to land inside
    // them; when it lands late its commit arrives after the counters are zeroed
    // and is charged to the switch. R158 found exactly this in the sibling file
    // `documentPropsRenderCost.test.tsx`, where it failed a macOS CI run with
    // `expected 11 to be 10`. Here the assertion is a generous
    // `wallMs < 500`, so it would never have gone red — it would have quietly
    // inflated the R30 figure this test prints to the log as its own
    // deliverable, which is `CLAUDE.md`'s "a component measured cleanly while
    // the pipeline around it was not" for the fifth time.
    await waitForQuietFrames(() => commits.count, { label: 'drainMount' })
    for (const pane of PANES) stats[pane] = 0
    commits.count = 0

    const start = performance.now()
    await paint(<Harness document={docB} stats={stats} />)
    const wallMs = performance.now() - start

    const totalProfiledMs = PANES.reduce((sum, pane) => sum + stats[pane], 0)

    console.log('[R30] tab-switch remount:', {
      wallMs: wallMs.toFixed(2),
      perPaneMs: Object.fromEntries(PANES.map((p) => [p, stats[p].toFixed(2)])),
      totalProfiledMs: totalProfiledMs.toFixed(2)
    })

    root.unmount()
    container.remove()

    // A generous regression bound, not a target — this is the round that
    // establishes what "normal" is, not one that had a number to defend
    // already. 500ms would be a genuinely bad user-facing switch latency.
    expect(wallMs).toBeLessThan(500)
  })
})

describe('R30 — worker pool queueing latency', () => {
  it('measures how long queued parses (beyond the 3-worker pool) wait versus the first three', async () => {
    function jsonOf(n: number): ArrayBuffer {
      const items = Array.from({ length: 5_000 }, (_, i) => ({ id: i, n }))
      return new TextEncoder().encode(JSON.stringify({ items })).buffer as ArrayBuffer
    }

    const timings: number[] = []
    const overallStart = performance.now()
    const jobs = Array.from({ length: 6 }, (_, i) =>
      parseInWorker(jsonOf(i), { filename: `${i}.json` }).then(() => {
        timings[i] = performance.now() - overallStart
      })
    )
    await Promise.all(jobs)

    console.log(
      '[R30] worker pool (size 3), 6 concurrent parses, completion times (ms):',
      timings.map((t) => t.toFixed(1))
    )

    // The queued half (jobs 4-6) finishing no faster than the first three
    // is the real signal the queue is queueing — true in isolation (this
    // file run alone: ~120ms vs. ~145ms), but running alongside the rest
    // of the suite adds enough OS/CPU scheduling noise across six real
    // `Worker` threads that this ordering isn't reliable as a hard
    // assertion (observed inverted once under full-suite load, not a
    // correctness regression — the same "load-sensitive timing, not a
    // regression" class R24's own results section already names). The
    // pool staying at its configured size is the part worth asserting;
    // the comparative timing above is the actual R30 deliverable, read
    // from the log, not enforced here.
    expect(getWorkerPoolStats().size).toBe(3)
    expect(getWorkerPoolStats().free).toBe(3)
  })
})

/** `performance.memory` is a Chromium-only, non-standard API — exactly why
 * this runs in the browser project rather than being asserted anywhere
 * production code depends on. A proxy for renderer JS heap growth, not the
 * packaged app's own OS-level RSS §8 talks about — measuring that would
 * need main-process instrumentation (`app.getAppMetrics()`) this round
 * didn't build; disclosed in the R30 Results section rather than
 * conflated with a number this test doesn't actually produce. */
interface ChromeMemory {
  readonly usedJSHeapSize: number
}

describe('R30 — JS heap with three vs. six documents open (a proxy, not process RSS)', () => {
  it('reports heap growth for 3 and 6 ~2 MB documents held at once', () => {
    const memory = (performance as unknown as { memory?: ChromeMemory }).memory
    if (memory === undefined) {
      console.log('[R30] performance.memory unavailable in this Chromium build — skipped')
      return
    }

    const baseline = memory.usedJSHeapSize
    const three = Array.from({ length: 3 }, (_, i) => bigDocumentFor(`three-${i}`))
    const afterThree = memory.usedJSHeapSize
    const six = [...three, ...Array.from({ length: 3 }, (_, i) => bigDocumentFor(`six-${i}`))]
    const afterSix = memory.usedJSHeapSize

    console.log('[R30] JS heap bytes:', {
      baseline,
      afterThree,
      afterSix,
      deltaThree: afterThree - baseline,
      deltaSix: afterSix - baseline
    })

    expect(three.length + six.length).toBe(9) // keeps both arrays live until logging above runs
  })
})
