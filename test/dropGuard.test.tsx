/**
 * R164 (`docs/plans/R164-release-security-hardening.md` §2d, §2e) — the
 * window-level drop guard.
 *
 * **What this can and cannot prove.** It cannot dispatch a native drag-drop —
 * that needs a real Electron window, which the harness does not have (§2c) — so
 * it tests the decision the guard makes about a `drop` event, not the OS
 * gesture that produces one. That is the same honest boundary §2c draws for the
 * navigation guard: the guard denies every unexpected navigation regardless of
 * trigger, so pinning a test to one trigger tests the wrong thing.
 *
 * The property under test is that **no drop anywhere reaches Chromium's default
 * action**, which for a dragged link is to navigate the top frame — the first
 * step of the chain R164 exists to break.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDropGuard } from '../src/renderer/dropGuard'
import { resetTabsForTests } from '../src/renderer/session/tabs'
import type { KladosApi } from '../src/preload/api'

type ApiWindow = Window & { api?: KladosApi }

let dispose: (() => void) | null = null

afterEach(() => {
  dispose?.()
  dispose = null
  Reflect.deleteProperty(window, 'api')
  resetTabsForTests()
})

/** Only `getPathForFile` is under test, but `openPathInNewTab` builds a real
 * session behind it, which reaches for the watcher seam — so the double has to
 * answer the whole surface rather than the one method. */
function fakeApi(getPathForFile: (file: File) => string): KladosApi {
  return {
    document: {
      openDialog: vi.fn().mockResolvedValue(null),
      stat: vi.fn().mockResolvedValue({ size: 0, readOnly: false }),
      mintReadToken: vi.fn().mockResolvedValue('token'),
      read: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      write: vi.fn().mockResolvedValue(undefined),
      saveAsDialog: vi.fn().mockResolvedValue(null),
      getPathForFile,
      watch: vi.fn().mockResolvedValue(undefined),
      unwatch: vi.fn().mockResolvedValue(undefined),
      onExternalChange: vi.fn().mockReturnValue(() => {})
    }
  } as unknown as KladosApi
}

/** A `drop` that carries no files — a dragged *link*, which is the shape of the
 * attack and the one the old `.layout`-scoped handler never saw. */
function dropEvent(): Event {
  return new Event('drop', { bubbles: true, cancelable: true })
}

function dragOverEvent(): Event {
  return new Event('dragover', { bubbles: true, cancelable: true })
}

describe('R164 — the drop guard covers the whole window', () => {
  it('prevents a drop dispatched on the document body', () => {
    dispose = installDropGuard()
    const event = dropEvent()
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('prevents a drop on window chrome — the region that used to fall through', () => {
    // `TitleBar` and `TabStrip` render as siblings *above* `.layout`, so a drop
    // here reached no handler at all before R164. Standing in for them with a
    // bare element outside any `.layout` subtree is the honest equivalent: what
    // changed is that the listener is on `window`, so the element's position in
    // the tree stopped mattering.
    const chrome = document.createElement('div')
    chrome.className = 'title-bar'
    document.body.appendChild(chrome)
    try {
      dispose = installDropGuard()
      const event = dropEvent()
      chrome.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    } finally {
      chrome.remove()
    }
  })

  it('prevents dragover too — without it the drop never fires', () => {
    dispose = installDropGuard()
    const event = dragOverEvent()
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('prevents a link drop even though there is no file to open', () => {
    // The early returns in the handler must not be reachable before
    // `preventDefault` — a dragged link carries no `files`, and it is exactly
    // the payload that would otherwise navigate the frame.
    dispose = installDropGuard()
    const event = dropEvent()
    Object.defineProperty(event, 'dataTransfer', { value: { files: [] } })
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('R164 — a dropped file still opens', () => {
  it('routes through getPathForFile into a new tab', () => {
    const getPathForFile = vi.fn().mockReturnValue('C:/docs/dropped.json')
    ;(window as ApiWindow).api = fakeApi(getPathForFile)

    dispose = installDropGuard()
    const file = new File(['{"a":1}'], 'dropped.json')
    const event = dropEvent()
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } })
    document.body.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(getPathForFile).toHaveBeenCalledWith(file)
  })
})

describe('R164 — the guard is removable', () => {
  it('stops preventing once disposed', () => {
    const stop = installDropGuard()
    stop()
    const event = dropEvent()
    document.body.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
