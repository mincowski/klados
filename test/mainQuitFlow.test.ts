/**
 * R51 (`R51-main-process.md`) — `handleWindowClose`/`confirmQuit`
 * (`src/core/mainQuitFlow.ts`) against plain objects, not a real
 * `BrowserWindow`. Verified directly that Playwright's `_electron` cannot
 * exercise this behaviour at all: a window closed under its automation
 * tears down regardless of `event.preventDefault()` (see that document's
 * Results section), which is exactly why this logic was pulled out of
 * `main/index.ts` rather than tested through `_electron` as the plan
 * first proposed.
 */
import { describe, expect, it } from 'vitest'
import { confirmQuit, handleWindowClose } from '../src/core/mainQuitFlow'

function fakeWebContents(): { sent: string[]; send: (channel: 'app:quitRequested') => void } {
  const sent: string[] = []
  return { sent, send: (channel) => sent.push(channel) }
}

describe('handleWindowClose', () => {
  it('intercepts an unconfirmed window: returns false and sends app:quitRequested', () => {
    const window = {}
    const webContents = fakeWebContents()
    const confirmed = new WeakSet<object>()

    const shouldProceed = handleWindowClose(window, webContents, confirmed)

    expect(shouldProceed).toBe(false)
    expect(webContents.sent).toEqual(['app:quitRequested'])
  })

  it('lets a confirmed window close proceed: returns true, sends nothing', () => {
    const window = {}
    const webContents = fakeWebContents()
    const confirmed = new WeakSet<object>([window])

    const shouldProceed = handleWindowClose(window, webContents, confirmed)

    expect(shouldProceed).toBe(true)
    expect(webContents.sent).toEqual([])
  })

  it('confirmQuit marks a window so the next close proceeds — the real close() → confirmQuit → close() sequence', () => {
    const window = {}
    const webContents = fakeWebContents()
    const confirmed = new WeakSet<object>()

    // First close(): intercepted.
    expect(handleWindowClose(window, webContents, confirmed)).toBe(false)

    // The renderer resolved every dirty tab and called app:confirmQuit.
    confirmQuit(window, confirmed)

    // Second close(): now proceeds.
    expect(handleWindowClose(window, webContents, confirmed)).toBe(true)
    expect(webContents.sent).toEqual(['app:quitRequested'])
  })

  it("a second, distinct window never inherits the first window's confirmed answer", () => {
    const first = {}
    const second = {}
    const confirmed = new WeakSet<object>()
    confirmQuit(first, confirmed)

    const webContents = fakeWebContents()
    expect(handleWindowClose(second, webContents, confirmed)).toBe(false)
    expect(webContents.sent).toEqual(['app:quitRequested'])
  })
})
