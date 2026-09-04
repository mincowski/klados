import { describe, expect, it } from 'vitest'
import { GrowableBytes } from '../src/core/growableBytes'

describe('GrowableBytes', () => {
  it('accumulates pushed bytes in order', () => {
    const g = new GrowableBytes(2)
    g.push(1)
    g.push(2)
    g.push(3)
    expect(Array.from(g.toArray())).toEqual([1, 2, 3])
  })

  it('grows past its initial capacity without losing data', () => {
    const g = new GrowableBytes(1)
    for (let i = 0; i < 10000; i++) g.push(i % 256)
    const arr = g.toArray()
    expect(arr.length).toBe(10000)
    for (let i = 0; i < 10000; i++) expect(arr[i]).toBe(i % 256)
  })

  it('pushBytes copies a source range verbatim', () => {
    const source = new Uint8Array([10, 20, 30, 40, 50])
    const g = new GrowableBytes(1)
    g.pushBytes(source, 1, 4)
    expect(Array.from(g.toArray())).toEqual([20, 30, 40])
  })

  it('pushAscii encodes ASCII text as bytes', () => {
    const g = new GrowableBytes(1)
    g.pushAscii('ab')
    expect(Array.from(g.toArray())).toEqual(['a'.charCodeAt(0), 'b'.charCodeAt(0)])
  })

  it('mixes push, pushBytes and pushAscii in one accumulator', () => {
    const source = new Uint8Array([0x78, 0x79]) // "xy"
    const g = new GrowableBytes(1)
    g.pushAscii('a')
    g.pushBytes(source, 0, 2)
    g.push('z'.charCodeAt(0))
    expect(new TextDecoder().decode(g.toArray())).toBe('axyz')
  })

  it('length reflects the number of bytes pushed, not backing capacity', () => {
    const g = new GrowableBytes(4)
    g.push(1)
    expect(g.length).toBe(1)
    g.push(2)
    g.push(3)
    g.push(4)
    g.push(5) // forces a grow
    expect(g.length).toBe(5)
  })

  it('toArray on an empty accumulator returns an empty array', () => {
    const g = new GrowableBytes()
    expect(g.toArray().length).toBe(0)
  })
})
