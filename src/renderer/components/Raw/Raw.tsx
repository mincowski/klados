/**
 * The Raw View (M1-PLAN.md D10, CONCEPT.md §4.4). Read-only in M1
 * (`EditorState.readOnly.of(true)` — no undo stack, no pending-delta list,
 * no reparse; §12 puts editing at M3). CodeMirror is given a ~1 MB window
 * of the buffer around the current position and never the whole document
 * — see `rawWindow.ts` for the mechanism this component is a thin wrapper
 * around.
 *
 * **Line numbers are absolute and exact**, via `rawGutter.ts`. Both of the
 * objections that kept the gutter off through D10 turned out to be solvable
 * rather than inherent: CodeMirror numbering only within the window is what
 * `formatNumber` exists to correct, and "a row is not a line" (§3.1) stops
 * mattering once the line number is a rank query over the row index instead
 * of the row number itself — every line start is already a row start, so no
 * second index is needed. The gutter is off for a document with no
 * meaningful lines, on the same rule §4.3 uses for the Detail view's
 * source-range fact.
 */
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'
import { setContext } from '../../commands/context'
import { registerPaneContent } from '../../focus'
import { activeDocumentId } from '../../notifications/documentId'
import { notify } from '../../notifications/notificationStore'
import { getFindState, subscribeFind } from '../Find/findStore'
import { activeSearchStore } from '../../session/activeSearchStore'
import { activeSession } from '../../session/activeSession'
import type { OpenDocument } from '../../session/documentSession'
import { getActiveTabId } from '../../session/tabs'
import { useDocumentSession } from '../../session/useDocumentSession'
import { subscribeZoom } from '../../zoom'
import { Scrubber } from '../Scrubber/Scrubber'
import { programmaticChange, rawEditExtension } from './rawEdit'
import { programmaticSelection, rawCaretSyncExtension } from './rawCaretSync'
import { buildOffsetMap, type RawOffsetMap } from './rawOffsetMap'
import { createFrameCoalescer } from './frameCoalescer'
import { registerRawController } from './rawController'
import { clearRawViewport, publishRawViewport } from './rawViewportStore'
import { offsetToRatio } from '../Scrubber/scrubberModel'
import {
  bumpDecorationsEffect,
  rawDecorationsExtension,
  setMatchesEffect,
  setSelectedNodeEffect,
  type RawMatches
} from './rawDecorations'
import { rawLineNumbersExtension } from './rawGutter'
import { rawKeymapExtension, sniffIndentUnit } from './rawKeymap'
import { computeWindowBounds, planReslice, shouldRecenter, WINDOW_BYTES } from './rawWindow'
import { needsWrapToScroll } from './wrapPolicy'
import './Raw.css'

export function Raw(): JSX.Element {
  const state = useDocumentSession()

  // Layout only mounts this pane once a document is ready — the shared
  // phase-aware document area (Layout/DocumentArea.tsx) covers every other phase. This
  // guard exists for type narrowing onto `state.document`, not display.
  if (state.phase !== 'ready') return <></>
  return (
    <RawContent
      document={state.document}
      caretOffset={state.selection.caretOffset}
      selectedNode={state.selection.selectedNode}
    />
  )
}

interface RawContentProps {
  readonly document: OpenDocument
  readonly caretOffset: number
  readonly selectedNode: NodeRef
}

/** What `viewRef` actually needs to track between renders — the window's
 * absolute bounds, kept in lockstep with whatever the live `EditorView`'s
 * document currently holds. */
interface WindowHandle {
  readonly view: EditorView
  readonly wrapCompartment: Compartment
  /** F9 — `EditorState.readOnly`'s own compartment, reconfigured whenever
   * `document.readOnly` changes (Save As on a read-only document clears
   * it, per F7). Mirrors `wrapCompartment`'s own shape exactly. */
  readonly readOnlyCompartment: Compartment
  start: number
  end: number
  /** The window's decoded text and byte↔unit offset map (M5c-PLAN.md J1) —
   * built once per re-slice/mount rather than re-derived per call. Updated
   * *before* the dispatch that changes the view's doc (`applyReslice`), so
   * the decorations plugin (which runs synchronously inside that same
   * dispatch) never observes a `start`/`map` pair that doesn't match the
   * text it's about to build decorations against. */
  text: string
  map: RawOffsetMap
  wrapped: boolean
  /** Guards against a recentre's own geometry settling triggering another
   * recentre before the browser has laid out the result. */
  recentering: boolean
  /** Set once, in the mount effect's cleanup. The wrap-enable path defers a
   * dispatch behind a `requestAnimationFrame`, which can outlive this
   * handle entirely — the document can change (or the component unmount)
   * before that frame fires, and by then `view` is destroyed. Dispatching
   * on a destroyed `EditorView` throws, so every deferred callback checks
   * this before touching `view`. */
  disposed: boolean
}

function absTopOffset(handle: WindowHandle): number {
  // `lineBlockAtHeight` is preferred for precision but throws on a handful
  // of edge geometries (an empty document, a height past the content) —
  // ported from the spike's own fallback (renderer-a6b.js's absTopOffset).
  // `.from` is a UTF-16 unit position into the window's own text, not a
  // byte offset — `handle.map` is what makes adding it to `handle.start`
  // (an absolute byte offset) correct, in O(1)/O(K) rather than the O(window)
  // walk this used before J1 (UI-FEEDBACK.md M5b: under-reporting the
  // viewport's true byte depth on a non-ASCII document is what could stop
  // `shouldRecenter` from ever firing again).
  try {
    const height = Math.round(
      Math.max(0, Math.min(handle.view.scrollDOM.scrollTop, handle.view.contentHeight))
    )
    const localUnits = handle.view.lineBlockAtHeight(height).from
    return handle.start + handle.map.toBytes(localUnits)
  } catch {
    const blocks = handle.view.viewportLineBlocks
    const localUnits = blocks.length > 0 ? blocks[0]!.from : 0
    return handle.start + handle.map.toBytes(localUnits)
  }
}

/** The absolute byte offset of the *bottom* edge of the visible viewport —
 * `absTopOffset`'s counterpart, used only to publish the scrubber's own
 * viewport thumb (UI-FEEDBACK.md M5b): "the thumb shows the viewport, not
 * the window." Not used by `shouldRecenter`, which only ever needs the top
 * edge. */
function absBottomOffset(handle: WindowHandle): number {
  try {
    const height = Math.round(
      Math.max(
        0,
        Math.min(
          handle.view.scrollDOM.scrollTop + handle.view.scrollDOM.clientHeight,
          handle.view.contentHeight
        )
      )
    )
    const localUnits = handle.view.lineBlockAtHeight(height).to
    return handle.start + handle.map.toBytes(localUnits)
  } catch {
    const blocks = handle.view.viewportLineBlocks
    const localUnits = blocks.length > 0 ? blocks[blocks.length - 1]!.to : 0
    return handle.start + handle.map.toBytes(localUnits)
  }
}

/** Exported for `R19-document-props.md` §5a's render-count measurement
 * (`test/documentPropsRenderCost.test.tsx`) — same reasoning `Tree.tsx`'s
 * own `TreeContent` export gives. */
export function RawContent({ document, caretOffset, selectedNode }: RawContentProps): JSX.Element {
  const { store, sourceBuffer, rowIndex, lineIndex } = document
  const hostRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<WindowHandle | null>(null)

  // R41 (`R41-raw-editing.md`): the "live getter" targets the mount
  // effect's extensions close over instead of `store`/`sourceBuffer`/
  // `rowIndex`/`lineIndex` directly — a same-document reparse replaces all
  // four without remounting the `EditorView` (see the mount effect's own
  // key, below), so anything reading them after construction must read
  // through a ref that's current as of the latest render, not a value
  // frozen at whichever render happened to be running when the extension
  // was built. Kept current via `useLayoutEffect` (not a plain `useEffect`,
  // and not assigned directly in the render body, which this project's own
  // lint rule forbids) — `useLayoutEffect` runs synchronously after every
  // commit and, critically, *before* any `useEffect` in the same commit
  // (including the mount/live-update effects below), so a reader inside
  // either of those never observes last-render's values.
  const storeRef = useRef(store)
  const sourceBufferRef = useRef(sourceBuffer)
  const rowIndexRef = useRef(rowIndex)
  const lineIndexRef = useRef(lineIndex)
  // R92 (`R91-focus-into-content.md` §3): the content-focus delegate
  // (registered once, at mount) needs the *current* caret offset at
  // whatever later moment F6 actually fires, not the one closed over when
  // the delegate was created — same live-ref reasoning as the four refs
  // above.
  const caretOffsetRef = useRef(caretOffset)
  // R42/D-070: kept current the same way and for the same reason as the
  // four refs above — `document.pendingSpanDeltas` changes on every
  // `applyEdit`, not just on a reparse, so `rawDecorationsExtension`'s own
  // rebuild (triggered by `update.docChanged`, i.e. every keystroke) must
  // read whatever shift is live as of the edit that just landed.
  const pendingSpanDeltasRef = useRef(document.pendingSpanDeltas)
  // R42 addendum (`R42-stale-spans.md`): keeping the ref current isn't
  // enough on its own — `rawDecorationsExtension`'s rebuild is driven by
  // CodeMirror's own `update.docChanged`, which fires *inside* the keystroke's
  // dispatch, upstream of this component's render entirely. By the time this
  // `useLayoutEffect` runs (after React's commit) the decorations have
  // already been rebuilt once this keystroke, against the *previous* delta
  // list. Tracked separately from `pendingSpanDeltasRef` itself so the
  // dispatch below can tell "changed since the last dispatch" apart from
  // "changed since the last render" — both refs start at the same value, so
  // the very first commit (nothing to correct yet) dispatches nothing.
  const lastDispatchedDeltasRef = useRef(document.pendingSpanDeltas)
  useLayoutEffect(() => {
    storeRef.current = store
    sourceBufferRef.current = sourceBuffer
    rowIndexRef.current = rowIndex
    lineIndexRef.current = lineIndex
    caretOffsetRef.current = caretOffset
    pendingSpanDeltasRef.current = document.pendingSpanDeltas
    if (lastDispatchedDeltasRef.current !== document.pendingSpanDeltas) {
      lastDispatchedDeltasRef.current = document.pendingSpanDeltas
      // A second, corrected rebuild — still before paint, so the wrong-by-one
      // frame the addendum reported is never shown. `handleRef.current` is
      // `null` only before the mount effect has run at all, in which case the
      // mount's own initial decoration build already used this exact value.
      handleRef.current?.view.dispatch({ effects: bumpDecorationsEffect.of(undefined) })
    }
  })
  // The last `store` the live-update effect (below) actually processed —
  // `null` until the mount effect runs, which sets it to the same `store`
  // it just built the view against, so the live-update effect's first firing
  // (paired with every mount, mount-only or not) is recognized as already
  // handled rather than redone.
  const lastLiveStoreRef = useRef<NodeStore | null>(null)
  // R100 (`R100-raw-external-rewrite.md`): the last `document.
  // externalRewrites` the live-update effect (below) actually applied —
  // lets it distinguish "sourceBuffer changed because of typing" (the view
  // already has the text) from "sourceBuffer changed because
  // Replace/Format/Undo/Redo/Reload rewrote it" (the view has never seen
  // it), the one case the in-place `handle.text`/`handle.map` refresh does
  // not cover. `null` until the mount effect runs, same "already handled"
  // pairing as `lastLiveStoreRef`.
  const lastAppliedExternalRewritesRef = useRef<number | null>(null)

  // Tracks the caret offset / selected node this component last applied to
  // the editor, so the effects below can tell "the session moved this
  // externally (Locate in source / a new Tree selection, D14)" apart from
  // "nothing relevant changed" — neither must re-apply on every unrelated
  // re-render.
  const lastPositionedOffsetRef = useRef<number | null>(null)
  const lastAppliedSelectionRef = useRef<NodeRef | null>(null)
  const lastAppliedReadOnlyRef = useRef<boolean | null>(null)
  // G5: what was last dispatched to *whichever* `EditorView` currently
  // exists — `null` after a remount (the mount effect below resets it) so
  // the very next `applyMatches()` call always re-dispatches onto the new
  // view rather than skipping because the search result's own identity
  // happens not to have changed since before the remount.
  const lastAppliedMatchesRef = useRef<{
    starts: Int32Array
    ends: Int32Array
    currentIndex: number | null
  } | null>(null)

  function applyMatches(): void {
    const handle = handleRef.current
    if (handle === null) return
    const result = activeSearchStore.getSnapshot()
    const { currentIndex } = getFindState()
    const last = lastAppliedMatchesRef.current
    if (
      last !== null &&
      last.starts === result.starts &&
      last.ends === result.ends &&
      last.currentIndex === currentIndex
    ) {
      return
    }
    lastAppliedMatchesRef.current = { starts: result.starts, ends: result.ends, currentIndex }
    const matches: RawMatches = { starts: result.starts, ends: result.ends, currentIndex }
    handle.view.dispatch({ effects: setMatchesEffect.of(matches) })
  }

  // UI-FEEDBACK.md M5b: "the thumb shows the viewport, not the window" —
  // publishes the currently-visible range, in document-wide ratio terms
  // (`scrubberModel.ts`'s own `offsetToRatio`, resolved through the row
  // index like every other scrubber position), for the scrubber to render
  // as a thumb. Called on every scroll, plus whenever the window itself
  // moves (mount, reslice, jump) — a re-slice can change what's visible
  // without necessarily firing a `scroll` event.
  // `top`, when the caller already has it (`onScroll`, below), is reused
  // rather than re-derived — `absTopOffset` and `shouldRecenter` used to
  // each compute it independently per scroll event (M5c-PLAN.md §1.1's
  // Cause B), which is real cost even after J1 made one call cheap.
  function publishViewport(handle: WindowHandle, top: number = absTopOffset(handle)): void {
    const bottom = absBottomOffset(handle)
    // `rowIndexRef.current`, not `rowIndex` directly — this function is
    // called from inside the mount effect's own closures (`handleScrollFrame`,
    // `scrubTo`), which R41 keeps alive across a same-document reparse
    // rather than recreating; reading the plain destructured `rowIndex`
    // there would freeze this at whichever `rowIndex` existed at mount.
    publishRawViewport(
      offsetToRatio(rowIndexRef.current, top),
      offsetToRatio(rowIndexRef.current, bottom)
    )
  }

  // D12: true while an about-to-be-enabled wrap is waiting one frame to
  // paint this before doing the ~400 ms layout pass that turning wrap on
  // over a ~1 MB window costs (A6b) — "show a loading state; do not assume
  // it away" is the plan's own instruction, not a nice-to-have.
  const [wrapping, setWrapping] = useState(false)

  // R41 (`R41-raw-editing.md` §2): what the mount effect below keys on
  // instead of `store`. `store` (and `sourceBuffer`/`rowIndex`/`lineIndex`
  // alongside it) changes identity on *every* reparse — including the
  // debounced one a keystroke triggers — so keying the `EditorView`'s own
  // lifetime on it meant every reparse tore the editor down and rebuilt it,
  // destroying focus, selection and scroll. The active tab id changes only
  // when the user switches documents (or this tab's document is replaced
  // wholesale, e.g. Open into a new tab is the only path that creates one),
  // which is the actual "is this still the same document" question this
  // component needs answered. Falls back to `filePath` only for a
  // hypothetical caller with no active tab (there always is one whenever
  // this component is mounted at all — `Raw()`'s own phase guard ensures
  // it — so this is a defensive fallback, not a reachable path).
  const documentIdentity = getActiveTabId() ?? document.filePath

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    const { start, end } = computeWindowBounds(rowIndex, sourceBuffer.byteLength, caretOffset)
    const text = sourceBuffer.slice(start, end)
    // Built before the `EditorView` exists, so the extensions below (whose
    // `create` callback runs synchronously during `new EditorView(...)`,
    // before `handleRef.current` is assigned a few lines down) see a
    // window snapshot that already matches `text` — not a stale one from a
    // previous document, and not a crash from reading a null handle.
    const initialMap = buildOffsetMap(
      text,
      sourceBuffer.encoding,
      sourceBuffer.bytes.subarray(start, end)
    )
    function getWindow(): { start: number; text: string; map: RawOffsetMap } {
      const current = handleRef.current
      return current !== null
        ? { start: current.start, text: current.text, map: current.map }
        : { start, text, map: initialMap }
    }
    const wrapCompartment = new Compartment()
    const readOnlyCompartment = new Compartment()
    const state = EditorState.create({
      doc: text,
      extensions: [
        // R168 (`docs/plans/R168-crlf-edit-offset.md`) — **the single line
        // that makes CodeMirror's document byte-faithful to the window.**
        //
        // CodeMirror's default split is `/\r\n?|\n/`, which treats a CRLF as
        // one line break and **does not keep the `\r` in the document at
        // all**. Every offset in this directory crosses between CodeMirror's
        // UTF-16 positions and the buffer's bytes through an offset map built
        // from the window *text* — which does contain the `\r` — so the two
        // sides were measuring different strings and every conversion
        // undercounted by the number of line breaks before it. An edit on
        // line 2 of a CRLF file spliced one byte early; on line 10, nine. It
        // was silent, because the user sees CodeMirror's own rendering and
        // only the saved bytes were wrong.
        //
        // Splitting on `\n` alone leaves the `\r` as an ordinary character at
        // the end of its line, so `state.doc` and `handle.text` agree unit for
        // unit and **every existing conversion becomes correct with no other
        // change** — `rawEdit`'s two maps, `rawCaretSync`'s, and the
        // decorations'. That is the whole reason this was preferred over
        // teaching each conversion about dropped CRs: the bug is one
        // disagreement, and this removes it rather than compensating for it
        // in four places.
        //
        // `EditorState.lineBreak` follows this facet, so Enter inserts `\n` —
        // unchanged from before, since the facet was previously unset and
        // defaulted to the same thing.
        //
        // **Consequence, stated rather than discovered later:** a lone `\r` is
        // no longer treated as a line break. No format this app parses emits
        // one (it is a pre-1999 Mac convention), and treating it as ordinary
        // text is exactly what keeps the document byte-faithful. Mixed CRLF/LF
        // files — which are common — are handled exactly.
        EditorState.lineSeparator.of('\n'),
        readOnlyCompartment.of(EditorState.readOnly.of(document.readOnly)),
        wrapCompartment.of([]),
        rawDecorationsExtension(
          () => storeRef.current,
          () => sourceBufferRef.current,
          getWindow,
          () => pendingSpanDeltasRef.current
        ),
        rawCaretSyncExtension(() => storeRef.current, getWindow),
        rawLineNumbersExtension(
          () => sourceBufferRef.current,
          () => rowIndexRef.current,
          () => lineIndexRef.current,
          () => handleRef.current?.start ?? 0
        ),
        rawEditExtension(
          activeSession,
          () => sourceBufferRef.current.encoding,
          () => handleRef.current?.start ?? 0,
          (netByteDelta) => {
            // Only `end` shifts — an edit inside the window changes how
            // much more of the document lies ahead of it, never where the
            // window itself begins.
            const current = handleRef.current
            if (current !== null) current.end += netByteDelta
          },
          // R41 §3/§5: mark this offset as already applied *before*
          // `session.setCaretOffset` triggers the re-render that would
          // otherwise carry it into the `caretOffset` effect below — that
          // effect can't otherwise tell "the user just typed here" apart
          // from "Locate in source jumped here," and the latter is the only
          // one that should scroll the pane.
          (offset) => {
            lastPositionedOffsetRef.current = offset
          },
          // R21-notifications.md §1: a refused edit's explanation is an
          // event, not a standing condition (unlike the read-only banner
          // below) — a transient notification, not `severity: 'error'`
          // (which the notification store treats as sticky; this needs to
          // auto-dismiss the way the old 4s local timer did).
          (message) =>
            notify({
              severity: 'warning',
              message,
              documentId: activeDocumentId(),
              dedupeKey: 'raw.editRefused'
            })
        ),
        // R61/R64 (`R61-keyboard-workflow.md` §4–5): sniffed fresh on
        // every keypress from a bounded prefix of the live source buffer,
        // not sniffed once at mount and closed over — `sourceBufferRef`
        // changes on every edit and reparse (R41), and a same-document
        // reparse never recreates this extension.
        rawKeymapExtension(() => sniffIndentUnit(sourceBufferRef.current.slice(0, 20000)))
      ]
    })
    const view = new EditorView({ state, parent: host })
    const handle: WindowHandle = {
      view,
      wrapCompartment,
      readOnlyCompartment,
      start,
      end,
      text,
      map: initialMap,
      wrapped: false,
      recentering: false,
      disposed: false
    }
    handleRef.current = handle
    lastPositionedOffsetRef.current = caretOffset
    // R41: the live-update effect (below) must not redo this same-store
    // work the instant it fires alongside this mount — recording the store
    // this mount just built against is what lets it recognize "already
    // handled" on its own first firing.
    lastLiveStoreRef.current = store
    lastAppliedExternalRewritesRef.current = document.externalRewrites
    // A remount (switching tabs, or opening a genuinely different document
    // into this one — see `documentIdentity`, above) means the new view
    // starts with no matches applied — reset the tracker so `applyMatches`
    // can't skip a dispatch just because the search result's identity
    // happens not to have changed since before the remount.
    lastAppliedMatchesRef.current = null
    applyMatches()

    // The decoration extension's selected-node field defaults to "none" on
    // creation — set it to the document's actual initial selection here,
    // in the same effect that creates the view, rather than relying on the
    // selection-tracking effect below to fire: it won't, if this document's
    // initial `selectedNode` happens to equal whatever the *previous*
    // document's last value was (a real case, not just a hypothetical —
    // node 0 is a common initial selection for any freshly opened document).
    view.dispatch({ effects: setSelectedNodeEffect.of(selectedNode) })
    lastAppliedSelectionRef.current = selectedNode
    lastAppliedReadOnlyRef.current = document.readOnly

    reevaluateWrap(handle, setWrapping)

    const unregisterController = registerRawController({
      toggleWrap: () => manualToggleWrap(handleRef.current, setWrapping),
      scrubTo: (offset) => {
        const handle = handleRef.current
        if (handle === null) return
        // Live refs, not the closed-over `sourceBuffer`/`rowIndex` — this
        // callback can fire long after mount, including after a
        // same-document reparse this effect no longer reruns for (R41).
        jumpTo(handle, sourceBufferRef.current, rowIndexRef.current, offset, setWrapping)
        publishViewport(handle)
      }
    })

    // R92 (`R91-focus-into-content.md` §3): `view.focus()` — the caret needs
    // no repositioning (it's already at the selected node's span start,
    // `setSelectedNode`'s own doc comment) and repositioning it would be
    // actively wrong: leave Raw with the caret somewhere, visit another
    // pane, come back with F6, and the caret must still be where it was
    // left. What does need care is visibility: the caret can be focused and
    // off-screen if the user scrolled Raw with the mouse first (scrolling
    // and the caret are deliberately decoupled, `rawCaretSync.ts`'s own
    // comment). A plain `scrollIntoView` on `caretOffset` isn't safe on its
    // own, though — scrolling can trigger a re-slice, and if the window has
    // moved past the caret's byte offset, `jumpTo` (which already handles
    // both the re-slice and the byte→UTF-16-unit conversion) is what's
    // needed instead of a bare scroll dispatch that would land on text the
    // re-slice just replaced.
    const unregisterContent = registerPaneContent('raw', () => {
      const handle = handleRef.current
      if (handle === null) return false
      handle.view.focus()
      const target = Math.floor(caretOffsetRef.current)
      if (target >= handle.start && target < handle.end) {
        const localBytes = Math.max(0, target - handle.start)
        const local = Math.min(handle.view.state.doc.length, handle.map.toUnits(localBytes))
        handle.view.dispatch({
          effects: EditorView.scrollIntoView(local, {
            y: 'start',
            yMargin: handle.view.defaultLineHeight
          })
        })
      } else {
        jumpTo(handle, sourceBufferRef.current, rowIndexRef.current, target, setWrapping)
        publishViewport(handle)
      }
      return true
    })

    // M5c-PLAN.md J2: `scroll` can fire several times per frame; the actual
    // work (an `absTopOffset` read, a viewport publish, a possible re-slice)
    // only needs to happen once per frame, not once per event. The
    // coalescer collapses a burst into a single queued call — same shape as
    // `rawViewportStore.ts`'s own `quantize`, one layer further down.
    const scrollFrame = createFrameCoalescer(
      (cb) => requestAnimationFrame(cb),
      (id) => cancelAnimationFrame(id)
    )

    function handleScrollFrame(): void {
      const handle = handleRef.current
      if (handle === null || handle.recentering) return

      // Computed once and reused for both the publish below and the
      // recentre check, rather than each deriving it independently
      // (M5c-PLAN.md §1.1's Cause B).
      const topOffset = absTopOffset(handle)

      // Published on every scroll frame regardless of whether this one also
      // triggers a recentre — the scrubber thumb needs to track the
      // viewport continuously, not just at re-slice boundaries.
      // `publishRawViewport` itself quantizes, so this doesn't mean a
      // re-render per frame.
      publishViewport(handle, topOffset)

      // Live refs — this closure is created once, at mount, and (R41) is no
      // longer recreated on a same-document reparse, so `sourceBuffer`/
      // `rowIndex` from the render that happened to be running at mount
      // time would otherwise go stale the moment the document's byte
      // length changes from an edit.
      const currentSourceBuffer = sourceBufferRef.current
      const currentRowIndex = rowIndexRef.current
      if (!shouldRecenter(topOffset, handle.start, handle.end, currentSourceBuffer.byteLength)) {
        return
      }

      handle.recentering = true
      try {
        const { start: newStart, end: newEnd } = computeWindowBounds(
          currentRowIndex,
          currentSourceBuffer.byteLength,
          topOffset,
          WINDOW_BYTES
        )
        applyReslice(handle, currentSourceBuffer, newStart, newEnd, setWrapping)
        publishViewport(handle)
      } finally {
        // In `finally`, not just after the call: a bug in `applyReslice`
        // throwing would otherwise leave `recentering` stuck `true` forever
        // — a silent, permanent loss of re-centering for the rest of the
        // session, far worse than whatever the original throw was.
        handle.recentering = false
      }
    }
    function onScroll(): void {
      scrollFrame.request(handleScrollFrame)
    }
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
    publishViewport(handle)

    return () => {
      handle.disposed = true
      unregisterController()
      unregisterContent()
      view.scrollDOM.removeEventListener('scroll', onScroll)
      scrollFrame.cancel()
      view.destroy()
      handleRef.current = null
      clearRawViewport()
    }
    // R41: keyed on `documentIdentity` (the active tab), not `store` — a
    // reparse of the *same* document no longer tears this down (the
    // live-update effect below handles that case instead); only switching
    // to a genuinely different document does. Runtime jumps to a different
    // `caretOffset` are handled by the effect below rather than by
    // recreating the whole editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentIdentity])

  // R41 §2: the other half of "don't remount on a same-document reparse" —
  // this is what M5g-PLAN.md's O4 called "a second effect ... that
  // re-slices the window and forces a decoration rebuild without destroying
  // the view." Fires whenever a reparse actually lands (any of the four
  // values below get a new identity together, `applyReparseResult`'s own
  // commit point), *not* on every keystroke — `sourceBuffer` alone changes
  // per edit (`OpenDocument`'s own doc comment), but `store`/`rowIndex`/
  // `lineIndex` only change once the debounced reparse completes, and it's
  // that landing this effect exists to react to.
  useEffect(() => {
    const handle = handleRef.current
    if (handle === null) return
    // Paired with the mount effect above: on the very same commit a mount
    // happens, this would otherwise immediately redo work the mount effect
    // already did against the identical `store`.
    if (lastLiveStoreRef.current === store) return
    lastLiveStoreRef.current = store

    // R100 (`R100-raw-external-rewrite.md`): `document.externalRewrites`
    // is the explicit signal that `sourceBuffer` was replaced by something
    // other than typing in this editor (Replace/Replace All, Format,
    // Minify, Undo, Redo, Reload) — the one case the in-place refresh below
    // does not cover, because the view's own document was never told about
    // that rewrite the way it's told about every keystroke. Checked before
    // updating the ref, so the comparison is always against what this
    // effect last actually applied, not the render that happened to be
    // current.
    const rewrittenExternally = lastAppliedExternalRewritesRef.current !== document.externalRewrites
    lastAppliedExternalRewritesRef.current = document.externalRewrites

    if (rewrittenExternally) {
      // A reslice, not a patch, because the window bounds themselves may
      // have moved by a large factor (e.g. every offset after a Format) —
      // clamping `handle.end` to the new length the way the in-place path
      // below does would keep a window that no longer describes anything
      // meaningful. `caretOffset` is where F5's cascade has already
      // re-resolved the selection to, so recomputing the window around it
      // is the same thing an open does, and lands the view where the model
      // says the selection is.
      const { start, end } = computeWindowBounds(rowIndex, sourceBuffer.byteLength, caretOffset)
      // `forceReplace: true` — the byte range this window shares with the
      // *previous* one (if any) may hold entirely different content now;
      // see `applyReslice`'s own doc comment on why the incremental path
      // must not run here.
      applyReslice(handle, sourceBuffer, start, end, setWrapping, true)
      // `applyReslice` already dispatches a content change, which
      // `rawDecorationsExtension`'s own `update.docChanged` check rebuilds
      // decorations from — no separate `bumpDecorationsEffect` needed here.
      lastPositionedOffsetRef.current = caretOffset
      publishViewport(handle)
      return
    }

    // `handle.start` never moves for an ordinary edit (only a re-slice
    // moves it — `applyReslice`'s own comment) and `handle.end` is kept in
    // lockstep with every edit's own byte delta (`rawEditExtension`'s
    // `onApplied` callback, above) — so the byte *range* the window covers
    // is already correct. What's stale is `handle.text`/`handle.map`
    // themselves: they were decoded from the *previous* `sourceBuffer`, and
    // nothing re-derives them on a plain edit (only `applyReslice` does),
    // even though the live `EditorView`'s own document already reflects
    // every character the user has typed — CodeMirror is what the user has
    // been typing into all along, and this branch runs only when
    // `externalRewrites` says nothing rewrote it out from under that.
    // Clamped defensively against the new `sourceBuffer`'s length, though
    // in practice it should already be in range — every edit's
    // `netByteDelta` and every reparse's resulting `byteLength` come from
    // the same sequence of edits.
    const clampedEnd = Math.min(handle.end, sourceBuffer.byteLength)
    const clampedStart = Math.min(handle.start, clampedEnd)
    handle.start = clampedStart
    handle.end = clampedEnd
    handle.text = sourceBuffer.slice(clampedStart, clampedEnd)
    handle.map = buildOffsetMap(
      handle.text,
      sourceBuffer.encoding,
      sourceBuffer.bytes.subarray(clampedStart, clampedEnd)
    )

    // Nothing here dispatches a *content* change — the view's own document
    // is already the live, correct text. Node refs now resolve against a
    // new `NodeStore`, though, so the decorations built against the old one
    // are stale — `bumpDecorationsEffect` (`rawDecorations.ts`) is what
    // forces that rebuild without requiring a value in CodeMirror's own
    // state to have actually changed.
    handle.view.dispatch({ effects: bumpDecorationsEffect.of(undefined) })
  }, [store, sourceBuffer, rowIndex, lineIndex, document.externalRewrites, caretOffset])

  useEffect(() => {
    const handle = handleRef.current
    if (handle === null) return
    // The initial mount above already positioned the editor at this exact
    // offset — this effect is only for a *subsequent* change (D14's
    // "Locate in source"), so it must not immediately re-run its own jump.
    // R41 §3/§5: a caret move the user caused by typing is marked "already
    // positioned" by `rawEditExtension`'s `onCaretMoved` callback before
    // `session.setCaretOffset` ever triggers this render, so this guard is
    // also what keeps typing from re-scrolling the pane out from under the
    // person still typing in it — only a genuine external jump reaches the
    // `jumpTo` call below.
    if (lastPositionedOffsetRef.current === caretOffset) return
    lastPositionedOffsetRef.current = caretOffset

    jumpTo(handle, sourceBuffer, rowIndex, caretOffset, setWrapping)
    publishViewport(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caretOffset])

  useEffect(() => {
    const handle = handleRef.current
    if (handle === null) return
    if (lastAppliedSelectionRef.current === selectedNode) return
    lastAppliedSelectionRef.current = selectedNode

    handle.view.dispatch({ effects: setSelectedNodeEffect.of(selectedNode) })
  }, [selectedNode])

  // M4-PLAN.md G5: pushes the live Find result (and which match is
  // "current") into the editor's decoration state — `activeSearchStore`
  // and `findStore` are both module-level singletons `RawContent` has no
  // other reason to re-render on, so this subscribes directly rather than
  // going through props/`useSyncExternalStore` (which would re-render the
  // whole pane on every keystroke of a search). `[]` deps: `RawContent`
  // itself doesn't remount between documents (only the mount effect above,
  // keyed on `store`, recreates the `EditorView`), and `applyMatches`
  // re-reads `handleRef.current` fresh on every call rather than closing
  // over a specific view — so one subscription for the component's whole
  // lifetime is correct, not stale.
  useEffect(() => {
    applyMatches()
    const unsubscribeSearch = activeSearchStore.subscribe(applyMatches)
    const unsubscribeFind = subscribeFind(applyMatches)
    return () => {
      unsubscribeSearch()
      unsubscribeFind()
    }
  }, [])

  useEffect(() => {
    const handle = handleRef.current
    if (handle === null) return
    // Mirrors `wrapCompartment`'s own reconfigure pattern, and
    // `lastPositionedOffsetRef`/`lastAppliedSelectionRef`'s own "don't
    // re-apply what the mount effect already applied" guard exactly: the
    // mount effect above already dispatches the *initial* value, so this
    // effect firing on that same mount (every `useEffect` runs once
    // regardless of its dependency array) must not redundantly re-dispatch
    // it — only a genuine change after mount (F7's Save As clearing
    // `readOnly` on a document opened read-only) should.
    if (lastAppliedReadOnlyRef.current === document.readOnly) return
    lastAppliedReadOnlyRef.current = document.readOnly

    handle.view.dispatch({
      effects: handle.readOnlyCompartment.reconfigure(EditorState.readOnly.of(document.readOnly))
    })
  }, [document.readOnly])

  // R59 (`R58-zoom.md` §4's own trap): CodeMirror's `defaultLineHeight`
  // (`jumpTo`'s scroll-margin, above) does not recompute itself just because
  // the page's zoom changed — measured directly, not assumed: a CSS `zoom`
  // change alone left a bare `EditorView`'s `defaultLineHeight` completely
  // stale until an explicit `requestMeasure()` was called, with no auto
  // remeasure even ~100ms later. Real Electron zoom
  // (`webContents.setZoomFactor`, not the CSS `zoom` property that was
  // probed) may drive CodeMirror's own `ResizeObserver` more reliably, but
  // nothing here depends on hoping so — every zoom change nudges whichever
  // `EditorView` is currently mounted to remeasure explicitly. `handleRef
  // .current` read fresh inside the callback, not closed over, the same
  // reason `applyMatches` above does — one subscription for the component's
  // whole lifetime, correct across a same-document reparse (R41) since that
  // never recreates `handleRef.current`'s identity.
  useEffect(() => {
    return subscribeZoom(() => {
      handleRef.current?.view.requestMeasure()
    })
  }, [])

  return (
    <div className="raw-pane">
      {document.readOnly && (
        <p className="raw-banner raw-banner-warning" role="alert">
          This file is read-only — changes can't be saved here.
        </p>
      )}
      <div className="raw-container">
        <div className="raw" ref={hostRef} />
        <Scrubber />
        {wrapping && (
          <div className="raw-wrapping-overlay" role="status">
            Wrapping…
          </div>
        )}
      </div>
    </div>
  )
}

/** Applies a re-slice plan to `handle`'s live view — the two-edge
 * incremental dispatch for the overlapping case, a full replace otherwise
 * — and updates `handle`'s recorded bounds to match. Every offset used to
 * slice `sourceBuffer` is an integer already (row-boundary-snapped by
 * `computeWindowBounds`), but floored again here regardless — arithmetic
 * feeding a byte slice should never trust a caller not to have introduced
 * a fraction (CONCEPT.md §4.4's own warning: a fractional offset defeats
 * boundary snapping silently and throws asynchronously, far from its
 * cause).
 *
 * `forceReplace` (R100): `planReslice`'s incremental path assumes old and
 * new windows describe the *same* buffer — the shared byte range is kept as
 * whatever `handle.text` already holds there, which is exactly right for a
 * scroll-triggered recentre and exactly wrong for a rewrite that replaced
 * the buffer's *content*: a byte range that overlaps in offset terms can
 * hold completely different characters across a Format or Replace, and
 * reusing the old decoded text for it corrupts the result (measured:
 * `{"a":1,"b":2}` formatted showed up as `{"a":1,"b":2} "b": 2\n}\n`, an old/
 * new splice at whatever offset happened to overlap). `Raw.tsx`'s
 * live-update effect passes `true` whenever `document.externalRewrites`
 * says the buffer underneath this window is not the one `handle.text` was
 * ever decoded from. */
function applyReslice(
  handle: WindowHandle,
  sourceBuffer: OpenDocument['sourceBuffer'],
  newStart: number,
  newEnd: number,
  setWrapping: (wrapping: boolean) => void,
  forceReplace = false
): void {
  const start = Math.floor(newStart)
  const end = Math.floor(newEnd)
  const plan: ReturnType<typeof planReslice> = forceReplace
    ? { kind: 'replace', newStart: start, newEnd: end }
    : planReslice(handle.start, handle.end, start, end)
  const encoding = sourceBuffer.encoding

  if (plan.kind === 'replace') {
    const text = sourceBuffer.slice(plan.newStart, plan.newEnd)
    // Bounds/text/map are updated *before* dispatch (see `WindowHandle.map`'s
    // own comment) — the decorations plugin's `update()` runs synchronously
    // inside `dispatch`, and must see the new window, not the old one, since
    // it's the new text the dispatch is about to install.
    handle.start = plan.newStart
    handle.end = plan.newEnd
    handle.text = text
    handle.map = buildOffsetMap(
      text,
      encoding,
      sourceBuffer.bytes.subarray(plan.newStart, plan.newEnd)
    )
    handle.view.dispatch({
      changes: { from: 0, to: handle.view.state.doc.length, insert: text },
      annotations: programmaticChange.of(true)
    })
    maybeReevaluateWrap(handle, setWrapping)
    return
  }

  const oldStart = handle.start
  const oldText = handle.text
  const oldMap = handle.map
  const oldLength = handle.view.state.doc.length
  const leadingText =
    plan.leading.end > plan.leading.start
      ? sourceBuffer.slice(plan.leading.start, plan.leading.end)
      : ''
  const trailingText =
    plan.trailing.end > plan.trailing.start
      ? sourceBuffer.slice(plan.trailing.start, plan.trailing.end)
      : ''
  // The shared middle is already decoded — in `oldText`, at the local unit
  // range `oldMap` (still valid; nothing has been reassigned yet) converts
  // the shared byte range to — so the new window's full text is assembled
  // without a second `sourceBuffer.slice` over content already in memory.
  const sharedStartUnits = oldMap.toUnits(plan.sharedStart - oldStart)
  const sharedEndUnits = oldMap.toUnits(plan.sharedEnd - oldStart)
  const newText = leadingText + oldText.slice(sharedStartUnits, sharedEndUnits) + trailingText

  handle.start = plan.newStart
  handle.end = plan.newEnd
  handle.text = newText
  handle.map = buildOffsetMap(
    newText,
    encoding,
    sourceBuffer.bytes.subarray(plan.newStart, plan.newEnd)
  )

  handle.view.dispatch({
    // `sharedStartUnits`/`sharedEndUnits`, not `plan.sharedStart - oldStart`
    // (a BYTE delta) — CodeMirror's `from`/`to` are UTF-16 unit positions,
    // and the two only coincide on ASCII. A latent instance of the same
    // byte/unit confusion `30f1737` fixed elsewhere, caught incidentally
    // while building the map this re-slice needs anyway.
    changes: [
      { from: 0, to: sharedStartUnits, insert: leadingText },
      { from: sharedEndUnits, to: oldLength, insert: trailingText }
    ],
    annotations: programmaticChange.of(true)
  })
  maybeReevaluateWrap(handle, setWrapping)
}

/** An explicit jump — "Locate in source," or the initial position when a
 * document opens with a non-zero caret/error offset — unlike the silent
 * scroll-triggered recentre in the mount effect above, this also moves the
 * caret and scrolls it into view, since the user (or a command acting on
 * their behalf) asked to go somewhere specific. */
function jumpTo(
  handle: WindowHandle,
  sourceBuffer: OpenDocument['sourceBuffer'],
  rowIndex: Int32Array,
  offset: number,
  setWrapping: (wrapping: boolean) => void
): void {
  const target = Math.floor(offset)
  if (target < handle.start || target >= handle.end) {
    const { start, end } = computeWindowBounds(rowIndex, sourceBuffer.byteLength, target)
    applyReslice(handle, sourceBuffer, start, end, setWrapping)
  }
  // `target - handle.start` is a BYTE delta into the window; the editor's
  // own local position is a UTF-16 unit index — the two only coincide on
  // ASCII (UI-FEEDBACK.md M5b, the same bug class as `absTopOffset` above,
  // not in its own table of four sites but the identical mistake). `handle`
  // was re-sliced above if needed, so `handle.map` already reflects
  // whichever window `target` actually falls in.
  const localBytes = Math.max(0, target - handle.start)
  const local = Math.min(handle.view.state.doc.length, handle.map.toUnits(localBytes))
  handle.view.dispatch({
    selection: { anchor: local },
    // User feedback after R8f: centering the target line left it mid-
    // window, with no visual anchor to "where I came from." `y: 'start'`
    // with a one-line `yMargin` lands the target as the *second* visible
    // row instead — one line of leading context, not buried in the
    // middle. `defaultLineHeight` (not a hardcoded pixel value) so this
    // stays correct across font-size/zoom changes.
    effects: EditorView.scrollIntoView(local, {
      y: 'start',
      yMargin: handle.view.defaultLineHeight
    }),
    annotations: programmaticSelection.of(true)
  })
}

/**
 * The automatic half of D12's wrap rule, run unconditionally on mount and
 * on a document change (a reparse remounts the whole `EditorView`). Always
 * measures in the *unwrapped* state first: wrapping only ever adds visual
 * rows, so a "yes, this scrolls" measurement taken while still wrapped
 * can't tell you whether the underlying content would still scroll without
 * it, but the reverse always holds — unwrapped scrollHeight is a true
 * lower bound on wrapped scrollHeight. This is also what makes it costly:
 * forcing an unwrap, reading `scrollHeight` (a synchronous layout), and
 * possibly re-wrapping a frame later (A6b: ~400 ms) — cheap once per
 * document, not something a re-slice should pay on every window crossing.
 * `maybeReevaluateWrap`, below, is what a re-slice actually calls.
 *
 * Enabling wrap (never disabling) is deferred one frame behind a loading
 * flag — A6b measured ~400 ms of first-paint cost turning wrap on over a
 * ~1 MB window, and the plan is explicit that this needs a visible loading
 * state, not silence while the main thread blocks.
 */
/** The deferred-behind-a-loading-flag part of enabling wrap, shared by the
 * automatic and manual paths. Guards against `handle` having outlived its
 * view — see `WindowHandle.disposed`'s own comment — since the whole point
 * of deferring to the next frame is that the world can change out from
 * under this callback before it runs. */
function enableWrapDeferred(handle: WindowHandle, setWrapping: (wrapping: boolean) => void): void {
  setWrapping(true)
  requestAnimationFrame(() => {
    if (handle.disposed) return
    handle.view.dispatch({ effects: handle.wrapCompartment.reconfigure(EditorView.lineWrapping) })
    handle.wrapped = true
    setContext('isWrapped', true)
    setWrapping(false)
  })
}

function reevaluateWrap(handle: WindowHandle, setWrapping: (wrapping: boolean) => void): void {
  if (handle.wrapped) {
    handle.view.dispatch({ effects: handle.wrapCompartment.reconfigure([]) })
    handle.wrapped = false
  }

  const el = handle.view.scrollDOM
  if (!needsWrapToScroll(el.scrollHeight, el.clientHeight)) {
    setContext('isWrapped', false)
    return
  }

  enableWrapDeferred(handle, setWrapping)
}

/**
 * M5c-PLAN.md J3 — what a re-slice calls instead of `reevaluateWrap`
 * unconditionally. A re-slice moves the window over content of the same
 * kind; the only transition that should actually flip wrap is
 * minified↔not-minified, and that's a property of the *document*
 * (`hasMeaningfulLines`), not of which window happens to be loaded — it
 * cannot change between two re-slices of the same document. So: take one
 * cheap reading of the window's *current* (not force-unwrapped) geometry,
 * and only pay for the full unwrap/measure/maybe-rewrap dance if that
 * reading actually disagrees with the wrap state already in effect.
 *
 * This read is exact when `handle` is currently unwrapped (the current
 * `scrollHeight` already *is* the lower-bound measurement
 * `reevaluateWrap` would take) and only approximate when currently
 * wrapped (wrap-added rows can make `scrollHeight` read "still needs
 * wrap" even in the rare case where the true unwrapped answer flipped to
 * "no longer does") — an accepted imprecision (a document that stays
 * wrapped one re-slice longer than strictly necessary, never the reverse)
 * in exchange for not forcing that layout pass on every window crossing.
 */
function maybeReevaluateWrap(handle: WindowHandle, setWrapping: (wrapping: boolean) => void): void {
  const el = handle.view.scrollDOM
  const needsWrap = needsWrapToScroll(el.scrollHeight, el.clientHeight)
  if (needsWrap === handle.wrapped) return
  reevaluateWrap(handle, setWrapping)
}

/**
 * The manual half of D12's wrap rule (`klados.raw.toggleWrap`, via
 * `rawController.ts`). Toggling on is always safe; toggling off is
 * immediately checked against the same measurement `reevaluateWrap` uses,
 * and reverted if it would leave the window with no scroll surface —
 * "the automatic rule must win when the window cannot otherwise scroll"
 * is the plan's own wording for exactly this case.
 */
function manualToggleWrap(
  handle: WindowHandle | null,
  setWrapping: (wrapping: boolean) => void
): void {
  if (handle === null) return

  if (handle.wrapped) {
    // Turning wrap off is cheap (no reflow of previously-unwrapped text to
    // compute) — applied immediately, then checked against the same rule
    // `reevaluateWrap` uses.
    handle.view.dispatch({ effects: handle.wrapCompartment.reconfigure([]) })
    handle.wrapped = false
    const el = handle.view.scrollDOM
    if (needsWrapToScroll(el.scrollHeight, el.clientHeight)) {
      handle.view.dispatch({ effects: handle.wrapCompartment.reconfigure(EditorView.lineWrapping) })
      handle.wrapped = true
    }
    setContext('isWrapped', handle.wrapped)
    return
  }

  // Turning wrap on is the expensive direction (A6b: ~400 ms over ~1 MB) —
  // same one-frame-deferred loading state as the automatic path.
  enableWrapDeferred(handle, setWrapping)
}
