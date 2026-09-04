/**
 * CodeMirror-facing layer over `decorations.ts` (M1-PLAN.md D11): turns
 * `DecorationSpan`/`Range` values into an actual `Decoration.mark` range
 * set, rebuilt whenever the viewport, the document (after a re-slice), or
 * the selected node changes. Colours come from D2's token set via CSS
 * classes (`Raw.css`), never inline styles.
 */
import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView } from '@codemirror/view'
import type { SourceBuffer } from '../../../core/buffer'
import type { NodeStore } from '../../../core/nodeStore'
import type { NodeRef } from '../../../core/types'
import type { DeltaList } from '../../../core/deltaList'
import { NO_SELECTION } from '../../session/documentSession'
import { selectionDecoration, viewportDecorations, type SyntaxClass } from './decorations'
import { viewportMatchDecorations } from './matchDecorations'
import type { RawWindowSnapshot } from './rawOffsetMap'

export const setSelectedNodeEffect = StateEffect.define<NodeRef>()

const selectedNodeField = StateField.define<NodeRef>({
  create: () => NO_SELECTION,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSelectedNodeEffect)) return effect.value
    }
    return value
  }
})

/** The Find match set (G5) plus which one, if any, is the "current" match
 * navigation is parked on — ascending `starts`/`ends`, same shape as
 * `SearchResult`. Kept as its own `StateEffect`/`StateField`, same pattern
 * as `selectedNodeField` above — a live, externally-computed value fed into
 * the decoration rebuild rather than owned by CodeMirror itself. */
export interface RawMatches {
  readonly starts: Int32Array
  readonly ends: Int32Array
  readonly currentIndex: number | null
}

const NO_MATCHES: RawMatches = {
  starts: new Int32Array(0),
  ends: new Int32Array(0),
  currentIndex: null
}

export const setMatchesEffect = StateEffect.define<RawMatches>()

const matchesField = StateField.define<RawMatches>({
  create: () => NO_MATCHES,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMatchesEffect)) return effect.value
    }
    return value
  }
})

/**
 * R41 (`R41-raw-editing.md`): forces a decoration rebuild without
 * requiring the docChanged/viewportChanged/selectionChanged/matchesChanged
 * value-equality checks below to actually observe a change. The live-update
 * effect that replaces a same-document reparse's remount (`Raw.tsx`) needs
 * this specifically for the case where `selectedNode` is unchanged as a
 * *number* but now resolves against a brand-new `NodeStore` — dispatching
 * `setSelectedNodeEffect.of(selectedNode)` again wouldn't change the
 * field's value (same number), so `selectionChanged` would read `false`
 * even though the decorations built against the old store are now stale.
 */
export const bumpDecorationsEffect = StateEffect.define<undefined>()

const decorationsEpochField = StateField.define<number>({
  create: () => 0,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(bumpDecorationsEffect)) return value + 1
    }
    return value
  }
})

const SYNTAX_CLASS_NAMES: Record<SyntaxClass, string> = {
  tagName: 'cm-np-tagName',
  string: 'cm-np-string',
  number: 'cm-np-number',
  keyword: 'cm-np-keyword',
  comment: 'cm-np-comment'
}
const SELECTION_CLASS_NAME = 'cm-np-selected'
const MATCH_CLASS_NAME = 'cm-np-match'
const MATCH_CURRENT_CLASS_NAME = 'cm-np-match-current'

function buildDecorationSet(
  view: EditorView,
  store: NodeStore,
  source: SourceBuffer,
  window: RawWindowSnapshot,
  deltas: DeltaList
): DecorationSet {
  // `view.viewport.from`/`.to`/`docLength` are all UTF-16 unit positions
  // into the window's own text — everything `store`/`source` deal in is
  // absolute bytes. Mixing the two is invisible on ASCII (UI-FEEDBACK.md
  // M5b) and wrong everywhere else, so every boundary crossing below goes
  // through `window.map` — built once per re-slice (J1), not re-derived
  // per mark, which is what made this function cost up to 2 479 ms per
  // rebuild before (`M5c-PLAN.md` §1.1).
  const { start: windowStart, map } = window
  const docLength = view.state.doc.length
  const windowEndByte = windowStart + map.toBytes(docLength)
  const from = windowStart + map.toBytes(view.viewport.from)
  const to = windowStart + map.toBytes(view.viewport.to)

  const marks: { start: number; end: number; className: string }[] = []
  for (const span of viewportDecorations(store, source, from, to, deltas)) {
    marks.push({ start: span.start, end: span.end, className: SYNTAX_CLASS_NAMES[span.className] })
  }

  const selectedNode = view.state.field(selectedNodeField)
  const selected = selectionDecoration(store, selectedNode, windowStart, windowEndByte, deltas)
  if (selected !== null) {
    marks.push({ start: selected.start, end: selected.end, className: SELECTION_CLASS_NAME })
  }

  const matches = view.state.field(matchesField)
  for (const span of viewportMatchDecorations(
    matches.starts,
    matches.ends,
    matches.currentIndex,
    from,
    to
  )) {
    marks.push({
      start: span.start,
      end: span.end,
      className: span.current ? MATCH_CURRENT_CLASS_NAME : MATCH_CLASS_NAME
    })
  }

  // `RangeSetBuilder.add` requires non-decreasing `from` — sorting is not
  // an optimization here, it's the contract.
  marks.sort((a, b) => a.start - b.start || a.end - b.end)

  const builder = new RangeSetBuilder<Decoration>()
  for (const mark of marks) {
    const startBytes = Math.max(0, mark.start - windowStart)
    const endBytes = Math.max(0, mark.end - windowStart)
    const localFrom = Math.min(docLength, map.toUnits(startBytes))
    const localTo = Math.min(docLength, map.toUnits(endBytes))
    if (localFrom < localTo)
      builder.add(localFrom, localTo, Decoration.mark({ class: mark.className }))
  }
  return builder.finish()
}

/**
 * `getWindow` is called fresh on every rebuild rather than closed over as a
 * constant — the window (its absolute start, decoded text and offset map)
 * changes on every re-slice (`rawWindow.ts`), and decorations must always
 * be built against whatever it currently is, not whatever it was when this
 * extension was constructed (once, per `EditorView`, in `Raw.tsx`'s mount
 * effect). `Raw.tsx` guarantees the snapshot `getWindow` returns already
 * reflects a re-slice's new text *before* dispatching it, so this never
 * observes a window whose `start`/`map` don't match the view's own doc.
 *
 * R41: `getStore`/`getSource` are live getters, not closed-over values, for
 * the same reason — a same-document reparse (`Raw.tsx`'s live-update
 * effect) replaces `store`/`sourceBuffer` without recreating this
 * `EditorView`, so a rebuild triggered any time after that must read the
 * *current* store, not the one this extension happened to be constructed
 * against.
 */
/** R42/D-070: `getDeltas` is a live getter, same reasoning as `getStore`/
 * `getSource` above — `Raw.tsx` updates the ref it reads every render (via
 * `useLayoutEffect`, before this extension's own `update` can run), so a
 * rebuild triggered by `update.docChanged` (every keystroke) always reads
 * the delta list current as of the edit that just landed, not the one this
 * extension happened to close over at construction. */
export function rawDecorationsExtension(
  getStore: () => NodeStore,
  getSource: () => SourceBuffer,
  getWindow: () => RawWindowSnapshot,
  getDeltas: () => DeltaList
): Extension {
  const plugin = ViewPlugin.define(
    (view) => ({
      decorations: buildDecorationSet(view, getStore(), getSource(), getWindow(), getDeltas()),
      update(update) {
        const selectionChanged =
          update.state.field(selectedNodeField) !== update.startState.field(selectedNodeField)
        const matchesChanged =
          update.state.field(matchesField) !== update.startState.field(matchesField)
        const epochChanged =
          update.state.field(decorationsEpochField) !==
          update.startState.field(decorationsEpochField)
        if (
          update.docChanged ||
          update.viewportChanged ||
          selectionChanged ||
          matchesChanged ||
          epochChanged
        ) {
          this.decorations = buildDecorationSet(
            update.view,
            getStore(),
            getSource(),
            getWindow(),
            getDeltas()
          )
        }
      }
    }),
    { decorations: (value) => value.decorations }
  )

  return [selectedNodeField, matchesField, decorationsEpochField, plugin]
}
