/**
 * Preload script — exposes an Electron-is-running flag to the renderer.
 * Display media is auto-handled by the main process via setDisplayMediaRequestHandler.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
});
