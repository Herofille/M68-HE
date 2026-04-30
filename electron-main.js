/**
 * Electron main process — bundles the HID WebSocket server + browser UI
 * into a single desktop window. One command: npm start
 */
const { app, BrowserWindow, desktopCapturer, session } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');

// ── Free port 8484 if a previous instance is still holding it ──────────────
try {
  const out = execSync('netstat -ano | findstr ":8484"', { encoding: 'utf8' });
  const m = out.match(/LISTENING\s+(\d+)/);
  if (m) {
    execSync(`taskkill /PID ${m[1]} /F 2>nul`);
    console.log(`[Electron] Killed stale process PID ${m[1]} on port 8484`);
  }
} catch { /* port is already free */ }

// ── Start the native HID WebSocket server (port 8484) ─────────────────────
// hid-server.js creates the server immediately on require.
require('./hid-server.js');

let mainWindow = null;

function startViteDev() {
  return new Promise((resolve) => {
    const vite = spawn('npx', ['vite', '--port', '3000', '--strictPort'], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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

async function createWindow() {
  setupDisplayMediaHandler();

  await startViteDev();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    title: 'M68 HE Controller',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL('http://localhost:3000');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
