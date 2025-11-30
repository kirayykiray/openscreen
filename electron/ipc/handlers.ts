import { ipcMain, desktopCapturer, BrowserWindow, shell, app, dialog, screen } from 'electron'

import fs from 'node:fs/promises'
import path from 'node:path'
import { RECORDINGS_DIR } from '../main'

let selectedSource: any = null

export function registerIpcHandlers(
  createEditorWindow: () => void,
  createSourceSelectorWindow: () => BrowserWindow,
  getMainWindow: () => BrowserWindow | null,
  getSourceSelectorWindow: () => BrowserWindow | null,
  onRecordingStateChange?: (recording: boolean, sourceName: string) => void
) {
  ipcMain.handle('get-sources', async (_, opts) => {
    const sources = await desktopCapturer.getSources(opts)
    return sources.map(source => ({
      id: source.id,
      name: source.name,
      display_id: source.display_id,
      thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : null,
      appIcon: source.appIcon ? source.appIcon.toDataURL() : null
    }))
  })

  ipcMain.handle('select-source', (_, source) => {
    selectedSource = source
    const sourceSelectorWin = getSourceSelectorWindow()
    if (sourceSelectorWin) {
      sourceSelectorWin.close()
    }
    return selectedSource
  })

  ipcMain.handle('get-selected-source', () => {
    return selectedSource
  })

  ipcMain.handle('open-source-selector', () => {
    const sourceSelectorWin = getSourceSelectorWindow()
    if (sourceSelectorWin) {
      sourceSelectorWin.focus()
      return
    }
    createSourceSelectorWindow()
  })

  ipcMain.handle('switch-to-editor', () => {
    const mainWin = getMainWindow()
    if (mainWin) {
      mainWin.close()
    }
    createEditorWindow()
  })



  ipcMain.handle('store-recorded-video', async (_, videoData: ArrayBuffer, fileName: string) => {
    try {
      const videoPath = path.join(RECORDINGS_DIR, fileName)
      await fs.writeFile(videoPath, Buffer.from(videoData))
      currentVideoPath = videoPath;
      return {
        success: true,
        path: videoPath,
        message: 'Video stored successfully'
      }
    } catch (error) {
      console.error('Failed to store video:', error)
      return {
        success: false,
        message: 'Failed to store video',
        error: String(error)
      }
    }
  })



  ipcMain.handle('get-recorded-video-path', async () => {
    try {
      const files = await fs.readdir(RECORDINGS_DIR)
      const videoFiles = files.filter(file => file.endsWith('.webm'))
      
      if (videoFiles.length === 0) {
        return { success: false, message: 'No recorded video found' }
      }
      
      const latestVideo = videoFiles.sort().reverse()[0]
      const videoPath = path.join(RECORDINGS_DIR, latestVideo)
      
      return { success: true, path: videoPath }
    } catch (error) {
      console.error('Failed to get video path:', error)
      return { success: false, message: 'Failed to get video path', error: String(error) }
    }
  })

  ipcMain.handle('set-recording-state', (_, recording: boolean) => {
    const source = selectedSource || { name: 'Screen' }
    if (onRecordingStateChange) {
      onRecordingStateChange(recording, source.name)
    }
  })

  ipcMain.handle('open-external-url', async (_, url: string) => {
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch (error) {
      console.error('Failed to open URL:', error)
      return { success: false, error: String(error) }
    }
  })

  // Return base path for assets so renderer can resolve file:// paths in production
  ipcMain.handle('get-asset-base-path', () => {
    try {
      if (app.isPackaged) {
        return path.join(process.resourcesPath, 'assets')
      }
      return path.join(app.getAppPath(), 'public', 'assets')
    } catch (err) {
      console.error('Failed to resolve asset base path:', err)
      return null
    }
  })

  ipcMain.handle('save-exported-video', async (_, videoData: ArrayBuffer, fileName: string) => {
    try {
      const result = await dialog.showSaveDialog({
        title: 'Save Exported Video',
        defaultPath: path.join(app.getPath('downloads'), fileName),
        filters: [
          { name: 'MP4 Video', extensions: ['mp4'] }
        ],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });

      if (result.canceled || !result.filePath) {
        return {
          success: false,
          cancelled: true,
          message: 'Export cancelled'
        };
      }
      await fs.writeFile(result.filePath, Buffer.from(videoData));
      
      return {
        success: true,
        path: result.filePath,
        message: 'Video exported successfully'
      };
    } catch (error) {
      console.error('Failed to save exported video:', error)
      return {
        success: false,
        message: 'Failed to save exported video',
        error: String(error)
      }
    }
  })

  ipcMain.handle('open-video-file-picker', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Video File',
        defaultPath: RECORDINGS_DIR,
        filters: [
          { name: 'Video Files', extensions: ['webm', 'mp4', 'mov', 'avi', 'mkv'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, cancelled: true };
      }

      return {
        success: true,
        path: result.filePaths[0]
      };
    } catch (error) {
      console.error('Failed to open file picker:', error);
      return {
        success: false,
        message: 'Failed to open file picker',
        error: String(error)
      };
    }
  });

  let currentVideoPath: string | null = null;

  ipcMain.handle('set-current-video-path', (_, path: string) => {
    currentVideoPath = path;
    return { success: true };
  });

  ipcMain.handle('get-current-video-path', async () => {
        
    // If we have a current video path, return it (but validate it's a video file)
    if (currentVideoPath && currentVideoPath.endsWith('.webm')) {
            return { success: true, path: currentVideoPath };
    }
    
    // Fallback: return the latest recording
    try {
            const files = await fs.readdir(RECORDINGS_DIR);
            // Only get .webm files, explicitly exclude .meta.json and other files
      const videoFiles = files.filter(file => file.endsWith('.webm') && !file.includes('.meta.'));
            
      if (videoFiles.length === 0) {
                return { success: false, message: 'No recorded video found' };
      }
      
      // Sort by timestamp in filename (recording-TIMESTAMP.webm) - newest first
      const latestVideo = videoFiles.sort().reverse()[0];
      const videoPath = path.join(RECORDINGS_DIR, latestVideo);
      currentVideoPath = videoPath;
      
            return { success: true, path: videoPath };
    } catch (error) {
      console.error('[IPC] Failed to get video path:', error);
      return { success: false, message: 'Failed to get video path', error: String(error) };
    }
  });

  ipcMain.handle('clear-current-video-path', () => {
    currentVideoPath = null;
    return { success: true };
  });

  // Load cursor data for a video file
  ipcMain.handle('get-cursor-data', async (_, videoPath: string) => {
    try {
      // Replace .webm extension with .cursor.json
      const cursorPath = videoPath.replace(/\.(webm|mp4)$/, '.cursor.json');
      
      const exists = await fs.access(cursorPath).then(() => true).catch(() => false);
      if (!exists) {
        return { success: false, message: 'No cursor data found for this video' };
      }
      
      const data = await fs.readFile(cursorPath, 'utf-8');
      const cursorData = JSON.parse(data);
      
      return { success: true, data: cursorData };
    } catch (error) {
      console.error('Failed to load cursor data:', error);
      return { success: false, message: 'Failed to load cursor data', error: String(error) };
    }
  });

  // Get the bounds of the display being recorded (for cursor coordinate mapping)
  ipcMain.handle('get-display-bounds', () => {
    // If we have a selected source with a display_id, get that display's bounds
    if (selectedSource?.display_id) {
      const displays = screen.getAllDisplays();
      const targetDisplay = displays.find(d => String(d.id) === selectedSource.display_id);
      if (targetDisplay) {
        return {
          x: targetDisplay.bounds.x,
          y: targetDisplay.bounds.y,
          width: targetDisplay.bounds.width,
          height: targetDisplay.bounds.height,
          scaleFactor: targetDisplay.scaleFactor
        };
      }
    }
    
    // Fallback: use primary display
    const primaryDisplay = screen.getPrimaryDisplay();
    return {
      x: primaryDisplay.bounds.x,
      y: primaryDisplay.bounds.y,
      width: primaryDisplay.bounds.width,
      height: primaryDisplay.bounds.height,
      scaleFactor: primaryDisplay.scaleFactor
    };
  });

  // Get current cursor position (relative to primary display or selected display)
  ipcMain.handle('get-cursor-position', () => {
    const point = screen.getCursorScreenPoint();
    
    // If we have a selected source with a display_id, get position relative to that display
    if (selectedSource?.display_id) {
      const displays = screen.getAllDisplays();
      const targetDisplay = displays.find(d => String(d.id) === selectedSource.display_id);
      if (targetDisplay) {
        // Return position relative to the display's origin
        return { 
          x: point.x - targetDisplay.bounds.x, 
          y: point.y - targetDisplay.bounds.y 
        };
      }
    }
    
    // Fallback: use primary display bounds
    const primaryDisplay = screen.getPrimaryDisplay();
    return { 
      x: point.x - primaryDisplay.bounds.x, 
      y: point.y - primaryDisplay.bounds.y 
    };
  });

  // Cursor hiding for recording - creates transparent cursor overlay
  let cursorHideWindow: BrowserWindow | null = null;
  
  ipcMain.handle('hide-system-cursor', () => {
    // Create a fullscreen transparent window that hides the cursor
    if (cursorHideWindow) return { success: true };
    
    const displays = screen.getAllDisplays();
    
    // Cover all displays with transparent windows
    const bounds = displays.reduce((acc, display) => {
      const left = Math.min(acc.x, display.bounds.x);
      const top = Math.min(acc.y, display.bounds.y);
      const right = Math.max(acc.x + acc.width, display.bounds.x + display.bounds.width);
      const bottom = Math.max(acc.y + acc.height, display.bounds.y + display.bounds.height);
      return { x: left, y: top, width: right - left, height: bottom - top };
    }, { x: Infinity, y: Infinity, width: 0, height: 0 });
    
    cursorHideWindow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      type: 'toolbar', // Makes it click-through on Windows
      webPreferences: {
        nodeIntegration: false,
      }
    });
    
    // Make window click-through
    cursorHideWindow.setIgnoreMouseEvents(true, { forward: true });
    
    // Load a simple HTML that hides cursor
    cursorHideWindow.loadURL(`data:text/html,
      <html>
        <head>
          <style>
            * { cursor: none !important; }
            html, body { 
              margin: 0; 
              padding: 0; 
              background: transparent;
              overflow: hidden;
            }
          </style>
        </head>
        <body></body>
      </html>
    `);
    
    return { success: true };
  });
  
  ipcMain.handle('show-system-cursor', () => {
    if (cursorHideWindow) {
      cursorHideWindow.close();
      cursorHideWindow = null;
    }
    return { success: true };
  });
}
