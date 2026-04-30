/**
 * Native HID Server — bridges WebSocket to node-hid for low-latency USB writes.
 * 
 * WebHID: ~18ms per sendReport (Chrome async overhead)
 * node-hid: ~1-3ms per write (native synchronous)
 * 
 * Usage: node hid-server.js
 * Then connect from the browser via WebSocket on port 8484.
 */

const HID = require('node-hid');
const { WebSocketServer } = require('ws');

// K68 / M68 HE keyboard
const VID = 0x19F5;
const PID = 0xFB2B;
const USAGE_PAGE = 0xFF00; // vendor-specific

// Packet constants
const OUTPUT_MAGIC = 0x55;
const CMD_WRITE_KEY_COLORS = 0x0B;
const CMD_LIVE_RGB_FRAME = 0xDD;
const CMD_WRITE_CONFIG = 0x06;
const CMD_START_FAST = 0x01;
const CMD_END_FAST = 0x02;
const MAX_CHUNK_SIZE = 56;
const RGB_ALIGNED_CHUNK_SIZE = 54;
const K68_PHYSICAL_KEYS = 68;
const TOTAL_RGB_BYTES = K68_PHYSICAL_KEYS * 3;
const TOTAL_LED_SLOTS = 128;
const LIVE_RGB_BYTES = TOTAL_LED_SLOTS * 3;
const LIVE_BASE_RGB_BYTES = TOTAL_RGB_BYTES;
const LIVE_FRAME_INTERVAL_MS = 16;
const LIVE_INTER_CHUNK_GAP_MS = 1;
const DEFAULT_COLOR_SLOT = 2;
const CONFIG_OFFSET = 0x0080;

let device = null;
let writeCount = 0;
let writeTimeTotal = 0;

function findDevice() {
  const devices = HID.devices();
  const matches = devices.filter(d => d.vendorId === VID && d.productId === PID);
  
  if (matches.length === 0) {
    console.log('[HID] No devices found with VID=0x19F5 PID=0xFB2B');
    return null;
  }

  console.log(`[HID] Found ${matches.length} interfaces:`);
  matches.forEach((d) => {
    console.log(`  if=${d.interface}, usagePage=0x${(d.usagePage||0).toString(16)}, usage=0x${(d.usage||0).toString(16)}, path=${d.path}`);
  });

  // Priority order:
  // 1. Vendor-specific usagePage (0xFF00)
  // 2. Interface 1 (often vendor control on this keyboard)
  // 3. Any interface with unusual usage (0x0)
  let pick = matches.find(d => d.usagePage === USAGE_PAGE);
  if (!pick) pick = matches.find(d => d.interface === 1);
  if (!pick) pick = matches.find(d => d.usage === 0x0);
  if (!pick) pick = matches[0]; // fallback to first

  console.log(`[HID] Selected: interface=${pick.interface}, usagePage=0x${(pick.usagePage||0).toString(16)}, usage=0x${(pick.usage||0).toString(16)}`);
  return pick;
}

/** Try to open a device and write a test packet. Returns device if successful. */
function tryOpenDevice(info) {
  try {
    const dev = new HID.HID(info.path);
    console.log(`[HID] Opened interface=${info.interface} OK`);
    return dev;
  } catch (err) {
    console.log(`[HID] Failed to open interface=${info.interface}: ${err.message}`);
    return null;
  }
}

/** Try all interfaces to find one that accepts vendor writes */
function findAndOpenDevice() {
  const devices = HID.devices();
  const matches = devices.filter(d => d.vendorId === VID && d.productId === PID);
  
  if (matches.length === 0) {
    console.log('[HID] No devices found');
    return null;
  }

  // Interface 1 (MI_01, usage=0x0000) is the only one that accepts vendor writes on Windows.
  // Prioritize it; fall back to trying all others.
  const sorted = [
    ...matches.filter(d => d.interface === 1 && d.usage === 0x0000),
    ...matches.filter(d => d.interface === 1),
    ...matches.filter(d => d.interface !== 1),
  ];

  for (const info of sorted) {
    const dev = tryOpenDevice(info);
    if (dev) {
      // Quick write test to confirm this interface accepts vendor packets
      try {
        const testPkt = buildPacket(0x05, 56, 0x80, 0x00, null); // read config (harmless)
        dev.write(Array.from(testPkt));
        console.log(`[HID] Using interface=${info.interface} (usagePage=0x${(info.usagePage||0).toString(16)}) — write test passed`);
        return { device: dev, info };
      } catch (e) {
        console.log(`[HID] Interface=${info.interface} open OK but write failed: ${e.message}`);
        dev.close();
      }
    }
  }
  console.log('[HID] Could not find a writable interface');
  return null;
}

function checksum(data, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += data[i];
  return sum & 0xFF;
}

function buildPacket(cmd, size, offsetLo, offsetHi, payload) {
  const pkt = Buffer.alloc(65); // 1 byte report ID + 64 bytes data
  pkt[0] = 0x00;          // Report ID
  pkt[1] = OUTPUT_MAGIC;  // 0x55
  pkt[2] = cmd;
  pkt[3] = 0x00;          // checksum placeholder
  // bytes 4..7: size, offset_lo, offset_hi, 0x00
  pkt[5] = size;
  pkt[6] = offsetLo;
  pkt[7] = offsetHi;
  pkt[8] = 0x00;
  // payload at bytes 9..64
  if (payload) {
    for (let i = 0; i < payload.length && i < 56; i++) {
      pkt[9 + i] = payload[i];
    }
  }
  // Checksum: sum of bytes[4..63] (which is pkt[5..64])
  pkt[4] = checksum(pkt, 5, 65);
  return pkt;
}

function writePacket(cmd, size, offsetLo, offsetHi, payload) {
  if (!device) return false;
  const pkt = buildPacket(cmd, size, offsetLo, offsetHi, payload);
  const start = performance.now();
  try {
    device.write(pkt);
    const elapsed = performance.now() - start;
    writeCount++;
    writeTimeTotal += elapsed;
    return true;
  } catch (err) {
    console.error('[HID] Write error:', err.message);
    return false;
  }
}

function sendRGBFrame(rgbData) {
  const liveFrame = expandToLiveRGBFrame(rgbData);
  let ok = true;
  for (let pos = 0; pos < LIVE_BASE_RGB_BYTES; ) {
    const sz = Math.min(RGB_ALIGNED_CHUNK_SIZE, LIVE_BASE_RGB_BYTES - pos);
    const payload = liveFrame.slice(pos, pos + sz);
    if (!writePacket(CMD_LIVE_RGB_FRAME, sz, pos & 0xFF, (pos >> 8) & 0xFF, payload)) {
      ok = false;
      break;
    }
    pos += sz;
  }
  return ok;
}

function expandToLiveRGBFrame(rgbData) {
  if (rgbData.length >= LIVE_BASE_RGB_BYTES) return rgbData.slice(0, LIVE_BASE_RGB_BYTES);

  const frame = Buffer.alloc(LIVE_BASE_RGB_BYTES, 0);
  const knownLength = Math.min(rgbData.length, TOTAL_RGB_BYTES);
  for (let i = 0; i < knownLength; i++) {
    frame[i] = Math.min(0xFE, rgbData[i]);
  }
  // Do not pad/write the 384-byte live-read buffer. Slots above 67 appear to be
  // FN/layer logical aliases for the same physical keys, so writing them can
  // override visible base keys with wrong colors.
  return frame;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeLiveFrameSerialized(liveFrame) {
  // 0xDD applies chunks live, so avoid back-to-back frame overlap. The capture
  // showed tearing concentrated in the final chunk (offset 162), so each frame
  // is committed as one ordered chain: 0, 54, 108, 162.
  for (let pos = 0; pos < LIVE_BASE_RGB_BYTES; ) {
    const sz = Math.min(RGB_ALIGNED_CHUNK_SIZE, LIVE_BASE_RGB_BYTES - pos);
    writePacket(CMD_LIVE_RGB_FRAME, sz, pos & 0xFF, (pos >> 8) & 0xFF, liveFrame.slice(pos, pos + sz));
    pos += sz;
    if (pos < LIVE_BASE_RGB_BYTES && LIVE_INTER_CHUNK_GAP_MS > 0) {
      await wait(LIVE_INTER_CHUNK_GAP_MS);
    }
  }
}

// Latest-frame pipeline: only ONE write chain runs at a time.
// Incoming frames overwrite _latestFrame; stale frames are dropped, never queued.
let _frameBusy = false;
let _latestFrame = null;

async function _processLatestFrame() {
  if (_frameBusy || !_latestFrame) return;
  _frameBusy = true;
  const startedAt = performance.now();
  const frame = _latestFrame;
  _latestFrame = null;

  const liveFrame = expandToLiveRGBFrame(frame);
  // Fast 0xDD path. Only write the base 68 physical keys; do not touch the
  // high live/FN-layer slots that alias visible keys.
  await writeLiveFrameSerialized(liveFrame);

  _frameBusy = false;
  // Yield AFTER the full frame is committed. Preserve the 16ms target cadence,
  // but never start a new frame while the previous chunk chain is in flight.
  const elapsed = performance.now() - startedAt;
  const delay = Math.max(0, LIVE_FRAME_INTERVAL_MS - elapsed);
  setTimeout(_processLatestFrame, delay);
}

function enqueueRGBFrame(rgbData) {
  _latestFrame = rgbData; // always overwrite — only latest matters
  _processLatestFrame();
}

// Partial-frame pipeline: same latest-only logic but only writes the chunks flagged in chunkMask.
let _partialBusy = false;
let _latestPartial = null;

function _processLatestPartial() {
  if (_partialBusy || !_latestPartial) return;
  _partialBusy = true;
  const { frame, mask } = _latestPartial;
  _latestPartial = null;

  const baseOffset = 512 * DEFAULT_COLOR_SLOT;
  const CHUNKS = [
    { start:   0, size: 56 },
    { start:  56, size: 56 },
    { start: 112, size: 56 },
    { start: 168, size: 36 },
  ];

  for (let i = 0; i < CHUNKS.length; i++) {
    if (!(mask & (1 << i))) continue; // skip chunks not in mask
    const { start, size } = CHUNKS[i];
    const off = baseOffset + start;
    writePacket(CMD_WRITE_KEY_COLORS, size, off & 0xFF, (off >> 8) & 0xFF, frame.slice(start, start + size));
  }

  _partialBusy = false;
  setImmediate(_processLatestPartial);
}

function enqueuePartialFrame(rgbData, chunkMask) {
  // Partial 0x0B masks are for the old storage path. Fast runtime mode uses a
  // latest-only complete 0xDD base-key frame.
  enqueueRGBFrame(rgbData);
}

function sendCustomMode(brightness = 100) {
  // Config packet 1 (56 bytes at offset 0x0080)
  const d = Buffer.alloc(64);
  d[0] = 0x50; d[1] = 0x09; d[2] = 0xAA; d[3] = 0xBB;
  d[4] = 0x01; d[5] = 0x00; d[6] = 0x00;
  d[7] = 0x05; // CUSTOM mode
  d[8] = 0x00; // speed
  d[9] = brightness;
  d[10] = 0x03; d[11] = 0x00; d[12] = 0x00;
  d[13] = 0x04; d[14] = 0x00;
  d[15] = 0xFF; d[16] = 0x00; d[17] = 0x00; // primary color
  d[18] = 0x64;
  d[19] = 0xFF; d[20] = 0x80; d[21] = 0x00; // secondary color
  d[22] = 0x00; d[23] = 0x00; d[24] = 0x00;
  d[25] = 0x01; d[26] = 0x32; d[27] = 0x02;
  d[28] = 0x00; d[29] = 0x01;
  for (let i = 30; i < 64; i++) d[i] = 0x10;

  writePacket(CMD_WRITE_CONFIG, 56, 0x80, 0x00, d.slice(0, 56));
  writePacket(CMD_WRITE_CONFIG, 8, 0xB8, 0x00, d.slice(56, 64));
}

function sendStartFast() {
  writePacket(CMD_START_FAST, 0, 0, 0, null);
}

function sendEndFast() {
  writePacket(CMD_END_FAST, 0, 0, 0, null);
}

// ─── WebSocket Server ───
const PORT = 8484;
const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  
  ws.on('message', (data) => {
    try {
      // 205-byte message = partial frame: byte 0 is chunk bitmask, bytes 1-204 are RGB
      if (data instanceof Buffer && data.length === TOTAL_RGB_BYTES + 1) {
        enqueuePartialFrame(data.slice(1), data[0]);
        return;
      }
      // Binary message = raw RGB frame (204-byte mapped frame or 384-byte live frame)
      if (data instanceof Buffer && data.length >= TOTAL_RGB_BYTES) {
        enqueueRGBFrame(data);
        return;
      }
      
      // Text message = JSON command
      const msg = JSON.parse(data.toString());
      
      switch (msg.cmd) {
        case 'connect': {
          const result = findAndOpenDevice();
          if (!result) {
            ws.send(JSON.stringify({ type: 'error', msg: 'Keyboard not found or could not open any interface' }));
            return;
          }
          device = result.device;
          console.log(`[HID] Opened: ${result.info.product || 'M68 HE'} (interface=${result.info.interface})`);
          ws.send(JSON.stringify({ type: 'connected', product: result.info.product || 'M68 HE' }));
          break;
        }
        
        case 'disconnect':
          if (device) {
            sendEndFast();
            device.close();
            device = null;
          }
          ws.send(JSON.stringify({ type: 'disconnected' }));
          break;
        
        case 'init':
          // Set custom mode + fast model for low-latency 0xDD base-key writes.
          sendCustomMode(msg.brightness || 100);
          sendStartFast();
          ws.send(JSON.stringify({ type: 'ready' }));
          break;
        
        case 'rgb':
          // RGB data as array
          if (msg.data && msg.data.length >= TOTAL_RGB_BYTES) {
            sendRGBFrame(Buffer.from(msg.data));
          }
          break;
        
        case 'stats': {
          const avg = writeCount > 0 ? (writeTimeTotal / writeCount).toFixed(2) : 0;
          ws.send(JSON.stringify({ 
            type: 'stats', 
            avgWriteMs: parseFloat(avg),
            totalWrites: writeCount 
          }));
          writeCount = 0;
          writeTimeTotal = 0;
          break;
        }

        case 'effect': {
          // Send a config write for any effect mode
          const d = Buffer.alloc(64);
          d[0] = 0x50; d[1] = 0x09; d[2] = 0xAA; d[3] = 0xBB;
          d[4] = 0x01; d[5] = 0x00; d[6] = 0x00;
          d[7] = msg.mode || 0x05;
          d[8] = msg.speed || 0x32;
          d[9] = msg.brightness || 100;
          d[10] = msg.direction || 0x03;
          d[11] = 0x00; d[12] = 0x00;
          d[13] = 0x04; d[14] = 0x00;
          const pc = msg.color1 || [255, 0, 0];
          const sc = msg.color2 || [0, 0, 255];
          d[15] = pc[0]; d[16] = pc[1]; d[17] = pc[2];
          d[18] = 0x64;
          d[19] = sc[0]; d[20] = sc[1]; d[21] = sc[2];
          d[22] = 0x00; d[23] = 0x00; d[24] = 0x00;
          d[25] = 0x01; d[26] = 0x32; d[27] = 0x02;
          d[28] = 0x00; d[29] = 0x01;
          for (let i = 30; i < 64; i++) d[i] = 0x10;
          writePacket(CMD_WRITE_CONFIG, 56, 0x80, 0x00, d.slice(0, 56));
          writePacket(CMD_WRITE_CONFIG, 8, 0xB8, 0x00, d.slice(56, 64));
          ws.send(JSON.stringify({ type: 'effect_set', mode: msg.mode }));
          break;
        }
      }
    } catch (err) {
      console.error('[WS] Error:', err.message);
    }
  });
  
  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

console.log(`[HID Server] Listening on ws://localhost:${PORT}`);
console.log('[HID Server] Searching for keyboard...');
const startResult = findAndOpenDevice();
if (startResult) {
  device = startResult.device;
  console.log(`[HID Server] Auto-connected to interface=${startResult.info.interface}. Ready for WebSocket clients.`);
} else {
  console.log('[HID Server] Could not auto-connect. Will retry when browser connects.');
}

// Print timing stats every 5 seconds
setInterval(() => {
  if (writeCount > 0) {
    const avg = (writeTimeTotal / writeCount).toFixed(2);
    console.log(`[HID Stats] ${writeCount} writes, avg=${avg}ms/write`);
    writeCount = 0;
    writeTimeTotal = 0;
  }
}, 5000);
