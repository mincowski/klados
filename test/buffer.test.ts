import { describe, expect, it } from 'vitest'
import { SourceBuffer, snapToCharBoundary } from '../src/core/buffer'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('snapToCharBoundary', () => {
  it('leaves an ASCII offset unchanged', () => {
    const bytes = utf8('hello')
    expect(snapToCharBoundary(bytes, 2)).toBe(2)
  })

  it('advances past continuation bytes of a CJK character', () => {
    // U+4E2D ("中") encodes as three bytes; offset 1 lands mid-character.
    const bytes = utf8('中')
    expect(bytes.length).toBe(3)
    expect(snapToCharBoundary(bytes, 1)).toBe(3)
    expect(snapToCharBoundary(bytes, 2)).toBe(3)
  })

  it('advances past continuation bytes of an emoji (surrogate pair, 4-byte UTF-8)', () => {
    const bytes = utf8('😀')
    expect(bytes.length).toBe(4)
    expect(snapToCharBoundary(bytes, 1)).toBe(4)
    expect(snapToCharBoundary(bytes, 3)).toBe(4)
  })

  it('does not move an offset already at a lead byte', () => {
    const bytes = utf8('a中b')
    const leadOfChun = 1
    expect(snapToCharBoundary(bytes, leadOfChun)).toBe(leadOfChun)
  })

  it('clamps to the buffer length at the end', () => {
    const bytes = utf8('abc')
    expect(snapToCharBoundary(bytes, 3)).toBe(3)
  })
})

describe('SourceBuffer', () => {
  it('decodes a slice on demand', () => {
    const bytes = utf8('hello world')
    const buf = new SourceBuffer(bytes, 'utf-8', 0)
    expect(buf.slice(0, 5)).toBe('hello')
    expect(buf.slice(6, 11)).toBe('world')
  })

  it('reports byteLength', () => {
    const bytes = utf8('hello')
    const buf = new SourceBuffer(bytes, 'utf-8', 0)
    expect(buf.byteLength).toBe(5)
  })

  it('a naive slice at an arbitrary byte offset mangles CJK content, snapToCharBoundary fixes it', () => {
    const bytes = utf8('中文abc')
    const buf = new SourceBuffer(bytes, 'utf-8', 0)

    // Byte 1 is the middle of the first character's 3-byte encoding.
    const naive = buf.slice(1, bytes.length)
    expect(naive).toContain('�') // replacement character(s)

    const snapped = buf.snapToCharBoundary(1)
    const fixed = buf.slice(snapped, bytes.length)
    expect(fixed).not.toContain('�')
    expect(fixed).toBe('文abc')
  })

  it('delegates snapToCharBoundary to the free function', () => {
    const bytes = utf8('中x')
    const buf = new SourceBuffer(bytes, 'utf-8', 0)
    expect(buf.snapToCharBoundary(1)).toBe(snapToCharBoundary(bytes, 1))
  })
})
