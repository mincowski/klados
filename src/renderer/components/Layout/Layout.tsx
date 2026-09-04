/**
 * The layout shell (M1-PLAN.md D7, CONCEPT.md §4.1): the three panes and
 * their dividers. Reachable layouts are exactly the five CONCEPT.md names
 * — see `layoutLogic.ts`'s module comment for how the three toggles are
 * constrained to produce that set.
 *
 * Raw stacks below Detail, never beside it (§4.1) — both panes are
 * width-hungry for the same reason, so the Detail/Raw column is a vertical
 * split and Tree is a separate horizontal split to its left.
 *
 * R21-notifications.md / R22: the alert strip that used to sit above
 * `.layout-body` (`DocumentStatus`, M5d-PLAN.md R3) is gone — every message
 * it used to show moved to `<Notifications />` (`position: fixed`, mounted
 * as a sibling of `StatusBar` here but never part of layout flow), so the
 * panes' pixel geometry no longer shifts when a message appears.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore, type DragEvent, type JSX } from 'react'
import { getContext, subscribeContext } from '../../commands/context'
import { commandsForSurface } from '../../commands/registry'
import { runCommand, tooltipFor } from '../../commands/uiHelpers'
import type { FocusablePane, Pane } from '../../focus'
import { focusPaneOrFirstAvailable, registerPane } from '../../focus'
import { getKladosApi } from '../../preloadApi'
import { openPathInNewTab } from '../../session/tabs'
import { useDocumentSession } from '../../session/useDocumentSession'
import { Detail } from '../Detail/Detail'
import { FindBar } from '../Find/FindBar'
import { Icon } from '../Icon/Icon'
import { Notifications } from '../../notifications/Notifications'
import { Raw } from '../Raw/Raw'
import { StatusBar } from '../StatusBar/StatusBar'
import { Tree } from '../Tree/Tree'
import { DocumentArea } from './DocumentArea'
import {
  getLayoutState,
  setRawHeight,
  setTreeWidth,
  subscribeLayout,
  type LayoutState
} from './layoutStore'
import './Layout.css'

/** Wraps a pane's content, registering it with the focus model (D4) for as
 * long as it's mounted — a hidden pane simply isn't in the tree, so it
 * un-registers itself for free rather than needing a visibility check. */
function PaneShell(props: {
  readonly pane: Pane
  readonly label: string
  readonly children: React.ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const context = useSyncExternalStore(subscribeContext, getContext, getContext)
  const headerCommands = commandsForSurface('paneHeader', context).filter(
    (command) => command.pane === props.pane
  )

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    return registerPane(props.pane, element as unknown as FocusablePane)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pane` is fixed for the lifetime of a given PaneShell instance
  }, [])

  return (
    <div className="pane">
      <div className="pane-header">
        <span className="pane-header-label">{props.label}</span>
        {headerCommands.length > 0 && (
          <div className="pane-header-actions">
            {headerCommands.map((command) => (
              <button
                key={command.id}
                type="button"
                className="pane-header-button"
                title={tooltipFor(command)}
                aria-label={tooltipFor(command)}
                onClick={() => runCommand(command)}
              >
                {command.icon !== undefined ? <Icon name={command.icon} /> : command.title}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="pane-body" ref={ref} tabIndex={-1} role="region" aria-label={props.label}>
        {props.children}
      </div>
    </div>
  )
}

/**
 * `onDelta` receives the pointer's offset from where the drag started along
 * `axis`, plus the layout as it stood at that moment, on every `pointermove`
 * until release.
 *
 * The baseline is read straight from `getLayoutState()` at the moment the
 * pointer goes down, not from a piece of React state set just beforehand —
 * `setState` doesn't apply until React re-renders, so a value set in the
 * same handler that starts the drag would still read as its *previous*
 * value for the closures created here, and every delta for the entire
 * gesture would be computed against a stale baseline (visibly: the pane
 * jumping to roughly the pointer's raw offset instead of moving from where
 * the divider actually was).
 */
function useDividerDrag(
  axis: 'x' | 'y',
  onDelta: (deltaPx: number, baseline: LayoutState) => void
): (event: React.PointerEvent) => void {
  return (event: React.PointerEvent) => {
    event.preventDefault()
    const start = axis === 'x' ? event.clientX : event.clientY
    const baseline = getLayoutState()

    function onMove(moveEvent: PointerEvent): void {
      const current = axis === 'x' ? moveEvent.clientX : moveEvent.clientY
      onDelta(current - start, baseline)
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
}

/** A file dropped anywhere on the window opens it — the drag-drop half of
 * D6's "opens by dialog, drag-drop, and command," alongside `openDialog`
 * and `klados.document.open`. `getPathForFile` (preload, `webUtils`)
 * replaces the `File.path` Electron removed from the renderer-side `File`
 * object. R26 (`R24-tabs.md` §4): opens into a new tab, the same
 * "opening a file never touches whatever's already open" rule
 * `klados.document.open` now follows — a dropped file used to silently
 * replace the active tab's own document. */
function onDragOver(event: DragEvent<HTMLDivElement>): void {
  event.preventDefault()
}

function onDrop(event: DragEvent<HTMLDivElement>): void {
  event.preventDefault()
  const file = event.dataTransfer.files[0]
  if (file === undefined) return
  const api = getKladosApi()
  if (api === undefined) return
  const path = api.document.getPathForFile(file)
  openPathInNewTab(path)
}

export function Layout(): JSX.Element {
  const layout = useSyncExternalStore(subscribeLayout, getLayoutState, getLayoutState)
  const documentState = useDocumentSession()
  const columnRef = useRef<HTMLDivElement>(null)

  // R69 (`R69-focus-and-find.md` §1): nothing ever moved focus into a
  // pane after a document opened — the arrow keys still pointed wherever
  // they were (the Open button, or nowhere). Tree, per the report and the
  // plan's own recommendation: it's the navigable pane the arrow keys serve
  // best, and `focusPaneOrFirstAvailable` falls back to whichever pane is
  // actually visible if Tree itself is collapsed. Panes register with the
  // focus model in their own mount effects (`PaneShell`'s `useEffect`
  // above) — React runs child effects before a parent's on the same commit,
  // so by the time this one runs, `ready`'s newly-mounted panes are already
  // registered.
  //
  // Gated on an actual phase *transition* into `ready`, not "phase is
  // ready" — comparing against the previous render's value (not `useRef`'s
  // own initial snapshot alone) is what keeps a restored-ready session on
  // startup from stealing focus the instant the app opens, since the very
  // first render's "previous" is the same value as its own "current."
  // Switching between two tabs that are *both* already `ready` doesn't
  // retrigger this either, for the same reason (`Object.is('ready',
  // 'ready')` never changes). The one broadened case, accepted rather than
  // engineered around: switching from a non-ready tab (freshly created and
  // still empty, say) back to an already-`ready` one also focuses Tree —
  // not strictly "opening," but a reasonable thing for a tab switch to do
  // too, not a false positive worth a tab-identity-tracking mechanism.
  const previousPhaseRef = useRef(documentState.phase)
  useEffect(() => {
    const previous = previousPhaseRef.current
    previousPhaseRef.current = documentState.phase
    if (previous !== 'ready' && documentState.phase === 'ready') {
      focusPaneOrFirstAvailable('tree')
    }
  }, [documentState.phase])

  const onTreeDividerDown = useDividerDrag('x', (deltaPx, baseline) => {
    setTreeWidth(baseline.treeWidth + deltaPx)
  })
  const onRawDividerDown = useDividerDrag('y', (deltaPx, baseline) => {
    const columnHeight = columnRef.current?.clientHeight ?? 1
    setRawHeight(baseline.rawHeight - deltaPx / columnHeight)
  })

  const rawHeightPercent = useMemo(
    () => `${Math.round(layout.rawHeight * 100)}%`,
    [layout.rawHeight]
  )

  return (
    <div className="layout" onDragOver={onDragOver} onDrop={onDrop}>
      <div className="layout-body">
        {documentState.phase !== 'ready' ? (
          <DocumentArea />
        ) : (
          <>
            {layout.treeVisible && (
              <>
                <div className="layout-tree" style={{ width: layout.treeWidth }}>
                  <PaneShell pane="tree" label="Tree">
                    <Tree />
                  </PaneShell>
                </div>
                <div
                  className="layout-divider layout-divider-vertical"
                  onPointerDown={onTreeDividerDown}
                />
              </>
            )}
            <div className="layout-column" ref={columnRef}>
              {layout.detailVisible && (
                // Always grows to fill whatever Raw's fixed height (below,
                // when both are visible) doesn't take — Raw is the one pane
                // with an explicit size; Detail always takes the remainder.
                <div className="layout-detail" style={{ flex: 1 }}>
                  <PaneShell pane="detail" label="Detail">
                    <Detail />
                  </PaneShell>
                </div>
              )}
              {layout.detailVisible && layout.rawVisible && (
                <div
                  className="layout-divider layout-divider-horizontal"
                  onPointerDown={onRawDividerDown}
                />
              )}
              {layout.rawVisible && (
                <div
                  className="layout-raw"
                  style={{ flex: layout.detailVisible ? `0 0 ${rawHeightPercent}` : 1 }}
                >
                  <PaneShell pane="raw" label="Raw Source">
                    <Raw />
                  </PaneShell>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {/* R70 (`R69-focus-and-find.md` §2): was mounted inside
       * `Raw.tsx`, which made `Ctrl+F` inert whenever the Raw pane was
       * hidden — Find is document-wide (D-038), only its old *mount point*
       * was Raw-scoped. `.layout` (not `App.tsx`'s `<main>`) is what it's
       * `position: absolute` against now — `.layout` already sits entirely
       * below the title bar and tab strip (M5d-PLAN.md R1's own flex
       * column), so anchoring here keeps R8e's fix (never colliding with
       * Windows' caption-button overlay) without needing a pixel offset
       * that guesses the title bar's height, which a viewport-`fixed`
       * mount at the app shell would have had to. */}
      <FindBar />
      <StatusBar />
      <Notifications />
    </div>
  )
}
