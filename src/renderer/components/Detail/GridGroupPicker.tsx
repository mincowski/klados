/**
 * R211 (`docs/plans/R210-grid-grouping.md` § 11, D-104): the Detail view's
 * group tabs. A node whose children form several groups shows **one table at
 * a time**, with a tab per group above it; a node with one group shows no
 * tabs at all, exactly as before R210.
 *
 * **This replaced a stack of tables capped at five**, which was built,
 * rendered and rejected: the cap was a sound rendering budget, but on screen
 * it was only a number, and nothing explained why the sixth group was a list.
 * Tabs make every group reachable with no cap, and mount exactly one grid.
 *
 * Chosen by the project lead from three renderings in the running app —
 * tabs that wrap, tabs that overflow into a menu, and a dropdown. Wrapping
 * pushes the table down a line per row of tabs on a wide node; the dropdown
 * hides the one fact the control exists to show, that the node has several
 * tables. This is the overflow version: one line always, every group that
 * fits named with its row count, the rest behind "+N more".
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { NodeStore } from '../../../core/nodeStore'
import { kindLabelOf } from '../../nodeDisplay'
import { Icon } from '../Icon/Icon'
import { useRovingTabIndex } from '../../rovingTabIndex'
import type { GridGroup } from './gridDetection'

/** A group's tab label. Named groups show the name the document writes; the
 * unnamed group a JSON or CSV array forms (`nameId === -1`) shows its members'
 * kind, which is what the Tree calls them.
 *
 * **The unnamed branch is defensive rather than reachable in a tab strip**:
 * unnamed children only occur under an Array, where every child is unnamed,
 * so they always form a single group — and a single group shows no tabs. It
 * is still reachable as the grid's accessible name. */
export function groupLabelOf(store: NodeStore, group: GridGroup): string {
  if (group.nameId !== -1) return store.textOf(group.nameId)
  const first = group.members[0]
  return first === undefined ? 'Rows' : kindLabelOf(store.kindOf(first))
}

/**
 * The last group the user picked, **by name**, per document. Stepping between
 * sibling nodes of the same shape — one `<shelf>` after another, each with
 * `book` and `magazine` — keeps `magazine` selected instead of snapping back
 * to the first tab on every node. A node without that group shows its first.
 *
 * Keyed by `NodeStore` so it is scoped to one open document and dropped with
 * it. A reparse replaces the store, which forgets the choice; that is the
 * cheap failure (back to the first tab), not a wrong one.
 */
const rememberedGroup = new WeakMap<NodeStore, number>()

export function rememberGroup(store: NodeStore, nameId: number): void {
  rememberedGroup.set(store, nameId)
}

/** Which of `tables` to show: the remembered group if this node has it, else
 * the first in document order. Pure apart from the lookup, so the rule is
 * testable without mounting anything. */
export function selectedGroupIndex(store: NodeStore, tables: readonly GridGroup[]): number {
  const remembered = rememberedGroup.get(store)
  if (remembered === undefined) return 0
  const index = tables.findIndex((t) => t.nameId === remembered)
  return index === -1 ? 0 : index
}

export function resetRememberedGroupsForTests(store: NodeStore): void {
  rememberedGroup.delete(store)
}

/**
 * How many tabs fit in `available` pixels, given each tab's width and the
 * width the "more" button would need. The more button's label depends on the
 * answer — it names the selected group when that group is among the hidden
 * ones, and reads "+N more" otherwise — so it is passed as a function of the
 * candidate count rather than as one number. Exported for a DOM-free test.
 *
 * Deterministic for fixed inputs, which is what keeps a `ResizeObserver`
 * re-measure from oscillating: the answer depends on the widths, not on what
 * was rendered last time.
 */
export function tabsThatFit(
  tabWidths: readonly number[],
  available: number,
  moreWidthFor: (visibleCount: number) => number
): number {
  const total = tabWidths.reduce((sum, w) => sum + w, 0)
  if (total <= available) return tabWidths.length
  let used = 0
  let best = 0
  for (let k = 1; k < tabWidths.length; k++) {
    used += tabWidths[k - 1]!
    // No early exit: the more button narrows once the selected group is
    // among the visible tabs, so a larger count can fit where a smaller one
    // did not.
    if (used + moreWidthFor(k) <= available) best = k
  }
  return best
}

interface GridGroupPickerProps {
  readonly store: NodeStore
  readonly groups: readonly GridGroup[]
  readonly selected: number
  readonly onSelect: (index: number) => void
  /** The id of the element the tabs control, for `aria-controls`. */
  readonly panelId: string
}

export function GridGroupPicker({
  store,
  groups,
  selected,
  onSelect,
  panelId
}: GridGroupPickerProps): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(groups.length)
  const [menuOpen, setMenuOpen] = useState(false)

  // Every tab, and both possible "more" labels, are laid out once in an
  // invisible copy of the row; the real row then shows as many as fit. The
  // copies are measured **bold**, because whichever tab is selected renders
  // bold and a normal-weight measurement would let it clip.
  useLayoutEffect(() => {
    const row = rowRef.current
    const measure = measureRef.current
    if (row === null || measure === null) return
    const recompute = (): void => {
      const tabs = [...measure.querySelectorAll<HTMLElement>('[data-measure="tab"]')]
      const genericMore = measure.querySelector<HTMLElement>('[data-measure="more"]')
      const selectedMore = measure.querySelector<HTMLElement>('[data-measure="more-selected"]')
      const widths = tabs.map((t) => t.getBoundingClientRect().width)
      const fit = tabsThatFit(
        widths,
        row.clientWidth,
        (k) => (selected >= k ? selectedMore : genericMore)?.getBoundingClientRect().width ?? 0
      )
      setVisibleCount(fit)
    }
    recompute()
    const observer = new ResizeObserver(recompute)
    observer.observe(row)
    return () => observer.disconnect()
  }, [store, groups, selected])

  // The menu closes on Escape and on any press outside it — without both, an
  // open menu outlives the user's attention and sits over the table.
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!moreRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen])

  const shown = groups.slice(0, visibleCount)
  const hidden = groups.slice(visibleCount)
  const selectedHidden = selected >= visibleCount
  const selectedGroup = groups[selected]

  // One Tab stop for the whole strip (R62's roving tabindex), the more button
  // included as its last member. Arrows move focus, not the selection:
  // switching remounts the grid, which on a two-million-row group is not free,
  // so activation is Enter/Space/click (WAI-ARIA's "manual activation").
  const roving = useRovingTabIndex(shown.length + (hidden.length > 0 ? 1 : 0))

  function closeMenuWith(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    setMenuOpen(false)
    moreRef.current?.querySelector('button')?.focus()
  }

  return (
    <div className="grid-group-tabs" ref={rowRef}>
      {/* Clipped, not just hidden: at natural width this copy can be thousands
          of pixels wide, and an absolutely positioned box that wide still
          extends the pane's horizontal scroll range. */}
      <div className="grid-group-tabs-measure-clip" aria-hidden="true">
        <div className="grid-group-tabs-measure" ref={measureRef}>
          {groups.map((g) => (
            <span
              key={g.nameId}
              className="grid-group-tab grid-group-tab-active"
              data-measure="tab"
            >
              <span className="grid-group-tab-name">{groupLabelOf(store, g)}</span>
              <span className="grid-group-tab-count">{g.members.length.toLocaleString()}</span>
            </span>
          ))}
          <span className="grid-group-more-button" data-measure="more">
            +{groups.length} more <Icon name="chevron-down" />
          </span>
          {selectedGroup !== undefined && (
            <span
              className="grid-group-more-button grid-group-tab-active"
              data-measure="more-selected"
            >
              <span className="grid-group-tab-name">{groupLabelOf(store, selectedGroup)}</span>
              <span className="grid-group-tab-count">
                {selectedGroup.members.length.toLocaleString()}
              </span>{' '}
              <Icon name="chevron-down" />
            </span>
          )}
        </div>
      </div>

      <div className="grid-group-tablist" role="tablist" aria-label="Groups">
        {shown.map((g, i) => (
          <button
            key={g.nameId}
            type="button"
            role="tab"
            aria-selected={i === selected}
            aria-controls={panelId}
            className={`grid-group-tab${i === selected ? ' grid-group-tab-active' : ''}`}
            onClick={() => onSelect(i)}
            {...roving.itemProps(i)}
          >
            <span className="grid-group-tab-name">{groupLabelOf(store, g)}</span>
            <span className="grid-group-tab-count">{g.members.length.toLocaleString()}</span>
          </button>
        ))}
      </div>

      {hidden.length > 0 && (
        <div className="grid-group-more" ref={moreRef}>
          <button
            type="button"
            className={`grid-group-more-button${selectedHidden ? ' grid-group-tab-active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${hidden.length} more groups`}
            onClick={() => setMenuOpen((open) => !open)}
            {...roving.itemProps(shown.length)}
          >
            {selectedHidden && selectedGroup !== undefined ? (
              <>
                <span className="grid-group-tab-name">{groupLabelOf(store, selectedGroup)}</span>
                <span className="grid-group-tab-count">
                  {selectedGroup.members.length.toLocaleString()}
                </span>
              </>
            ) : (
              <>+{hidden.length} more</>
            )}{' '}
            <Icon name="chevron-down" />
          </button>
          {menuOpen && (
            <ul className="grid-group-menu" role="menu" onKeyDown={closeMenuWith}>
              {hidden.map((g, i) => {
                const index = visibleCount + i
                return (
                  <li key={g.nameId} role="none">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={index === selected}
                      className={`grid-group-menu-item${index === selected ? ' grid-group-menu-item-active' : ''}`}
                      onClick={() => {
                        onSelect(index)
                        setMenuOpen(false)
                        // The item just clicked is about to unmount, which would drop
                        // focus to <body>; the more button survives the re-render
                        // and now names the chosen group, so focus goes back there.
                        moreRef.current?.querySelector('button')?.focus()
                      }}
                    >
                      <span className="grid-group-tab-name">{groupLabelOf(store, g)}</span>
                      <span className="grid-group-tab-count">
                        {g.members.length.toLocaleString()}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
