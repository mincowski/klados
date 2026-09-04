/**
 * M5-PLAN.md H12's security model, unit-tested directly: a token is
 * single-use, unknown tokens return `undefined`, and an unconsumed token
 * expires after its TTL. See `src/core/readTokenRegistry.ts`'s own doc
 * comment for why this logic was pulled out of `src/main/documents.ts`.
 */
import { describe, expect, it } from 'vitest'
import { createReadTokenRegistry } from '../src/core/readTokenRegistry'

describe('createReadTokenRegistry', () => {
  it('mints a token that resolves to the minted path', () => {
    const registry = createReadTokenRegistry(1000)
    const token = registry.mint('C:/docs/data.json')
    expect(registry.take(token)).toBe('C:/docs/data.json')
  })

  it('is single-use: a second take of the same token fails', () => {
    const registry = createReadTokenRegistry(1000)
    const token = registry.mint('C:/docs/data.json')
    registry.take(token)
    expect(registry.take(token)).toBeUndefined()
  })

  it('an unknown token resolves to undefined', () => {
    const registry = createReadTokenRegistry(1000)
    expect(registry.take('never-minted')).toBeUndefined()
  })

  it('two mints for the same path produce distinct tokens', () => {
    let counter = 0
    const registry = createReadTokenRegistry(1000, Date.now, () => `token-${counter++}`)
    const a = registry.mint('C:/docs/data.json')
    const b = registry.mint('C:/docs/data.json')
    expect(a).not.toBe(b)
    expect(registry.take(a)).toBe('C:/docs/data.json')
    expect(registry.take(b)).toBe('C:/docs/data.json')
  })

  it('an unconsumed token expires after the TTL, on the next sweep', () => {
    let now = 0
    const registry = createReadTokenRegistry(
      1000,
      () => now,
      () => 'fixed-token'
    )
    const token = registry.mint('C:/docs/data.json')
    now = 1001
    registry.sweepExpired()
    expect(registry.take(token)).toBeUndefined()
  })

  it('a token within the TTL is not swept', () => {
    let now = 0
    const registry = createReadTokenRegistry(1000, () => now)
    const token = registry.mint('C:/docs/data.json')
    now = 999
    registry.sweepExpired()
    expect(registry.take(token)).toBe('C:/docs/data.json')
  })

  it('minting sweeps expired entries as a side effect', () => {
    let now = 0
    let counter = 0
    const registry = createReadTokenRegistry(
      1000,
      () => now,
      () => `token-${counter++}`
    )
    const stale = registry.mint('C:/docs/old.json')
    now = 2000
    registry.mint('C:/docs/new.json') // triggers a sweep before minting
    expect(registry.take(stale)).toBeUndefined()
  })
})
