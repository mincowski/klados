/**
 * The shape of `window.api`, split out from `index.ts` (the implementation)
 * and `index.d.ts` (the global `Window` augmentation) so both — and
 * anything in `src/renderer` that wants the type without pulling in the
 * ambient global — can import the same declaration.
 */
import type { TitleBarTheme } from '../shared/titleBar'

export type { TitleBarTheme }

export interface OpenDialogResult {
  readonly path: string
  readonly fileName: string
}

export interface DocumentStat {
  readonly size: number
  readonly readOnly: boolean
}

export interface KladosApi {
  keybindings: {
    read(): Promise<string | null>
    write(contents: string): Promise<void>
  }
  document: {
    /** Shows the native Open dialog. Resolves `null` if the user cancels. */
    openDialog(): Promise<OpenDialogResult | null>
    /** `fs.stat` plus a write-access probe — read before `read()` so D6's
     * size-limit checks (soft cap confirm, hard ceiling refusal) never have
     * to load bytes just to decide whether to. */
    stat(path: string): Promise<DocumentStat>
    /** M5-PLAN.md H12. Mints an opaque, single-use token for `path` — the
     * only thing the read protocol handler (`main/documents.ts`) will
     * accept. Reading the actual bytes is the *worker*'s job
     * (`parseFromUrlInWorker`, `core/parseClient.ts`), fetching
     * `klados-file://<token>/` directly — no IPC copy of the document
     * ever crosses into the renderer's main thread. */
    mintReadToken(path: string): Promise<string>
    /** A dropped `File`'s absolute path — `File.path` was removed from
     * Electron's renderer-side `File` object; `webUtils.getPathForFile`,
     * called here from preload (no IPC round trip needed), is the
     * replacement. */
    getPathForFile(file: File): string
    /** M3-PLAN.md F7. Writes `bytes` to `path` verbatim — no encoding, no
     * transformation. Overwrites unconditionally; the caller (`isReadOnly`)
     * is what keeps this from ever being invoked against a file the user
     * can't write to. */
    write(path: string, bytes: ArrayBuffer): Promise<void>
    /** Shows the native Save As dialog, seeded with `defaultPath`. Resolves
     * `null` if the user cancels. */
    saveAsDialog(defaultPath: string): Promise<OpenDialogResult | null>
    /** M3-PLAN.md F8 (§11.3), R52 (`R51-main-process.md`). Starts
     * watching `path` for external changes under `key` — the renderer's own
     * tab identity (`session/tabs.ts`'s `TabId`) — replacing whatever `key`
     * was previously watching, if anything. Two different keys may watch
     * the same path at once (the same file open in two tabs); main
     * refcounts one real OS watcher per unique path. A no-op, watching
     * nothing, if `path` can't be stat'd. */
    watch(path: string, key: string): Promise<void>
    /** Stops `key`'s watch, if it has one. */
    unwatch(key: string): Promise<void>
    /** Subscribes to external-change notifications for every key this
     * renderer process has watched — the callback receives the `key` whose
     * file changed, so each subscriber (one per open tab's session) can
     * filter to its own. Returns an unsubscribe function. */
    onExternalChange(callback: (key: string) => void): () => void
  }
  /** M5d-PLAN.md R1 — the frameless title bar's own IPC seam. The renderer
   * owns the theme (`theme.ts`); only main can call `BrowserWindow
   * .setTitleBarOverlay`, since that's a main-process-only API — this is
   * what lets the renderer stay the source of truth while still reaching
   * the OS-drawn caption strip. */
  titleBar: {
    /** Resolved once in preload (`process.platform` is available there) so
     * the renderer never needs its own IPC round trip just to branch on
     * platform for macOS's traffic-light inset or Linux's native frame. */
    readonly platform: NodeJS.Platform
    /** No-op on macOS/Linux (there is no overlay to recolour there) —
     * still safe to call unconditionally so the renderer doesn't need its
     * own platform branch just to skip it. Persists `theme` to disk too,
     * so the *next* launch's first paint is seeded correctly instead of
     * flashing light chrome before the renderer's own theme read lands. */
    setOverlayColors(theme: TitleBarTheme): Promise<void>
    /** R1's replacement for the focus/blur dimming a native title bar gets
     * for free. Returns an unsubscribe function. */
    onFocusChange(callback: (focused: boolean) => void): () => void
    /** R1 (macOS): the traffic-light inset collapses in fullscreen, where
     * the lights themselves hide. Returns an unsubscribe function. */
    onFullscreenChange(callback: (fullscreen: boolean) => void): () => void
  }
  /** R26 (`R24-tabs.md` §4) — the consolidated quit flow's own IPC
   * seam. Main intercepts the window's `close` event and holds it open
   * (`event.preventDefault()`) until the renderer says which way to go —
   * nothing here decides *how* the renderer resolves dirty tabs, only
   * carries the final answer back to the one process that can actually
   * close the window. */
  app: {
    /** Fired when the window is trying to close and hasn't been confirmed
     * yet. Returns an unsubscribe function. */
    onQuitRequested(callback: () => void): () => void
    /** Every dirty tab has been resolved (saved or discarded) — actually
     * close the window now. */
    confirmQuit(): void
    /** The user backed out of quitting — leave the window exactly as it
     * was; main already kept it open via `preventDefault`, so this exists
     * only so the renderer has an explicit signal to send, symmetric with
     * `confirmQuit`. */
    cancelQuit(): void
  }
  /** R59 (`R58-zoom.md` §4) — content zoom's own IPC seam. Chromium's
   * zoom lives on `webContents`, a main-process-only object; `settings.ts`
   * owns the persisted value and calls through here rather than reaching
   * for `webFrame` in the renderer (which manipulates zoom for the calling
   * frame only, invisibly to `BrowserWindow`'s own zoom state main reads
   * elsewhere — title bar geometry, a future zoom-aware measurement — so
   * `webContents.setZoomFactor` from main is the one source of truth). */
  view: {
    /** Sets *this window's* zoom factor (`1` is 100%). Resolves once
     * applied; there is no corresponding getter because the renderer's own
     * persisted value (`settings.ts`) is already the source of truth —
     * this call only ever pushes it outward, never pulls it back. */
    setZoomFactor(factor: number): Promise<void>
  }
}
