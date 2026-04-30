# SRC KNOWLEDGE BASE

## OVERVIEW

Browser source for the M68 HE controller: UI orchestration, WebHID/native-HID transport, packet protocol, RGB effects, and music analysis.

## STRUCTURE

```text
src/
├── main.js             # App controller; DOM events, diagnostics, effects, music, preview
├── protocol.js         # Reverse-engineered HID packet adapter and LED mapping
├── effects-engine.js   # RGB color-buffer generation and palette utilities
├── music-analyzer.js   # Web Audio frequency bands and low-latency smoothing
├── hid-manager.js      # WebHID device/report manager
├── hid-ws-client.js    # Browser client for native hid-server.js bridge
└── styles.css          # Dark analyzer/controller UI styles
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add UI behavior | `main.js` | Existing pattern: grab DOM nodes by ID, attach listeners, log via panel-specific helpers |
| Change packet format | `protocol.js` | Update constants, packet builders, decode logic, and comments together |
| Change physical key mapping | `protocol.js` | `K68_LED_MAP` is authoritative for row/col to LED index conversion |
| Add visual effect | `effects-engine.js` | Implement as `EffectsEngine` method and route through `_computeFrame()` or music helpers |
| Add music-reactive mode | `effects-engine.js` + `music-analyzer.js` + `main.js` | Analyzer emits bands; engine writes color buffer; main handles send cadence |
| Change WebHID connect rules | `hid-manager.js` | Preserve vendor-interface preference and warning behavior |
| Change native transport | `hid-ws-client.js` and root `hid-server.js` | Keep command names and binary frame sizes aligned |
| Change styling | `styles.css` | Use existing CSS variables and tab/card naming style |

## MODULE BOUNDARIES

- `effects-engine.js` never sends HID packets; it only mutates/returns RGB color buffers.
- `protocol.js` owns packet byte layout, checksums, chunking, stream mode, LED mapping, and RGB buffer conversion.
- `hid-manager.js` wraps browser WebHID APIs and emits lightweight events; it should not know effect semantics.
- `hid-ws-client.js` sends JSON control messages and binary RGB buffers only; root `hid-server.js` owns native USB writes.
- `main.js` is intentionally orchestration-heavy. Prefer extracting reusable protocol/effect/audio logic into the other modules instead of growing inline helpers.

## CONVENTIONS

- Exports use named ES module exports; there is no default export pattern in `src/`.
- RGB objects are `{ r, g, b }`; physical frame arrays are `Uint8Array` of 204 bytes.
- Clamp byte values before packet/frame writes; existing code uses `Math.min/Math.max/Math.round` and caps some firmware values at `0xFE`.
- Use `performance.now()` for frame/audio timing; do not mix with `Date.now()` for latency-sensitive loops.
- WebHID frame send cadence is slower (`72ms`) than native HID target cadence (`16ms`); preserve the distinction unless measured on hardware.
- Comments documenting reverse-engineered protocol bytes are part of the implementation contract.

## ANTI-PATTERNS

- Do not bypass `colorBufferToRGBArray()` when mapping logical rows/cols to physical LEDs.
- Do not send all 128 possible LED slots; this keyboard uses 68 physical keys and 204 RGB bytes.
- Do not add unbounded animation/HID queues. Drop stale frames or throttle; latest visual state wins.
- Do not assume WebHID and native HID use the same selected PID/interface.
- Do not weaken low-latency audio constants (`smoothing = 0.1`, attack `0.005`, release `0.05`) without running latency checks.

## TEST/VERIFY TOUCHPOINTS

- Packet changes: inspect `test-hid.js`, `test-sweep.js`, and `test-dd.js`; most require keyboard and visual confirmation.
- Latency changes: run `node test-latency.js` and compare behavior with `sync-architecture.md`.
- Frontend changes: run `npm run build`; Vite is the only configured automated build gate.
