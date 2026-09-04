/**
 * M5c-PLAN.md J8 — the phase-aware document area `Layout` swaps in for the
 * pane grid whenever the session isn't `ready` (CONCEPT.md's five reachable
 * layouts always keep at least one pane visible once it is). Replaces the
 * old `EmptyState.tsx`, widened past just the `empty` phase: before this,
 * `confirmSize`/`parsing`/`error` rendered as small text beside the Open
 * button in the command bar (the retired `DocumentStatus.tsx`, M5d-PLAN.md
 * R3), so "Opening file.xml… 43%" competed for space with a toolbar rather
 * than getting the whole window a phase this size actually warrants
 * (M5c-PLAN.md appendix, "open progress shown by the Open button").
 *
 * R21-notifications.md / R22: `DocumentStatus.tsx` is gone — the `ready`
 * phase's own content it used to hold (the diagnostic banner, the minified
 * banner, the pending-transform confirmation) now lives in
 * `notifications/Notifications.tsx`. This component still owns every
 * non-`ready` phase and keeps `data-testid="document-status"`/`data-phase`
 * on its own root, since a fair amount of existing test setup keys off
 * that name — kept for continuity, not because a `DocumentStatus`
 * component exists to share it with anymore.
 */
import { useSyncExternalStore, type JSX } from 'react'
import { getCommand } from '../../commands/registry'
import { runCommand } from '../../commands/uiHelpers'
import { activeSession } from '../../session/activeSession'
import { formatBytes, type DocumentSessionState } from '../../session/documentSession'
import { getRecentFiles, subscribeRecentFiles, type RecentFile } from '../../session/recentFiles'
import { useDocumentSession } from '../../session/useDocumentSession'
import { formatGlyphOf } from '../TabStrip/tabDisplay'
import { splitForMiddleTruncation } from '../../textTruncate'
import './DocumentArea.css'

function formatPercent(bytesConsumed: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0
  return Math.min(100, Math.round((bytesConsumed / totalBytes) * 100))
}

export function DocumentArea(): JSX.Element {
  const state = useDocumentSession()
  return (
    <div className="document-area" data-testid="document-status" data-phase={state.phase}>
      {renderPhase(state)}
    </div>
  )
}

/** R96 (`R95-recent-files.md` §4): the directory half of a recent-file row
 * — everything before the file name that's already stored alongside it,
 * so no second path-parsing rule needs to agree with `fileNameOf`
 * (`documentSession.ts`'s own, not exported for exactly this reason: the
 * two would drift). Empty for a bare file name with no directory at all. */
function directoryOf(entry: RecentFile): string {
  return entry.path.slice(0, entry.path.length - entry.fileName.length).replace(/[\\/]+$/, '')
}

/** R96 / R104 addendum: a row shows the format glyph, the file name and the
 * directory — both strings through `splitForMiddleTruncation`
 * (`TabStrip.tsx`/`TitleBar.tsx`'s own truncation). The directory is always
 * shown, not just on a name collision — the tab strip's own disambiguation
 * only kicks in for two *open* tabs sharing a name; two entries in six
 * recent files are exactly as likely to collide with nothing open to
 * compare against.
 *
 * **Only the file name is clickable.** R105 (`R104-start-pane-polish.md`
 * §4) deliberately made the whole row a `<button>` for the larger hit
 * target — reversed here: a row that looks like a link (accent text) but
 * responds to a click anywhere in its whitespace reads as broken, not
 * generous. The name carries `title={entry.path}` (moved off the row,
 * since the row is no longer the interactive element) so the full path is
 * still available on hover. */
function RecentFileRow({ entry }: { readonly entry: RecentFile }): JSX.Element {
  const { glyph, colorVar } = formatGlyphOf(entry.formatId)
  const name = splitForMiddleTruncation(entry.fileName)
  const directory = directoryOf(entry)
  const dir = splitForMiddleTruncation(directory)

  return (
    <div className="document-area-recent-row">
      <span className="document-area-recent-glyph" aria-hidden="true" style={{ color: colorVar }}>
        {glyph}
      </span>
      <button
        type="button"
        className="document-area-recent-name"
        title={entry.path}
        onClick={() => void activeSession.openPath(entry.path)}
      >
        {name.head !== '' && <span className="document-area-recent-head">{name.head}</span>}
        <span className="document-area-recent-tail">{name.tail}</span>
      </button>
      {directory !== '' && (
        <span className="document-area-recent-dir">
          {dir.head !== '' && <span className="document-area-recent-head">{dir.head}</span>}
          <span className="document-area-recent-tail">{dir.tail}</span>
        </span>
      )}
    </div>
  )
}

/** R95 §2: the six rows are data — clicking one is a selection, not a
 * command (invariant 10 covers commands, not this). Clear is the one
 * action, run through the registry like `Layout.tsx`'s own pane-header
 * buttons, rather than calling `clearRecentFiles()` directly. */
function RecentFilesColumn(): JSX.Element {
  const recent = useSyncExternalStore(subscribeRecentFiles, getRecentFiles, getRecentFiles)

  return (
    <section className="document-area-column document-area-recent-column">
      <h2>Recent</h2>
      {recent.length === 0 ? (
        <p className="document-area-empty-inline">No recent files.</p>
      ) : (
        <>
          <div className="document-area-recent-list">
            {recent.map((entry) => (
              <RecentFileRow key={entry.path} entry={entry} />
            ))}
          </div>
          <div className="document-area-actions">
            <button
              type="button"
              onClick={() => {
                const command = getCommand('klados.document.clearRecentFiles')
                if (command !== undefined) runCommand(command)
              }}
            >
              Clear
            </button>
          </div>
        </>
      )}
    </section>
  )
}

/** R96 §4 / R104: the `error` banner (R97's dead-end fix) hoists above both
 * sections when present — it describes the whole state, not just the first
 * one. The `empty` phase passes no heading at all: "No document open." was
 * found to be noise once the two sections already say that. Open comes
 * first (the primary action, first in reading and tab order; a leading
 * empty Recent section on a fresh install would otherwise read as broken
 * layout), Recent second. R104 stacks them vertically rather than side by
 * side — `DocumentArea.css`'s own comment on `.document-area-columns`
 * covers why. */
function StartColumns({ heading }: { readonly heading?: JSX.Element }): JSX.Element {
  return (
    <div className="document-area-start">
      {heading}
      <div className="document-area-columns">
        <section className="document-area-column document-area-open-column">
          <h2>Open</h2>
          <p className="document-area-hint">
            Press <kbd>Ctrl+O</kbd>, drag a file onto this window, or open the palette (
            <kbd>Ctrl+Shift+P</kbd>).
          </p>
          <div className="document-area-actions">
            <button type="button" onClick={() => void activeSession.openFileDialog()}>
              Open File…
            </button>
          </div>
        </section>
        <RecentFilesColumn />
      </div>
    </div>
  )
}

function renderPhase(state: DocumentSessionState): JSX.Element {
  switch (state.phase) {
    case 'empty':
      return <StartColumns />

    case 'confirmSize':
      return (
        <div className="document-area-confirm" role="status">
          {/* R28 (`R24-tabs.md` §6): `reason` distinguishes this
           * file's own size from the cross-tab total pushing past the
           * configured budget — same confirm/cancel shape either way, the
           * message is what actually differs. */}
          {state.reason === 'size' ? (
            <p>
              {state.fileName} is {formatBytes(state.fileBytes)} — estimated memory use ~
              {formatBytes(state.estimatedBytes)}. Continue?
            </p>
          ) : (
            <p>
              Opening {state.fileName} (~{formatBytes(state.estimatedBytes)}) would bring total
              memory across open tabs to ~{formatBytes(state.totalEstimatedBytes ?? 0)}, over the
              configured budget. Continue?
            </p>
          )}
          <div className="document-area-actions">
            <button type="button" onClick={() => activeSession.confirmOpenAnyway()}>
              Continue
            </button>
            <button type="button" onClick={() => activeSession.cancel()}>
              Cancel
            </button>
          </div>
        </div>
      )

    case 'parsing': {
      const percent = formatPercent(state.bytesConsumed, state.totalBytes)
      return (
        <div className="document-area-parsing" role="status">
          <p>Opening {state.fileName}…</p>
          <div
            className="document-area-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="document-area-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="document-area-hint">{percent}%</p>
          <div className="document-area-actions">
            <button type="button" onClick={() => activeSession.cancel()}>
              Cancel
            </button>
          </div>
        </div>
      )
    }

    case 'error':
      // R97 (`R95-recent-files.md` §5): the two-column layout renders here
      // too, under the error banner — retiring the dead end
      // `DocumentArea.tsx` used to be (a lone Open File… button, no way
      // back to the recent list once one entry failed). `StartColumns`'s
      // own Open button still works alongside it, unchanged.
      return (
        <StartColumns
          heading={
            <p className="document-area-banner document-area-banner-error" role="alert">
              {state.message}
            </p>
          }
        />
      )

    case 'ready':
      // `Layout` only mounts this component while `phase !== 'ready'` —
      // unreachable in practice, kept only so the switch stays exhaustive
      // against `DocumentSessionState`'s full phase union.
      return <></>
  }
}
