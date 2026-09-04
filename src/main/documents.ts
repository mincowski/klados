/**
 * The main-process half of the document session's IPC seam (M1-PLAN.md D6):
 * an Open dialog, `fs.stat` (for the read-only flag and D6's size-limit
 * checks — stat before reading, so a 2 GB file is refused without ever
 * loading a byte of it), and the file read itself.
 *
 * **The file read is M5-PLAN.md H12** — the production wiring for H11's
 * spiked route (`spike/h11-protocol-fetch/`, `docs/DECISIONS.md` D-047).
 * `document:read` used to hand an `ArrayBuffer` back over `ipcMain.handle`,
 * which structured-clones it — a real copy, not a transfer
 * (`ipcRenderer.invoke` has no transfer-list equivalent) — measured at
 * 10 MB ~51 ms, 200 MB ~955 ms, 500 MB ~2.39 s, on top of a second copy
 * inside the renderer's own main thread before the bytes ever reached the
 * worker that actually parses them.
 *
 * That handler is gone. In its place: `document:mintReadToken` mints an
 * opaque, single-use token for a path the user has actually chosen (the
 * Open dialog, or an explicit path otherwise accepted); `protocol.handle`
 * serves the file through a streamed response keyed by that token; the
 * *worker* (`parse.worker.ts`'s `runParseFromUrlJob`) fetches it directly,
 * never the renderer's main thread. D-047's spike measured this at ~1.0×
 * peak RSS in the fetching process, with or without `Content-Length` —
 * the document now exists once, in the process that parses it, instead of
 * three times across two processes and an IPC hop.
 *
 * **The token is the whole security model.** `READ_TOKEN_SCHEME`'s handler
 * maps a token to a path via `pendingReadTokens`, never a URL to a path
 * directly — a protocol handler that did the latter would be an
 * arbitrary-file-read oracle reachable from any script that ends up
 * running in the renderer. A token is minted only here, deleted the
 * instant it's consumed (single-use), and swept on a TTL so an abandoned
 * mint (a dialog opened but never followed through, or a renderer that
 * crashed before fetching) doesn't linger.
 */
import { dialog, ipcMain, protocol, BrowserWindow, app } from 'electron'
import { basename } from 'path'
import { stat } from 'fs/promises'
import { watch as fsWatch } from 'fs'
import { randomUUID } from 'crypto'
import type { DocumentStat, OpenDialogResult } from '../preload/api'
import { createReadTokenRegistry } from '../core/readTokenRegistry'
import { handleReadTokenRequest } from '../core/readTokenProtocol'
import { statDocument, writeDocument } from '../core/mainDocumentIO'
import { createDocumentWatcherRegistry } from '../core/documentWatchers'

/** M5-PLAN.md H12. Must match `core/parseClient.ts`'s own copy of this
 * string exactly — duplicated rather than shared through a module both
 * `src/main` and `src/renderer`/`src/worker` can import (they compile as
 * separate TypeScript projects, `tsconfig.node.json` vs `tsconfig.web.json`/
 * `tsconfig.worker.json`, and this one literal isn't worth a shared-module
 * seam). A scheme mismatch here would fail loudly (the worker's `fetch`
 * would 404 against nothing registered), not silently. */
export const READ_TOKEN_SCHEME = 'klados-file'

protocol.registerSchemesAsPrivileged([
  {
    scheme: READ_TOKEN_SCHEME,
    privileges: {
      // A worker's `fetch` needs this treated like a normal, fetchable
      // origin — `standard`/`secure` for URL parsing and mixed-content
      // rules, `supportFetchAPI`/`corsEnabled` for `fetch()` itself to be
      // willing to cross from the page's real origin to this scheme, and
      // `stream` so the handler's `ReadableStream` response body is
      // actually streamed rather than buffered whole before delivery —
      // the entire point of not holding the file twice.
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

/** How long an unconsumed token survives before being swept — generous
 * relative to how quickly a real open actually follows a mint
 * (milliseconds), but bounded rather than left to leak forever if a
 * renderer never follows through. The mint/take/sweep logic itself lives
 * in `readTokenRegistry.ts` (unit-tested there); this is Electron wiring
 * around it. */
const READ_TOKEN_TTL_MS = 5 * 60 * 1000

const readTokens = createReadTokenRegistry(READ_TOKEN_TTL_MS, Date.now, randomUUID)

ipcMain.handle('document:mintReadToken', (_event, path: string): string => {
  return readTokens.mint(path)
})

/**
 * Registered once `app` is ready (`protocol.handle` requires it, unlike
 * `registerSchemesAsPrivileged` above, which requires the opposite — called
 * before the `ready` event). `main/index.ts` calls this from its own
 * `app.whenReady().then(...)` chain.
 */
export function registerReadTokenProtocol(): void {
  protocol.handle(READ_TOKEN_SCHEME, (request) => handleReadTokenRequest(request, readTokens))
}

ipcMain.handle('document:openDialog', async (event): Promise<OpenDialogResult | null> => {
  const window = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.OpenDialogOptions = {
    title: 'Open Document',
    properties: ['openFile'],
    filters: [
      {
        name: 'XML/JSON/TOML/CSV documents',
        extensions: ['xml', 'json', 'toml', 'csv', 'tsv', 'tab']
      },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const result =
    window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options)
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]!
  return { path, fileName: basename(path) }
})

ipcMain.handle('document:stat', async (_event, path: string): Promise<DocumentStat> => {
  return statDocument(path)
})

/**
 * M3-PLAN.md F7. Writes exactly `bytes` — invariant 6/7: never text, never
 * re-encoded. The read path (`document:mintReadToken` + the streamed
 * protocol handler above, M5-PLAN.md H12) already hands the renderer the
 * complete original byte sequence (BOM included, since nothing upstream
 * strips it — `core/encoding.ts`'s `bomLength` is only ever used to *find*
 * where content starts, never to cut the BOM out of the bytes a `SourceBuffer`
 * holds), and every edit since has spliced into that same buffer at exact
 * byte ranges (`documentEdits.ts`'s `applyPatch`) — so `bytes` here already
 * *is* the file's next contents, verbatim, with no transformation left to
 * apply on the way out.
 */
ipcMain.handle(
  'document:write',
  async (_event, path: string, bytes: ArrayBuffer): Promise<void> => {
    await writeDocument(path, bytes)
  }
)

ipcMain.handle(
  'document:saveAsDialog',
  async (event, defaultPath: string): Promise<OpenDialogResult | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = { title: 'Save Document As', defaultPath }
    const result =
      window === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(window, options)
    if (result.canceled || result.filePath === undefined) return null
    return { path: result.filePath, fileName: basename(result.filePath) }
  }
)

/**
 * M3-PLAN.md F8 (§11.3), R52 (`R51-main-process.md`) — watching open
 * files for external changes, one real OS watcher per unique path,
 * refcounted across every tab ("key") watching it. `document:watch`/
 * `document:unwatch` now take a `key` — the renderer's own tab identity
 * (`session/tabs.ts`'s `TabId`) — instead of replacing a single
 * module-level watcher the way M1's one-document assumption did.
 *
 * `fs.watch`'s callback fires on rename events too (some editors save via
 * write-to-temp-then-rename) and can fire more than once for a single
 * logical write (common on Windows, where a save is often several
 * filesystem operations) — `mtimeMs` comparison (inside
 * `createDocumentWatcherRegistry`) is what turns "the watcher noticed
 * something" into "the file's contents actually changed since we last
 * knew." That refcounting/mtime logic is Electron-free and unit-tested on
 * its own (`test/documentWatchers.test.ts`); everything here is the thin
 * wiring that turns a notified key into a `webContents.send`.
 */
const watchers = createDocumentWatcherRegistry({
  stat: (path) =>
    stat(path)
      .then((info) => ({ mtimeMs: info.mtimeMs }))
      .catch(() => null),
  watch: (path, onEvent) => {
    const fsWatcher = fsWatch(path, { persistent: false }, onEvent)
    return { close: () => fsWatcher.close() }
  }
})

// Which window each currently-registered key belongs to, so a closing
// window can release every watch it owns (the plan's own "teardown on
// window close covering all of them") without the registry itself having
// to know anything about `BrowserWindow`.
const keySenderIds = new Map<string, number>()

ipcMain.handle('document:watch', async (event, path: string, key: string): Promise<void> => {
  const senderId = event.sender.id
  keySenderIds.set(key, senderId)
  await watchers.watch(key, path, (watchedKey) => {
    const window = BrowserWindow.fromId(senderId)
    window?.webContents.send('document:externalChange', watchedKey)
  })
})

ipcMain.handle('document:unwatch', (_event, key: string): void => {
  keySenderIds.delete(key)
  watchers.unwatch(key)
})

app.on('browser-window-created', (_event, window) => {
  window.webContents.once('destroyed', () => {
    const senderId = window.webContents.id
    watchers.unwatchMatching((key) => keySenderIds.get(key) === senderId)
    for (const [key, id] of keySenderIds) {
      if (id === senderId) keySenderIds.delete(key)
    }
  })
})
