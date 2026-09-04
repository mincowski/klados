/**
 * The Detail View (M1-PLAN.md D9, CONCEPT.md §4.3): breadcrumb, node
 * header, comment block, value block, scalar facets table, and the
 * children section — list mode only, per M1's own scope (grid mode is M2).
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import type { NodeStore } from '../../../core/nodeStore'
import type { SourceBuffer } from '../../../core/buffer'
import type { NodeRef } from '../../../core/types'
import type { DeltaList } from '../../../core/deltaList'
import { getFormatCapabilities } from '../../../formats/registry'
import { registerPaneContent, wasLastFocusedPane } from '../../focus'
import { glyphFontClass } from '../../glyphFont'
import {
  childCountOf,
  glyphOf,
  hasChildren,
  kindLabelOf,
  labelOf,
  previewOf
} from '../../nodeDisplay'
import { selectNode } from '../../selectNode'
import { NO_SELECTION, type OpenDocument } from '../../session/documentSession'
import { useDocumentSession } from '../../session/useDocumentSession'
import { Scrollbar } from '../Scrollbar/Scrollbar'
import {
  adjacentCommentOf,
  childrenColumnLayout,
  copyPathFor,
  pathSegmentsOf,
  scalarFacetsOf,
  valueTextOf,
  type PathSegment
} from './detailModel'
import { detectGrid } from './gridDetection'
import { collectGroupMembers } from './gridColumns'
import { focusGrid } from './gridController'
import { Grid } from './Grid'
import { resolveWrapperTarget, skippedComments } from '../../wrapperDescent'
import { useRovingTabIndex } from '../../rovingTabIndex'
import './Detail.css'

const ROW_HEIGHT = 23

export function Detail(): JSX.Element {
  const state = useDocumentSession()

  // Layout only mounts this pane once a document is ready — the shared
  // phase-aware document area (Layout/DocumentArea.tsx) covers every other phase. This
  // guard exists for type narrowing onto `state.document`, not display.
  if (state.phase !== 'ready') return <></>
  if (state.selection.selectedNode === NO_SELECTION) {
    return (
      <p className="detail-empty" role="status">
        No node selected.
      </p>
    )
  }
  return <DetailContent document={state.document} selectedNode={state.selection.selectedNode} />
}

interface DetailContentProps {
  readonly document: OpenDocument
  readonly selectedNode: NodeRef
}

/** Exported for `R19-document-props.md` §5a's render-count measurement
 * (`test/documentPropsRenderCost.test.tsx`) — `Detail` itself reads
 * `useDocumentSession()`, a module-level singleton a from-scratch render
 * can't easily stand up; this takes its document as a plain prop, same
 * reasoning `Tree.tsx`'s own `TreeContent` export gives. */
export function DetailContent({ document, selectedNode }: DetailContentProps): JSX.Element {
  const { store, sourceBuffer, formatId, pendingSpanDeltas } = document
  const capabilities = getFormatCapabilities(formatId)

  // A transparent wrapper (§4.3, D-015) has nothing useful to show on its
  // own — one composite child, no attributes, no text — so the view
  // descends through it and everything below is drawn from `node`, the
  // first thing actually worth showing. `skipped` is empty and `node ===
  // selectedNode` whenever the selection wasn't a wrapper chain, so this is
  // a no-op in the common case.
  const { destination: node, skipped } = useMemo(
    () => resolveWrapperTarget(store, selectedNode),
    [store, selectedNode]
  )

  const segments = useMemo(() => pathSegmentsOf(store, node), [store, node])
  const kind = store.kindOf(node)
  const name = store.nameOf(node)
  const childCount = hasChildren(store, node) ? childCountOf(store, node) : 0
  const commentNode = adjacentCommentOf(store, node)
  const commentText =
    commentNode !== null ? valueTextOf(store, sourceBuffer, commentNode, pendingSpanDeltas) : null
  // Comments attached to nodes descended through are not lost (§4.3) — each
  // is surfaced here labelled with the segment it came from, ahead of the
  // destination's own comment (if any), in document order.
  const wrapperComments = useMemo(() => skippedComments(store, skipped), [store, skipped])
  const value = valueTextOf(store, sourceBuffer, node, pendingSpanDeltas)
  const facets =
    capabilities?.hasAttributes === true
      ? scalarFacetsOf(store, sourceBuffer, node, pendingSpanDeltas)
      : []

  // UI-FEEDBACK.md M5b / D-049: the manual grid/list override (M2 E9)
  // is gone — `detection.grid` is now the only source of grid mode, so
  // there's nothing left to reconcile against an override.
  const detection = useMemo(() => detectGrid(store, node), [store, node])
  const useGrid = detection.grid !== null
  const gridMembers = useMemo(
    () =>
      useGrid && detection.grid !== null
        ? collectGroupMembers(store, node, detection.grid.nameId)
        : [],
    [useGrid, detection.grid, store, node]
  )
  const gridMemberSet = useMemo(() => new Set(gridMembers), [gridMembers])

  const paneRef = useRef<HTMLDivElement>(null)

  // R94 (`R91-focus-into-content.md` §5): grid mode focuses `.grid-scroll`
  // via the existing `GridController` (the element lives in the `Grid`
  // child); list mode focuses `.detail` itself — already the pane's own
  // scroller (`height: 100%; overflow: auto`) — so arrows/PageUp/PageDown/
  // Home/End scroll it natively, no new selection model or ARIA needed.
  // Rejected: a keyboard model over `ChildrenList` — a second tree with a
  // strictly worse model than the one F6 already reaches.
  useEffect(() => {
    return registerPaneContent('detail', () => {
      if (useGrid) return focusGrid()
      paneRef.current?.focus()
      return true
    })
  }, [useGrid])

  // R107 (`R106-detail-focus-ring.md` §3): when `useGrid` flips true→false,
  // `Grid` unmounts taking the focused `.grid-scroll` with it, and focus
  // falls back to `<body>` even though the user never left the pane —
  // `document.activeElement` can't answer "was it inside this pane" by the
  // time any effect here runs, because the browser retargets focus
  // synchronously as part of removing the focused node, which happens
  // during React's commit — before even a layout effect's cleanup fires.
  // `wasLastFocusedPane` (`focus.ts`) sidesteps the race entirely: it's
  // driven by `focusin` on the pane's own shell (`Layout.tsx`, unaffected
  // by Grid unmounting inside it) and isn't cleared by an ordinary blur, so
  // it still reads `true` here. The conditional is the whole task — an
  // unconditional refocus on every selection change would steal the
  // keyboard from Tree or Raw whenever the selection moved to a non-grid
  // node (the behaviour R69 was careful not to introduce).
  const prevUseGridRef = useRef(useGrid)
  useEffect(() => {
    const wasGrid = prevUseGridRef.current
    prevUseGridRef.current = useGrid
    if (wasGrid && !useGrid && wasLastFocusedPane('detail')) {
      paneRef.current?.focus()
    }
  }, [useGrid])

  return (
    <div className="detail-viewport">
      <div className="detail scrollbar-host" ref={paneRef} tabIndex={-1}>
        <Breadcrumb
          store={store}
          segments={segments}
          capabilities={capabilities}
          selectedNode={selectedNode}
          skipped={skipped}
        />

        <section className="detail-section detail-header">
          <h2 className="detail-node-title">
            <span
              className={`detail-node-glyph ${glyphFontClass(glyphOf(kind))}`}
              aria-hidden="true"
              title={kindLabelOf(kind)}
            >
              {glyphOf(kind)}
            </span>
            <span
              className="detail-node-name"
              aria-label={name !== null ? `${kindLabelOf(kind)} ${name}` : undefined}
            >
              {name ?? kindLabelOf(kind)}
            </span>
            <span className="detail-node-count">
              {childCount.toLocaleString()} {childCount === 1 ? 'child' : 'children'}
            </span>
          </h2>
        </section>

        {(commentText !== null || wrapperComments.length > 0) && (
          <section className="detail-section detail-comment">
            <h3>Comment</h3>
            {wrapperComments.map((c) => (
              <p key={c.node}>
                <strong>{c.label}:</strong>{' '}
                {valueTextOf(store, sourceBuffer, c.commentNode, pendingSpanDeltas)}
              </p>
            ))}
            {commentText !== null && <p>{commentText}</p>}
          </section>
        )}

        {value !== null && (
          <section className="detail-section detail-value">
            <h3>Value</h3>
            <p>{value}</p>
          </section>
        )}

        {capabilities?.hasAttributes === true && (
          <section className="detail-section detail-facets">
            <h3>Attributes</h3>
            {facets.length === 0 ? (
              <p className="detail-empty-inline">None</p>
            ) : (
              <table className="detail-facets-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {facets.map((facet) => (
                    <tr key={facet.name}>
                      <td>{facet.name}</td>
                      <td>{facet.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        <section
          className={`detail-section detail-children${useGrid ? ' detail-children-grid' : ''}`}
        >
          <div className="detail-children-heading">
            <h3>Children</h3>
          </div>
          {useGrid ? (
            <>
              <div className="detail-grid-container">
                <Grid
                  store={store}
                  sourceBuffer={sourceBuffer}
                  members={gridMembers}
                  deltas={pendingSpanDeltas}
                />
              </div>
              {childCount > gridMemberSet.size && (
                <ChildrenList
                  store={store}
                  sourceBuffer={sourceBuffer}
                  node={node}
                  exclude={gridMemberSet}
                  deltas={pendingSpanDeltas}
                />
              )}
            </>
          ) : hasChildren(store, node) ? (
            <ChildrenList
              store={store}
              sourceBuffer={sourceBuffer}
              node={node}
              deltas={pendingSpanDeltas}
            />
          ) : (
            <p className="detail-empty-inline">None</p>
          )}
        </section>
      </div>
      <Scrollbar target={paneRef} axis="vertical" />
    </div>
  )
}

function Breadcrumb({
  store,
  segments,
  capabilities,
  selectedNode,
  skipped
}: {
  readonly store: NodeStore
  readonly segments: readonly PathSegment[]
  readonly capabilities: ReturnType<typeof getFormatCapabilities>
  readonly selectedNode: NodeRef
  readonly skipped: readonly NodeRef[]
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  // R62 (`R61-keyboard-workflow.md` §3): the segments are one Tab
  // stop, not one per segment — ArrowLeft/Right/Home/End move which one is
  // current. `Copy path` stays its own ordinary stop right after the
  // group, since it's a distinct action rather than another path segment.
  const roving = useRovingTabIndex(segments.length)

  // D-050: mark a wrapper descent on the breadcrumb rather than adding new
  // chrome. `skipped` is root-first and includes `selectedNode` itself when
  // it qualifies — that one segment stays normal weight (it's what the user
  // actually clicked), the wrapper hops *between* it and the destination are
  // dimmed, and the destination (always the last segment, already carrying
  // `aria-current`) reads as the actual answer.
  const dimmed = useMemo(
    () => new Set(skipped.filter((n) => n !== selectedNode)),
    [skipped, selectedNode]
  )

  function copyPath(): void {
    if (capabilities === undefined) return
    const path = copyPathFor(segments)
    navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        // Clipboard access can be denied (permissions, an insecure context)
        // — not worth surfacing as an error banner for a copy-path button.
      })
  }

  return (
    <nav className="detail-breadcrumb" aria-label="Node path">
      <ol>
        {segments.map((segment, index) => (
          <li key={segment.node}>
            {index > 0 && <span className="detail-breadcrumb-separator">/</span>}
            <button
              type="button"
              className={
                'detail-breadcrumb-segment' +
                (dimmed.has(segment.node) ? ' detail-breadcrumb-segment-skipped' : '')
              }
              aria-current={index === segments.length - 1 ? 'true' : undefined}
              onClick={() => selectNode(store, segment.node)}
              {...roving.itemProps(index)}
            >
              {segment.label}
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="detail-breadcrumb-copy"
        onClick={copyPath}
        disabled={capabilities === undefined}
      >
        {copied ? 'Copied' : 'Copy path'}
      </button>
    </nav>
  )
}

function ChildrenList({
  store,
  sourceBuffer,
  node,
  exclude,
  deltas
}: {
  readonly store: NodeStore
  readonly sourceBuffer: SourceBuffer
  readonly node: NodeRef
  /** Grid-mode members (E1/E9) to leave out — "any remaining children
   * render in list mode beneath it" (§4.3). Omitted (not just empty) when
   * grid mode isn't in play, so a plain list-mode selection stays a single
   * unfiltered pass over `childrenOf`. */
  readonly exclude?: ReadonlySet<NodeRef>
  /** R42/D-070: `document.pendingSpanDeltas` — translated through before
   * every preview this list decodes. */
  readonly deltas: DeltaList
}): JSX.Element {
  // Materialized once per selected node, not per render of anything above
  // it — a two-million-child parent is D9's own stated normal case, and
  // this list is exactly what the virtualizer below needs a stable
  // NodeRef[] for.
  const children = useMemo(
    () => [...store.childrenOf(node)].filter((c) => !(exclude?.has(c) ?? false)),
    [store, node, exclude]
  )
  // M5c-PLAN.md J5: content-derived column widths, sampled from `children`
  // (bounded to the first 200 — `childrenColumnLayout`'s own doc). Fed to
  // both the header and the rows below via CSS custom properties, so a
  // single source of truth keeps them from drifting apart.
  const layout = useMemo(
    () => childrenColumnLayout(store, sourceBuffer, children, deltas),
    [store, sourceBuffer, children, deltas]
  )
  const columnVars = {
    '--dc-name': `${layout.nameCh}ch`,
    '--dc-kind': `${layout.kindCh}ch`,
    '--dc-value': `${layout.valueCh}ch`,
    '--dc-children': `${layout.childrenCh}ch`
  } as CSSProperties

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: children.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })

  return (
    <div className="detail-children-viewport">
      <div
        className="detail-children-list scrollbar-host"
        ref={parentRef}
        style={columnVars}
        role="table"
        aria-label="Children"
      >
        <div className="detail-children-header" role="row">
          <span className="detail-child-glyph" aria-hidden="true" />
          <span className="detail-child-name" role="columnheader">
            Name
          </span>
          {layout.showKind && (
            <span className="detail-child-kind" role="columnheader">
              Kind
            </span>
          )}
          <span className="detail-child-preview" role="columnheader">
            Value
          </span>
          <span className="detail-child-count" role="columnheader">
            Children
          </span>
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const child = children[virtualRow.index]!
            const childKind = store.kindOf(child)
            const childHasChildren = hasChildren(store, child)
            const kindLabel = kindLabelOf(childKind)
            return (
              <div
                key={child}
                className="detail-child-row"
                role="row"
                style={{
                  position: 'absolute',
                  top: virtualRow.start,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT
                }}
                onMouseDown={() => selectNode(store, child)}
              >
                {/* The glyph carries the kind either way — a title/aria-label
                 * so the information is never actually lost when the Kind
                 * column itself is hidden (`Layout.tsx`'s `tooltipFor` follows
                 * the same "moved, not lost" rule for icon-only buttons). */}
                <span
                  className={`detail-child-glyph ${glyphFontClass(glyphOf(childKind))}`}
                  aria-hidden="true"
                  title={kindLabel}
                >
                  {glyphOf(childKind)}
                </span>
                <span className="detail-child-name">{labelOf(store, child)}</span>
                {layout.showKind && <span className="detail-child-kind">{kindLabel}</span>}
                <span className="detail-child-preview">
                  {childHasChildren ? '' : (previewOf(store, sourceBuffer, child, deltas) ?? '')}
                </span>
                <span className="detail-child-count">
                  {childHasChildren ? childCountOf(store, child).toLocaleString() : ''}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <Scrollbar target={parentRef} axis="vertical" />
    </div>
  )
}
