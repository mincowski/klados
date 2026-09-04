import { describe, expect, it } from 'vitest'
import { viewportMatchDecorations } from '../src/renderer/components/Raw/matchDecorations'

describe('viewportMatchDecorations', () => {
  const starts = Int32Array.from([5, 20, 50])
  const ends = Int32Array.from([8, 23, 53])

  it('is empty outside any window', () => {
    expect(viewportMatchDecorations(starts, ends, null, 0, 0)).toEqual([])
    expect(viewportMatchDecorations(new Int32Array(0), new Int32Array(0), null, 0, 100)).toEqual([])
  })

  it('includes matches fully inside the window', () => {
    const spans = viewportMatchDecorations(starts, ends, null, 0, 100)
    expect(spans).toEqual([
      { start: 5, end: 8, current: false },
      { start: 20, end: 23, current: false },
      { start: 50, end: 53, current: false }
    ])
  })

  it('clips a match straddling the window start', () => {
    const spans = viewportMatchDecorations(starts, ends, null, 6, 100)
    expect(spans[0]).toEqual({ start: 6, end: 8, current: false })
  })

  it('clips a match straddling the window end', () => {
    const spans = viewportMatchDecorations(starts, ends, null, 0, 7)
    expect(spans).toEqual([{ start: 5, end: 7, current: false }])
  })

  it('excludes a match entirely outside the window', () => {
    const spans = viewportMatchDecorations(starts, ends, null, 30, 40)
    expect(spans).toEqual([])
  })

  it('marks the current match', () => {
    const spans = viewportMatchDecorations(starts, ends, 1, 0, 100)
    expect(spans[1]).toEqual({ start: 20, end: 23, current: true })
  })

  it('never returns an out-of-window span', () => {
    const spans = viewportMatchDecorations(starts, ends, null, 10, 15)
    expect(spans).toEqual([])
  })
})
