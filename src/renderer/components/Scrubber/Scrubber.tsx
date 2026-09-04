/**
 * The scrubber (M1-PLAN.md D13, CONCEPT.md §4.5) — a fixed-height strip
 * whose position is a ratio resolved through the row index, never the
 * editor's own scroll height (`scrubberModel.ts`'s whole reason to exist).
 * Carries markers for the selected node's span and diagnostics, so a
 * selection outside the current Raw window stays visible.
 *
 * **Navigating is not selecting.** Dragging moves the Raw window (via
 * `rawController.ts`'s `scrubTo`) and never touches the document session's
 * selection — no Tree scroll, no breadcrumb update, no
 * `klados.selection.changed`-shaped cascade. Firing that on scroll
 * position would mean millions of updates scrubbing a 200 MB file.
 */
import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from 'react'
import type { NodeRef } from '../../../core/types'
import { NO_SELECTION, type OpenDocument } from '../../session/documentSession'
import { activeSearchStore } from '../../session/activeSearchStore'
import { useDocumentSession } from '../../session/useDocumentSession'
import { scrubRawTo } from '../Raw/rawController'
import { getRawViewport, subscribeRawViewport } from '../Raw/rawViewportStore'
import {
  diagnosticMarkers,
  matchMarkers,
  offsetToRatio,
  ratioToOffset,
  type ScrubberMarker
} from './scrubberModel'
import './Scrubber.css'

/** Must match `.scrubber-thumb`'s own `min-height` in Scrubber.css — used
 * here too, to clamp the thumb's `top` so the forced minimum height can't
 * push it past the strip's own bottom edge (review finding, M5b: near
 * `topRatio` 1 on a large document, the natural ratio-derived height is
 * tiny, so the CSS minimum was winning and the box overflowed). */
const THUMB_MIN_HEIGHT_PX = 20

/** Arrow-key nudge size — a keyboard equivalent to a short drag, not a
 * one-row step (the strip has no way to know how many rows fit "one key
 * press" worth of visual distance, and doesn't need to). */
const KEY_STEP_RATIO = 0.02

/** M5c-PLAN.md J4: "wheel over the strip scrolls the Raw view." There's no
 * real `scrollHeight` to derive a wheel-to-ratio scale from (D-031's own
 * "the window must be invisible" is exactly why not) — this constant picks
 * a step that feels roughly like scrolling, not a measured quantity. */
const WHEEL_RATIO_DIVISOR = 6000

export function Scrubber(): JSX.Element | null {
  const state = useDocumentSession()
  if (state.phase !== 'ready') return null
  return <ScrubberContent document={state.document} selectedNode={state.selection.selectedNode} />
}

interface ScrubberContentProps {
  readonly document: OpenDocument
  readonly selectedNode: NodeRef
}

function ratioFromPointer(strip: HTMLElement, clientY: number): number {
  const rect = strip.getBoundingClientRect()
  if (rect.height <= 0) return 0
  return (clientY - rect.top) / rect.height
}

/** Exported for `R19-document-props.md` §5a's render-count measurement
 * (`test/documentPropsRenderCost.test.tsx`) — same reasoning `Tree.tsx`'s
 * own `TreeContent` export gives. */
export function ScrubberContent({ document, selectedNode }: ScrubberContentProps): JSX.Element {
  const { rowIndex, diagnostics, store } = document
  const stripRef = useRef<HTMLDivElement>(null)
  // The scrubber's own reported position — distinct from the selection
  // marker below. Dragging never moves the selection (§4.5: "navigating is
  // not selecting"), so using the selection's ratio for `aria-valuenow`
  // would freeze the announced value at wherever the selection was while
  // the user actively drags somewhere else entirely. Seeded from the
  // selection only as a starting point, since that's the best guess at
  // "where the window probably is" before the user has touched the strip
  // at all.
  const [positionRatio, setPositionRatio] = useState(() =>
    selectedNode !== NO_SELECTION ? offsetToRatio(rowIndex, store.spanOf(selectedNode).start) : 0
  )

  const diagMarkers = useMemo(
    () => diagnosticMarkers(rowIndex, diagnostics),
    [rowIndex, diagnostics]
  )
  const selectedMarker: ScrubberMarker | null =
    selectedNode !== NO_SELECTION
      ? { ratio: offsetToRatio(rowIndex, store.spanOf(selectedNode).start), kind: 'selected' }
      : null

  // UI-FEEDBACK.md M5b: search hits, specified for this strip in §4.4 and
  // never wired up. Memoized on `starts`' own identity — `activeSearchStore`
  // hands out a stable array per result, so a re-render this component takes
  // for an unrelated reason (a diagnostics/selection change) doesn't re-walk
  // a million-match array for nothing.
  const { starts: matchStarts } = useSyncExternalStore(
    activeSearchStore.subscribe,
    activeSearchStore.getSnapshot,
    activeSearchStore.getSnapshot
  )
  const searchMatchMarkers = useMemo(
    () => matchMarkers(rowIndex, matchStarts),
    [rowIndex, matchStarts]
  )

  // UI-FEEDBACK.md M5b: the thumb shows the visible *viewport*, not the
  // ~1 MB window (D-031's own "the window must be invisible") — published
  // by `Raw.tsx` via `rawViewportStore.ts`, the one-way Raw → Scrubber
  // channel that didn't exist before this.
  const viewport = useSyncExternalStore(subscribeRawViewport, getRawViewport, getRawViewport)

  function scrubToRatio(ratio: number): void {
    const clamped = Math.max(0, Math.min(1, ratio))
    setPositionRatio(clamped)
    scrubRawTo(ratioToOffset(rowIndex, clamped))
  }

  function scrubToClientY(clientY: number): void {
    const strip = stripRef.current
    if (strip === null) return
    scrubToRatio(ratioFromPointer(strip, clientY))
  }

  const [dragging, setDragging] = useState(false)

  // M5c-PLAN.md J4 / D-051: dragging the *thumb* is the continuous
  // ratio-scrub gesture — today's own behaviour, kept, just scoped to the
  // thumb itself now that the track has a different gesture of its own.
  function onThumbPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.stopPropagation()
    stripRef.current?.focus()
    setDragging(true)

    function onMove(moveEvent: PointerEvent): void {
      scrubToClientY(moveEvent.clientY)
    }
    function onUp(): void {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Clicking the track (not the thumb, which stops propagation above)
  // pages toward the click by one viewport's worth of ratio, rather than
  // jumping straight to that ratio — a real scrollbar's track-click
  // gesture, distinct from the thumb's continuous drag (J4's own
  // acceptance: "click on the track pages… dragging the thumb keeps
  // today's continuous ratio-scrub").
  function onTrackPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.currentTarget.focus()
    const strip = stripRef.current
    if (strip === null) return
    const clickRatio = ratioFromPointer(strip, event.clientY)
    const page = Math.max(0.01, viewport.bottomRatio - viewport.topRatio)
    if (clickRatio > viewport.bottomRatio) scrubToRatio(positionRatio + page)
    else if (clickRatio < viewport.topRatio) scrubToRatio(positionRatio - page)
  }

  // M5c-PLAN.md J4: "wheel over the strip scrolls the Raw view, rather than
  // doing nothing."
  function onWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    scrubToRatio(positionRatio + event.deltaY / WHEEL_RATIO_DIVISOR)
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault()
        scrubToRatio(positionRatio + KEY_STEP_RATIO)
        return
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault()
        scrubToRatio(positionRatio - KEY_STEP_RATIO)
        return
      case 'Home':
        event.preventDefault()
        scrubToRatio(0)
        return
      case 'End':
        event.preventDefault()
        scrubToRatio(1)
        return
      default:
    }
  }

  return (
    <div
      className={`scrubber${dragging ? ' scrubber-active' : ''}`}
      ref={stripRef}
      role="slider"
      tabIndex={0}
      aria-label="Document position"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(positionRatio * 100)}
      onPointerDown={onTrackPointerDown}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
    >
      <div
        className="scrubber-thumb"
        aria-hidden="true"
        onPointerDown={onThumbPointerDown}
        style={{
          // `.scrubber-thumb`'s own `min-height: 20px` (THUMB_MIN_HEIGHT_PX)
          // can force the box taller than its ratio-derived height —
          // without this `min()`, that forcing pushes the bottom edge past
          // the strip's own bottom whenever `topRatio` is close to 1 (a
          // large document, scrolled near its end: found in review).
          // `top + naturalHeight` never exceeds 100% on its own (both
          // ratios are within [0, 1] and `bottomRatio >= topRatio`), so
          // this only ever clamps the case the forced minimum creates.
          top: `min(${viewport.topRatio * 100}%, calc(100% - ${THUMB_MIN_HEIGHT_PX}px))`,
          height: `${Math.max(0, viewport.bottomRatio - viewport.topRatio) * 100}%`
        }}
      />
      {searchMatchMarkers.map((marker, index) => (
        <div
          // Bucket index is stable within one array of them — matches
          // themselves carry no id this strip needs to key by.
          key={index}
          className="scrubber-marker scrubber-marker-match"
          style={{ top: `${marker.ratio * 100}%`, opacity: marker.density }}
        />
      ))}
      {diagMarkers.map((marker, index) => (
        <div
          // Diagnostics carry no id of their own to key by; index is stable
          // within one array of them.
          key={index}
          className={`scrubber-marker scrubber-marker-${marker.kind}`}
          style={{ top: `${marker.ratio * 100}%` }}
        />
      ))}
      {selectedMarker !== null && (
        <div
          className={`scrubber-marker scrubber-marker-${selectedMarker.kind}`}
          style={{ top: `${selectedMarker.ratio * 100}%` }}
        />
      )}
    </div>
  )
}
