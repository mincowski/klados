/**
 * Pure back/forward history logic (M1-PLAN.md D14, CONCEPT.md §4.5). A
 * plain list of visited nodes plus a cursor — kept free of the document
 * session so the truncate-on-new-visit and step behaviours can be tested
 * without one.
 */
import type { NodeRef } from '../../core/types'

export interface HistoryState {
  readonly entries: readonly NodeRef[]
  readonly index: number
}

export const EMPTY_HISTORY: HistoryState = { entries: [], index: -1 }

/**
 * Records a visit to `node`. A no-op if it's already the current entry
 * (selecting the same node twice shouldn't create a duplicate stop), and
 * — the standard back/forward-history rule — visiting anywhere while not
 * at the end of the list discards everything ahead of the cursor rather
 * than trying to splice a new branch into a linear history.
 */
export function recordVisit(state: HistoryState, node: NodeRef): HistoryState {
  if (state.entries[state.index] === node) return state
  const truncated = state.entries.slice(0, state.index + 1)
  return { entries: [...truncated, node], index: truncated.length }
}

export interface HistoryStep {
  readonly state: HistoryState
  readonly node: NodeRef
}

/** `null` when already at the oldest entry — nothing to go back to. */
export function stepBack(state: HistoryState): HistoryStep | null {
  if (state.index <= 0) return null
  const index = state.index - 1
  return { state: { ...state, index }, node: state.entries[index]! }
}

/** `null` when already at the newest entry — nothing to go forward to. */
export function stepForward(state: HistoryState): HistoryStep | null {
  if (state.index === -1 || state.index >= state.entries.length - 1) return null
  const index = state.index + 1
  return { state: { ...state, index }, node: state.entries[index]! }
}

export function canStepBack(state: HistoryState): boolean {
  return state.index > 0
}

export function canStepForward(state: HistoryState): boolean {
  return state.index !== -1 && state.index < state.entries.length - 1
}
