import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampRawHeight,
  clampTreeWidth,
  DEFAULT_PANE_VISIBILITY,
  RAW_HEIGHT_RANGE,
  TREE_WIDTH_RANGE,
  toggleDetail,
  toggleRaw,
  toggleTree,
  type PaneVisibility
} from '../src/renderer/components/Layout/layoutLogic'
import {
  getLayoutState,
  resetLayoutForTests,
  setRawHeight,
  setTreeWidth,
  subscribeLayout,
  toggleDetailPane,
  toggleRawPane
} from '../src/renderer/components/Layout/layoutStore'

function fakeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    }
  } as Storage
}
;(globalThis as { localStorage?: Storage }).localStorage = fakeStorage()

function label(v: PaneVisibility): string {
  const parts: string[] = []
  if (v.treeVisible) parts.push('Tree')
  if (v.detailVisible) parts.push('Detail')
  if (v.rawVisible) parts.push('Raw')
  return parts.join('+')
}

describe('layout toggles (D7): exactly the five CONCEPT.md §4.1 layouts', () => {
  it('default is Tree+Detail', () => {
    expect(label(DEFAULT_PANE_VISIBILITY)).toBe('Tree+Detail')
  })

  it('every reachable layout from the default is one of the five named ones', () => {
    const reachable = new Set<string>()
    let frontier: PaneVisibility[] = [DEFAULT_PANE_VISIBILITY]
    const seen = new Set<string>([label(DEFAULT_PANE_VISIBILITY)])

    // Breadth-first over the reachability graph the three toggles define —
    // exhaustive because the state space is only 2^3.
    while (frontier.length > 0) {
      const next: PaneVisibility[] = []
      for (const state of frontier) {
        reachable.add(label(state))
        for (const result of [toggleTree(state), toggleDetail(state), toggleRaw(state)]) {
          const key = label(result)
          if (!seen.has(key)) {
            seen.add(key)
            next.push(result)
          }
        }
      }
      frontier = next
    }

    expect(reachable).toEqual(
      new Set(['Tree+Detail', 'Tree+Detail+Raw', 'Tree+Raw', 'Detail+Raw', 'Detail'])
    )
  })

  it('Tree+Raw is reached by hiding Detail from Tree+Detail+Raw, not the other two toggles alone', () => {
    const all = { treeVisible: true, detailVisible: true, rawVisible: true }
    expect(label(toggleDetail(all))).toBe('Tree+Raw')
  })

  it('hiding Detail is a no-op unless both Tree and Raw are visible', () => {
    const treeDetail = { treeVisible: true, detailVisible: true, rawVisible: false }
    expect(toggleDetail(treeDetail)).toEqual(treeDetail)
  })

  it('hiding Tree from Tree+Raw recovers into Detail+Raw rather than "Raw alone"', () => {
    const treeRaw = { treeVisible: true, detailVisible: false, rawVisible: true }
    expect(label(toggleTree(treeRaw))).toBe('Detail+Raw')
  })

  it('hiding Raw from Tree+Raw recovers into Tree+Detail rather than "Tree alone"', () => {
    const treeRaw = { treeVisible: true, detailVisible: false, rawVisible: true }
    expect(label(toggleRaw(treeRaw))).toBe('Tree+Detail')
  })
})

describe('clampTreeWidth / clampRawHeight (D7)', () => {
  it('clamps below the floor', () => {
    expect(clampTreeWidth(0)).toBe(TREE_WIDTH_RANGE.min)
    expect(clampRawHeight(0)).toBe(RAW_HEIGHT_RANGE.min)
  })

  it('clamps above the ceiling', () => {
    expect(clampTreeWidth(10_000)).toBe(TREE_WIDTH_RANGE.max)
    expect(clampRawHeight(1)).toBe(RAW_HEIGHT_RANGE.max)
  })

  it('passes through an in-range value unchanged', () => {
    expect(clampTreeWidth(300)).toBe(300)
    expect(clampRawHeight(0.5)).toBe(0.5)
  })
})

describe('layoutStore (D7)', () => {
  beforeEach(() => resetLayoutForTests())

  it('persists across a reload — a fresh read of localStorage reflects the last state', () => {
    toggleRawPane()
    expect(localStorage.getItem('klados.layout')).toContain('"rawVisible":true')
  })

  it('notifies subscribers on a toggle', () => {
    let notifications = 0
    const unsubscribe = subscribeLayout(() => notifications++)
    toggleRawPane()
    expect(notifications).toBe(1)
    unsubscribe()
  })

  it('toggleDetailPane is a no-op (and does not notify) when it would strand a single non-Detail pane', () => {
    let notifications = 0
    const unsubscribe = subscribeLayout(() => notifications++)
    toggleDetailPane() // default is Tree+Detail, Raw hidden — guarded no-op
    expect(getLayoutState().detailVisible).toBe(true)
    expect(notifications).toBe(0)
    unsubscribe()
  })

  it('setTreeWidth / setRawHeight clamp and persist', () => {
    setTreeWidth(9_999)
    setRawHeight(0.99)
    expect(getLayoutState().treeWidth).toBe(TREE_WIDTH_RANGE.max)
    expect(getLayoutState().rawHeight).toBe(RAW_HEIGHT_RANGE.max)
  })
})
