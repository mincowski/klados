import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TOTAL_MEMORY_BUDGET_BYTES,
  getFormatMinifiedOnOpen,
  getTotalMemoryBudgetBytes,
  setFormatMinifiedOnOpen,
  setTotalMemoryBudgetBytes,
  toggleFormatMinifiedOnOpen
} from '../src/renderer/settings'

function fakeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    }
  } as Storage
}

describe('formatMinifiedOnOpen setting (M5-PLAN.md H8)', () => {
  const originalLocalStorage = globalThis.localStorage

  beforeEach(() => {
    ;(globalThis as { localStorage?: Storage }).localStorage = fakeStorage()
  })

  afterEach(() => {
    ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
  })

  it('defaults to false', () => {
    expect(getFormatMinifiedOnOpen()).toBe(false)
  })

  it('persists a set value', () => {
    setFormatMinifiedOnOpen(true)
    expect(getFormatMinifiedOnOpen()).toBe(true)
    setFormatMinifiedOnOpen(false)
    expect(getFormatMinifiedOnOpen()).toBe(false)
  })

  it('toggle flips the persisted value', () => {
    expect(getFormatMinifiedOnOpen()).toBe(false)
    toggleFormatMinifiedOnOpen()
    expect(getFormatMinifiedOnOpen()).toBe(true)
    toggleFormatMinifiedOnOpen()
    expect(getFormatMinifiedOnOpen()).toBe(false)
  })
})

describe('totalMemoryBudgetBytes setting (R28)', () => {
  const originalLocalStorage = globalThis.localStorage

  beforeEach(() => {
    ;(globalThis as { localStorage?: Storage }).localStorage = fakeStorage()
  })

  afterEach(() => {
    ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
  })

  it('defaults to DEFAULT_TOTAL_MEMORY_BUDGET_BYTES', () => {
    expect(getTotalMemoryBudgetBytes()).toBe(DEFAULT_TOTAL_MEMORY_BUDGET_BYTES)
  })

  it('persists a set value', () => {
    setTotalMemoryBudgetBytes(2 * 1024 * 1024 * 1024)
    expect(getTotalMemoryBudgetBytes()).toBe(2 * 1024 * 1024 * 1024)
  })

  it('falls back to the default for a non-positive or corrupted stored value', () => {
    setTotalMemoryBudgetBytes(-5)
    expect(getTotalMemoryBudgetBytes()).toBe(DEFAULT_TOTAL_MEMORY_BUDGET_BYTES)

    localStorage.setItem('klados.totalMemoryBudgetBytes', 'not a number')
    expect(getTotalMemoryBudgetBytes()).toBe(DEFAULT_TOTAL_MEMORY_BUDGET_BYTES)
  })
})
