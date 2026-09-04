import { describe, expect, it } from 'vitest'
import { splitForMiddleTruncation } from '../src/renderer/textTruncate'

describe('splitForMiddleTruncation (M5d-PLAN.md R5)', () => {
  it('keeps a short name whole, as the tail', () => {
    expect(splitForMiddleTruncation('report.xml')).toEqual({ head: '', tail: 'report.xml' })
  })

  it('splits a long name so the tail keeps the extension', () => {
    const text = 'a-very-long-filename-indeed.xml'
    const result = splitForMiddleTruncation(text, 8)
    expect(result.head + result.tail).toBe(text)
    expect(result.tail).toBe('deed.xml')
    expect(result.tail.length).toBe(8)
  })

  it('a name exactly at the tail length stays whole', () => {
    const text = '123456789012' // 12 chars, the default tailChars
    expect(splitForMiddleTruncation(text)).toEqual({ head: '', tail: text })
  })

  it('respects a custom tailChars', () => {
    expect(splitForMiddleTruncation('abcdefgh', 3)).toEqual({ head: 'abcde', tail: 'fgh' })
  })
})
