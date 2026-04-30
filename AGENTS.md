# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-28
**Commit:** N/A (workspace is not a git repository)
**Branch:** N/A

## OVERVIEW

M68 HE / K68 keyboard RGB controller and HID protocol analyzer. Vanilla JavaScript + Vite frontend talks to the keyboard through WebHID, with an optional native `node-hid` WebSocket bridge for lower-latency RGB streaming.

## STRUCTURE

```text
M68 HE/
├── index.html                         # Vite HTML entry; tabbed HID/RGB UI
├── hid-server.js                      # Native node-hid + ws bridge on port 8484
├── src/                               # Source of truth for browser modules and CSS
├── public/timer-worker.js             # 16ms worker timer used by music-reactive mode
├── test-*.js                          # Manual hardware/regression probes
├── saveweb2zip-com-www-hedriver-com/  # Mirrored hedriver.com reference; do not treat as app source
├── sync-architecture.md               # Latency rationale and regression notes
└── start.bat                          # Windows launcher for HID server + Vite dev server
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Browser entry/UI orchestration | `src/main.js` | DOM wiring, tabs, diagnostics, RGB controls, native/WebHID mode switching |
| WebHID device selection | `src/hid-manager.js` | Prefers vendor interface `PID 0xFFA1`, warns on keyboard interface `PID 0xFB2B` |
| Native HID bridge | `hid-server.js` | Uses `node-hid` + `ws`; WebSocket default `ws://localhost:8484` |
| Protocol packets | `src/protocol.js` | `0x55` output magic, checksum, chunks, config writes, K68 LED map |
| RGB frame generation | `src/effects-engine.js` | Effects and music-reactive color buffers, independent of HID transport |
| Audio analysis | `src/music-analyzer.js` | Web Audio `latencyHint: 'interactive'`, low smoothing/envelope constants |
| Native HID client | `src/hid-ws-client.js` | Browser-side client for `hid-server.js` commands and binary RGB frames |
| Styling | `src/styles.css` | Dark UI, CSS custom properties, tab/panel/card layout |
| External reference | `saveweb2zip-com-www-hedriver-com/` | Archived hedriver.com build; use for reverse-engineering only |
| Architecture rationale | `sync-architecture.md` | Explains sub-100ms audio/RGB sync target and latency fixes |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `HIDManager` | class | `src/hid-manager.js` | WebHID connect/disconnect, report send/read, capture events |
| `HIDWebSocketClient` | class | `src/hid-ws-client.js` | Native HID server connection and RGB frame transport |
| `MusicAnalyzer` | class | `src/music-analyzer.js` | Microphone/system/file audio frequency bands and smoothing |
| `EffectsEngine` | class | `src/effects-engine.js` | Generates `[row][col]` RGB buffers for visual effects |
| `KEYBOARD_LAYOUT` | const | `src/effects-engine.js` | 5-row logical preview layout for 68-key keyboard |
| `K68_LED_MAP` | const | `src/protocol.js` | Maps logical rows/cols to physical LED indices 0-67 |
| `EFFECT_MODES` | const | `src/protocol.js` | Reverse-engineered firmware effect IDs |
| `buildOutputPacket` | function | `src/protocol.js` | Builds 64-byte WebHID output packets with checksum |
| `colorBufferToRGBArray` | function | `src/protocol.js` | Converts effect buffers to 204-byte physical RGB frames |
| `sendRGBFrame` | function | `src/protocol.js` | WebHID streaming path with in-flight throttling |

## CONVENTIONS

- JavaScript only: ES modules in `src/`; CommonJS in root-level Node scripts (`hid-server.js`, `test-*.js`).
- No ESLint, Prettier, TypeScript, or formal test runner is configured.
- Vite dev server runs on port `3000` with `https: false`.
- WebSocket HID bridge runs on port `8484`; browser code assumes `ws://localhost:8484`.
- Keyboard identifiers are reverse-engineered constants: vendor `0x19F5`, WebHID vendor interface `PID 0xFFA1`, native/node-hid interface `PID 0xFB2B`.
- RGB frames are 68 physical keys x 3 bytes = `204` bytes, chunked as `56 + 56 + 56 + 36`.
- Timing-sensitive music/RGB code targets sub-100ms perceived latency; preserve low smoothing constants unless re-measured.

## ANTI-PATTERNS (THIS PROJECT)

- Do not edit `node_modules/` or treat dependency TODO/FIXME comments as project rules.
- Do not treat `saveweb2zip-com-www-hedriver-com/` as source of truth; it is a mirrored external reference snapshot.
- Do not add queued frame backlogs in HID streaming. Existing native paths overwrite stale frames and keep only the latest frame.
- Do not switch reactive RGB back to long smoothing/release constants without updating `sync-architecture.md` and latency validation.
- Do not assume all selected WebHID devices can write RGB; the keyboard interface may expose no output reports.

## UNIQUE STYLES

- UI is a single-page tabbed analyzer/controller: Device Explorer, Packet Sniffer, Command Sender, RGB Effects, Music Reactive, Keyboard Preview.
- CSS uses dark theme variables (`--bg-*`, `--text-*`, `--accent`) and compact cards/toolbars.
- Protocol comments intentionally document reverse-engineered byte offsets and command IDs; keep these comments close to packet-building logic.
- Manual tests favor console output and real keyboard observation over assertions.

## COMMANDS

```bash
npm run dev      # Vite dev server on http://localhost:3000
npm run build    # Vite production build
npm run preview  # Preview built frontend
npm run hid      # Native HID WebSocket server: node hid-server.js
node test-latency.js  # Latency regression; simulates if keyboard unavailable
node test-hid.js      # Native HID interface probe; requires keyboard
node test-sweep.js    # Manual command/offset sweeper; requires keyboard and visual checks
node test-dd.js       # 0xDD payload probe; requires keyboard
```

## NOTES

- `start.bat` is the Windows convenience path for running both the HID bridge and Vite during manual testing.
- `public/timer-worker.js` is static public content, not bundled through `src/`; keep worker URL assumptions in sync with `src/main.js`.
- `arrays.txt` and `fze.txt` are large reverse-engineering artifacts at root; read selectively before changing LED mapping or protocol constants.
- `test-latency.js` currently describes storage write mode `0x0B`; compare with `sync-architecture.md` before using it as proof of direct LED mode behavior.
