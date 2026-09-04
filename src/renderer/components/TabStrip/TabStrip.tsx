/**
 * R25 (`R24-tabs.md` §3, `CONCEPT.md` §11.4) built the anatomy; R26
 * (§4) adds the dirty-close prompt (`requestCloseTab`, resolved by
 * `derivedNotifications.ts`'s `derived:pendingCloseTab` and the commands in
 * `./commands.ts`), keyboard switching, and routes the "+" button through
 * `session/tabs.ts`'s `openNewTab` — the same function `klados.document.open`
 * (Ctrl+O) now calls, so opening a file always means "into a new tab."
 */
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type WheelEvent as ReactWheelEvent
} from 'react'
import type { DocumentSession } from '../../session/documentSession'
import {
  getActiveTabId,
  getSessionFor,
  getTabIds,
  openNewTab,
  requestCloseTab,
  setActiveTab,
  subscribeTabs,
  type TabId
} from '../../session/tabs'
import { glyphFontClass } from '../../glyphFont'
import { splitForMiddleTruncation } from '../../textTruncate'
import { horizontalWheelDelta } from '../../wheelDelta'
import { Icon } from '../Icon/Icon'
import { formatGlyphOf, tabDisplayInfoOf, tabLabelsOf } from './tabDisplay'
import './TabStrip.css'

/** R38 §2c: `behavior: 'smooth'` isn't suppressed by the OS reduced-motion
 * setting on its own — that only governs CSS `scroll-behavior` in some
 * engines, never the scripted option — so both scroll paths gate on it
 * explicitly. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

// A stable identity (module scope, not recreated per render) for the rare
// transient case where a tab's session has already been disposed —
// `useSyncExternalStore` otherwise resubscribes every render against a
// fresh no-op closure.
function emptySubscribe(): () => void {
  return () => {}
}

function useTabSession(id: TabId): DocumentSession | undefined {
  // `getSessionFor` returns a stable reference for a tab's whole lifetime
  // (`tabs.ts` never replaces a `TabEntry`'s `session`), so it's safe to
  // call directly as `useSyncExternalStore`'s `getSnapshot` — no separate
  // "watch for the session itself changing" subscription needed.
  return getSessionFor(id)
}

function TabItem(props: {
  readonly id: TabId
  readonly active: boolean
  readonly label: string
}): JSX.Element {
  const session = useTabSession(props.id)
  const state = useSyncExternalStore(
    session?.subscribe ?? emptySubscribe,
    () => session?.getSnapshot(),
    () => session?.getSnapshot()
  )
  const info = tabDisplayInfoOf(state ?? { phase: 'empty' })
  const { glyph, colorVar } = formatGlyphOf(info.formatId)
  const { head, tail } = splitForMiddleTruncation(props.label)

  function onClose(event: React.MouseEvent): void {
    event.stopPropagation()
    requestCloseTab(props.id)
  }

  return (
    <div
      className={`tab${props.active ? ' tab-active' : ''}`}
      role="tab"
      aria-selected={props.active}
      title={info.filePath ?? props.label}
      onClick={() => setActiveTab(props.id)}
    >
      <span
        className={`tab-icon ${glyphFontClass(glyph)}`}
        aria-hidden="true"
        style={{ color: colorVar }}
      >
        {glyph}
      </span>
      <span className="tab-label">
        {head !== '' && <span className="tab-label-head">{head}</span>}
        <span className="tab-label-tail">{tail}</span>
      </span>
      <button
        type="button"
        className="tab-close-slot"
        aria-label={info.dirty ? `${props.label} (unsaved) — close` : `Close ${props.label}`}
        onClick={onClose}
      >
        {info.dirty && <span className="tab-dirty-dot" aria-hidden="true" />}
        <span className="tab-close-cross" aria-hidden="true" />
      </button>
    </div>
  )
}

/** Same-name disambiguation (§11.4) needs every open tab's own `fileName`,
 * not just the one that happens to be re-rendering — a plain
 * `tabIds.map(id => getSessionFor(id).getSnapshot())` read at `TabStrip`'s
 * own render time would go stale the moment a *background* tab's document
 * changes (Save As onto a name that now collides with another tab) without
 * the tab *set* itself changing, since that's the only thing `subscribeTabs`
 * fires for. Subscribing to every open tab's own session — resubscribed
 * only when the tab set changes, not on every render — is what keeps this
 * live without `TabItem` needing to lift its own state up. */
function useTabDisplayInfos(
  tabIds: readonly TabId[]
): ReadonlyMap<TabId, ReturnType<typeof tabDisplayInfoOf>> {
  const [, forceUpdate] = useReducer((c: number) => c + 1, 0)
  const key = tabIds.join(',')
  useEffect(() => {
    const unsubscribes = tabIds.map((id) => getSessionFor(id)?.subscribe(forceUpdate) ?? (() => {}))
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is `tabIds`' own content-equality proxy; re-running per `tabIds` identity would resubscribe every render for no reason (a stable array isn't guaranteed here).
  }, [key])
  return new Map(
    tabIds.map((id) => [
      id,
      tabDisplayInfoOf(getSessionFor(id)?.getSnapshot() ?? { phase: 'empty' })
    ])
  )
}

/** How often a press-and-hold on `<`/`>` repeats, and how long the first
 * press waits before repeating starts — long enough that an ordinary click
 * (press, release) never triggers a second step. */
const HOLD_REPEAT_MS = 120
const HOLD_DELAY_MS = 400

interface OverflowState {
  readonly overflowing: boolean
  readonly atStart: boolean
  readonly atEnd: boolean
}

const NOT_OVERFLOWING: OverflowState = { overflowing: false, atStart: true, atEnd: true }

/** R36 (`R35-tab-overflow.md` §3): `<`/`>`/`⌄` render only once the
 * strip actually overflows, and the state cannot oscillate — adding these
 * controls only ever *narrows* the scroll area (shrinking it can only
 * increase overflow, never remove it), and the no-overflow measurement
 * below is taken with them already absent, so widening the area back can't
 * re-introduce them either. Both directions are stable. */
function readOverflowState(el: HTMLElement): OverflowState {
  const overflowing = el.scrollWidth > el.clientWidth + 1
  return {
    overflowing,
    atStart: el.scrollLeft <= 0,
    atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
  }
}

export function TabStrip(): JSX.Element {
  const tabIds = useSyncExternalStore(subscribeTabs, getTabIds, getTabIds)
  const activeId = useSyncExternalStore(subscribeTabs, getActiveTabId, getActiveTabId)
  const infos = useTabDisplayInfos(tabIds)

  const labels = tabLabelsOf(
    tabIds.map((id) => {
      const info = infos.get(id)
      return { id, fileName: info?.fileName ?? null, filePath: info?.filePath ?? null }
    })
  )
  const labelOf = (id: TabId): string => labels.find((l) => l.id === id)?.text ?? 'New Tab'

  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState<OverflowState>(NOT_OVERFLOWING)
  const [menuOpen, setMenuOpen] = useState(false)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heldByHoldRef = useRef(false)

  // A hold that's still repeating when the strip unmounts (closing the last
  // dirty tab into the quit flow, mid-press) would otherwise leave its
  // `setInterval` running forever — harmless per call (`scrollRef.current`
  // is null by then) but a real, permanent leak.
  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current)
        clearInterval(holdTimerRef.current)
      }
    },
    []
  )

  // R35: scroll the active tab into view on every activation route —
  // pointer click, Ctrl+Tab, tab close landing on a neighbour, or session
  // restore. `nearest` so a tab already fully visible never moves the
  // strip (the common case must stay motionless), and the `tabIds.join`
  // dependency (content-equality, `useTabDisplayInfos`'s own pattern) makes
  // this re-run once the tab set itself settles, not only once on mount —
  // restore may still be measuring layout the first time this effect runs.
  useEffect(() => {
    const scrollEl = scrollRef.current
    if (scrollEl === null) return
    const activeEl = scrollEl.querySelector<HTMLElement>('.tab-active')
    activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: scrollBehavior() })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tabIds.join(',')` is `tabIds`' own content-equality proxy, same reasoning `useTabDisplayInfos` above already uses.
  }, [activeId, tabIds.join(',')])

  // R36: overflow/edge state — a `ResizeObserver` for the strip's own
  // width changing, a `scroll` listener for `scrollLeft` moving, and a
  // `MutationObserver` for the tab *set* changing `scrollWidth` without
  // necessarily resizing the container itself (`Scrollbar.tsx`'s own
  // reasoning for the identical trio).
  useEffect(() => {
    const scrollEl = scrollRef.current
    if (scrollEl === null) return
    // R38 §2d: `readOverflowState` returns a fresh object every call, so
    // comparing fields in the updater form (and returning the *previous*
    // state when nothing changed) is what keeps `Object.is` succeeding and
    // stops every `scroll` event from re-rendering the whole strip —
    // `behavior: 'smooth'` turns one instant jump into ~30 frames of scroll
    // events, which makes this ~30x worse if left unfixed.
    const update = (): void =>
      setOverflow((prev) => {
        const next = readOverflowState(scrollEl)
        return prev.overflowing === next.overflowing &&
          prev.atStart === next.atStart &&
          prev.atEnd === next.atEnd
          ? prev
          : next
      })
    update()
    scrollEl.addEventListener('scroll', update, { passive: true })
    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(scrollEl)
    const mutationObserver = new MutationObserver(update)
    mutationObserver.observe(scrollEl, { childList: true, subtree: true })
    return () => {
      scrollEl.removeEventListener('scroll', update)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [])

  function tabStepWidth(): number {
    const firstTab = scrollRef.current?.querySelector<HTMLElement>('.tab')
    return firstTab?.getBoundingClientRect().width ?? 160
  }

  // Viewport-only — never changes `activeId` (R36's whole point: "see what
  // else is open without leaving this file").
  function scrollByOneTab(direction: 1 | -1): void {
    scrollRef.current?.scrollBy({ left: direction * tabStepWidth(), behavior: scrollBehavior() })
  }

  function onChevronPointerDown(direction: 1 | -1): void {
    heldByHoldRef.current = false
    holdTimerRef.current = setTimeout(() => {
      heldByHoldRef.current = true
      holdTimerRef.current = setInterval(() => scrollByOneTab(direction), HOLD_REPEAT_MS)
    }, HOLD_DELAY_MS)
  }

  function onChevronPointerUp(): void {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current)
      clearInterval(holdTimerRef.current)
      holdTimerRef.current = null
    }
  }

  function onChevronClick(direction: 1 | -1): void {
    // A press-and-hold that already repeated has moved the strip enough —
    // the trailing `click` a pointer-up also fires shouldn't add one more
    // step on top of it.
    if (heldByHoldRef.current) {
      heldByHoldRef.current = false
      return
    }
    scrollByOneTab(direction)
  }

  // R36 §3c: `overflow-x: auto` alone doesn't give the strip wheel
  // scrolling (measured, R35-tab-overflow.md §1) — mapping `deltaY` (and
  // `deltaX`, trackpads/tilt wheels) onto `scrollLeft` mirrors
  // `Scrollbar.tsx`'s own `onWheel`, the same lesson R33's addendum drew
  // about not inventing a second copy of an existing pattern. R45
  // (`R43-grid-sizing-and-scroll.md`): now the shared
  // `horizontalWheelDelta` helper, not a third hand-copied line of it.
  function onWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    const scrollEl = scrollRef.current
    if (scrollEl === null) return
    scrollEl.scrollLeft += horizontalWheelDelta(event)
  }

  function selectFromMenu(id: TabId): void {
    setActiveTab(id)
    setMenuOpen(false)
  }

  return (
    <div className="tab-strip" role="tablist" aria-label="Open documents">
      {overflow.overflowing && (
        <button
          type="button"
          className="tab-strip-scroll-btn"
          aria-label="Scroll tabs left"
          disabled={overflow.atStart}
          onPointerDown={() => onChevronPointerDown(-1)}
          onPointerUp={onChevronPointerUp}
          onPointerLeave={onChevronPointerUp}
          onClick={() => onChevronClick(-1)}
        >
          <Icon name="chevron-left" />
        </button>
      )}
      <div className="tab-strip-scroll" ref={scrollRef} onWheel={onWheel}>
        {tabIds.map((id) => (
          <TabItem key={id} id={id} active={id === activeId} label={labelOf(id)} />
        ))}
      </div>
      {overflow.overflowing && (
        <button
          type="button"
          className="tab-strip-scroll-btn"
          aria-label="Scroll tabs right"
          disabled={overflow.atEnd}
          onPointerDown={() => onChevronPointerDown(1)}
          onPointerUp={onChevronPointerUp}
          onPointerLeave={onChevronPointerUp}
          onClick={() => onChevronClick(1)}
        >
          <Icon name="chevron-right" />
        </button>
      )}
      {overflow.overflowing && (
        <div className="tab-strip-menu">
          <button
            type="button"
            className="tab-strip-scroll-btn"
            aria-label="List all tabs"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="chevron-down" />
          </button>
          {menuOpen && (
            <ul className="tab-strip-menu-list">
              {tabIds.map((id) => (
                <TabMenuItem
                  key={id}
                  id={id}
                  active={id === activeId}
                  label={labelOf(id)}
                  onSelect={() => selectFromMenu(id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      <button
        type="button"
        className="tab-strip-new"
        aria-label="New tab — open a file"
        title="New tab — open a file"
        onClick={openNewTab}
      >
        <Icon name="add" />
      </button>
    </div>
  )
}

function TabMenuItem(props: {
  readonly id: TabId
  readonly active: boolean
  readonly label: string
  readonly onSelect: () => void
}): JSX.Element {
  const session = useTabSession(props.id)
  const state = useSyncExternalStore(
    session?.subscribe ?? emptySubscribe,
    () => session?.getSnapshot(),
    () => session?.getSnapshot()
  )
  const info = tabDisplayInfoOf(state ?? { phase: 'empty' })
  const { glyph, colorVar } = formatGlyphOf(info.formatId)

  return (
    <li>
      <button
        type="button"
        className={`tab-strip-menu-item${props.active ? ' tab-strip-menu-item-active' : ''}`}
        onClick={props.onSelect}
      >
        <span
          className={`tab-icon ${glyphFontClass(glyph)}`}
          aria-hidden="true"
          style={{ color: colorVar }}
        >
          {glyph}
        </span>
        <span className="tab-strip-menu-item-label">{props.label}</span>
        {info.dirty && <span className="tab-dirty-dot" aria-hidden="true" />}
      </button>
    </li>
  )
}
