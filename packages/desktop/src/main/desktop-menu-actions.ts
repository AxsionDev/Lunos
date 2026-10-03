import { app, BrowserWindow, dialog, shell } from "electron"
import path from "node:path"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import { createMainWindow, updateTitlebar } from "./windows"

export type DesktopMenuActionHandlers = Partial<{
  checkForUpdates: () => void
  relaunch: () => void
  licenses: () => void
}>

/**
 * XCOD-177: open the licence notices packaged next to the app (resources/ when run from source).
 * The .txt name gives it a default app on Windows and Linux; openPath reports failure as a string.
 */
export async function openLicenses() {
  const name = "THIRD_PARTY_NOTICES.txt"
  const file = app.isPackaged ? path.join(process.resourcesPath, name) : path.join(app.getAppPath(), "resources", name)
  const error = await shell.openPath(file)
  if (error) dialog.showErrorBox("Third-Party Licences", `Could not open ${file}: ${error}`)
}

export function runDesktopMenuAction(
  win: BrowserWindow | null,
  action: DesktopMenuAction,
  handlers: DesktopMenuActionHandlers = {},
) {
  switch (action) {
    case "app.checkForUpdates":
      handlers.checkForUpdates?.()
      return
    case "app.relaunch":
      handlers.relaunch?.()
      return
    case "app.licenses":
      handlers.licenses?.()
      return
    case "window.new":
      createMainWindow()
      return
    case "window.close":
      win?.close()
      return
    case "window.minimize":
      win?.minimize()
      return
    case "window.toggleMaximize":
      if (win?.isMaximized()) {
        win.unmaximize()
        return
      }
      win?.maximize()
      return
    case "view.reload":
      win?.reload()
      return
    case "view.toggleDevTools":
      win?.webContents.toggleDevTools()
      return
    case "view.resetZoom":
      setZoom(win, 1)
      return
    case "view.zoomIn":
      setZoom(win, (win?.webContents.getZoomFactor() ?? 1) + 0.2)
      return
    case "view.zoomOut":
      setZoom(win, (win?.webContents.getZoomFactor() ?? 1) - 0.2)
      return
    case "view.toggleFullscreen":
      win?.setFullScreen(!win.isFullScreen())
      return
    case "edit.undo":
      win?.webContents.undo()
      return
    case "edit.redo":
      win?.webContents.redo()
      return
    case "edit.cut":
      win?.webContents.cut()
      return
    case "edit.copy":
      win?.webContents.copy()
      return
    case "edit.paste":
      win?.webContents.paste()
      return
    case "edit.delete":
      win?.webContents.delete()
      return
    case "edit.selectAll":
      win?.webContents.selectAll()
      return
  }
}

function setZoom(win: BrowserWindow | null, value: number) {
  if (!win) return
  win.webContents.setZoomFactor(Math.min(Math.max(value, 0.2), 10))
  updateTitlebar(win)
}
