import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { DocumentStat, KladosApi, OpenDialogResult, TitleBarTheme } from './api'

// Custom APIs for renderer
const api: KladosApi = {
  keybindings: {
    // D4 — user keybinding overrides. `read` resolves `null` when no
    // override file exists yet (a fresh install), not an error.
    read: (): Promise<string | null> => ipcRenderer.invoke('keybindings:read'),
    write: (contents: string): Promise<void> => ipcRenderer.invoke('keybindings:write', contents)
  },
  // D6 — the document session's IPC seam. Implemented in `src/main/documents.ts`.
  document: {
    openDialog: (): Promise<OpenDialogResult | null> => ipcRenderer.invoke('document:openDialog'),
    stat: (path: string): Promise<DocumentStat> => ipcRenderer.invoke('document:stat', path),
    mintReadToken: (path: string): Promise<string> =>
      ipcRenderer.invoke('document:mintReadToken', path),
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
    write: (path: string, bytes: ArrayBuffer): Promise<void> =>
      ipcRenderer.invoke('document:write', path, bytes),
    saveAsDialog: (defaultPath: string): Promise<OpenDialogResult | null> =>
      ipcRenderer.invoke('document:saveAsDialog', defaultPath),
    watch: (path: string, key: string): Promise<void> =>
      ipcRenderer.invoke('document:watch', path, key),
    unwatch: (key: string): Promise<void> => ipcRenderer.invoke('document:unwatch', key),
    onExternalChange: (callback: (key: string) => void): (() => void) => {
      const listener = (_event: unknown, key: string): void => callback(key)
      ipcRenderer.on('document:externalChange', listener)
      return () => ipcRenderer.removeListener('document:externalChange', listener)
    }
  },
  // M5d-PLAN.md R1.
  titleBar: {
    platform: process.platform,
    setOverlayColors: (theme: TitleBarTheme): Promise<void> =>
      ipcRenderer.invoke('titleBar:setOverlayColors', theme),
    onFocusChange: (callback: (focused: boolean) => void): (() => void) => {
      const listener = (_event: unknown, focused: boolean): void => callback(focused)
      ipcRenderer.on('titleBar:focusChanged', listener)
      return () => ipcRenderer.removeListener('titleBar:focusChanged', listener)
    },
    onFullscreenChange: (callback: (fullscreen: boolean) => void): (() => void) => {
      const listener = (_event: unknown, fullscreen: boolean): void => callback(fullscreen)
      ipcRenderer.on('titleBar:fullscreenChanged', listener)
      return () => ipcRenderer.removeListener('titleBar:fullscreenChanged', listener)
    }
  },
  // R26 (`R24-tabs.md` §4) — the consolidated quit flow.
  app: {
    onQuitRequested: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('app:quitRequested', listener)
      return () => ipcRenderer.removeListener('app:quitRequested', listener)
    },
    confirmQuit: (): void => ipcRenderer.send('app:confirmQuit'),
    cancelQuit: (): void => ipcRenderer.send('app:cancelQuit')
  },
  // R59 (`R58-zoom.md` §4).
  view: {
    setZoomFactor: (factor: number): Promise<void> =>
      ipcRenderer.invoke('view:setZoomFactor', factor)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
