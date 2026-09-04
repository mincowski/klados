/**
 * R26's `close` interception (`R24-tabs.md` §4) — the main-process
 * half, pulled out so it can be unit-tested against plain objects rather
 * than a real `BrowserWindow` (R51, `R51-main-process.md`). Main's
 * only job is holding the native window open until the renderer says which
 * way to go; deciding *how* to ask the user about dirty tabs is entirely
 * the renderer's (`session/quitFlow.ts` — an unrelated, same-named module
 * on the other side of the IPC seam).
 *
 * Verified directly (not via Playwright's `_electron`): a `BrowserWindow`
 * closed while under Playwright's automation tears down regardless of
 * `event.preventDefault()`, so the one behaviour this module exists to
 * protect cannot be exercised through `_electron` at all — see
 * `R51-main-process.md`'s Results section. This extraction is what
 * makes the behaviour testable anyway.
 */

export interface QuitFlowWebContents {
  send(channel: 'app:quitRequested'): void
}

/**
 * Called from a `BrowserWindow`'s own `close` handler, before the caller
 * decides whether to call `event.preventDefault()`. `confirmedWindows` is
 * the caller's `WeakSet<BrowserWindow>` — a `WeakSet` rather than a boolean
 * flag so a second window (macOS's `app.on('activate')`) never inherits the
 * first window's already-confirmed answer.
 *
 * Returns `true` if the close should proceed (the window is already in
 * `confirmedWindows` — the second, real `close()` call `confirmQuit` below
 * triggers after the renderer resolves every dirty tab), `false` if the
 * close was intercepted and an `app:quitRequested` request was sent instead.
 */
export function handleWindowClose<W extends object>(
  window: W,
  webContents: QuitFlowWebContents,
  confirmedWindows: WeakSet<W>
): boolean {
  if (confirmedWindows.has(window)) return true
  webContents.send('app:quitRequested')
  return false
}

/** The renderer's `app:confirmQuit` handler's own half: marks `window` as
 * confirmed so the *next* `close()` call against it (which the caller must
 * still make) passes `handleWindowClose`'s guard instead of intercepting
 * again. */
export function confirmQuit<W extends object>(window: W, confirmedWindows: WeakSet<W>): void {
  confirmedWindows.add(window)
}
