import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  showRawPane,
  subscribeLayout,
  toggleDetailPane,
  toggleRawPane,
  toggleTreePane
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
  // R223 (`docs/plans/R223-raw-pane-default.md`): was Tree+Detail.
  it('default is Tree+Detail+Raw', () => {
    expect(label(DEFAULT_PANE_VISIBILITY)).toBe('Tree+Detail+Raw')
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
    expect(localStorage.getItem('klados.layout')).toContain('"rawVisible":false')
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
    toggleRawPane() // Tree+Detail — the default before R223
    notifications = 0
    toggleDetailPane() // Raw hidden — guarded no-op
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

describe('R223: showRawPane', () => {
  beforeEach(() => resetLayoutForTests())

  it('shows a hidden Raw from Tree+Detail, keeping Tree and Detail', () => {
    toggleRawPane()
    showRawPane()
    expect(getLayoutState()).toMatchObject({
      treeVisible: true,
      detailVisible: true,
      rawVisible: true
    })
  })

  it('shows a hidden Raw from Detail alone', () => {
    toggleRawPane()
    toggleTreePane()
    showRawPane()
    expect(getLayoutState()).toMatchObject({
      treeVisible: false,
      detailVisible: true,
      rawVisible: true
    })
  })

  it('is a no-op when Raw is already visible: no notification, no write', () => {
    let notifications = 0
    const unsubscribe = subscribeLayout(() => notifications++)
    showRawPane()
    expect(getLayoutState().rawVisible).toBe(true)
    expect(notifications).toBe(0)
    expect(localStorage.getItem('klados.layout')).toBeNull()
    unsubscribe()
  })
})

describe('R223: who gets the new default', () => {
  // The store reads `localStorage` once, when the module loads — so each case
  // loads a fresh copy of it, the way a restart does.
  async function freshStore(): Promise<
    typeof import('../src/renderer/components/Layout/layoutStore')
  > {
    vi.resetModules()
    return import('../src/renderer/components/Layout/layoutStore')
  }

  beforeEach(() => localStorage.removeItem('klados.layout'))

  it('a profile with no saved layout gets Tree+Detail+Raw, Raw at 30%', async () => {
    const store = await freshStore()
    expect(store.getLayoutState()).toEqual({
      treeVisible: true,
      detailVisible: true,
      rawVisible: true,
      treeWidth: 260,
      rawHeight: 0.3
    })
  })

  it('a saved layout with Raw hidden is kept, not migrated', async () => {
    const saved = {
      treeVisible: true,
      detailVisible: true,
      rawVisible: false,
      treeWidth: 300,
      rawHeight: 0.4
    }
    localStorage.setItem('klados.layout', JSON.stringify(saved))
    const store = await freshStore()
    expect(store.getLayoutState()).toEqual(saved)
    expect(localStorage.getItem('klados.layout')).toBe(JSON.stringify(saved))
  })
})
