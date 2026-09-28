/**
 * R221 (`docs/plans/R221-electron-44.md` § 3.2) — the folder the Open dialog
 * starts in.
 *
 * **Electron 43 changed who decides.** Without a `defaultPath`, dialogs used
 * to start wherever the operating system chose — on Windows the last folder
 * this program's dialog visited, kept across restarts under `ComDlg32`'s
 * `LastVisitedPidlMRU` (which holds a `Klados.exe` entry, measured), and on
 * macOS the open panel's own per-application memory. From 43 Electron passes
 * the Downloads folder instead, and the OS stops remembering. So Klados
 * remembers the folder itself: the folder of the last file chosen in its Open
 * or Save As dialog, persisted beside `titlebar-theme.json` so it survives a
 * restart as the OS's memory did.
 *
 * Only a folder the user picked in a native dialog is ever written. No
 * Electron import: `main/documents.ts` is the wiring, as it is for
 * `mainDocumentIO.ts`, so this is tested against a real file system.
 */
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname } from 'path'

export interface DialogFolder {
  /** The remembered folder, if one is remembered and still a folder on disk;
   * otherwise `undefined`, which leaves Electron's own default in place. */
  defaultPath(): Promise<string | undefined>
  /** Remembers the folder of `filePath`, a file the user just chose. A failed
   * write is reported and otherwise ignored: forgetting a folder must never
   * fail an open or a save. */
  remember(filePath: string): Promise<void>
}

export function createDialogFolder(
  stateFile: () => string,
  onWriteError: (error: unknown) => void = () => {}
): DialogFolder {
  return {
    async defaultPath() {
      let folder: unknown
      try {
        folder = JSON.parse(await readFile(stateFile(), 'utf-8'))?.folder
      } catch {
        return undefined
      }
      if (typeof folder !== 'string' || folder === '') return undefined
      try {
        return (await stat(folder)).isDirectory() ? folder : undefined
      } catch {
        return undefined
      }
    },

    async remember(filePath) {
      try {
        await mkdir(dirname(stateFile()), { recursive: true })
        await writeFile(stateFile(), JSON.stringify({ folder: dirname(filePath) }), 'utf-8')
      } catch (error) {
        onWriteError(error)
      }
    }
  }
}
