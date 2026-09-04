/**
 * The command palette (M1-PLAN.md D5/D14, CONCEPT.md §7). `>` (the
 * default, no prefix required): fuzzy search over the registry, filtered
 * by the live `when` context, recently-used first. `@` (jump to node):
 * exact fuzzy search over node names via the name index (`nodeNameSearch.ts`,
 * M4-PLAN.md G1). `:` (go to
 * position): a line number or byte offset (`goToPosition.ts`), whichever
 * the document's own shape calls for. The last two render a disabled
 * placeholder without a document open — the palette doesn't change shape
 * when one is.
 *
 * Elevated surface (§9.4): an overlay plus a floating panel, never inline
 * in the layout. Keyboard-only throughout, ARIA `combobox`/`listbox` per
 * §11.5.
 *
 * Split into an outer `Palette` and an inner `PaletteContent` deliberately:
 * `PaletteContent` only exists in the tree while the palette is open, so
 * its `input`/`activeIndex` state starts fresh on every open by virtue of
 * mounting fresh — no "reset on open" effect, and so no effect that calls
 * `setState` synchronously in its body (which trades one render for a
 * second, cascading one — react-hooks flags it precisely for that reason).
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent
} from 'react'
import type { NodeRef } from '../../../core/types'
import type { NodeStore } from '../../../core/nodeStore'
import { parsePath, type PathDiagnostic } from '../../../core/path/parse'
import { getContext, subscribeContext, type ContextKeys } from '../../commands/context'
import { effectiveChordFor, formatChord } from '../../commands/keybindings'
import { commandsForSurface, type AppContext } from '../../commands/registry'
import { focusPaneOrFirstAvailable, type Pane } from '../../focus'
import { openFindWithQuery } from '../Find/findStore'
import { scrubRawTo } from '../Raw/rawController'
import { locateInTree } from '../Tree/treeController'
import { parseGoToPosition, type GoToPosition } from '../../navigation/goToPosition'
import { hasMeaningfulLines } from '../Detail/detailModel'
import { findNodesByName, type NodeNameMatch } from '../../navigation/nodeNameSearch'
import { nodeContainingOffset } from '../../nodeSpanLookup'
import { evaluatePathChunked } from '../../navigation/pathQueryJob'
import { selectNode } from '../../selectNode'
import { activeSession } from '../../session/activeSession'
import { JobSlot } from '../../session/searchJob'
import { useDocumentSession } from '../../session/useDocumentSession'
import {
  getRecencyRank,
  paneForPaletteJump,
  parsePaletteInput,
  rankCommands,
  recordRecentCommand,
  type RankedCommand
} from './paletteLogic'
import {
  closePalette,
  consumePendingInitialQuery,
  isPaletteOpen,
  subscribePaletteOpen
} from './paletteStore'
import './CommandPalette.css'

const NO_DOCUMENT_PLACEHOLDER: Record<'jumpToNode' | 'goToPosition' | 'pathQuery', string> = {
  jumpToNode: 'Open a document to jump to a node by name.',
  goToPosition: 'Open a document to go to a line or byte offset.',
  pathQuery: 'Open a document to run a path query.'
}

type PathQueryOutcome =
  | { readonly ok: true; readonly nodes: Int32Array }
  | { readonly ok: false; readonly diagnostic: PathDiagnostic }

/** A single stable reference for "no node matches (yet)" — `nodeMatches
 * ?? EMPTY_MATCHES` must return the *same* array on every render when
 * there's nothing to show, not a fresh `[]` literal. A fresh literal there
 * would never `===` the previous render's, so the "did the active list
 * change" check below would see a change on every single render and loop
 * `setActiveIndex` during render indefinitely — reachable just by opening
 * `@` mode with no document open. */
const EMPTY_MATCHES: readonly NodeNameMatch[] = []

function getSnapshotFalse(): boolean {
  return false
}

/**
 * R82 (`R82-hover-and-glyphs.md` §1): R67's own `scrollIntoView({block:
 * 'nearest'})` (below) moves the list under a pointer that never moved
 * itself — the rows slide, the browser fires a real `mouseenter` on
 * whichever row is now under the cursor, and its handler calls
 * `setActiveIndex`, snapping the keyboard-driven selection back to
 * wherever the mouse happened to be resting. Standard treatment: keyboard
 * navigation suppresses hover-activation until the pointer *genuinely*
 * moves again.
 *
 * The coordinate check lives inside `activateOnHover` itself, run from the
 * `mouseenter`/`onMouseEnter` handler — not a separate `mousemove`
 * listener racing it. Browsers fire `mouseover` (what `onMouseEnter`
 * synthesizes from) *before* the accompanying `mousemove` for the same
 * pointer transition, so a separate listener clearing suppression on
 * `mousemove` would still see the stale, suppressed value at the moment
 * `mouseenter` itself fires — checking the entering event's own
 * `clientX`/`clientY` against the last-seen position removes that race
 * entirely. Relying on "scrolling doesn't fire `mousemove`" was rejected
 * for the same reason R82's own writeup gives: true in Chromium today, not
 * a contract to depend on. One instance covers both lists (`ranked` and
 * `nodeMatches`) rather than growing two copies of the rule.
 */
function useHoverGate(): {
  activateOnHover: (event: { clientX: number; clientY: number }, activate: () => void) => void
  suppressHover: () => void
} {
  const suppressedRef = useRef(false)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)

  return {
    activateOnHover: (event, activate) => {
      const last = lastPointerRef.current
      const moved = last === null || last.x !== event.clientX || last.y !== event.clientY
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      if (moved) suppressedRef.current = false
      if (!suppressedRef.current) activate()
    },
    suppressHover: () => {
      suppressedRef.current = true
    }
  }
}

export function Palette(): JSX.Element | null {
  // `false` as the SSR/initial-render fallback isn't reachable in this
  // renderer-only app, but useSyncExternalStore requires the third
  // argument's type to line up with the client snapshot's.
  const open = useSyncExternalStore(subscribePaletteOpen, isPaletteOpen, getSnapshotFalse)
  const context = useSyncExternalStore(subscribeContext, getContext, getContext)

  if (!open) return null
  return <PaletteContent context={context} />
}

function PaletteContent({ context }: { context: ContextKeys }): JSX.Element {
  // Lazy initializer, same shape as `previouslyFocused` below — runs once,
  // at mount (i.e. once per open), so a caller's `openPalette(':')` lands
  // exactly once and doesn't linger across a later plain open.
  const [input, setInput] = useState<string>(() => consumePendingInitialQuery() ?? '')
  const [activeIndex, setActiveIndex] = useState(0)
  // Captured once, at mount (i.e. once per open) — a lazy initializer runs
  // during render, before anything in this component could have moved
  // focus itself, unlike reading it inside an effect.
  const [previouslyFocused] = useState<HTMLElement | null>(
    () => document.activeElement as HTMLElement | null
  )

  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { activateOnHover, suppressHover } = useHoverGate()

  const documentState = useDocumentSession()
  const readyDocument = documentState.phase === 'ready' ? documentState.document : null

  const parsed = useMemo(() => parsePaletteInput(input), [input])

  const ranked: readonly RankedCommand[] = useMemo(() => {
    if (parsed.mode !== 'command') return []
    return rankCommands(commandsForSurface('palette', context), parsed.query, getRecencyRank)
  }, [parsed, context])

  const nodeMatches = useMemo(() => {
    if (parsed.mode !== 'jumpToNode' || readyDocument === null) return null
    return findNodesByName(readyDocument.store, readyDocument.nameIndex, parsed.query)
  }, [parsed, readyDocument])

  const goToResult = useMemo(() => {
    if (parsed.mode !== 'goToPosition' || readyDocument === null) return null
    return parseGoToPosition(
      readyDocument.sourceBuffer.bytes,
      readyDocument.rowIndex,
      readyDocument.lineIndex,
      readyDocument.sourceBuffer.byteLength,
      parsed.query
    )
  }, [parsed, readyDocument])

  // M4-PLAN.md G9/G8's own "runs through G3's scheduler" requirement:
  // parsing is cheap and stays synchronous (a diagnostic shows before
  // Enter is pressed), but *evaluating* a query — G10 measured a facet
  // predicate at 163–314 ms on a 100–200 MB fixture — must not run
  // synchronously inside a render on every keystroke. Debounced the same
  // 150 ms as `FindBar`'s own search debounce, then chunked at step
  // granularity via `evaluatePathChunked`, in a `JobSlot` so a query that
  // changes mid-evaluation supersedes the stale one cleanly rather than
  // racing it. Results feed `activeSearchStore` (G4) on confirm, not a
  // palette-local list — the payoff of expressing both a text find and a
  // path query as the same offset set is that Raw highlighting, Tree/grid
  // marking and next/previous all already work, unmodified, for whichever
  // produced the current result.
  const [pathQueryResult, setPathQueryResult] = useState<PathQueryOutcome | null>(null)
  const pathQueryJobsRef = useRef<JobSlot<Int32Array> | null>(null)
  if (pathQueryJobsRef.current === null) pathQueryJobsRef.current = new JobSlot()

  // A stale `pathQueryResult` from a previous non-empty query is never
  // *shown* once the query goes empty (or the mode/document changes) —
  // derived at render time, not reset via `setState` inside the effect
  // below, which would trip react-hooks' "avoid calling setState()
  // directly within an effect" rule (cascading-render risk) for a branch
  // that fires on every keystroke that clears the input.
  const displayedPathQueryResult =
    parsed.mode === 'pathQuery' && readyDocument !== null && parsed.query.length > 0
      ? pathQueryResult
      : null

  useEffect(() => {
    // Clearing needs no debounce, and no `setState` here either — nothing
    // is displayed for an empty query regardless of what `pathQueryResult`
    // still holds (see `displayedPathQueryResult` above). Only the actual
    // async work (the job in flight) needs cancelling as an external-
    // system side effect.
    if (parsed.mode !== 'pathQuery' || readyDocument === null || parsed.query.length === 0) {
      pathQueryJobsRef.current!.cancel()
      return
    }
    const debounce = setTimeout(() => {
      const document = readyDocument
      const parsedPath = parsePath(parsed.query, (name) =>
        document.store.interner.lookup(name, document.sourceBuffer.encoding)
      )
      if (!parsedPath.ok) {
        pathQueryJobsRef.current!.cancel()
        setPathQueryResult({ ok: false, diagnostic: parsedPath.diagnostic })
        return
      }
      const job = pathQueryJobsRef.current!.start(() =>
        evaluatePathChunked(
          document.store,
          document.nameIndex,
          document.sourceBuffer,
          parsedPath.path
        )
      )
      job.result.then(
        (nodes) => setPathQueryResult({ ok: true, nodes }),
        () => {
          // Cancelled — superseded by a newer query, or the palette closed.
          // Whichever superseded it already owns `pathQueryResult`.
        }
      )
    }, 150)
    return () => clearTimeout(debounce)
  }, [parsed, readyDocument])

  // Cancels whatever job is in flight when the palette itself closes
  // (`PaletteContent` unmounts) — the debounce-clearing cleanup above only
  // covers a *pending* timer, not a job already running past it.
  useEffect(() => () => pathQueryJobsRef.current?.cancel(), [])

  // Clamping-during-render, not an effect: whenever the active mode's
  // result list is a new one (the query, the context, or the open document
  // changed), snap the selection back to the top result rather than
  // pointing at a stale index. This is the "adjust state when a prop
  // changes" pattern React's own docs recommend in place of an effect — it
  // costs one extra render on the transition, not a cascading
  // effect-triggered one. `goToPosition` has no list of its own (Enter
  // just confirms the one parsed result), so it's not part of this.
  const activeList: readonly unknown[] | null =
    parsed.mode === 'command'
      ? ranked
      : parsed.mode === 'jumpToNode'
        ? (nodeMatches?.matches ?? EMPTY_MATCHES)
        : null
  const [lastActiveList, setLastActiveList] = useState<readonly unknown[] | null>(null)
  if (activeList !== null && lastActiveList !== activeList) {
    setLastActiveList(activeList)
    setActiveIndex(0)
  }

  // R67 (`R66-palette-polish.md` §2): measured, after 14 ArrowDown
  // presses, that the selection walks off the bottom of the list with
  // nothing scrolling it into view — `aria-activedescendant` was correct,
  // the row just wasn't on screen. `'nearest'`, not `'center'`: centring
  // would yank the list on every keypress even when the target was already
  // visible, worse than not scrolling for someone stepping one row at a
  // time. No `behavior: 'smooth'` — instant is simply better for a
  // keyboard-repeat list, and it's what `scrollIntoView` does by default
  // with no `behavior` given. Covers both lists (`ranked` and
  // `nodeMatches`) since both render `.palette-option-active` the same way.
  useEffect(() => {
    containerRef.current
      ?.querySelector('.palette-option-active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, activeList])

  // Runs once per mount, i.e. once per open (see the module comment): hand
  // focus to the input, and close on an outside click. Focus restoration
  // lives in `closeRestoringFocus` below, not here — see its comment.
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus())

    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        closeRestoringFocus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)

    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', onPointerDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeRestoringFocus reads only refs/state via closures that don't need to retrigger this mount effect
  }, [])

  /**
   * Closes the palette and, if nothing else has already claimed focus,
   * restores it to whatever had it before the palette opened.
   *
   * Deliberately synchronous at the call site rather than done from the
   * unmount effect's cleanup: a command run from the palette (e.g.
   * `klados.focus.tree`) can itself move focus, and by the time an effect
   * cleanup would run, this component's DOM — and the `containerRef` check
   * that would notice — is already gone. Checking here, before `closePalette`
   * even runs, means a subsequent `entry.command.run()` call in `runCommand`
   * still executes after this and so still wins if it moves focus.
   */
  function closeRestoringFocus(): void {
    const stillFocusedInPalette = containerRef.current?.contains(document.activeElement) ?? false
    closePalette()
    if (stillFocusedInPalette) previouslyFocused?.focus()
  }

  /** R69 (`R69-focus-and-find.md` §1): a palette jump (`@`/`:`/`/`)
   * is "take me there," not an ordinary command — closing and restoring
   * focus to wherever it was before the palette opened would leave the
   * keyboard pointing at the Open button (or nothing) while the selection
   * moved elsewhere entirely. Closes and focuses `pane` instead of
   * restoring, via `focusPaneOrFirstAvailable` so a hidden target pane
   * falls back to whichever is actually visible rather than stranding
   * focus silently. */
  function closeAndFocus(pane: Pane): void {
    closePalette()
    focusPaneOrFirstAvailable(pane)
  }

  function runCommand(entry: RankedCommand): void {
    recordRecentCommand(entry.command.id)
    closeRestoringFocus()
    entry.command.run({ context: getContext(), session: activeSession } satisfies AppContext)
  }

  /** Jumping to a node (`@`) or a position (`:`) both mean the same three
   * things once a target node is known: select it, and bring the Tree and
   * Raw View to show it too — the same "jump everywhere" a `Locate in
   * tree`/`Locate in source` pair would do separately, done together since
   * this *is* the act of navigating there for the first time. `pane` is
   * where the keyboard ends up: Tree for `@`/`/` (both name *nodes*), Raw
   * for `:` (which names a *position* — R69 §1's own recommendation). */
  function navigateToNode(store: NodeStore, node: NodeRef, pane: Pane): void {
    selectNode(store, node)
    locateInTree(node)
    scrubRawTo(store.spanOf(node).start)
    closeAndFocus(pane)
  }

  function runNodeMatch(match: NodeNameMatch): void {
    if (readyDocument === null) return
    navigateToNode(readyDocument.store, match.node, paneForPaletteJump('jumpToNode'))
  }

  function runGoToPosition(result: GoToPosition): void {
    if (readyDocument === null) return
    navigateToNode(
      readyDocument.store,
      nodeContainingOffset(readyDocument.store, result.offset),
      paneForPaletteJump('goToPosition')
    )
  }

  /** R88 (`R86-find-as-query-surface.md` §4): confirms a path query (`/`)
   * by handing off to Find rather than publishing a result itself — the
   * palette becomes a launcher, the same shape `@`/`:` already have, where
   * it finds, hands off and closes. `query` (the raw typed text, no
   * leading `/` — `parsePaletteInput` already stripped it) becomes Find's
   * own prefilled text in path mode; Find re-evaluates it independently
   * (R86: a `mode: 'path'` `SearchQuery` re-runs on every reparse, unlike
   * the old `setDirectResult` snapshot this replaces) and jumps to the
   * first match the same way a text search landing does (R79) — no second
   * "jump to the first match" implementation needed here. */
  function runPathQuery(query: string): void {
    if (readyDocument === null) return
    openFindWithQuery(query, 'path')
    closePalette()
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeRestoringFocus()
      return
    }
    // The input is the palette's only focusable element — Tab has nothing
    // useful to do but leave the trap, so it's swallowed rather than
    // handed to whatever the browser would focus next in the document.
    if (event.key === 'Tab') {
      event.preventDefault()
      return
    }

    if (parsed.mode === 'goToPosition') {
      if (event.key === 'Enter' && goToResult !== null) {
        event.preventDefault()
        runGoToPosition(goToResult)
      }
      return
    }

    if (parsed.mode === 'pathQuery') {
      if (event.key === 'Enter' && displayedPathQueryResult?.ok === true) {
        event.preventDefault()
        runPathQuery(parsed.query)
      }
      return
    }

    const list = parsed.mode === 'command' ? ranked : (nodeMatches?.matches ?? EMPTY_MATCHES)
    if (list.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      suppressHover()
      setActiveIndex((i) => (i + 1) % list.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      suppressHover()
      setActiveIndex((i) => (i - 1 + list.length) % list.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (parsed.mode === 'command') {
        const entry = ranked[activeIndex]
        if (entry !== undefined) runCommand(entry)
      } else {
        const match = nodeMatches?.matches[activeIndex]
        if (match !== undefined) runNodeMatch(match)
      }
    }
  }

  const activeOption = ranked[activeIndex]
  const activeOptionId =
    parsed.mode === 'command' && activeOption !== undefined
      ? `klados-palette-option-${activeOption.command.id}`
      : parsed.mode === 'jumpToNode' && nodeMatches?.matches[activeIndex] !== undefined
        ? `klados-palette-node-${nodeMatches.matches[activeIndex]!.node}`
        : undefined

  return (
    <div className="palette-overlay">
      <div className="palette" ref={containerRef}>
        <input
          ref={inputRef}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="klados-palette-listbox"
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          placeholder="Type a command, @ to jump to a node, : to go to a position, / to query"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {parsed.mode === 'command' && (
          <ul id="klados-palette-listbox" role="listbox" className="palette-list">
            {ranked.length === 0 ? (
              <li className="palette-empty">No matching commands</li>
            ) : (
              ranked.map((entry, index) => {
                // R65 (`R65-shortcuts-help.md` §2): the effective
                // (possibly overridden) chord, not the shipped default.
                const chord = effectiveChordFor(entry.command.id)
                // R68 (`R66-palette-polish.md` §3): `state !==
                // undefined` is the toggle contract itself.
                const state = entry.command.state?.()
                return (
                  <li
                    key={entry.command.id}
                    id={`klados-palette-option-${entry.command.id}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-label={
                      entry.label +
                      (state === undefined ? '' : `, ${state ? 'on' : 'off'}`) +
                      (chord === null ? '' : `, keybinding ${formatChord(chord)}`)
                    }
                    className={
                      index === activeIndex
                        ? 'palette-option palette-option-active'
                        : 'palette-option'
                    }
                    onMouseEnter={(event) => activateOnHover(event, () => setActiveIndex(index))}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      runCommand(entry)
                    }}
                  >
                    {/* R66 (`R66-palette-polish.md` §1): one string,
                     * `Category: Title`, used for both matching and
                     * rendering — the highlighted indices are always
                     * against exactly this text, never the title alone. */}
                    <span className="palette-option-title">{highlight(entry)}</span>
                    <span className="palette-option-meta">
                      {state !== undefined && (
                        <span className="palette-option-state">{state ? 'On' : 'Off'}</span>
                      )}
                      {chord !== null && (
                        <span className="palette-option-hint">{formatChord(chord)}</span>
                      )}
                    </span>
                  </li>
                )
              })
            )}
          </ul>
        )}
        {parsed.mode === 'jumpToNode' &&
          (readyDocument === null ? (
            <div id="klados-palette-listbox" className="palette-disabled-mode" role="status">
              {NO_DOCUMENT_PLACEHOLDER.jumpToNode}
            </div>
          ) : (
            <ul id="klados-palette-listbox" role="listbox" className="palette-list">
              {nodeMatches === null || nodeMatches.matches.length === 0 ? (
                <li className="palette-empty">
                  {parsed.query.length === 0 ? 'Type a node name' : 'No matching nodes'}
                </li>
              ) : (
                <>
                  {nodeMatches.matches.map((match, index) => (
                    <li
                      key={match.node}
                      id={`klados-palette-node-${match.node}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={
                        index === activeIndex
                          ? 'palette-option palette-option-active'
                          : 'palette-option'
                      }
                      onMouseEnter={(event) => activateOnHover(event, () => setActiveIndex(index))}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        runNodeMatch(match)
                      }}
                    >
                      <span className="palette-option-title">{highlightName(match)}</span>
                    </li>
                  ))}
                </>
              )}
            </ul>
          ))}
        {parsed.mode === 'goToPosition' &&
          (readyDocument === null ? (
            <div id="klados-palette-listbox" className="palette-disabled-mode" role="status">
              {NO_DOCUMENT_PLACEHOLDER.goToPosition}
            </div>
          ) : (
            <div id="klados-palette-listbox" className="palette-disabled-mode" role="status">
              {goToResult === null
                ? hasMeaningfulLines(readyDocument.lineIndex, readyDocument.sourceBuffer.byteLength)
                  ? `Type a line number (1–${readyDocument.lineIndex.lineCount.toLocaleString()})`
                  : `Type a byte offset (0–${readyDocument.sourceBuffer.byteLength.toLocaleString()}). This document has no lines to number.`
                : `Enter to go to ${goToResult.kind === 'line' ? `line ${parsed.query}` : `byte ${goToResult.offset}`}`}
            </div>
          ))}
        {parsed.mode === 'pathQuery' &&
          (readyDocument === null ? (
            <div id="klados-palette-listbox" className="palette-disabled-mode" role="status">
              {NO_DOCUMENT_PLACEHOLDER.pathQuery}
            </div>
          ) : parsed.query.length === 0 ? (
            // R72 (`R72-path-query.md` §5): the grammar itself, not one
            // line leading with its most complex form — someone meeting `/`
            // here has no way to learn `*`/`//`/`[n]` exist otherwise.
            <div id="klados-palette-listbox" className="palette-path-help" role="status">
              <PathQueryGrammarHelp />
            </div>
          ) : (
            <div id="klados-palette-listbox" className="palette-disabled-mode" role="status">
              {displayedPathQueryResult === null ? (
                'Evaluating…'
              ) : !displayedPathQueryResult.ok ? (
                // §5: a caret under the offending character instead of an
                // offset the user has to count — `PathDiagnostic` already
                // carries it, this is presentation only.
                <PathQueryError
                  query={parsed.query}
                  diagnostic={displayedPathQueryResult.diagnostic}
                />
              ) : displayedPathQueryResult.nodes.length === 0 ? (
                'No matches'
              ) : (
                `Enter to show ${displayedPathQueryResult.nodes.length.toLocaleString()} match${displayedPathQueryResult.nodes.length === 1 ? '' : 'es'}`
              )}
            </div>
          ))}
      </div>
    </div>
  )
}

/**
 * Wraps each fuzzy-matched character of `text` (a command's `Category:
 * Title` label — R66 — or a node name) in a `<mark>` so a user can see
 * *why* a result matched, not just that it did.
 *
 * Indexes by UTF-16 code unit (`text[i]`), not code point (`[...text]`) —
 * `fuzzyMatch` walks its target the same way (plain indexed access), so
 * its `indices` are code-unit offsets. Iterating by code point instead
 * would silently misalign the highlight for any text containing a
 * character outside the BMP, since a surrogate pair counts as one
 * iteration step there but two code units in `indices`.
 */
function highlightText(text: string, indices: readonly number[]): JSX.Element {
  if (indices.length === 0) return <>{text}</>

  const indexSet = new Set(indices)
  const chars: JSX.Element[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    chars.push(indexSet.has(i) ? <mark key={i}>{char}</mark> : <span key={i}>{char}</span>)
  }
  return <>{chars}</>
}

function highlight(entry: RankedCommand): JSX.Element {
  return highlightText(entry.label, entry.indices)
}

function highlightName(match: NodeNameMatch): JSX.Element {
  return highlightText(match.name, match.indices)
}

/**
 * R72 (`R72-path-query.md` §5) — the `/` mode's empty-state guidance.
 * Five lines, already written verbatim in `core/path/parse.ts`'s own
 * header comment and `CONCEPT.md` §6.3 — this renders the same grammar
 * rather than the one line ("Type a path query, e.g. …") that used to lead
 * with the most complex form (a quoted facet predicate) and left `*`/`//`/
 * `[n]` undiscoverable.
 */
function PathQueryGrammarHelp(): JSX.Element {
  const rows: readonly [string, string][] = [
    ['cars/car', 'children by name'],
    ['cars//price', 'any descendant'],
    ['car[3]', 'the 3rd'],
    ['car[@id="c-001"]', 'by attribute value'],
    // R129: the comparison predicate. Listed because the grammar help is
    // the only place the query syntax is discoverable at all.
    ['car[price>100]', 'by comparison'],
    ['*', 'any name']
  ]
  return (
    <table className="palette-path-help-table">
      <tbody>
        {rows.map(([example, does]) => (
          <tr key={example}>
            <td className="palette-path-help-example">{example}</td>
            <td>{does}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * R72 §5 — a caret under the offending character instead of `Error at N:
 * message`, which made the user count characters to find the offset.
 * `query` and the caret row share `--font-mono` (set in CSS), which is
 * what makes the caret's horizontal position actually line up with the
 * character it points at — a proportional font would silently misalign it.
 */
function PathQueryError({
  query,
  diagnostic
}: {
  readonly query: string
  readonly diagnostic: PathDiagnostic
}): JSX.Element {
  const caretOffset = Math.max(0, Math.min(diagnostic.offset, query.length))
  return (
    <div className="palette-path-error">
      <div className="palette-path-error-query">{query}</div>
      <div className="palette-path-error-caret" aria-hidden="true">
        {' '.repeat(caretOffset)}^
      </div>
      <div className="palette-path-error-message">{diagnostic.message}</div>
    </div>
  )
}
