/**
 * Guarded realtime RGB command probe for M68 HE.
 *
 * Dry-run by default:
 *   node scripts/probe-realtime-rgb.js --cmd 0xdd --shape index-rgb
 *
 * Hardware write mode requires explicit --run:
 *   node scripts/probe-realtime-rgb.js --run --cmd 0xdd --shape index-rgb
 *
 * The script sends one low-rate probe, prompts for the visual result, then runs a
 * known 0x06 + 0x0B recovery sequence unless --no-recover is supplied.
 */

const HID = require('node-hid');
const readline = require('node:readline');

const VID = 0x19F5;
const PID = 0xFB2B;
const OUTPUT_MAGIC = 0x55;
const CMD_WRITE_CONFIG = 0x06;
const CMD_WRITE_KEY_COLORS = 0x0B;
const CMD_START_FAST = 0x01;
const CMD_END_FAST = 0x02;
const MAX_CHUNK_SIZE = 56;
const K68_KEYS = 68;
const RGB_BYTES = K68_KEYS * 3;
const FULL_LED_SLOTS = 128;
const DEFAULT_COLOR_SLOT = 2;
const DEFAULT_OFFSET = 512 * DEFAULT_COLOR_SLOT;

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = {
    run: false,
    recover: true,
    fullFrame: false,
    rgbAligned: false,
    slots: K68_KEYS,
    cmd: 0xDD,
    shape: 'index-rgb',
    offset: 0,
    color: [0xFE, 0x00, 0x00],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run') parsed.run = true;
    else if (arg === '--full-frame') parsed.fullFrame = true;
    else if (arg === '--rgb-aligned') parsed.rgbAligned = true;
    else if (arg === '--slots') parsed.slots = parseNumber(argv[++i]);
    else if (arg === '--no-recover') parsed.recover = false;
    else if (arg === '--cmd') parsed.cmd = parseNumber(argv[++i]);
    else if (arg === '--shape') parsed.shape = argv[++i];
    else if (arg === '--offset') parsed.offset = parseNumber(argv[++i]);
    else if (arg === '--color') parsed.color = parseColor(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return parsed;
}

function parseNumber(value) {
  if (!value) throw new Error('Missing numeric argument');
  return Number.parseInt(value, value.toLowerCase().startsWith('0x') ? 16 : 10);
}

function parseColor(value) {
  if (!value) throw new Error('Missing color argument');
  const parts = value.split(',').map(part => parseNumber(part.trim()));
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part) || part < 0 || part > 255)) {
    throw new Error('Color must be r,g,b with byte values, e.g. --color 255,0,0');
  }
  return parts;
}

function printHelp() {
  console.log(`M68 HE guarded realtime RGB probe\n\nOptions:\n  --run                 Actually write to the keyboard. Omit for dry-run.\n  --cmd 0xdd            Command byte to probe. Recommended order: 0xdd, 0x0d, 0x0e, 0xde.\n  --shape NAME          Payload shape: index-rgb, flat-rgb, gradient, audio16, screen-rgb, zeros.\n  --full-frame          Send RGB bytes as chunks instead of one packet.\n  --slots 68|128        Number of RGB slots for --full-frame. Default 68.\n  --rgb-aligned         Use RGB-safe chunks: 54-byte chunks plus remainder.\n  --offset 0x0000       Packet offset. Default 0.\n  --color 255,0,0       Probe color. Default red.\n  --no-recover          Skip known recovery sequence after write.\n`);
}

function checksum(buf, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += buf[i];
  return sum & 0xFF;
}

function buildPacket(cmd, size, offset, payload) {
  const pkt = Buffer.alloc(65, 0);
  pkt[0] = 0x00;
  pkt[1] = OUTPUT_MAGIC;
  pkt[2] = cmd & 0xFF;
  pkt[5] = size & 0xFF;
  pkt[6] = offset & 0xFF;
  pkt[7] = (offset >> 8) & 0xFF;
  if (payload) {
    for (let i = 0; i < payload.length && i < MAX_CHUNK_SIZE; i++) {
      pkt[9 + i] = payload[i];
    }
  }
  pkt[4] = checksum(pkt, 5, 65);
  return pkt;
}

function toHex(buf) {
  return Array.from(buf).map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function makePayload(shape, color) {
  const [r, g, b] = color.map(value => Math.min(0xFE, value));
  if (shape === 'zeros') return Buffer.alloc(56, 0);
  if (shape === 'index-rgb') return Buffer.from([0x00, r, g, b]);
  if (shape === 'screen-rgb') return Buffer.from([r, g, b]);

  if (shape === 'audio16') {
    const payload = Buffer.alloc(48, 0);
    for (let band = 0; band < 16; band++) {
      const amp = band < 4 ? 0x03FF : 0x0000;
      payload[band * 3] = amp & 0xFF;
      payload[band * 3 + 1] = (amp >> 8) & 0xFF;
      payload[band * 3 + 2] = band < 4 ? 0xFE : 0x00;
    }
    return payload;
  }

  if (shape === 'gradient') {
    const payload = Buffer.alloc(56, 0);
    for (let i = 0; i < payload.length; i += 3) {
      payload[i] = Math.min(0xFE, i * 4);
      payload[i + 1] = g;
      payload[i + 2] = b;
    }
    return payload;
  }

  if (shape === 'flat-rgb') {
    const payload = Buffer.alloc(56, 0);
    for (let i = 0; i < payload.length; i += 3) {
      payload[i] = r;
      payload[i + 1] = g;
      payload[i + 2] = b;
    }
    return payload;
  }

  throw new Error(`Unknown payload shape: ${shape}`);
}

function makeFullRgbFrame(shape, color, slots) {
  if (![K68_KEYS, FULL_LED_SLOTS].includes(slots)) {
    throw new Error(`Unsupported slot count ${slots}; use ${K68_KEYS} or ${FULL_LED_SLOTS}`);
  }
  const [r, g, b] = color.map(value => Math.min(0xFE, value));
  const frame = Buffer.alloc(slots * 3, 0);

  for (let key = 0; key < slots; key++) {
    const base = key * 3;
    if (shape === 'zeros') continue;
    if (shape === 'gradient') {
      frame[base] = Math.min(0xFE, key * 4);
      frame[base + 1] = g;
      frame[base + 2] = b;
      continue;
    }
    frame[base] = r;
    frame[base + 1] = g;
    frame[base + 2] = b;
  }

  return frame;
}

function listCandidates() {
  const matches = HID.devices().filter(d => d.vendorId === VID && d.productId === PID);
  console.log(`[HID] Found ${matches.length} candidate interface(s) for VID=0x${VID.toString(16)} PID=0x${PID.toString(16)}`);
  for (const d of matches) {
    console.log(`  interface=${d.interface} usagePage=0x${(d.usagePage || 0).toString(16)} usage=0x${(d.usage || 0).toString(16)} product=${d.product || ''}`);
  }
  return matches;
}

function openKeyboard() {
  const matches = listCandidates();
  const sorted = [
    ...matches.filter(d => d.interface === 1 && d.usage === 0x0000),
    ...matches.filter(d => d.interface === 1),
    ...matches.filter(d => d.usagePage === 0xFF00),
    ...matches.filter(d => d.interface !== 1),
  ];

  for (const info of sorted) {
    try {
      const dev = new HID.HID(info.path);
      console.log(`[HID] Opened interface=${info.interface} usagePage=0x${(info.usagePage || 0).toString(16)}`);
      return dev;
    } catch (err) {
      console.log(`[HID] Failed interface=${info.interface}: ${err.message}`);
    }
  }
  throw new Error('No writable keyboard interface opened');
}

function writePacket(dev, cmd, offset, payload, label) {
  const pkt = buildPacket(cmd, payload.length, offset, payload);
  console.log(`[TX] ${label}: cmd=0x${cmd.toString(16).padStart(2, '0')} offset=0x${offset.toString(16).padStart(4, '0')} size=${payload.length}`);
  console.log(`[TX] ${toHex(pkt)}`);
  if (!args.run) return;
  const started = performance.now();
  dev.write(Array.from(pkt));
  console.log(`[TX] write returned in ${(performance.now() - started).toFixed(2)}ms`);
}

function writeFullFrame(dev, cmd, offset, frame, label, rgbAligned) {
  const maxChunk = rgbAligned ? 54 : MAX_CHUNK_SIZE;
  for (let pos = 0; pos < frame.length;) {
    const size = Math.min(maxChunk, frame.length - pos);
    writePacket(dev, cmd, offset + pos, frame.slice(pos, pos + size), `${label} chunk ${pos}`);
    pos += size;
  }
}

function sendCustomMode(dev) {
  const d = Buffer.alloc(64, 0);
  d[0] = 0x50; d[1] = 0x09; d[2] = 0xAA; d[3] = 0xBB;
  d[4] = 0x01; d[7] = 0x05; d[9] = 100; d[10] = 0x03; d[13] = 0x04;
  d[15] = 0xFF; d[18] = 0x64; d[19] = 0xFF; d[20] = 0x80;
  d[25] = 0x01; d[26] = 0x32; d[27] = 0x02; d[29] = 0x01;
  for (let i = 30; i < 64; i++) d[i] = 0x10;
  writePacket(dev, CMD_WRITE_CONFIG, 0x0080, d.slice(0, 56), 'recovery custom config 1/2');
  writePacket(dev, CMD_WRITE_CONFIG, 0x00B8, d.slice(56, 64), 'recovery custom config 2/2');
}

function sendBlankCustomFrame(dev) {
  const rgb = Buffer.alloc(RGB_BYTES, 0);
  for (let pos = 0; pos < RGB_BYTES;) {
    const size = Math.min(MAX_CHUNK_SIZE, RGB_BYTES - pos);
    writePacket(dev, CMD_WRITE_KEY_COLORS, DEFAULT_OFFSET + pos, rgb.slice(pos, pos + size), `recovery blank chunk ${pos}`);
    pos += size;
  }
}

function sendFastToggle(dev, enabled) {
  writePacket(dev, enabled ? CMD_START_FAST : CMD_END_FAST, 0, Buffer.alloc(0), enabled ? 'start fast mode' : 'end fast mode');
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer);
  }));
}

async function main() {
  const payload = args.fullFrame ? makeFullRgbFrame(args.shape, args.color, args.slots) : makePayload(args.shape, args.color);
  console.log('[Probe] Settings:', {
    run: args.run,
    cmd: `0x${args.cmd.toString(16)}`,
    shape: args.shape,
    fullFrame: args.fullFrame,
    slots: args.slots,
    rgbAligned: args.rgbAligned,
    offset: `0x${args.offset.toString(16)}`,
    color: args.color,
    recover: args.recover,
  });
  console.log('[Probe] Dry-run is default. Add --run to write to hardware.');

  const dev = args.run ? openKeyboard() : null;
  try {
    if (dev) sendFastToggle(dev, true);
    if (args.fullFrame) writeFullFrame(dev, args.cmd, args.offset, payload, 'probe', args.rgbAligned);
    else writePacket(dev, args.cmd, args.offset, payload, 'probe');
    if (args.run) {
      await ask('Observe keyboard. What happened? Press Enter to run recovery... ');
    }
    if (args.recover) {
      sendCustomMode(dev);
      sendBlankCustomFrame(dev);
      sendFastToggle(dev, false);
    }
  } finally {
    if (dev) dev.close();
  }
}

main().catch(err => {
  console.error('[Probe] ERROR:', err.message);
  process.exit(1);
});
