import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHudOverlayWindow, createEditorWindow, createSourceSelectorWindow } from './windows'
import { registerIpcHandlers } from './ipc/handlers'


const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const RECORDINGS_DIR = path.join(app.getPath('userData'), 'recordings')


async function ensureRecordingsDir() {
  try {
    await fs.mkdir(RECORDINGS_DIR, { recursive: true })
      let icon = nativeImage.createFromPath(iconPath);
  icon = icon.resize({ width: 24, height: 24, quality: 'best' });
  tray = new Tray(icon);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const menuTemplate = [
    {
      label: 'Stop Recording',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('stop-recording-from-tray');
        }
      }
    }
  ];
  const contextMenu = Menu.buildFromTemplate(menuTemplate);
  tray.setContextMenu(contextMenu);
  tray.setToolTip(`Recording: ${selectedSourceName}`);
}

function createEditorWindowWrapper() {
  if (mainWindow) {
    mainWindow.close()
    mainWindow = null
  }
  mainWindow = createEditorWindow()
}

function createSourceSelectorWindowWrapper() {
  sourceSelectorWindow = createSourceSelectorWindow()
  sourceSelectorWindow.on('closed', () => {
    sourceSelectorWindow = null
  })
  return sourceSelectorWindow
}

// On macOS, applications and their menu bar stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // On Windows/Linux, quit when all windows are closed
  if (process.platform !== 'darwin') {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    app.quit();
  }
})

app.on('before-quit', () => {
  // Clean up tray on quit
  if (tray) {
    tray.destroy();
    tray = null;
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})



// Register all IPC handlers when app is ready
app.whenReady().then(async () => {
  // Ensure recordings directory exists
  await ensureRecordingsDir()

  registerIpcHandlers(
    createEditorWindowWrapper,
    createSourceSelectorWindowWrapper,
    () => mainWindow,
    () => sourceSelectorWindow,
    (recording: boolean, sourceName: string) => {
      selectedSourceName = sourceName
      if (recording) {
        if (!tray) createTray();
        updateTrayMenu();
        if (mainWindow) mainWindow.minimize();
      } else {
        if (tray) {
          tray.destroy();
          tray = null;
        }
        if (mainWindow) mainWindow.restore();
      }
    }
  )
  createWindow()
})
