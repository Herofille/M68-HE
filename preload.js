/**
 * Preload script — exposes an Electron-is-running flag to the renderer.
 * Display media is auto-handled by the main process via setDisplayMediaRequestHandler.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  getAutoLaunch: () => ipcRenderer.invoke('auto-launch:get'),
  setAutoLaunch: (enable) => ipcRenderer.invoke('auto-launch:set', enable),
  onAutoLaunchChanged: (cb) => ipcRenderer.on('auto-launch-changed', (_e, value) => cb(value)),
  hideWindow: () => ipcRenderer.send('window:hide'),
  quitApp: () => ipcRenderer.send('app:quit'),
});
