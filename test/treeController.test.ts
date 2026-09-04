import { describe, expect, it, vi } from 'vitest'
import { Interner } from '../src/core/interner'
import { NodeStore } from '../src/core/nodeStore'
import {
  collapseSubtreeInTree,
  consumePendingReveal,
  expandSubtreeInTree,
  locateInTree,
  registerTreeController,
  requestReveal,
  type TreeController
} from '../src/renderer/components/Tree/treeController'

function emptyStore(): NodeStore {
  return new NodeStore(new Uint8Array(0), new Interner())
}

function fakeController(): TreeController {
  return { locateNode: vi.fn(), expandSubtree: vi.fn(), collapseSubtree: vi.fn() }
}

describe('treeController', () => {
  it('routes locateInTree/expandSubtreeInTree/collapseSubtreeInTree to the currently registered controller', () => {
    const controller = fakeController()
    registerTreeController(controller)

    locateInTree(7)
    expandSubtreeInTree()
    collapseSubtreeInTree()

    expect(controller.locateNode).toHaveBeenCalledWith(7)
    expect(controller.expandSubtree).toHaveBeenCalledOnce()
    expect(controller.collapseSubtree).toHaveBeenCalledOnce()
  })

  it('is a no-op with nothing registered — no Tree view mounted is not an error', () => {
    expect(() => locateInTree(1)).not.toThrow()
    expect(() => expandSubtreeInTree()).not.toThrow()
    expect(() => collapseSubtreeInTree()).not.toThrow()
  })

  it('unregistering stops routing to a stale controller', () => {
    const first = fakeController()
    const unregister = registerTreeController(first)
    unregister()

    expandSubtreeInTree()
    collapseSubtreeInTree()

    expect(first.expandSubtree).not.toHaveBeenCalled()
    expect(first.collapseSubtree).not.toHaveBeenCalled()
  })

  it("a second registration replaces the first — the first controller's own unregister is a no-op once superseded", () => {
    const first = fakeController()
    const second = fakeController()
    const unregisterFirst = registerTreeController(first)
    registerTreeController(second)
    unregisterFirst()

    expandSubtreeInTree()
    collapseSubtreeInTree()

    expect(first.expandSubtree).not.toHaveBeenCalled()
    expect(second.expandSubtree).toHaveBeenCalledOnce()
    expect(second.collapseSubtree).toHaveBeenCalledOnce()
  })
})

describe('requestReveal/consumePendingReveal (M3-PLAN.md F5) — store-scoped, not a synchronous locateInTree call', () => {
  it('is consumed only by the exact store it was requested against', () => {
    const store = emptyStore()
    requestReveal(3, store)
    expect(consumePendingReveal(store)).toBe(3)
  })

  it('is discarded, not applied, against a different store — the guard the timing bug needs', () => {
    // Simulates the exact race the bug report describes: a reveal is
    // requested for the store a reparse just produced, but something
    // (Tree unmounted, or a second reparse landing first) asks for it
    // against a *different* store object before that one ever consumes
    // it. Applying it there would walk `parentOf` on a store the node
    // wasn't allocated in.
    const requestedFor = emptyStore()
    const askedAgainst = emptyStore()
    requestReveal(5, requestedFor)
    expect(consumePendingReveal(askedAgainst)).toBeNull()
  })

  it('is one-shot — consuming it clears it, even for the same store asked twice', () => {
    const store = emptyStore()
    requestReveal(2, store)
    expect(consumePendingReveal(store)).toBe(2)
    expect(consumePendingReveal(store)).toBeNull()
  })

  it('a later request supersedes an earlier, unconsumed one', () => {
    const store = emptyStore()
    requestReveal(1, store)
    requestReveal(9, store)
    expect(consumePendingReveal(store)).toBe(9)
  })

  it('returns null with nothing ever requested', () => {
    expect(consumePendingReveal(emptyStore())).toBeNull()
  })
})
