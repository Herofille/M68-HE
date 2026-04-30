/**
 * Protocol Adapter for Step One HE / M68 HE Keyboard
 * Reverse-engineered from hedriver.com WebHID traffic (intercepted output)
 *
 * OUTPUT packet format (host → keyboard): 64 bytes, Report ID 0
 *   Byte 0: 0x55 (output magic)
 *   Byte 1: Command type
 *   Byte 2: 0x00
 *   Byte 3: Checksum = sum(bytes[4..63]) & 0xFF
 *   Byte 4: Chunk data size
 *   Byte 5: Offset low byte
 *   Byte 6: Offset high byte
 *   Byte 7: 0x00
 *   Bytes 8-63: Payload data (56 bytes max)
 *
 * INPUT packet format (keyboard → host): 64 bytes
 *   Byte 0: 0xAA (input magic)
 *   (same structure otherwise)
 *
 * Commands:
 *   0x01 = Start fast model  0x02 = End fast model
 *   0x05 = Read config        0x06 = Write config
 *   0x0B = Write key colors   0xDD = Live RGB frame
 *   0xDE = Read key light (input only!)
 *   0x03 = Read firmware
 */

const OUTPUT_MAGIC = 0x55;
const INPUT_MAGIC = 0xAA;

// HID commands (from hedriver.com website source)
const CMD_START_FAST_MODEL = 0x01;
const CMD_END_FAST_MODEL = 0x02;
const CMD_READ_CONFIG = 0x05;
const CMD_WRITE_CONFIG = 0x06;
const CMD_WRITE_KEY_COLORS = 0x0B; // setKeyColors command
const CMD_LIVE_RGB_FRAME = 0xDD;   // confirmed live RGB buffer at offset 0x0000
const CMD_READ_KEY_LIGHT = 0xDE;  // alias for reads

// K68 has 68 physical keys. The live RGB buffer can expose 128 logical slots,
// but slots 68-127 appear to represent FN/layer/alternate key state, not extra
// physical LEDs. Streaming must only write the base 68-key range to avoid
// overriding layer slots with unrelated colors.
const TOTAL_LED_SLOTS = 128;        // keyboard's full live buffer
const K68_PHYSICAL_KEYS = 68;       // actual keys on K68 (indices 0-67)
const TOTAL_RGB_BYTES = K68_PHYSICAL_KEYS * 3; // 204 bytes for the known logical key map
const LIVE_RGB_BYTES = TOTAL_LED_SLOTS * 3;    // 384 bytes for command 0xDD
const LIVE_BASE_RGB_BYTES = TOTAL_RGB_BYTES;   // write only physical base keys
const MAX_CHUNK_SIZE = 56;          // max payload per packet
const RGB_ALIGNED_CHUNK_SIZE = 54;  // keep chunk boundaries on RGB triplets for 0xDD

/**
 * K68 LED index mapping: [row][col] → LED index in the 128-slot buffer
 * Derived from arrays.txt (hedriver.com K68 key layout, profile 2, layer 0)
 * -1 = no physical key at this grid position (visual spacer)
 *
 * LED indices 0-11:  Row 0 main keys (Esc through -)
 * LED indices 12-23: Row 1 main keys (Tab through [)
 * LED indices 24-35: Row 2 main keys (Caps through ')
 * LED indices 36-47: Row 3 main keys (LShift through RShift)
 * LED indices 48-58: Row 4 + arrows (LCtrl through →)
 * LED indices 59-67: Right cluster / wide-key spillover positions. The physical
 * right column is Insert → Delete → PgUp → PgDn → Right Arrow.
 */
export const K68_LED_MAP = [
  // Row 0: Esc, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, -, =, Bksp, Insert
  [  0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 60, 61, 62 ],
  // Row 1: Tab, Q, W, E, R, T, Y, U, I, O, P, [, ], \, Delete
  [ 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 63, 64, 65 ],
  // Row 2: Caps, A, S, D, F, G, H, J, K, L, ;, ', Enter, (empty), PageUp
  [ 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 66, -1, 67 ],
  // Row 3: Shift, Z, X, C, V, B, N, M, comma, ., /, Shift, (empty), Up, PageDown
  [ 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, -1, 57, 59 ],
  // Row 4: Ctrl, Win, Alt, (space), (space), Space, (space), (space), Alt, Fn, Ctrl, Left, Down, Right, (empty)
  [ 48, 49, 50, -1, -1, 51, -1, -1, 52, 53, 54, 55, 56, 58, -1 ],
];

// Config write: 2 packets at offset 0x0080
const CONFIG_CHUNKS = [
  { offset: 0x0080, size: 0x38 }, // 56 bytes
  { offset: 0x00B8, size: 0x08 }, // 8 bytes
];

// Default config slot for custom colors (from captured hedriver.com traffic: offset 0x0400 = 512*2)
const DEFAULT_COLOR_SLOT = 2;

// Effect mode IDs (from captured data)
export const EFFECT_MODES = {
  OFF: 0x00,
  STATIC: 0x01,
  BREATHING: 0x04,
  CUSTOM: 0x05,       // Per-key custom colors (confirmed from captured 0x06 config write)
  WAVE: 0x06,
  RIPPLE: 0x07,
  RAIN: 0x08,
  REACTIVE: 0x09,
  CUSTOM_ALT: 0x0A,   // Alternative custom mode (may not be used)
  FLOWER: 0x0B,
  STORED: 0x10,
};

/**
 * Compute checksum: sum of bytes[4..63] & 0xFF
 */
function computeChecksum(packet) {
  let sum = 0;
  for (let i = 4; i < 64; i++) {
    sum = (sum + packet[i]) & 0xFF;
  }
  return sum;
}

/**
 * Build a raw output packet with correct header and checksum
 */
export function buildOutputPacket(cmd, chunkSize, offsetLo, offsetHi, data) {
  const packet = new Uint8Array(64);
  packet[0] = OUTPUT_MAGIC;
  packet[1] = cmd;
  packet[2] = 0x00;
  // packet[3] = checksum (filled after data)
  packet[4] = chunkSize;
  packet[5] = offsetLo;
  packet[6] = offsetHi;
  packet[7] = 0x00;

  if (data) {
    for (let i = 0; i < Math.min(data.length, 56); i++) {
      packet[8 + i] = data[i];
    }
  }

  packet[3] = computeChecksum(packet);
  return packet;
}

/**
 * Build packets to write key colors using command 0x0B
 * Matches the website's sendData(0x0B, 512*configSlot, colorData) approach
 * @param {Uint8Array} rgbData - Flat array of R,G,B values for the known 68-key map
 * @param {number} configSlot - Config slot (0 = active, 2 = custom mode storage). Default 0.
 * @returns {Uint8Array[]} Array of storage-write packets
 */
export function buildRGBFrame(rgbData, configSlot = DEFAULT_COLOR_SLOT) {
  // Pad to full 384-byte buffer
  const ledBuffer = new Uint8Array(TOTAL_RGB_BYTES);
  for (let i = 0; i < Math.min(rgbData.length, TOTAL_RGB_BYTES); i++) {
    ledBuffer[i] = rgbData[i];
  }

  const baseOffset = 512 * configSlot;
  const packets = [];

  // Dynamic chunking matching website's sendData approach
  for (let pos = 0; pos < ledBuffer.length; ) {
    const chunkSize = Math.min(MAX_CHUNK_SIZE, ledBuffer.length - pos);
    const offset = baseOffset + pos;
    const data = ledBuffer.slice(pos, pos + chunkSize);
    packets.push(buildOutputPacket(
      CMD_WRITE_KEY_COLORS,
      chunkSize,
      offset & 0xFF,
      (offset >> 8) & 0xFF,
      data
    ));
    pos += chunkSize;
  }

  return packets;
}

/**
 * Build a startFastModel packet (command 0x01)
 * Enables fast LED update mode on the keyboard
 * @returns {Uint8Array} Single 64-byte packet
 */
export function buildStartFastModel() {
  return buildOutputPacket(CMD_START_FAST_MODEL, 0, 0, 0, null);
}

/**
 * Build an endFastModel packet (command 0x02)
 * Disables fast LED update mode
 * @returns {Uint8Array} Single 64-byte packet
 */
export function buildEndFastModel() {
  return buildOutputPacket(CMD_END_FAST_MODEL, 0, 0, 0, null);
}

/**
 * Build config write packets to set RGB effect
 * @param {object} config - Effect configuration
 * @returns {Uint8Array[]} Array of 2 packets
 */
export function buildConfigPacket(config = {}) {
  const {
    effectMode = EFFECT_MODES.FLOWER,
    brightness = 0x64,
    speed = 0x13,
    direction = 0x03,
    primaryColor = [0xFF, 0x80, 0x00],
    secondaryColor = [0xFF, 0x80, 0x00],
    perKeyBrightness = 0x10,
  } = config;

  // Build the 64-byte config data buffer (spans 2 packets)
  const configData = new Uint8Array(64);

  // Sub-command header
  configData[0] = 0x50;   // config type
  configData[1] = 0x09;   // runtime (active) config
  configData[2] = 0xAA;   // magic 1
  configData[3] = 0xBB;   // magic 2
  configData[4] = 0x01;
  configData[5] = 0x00;
  configData[6] = 0x00;

  // Effect parameters
  configData[7] = effectMode;
  configData[8] = speed;
  configData[9] = brightness;
  configData[10] = direction;
  configData[11] = 0x00;
  configData[12] = 0x00;
  configData[13] = 0x04;
  configData[14] = 0x00;

  // Primary color (RGB)
  configData[15] = primaryColor[0];
  configData[16] = primaryColor[1];
  configData[17] = primaryColor[2];

  configData[18] = 0x64;

  // Secondary color (RGB)
  configData[19] = secondaryColor[0];
  configData[20] = secondaryColor[1];
  configData[21] = secondaryColor[2];

  configData[22] = 0x00;
  configData[23] = 0x00;
  configData[24] = 0x00;
  configData[25] = 0x01;
  configData[26] = 0x32;
  configData[27] = 0x02;
  configData[28] = 0x00;
  configData[29] = 0x01;

  // Per-key brightness values (34 keys total: 26 in chunk1 + 8 in chunk2)
  for (let i = 30; i < 64; i++) {
    configData[i] = perKeyBrightness;
  }

  // Split into 2 packets matching CONFIG_CHUNKS
  const pkt1 = buildOutputPacket(
    0x06,
    CONFIG_CHUNKS[0].size,
    CONFIG_CHUNKS[0].offset & 0xFF,
    (CONFIG_CHUNKS[0].offset >> 8) & 0xFF,
    configData.slice(0, 56)
  );

  const pkt2 = buildOutputPacket(
    0x06,
    CONFIG_CHUNKS[1].size,
    CONFIG_CHUNKS[1].offset & 0xFF,
    (CONFIG_CHUNKS[1].offset >> 8) & 0xFF,
    configData.slice(56, 64)
  );

  return [pkt1, pkt2];
}

/**
 * Build a config read request
 * @param {number} offset - Start offset to read from
 * @param {number} size - Number of bytes to read
 * @returns {Uint8Array} Single 64-byte packet
 */
export function buildConfigReadPacket(offset = 0x0000, size = 0x38) {
  return buildOutputPacket(
    0x05,
    size,
    offset & 0xFF,
    (offset >> 8) & 0xFF,
    null
  );
}

/**
 * Build hedriver-style live RGB read requests.
 * Host asks with output magic 0x55 / command 0xDE, then the keyboard replies
 * with input magic 0xAA / command 0xDE. Hedriver reads 384 bytes in regular
 * 56-byte chunks even though live writes use RGB-aligned 54-byte chunks.
 */
export function buildLiveRGBReadPackets() {
  const packets = [];
  for (let offset = 0; offset < LIVE_RGB_BYTES; offset += MAX_CHUNK_SIZE) {
    const size = Math.min(MAX_CHUNK_SIZE, LIVE_RGB_BYTES - offset);
    packets.push(buildOutputPacket(
      CMD_READ_KEY_LIGHT,
      size,
      offset & 0xFF,
      (offset >> 8) & 0xFF,
      null
    ));
  }
  return packets;
}

/**
 * Read the live 128-slot RGB buffer exactly like hedriver.com's getKeyLight().
 * @param {HIDManager} hid
 * @param {{timeoutMs?: number}} options
 * @returns {Promise<Uint8Array>} 384-byte live RGB buffer
 */
export async function readLiveRGBFrame(hid, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180;
  const frame = new Uint8Array(LIVE_RGB_BYTES);
  const requests = buildLiveRGBReadPackets().map(packet => {
    const size = packet[4];
    const offset = packet[5] | (packet[6] << 8);
    return { packet, size, offset };
  });

  const responsePromises = requests.map(({ size, offset }) => {
    const responsePromise = hid.waitForInputReport((entry) => {
      const parsed = parseLiveRGBReadResponse(entry);
      return parsed && parsed.size === size && parsed.offset === offset;
    }, timeoutMs);
    return responsePromise.then(response => ({ response, size, offset }));
  });

  // Hedriver queues all getDeviceData calls then awaits Promise.all. Do the same
  // shape here: install every waiter first, then burst all seven read requests.
  for (const { packet } of requests) {
    await hid.sendOutputReport(0, packet);
  }

  const responses = await Promise.all(responsePromises);
  for (const { response, size, offset } of responses) {
    const parsed = parseLiveRGBReadResponse(response);
    frame.set(parsed.payload.slice(0, size), offset);
  }

  return frame;
}

export function parseLiveRGBChunk(entry, options = {}) {
  const data = entry?.data;
  if (!data) return null;
  const allowOutputEcho = options.allowOutputEcho ?? false;

  const candidates = [0, -1];
  for (const headerOffset of candidates) {
    const commandIndex = headerOffset + 1;
    const sizeIndex = headerOffset + 4;
    const offsetLoIndex = headerOffset + 5;
    const offsetHiIndex = headerOffset + 6;
    const payloadIndex = headerOffset + 8;
    if (commandIndex < 0 || payloadIndex < 0 || data.length <= offsetHiIndex) continue;

    const magic = headerOffset === -1 ? entry.reportId : data[headerOffset];
    const magicOk = headerOffset === -1
      || magic === INPUT_MAGIC
      || magic === 0xAB
      || (allowOutputEcho && magic === OUTPUT_MAGIC);
    const command = data[commandIndex];
    const commandOk = command === CMD_LIVE_RGB_FRAME || command === CMD_READ_KEY_LIGHT;
    if (!magicOk || !commandOk) continue;

    const size = data[sizeIndex];
    const offset = data[offsetLoIndex] | (data[offsetHiIndex] << 8);
    if (size <= 0 || offset < 0 || offset >= LIVE_RGB_BYTES) continue;
    if (data.length < payloadIndex + Math.min(size, data.length - payloadIndex)) continue;

    return {
      command,
      size,
      offset,
      payload: data.slice(payloadIndex, payloadIndex + Math.min(size, LIVE_RGB_BYTES - offset)),
    };
  }

  return null;
}

function parseLiveRGBReadResponse(entry) {
  const parsed = parseLiveRGBChunk(entry, { allowOutputEcho: true });
  if (!parsed || parsed.command !== CMD_READ_KEY_LIGHT) return null;
  return parsed;
}

/**
 * Build a firmware info read request
 * @returns {Uint8Array} Single 64-byte packet
 */
export function buildFirmwareReadPacket() {
  return buildOutputPacket(0x03, 0x20, 0x00, 0x00, null);
}

/**
 * Decode an incoming (input) packet from the keyboard
 * @param {Uint8Array} data - 64-byte raw packet
 * @returns {object} Decoded packet info
 */
export function decodePacket(data) {
  if (data[0] !== INPUT_MAGIC) return { type: 'unknown', raw: data };

  const packetType = data[1];

  if (packetType === 0xDE) {
    const chunkSize = data[4];
    const offsetLo = data[5];
    const offsetHi = data[6];
    const offset = offsetLo | (offsetHi << 8);

    const colors = [];
    for (let i = 8; i < 8 + chunkSize && i + 2 < data.length; i += 3) {
      colors.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
    }

    return {
      type: 'rgb_frame',
      offset,
      chunkSize,
      colors,
      colorCount: colors.length,
    };
  }

  if (packetType === 0x05 || packetType === 0x06) {
    const layer = packetType;
    const hasMagic = data[10] === 0xAA && data[11] === 0xBB;

    if (hasMagic) {
      return {
        type: 'config',
        layer,
        subCmd: data[9],
        effectMode: data[15],
        effectModeName: getEffectName(data[15]),
        speed: data[16],
        brightness: data[17],
        direction: data[18],
        primaryColor: { r: data[23], g: data[24], b: data[25] },
        secondaryColor: { r: data[27], g: data[28], b: data[29] },
      };
    }

    return { type: 'config_continuation', layer };
  }

  if (packetType === 0x03) {
    return { type: 'firmware_info' };
  }

  return { type: 'other', packetType: `0x${packetType.toString(16).padStart(2, '0')}`, raw: data };
}

function getEffectName(mode) {
  const names = {
    0x00: 'Off',
    0x01: 'Static',
    0x02: 'Breathing (slow)',
    0x03: 'Color Cycle',
    0x04: 'Breathing',
    0x05: 'Custom (per-key)',
    0x06: 'Wave',
    0x07: 'Ripple',
    0x08: 'Rain',
    0x09: 'Reactive',
    0x0A: 'Custom Alt',
    0x0B: 'Flower',
    0x10: 'Stored Config',
  };
  return names[mode] || `Unknown (0x${mode.toString(16)})`;
}

// ─── LED Streaming Pipeline ───
// Fast live path: command 0xDD at offset 0x0000. Writes target only the base
// 68 physical-key range (204 bytes); slots 68-127 appear to be FN/layer aliases
// and must not be touched during normal streaming.

const COLOR_QUANT = 1;             // fine granularity for smooth fades
// Time constants in seconds (frame-rate independent exponential decay)
// For sub-100ms sync, these must be extremely low to prevent delay
const ATTACK_TC  = 0.001; // nearly instant attack
const RELEASE_TC = 0.001; // nearly instant release

let _streamCmd = CMD_LIVE_RGB_FRAME;
let _current = null;               // interpolated color state (what's actually on the keyboard)
let _quantized = null;
let _inFlight = 0;
let _initialized = false;
let _lastFrameTime = null;

function quantize(v) {
  return Math.min(0xFE, Math.max(0, Math.round(v / COLOR_QUANT) * COLOR_QUANT));
}

/**
 * Convert a 2D color buffer to flat RGB target array using K68_LED_MAP
 */
export function colorBufferToRGBArray(colorBuffer) {
  const rgbArray = new Uint8Array(TOTAL_RGB_BYTES);

  for (let r = 0; r < colorBuffer.length && r < K68_LED_MAP.length; r++) {
    for (let c = 0; c < colorBuffer[r].length && c < K68_LED_MAP[r].length; c++) {
      const ledIdx = K68_LED_MAP[r][c];
      if (ledIdx < 0 || ledIdx >= K68_PHYSICAL_KEYS) continue;
      const color = colorBuffer[r][c];
      const base = ledIdx * 3;
      rgbArray[base]     = Math.min(0xFE, Math.max(0, Math.round(color.r)));
      rgbArray[base + 1] = Math.min(0xFE, Math.max(0, Math.round(color.g)));
      rgbArray[base + 2] = Math.min(0xFE, Math.max(0, Math.round(color.b)));
    }
  }

  return rgbArray;
}

function expandToLiveRGBFrame(rgbData) {
  const frame = new Uint8Array(LIVE_BASE_RGB_BYTES);
  const knownLength = Math.min(rgbData.length, TOTAL_RGB_BYTES);
  frame.set(rgbData.slice(0, knownLength), 0);
  // Do not pad to the 384-byte live-read size. Offsets beyond 204 appear to be
  // FN/layer/alternate logical slots for the same keyboard, so touching them can
  // light the wrong visible keys.
  return frame;
}

// Precompute chunk boundaries
const _chunks = [];
{
  const len = LIVE_BASE_RGB_BYTES;
  for (let pos = 0; pos < len; ) {
    const sz = Math.min(RGB_ALIGNED_CHUNK_SIZE, len - pos);
    _chunks.push({ pos, sz });
    pos += sz;
  }
}

/**
 * Apply time-based interpolation to an RGB array.
 * Call this before sending via any path (WebHID or native HID).
 * Returns the smoothed, quantized Uint8Array ready to send.
 */
export function interpolateRGB(targetRgb) {
  const len = K68_PHYSICAL_KEYS * 3;
  if (!_current) _current = new Float32Array(len);
  if (!_quantized) _quantized = new Uint8Array(len);

  const now = performance.now();
  const dt = _lastFrameTime ? Math.min((now - _lastFrameTime) / 1000, 0.15) : 1/14;
  _lastFrameTime = now;
  const attackRate  = 1 - Math.exp(-dt / ATTACK_TC);
  const releaseRate = 1 - Math.exp(-dt / RELEASE_TC);

  for (let i = 0; i < len; i++) {
    const target = targetRgb[i] || 0;
    const cur = _current[i];
    const blend = target > cur ? attackRate : releaseRate;
    _current[i] = cur + (target - cur) * blend;
    _quantized[i] = quantize(_current[i]);
  }
  return _quantized;
}

export function sendRGBFrame(hid, targetRgb, configSlot = DEFAULT_COLOR_SLOT) {
  // Skip if previous frame still in flight
  if (_inFlight > 0) return;

  const smoothed = interpolateRGB(targetRgb);
  const useLiveFrame = _streamCmd === CMD_LIVE_RGB_FRAME;
  const frame = useLiveFrame ? expandToLiveRGBFrame(smoothed) : smoothed;
  const chunks = useLiveFrame ? _chunks : buildStorageChunks(frame.length);
  const baseOffset = useLiveFrame ? 0 : 512 * configSlot;

  if (!_initialized) {
    _initialized = true;
    console.log(`[Stream] Init: 0x${_streamCmd.toString(16).toUpperCase()}, offset=0x${baseOffset.toString(16).toUpperCase()}, ${chunks.length} chunks/frame, interpolated`);
  }

  // Queue all chunks with same data (fire-and-forget, USB serializes them)
  for (const { pos, sz } of chunks) {
    const off = baseOffset + pos;
    _inFlight++;
    hid.sendOutputReport(0, buildOutputPacket(
      _streamCmd, sz, off & 0xFF, (off >> 8) & 0xFF,
      frame.slice(pos, pos + sz)
    )).then(() => _inFlight--).catch(() => _inFlight--);
  }
}

function buildStorageChunks(length) {
  const chunks = [];
  for (let pos = 0; pos < length; ) {
    const sz = Math.min(MAX_CHUNK_SIZE, length - pos);
    chunks.push({ pos, sz });
    pos += sz;
  }
  return chunks;
}

/**
 * Switch streaming command (call before starting stream)
 * @param {'direct'|'storage'} mode - 'direct' = experimental 0xDD, 'storage' = stable 0x0B at offset 0x0400
 */
export function setStreamMode(mode) {
  _streamCmd = mode === 'storage' ? CMD_WRITE_KEY_COLORS : CMD_LIVE_RGB_FRAME;
  resetFrameDelta();
  console.log(`[Stream] Switched to ${mode} mode (cmd=0x${_streamCmd.toString(16).toUpperCase()})`);
}

/**
 * Rapidly change Custom mode color + brightness via config write (0x06).
 * Stays in Custom mode (0x05) so the stored per-key colors are shown,
 * but brightness and primary/secondary color can change per frame.
 * Sends both config packets (56+8) to ensure keyboard applies the change.
 */
let _lastPulse = { r: -1, g: -1, b: -1, bright: -1 };

export function sendColorPulse(hid, r, g, b, brightness = 100) {
  if (_inFlight >= 2) return; // allow 2 in-flight (we send 2 packets)

  r = Math.min(0xFE, Math.max(0, Math.round(r)));
  g = Math.min(0xFE, Math.max(0, Math.round(g)));
  b = Math.min(0xFE, Math.max(0, Math.round(b)));
  brightness = Math.min(100, Math.max(0, Math.round(brightness)));
  if (r === _lastPulse.r && g === _lastPulse.g && b === _lastPulse.b && brightness === _lastPulse.bright) return;
  _lastPulse = { r, g, b, bright: brightness };

  // Build full 64-byte config data (same format as buildConfigPacket)
  const configData = new Uint8Array(64);
  configData[0] = 0x50;   // config type
  configData[1] = 0x09;   // runtime config
  configData[2] = 0xAA;   // magic 1
  configData[3] = 0xBB;   // magic 2
  configData[4] = 0x01;
  configData[5] = 0x00;
  configData[6] = 0x00;
  configData[7] = EFFECT_MODES.CUSTOM; // stay in custom mode
  configData[8] = 0x00;   // speed
  configData[9] = brightness;
  configData[10] = 0x03;  // direction
  configData[11] = 0x00;
  configData[12] = 0x00;
  configData[13] = 0x04;
  configData[14] = 0x00;
  configData[15] = r;     // primary color R
  configData[16] = g;     // primary color G
  configData[17] = b;     // primary color B
  configData[18] = 0x64;
  configData[19] = r;     // secondary color R
  configData[20] = g;     // secondary color G
  configData[21] = b;     // secondary color B
  configData[22] = 0x00;
  configData[23] = 0x00;
  configData[24] = 0x00;
  configData[25] = 0x01;
  configData[26] = 0x32;
  configData[27] = 0x02;
  configData[28] = 0x00;
  configData[29] = 0x01;
  for (let i = 30; i < 64; i++) configData[i] = 0x10;

  // Packet 1: 56 bytes at offset 0x0080
  _inFlight++;
  hid.sendOutputReport(0, buildOutputPacket(
    CMD_WRITE_CONFIG,
    CONFIG_CHUNKS[0].size,
    CONFIG_CHUNKS[0].offset & 0xFF,
    (CONFIG_CHUNKS[0].offset >> 8) & 0xFF,
    configData.slice(0, 56)
  )).then(() => _inFlight--).catch(() => _inFlight--);

  // Packet 2: 8 bytes at offset 0x00B8
  _inFlight++;
  hid.sendOutputReport(0, buildOutputPacket(
    CMD_WRITE_CONFIG,
    CONFIG_CHUNKS[1].size,
    CONFIG_CHUNKS[1].offset & 0xFF,
    (CONFIG_CHUNKS[1].offset >> 8) & 0xFF,
    configData.slice(56, 64)
  )).then(() => _inFlight--).catch(() => _inFlight--);
}

/**
 * Write a solid color to all keys via 0x0B (one-time setup).
 * After this, use sendColorPulse to change brightness rapidly.
 */
export async function writeSolidColorSetup(hid, r, g, b) {
  // Set custom mode first
  await sendCustomMode(hid, 100);
  // Write solid color to all keys
  const rgbData = new Uint8Array(TOTAL_RGB_BYTES);
  for (let i = 0; i < K68_PHYSICAL_KEYS; i++) {
    rgbData[i * 3] = Math.min(0xFE, r);
    rgbData[i * 3 + 1] = Math.min(0xFE, g);
    rgbData[i * 3 + 2] = Math.min(0xFE, b);
  }
  // Send all chunks
  const baseOffset = 512 * DEFAULT_COLOR_SLOT;
  for (let pos = 0; pos < TOTAL_RGB_BYTES; ) {
    const sz = Math.min(MAX_CHUNK_SIZE, TOTAL_RGB_BYTES - pos);
    const off = baseOffset + pos;
    await hid.sendOutputReport(0, buildOutputPacket(
      CMD_WRITE_KEY_COLORS, sz, off & 0xFF, (off >> 8) & 0xFF,
      rgbData.slice(pos, pos + sz)
    ));
    pos += sz;
  }
  console.log(`[Setup] Wrote solid color (${r},${g},${b}) to all keys`);
}

/**
 * Reset state
 */
export function resetFrameDelta() {
  _quantized = null;
  _initialized = false;
  _inFlight = 0;
}

/**
 * Enable fast LED update mode (reduces latency for streaming)
 * @param {HIDManager} hid
 */
export async function sendStartFastModel(hid) {
  await hid.sendOutputReport(0, buildStartFastModel());
}

/**
 * Disable fast LED update mode
 * @param {HIDManager} hid
 */
export async function sendEndFastModel(hid) {
  await hid.sendOutputReport(0, buildEndFastModel());
}

/**
 * Switch keyboard to Custom effect mode (per-key RGB control)
 * This must be called before streaming per-key colors with sendRGBFrame
 * @param {HIDManager} hid
 * @param {number} brightness - Brightness 0-100 (default 100)
 */
export async function sendCustomMode(hid, brightness = 100) {
  // Match the captured config write: 50 09 AA BB 01 00 00 05 00 64 03 00 00 04 00 FF 00 00 64 FF 80 00
  await sendEffectConfig(hid, {
    effectMode: EFFECT_MODES.CUSTOM,  // 0x05 = per-key custom
    brightness,
    speed: 0x00,
    direction: 0x03,
    primaryColor: [0xFF, 0x00, 0x00],
    secondaryColor: [0xFF, 0x80, 0x00],
  });
}

/**
 * Send a config command to change effect mode
 * @param {HIDManager} hid - HID manager instance
 * @param {object} config - Effect configuration
 */
export async function sendEffectConfig(hid, config) {
  const packets = buildConfigPacket(config);
  for (const pkt of packets) {
    await hid.sendOutputReport(0, pkt);
  }
}

/**
 * Turn off all LEDs by sending blank RGB frame
 * @param {HIDManager} hid
 */
export async function sendAllOff(hid) {
  const rgbData = new Uint8Array(TOTAL_RGB_BYTES); // all zeros
  await sendRGBFrame(hid, rgbData);
}

/**
 * Set all LED slots to a single color
 * @param {HIDManager} hid
 * @param {number} r
 * @param {number} g
 * @param {number} b
 */
export async function sendSolidColor(hid, r, g, b) {
  const rgbData = new Uint8Array(TOTAL_RGB_BYTES);
  for (let i = 0; i < K68_PHYSICAL_KEYS; i++) {
    rgbData[i * 3] = Math.min(0xFE, r);
    rgbData[i * 3 + 1] = Math.min(0xFE, g);
    rgbData[i * 3 + 2] = Math.min(0xFE, b);
  }
  await sendRGBFrame(hid, rgbData);
}

/**
 * Read the current light config from the keyboard
 * @param {HIDManager} hid
 */
export async function readLightConfig(hid) {
  // Send read requests for light config area (same as hedriver.com connect sequence)
  const pkt1 = buildConfigReadPacket(0x0080, 0x38);
  const pkt2 = buildConfigReadPacket(0x00B8, 0x08);
  await hid.sendOutputReport(0, pkt1);
  await hid.sendOutputReport(0, pkt2);
}
