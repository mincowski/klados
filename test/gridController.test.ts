/**
 * R211 (`docs/plans/R210-grid-grouping.md` §7) — the grid controller registry
 * with several grids mounted at once.
 *
 * One table per group means several live `Grid` components, and the registry
 * was a single slot: whichever grid registered last owned every palette
 * command. That is the same arbitrary-target problem R210 removed from
 * detection, reappearing one layer up — "Copy Grid as CSV" would copy a
 * table the user had not looked at, deterministically and invisibly.
 *
 * Focus is what disambiguates, and it is deliberately *sticky*: opening the
 * palette moves focus into the palette, so a controller that cleared on blur
 * would have no target by the time the command ran.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  copyGridAs,
  focusGrid,
  focusGridQuickFilter,
  mountedGridCount,
  noteGridFocused,
  registerGridController,
  resetGridControllersForTests,
  type GridController
} from '../src/renderer/components/Detail/gridController'

interface Spy extends GridController {
  readonly calls: string[]
}

function spy(): Spy {
  const calls: string[] = []
  return {
    calls,
    copyAs: (format) => calls.push(`copyAs:${format}`),
    focusQuickFilter: () => calls.push('focusQuickFilter'),
    focusGrid: () => calls.push('focusGrid'),
    confirmExport: () => calls.push('confirmExport'),
    cancelExport: () => calls.push('cancelExport')
  }
}

afterEach(() => resetGridControllersForTests())

describe('gridController with several grids mounted (R211)', () => {
  it('holds every mounted grid, not just the last one to register', () => {
    const a = {}
    const b = {}
    registerGridController(a, spy())
    registerGridController(b, spy())
    expect(mountedGridCount()).toBe(2)
  })

  it('commands act on the first grid until one is focused', () => {
    const first = spy()
    const second = spy()
    registerGridController({}, first)
    registerGridController({}, second)

    copyGridAs('csv')
    expect(first.calls).toEqual(['copyAs:csv'])
    expect(second.calls).toEqual([])
  })

  it('and on the focused one once there is one', () => {
    const firstId = {}
    const secondId = {}
    const first = spy()
    const second = spy()
    registerGridController(firstId, first)
    registerGridController(secondId, second)

    noteGridFocused(secondId)
    copyGridAs('markdown')
    focusGridQuickFilter()

    expect(second.calls).toEqual(['copyAs:markdown', 'focusQuickFilter'])
    expect(first.calls).toEqual([])
  })

  it('focus survives the grid re-registering its controller', () => {
    // **The reason the id is separate from the controller object.** `Grid`
    // re-registers whenever its sort, filter or column set changes, so the
    // controller identity is replaced constantly during ordinary use —
    // typing one character into a filter box would otherwise hand every
    // command back to the first table.
    const firstId = {}
    const secondId = {}
    registerGridController(firstId, spy())
    registerGridController(secondId, spy())
    noteGridFocused(secondId)

    const afterFilterKeystroke = spy()
    registerGridController(secondId, afterFilterKeystroke)

    copyGridAs('tsv')
    expect(afterFilterKeystroke.calls).toEqual(['copyAs:tsv'])
    expect(mountedGridCount()).toBe(2)
  })

  it('falls back to the first grid when the focused one unmounts', () => {
    const firstId = {}
    const secondId = {}
    const first = spy()
    const second = spy()
    registerGridController(firstId, first)
    const unregisterSecond = registerGridController(secondId, second)
    noteGridFocused(secondId)

    unregisterSecond()

    copyGridAs('csv')
    expect(mountedGridCount()).toBe(1)
    expect(first.calls).toEqual(['copyAs:csv'])
    expect(second.calls).toEqual([])
  })

  it('focusGrid reports false with nothing mounted, so Detail can fall through', () => {
    expect(focusGrid()).toBe(false)
    const grid = spy()
    registerGridController({}, grid)
    expect(focusGrid()).toBe(true)
    expect(grid.calls).toEqual(['focusGrid'])
  })

  it('an unregister does not remove a grid that has already re-registered', () => {
    // React can run the new effect before the old one's cleanup; a cleanup
    // that deleted by id alone would unmount a live grid from the registry.
    const id = {}
    const stale = spy()
    const fresh = spy()
    const unregisterStale = registerGridController(id, stale)
    registerGridController(id, fresh)

    unregisterStale()

    expect(mountedGridCount()).toBe(1)
    copyGridAs('csv')
    expect(fresh.calls).toEqual(['copyAs:csv'])
  })

  it('focusing a grid that is not registered changes nothing', () => {
    const registered = spy()
    registerGridController({}, registered)
    noteGridFocused({})
    copyGridAs('csv')
    expect(registered.calls).toEqual(['copyAs:csv'])
  })
})
