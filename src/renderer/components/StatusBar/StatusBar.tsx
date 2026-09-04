/**
 * M5f-PLAN.md — VS Code's layout: a left group for document *state*
 * (diagnostics, info) and a right group for document *facts* (position,
 * encoding, format, size). Every item is unconditional (always rendered,
 * at zero/whatever the value is) so the strip never reflows — the read-only
 * badge §11.2 asked for was considered and dropped for exactly this reason
 * (§4b's amendment); the memory figure moved into the statistics panel for
 * the opposite reason (§4a: it changes constantly, which is what made the
 * live-region defect below audible).
 *
 * No `role="status"` on the container — the old version recomputed a
 * memory figure on every render inside a live region, so a screen reader
 * announced it continuously. If any one item should announce itself, it's
 * the diagnostic count, and it can carry its own live region; the whole
 * bar should not.
 */
import { useSyncExternalStore, type JSX } from 'react'
import { Severity } from '../../../core/types'
import { lineAtOffset, offsetOfLine } from '../../../core/rowIndex'
import { getCommand } from '../../commands/registry'
import { runCommand } from '../../commands/uiHelpers'
import { getFormatCapabilities } from '../../../formats/registry'
import type { OpenDocument } from '../../session/documentSession'
import { formatBytes } from '../../session/documentSession'
import { useDocumentSession } from '../../session/useDocumentSession'
import { hasMeaningfulLines } from '../Detail/detailModel'
import { Icon } from '../Icon/Icon'
import { openPalette } from '../Palette/paletteStore'
import { StatisticsPanel } from './StatisticsPanel'
import {
  openStatisticsPanel,
  isStatisticsPanelOpen,
  subscribeStatisticsPanelOpen
} from './statisticsPanelStore'
import './StatusBar.css'

export function StatusBar(): JSX.Element {
  const state = useDocumentSession()

  // The strip's own height is reserved unconditionally, ready or not — so
  // panes above it don't reflow the instant a document finishes loading.
  return (
    <div className="status-bar">
      {state.phase === 'ready' && (
        <ReadyStatus document={state.document} caretOffset={state.selection.caretOffset} />
      )}
    </div>
  )
}

function caretPositionLabel(document: OpenDocument, caretOffset: number): string {
  const { sourceBuffer, rowIndex, lineIndex } = document
  if (hasMeaningfulLines(lineIndex, sourceBuffer.byteLength)) {
    const line = lineAtOffset(sourceBuffer.bytes, rowIndex, lineIndex, caretOffset)
    const lineStart = offsetOfLine(sourceBuffer.bytes, rowIndex, lineIndex, line)
    const column = caretOffset - lineStart + 1
    return `Ln ${line.toLocaleString()}, Col ${column.toLocaleString()}`
  }
  return `Byte ${caretOffset.toLocaleString()}`
}

/** Exported for `test/statusBar.test.tsx` — `StatusBar` itself reads
 * `useDocumentSession()`, a module-level singleton a from-scratch render
 * can't easily stand up in isolation; this takes its document as a plain
 * prop, so a test can drive it directly (same reasoning `Tree.tsx`'s own
 * `TreeContent` export gives). */
export function ReadyStatus({
  document,
  caretOffset
}: {
  readonly document: OpenDocument
  readonly caretOffset: number
}): JSX.Element {
  const panelOpen = useSyncExternalStore(
    subscribeStatisticsPanelOpen,
    isStatisticsPanelOpen,
    isStatisticsPanelOpen
  )

  const errorCount = document.diagnostics.filter(
    (d) => d.severity === Severity.Error || d.severity === Severity.Fatal
  ).length
  const warningCount = document.diagnostics.filter((d) => d.severity === Severity.Warning).length

  // `klados.navigate.nextDiagnostic` has no `enabledWhen` of its own (its
  // `when: 'hasDiagnostics'` was written for the palette, which hides
  // rather than disables) — the strip needs "disabled, not hidden" (D-056),
  // so it computes the same condition directly rather than relying on a
  // gate the command doesn't carry.
  const nextDiagnostic = getCommand('klados.navigate.nextDiagnostic')
  const diagnosticsEnabled = (errorCount > 0 || warningCount > 0) && nextDiagnostic !== undefined

  const displayName = getFormatCapabilities(document.formatId)?.displayName ?? document.formatId

  return (
    <>
      <div className="status-bar-group status-bar-group-left">
        <button
          type="button"
          className="status-bar-item status-bar-clickable"
          disabled={!diagnosticsEnabled}
          onClick={() => nextDiagnostic !== undefined && runCommand(nextDiagnostic)}
          title="Next Diagnostic"
        >
          <Icon name="error-circle" /> {errorCount.toLocaleString()}
        </button>
        <button
          type="button"
          className="status-bar-item status-bar-clickable"
          disabled={!diagnosticsEnabled}
          onClick={() => nextDiagnostic !== undefined && runCommand(nextDiagnostic)}
          title="Next Diagnostic"
        >
          <Icon name="warning" /> {warningCount.toLocaleString()}
        </button>
        <div className="status-bar-info-anchor">
          <button
            type="button"
            id="status-bar-info-button"
            className="status-bar-item status-bar-clickable"
            aria-expanded={panelOpen}
            aria-haspopup="dialog"
            onClick={() => openStatisticsPanel()}
            title="Document Statistics"
          >
            <Icon name="info" />
          </button>
          {panelOpen && <StatisticsPanel document={document} />}
        </div>
      </div>
      <div className="status-bar-group status-bar-group-right">
        <button
          type="button"
          className="status-bar-item status-bar-clickable"
          onClick={() => openPalette(':')}
          title={
            hasMeaningfulLines(document.lineIndex, document.sourceBuffer.byteLength)
              ? 'Go to Line'
              : 'Go to Byte Offset'
          }
        >
          {caretPositionLabel(document, caretOffset)}
        </button>
        <span className="status-bar-item">{document.encoding}</span>
        <span className="status-bar-item">{displayName}</span>
        <span className="status-bar-item">{formatBytes(document.sourceBuffer.byteLength)}</span>
      </div>
    </>
  )
}
