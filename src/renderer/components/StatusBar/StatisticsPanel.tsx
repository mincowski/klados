/**
 * The statistics panel (M5f-PLAN.md §3) — opened by the status bar's `ⓘ`
 * item and, per invariant 10, also `klados.document.statistics`
 * (`commands.ts`), so it's palette-reachable independent of the icon.
 *
 * There is no popover component in this codebase yet (checked before
 * writing this one) — built anchored and dismissible (Escape, outside
 * click, focus returned to the `ⓘ`) rather than reusing the palette's
 * full-screen overlay, which is a different weight of thing entirely.
 * `elev-2-bg`/`elev-2-shadow` (the pair, invariant 9 — a shadow alone
 * doesn't read on dark surfaces), the same tokens `Find.css`'s own
 * anchored floating panel uses.
 */
import { useEffect, useRef, useSyncExternalStore, type JSX, type KeyboardEvent } from 'react'
import { Severity } from '../../../core/types'
import { getFormatCapabilities } from '../../../formats/registry'
import type { OpenDocument } from '../../session/documentSession'
import { formatBytes } from '../../session/documentSession'
import { getCrossTabMemoryBytes, getTabIds, subscribeTabs } from '../../session/tabs'
import { computeMemoryBudget } from './memoryBudget'
import { closeStatisticsPanel } from './statisticsPanelStore'
import './StatisticsPanel.css'

function focusInfoButton(): void {
  document.getElementById('status-bar-info-button')?.focus()
}

export function StatisticsPanel({
  document: doc
}: {
  readonly document: OpenDocument
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)

  // Focus moves into the panel on open so Escape/Tab work immediately —
  // otherwise focus stays on the `ⓘ` button itself and a keyboard user's
  // first Escape would do nothing (the button, not the panel, has focus).
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (panelRef.current !== null && !panelRef.current.contains(event.target as Node)) {
        closeStatisticsPanel()
      }
    }
    // `mousedown`, not `click` — the same reasoning the palette's own
    // outside-click listener uses (`Palette.tsx`): catches the interaction
    // before a subsequent focus change would make "was this still open"
    // ambiguous.
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  function close(): void {
    closeStatisticsPanel()
    focusInfoButton()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  const budget = computeMemoryBudget(doc)
  const sourceBytes = doc.sourceBuffer.byteLength
  const multiplier = sourceBytes > 0 ? budget.totalBytes / sourceBytes : 1
  // R28 (`R24-tabs.md` §6): the cross-tab figure D-060 already
  // promised would land here once tabs existed. Re-subscribed on tab
  // set/active changes (`subscribeTabs`) — not on every keystroke in a
  // background tab, which this transient, opened-on-demand popover doesn't
  // need to track live the way the always-visible tab strip's own labels
  // do (`TabStrip.tsx`'s `useTabDisplayInfos`).
  const tabCount = useSyncExternalStore(subscribeTabs, getTabIds, getTabIds).length
  const crossTabBytes = useSyncExternalStore(
    subscribeTabs,
    () => getCrossTabMemoryBytes(),
    () => getCrossTabMemoryBytes()
  )
  const displayName = getFormatCapabilities(doc.formatId)?.displayName ?? doc.formatId
  const errorCount = doc.diagnostics.filter(
    (d) => d.severity === Severity.Error || d.severity === Severity.Fatal
  ).length
  const warningCount = doc.diagnostics.filter((d) => d.severity === Severity.Warning).length

  return (
    <div
      ref={panelRef}
      className="statistics-panel"
      role="dialog"
      aria-label="Document Statistics"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <button type="button" className="statistics-panel-close" onClick={close} aria-label="Close">
        ×
      </button>

      <dl className="statistics-panel-facts">
        <dt>Path</dt>
        <dd className="statistics-panel-path">{doc.filePath}</dd>
        <dt>Format</dt>
        <dd>{displayName}</dd>
        <dt>Encoding</dt>
        <dd>{doc.encoding}</dd>
        <dt>Size on disk</dt>
        <dd>{formatBytes(sourceBytes)}</dd>
        <dt>Nodes</dt>
        <dd>{doc.store.nodeCount.toLocaleString()}</dd>
        <dt>Diagnostics</dt>
        <dd>
          {errorCount.toLocaleString()} error{errorCount === 1 ? '' : 's'},{' '}
          {warningCount.toLocaleString()} warning{warningCount === 1 ? '' : 's'}
        </dd>
      </dl>

      <h3 className="statistics-panel-heading">Memory</h3>
      <table className="statistics-panel-memory">
        <tbody>
          <tr>
            <th>Source buffer</th>
            <td>{formatBytes(budget.sourceBufferBytes)}</td>
          </tr>
          <tr>
            <th>Node store</th>
            <td>{formatBytes(budget.nodeStoreBytes)}</td>
          </tr>
          <tr>
            <th>Row index</th>
            <td>{formatBytes(budget.rowIndexBytes)}</td>
          </tr>
          <tr>
            <th>Line index</th>
            <td>{formatBytes(budget.lineIndexBytes)}</td>
          </tr>
          <tr>
            <th>Name index</th>
            <td>{formatBytes(budget.nameIndexBytes)}</td>
          </tr>
          <tr>
            <th>
              Undo history
              {budget.undoEntryCount > 0 && (
                <span className="statistics-panel-undo-count">
                  {' '}
                  ({budget.undoEntryCount.toLocaleString()}{' '}
                  {budget.undoEntryCount === 1 ? 'entry' : 'entries'})
                </span>
              )}
            </th>
            <td>{formatBytes(budget.undoBytes)}</td>
          </tr>
          <tr className="statistics-panel-total">
            <th>Total</th>
            <td>
              {formatBytes(budget.totalBytes)} (~{multiplier.toFixed(1)}×)
            </td>
          </tr>
          {tabCount > 1 && (
            <tr className="statistics-panel-cross-tab">
              <th>All tabs ({tabCount})</th>
              <td>{formatBytes(crossTabBytes)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
