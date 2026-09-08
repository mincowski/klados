/**
 * R164 (`docs/plans/R164-release-security-hardening.md` §2d) — the IPC sender
 * guard.
 *
 * The navigation guard in `index.ts` is the primary control; this is the second
 * chokepoint on the same chain. The plan reached `will-navigate` and stopped,
 * and the review that preceded implementation found the other half: **13
 * `ipcMain` registrations across this directory, and not one of them asked who
 * was calling.** `event.sender` appeared six times and every use was
 * `BrowserWindow.fromWebContents(...)` to find a window — never to establish an
 * origin.
 *
 * **This is not the path validation §6 rejected**, and the difference is the
 * reason it belongs here. Path validation asks *which file may this caller
 * touch*, needs real state about what the user has chosen this session, and
 * fights three legitimate flows (a Save-As target, a dropped file, a restored
 * session). This asks *may this caller speak at all*, needs no state, and
 * fights nothing — every legitimate caller is the app's own page.
 *
 * **Why both, when either would close today's hole.** They fail differently. A
 * navigation guard that misses a context — a `<webview>` someone adds, a child
 * window, a path Electron grows later — leaves the IPC wide open; a sender
 * guard that is somehow bypassed leaves the renderer navigable but mute. The
 * cost of the second is one wrapper.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { isAppUrl } from '../core/mainSecurity'

/**
 * The URL the window was actually told to load. Set by `createWindow` before
 * `loadURL`/`loadFile`, which is ordered correctly by construction: IPC can
 * only arrive from a renderer that has already loaded.
 *
 * `null` until then, and `null` denies — a handler that somehow fires before
 * the window exists has no legitimate caller to be from.
 */
let appUrl: string | null = null

export function setAppUrl(url: string): void {
  appUrl = url
}

/** Exposed for the navigation guard, which needs the same value. */
export function getAppUrl(): string | null {
  return appUrl
}

function senderUrl(event: IpcMainInvokeEvent | IpcMainEvent): string | null {
  try {
    // `senderFrame` is nullable, and reading `.url` on a frame that has since
    // been destroyed throws — both mean "no identifiable caller", which is a
    // denial rather than an error to propagate.
    return event.senderFrame?.url ?? null
  } catch {
    return null
  }
}

export function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const url = senderUrl(event)
  return url !== null && appUrl !== null && isAppUrl(url, appUrl)
}

/**
 * `ipcMain.handle` with the sender checked first.
 *
 * **Throws rather than returning quietly**, per the plan's acceptance note: a
 * handler that returns nothing on a hostile call is indistinguishable from one
 * that worked, and the renderer-side promise rejection is what makes a refusal
 * visible in a log or a bug report.
 */
export function secureHandle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error(`Refused ${channel} from an untrusted frame`)
    }
    return (listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown)(event, ...args)
  })
}

/**
 * `ipcMain.on` with the same check.
 *
 * A send has no reply channel, so an untrusted call can only be dropped — there
 * is nothing to reject. That asymmetry is why the two `on` channels here are
 * both fire-and-forget window operations (minimize, maximize) rather than
 * anything whose result a caller needs to trust.
 */
export function secureOn(
  channel: string,
  listener: (event: IpcMainEvent, ...args: never[]) => void
): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      // **Logged, because a dropped send is otherwise invisible and one of
      // these two channels is the quit flow.** `app:confirmQuit` is how the
      // renderer tells main that every dirty tab is resolved and the window may
      // actually close (R26); if this guard ever wrongly refused it, the
      // symptom would be a window that will not close and no explanation
      // anywhere. A line in the log turns that from a mystery into a grep.
      console.warn(`[security] dropped ${channel} from an untrusted frame`)
      return
    }
    ;(listener as (event: IpcMainEvent, ...args: unknown[]) => void)(event, ...args)
  })
}
