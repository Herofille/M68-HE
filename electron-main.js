/**
 * Electron main process — bundles the HID WebSocket server + browser UI
 * into a single desktop window. One command: npm start
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, desktopCapturer, session } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

let mainWindow = null;
let tray = null;
let viteProc = null;
let isQuitting = false;
const startHidden = process.argv.includes('--hidden');

// ── Persisted app-level settings (auto-launch preference) ─────────────────
function settingsPath() {
  return path.join(app.getPath('userData'), 'app-settings.json');
}

function readAppSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeAppSettings(patch) {
  const next = { ...readAppSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn('[Electron] Could not persist app settings:', err.message);
  }
  return next;
}

// ── Windows auto-start at login ──────────────────────────────────────────
function applyAutoLaunch(enable) {
  const args = [];
  if (!app.isPackaged) args.push(`"${path.resolve(app.getAppPath())}"`);
  args.push('--hidden');
  app.setLoginItemSettings({
    openAtLogin: enable,
    path: process.execPath,
    args,
  });
  writeAppSettings({ autoLaunch: enable });
}

function isAutoLaunchEnabled() {
  try {
    return app.getLoginItemSettings({ path: process.execPath }).openAtLogin;
  } catch {
    return !!readAppSettings().autoLaunch;
  }
}

// ── Minimal PNG encoder so the tray icon needs no binary asset ───────────
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const seq = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return seq.map((c) => Math.round(c * 255));
}

/** 32x32 RGBA keyboard glyph with a rainbow key row — encoded as PNG in memory. */
function buildTrayIcon() {
  const size = 32;
  const raw = Buffer.alloc(size * (1 + size * 4), 0);
  const put = (x, y, r, g, b, a) => {
    const off = y * (1 + size * 4) + 1 + x * 4;
    raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
  };

  const x0 = 2, x1 = 29, y0 = 7, y1 = 24;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const edge = x === x0 || x === x1 || y === y0 || y === y1;
      const corner = (x <= x0 + 1 || x >= x1 - 1) && (y <= y0 + 1 || y >= y1 - 1);
      if (corner) continue;
      if (edge) {
        const [r, g, b] = hsvToRgb((x - x0) / (x1 - x0), 0.85, 1);
        put(x, y, r, g, b, 255);
      } else {
        put(x, y, 24, 24, 34, 255);
      }
    }
  }
  // Three rows of lit keys
  for (let row = 0; row < 3; row++) {
    const y = y0 + 4 + row * 5;
    for (let k = 0; k < 6; k++) {
      const [r, g, b] = hsvToRgb((k / 6 + row * 0.08) % 1, 0.8, 1);
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          put(x0 + 3 + k * 4 + dx, y + dy, r, g, b, 255);
        }
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return nativeImage.createFromBuffer(png);
}

function freeHidPort() {
  try {
    const out = execSync('netstat -ano | findstr ":8484"', { encoding: 'utf8', windowsHide: true });
    const m = out.match(/LISTENING\s+(\d+)/);
    if (m && Number(m[1]) !== process.pid) {
      execSync(`taskkill /PID ${m[1]} /F 2>nul`, { windowsHide: true });
      console.log(`[Electron] Killed stale process PID ${m[1]} on port 8484`);
    }
  } catch { /* port is already free */ }
}

function startViteDev() {
  return new Promise((resolve) => {
    const vite = spawn('npx', ['vite', '--port', '3000', '--strictPort'], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    viteProc = vite;

    const onReady = () => {
      clearTimeout(timeout);
      resolve();
    };

    vite.stdout.on('data', (data) => {
      if (data.toString().includes('localhost:3000')) onReady();
    });
    vite.stderr.on('data', (data) => {
      if (data.toString().includes('localhost:3000')) onReady();
    });

    const timeout = setTimeout(onReady, 5000);
  });
}

// ── Auto-select display source for getDisplayMedia (no picker dialog) ─────
// When the renderer calls getDisplayMedia(), this handler automatically
// selects the primary screen with loopback audio — zero user interaction.
function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) {
        callback({ video: null, audio: 'loopback' });
        return;
      }
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => {
      callback({ video: null, audio: 'loopback' });
    });
  });
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show M68 HE Controller', click: showWindow },
    { label: 'Hide to tray', click: () => mainWindow && mainWindow.hide() },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: isAutoLaunchEnabled(),
      click: (item) => {
        applyAutoLaunch(item.checked);
        if (mainWindow) mainWindow.webContents.send('auto-launch-changed', item.checked);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function setupTray() {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('M68 HE Controller — RGB running in background');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
    else showWindow();
  });
}

function setupIpc() {
  ipcMain.handle('auto-launch:get', () => isAutoLaunchEnabled());
  ipcMain.handle('auto-launch:set', (_e, enable) => {
    applyAutoLaunch(!!enable);
    if (tray) tray.setContextMenu(buildTrayMenu());
    return isAutoLaunchEnabled();
  });
  ipcMain.on('window:hide', () => mainWindow && mainWindow.hide());
  ipcMain.on('app:quit', () => {
    isQuitting = true;
    app.quit();
  });
}

async function createWindow() {
  setupDisplayMediaHandler();

  await startViteDev();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    title: 'M68 HE Controller',
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL('http://localhost:3000');
  mainWindow.setMenuBarVisibility(false);

  // Closing the window only hides it — RGB streaming keeps running in the tray.
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function main() {
  freeHidPort();
  // hid-server.js creates the WebSocket server (port 8484) immediately on require.
  require('./hid-server.js');

  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    // First launch enables auto-start; afterwards respect the stored preference.
    const stored = readAppSettings();
    if (typeof stored.autoLaunch !== 'boolean') applyAutoLaunch(true);
    else applyAutoLaunch(stored.autoLaunch);

    setupIpc();
    setupTray();
    await createWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (viteProc && viteProc.pid) {
      try {
        execSync(`taskkill /PID ${viteProc.pid} /T /F 2>nul`, { windowsHide: true });
      } catch { /* already gone */ }
    }
  });

  // Keep running in the tray when all windows are closed.
  app.on('window-all-closed', () => {});

  app.on('activate', showWindow);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}
