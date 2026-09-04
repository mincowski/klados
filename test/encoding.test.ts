import { describe, expect, it } from 'vitest'
import { detectEncoding, stripBom } from '../src/core/encoding'

describe('detectEncoding', () => {
  it('detects a UTF-8 BOM', () => {
    const head = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x3f, 0x78])
    expect(detectEncoding(head, null)).toBe('utf-8')
  })

  it('detects a UTF-16LE BOM', () => {
    const head = new Uint8Array([0xff, 0xfe, 0x3c, 0x00])
    expect(detectEncoding(head, null)).toBe('utf-16le')
  })

  it('detects a UTF-16BE BOM', () => {
    const head = new Uint8Array([0xfe, 0xff, 0x00, 0x3c])
    expect(detectEncoding(head, null)).toBe('utf-16be')
  })

  it('uses the declared encoding when there is no BOM', () => {
    const head = new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c])
    expect(detectEncoding(head, 'ISO-8859-1')).toBe('ISO-8859-1')
  })

  it('prefers the BOM over a declared encoding', () => {
    const head = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c])
    expect(detectEncoding(head, 'ISO-8859-1')).toBe('utf-8')
  })

  it('defaults to utf-8 with no BOM and no declaration', () => {
    const head = new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c])
    expect(detectEncoding(head, null)).toBe('utf-8')
  })
})

describe('stripBom', () => {
  it('strips a UTF-8 BOM and reports its length', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x42])
    const result = stripBom(bytes)
    expect(result.bomLength).toBe(3)
    expect(Array.from(result.bytes)).toEqual([0x41, 0x42])
  })

  it('strips a UTF-16LE BOM', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00])
    const result = stripBom(bytes)
    expect(result.bomLength).toBe(2)
    expect(Array.from(result.bytes)).toEqual([0x41, 0x00])
  })

  it('reports zero length when there is no BOM', () => {
    const bytes = new Uint8Array([0x41, 0x42])
    const result = stripBom(bytes)
    expect(result.bomLength).toBe(0)
    expect(Array.from(result.bytes)).toEqual([0x41, 0x42])
  })
})
