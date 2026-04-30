/**
 * Probe 0xDD live RGB slot mapping for M68 HE.
 *
 * Dry-run by default:
 *   node scripts/probe-live-slots.js --slot 72
 *
 * Hardware write mode:
 *   node scripts/probe-live-slots.js --run --slot 72
 *   node scripts/probe-live-slots.js --run --start 64 --count 16
 *   node scripts/probe-live-slots.js --run --scan --start 0 --count 128
 *   node scripts/probe-live-slots.js --run --scan --record --start 0 --count 128
 *
 * This sends full 128-slot / 384-byte 0xDD frames with RGB-aligned 54-byte
 * chunks. It is meant to discover whether physical keys are actually scattered
 * across live slots 0-127, which would explain non-solid animation flicker.
 */

const HID = require('node-hid');
const fs = require('node:fs');
const readline = require('node:readline');

const VID = 0x19F5;
const PID = 0xFB2B;
const OUTPUT_MAGIC = 0x55;
const CMD_WRITE_CONFIG = 0x06;
const CMD_WRITE_KEY_COLORS = 0x0B;
const CMD_LIVE_RGB_FRAME = 0xDD;
const CMD_START_FAST = 0x01;
const CMD_END_FAST = 0x02;
const MAX_PACKET_PAYLOAD = 56;
const RGB_ALIGNED_CHUNK_SIZE = 54;
const LIVE_SLOTS = 128;
const LIVE_BYTES = LIVE_SLOTS * 3;
const K68_KEYS = 68;
const RGB_BYTES = K68_KEYS * 3;
const DEFAULT_COLOR_SLOT = 2;
const DEFAULT_OFFSET = 512 * DEFAULT_COLOR_SLOT;

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = {
    run: false,
    scan: false,
    slot: null,
    start: 68,
    count: 16,
    color: [0xFE, 0x00, 0x00],
    recover: true,
    record: false,
    out: 'live-slot-map.json',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run') parsed.run = true;
    else if (arg === '--scan') parsed.scan = true;
    else if (arg === '--slot') parsed.slot = parseNumber(argv[++i]);
    else if (arg === '--start') parsed.start = parseNumber(argv[++i]);
    else if (arg === '--count') parsed.count = parseNumber(argv[++i]);
    else if (arg === '--color') parsed.color = parseColor(argv[++i]);
    else if (arg === '--no-recover') parsed.recover = false;
    else if (arg === '--record') parsed.record = true;
    else if (arg === '--out') parsed.out = argv[++i];
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
  const parts = value.split(',').map((part) => parseNumber(part.trim()));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
    throw new Error('Color must be r,g,b with byte values, e.g. --color 255,0,0');
  }
  return parts.map((part) => Math.min(0xFE, part));
}

function printHelp() {
  console.log(`M68 HE 0xDD live-slot probe

Options:
  --run                 Actually write to hardware. Omit for dry-run.
  --slot N              Light one live slot N (0-127).
  --start N             First live slot for range/scan. Default 68.
  --count N             Number of live slots for range/scan. Default 16.
  --scan                Prompt one live slot at a time across the range.
  --color R,G,B         Probe color. Default 254,0,0.
  --no-recover          Skip custom-mode/blank/end-fast recovery.
  --record              During --scan, save typed key names to JSON + CSV.
  --out FILE            JSON output path for --record. Default live-slot-map.json.

Recommended first checks:
  node scripts/probe-live-slots.js --run --start 68 --count 60
  node scripts/probe-live-slots.js --run --scan --start 68 --count 60
  node scripts/probe-live-slots.js --run --scan --record --start 0 --count 128
`);
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
    for (let i = 0; i < payload.length && i < MAX_PACKET_PAYLOAD; i++) {
      pkt[9 + i] = payload[i];
    }
  }
  pkt[4] = checksum(pkt, 5, 65);
  return pkt;
}

function toHex(buf) {
  return Array.from(buf).map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function listCandidates() {
  const matches = HID.devices().filter((d) => d.vendorId === VID && d.productId === PID);
  console.log(`[HID] Found ${matches.length} candidate interface(s) for VID=0x${VID.toString(16)} PID=0x${PID.toString(16)}`);
  for (const d of matches) {
    console.log(`  interface=${d.interface} usagePage=0x${(d.usagePage || 0).toString(16)} usage=0x${(d.usage || 0).toString(16)} product=${d.product || ''}`);
  }
  return matches;
}

function openKeyboard() {
  const matches = listCandidates();
  const sorted = [
    ...matches.filter((d) => d.interface === 1 && d.usage === 0x0000),
    ...matches.filter((d) => d.interface === 1),
    ...matches.filter((d) => d.usagePage === 0xFF00),
    ...matches.filter((d) => d.interface !== 1),
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
  if (!args.run) {
    console.log(`[TX] ${toHex(pkt)}`);
    return;
  }
  dev.write(Array.from(pkt));
}

function writeLiveFrame(dev, frame, label) {
  for (let pos = 0; pos < LIVE_BYTES;) {
    const size = Math.min(RGB_ALIGNED_CHUNK_SIZE, LIVE_BYTES - pos);
    writePacket(dev, CMD_LIVE_RGB_FRAME, pos, frame.slice(pos, pos + size), `${label} chunk ${pos}`);
    pos += size;
  }
}

function makeFrame(slots, color) {
  const frame = Buffer.alloc(LIVE_BYTES, 0);
  const [r, g, b] = color;
  for (const slot of slots) {
    if (slot < 0 || slot >= LIVE_SLOTS) continue;
    const base = slot * 3;
    frame[base] = r;
    frame[base + 1] = g;
    frame[base + 2] = b;
  }
  return frame;
}

function makeRangeSlots(start, count) {
  const slots = [];
  for (let slot = start; slot < Math.min(LIVE_SLOTS, start + count); slot++) slots.push(slot);
  return slots;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function writeMappingFiles(outputPath, observations) {
  const payload = {
    generatedAt: new Date().toISOString(),
    command: '0xDD',
    slots: LIVE_SLOTS,
    notes: 'Typed observations from scripts/probe-live-slots.js. keyNames may contain multiple keys when more than one key lit.',
    observations,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  const csvPath = outputPath.replace(/\.json$/i, '.csv');
  const csvLines = ['slot,keyNames,rawAnswer'];
  for (const item of observations) {
    csvLines.push([item.slot, csvEscape(item.keyNames.join('|')), csvEscape(item.rawAnswer)].join(','));
  }
  fs.writeFileSync(csvPath, `${csvLines.join('\n')}\n`);
  console.log(`[Record] Wrote ${outputPath}`);
  console.log(`[Record] Wrote ${csvPath}`);
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
    const size = Math.min(MAX_PACKET_PAYLOAD, RGB_BYTES - pos);
    writePacket(dev, CMD_WRITE_KEY_COLORS, DEFAULT_OFFSET + pos, rgb.slice(pos, pos + size), `recovery blank chunk ${pos}`);
    pos += size;
  }
}

function sendFastToggle(dev, enabled) {
  writePacket(dev, enabled ? CMD_START_FAST : CMD_END_FAST, 0, Buffer.alloc(0), enabled ? 'start fast mode' : 'end fast mode');
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

async function main() {
  const rangeSlots = args.slot === null ? makeRangeSlots(args.start, args.count) : [args.slot];
  console.log('[Probe] Settings:', {
    run: args.run,
    scan: args.scan,
    slot: args.slot,
    start: args.start,
    count: args.count,
    color: args.color,
    recover: args.recover,
    record: args.record,
    out: args.out,
  });
  console.log('[Probe] Dry-run is default. Add --run to write to hardware.');

  const dev = args.run ? openKeyboard() : null;
  try {
    if (dev) sendFastToggle(dev, true);
    const observations = [];
    if (args.scan) {
      for (const slot of rangeSlots) {
        writeLiveFrame(dev, makeFrame([slot], args.color), `slot ${slot}`);
        if (args.run) {
          const answer = await ask(`Observe slot ${slot}. Which key lit? Type key name(s), blank if none/random, then Enter... `);
          if (args.record) {
            observations.push({
              slot,
              rawAnswer: answer.trim(),
              keyNames: answer.split(',').map((part) => part.trim()).filter(Boolean),
            });
          }
        }
      }
      if (args.record) writeMappingFiles(args.out, observations);
    } else {
      writeLiveFrame(dev, makeFrame(rangeSlots, args.color), `slots ${rangeSlots[0]}-${rangeSlots[rangeSlots.length - 1]}`);
      if (args.run) await ask('Observe keyboard. Which keys lit? Press Enter to recover... ');
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

main().catch((err) => {
  console.error('[Probe] ERROR:', err.message);
  process.exit(1);
});
