/**
 * The Tree View (M1-PLAN.md D8, CONCEPT.md §4.2). Virtualized via
 * `@tanstack/react-virtual`; rows are `NodeRef`s per hard rule 1, read
 * through `NodeStore` accessors rather than mapped into `{ id, name,
 * children }` objects.
 *
 * ARIA `tree` pattern (§11.5) via `aria-activedescendant` on a single
 * focusable root rather than roving `tabindex` on each row — the usual
 * choice for a virtualized tree, since roving `tabindex` needs every row
 * that could receive focus to actually be in the DOM, and most of a 6.6M-
 * node tree's visible list never is.
 */
import { useVirtualizer } from '@tanstack/react-virtual'
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
import type { SourceBuffer } from '../../../core/buffer'
import { EMPTY_DELTA_LIST, type DeltaList } from '../../../core/deltaList'
import { registerPaneContent } from '../../focus'
import { glyphFontClass } from '../../glyphFont'
import { getFindState, subscribeFind } from '../Find/findStore'
import { hasMatchInRange } from '../../navigation/matchSpanLookup'
import { activeDocumentId } from '../../notifications/documentId'
import { dismissNotification, notify } from '../../notifications/notificationStore'
import { selectNode } from '../../selectNode'
import { activeSearchStore } from '../../session/activeSearchStore'
import { NO_SELECTION } from '../../session/documentSession'
import { useDocumentSession } from '../../session/useDocumentSession'
import { resolveWrapperTarget } from '../../wrapperDescent'
import { Scrollbar } from '../Scrollbar/Scrollbar'
import { consumePendingReveal, registerTreeController } from './treeController'
import {
  autoExpandChain,
  buildFilteredRows,
  buildVisibleRows,
  childCountOf,
  collapseSubtree,
  EXPAND_ALL_LIMIT,
  expandAll,
  glyphOf,
  hasChildren,
  indexOfNode,
  labelOf,
  previewOf,
  typeAheadMatch,
  type TreeRow
} from './treeModel'
import './Tree.css'

const ROOT: NodeRef = 0
const ROW_HEIGHT = 23
/** Long enough to type a multi-character search deliberately, short enough
 * that an unrelated keypress later doesn't extend a stale query — the same
 * reasoning as `keybindings.ts`'s chord timeout, at a similar magnitude. */
const TYPE_AHEAD_TIMEOUT_MS = 600

export function Tree(): JSX.Element {
  const state = useDocumentSession()

  // Layout only mounts this pane once a document is ready — the shared
  // phase-aware document area (Layout/DocumentArea.tsx) covers every other phase. This
  // guard exists for type narrowing onto `state.document`, not display.
  if (state.phase !== 'ready') return <></>
  return <TreeContent document={state.document} selectedNode={state.selection.selectedNode} />
}

interface TreeContentProps {
  readonly document: {
    readonly store: NodeStore
    readonly sourceBuffer: SourceBuffer
    readonly filePath: string
    /** R42/D-070: optional so every existing narrow-document test double
     * (`test/treeExpansion.test.tsx` in particular) keeps compiling without
     * having to grow a field it has no reason to know about — defaults to
     * "nothing pending," the same as a document that just reparsed. */
    readonly pendingSpanDeltas?: DeltaList
  }
  readonly selectedNode: NodeRef
}

/** Exported for `test/treeExpansion.test.tsx` (M5g-PLAN.md O4) — `Tree`
 * itself reads `useDocumentSession()`, a module-level singleton a
 * from-scratch render can't easily stand up in isolation; `TreeContent`
 * takes its document as a plain prop, so a test can drive it directly with
 * a real `NodeStore`. */
export function TreeContent({ document, selectedNode }: TreeContentProps): JSX.Element {
  const { store, sourceBuffer, filePath, pendingSpanDeltas = EMPTY_DELTA_LIST } = document

  // A mutable `Set` plus a version counter, not `useState<ReadonlySet<...>>`
  // — cloning the set on every single toggle would be O(expanded.size),
  // and after "Expand All" that size can be in the tens of thousands.
  // `version` is what actually drives `useMemo` below to recompute.
  const expandedRef = useRef<Set<NodeRef>>(new Set([ROOT]))
  const [version, setVersion] = useState(0)
  // M5c-PLAN.md J6 / D-052: Expand/Collapse All are scoped to the
  // selection — read fresh at call time (a ref, not the `selectedNode`
  // closure variable) since `registerTreeController`'s effect below is
  // keyed on `[store]` alone and doesn't re-run on every selection change.
  const selectedNodeRef = useRef(selectedNode)
  selectedNodeRef.current = selectedNode
  const typeAheadRef = useRef<{
    anchorIndex: number
    query: string
    timer: ReturnType<typeof setTimeout> | null
  }>({ anchorIndex: 0, query: '', timer: null })

  // A genuinely new document (different `filePath`) starts fresh: only the
  // root expanded, no stale type-ahead or truncation notice from whatever
  // was open before. Deliberately keyed on `filePath`, not `store` identity
  // — `store` gets a new identity on *every* reparse of the same document
  // (an edit, a Transform), which used to collapse the whole tree on every
  // one of those too (M5g-PLAN.md O4/§1.5). `NodeRef`s are allocated in
  // document order, so a reparse that didn't restructure the document
  // (a Format no-op, most edits) reproduces the same refs and expansion
  // state carries over exactly; one that did shift some subtree's refs
  // just means a stale entry in `expandedRef` silently stops matching
  // anything real — a graceful degradation, not a correctness problem
  // (`buildVisibleRows` only ever reads refs that still exist), and still
  // strictly better than discarding all expansion state on every reparse.
  const filePathRef = useRef(filePath)
  if (filePathRef.current !== filePath) {
    filePathRef.current = filePath
    expandedRef.current = new Set([ROOT])
    // A stale truncation notice from whatever document was open before
    // shouldn't linger into a fresh one, even for the few seconds its own
    // auto-dismiss timer would otherwise take.
    dismissNotification('dedupe:tree.expandAll.truncated')
    dismissNotification('dedupe:tree.collapseAll.truncated')
    dismissNotification('dedupe:tree.filterToMatches.truncated')
  }

  // M4-PLAN.md G6: filter-to-matches. Reading `findState`/`matches` here
  // (rather than lower, alongside the row-marking overlay) is what lets
  // `rows` itself switch to the filtered traversal — an overlay marks rows
  // that still come from `buildVisibleRows`; this mode replaces which rows
  // exist at all, per `buildFilteredRows`'s own contract of never touching
  // `expandedRef` — turning the mode off is exactly restoring whatever
  // `buildVisibleRows(store, ROOT, expandedRef.current)` already produces,
  // no saved-and-restored expansion state needed.
  const findState = useSyncExternalStore(subscribeFind, getFindState, getFindState)
  const matches = useSyncExternalStore(
    activeSearchStore.subscribe,
    activeSearchStore.getSnapshot,
    activeSearchStore.getSnapshot
  )

  const filtered = useMemo(
    () => (findState.filterToMatches ? buildFilteredRows(store, ROOT, matches.starts) : null),
    [store, findState.filterToMatches, matches.starts]
  )

  useEffect(() => {
    if (filtered?.truncated !== true) return
    notify({
      severity: 'info',
      message: `Filter to matches stopped after ${EXPAND_ALL_LIMIT.toLocaleString()} nodes — matches further in may not be shown.`,
      documentId: activeDocumentId(),
      dedupeKey: 'tree.filterToMatches.truncated'
    })
  }, [filtered])

  const rows: readonly TreeRow[] = useMemo(
    () => filtered?.rows ?? buildVisibleRows(store, ROOT, expandedRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `expandedRef.current` is the mutable set `bump()` (via `version`) signals a change to; it is not itself a valid hook dependency
    [store, version, filtered]
  )
  // Falls back to the root row for exactly one render, when `selectedNode`
  // isn't yet visible (its ancestors aren't expanded). The effect below
  // expands them and triggers a re-render with the real row, so this is a
  // keyboard-navigation starting point for that one frame, not a claim that
  // the root is what's actually selected — UI-FEEDBACK.md's "Selecting a
  // deep node in Raw leaves the Tree showing Document" (M5b): the fallback
  // used to be the whole story, silently standing in for "not found."
  const activeIndex = Math.max(0, indexOfNode(rows, selectedNode))

  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })

  useEffect(() => {
    rowVirtualizer.scrollToIndex(activeIndex, { align: 'auto' })
  }, [activeIndex, rowVirtualizer])

  function bump(): void {
    setVersion((v) => v + 1)
  }

  /** Expands every ancestor of `node` that isn't already — what makes the
   * node reachable in `rows` at all — without touching the node's own
   * expansion state or changing the selection. "Locate in tree" (D14) is
   * the caller: it doesn't select a different node, just brings the
   * already-selected one into view. */
  function expandAncestors(node: NodeRef): void {
    const expanded = expandedRef.current
    let changed = false
    for (
      let ancestor = store.parentOf(node);
      ancestor !== -1;
      ancestor = store.parentOf(ancestor)
    ) {
      if (!expanded.has(ancestor)) {
        expanded.add(ancestor)
        changed = true
      }
    }
    if (changed) bump()
  }

  useEffect(() => {
    // This effect only runs once React has actually re-rendered with this
    // exact `store` — the one moment `expandAncestors` below is guaranteed
    // to close over the store a reparse-driven reveal request (F5,
    // `treeController.ts`'s `requestReveal`) was made against. Consuming it
    // here, not where the request was made, is what keeps a relocation
    // into a subtree the user hasn't expanded from walking `parentOf` on a
    // store the new `NodeRef` doesn't belong to.
    const pending = consumePendingReveal(store)
    if (pending !== null) expandAncestors(pending)
    const unregisterController = registerTreeController({
      locateNode: expandAncestors,
      expandSubtree: runExpandAll,
      collapseSubtree: runCollapseAll
    })
    // R91 (`R91-focus-into-content.md` §2): F6 lands on `.tree` itself, not
    // `PaneShell`'s `tabIndex={-1}` wrapper — `.tree` already owns arrow-key
    // navigation, and `activeIndex` (derived from `selectedNode`) is already
    // the right row, already scrolled into view (the effect above). `.tree`
    // is mounted whenever this effect runs, so there's always something to
    // focus once a document is open.
    const unregisterContent = registerPaneContent('tree', () => {
      parentRef.current?.focus()
      return true
    })
    return () => {
      unregisterController()
      unregisterContent()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-registering only needs to happen per document (`store`); `expandAncestors`/`runExpandAll`/`runCollapseAll` close over stable refs/setters (and `selectedNodeRef`, read fresh at call time) that stay valid for the registration's whole lifetime
  }, [store])

  // UI-FEEDBACK.md M5b: "Selecting a deep node in Raw leaves the Tree
  // showing `Document`," plus D-050's Tree half ("the Tree unfolds along
  // the descent"). Keyed on the `(store, node)` pair rather than
  // `selectedNode` alone — a fresh document's initial selection can
  // legitimately reuse a `NodeRef` value the previous document's selection
  // just had, and `store` changing already resets `expandedRef` (above),
  // so this still needs to run for that first selection too. Runs whenever
  // the current selection ends up with no row (including on open — §11.1's
  // deep-error-node case is now covered here rather than just by "Locate
  // in tree" being invoked explicitly), and separately expands exactly
  // `resolveWrapperTarget`'s own `skipped` set — never `destination`
  // itself, which may have millions of children (D-050's own note) — so a
  // wrapper the Detail pane silently descended through becomes a visible
  // row without moving the selection off the node actually clicked.
  const selectionExpansionRef = useRef<{ store: NodeStore; node: NodeRef } | null>(null)
  useEffect(() => {
    const prev = selectionExpansionRef.current
    if (prev !== null && prev.store === store && prev.node === selectedNode) return
    selectionExpansionRef.current = { store, node: selectedNode }
    if (indexOfNode(rows, selectedNode) === -1) expandAncestors(selectedNode)
    const { skipped } = resolveWrapperTarget(store, selectedNode)
    if (skipped.length > 0) {
      const expanded = expandedRef.current
      let changed = false
      for (const node of skipped) {
        if (!expanded.has(node)) {
          expanded.add(node)
          changed = true
        }
      }
      if (changed) bump()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `expandAncestors` closes over stable refs/setters valid for the component's whole lifetime; `rows` is read for its current value at effect time, not tracked as a trigger (re-running per row-rebuild would fight `bump()`'s own re-render)
  }, [store, selectedNode])

  function select(node: NodeRef): void {
    selectNode(store, node)
  }

  function toggle(node: NodeRef): void {
    if (!hasChildren(store, node)) return
    const expanded = expandedRef.current
    if (expanded.has(node)) {
      expanded.delete(node)
    } else {
      for (const n of autoExpandChain(store, node)) expanded.add(n)
    }
    bump()
  }

  /** D-052: the selected node's subtree, falling back to the root when
   * nothing is selected — selecting Document and expanding is exactly
   * today's whole-document behaviour (D-053 keeps that row for this
   * reason). */
  function expandScope(): NodeRef {
    return selectedNodeRef.current !== NO_SELECTION ? selectedNodeRef.current : ROOT
  }

  function runExpandAll(): void {
    const result = expandAll(store, expandScope())
    // Merged into the existing set, not replaced — a scoped expand must
    // not collapse whatever else was already open elsewhere in the tree.
    // For the root-scope case this produces the same end result as a
    // replace would (expandAll(store, ROOT) is exhaustive on its own).
    const expanded = expandedRef.current
    for (const n of result.expanded) expanded.add(n)
    if (result.truncated) {
      notify({
        severity: 'info',
        message: `Expand All stopped after ${EXPAND_ALL_LIMIT.toLocaleString()} nodes — the rest stayed collapsed.`,
        documentId: activeDocumentId(),
        dedupeKey: 'tree.expandAll.truncated'
      })
    }
    bump()
  }

  function runCollapseAll(): void {
    const result = collapseSubtree(store, expandScope())
    const expanded = expandedRef.current
    for (const n of result.toCollapse) expanded.delete(n)
    if (result.truncated) {
      notify({
        severity: 'info',
        message: `Collapse All stopped after ${EXPAND_ALL_LIMIT.toLocaleString()} nodes — the rest stayed expanded.`,
        documentId: activeDocumentId(),
        dedupeKey: 'tree.collapseAll.truncated'
      })
    }
    bump()
  }

  function selectRowAt(index: number): void {
    const row = rows[index]
    if (row !== undefined) select(row.node)
  }

  function onTypeAhead(key: string): void {
    const pending = typeAheadRef.current
    if (pending.timer !== null) clearTimeout(pending.timer)

    const isContinuation = pending.query.length > 0
    const anchorIndex = isContinuation ? pending.anchorIndex : activeIndex
    const query = pending.query + key

    const match = typeAheadMatch(rows, store, anchorIndex, query)
    typeAheadRef.current = {
      anchorIndex,
      query,
      timer: setTimeout(() => {
        typeAheadRef.current = { anchorIndex: 0, query: '', timer: null }
      }, TYPE_AHEAD_TIMEOUT_MS)
    }
    if (match !== null) selectRowAt(match)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const row = rows[activeIndex]
    if (row === undefined) return

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        selectRowAt(Math.min(rows.length - 1, activeIndex + 1))
        return
      case 'ArrowUp':
        event.preventDefault()
        selectRowAt(Math.max(0, activeIndex - 1))
        return
      case 'Home':
        event.preventDefault()
        selectRowAt(0)
        return
      case 'End':
        event.preventDefault()
        selectRowAt(rows.length - 1)
        return
      case 'ArrowRight':
        event.preventDefault()
        if (hasChildren(store, row.node) && !expandedRef.current.has(row.node)) {
          toggle(row.node)
        } else {
          const child = rows[activeIndex + 1]
          if (child !== undefined && child.depth === row.depth + 1) select(child.node)
        }
        return
      case 'ArrowLeft':
        event.preventDefault()
        if (expandedRef.current.has(row.node)) {
          toggle(row.node)
        } else if (row.depth > 0) {
          select(store.parentOf(row.node))
        }
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        toggle(row.node)
        return
      case '*':
        // The conventional "expand everything below this point" key in
        // desktop tree widgets (Windows Explorer, among others).
        event.preventDefault()
        runExpandAll()
        return
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
          onTypeAhead(event.key)
        }
    }
  }

  const activeNode = rows[activeIndex]?.node

  // M4-PLAN.md G5: the per-row marker below is an overlay, not a filter
  // (G6's filter-to-matches, applied above to `rows` itself, is the
  // separate mode that hides non-matching subtrees entirely) — a row's own
  // span containing a match just gets a marker class here.

  return (
    <div className="tree-viewport">
      <div
        className="tree scrollbar-host"
        ref={parentRef}
        role="tree"
        aria-label="Document tree"
        tabIndex={0}
        aria-activedescendant={activeNode !== undefined ? `tree-row-${activeNode}` : undefined}
        onKeyDown={onKeyDown}
      >
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]!
            return (
              <TreeRowView
                key={row.node}
                row={row}
                store={store}
                sourceBuffer={sourceBuffer}
                deltas={pendingSpanDeltas}
                expanded={expandedRef.current.has(row.node)}
                selected={virtualRow.index === activeIndex}
                matched={
                  matches.starts.length > 0 &&
                  hasMatchInRange(
                    matches.starts,
                    store.spanOf(row.node).start,
                    store.spanOf(row.node).end
                  )
                }
                top={virtualRow.start}
                onSelect={() => select(row.node)}
                onToggle={() => toggle(row.node)}
              />
            )
          })}
        </div>
      </div>
      <Scrollbar target={parentRef} axis="vertical" />
    </div>
  )
}

interface TreeRowViewProps {
  readonly row: TreeRow
  readonly store: NodeStore
  readonly sourceBuffer: SourceBuffer
  readonly deltas: DeltaList
  readonly expanded: boolean
  readonly selected: boolean
  readonly matched: boolean
  readonly top: number
  readonly onSelect: () => void
  readonly onToggle: () => void
}

function TreeRowView({
  row,
  store,
  sourceBuffer,
  deltas,
  expanded,
  selected,
  matched,
  top,
  onSelect,
  onToggle
}: TreeRowViewProps): JSX.Element {
  const kind = store.kindOf(row.node)
  const expandable = hasChildren(store, row.node)
  const preview = expandable ? null : previewOf(store, sourceBuffer, row.node, deltas)
  const childCount = expandable ? childCountOf(store, row.node) : null
  const label = labelOf(store, row.node)

  return (
    <div
      id={`tree-row-${row.node}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-posinset={row.posinset}
      aria-setsize={row.setsize}
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={selected}
      className={['tree-row', selected && 'tree-row-selected', matched && 'tree-row-matched']
        .filter(Boolean)
        .join(' ')}
      style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_HEIGHT }}
      onMouseDown={onSelect}
      // Double-click anywhere on the row toggles, so the disclosure triangle
      // is a shortcut rather than the only way to unfold — a 16px target is
      // a poor one at 23px row height. Deliberately *not* single-click:
      // selection is the frequent action here (§4.1 makes Detail the primary
      // working surface, and D-018 has selecting a node show that node), so
      // clicking through siblings to compare them would otherwise reshape the
      // tree underneath the pointer on every click. `preventDefault` stops
      // the browser's double-click word selection flashing over the label.
      onDoubleClick={
        expandable
          ? (event) => {
              event.preventDefault()
              onToggle()
            }
          : undefined
      }
    >
      <span className="tree-row-indent" style={{ width: row.depth * 16 }} />
      {expandable ? (
        <button
          type="button"
          className="tree-row-disclosure"
          aria-hidden="true"
          tabIndex={-1}
          onMouseDown={(event) => {
            // `preventDefault` here, not just `stopPropagation` — a mousedown
            // on a `<button>` focuses it by default even with `tabIndex={-1}`,
            // which would steal DOM focus away from `.tree` and break the
            // `aria-activedescendant` keyboard-navigation model until the
            // user clicked back into the tree.
            event.preventDefault()
            event.stopPropagation()
            onToggle()
          }}
          // Two mousedowns on the triangle have already toggled twice; without
          // this the row's own dblclick handler would fire a third time and
          // leave the node in the opposite state from where it started.
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span className="tree-row-disclosure tree-row-disclosure-empty" aria-hidden="true" />
      )}
      <span className={`tree-row-glyph ${glyphFontClass(glyphOf(kind))}`} aria-hidden="true">
        {glyphOf(kind)}
      </span>
      <span className="tree-row-label">{label}</span>
      {childCount !== null && childCount > 0 && (
        <span className="tree-row-count">{childCount.toLocaleString()}</span>
      )}
      {preview !== null && preview.length > 0 && (
        <span className="tree-row-preview">{preview}</span>
      )}
    </div>
  )
}
