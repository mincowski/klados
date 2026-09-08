import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { titleBarOverlayColorsFor, type TitleBarTheme } from '../shared/titleBar'
import icon from '../../assets/build/icons/256.png?asset'
// M5c-PLAN.md J7 / D-054: Windows resamples a 256px gradient tile down to
// 16px for the title bar, which reads as a blurry sticker — `icon.ico`
// carries purpose-drawn 16/24/32px frames (the bare monogram, no tile)
// instead of one image scaled for every size. macOS ignores this option
// entirely (see below), so only Windows needs the distinction.
import iconIco from '../../assets/build/icon.ico?asset'
import { registerReadTokenProtocol } from './documents'
import { handleWindowClose, confirmQuit as confirmQuitFlow } from '../core/mainQuitFlow'
import { isAllowedExternalUrl, isAppUrl } from '../core/mainSecurity'
import { getAppUrl, secureHandle, secureOn, setAppUrl } from './trustedRenderer'

// R26 (`R24-tabs.md` §4) — the consolidated quit flow. Windows whose
// close has actually been confirmed by the renderer (every dirty tab
// resolved) — a `WeakSet` rather than a boolean so a second window
// (`app.on('activate')` on macOS) never inherits the first one's answer.
const quitConfirmedWindows = new WeakSet<Electron.BrowserWindow>()

const KEYBINDINGS_FILENAME = 'keybindings.json'

function keybindingsPath(): string {
  return join(app.getPath('userData'), KEYBINDINGS_FILENAME)
}

// M5d-PLAN.md R1 — the renderer's theme (`theme.ts`) lives in its own
// `localStorage`, which main has no access to. Main persists its own copy
// of just the theme name, written every time `titleBar:setOverlayColors`
// is called, so the *next* launch's `BrowserWindow({ titleBarOverlay })`
// can seed the very first paint correctly instead of always flashing light
// chrome before the renderer's first theme read reaches it.
const TITLEBAR_THEME_FILENAME = 'titlebar-theme.json'

function titleBarThemePath(): string {
  return join(app.getPath('userData'), TITLEBAR_THEME_FILENAME)
}

async function readPersistedTitleBarTheme(): Promise<TitleBarTheme> {
  try {
    const raw = await readFile(titleBarThemePath(), 'utf-8')
    return JSON.parse(raw).theme === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

async function writePersistedTitleBarTheme(theme: TitleBarTheme): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(titleBarThemePath(), JSON.stringify({ theme }), 'utf-8')
}

secureHandle('titleBar:setOverlayColors', async (event, theme: TitleBarTheme): Promise<void> => {
  // Only Windows' `titleBarOverlay` exists to recolour — macOS's
  // `hiddenInset` traffic lights and Linux's native frame both ignore
  // this call, but the renderer calls it unconditionally on every theme
  // change (D-054a: no platform branch needed on that side) rather than
  // asking main first whether it would do anything.
  if (process.platform === 'win32') {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.setTitleBarOverlay(titleBarOverlayColorsFor(theme))
  }
  await writePersistedTitleBarTheme(theme)
})

// D4 — user keybinding overrides, persisted as a JSON file in userData.
// No in-app editor in M1; the file is the whole interface, read on startup
// and written by `commands/keybindings.ts`'s `saveOverrides`.
secureHandle('keybindings:read', async (): Promise<string | null> => {
  try {
    return await readFile(keybindingsPath(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
})

secureHandle('keybindings:write', async (_event, contents: string): Promise<void> => {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(keybindingsPath(), contents, 'utf-8')
})

// R26 (`R24-tabs.md` §4) — the other half of the `close` handler
// above: the renderer's final answer, once every dirty tab in its
// consolidated quit flow has been resolved (or there was nothing dirty to
// begin with).
secureOn('app:confirmQuit', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win === null) return
  confirmQuitFlow(win, quitConfirmedWindows)
  win.close()
})

// No-op: `event.preventDefault()` in the `close` handler already kept the
// window open. This exists so the renderer has an explicit "the user
// backed out" signal to send, symmetric with `confirmQuit` — nothing here
// needs to *do* anything for the window to simply stay open.
secureOn('app:cancelQuit', () => {})

// R59 (`R58-zoom.md` §4): `webContents.setZoomFactor` is main-process
// only, so this is the one seam the renderer's own persisted zoom
// (`settings.ts`) pushes through. `BrowserWindow.fromWebContents`, not a
// closed-over `mainWindow`, the same pattern `titleBar:setOverlayColors`
// above uses — correct for whichever window actually asked, not
// necessarily the first one created.
secureHandle('view:setZoomFactor', (event, factor: number): void => {
  BrowserWindow.fromWebContents(event.sender)?.webContents.setZoomFactor(factor)
})

/**
 * M5d-PLAN.md R1 — per-platform title bar shape. Windows gets a
 * system-drawn caption strip we can recolour (`titleBarOverlay`), which is
 * what keeps Snap Layouts working on maximize hover (§1's whole point);
 * macOS keeps its traffic lights via `hiddenInset`; Linux keeps its native
 * frame entirely — a frameless window there means drawing all three
 * caption buttons ourselves against window managers with no shared
 * convention for their order or behaviour, a deliberate gap (§1), not an
 * oversight.
 */
function titleBarWindowOptions(
  titleBarTheme: TitleBarTheme
): Pick<Electron.BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay'> {
  if (process.platform === 'win32') {
    return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlayColorsFor(titleBarTheme) }
  }
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset' }
  }
  return {}
}

async function createWindow(): Promise<void> {
  const titleBarTheme = await readPersistedTitleBarTheme()

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...titleBarWindowOptions(titleBarTheme),
    // A packaged app's Explorer/Finder/dock/taskbar icon always comes from
    // the platform installer format (.ico/.icns via electron-builder), so
    // this option's only real effect there is Windows' own title-bar icon
    // (macOS ignores it entirely). Its main purpose is `npm run dev` —
    // without it, a dev window shows Electron's own default icon.
    icon: process.platform === 'win32' ? iconIco : icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // R166 (`docs/plans/R164-release-security-hardening.md` §4): `true`, verified
      // rather than flipped. `contextIsolation` was already on and
      // `nodeIntegration` off, so the renderer main world had no Node — but
      // `sandbox: false` kept the *preload* running with full Node access and
      // dropped the renderer out of Chromium's own OS-level sandbox.
      //
      // **Flipping it broke the app, and that is why the plan asked for
      // verify-then-enable rather than "flip it".** The preload carried a
      // runtime `require("@electron-toolkit/preload")` — electron-vite
      // externalizes declared dependencies rather than bundling them — and a
      // sandboxed preload cannot resolve node_modules, so the script failed to
      // load outright and `window.api` was undefined. `preload/index.ts` now
      // documents that; the fix was to stop exposing an `electronAPI` nothing
      // ever read.
      //
      // `mainElectron.test.ts` is the verification, and it is repeatable in a
      // way the plan's manual lifecycle pass would not have been: the preload
      // surface, an IPC round trip and the document read path all run against
      // the real built app under this setting.
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // R26: hold the window open until the renderer has resolved every dirty
  // tab — the renderer, not main, owns "what's dirty" and how the user
  // gets asked about it (the consolidated quit flow, `session/tabs.ts` +
  // `session/quitFlow.ts`); main's only job is to not let the OS actually
  // tear the window down until that's settled.
  mainWindow.on('close', (event) => {
    const shouldProceed = handleWindowClose(
      mainWindow,
      mainWindow.webContents,
      quitConfirmedWindows
    )
    if (!shouldProceed) event.preventDefault()
  })

  // R1: the renderer has no other way to know it lost the OS's own
  // focus-dims-the-bar behaviour — a native title bar got this for free.
  mainWindow.on('focus', () => mainWindow.webContents.send('titleBar:focusChanged', true))
  mainWindow.on('blur', () => mainWindow.webContents.send('titleBar:focusChanged', false))
  // R6 (macOS): the traffic-light inset must collapse in fullscreen, where
  // the lights themselves hide.
  mainWindow.on('enter-full-screen', () =>
    mainWindow.webContents.send('titleBar:fullscreenChanged', true)
  )
  mainWindow.on('leave-full-screen', () =>
    mainWindow.webContents.send('titleBar:fullscreenChanged', false)
  )

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // R165: `openExternal` hands the string to the OS handler, so without a
    // scheme check a `file:`, `smb:` or `ms-msdt:` URL arriving here would be
    // actioned by the OS. Unreachable today — the renderer has no external
    // links, no `window.open`, no `target="_blank"` — which is exactly why it
    // is worth fixing while the right answer is obvious and nothing depends on
    // the looser behaviour.
    if (isAllowedExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // R58/R59 (`R58-zoom.md`): a fresh `file://` load starts Chromium at
  // zoom factor 1.25 for a reason this project never identified (§1 of that
  // document rules out the display, `--force-device-scale-factor`, the
  // harness, and a persisted user zoom) — `http://localhost` (dev) starts
  // at 1.0 on the same machine in the same launch. R58 fixed this with a
  // `did-finish-load` handler that unconditionally reset zoom to 1.0; R59
  // replaces it rather than keeping both, exactly as R58's own plan
  // anticipated ("must be written so R59 can replace the constant with a
  // restored setting rather than fight it") — the renderer's own
  // `settings.ts` now calls `view:setZoomFactor` eagerly on every boot
  // (`zoom.ts`'s module-load-time `apply(current)`, mirroring `theme.ts`),
  // defaulting to `1` exactly like this handler did when nothing is
  // persisted yet. Keeping both would race: a persisted zoom applied by the
  // renderer before this handler's `did-finish-load` fires would then be
  // silently stomped back to 1.0 by this constant.

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  // R164 (`docs/plans/R164-release-security-hardening.md` §2d): record what we
  // are about to load *before* loading it, so the navigation guard and the IPC
  // sender guard both have an answer to "is this still our page?" from the
  // first frame onward. Ordered correctly by construction — nothing can
  // navigate or send IPC before the load it is about to be compared against.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    setAppUrl(devUrl)
    mainWindow.loadURL(devUrl)
  } else {
    const indexPath = join(__dirname, '../renderer/index.html')
    setAppUrl(pathToFileURL(indexPath).href)
    mainWindow.loadFile(indexPath)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.klados.app')

  // M5-PLAN.md H12 — `protocol.handle` requires the app to already be
  // ready, the opposite requirement from `registerSchemesAsPrivileged`
  // (called at `documents.ts`'s own module load time, before this).
  registerReadTokenProtocol()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // R164 (`docs/plans/R164-release-security-hardening.md` §2d) — the primary
  // control. Nothing constrained top-level navigation before this: no
  // `will-navigate`, no `will-redirect`, no `web-contents-created` anywhere in
  // `src/`. Combined with a preload that re-exposes `window.api` on whatever
  // origin loads next, and IPC that mints read tokens for any path and writes
  // any bytes to any path, a single unexpected navigation turned the renderer
  // into an arbitrary file read *and* write primitive for remote content.
  //
  // **The app-level form, not `mainWindow.webContents` directly**, though both
  // would close today's hole. The value of this guard is that it denies every
  // unexpected navigation whatever the trigger — a dropped link, a stray
  // `location` assignment, a future feature, a bug — and a guard bound to one
  // `webContents` covers only the contexts that exist when it runs. This one
  // covers every context the app ever creates, including ones added by someone
  // who never read this comment.
  app.on('web-contents-created', (_, contents) => {
    const deny = (event: Electron.Event, url: string): void => {
      const appUrl = getAppUrl()
      if (appUrl !== null && isAppUrl(url, appUrl)) return
      event.preventDefault()
      console.warn(`[security] blocked navigation to ${url}`)
    }
    contents.on('will-navigate', (event, url) => deny(event, url))
    // A redirect is a navigation the page did not initiate, which is if
    // anything the more interesting half — a permitted first hop that lands
    // somewhere else entirely.
    contents.on('will-redirect', (event, url) => deny(event, url))

    // R165: Klados reads and writes local files and does nothing else. There is
    // no permission it could legitimately need, so every request is refused
    // outright rather than surfaced as a prompt the user has to interpret.
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    contents.session.setPermissionCheckHandler(() => false)
  })

  void createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
