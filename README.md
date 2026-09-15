# M68 HE — Keyboard RGB Controller & HID Protocol Analyzer

A desktop application for the **M68 HE / K68** Hall-effect keyboard. It combines a
WebHID-based protocol analyzer with a real-time RGB effects engine, music-reactive
lighting, and a screen-mirror mode. The app runs as an Electron desktop window with
a system-tray icon, so RGB streaming keeps running in the background.

> Built around reverse-engineered firmware constants for vendor `0x19F5`
> (WebHID vendor interface `PID 0xFFA1`, native `node-hid` interface `PID 0xFB2B`).

## Features

- **Device Explorer** — connect via WebHID or the native `node-hid` bridge, inspect
  interfaces, and send raw commands.
- **Packet Sniffer** — capture and decode `0x55` output packets with checksums and
  chunked config writes.
- **Command Sender** — build and transmit 64-byte output packets with live checksums.
- **RGB Effects** — generate `[row][col]` RGB buffers and stream them as 204-byte
  physical frames (68 keys × 3 bytes, chunked `56 + 56 + 56 + 36`).
- **Music Reactive** — Web Audio analysis with low-latency smoothing/envelope
  constants targeting sub-100ms perceived sync. Multiple modes including Adaptive
  Frequency, Smart Spectrum, and Screen Mirror.
- **Keyboard Preview** — 5-row logical preview of the 68-key layout mapped to
  physical LED indices `0–67` via `K68_LED_MAP`.
- **System Tray** — minimize to tray, start with Windows, single-instance lock, and
  automatic display-source selection for screen capture (no picker dialog).

## Architecture

```
Browser UI (Vite, port 3000)
   │   WebHID  ──┐
   │             ├──► Keyboard (vendor 0x19F5)
   │   WebSocket ─┘
   ▼
hid-server.js (node-hid + ws, port 8484)
```

The browser talks to the keyboard through either **WebHID** (vendor interface) or a
**native HID WebSocket bridge** (`hid-server.js`) for lower-latency RGB streaming. In
the Electron build, the main process spawns the Vite dev server and embeds the HID
bridge, so a single `npm start` launches everything.

See [`sync-architecture.md`](./sync-architecture.md) for the latency rationale and
regression notes behind the timing-sensitive audio/RGB code.

## Requirements

- **Windows** (the tray, auto-launch, and `start.bat`/`start-silent.vbs` are
  Windows-specific; the web UI itself is cross-platform)
- **Node.js** 18+ (for `node-hid` native builds and Electron)
- A Chromium-based browser for WebHID, **or** run the Electron app
- The M68 HE / K68 keyboard connected via USB

## Installation

### Quick install (Windows)

Double-click **`install.bat`** (or run it from a terminal). It will:

1. Install npm dependencies (including the native `node-hid` build).
2. Run a production Vite build into `dist/`.
3. Print the next steps.

```bat
install.bat
```

### Manual install

```bash
npm install      # installs electron, vite, node-hid, ws, naudiodon
npm run build    # optional: production build into dist/
```

## Usage

### Desktop app (recommended)

```bash
npm start                # launches Electron with the Vite dev server + HID bridge
```

Or use the Windows convenience launchers:

| File | What it does |
|------|--------------|
| `start.bat` | Launches the app silently via `start-silent.vbs` (no console window) |
| `start-silent.vbs` | Runs `electron.exe` hidden, clearing `ELECTRON_RUN_AS_NODE` |

The Electron app:
- Frees port `8484` if a stale HID server is still listening.
- Starts the native HID WebSocket bridge on `ws://localhost:8484`.
- Spawns Vite on `http://localhost:3000` and loads it in the window.
- Minimizes to the tray on close (RGB keeps streaming).
- Can start with Windows (toggle in the tray menu or app settings).

### Web-only (browser + native bridge)

Run the two pieces separately:

```bash
npm run dev    # Vite dev server on http://localhost:3000
npm run hid     # native HID WebSocket server on ws://localhost:8484
```

Then open `http://localhost:3000` in a Chromium browser and select the keyboard via
WebHID, or connect the UI to the native bridge.

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Vite dev server on port 3000 |
| `npm run build` | Vite production build into `dist/` |
| `npm run preview` | Preview the built frontend |
| `npm run hid` | Native HID WebSocket server (`node hid-server.js`) on port 8484 |
| `npm start` / `npm run app` | Launch the Electron desktop app |
| `npm run start:hidden` | Launch Electron hidden (tray only) |

## Project Structure

```
M68 HE/
├── electron-main.js          # Electron main: window, tray, HID bridge, Vite spawn
├── preload.js                # Context-isolated bridge to the renderer
├── hid-server.js             # Native node-hid + ws bridge on port 8484
├── index.html                # Vite HTML entry; tabbed HID/RGB UI
├── vite.config.js            # Vite config (port 3000, http)
├── start.bat / start-silent.vbs  # Windows silent launchers
├── install.bat               # One-click Windows installer
├── src/                      # Browser modules and CSS
│   ├── main.js               # DOM wiring, tabs, diagnostics, RGB controls
│   ├── hid-manager.js        # WebHID connect/disconnect, report send/read
│   ├── hid-ws-client.js       # Browser client for the native HID bridge
│   ├── protocol.js           # 0x55 packets, checksums, K68_LED_MAP, EFFECT_MODES
│   ├── effects-engine.js    # RGB frame generation, KEYBOARD_LAYOUT
│   ├── music-analyzer.js     # Web Audio frequency bands and smoothing
│   ├── screen-analyzer.js    # Screen-mirror capture analysis
│   └── styles.css            # Dark theme UI
├── public/timer-worker.js    # 16ms worker timer for music-reactive mode
└── sync-architecture.md      # Latency rationale and regression notes
```

## Notes

- The timing-sensitive music/RGB code targets sub-100ms perceived latency; do not
  switch back to long smoothing/release constants without re-measuring and updating
  `sync-architecture.md`.

## License

This project is provided as-is for personal use with the M68 HE / K68 keyboard.
