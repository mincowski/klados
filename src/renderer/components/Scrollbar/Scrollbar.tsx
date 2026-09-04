/**
 * M5c-PLAN.md J4 / D-051 — one overlay scrollbar look for every pane that
 * natively scrolls (Tree, Detail's children list, the Grid). Draws a thumb
 * over an element that keeps `overflow: auto` with its native bar hidden
 * (`Scrollbar.css`'s own rule for `.scrollbar-host`) and drives
 * `scrollTop`/`scrollLeft` on it — it does not reimplement scrolling, and
 * it cannot assume a meaningful `scrollHeight`/`scrollWidth` beyond reading
 * whatever the browser already computed for a real DOM tree (unlike the Raw
 * View's ~1 MB window, D-031, which is exactly why Raw keeps the Scrubber
 * instead of using this component — see Scrubber.css's own comment on
 * adopting this component's *visual language* without adopting the
 * component itself).
 *
 * `aria-hidden`: the scrollable pane stays the focusable, keyboard-
 * scrollable thing (`target`, supplied by the caller); this is decoration
 * over it, not a second way to reach the same content.
 */
import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent
} from 'react'
import { horizontalWheelDelta } from '../../wheelDelta'
import './Scrollbar.css'

export type ScrollbarAxis = 'vertical' | 'horizontal' | 'both'

interface Metrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  readonly scrollLeft: number
  readonly scrollWidth: number
  readonly clientWidth: number
}

const EMPTY_METRICS: Metrics = {
  scrollTop: 0,
  scrollHeight: 0,
  clientHeight: 0,
  scrollLeft: 0,
  scrollWidth: 0,
  clientWidth: 0
}

function readMetrics(el: HTMLElement): Metrics {
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollLeft: el.scrollLeft,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth
  }
}

export interface AxisGeometry {
  readonly scrollPos: number
  readonly scrollSize: number
  readonly clientSize: number
}

/** One axis' worth of thumb geometry — `size`/`offset` as a 0–1 fraction of
 * the track, clamped so a thumb never reports outside it even if a
 * transient DOM read (mid-resize) briefly disagrees. Exported for direct
 * testing — the one piece of this component's logic that's pure. */
export function thumbGeometry(axis: AxisGeometry): { size: number; offset: number } | null {
  if (axis.scrollSize <= axis.clientSize + 1) return null
  const size = Math.max(0.05, axis.clientSize / axis.scrollSize)
  const maxScroll = axis.scrollSize - axis.clientSize
  const offset = maxScroll > 0 ? (axis.scrollPos / maxScroll) * (1 - size) : 0
  return { size: Math.min(1, size), offset: Math.max(0, Math.min(1 - size, offset)) }
}

interface ScrollbarProps {
  /** The natively-scrolling element this scrollbar drives — must already
   * have its own native scrollbar hidden (`.scrollbar-host` in
   * `Scrollbar.css`, or an equivalent rule). */
  readonly target: RefObject<HTMLElement | null>
  readonly axis?: ScrollbarAxis
  /** R44 (`R43-grid-sizing-and-scroll.md`): how far, in px, the
   * horizontal track's own `left` edge sits from `target`'s left edge —
   * the range this track actually scrolls, for a caller (the Grid) whose
   * leading columns are `position: sticky` and never move. Without this
   * the track spans the *whole* viewport, including the sticky region,
   * which then paints over it (sticky content is `z-index`ed above the
   * track) — the track wasn't hidden, it was drawn and covered. `0`
   * (the default) is every other caller: nothing to inset past. */
  readonly horizontalInset?: number
}

export function Scrollbar({
  target,
  axis = 'vertical',
  horizontalInset = 0
}: ScrollbarProps): JSX.Element | null {
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS)

  useEffect(() => {
    const el = target.current
    if (el === null) return
    // R46 (`R43-grid-sizing-and-scroll.md`): `readMetrics` forces a
    // synchronous layout (`scrollHeight`/`clientHeight`/`scrollWidth`/
    // `clientWidth`). Three independent sources below can each ask for a
    // fresh read within the same animation frame — a thumb drag fires
    // `scroll` on every `scrollTop` write, and virtualization mounting and
    // unmounting rows under that same drag fires the `MutationObserver`
    // again, sometimes more than once per frame if React commits in more
    // than one batch — so calling `update` directly, once per source, is
    // one forced layout per *source event*, not per frame. Coalesced here
    // to at most one `requestAnimationFrame` callback (and so at most one
    // layout read) per frame regardless of how many of the three sources
    // fired in it; `rafRef` is what makes a second `scheduleUpdate` inside
    // the same pending frame a no-op rather than a second callback.
    let rafRef: number | null = null
    const update = (): void => setMetrics(readMetrics(el))
    const scheduleUpdate = (): void => {
      if (rafRef !== null) return
      rafRef = requestAnimationFrame(() => {
        rafRef = null
        update()
      })
    }
    update()
    el.addEventListener('scroll', scheduleUpdate, { passive: true })
    const resizeObserver = new ResizeObserver(scheduleUpdate)
    resizeObserver.observe(el)
    // Content mutations (rows mounting/unmounting under virtualization,
    // the children table's own sample-derived width) change scrollHeight/
    // scrollWidth without necessarily resizing `el` itself.
    const mutationObserver = new MutationObserver(scheduleUpdate)
    mutationObserver.observe(el, { childList: true, subtree: true })
    return () => {
      if (rafRef !== null) cancelAnimationFrame(rafRef)
      el.removeEventListener('scroll', scheduleUpdate)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [target])

  const showVertical = axis !== 'horizontal' && metrics.scrollHeight > metrics.clientHeight + 1
  const showHorizontal = axis !== 'vertical' && metrics.scrollWidth > metrics.clientWidth + 1
  if (!showVertical && !showHorizontal) return null

  return (
    <>
      {showVertical && (
        <ScrollbarTrack
          orientation="vertical"
          target={target}
          geometry={{
            scrollPos: metrics.scrollTop,
            scrollSize: metrics.scrollHeight,
            clientSize: metrics.clientHeight
          }}
        />
      )}
      {showHorizontal && (
        <ScrollbarTrack
          orientation="horizontal"
          target={target}
          inset={horizontalInset}
          geometry={{
            scrollPos: metrics.scrollLeft,
            scrollSize: metrics.scrollWidth,
            clientSize: metrics.clientWidth
          }}
        />
      )}
    </>
  )
}

interface ScrollbarTrackProps {
  readonly orientation: 'vertical' | 'horizontal'
  readonly target: RefObject<HTMLElement | null>
  readonly geometry: AxisGeometry
  /** R44: px inset for the horizontal track's `left` edge — see
   * `ScrollbarProps.horizontalInset`'s own doc comment. Unused for
   * `vertical` (its own inset would be a `top`/`bottom` concept this round
   * has no caller for). */
  readonly inset?: number
}

/** Plain (non-component, non-hook) functions, deliberately outside
 * `ScrollbarTrack` — the React Compiler's `react-hooks/immutability` rule
 * flags a component/hook writing a DOM property reached through a prop
 * (`target`, here) even though it's a real external DOM node, not React
 * state; mutating it from ordinary functions the compiler doesn't apply
 * that analysis to is what the drive*By/To helpers below are for. */
function driveScrollBy(el: HTMLElement, vertical: boolean, delta: number): void {
  if (vertical) el.scrollTop += delta
  else el.scrollLeft += delta
}

function driveScrollTo(el: HTMLElement, vertical: boolean, value: number): void {
  if (vertical) el.scrollTop = value
  else el.scrollLeft = value
}

function ScrollbarTrack({
  orientation,
  target,
  geometry,
  inset = 0
}: ScrollbarTrackProps): JSX.Element | null {
  const trackRef = useRef<HTMLDivElement>(null)
  const thumb = thumbGeometry(geometry)
  if (thumb === null) return null
  // Narrowed out to primitives — TS doesn't carry `thumb`'s non-null
  // narrowing into the nested pointer-handler closures below.
  const thumbSize = thumb.size
  const thumbOffset = thumb.offset

  const vertical = orientation === 'vertical'

  function scrollBy(delta: number): void {
    const el = target.current
    if (el === null) return
    driveScrollBy(el, vertical, delta)
  }

  function scrollTo(pos: number): void {
    const el = target.current
    if (el === null) return
    const maxScroll = geometry.scrollSize - geometry.clientSize
    const clamped = Math.max(0, Math.min(maxScroll, pos))
    driveScrollTo(el, vertical, clamped)
  }

  // Dragging the thumb: continuous ratio-scrub, same gesture as a native
  // scrollbar thumb drag — distinct from a track click, which pages.
  function onThumbPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.stopPropagation()
    const track = trackRef.current
    if (track === null) return
    const trackRect = track.getBoundingClientRect()
    const trackLength = vertical ? trackRect.height : trackRect.width
    const thumbLength = thumbSize * trackLength
    const trackRange = trackLength - thumbLength
    const startClient = vertical ? event.clientY : event.clientX
    const startScrollPos = geometry.scrollPos
    const maxScroll = geometry.scrollSize - geometry.clientSize

    function onMove(moveEvent: PointerEvent): void {
      if (trackRange <= 0) return
      const deltaClient = (vertical ? moveEvent.clientY : moveEvent.clientX) - startClient
      const deltaRatio = deltaClient / trackRange
      scrollTo(startScrollPos + deltaRatio * maxScroll)
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Clicking the track (not the thumb, which stops propagation above)
  // pages toward the click — a real scrollbar's track-click gesture,
  // distinct from the thumb's continuous drag.
  function onTrackPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const track = trackRef.current
    if (track === null) return
    const trackRect = track.getBoundingClientRect()
    const trackLength = vertical ? trackRect.height : trackRect.width
    const clickOffset =
      (vertical ? event.clientY - trackRect.top : event.clientX - trackRect.left) / trackLength
    const clickedAfterThumb = clickOffset > thumbOffset + thumbSize
    const clickedBeforeThumb = clickOffset < thumbOffset
    if (clickedAfterThumb) scrollBy(geometry.clientSize)
    else if (clickedBeforeThumb) scrollBy(-geometry.clientSize)
  }

  // Wheel over the strip scrolls the target — a scrollbar that ignores the
  // wheel doesn't read as a scrollbar (J4's own acceptance). R45
  // (`R43-grid-sizing-and-scroll.md`): the horizontal axis used to
  // read `event.deltaX` alone, which is 0 for an ordinary mouse wheel — so
  // pointing at a horizontal track and scrolling did nothing at all.
  // `horizontalWheelDelta` is the same deltaX-falls-back-to-deltaY idiom
  // `TabStrip.tsx`'s own `onWheel` already uses, shared rather than copied.
  function onWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    scrollBy(vertical ? event.deltaY : horizontalWheelDelta(event))
  }

  return (
    <div
      ref={trackRef}
      className={`scrollbar-track scrollbar-track-${orientation}`}
      aria-hidden="true"
      style={vertical || inset === 0 ? undefined : { left: inset }}
      onPointerDown={onTrackPointerDown}
      onWheel={onWheel}
    >
      <div
        className="scrollbar-thumb"
        style={
          vertical
            ? { top: `${thumb.offset * 100}%`, height: `${thumb.size * 100}%` }
            : { left: `${thumb.offset * 100}%`, width: `${thumb.size * 100}%` }
        }
        onPointerDown={onThumbPointerDown}
      />
    </div>
  )
}
