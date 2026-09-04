/**
 * M5f-PLAN.md — the status bar redesign (R12). `ReadyStatus` takes its
 * document as a plain prop (`StatusBar.tsx`'s own export comment), so it
 * can be driven directly here without standing up the real `activeSession`
 * singleton — same reasoning `test/treeExpansion.test.tsx` gives for
 * `TreeContent`. Verifies against real Chromium layout since the
 * statistics panel's focus handling needs a real DOM.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { Severity, type Diagnostic } from '../src/core/types'
import { SourceBuffer } from '../src/core/buffer'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import { buildLineIndex, buildRowIndex, DEFAULT_MAX_ROW_BYTES } from '../src/core/rowIndex'
import { buildNameIndex } from '../src/core/nameIndex'
import { EMPTY_DELTA_LIST } from '../src/core/deltaList'
import type { ParseOptions } from '../src/core/types'
import { jsonFormatModule } from '../src/formats/json/index'
import { ReadyStatus } from '../src/renderer/components/StatusBar/StatusBar'
import { resetStatisticsPanelStoreForTests } from '../src/renderer/components/StatusBar/statisticsPanelStore'
import { getAllCommands } from '../src/renderer/commands/registry'
import type { OpenDocument } from '../src/renderer/session/documentSession'
// Static, once per file — registered commands are a process-wide
// singleton in production too (`main.tsx` imports `builtins` once); an
// ES module only actually executes once per realm regardless of how many
// files import it, so resetting-and-reimporting per test (the node
// project's own `commands.test.ts` pattern) would silently leave the
// registry empty after the first test, since the cached module wouldn't
// re-run its `registerCommand` side effects.
import '../src/renderer/commands/builtins'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/components/StatusBar/StatusBar.css'
import '../src/renderer/components/StatusBar/StatisticsPanel.css'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetStatisticsPanelStoreForTests()
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

function openDocumentFor(
  overrides: {
    diagnostics?: readonly Diagnostic[]
    dirty?: boolean
    readOnly?: boolean
    undoBytes?: number
    undoEntryCount?: number
  } = {}
): OpenDocument {
  const text = '{"a":1,"b":{"c":[1,2,3]}}'
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
    diagnostics: overrides.diagnostics ?? [],
    complete: true,
    formatId: 'json',
    encoding: 'utf-8',
    readOnly: overrides.readOnly ?? false,
    errorNode: null,
    errorOffset: null,
    pendingParseError: null,
    dirty: overrides.dirty ?? false,
    externalChangeDetected: false,
    pendingTransform: null,
    minifiedBannerDismissed: false,
    reparsePending: false,
    transformInProgress: false,
    lastTransformWasNoOp: false,
    undoBytes: overrides.undoBytes ?? 0,
    undoEntryCount: overrides.undoEntryCount ?? 0,
    pendingSpanDeltas: EMPTY_DELTA_LIST,
    // R100: this fixture predates the field; a freshly opened document
    // has had no external rewrite yet.
    externalRewrites: 0
  }
}

function itemCount(): number {
  return container.querySelectorAll('.status-bar-item').length
}

describe('StatusBar (M5f-PLAN.md)', () => {
  it('renders the same item count regardless of dirty/read-only/diagnostic state', async () => {
    await paint(<ReadyStatus document={openDocumentFor()} caretOffset={0} />)
    const clean = itemCount()

    await paint(<ReadyStatus document={openDocumentFor({ dirty: true })} caretOffset={0} />)
    expect(itemCount()).toBe(clean)

    await paint(<ReadyStatus document={openDocumentFor({ readOnly: true })} caretOffset={0} />)
    expect(itemCount()).toBe(clean)

    const diagnostics: Diagnostic[] = [
      { severity: Severity.Error, code: 'x', offset: 0, length: 1, message: 'bad' },
      { severity: Severity.Warning, code: 'y', offset: 1, length: 1, message: 'meh' }
    ]
    await paint(<ReadyStatus document={openDocumentFor({ diagnostics })} caretOffset={0} />)
    expect(itemCount()).toBe(clean)
  })

  it('shows zero counters, disabled, with no diagnostics', async () => {
    await paint(<ReadyStatus document={openDocumentFor()} caretOffset={0} />)
    // R71 (`R71-text-as-icons.md` §5b): the ⊗/⚠ marks are icons now,
    // not text — the error button is the first `.status-bar-clickable`,
    // the warning button the second (`StatusBar.tsx`'s own fixed JSX
    // order: error, then warning, then the info button).
    const buttons = Array.from(container.querySelectorAll('button.status-bar-clickable'))
    const errorButton = buttons[0]!
    const warningButton = buttons[1]!
    expect(errorButton.textContent).toContain('0')
    expect(warningButton.textContent).toContain('0')
    expect((errorButton as HTMLButtonElement).disabled).toBe(true)
    expect((warningButton as HTMLButtonElement).disabled).toBe(true)
  })

  it('splits errors (Error|Fatal) from warnings and enables the counters', async () => {
    const diagnostics: Diagnostic[] = [
      { severity: Severity.Error, code: 'e1', offset: 0, length: 1, message: 'e' },
      { severity: Severity.Fatal, code: 'f1', offset: 1, length: 1, message: 'f' },
      { severity: Severity.Warning, code: 'w1', offset: 2, length: 1, message: 'w' }
    ]
    await paint(<ReadyStatus document={openDocumentFor({ diagnostics })} caretOffset={0} />)
    const buttons = Array.from(container.querySelectorAll('button.status-bar-clickable'))
    const errorButton = buttons[0]!
    const warningButton = buttons[1]!
    expect(errorButton.textContent).toContain('2')
    expect(warningButton.textContent).toContain('1')
    expect((errorButton as HTMLButtonElement).disabled).toBe(false)
  })

  it('the container carries no role="status"', async () => {
    await paint(
      <div className="status-bar">
        <ReadyStatus document={openDocumentFor()} caretOffset={0} />
      </div>
    )
    expect(container.querySelector('.status-bar')?.getAttribute('role')).toBeNull()
  })

  it('opens the statistics panel from the ⓘ button, with the memory breakdown including undo history', async () => {
    await paint(
      <ReadyStatus
        document={openDocumentFor({ undoBytes: 2048, undoEntryCount: 3 })}
        caretOffset={0}
      />
    )
    const infoButton = container.querySelector<HTMLButtonElement>('#status-bar-info-button')!
    infoButton.click()
    await paint(
      <ReadyStatus
        document={openDocumentFor({ undoBytes: 2048, undoEntryCount: 3 })}
        caretOffset={0}
      />
    )

    const panel = container.querySelector('.statistics-panel')
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('C:/docs/data.json')
    expect(panel!.textContent).toContain('Undo history')
    expect(panel!.textContent).toContain('3 entries')
  })

  it('Escape closes the panel and returns focus to the ⓘ button', async () => {
    await paint(<ReadyStatus document={openDocumentFor()} caretOffset={0} />)
    const infoButton = container.querySelector<HTMLButtonElement>('#status-bar-info-button')!
    infoButton.click()
    await paint(<ReadyStatus document={openDocumentFor()} caretOffset={0} />)

    const panel = container.querySelector<HTMLDivElement>('.statistics-panel')!
    expect(panel).not.toBeNull()
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await paint(<ReadyStatus document={openDocumentFor()} caretOffset={0} />)

    expect(container.querySelector('.statistics-panel')).toBeNull()
    expect(document.activeElement?.id).toBe('status-bar-info-button')
  })

  it('klados.document.statistics is registered and palette-reachable', () => {
    const command = getAllCommands().find((c) => c.id === 'klados.document.statistics')
    expect(command).toBeDefined()
    expect(command!.surfaces).toContain('palette')
  })

  it('klados.edit.clearUndoHistory is registered, palette-only', () => {
    const command = getAllCommands().find((c) => c.id === 'klados.edit.clearUndoHistory')
    expect(command).toBeDefined()
    expect(command!.surfaces).toEqual(['palette'])
  })
})
