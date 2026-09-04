import { describe, expect, it } from 'vitest'
import {
  canStepBack,
  canStepForward,
  EMPTY_HISTORY,
  recordVisit,
  stepBack,
  stepForward,
  type HistoryState
} from '../src/renderer/navigation/history'

describe('recordVisit (D14)', () => {
  it('starts empty, with nowhere to go', () => {
    expect(canStepBack(EMPTY_HISTORY)).toBe(false)
    expect(canStepForward(EMPTY_HISTORY)).toBe(false)
  })

  it('records a first visit', () => {
    const state = recordVisit(EMPTY_HISTORY, 5)
    expect(state).toEqual({ entries: [5], index: 0 })
  })

  it('is a no-op when re-recording the current entry', () => {
    const state = recordVisit(EMPTY_HISTORY, 5)
    const again = recordVisit(state, 5)
    expect(again).toBe(state) // same reference — a true no-op
  })

  it('appends a genuinely new visit', () => {
    let state = recordVisit(EMPTY_HISTORY, 1)
    state = recordVisit(state, 2)
    state = recordVisit(state, 3)
    expect(state).toEqual({ entries: [1, 2, 3], index: 2 })
  })

  it('discards forward entries when visiting after stepping back', () => {
    let state = recordVisit(EMPTY_HISTORY, 1)
    state = recordVisit(state, 2)
    state = recordVisit(state, 3)
    const back = stepBack(state)!
    state = recordVisit(back.state, 99)
    expect(state).toEqual({ entries: [1, 2, 99], index: 2 })
  })
})

describe('stepBack / stepForward (D14)', () => {
  function historyOf(...entries: number[]): HistoryState {
    return { entries, index: entries.length - 1 }
  }

  it('steps back through visited nodes', () => {
    const state = historyOf(1, 2, 3)
    const back = stepBack(state)!
    expect(back.node).toBe(2)
    expect(back.state.index).toBe(1)
  })

  it('returns null when already at the oldest entry', () => {
    const state: HistoryState = { entries: [1, 2, 3], index: 0 }
    expect(stepBack(state)).toBeNull()
  })

  it('returns null on an empty history', () => {
    expect(stepBack(EMPTY_HISTORY)).toBeNull()
    expect(stepForward(EMPTY_HISTORY)).toBeNull()
  })

  it('steps forward after stepping back', () => {
    const state = historyOf(1, 2, 3)
    const back = stepBack(state)!
    const forward = stepForward(back.state)!
    expect(forward.node).toBe(3)
    expect(forward.state.index).toBe(2)
  })

  it('returns null when already at the newest entry', () => {
    const state = historyOf(1, 2, 3)
    expect(stepForward(state)).toBeNull()
  })

  it('canStepBack/canStepForward reflect position accurately', () => {
    const state = historyOf(1, 2, 3)
    expect(canStepBack(state)).toBe(true)
    expect(canStepForward(state)).toBe(false)
    const back = stepBack(state)!
    expect(canStepBack(back.state)).toBe(true)
    expect(canStepForward(back.state)).toBe(true)
    const back2 = stepBack(back.state)!
    expect(canStepBack(back2.state)).toBe(false)
    expect(canStepForward(back2.state)).toBe(true)
  })
})
