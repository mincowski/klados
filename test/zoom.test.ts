/**
 * R59 (`R58-zoom.md` §4) — `zoom.ts`'s own logic: eager apply on load
 * (mirroring `theme.ts`, `test/theme.test.ts`'s own pattern), clamping,
 * persistence, and the step table `zoomIn`/`zoomOut` walk. `settings.ts`'s
 * storage functions are exercised directly too (`getZoomFactor`/
 * `setZoomFactor` clamping a value written by something other than this
 * module — a hand-edited `localStorage`, or a future settings UI).
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

describe('settings: zoom factor storage', () => {
  const originalLocalStorage = globalThis.localStorage

  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as { localStorage?: Storage }).localStorage = fakeStorage()
  })

  afterEach(() => {
    ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
  })

  it('defaults to 1 when nothing is persisted', async () => {
    const { getZoomFactor } = await import('../src/renderer/settings')
    expect(getZoomFactor()).toBe(1)
  })

  it('round-trips a value through setZoomFactor/getZoomFactor', async () => {
    const { getZoomFactor, setZoomFactor } = await import('../src/renderer/settings')
    setZoomFactor(1.5)
    expect(getZoomFactor()).toBe(1.5)
  })

  it('clamps on write — an out-of-range value never reaches storage unclamped', async () => {
    const { getZoomFactor, setZoomFactor, MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR } =
      await import('../src/renderer/settings')
    setZoomFactor(10)
    expect(getZoomFactor()).toBe(MAX_ZOOM_FACTOR)
    setZoomFactor(0.01)
    expect(getZoomFactor()).toBe(MIN_ZOOM_FACTOR)
  })

  it('clamps on read too — a hand-edited or stale out-of-range value degrades safely', async () => {
    localStorage.setItem('klados.zoomFactor', '99')
    const { getZoomFactor, MAX_ZOOM_FACTOR } = await import('../src/renderer/settings')
    expect(getZoomFactor()).toBe(MAX_ZOOM_FACTOR)
  })

  it('a malformed persisted value falls back to 1, not NaN', async () => {
    localStorage.setItem('klados.zoomFactor', 'not-a-number')
    const { getZoomFactor } = await import('../src/renderer/settings')
    expect(getZoomFactor()).toBe(1)
  })
})

describe('zoom', () => {
  const originalLocalStorage = globalThis.localStorage
  const originalWindow = (globalThis as { window?: unknown }).window

  function installFakeApi(): { setZoomFactor: ReturnType<typeof vi.fn> } {
    const setZoomFactor = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as { window?: unknown }).window = { api: { view: { setZoomFactor } } }
    return { setZoomFactor }
  }

  beforeEach(() => {
    vi.resetModules()
    ;(globalThis as { localStorage?: Storage }).localStorage = fakeStorage()
  })

  afterEach(() => {
    ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
    ;(globalThis as { window?: unknown }).window = originalWindow
  })

  it('applies the persisted factor through the preload seam on module load', async () => {
    localStorage.setItem('klados.zoomFactor', '1.5')
    const { setZoomFactor } = installFakeApi()

    const { getZoomFactor } = await import('../src/renderer/zoom')

    expect(getZoomFactor()).toBe(1.5)
    expect(setZoomFactor).toHaveBeenCalledWith(1.5)
  })

  it('defaults to 1 when nothing is persisted — the R58 startup case, now via this module', async () => {
    const { setZoomFactor } = installFakeApi()
    const { getZoomFactor } = await import('../src/renderer/zoom')

    expect(getZoomFactor()).toBe(1)
    expect(setZoomFactor).toHaveBeenCalledWith(1)
  })

  it('setZoomFactor clamps, applies, persists, and notifies — a no-op change notifies nobody', async () => {
    const { setZoomFactor: applySpy } = installFakeApi()
    const { setZoomFactor, getZoomFactor, subscribeZoom, MAX_ZOOM_FACTOR } =
      await import('../src/renderer/zoom')
    const listener = vi.fn()
    subscribeZoom(listener)
    applySpy.mockClear() // the module-load apply(1) call above isn't part of this assertion

    setZoomFactor(10) // out of range
    expect(getZoomFactor()).toBe(MAX_ZOOM_FACTOR)
    expect(applySpy).toHaveBeenCalledWith(MAX_ZOOM_FACTOR)
    expect(localStorage.getItem('klados.zoomFactor')).toBe(String(MAX_ZOOM_FACTOR))
    expect(listener).toHaveBeenCalledTimes(1)

    applySpy.mockClear()
    listener.mockClear()
    setZoomFactor(MAX_ZOOM_FACTOR) // already there
    expect(applySpy).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  it('zoomIn/zoomOut walk the step table, not a fixed ratchet', async () => {
    installFakeApi()
    const { zoomIn, zoomOut, resetZoom, getZoomFactor } = await import('../src/renderer/zoom')

    resetZoom()
    expect(getZoomFactor()).toBe(1)
    zoomIn()
    expect(getZoomFactor()).toBe(1.1)
    zoomIn()
    expect(getZoomFactor()).toBe(1.25)
    zoomOut()
    expect(getZoomFactor()).toBe(1.1)
    zoomOut()
    zoomOut()
    expect(getZoomFactor()).toBe(0.9)
  })

  it('zoomIn/zoomOut never overshoot the bound, even called repeatedly at the end', async () => {
    installFakeApi()
    const { zoomIn, zoomOut, getZoomFactor, MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR } =
      await import('../src/renderer/zoom')

    for (let i = 0; i < 20; i++) zoomIn()
    expect(getZoomFactor()).toBe(MAX_ZOOM_FACTOR)

    for (let i = 0; i < 20; i++) zoomOut()
    expect(getZoomFactor()).toBe(MIN_ZOOM_FACTOR)
  })

  it('resetZoom returns to 100% from either direction', async () => {
    installFakeApi()
    const { zoomIn, zoomOut, resetZoom, getZoomFactor } = await import('../src/renderer/zoom')

    zoomIn()
    zoomIn()
    resetZoom()
    expect(getZoomFactor()).toBe(1)

    zoomOut()
    zoomOut()
    resetZoom()
    expect(getZoomFactor()).toBe(1)
  })

  it('degrades without throwing when no preload api is present (e.g. under Vitest)', async () => {
    // No `installFakeApi()` call — `window` stays whatever the environment
    // provides, and `getKladosApi()` returns `undefined` for it.
    const zoomModule = await import('../src/renderer/zoom')
    expect(() => zoomModule.zoomIn()).not.toThrow()
  })
})
