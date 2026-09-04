/**
 * D2 — theme.ts's switching logic, exercised without a real DOM. The
 * module reads `document`/`localStorage` at load time (for the initial
 * theme) and on every `setTheme` call, so both globals are stubbed before
 * importing it. The actual "no React re-render" property (D2's other
 * acceptance criterion) follows from the module never touching React state
 * at all — nothing here to subscribe to, which is the point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

function fakeDocument(): Document {
  return { documentElement: { dataset: {} as DOMStringMap } } as unknown as Document
}

describe('theme', () => {
  const originalDocument = globalThis.document
  const originalLocalStorage = globalThis.localStorage

  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as { document?: Document }).document = fakeDocument()
    ;(globalThis as { localStorage?: Storage }).localStorage = fakeStorage()
  })

  afterEach(() => {
    ;(globalThis as { document?: Document }).document = originalDocument
    ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
  })

  it('defaults to light and applies data-theme on load', async () => {
    const { getTheme } = await import('../src/renderer/theme')
    expect(getTheme()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('setTheme updates the DOM, persists, and notifies subscribers', async () => {
    const { setTheme, getTheme, subscribeTheme } = await import('../src/renderer/theme')
    const listener = vi.fn()
    const unsubscribe = subscribeTheme(listener)

    setTheme('dark')

    expect(getTheme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('klados.theme')).toBe('dark')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    setTheme('light')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('setTheme is a no-op when the theme is unchanged — no redundant notification', async () => {
    const { setTheme, subscribeTheme } = await import('../src/renderer/theme')
    const listener = vi.fn()
    subscribeTheme(listener)

    setTheme('light') // already the default
    expect(listener).not.toHaveBeenCalled()
  })

  it('toggleTheme flips light/dark', async () => {
    const { toggleTheme, getTheme } = await import('../src/renderer/theme')
    expect(getTheme()).toBe('light')
    toggleTheme()
    expect(getTheme()).toBe('dark')
    toggleTheme()
    expect(getTheme()).toBe('light')
  })

  it('reads a persisted preference on load', async () => {
    localStorage.setItem('klados.theme', 'dark')
    const { getTheme } = await import('../src/renderer/theme')
    expect(getTheme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
