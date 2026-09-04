/**
 * M5d-PLAN.md R1 — Klados's own drawn title bar (`docs/DECISIONS.md`
 * D-055): a frameless window on Windows/macOS with `-webkit-app-region:
 * drag` standing in for the five things a native title bar used to give
 * away for free (§1's table) — caption buttons, Snap Layouts, focus/blur
 * dimming, drag-to-move/double-click-to-maximize, and the title itself.
 *
 * Mounted once in `App.tsx`, above `Layout`, since it carries window scope
 * (D-055) rather than anything specific to the pane grid — it stays present
 * across every `DocumentSessionState` phase, not just `'ready'`.
 */
import { useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { TITLE_BAR_HEIGHT_PX } from '../../../shared/titleBar'
import { getContext, subscribeContext } from '../../commands/context'
import type { ContextKeys } from '../../commands/context'
import {
  commandsForSurfaceUnfiltered,
  isCommandEnabled,
  type Command
} from '../../commands/registry'
import { runCommand, tooltipFor } from '../../commands/uiHelpers'
import { getKladosApi } from '../../preloadApi'
import { useDocumentSession } from '../../session/useDocumentSession'
import { getTheme, subscribeTheme } from '../../theme'
import { splitForMiddleTruncation } from '../../textTruncate'
import { Icon } from '../Icon/Icon'
import { Mark } from './Mark'
import './TitleBar.css'

/** Syncs `theme.ts`'s state to the OS-drawn caption strip on every change,
 * including on mount — the renderer owns the theme (`theme.ts`); only main
 * can call `BrowserWindow.setTitleBarOverlay`, so this is the one bridge
 * between the two, kept narrow (`titleBar.setOverlayColors`, not a general
 * "call anything on the window" surface). A no-op on platforms without an
 * overlay to recolour (`preload/index.ts`'s own platform branch). */
function useTitleBarOverlaySync(): void {
  useEffect(() => {
    const api = getKladosApi()
    if (api === undefined) return
    const sync = (): void => void api.titleBar.setOverlayColors(getTheme())
    sync()
    return subscribeTheme(sync)
  }, [])
}

/** R1: the OS no longer dims the bar on window blur — this is the
 * replacement, a main→renderer channel since focus/blur are main-process
 * events (`BrowserWindow.on('focus'/'blur')`). */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true)
  useEffect(() => {
    return getKladosApi()?.titleBar.onFocusChange(setFocused)
  }, [])
  return focused
}

/** R6 (macOS): the traffic-light inset must collapse in fullscreen, where
 * the lights themselves hide — nothing to reserve space for there. */
function useFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    return getKladosApi()?.titleBar.onFullscreenChange(setFullscreen)
  }, [])
  return fullscreen
}

/** R7: one button per command, disabled (not absent) per `enabledWhen` —
 * see `Command.enabledWhen`'s own doc comment for why this reads
 * `commandsForSurfaceUnfiltered` rather than the palette/pane-header
 * `commandsForSurface`. */
function TitleBarButtons(props: {
  readonly commands: readonly Command[]
  readonly context: ContextKeys
}): JSX.Element | null {
  if (props.commands.length === 0) return null
  return (
    <div className="title-bar-actions title-bar-no-drag">
      {props.commands.map((command) => (
        <button
          key={command.id}
          type="button"
          className="title-bar-button"
          title={tooltipFor(command)}
          aria-label={tooltipFor(command)}
          disabled={!isCommandEnabled(command, props.context)}
          onClick={() => runCommand(command)}
        >
          {command.icon !== undefined ? <Icon name={command.icon} /> : command.title}
        </button>
      ))}
    </div>
  )
}

/** R5: the window title is the open document, not a static "Klados" —
 * leading-aligned right after the mark (a deliberate pick over centring,
 * consistent with the drag region's own left-to-right layout; recorded
 * here rather than left to CSS accident). Middle-truncated via
 * `textTruncate.ts` so a long filename keeps its extension visible; the
 * amber dot is the same unsaved-changes mark `assets/README.md` already
 * reserves, and the tooltip carries the full absolute path since the
 * visible text may be truncated or just a bare filename either way. */
function Title(): JSX.Element {
  const state = useDocumentSession()
  if (state.phase !== 'ready') {
    return <span className="title-bar-title">Klados</span>
  }
  const { fileName, filePath, dirty } = state.document
  const { head, tail } = splitForMiddleTruncation(fileName)
  return (
    <span className="title-bar-title" title={filePath}>
      {head !== '' && <span className="title-bar-title-head">{head}</span>}
      <span className="title-bar-title-tail">{tail}</span>
      {dirty && <span className="title-bar-dirty-dot" role="img" aria-label="Unsaved changes" />}
    </span>
  )
}

export function TitleBar(): JSX.Element {
  useTitleBarOverlaySync()
  const focused = useWindowFocused()
  const fullscreen = useFullscreen()
  const platform = getKladosApi()?.titleBar.platform ?? 'win32'
  const context = useSyncExternalStore(subscribeContext, getContext, getContext)
  const allCommands = commandsForSurfaceUnfiltered('titleBar')
  // D-055: Save/Undo/Redo are document scope, placed beside the filename
  // (R5); the pane toggles are window scope and sit at the far end, next
  // to where Windows' own caption buttons paint. `category` already
  // distinguishes them ('Edit'/'File' vs 'View') without a second,
  // parallel classification to keep in sync.
  const documentCommands = allCommands.filter((command) => command.category !== 'View')
  const windowCommands = allCommands.filter((command) => command.category === 'View')

  return (
    <div
      className={`title-bar title-bar-${platform}${focused ? '' : ' title-bar-blurred'}`}
      style={{ height: TITLE_BAR_HEIGHT_PX }}
    >
      {platform === 'darwin' && !fullscreen && <div className="title-bar-mac-inset" />}
      <div className="title-bar-title-area">
        <Mark />
        <Title />
      </div>
      <TitleBarButtons commands={documentCommands} context={context} />
      <div className="title-bar-spacer" />
      <TitleBarButtons commands={windowCommands} context={context} />
    </div>
  )
}
