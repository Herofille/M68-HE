/**
 * Standalone native HID test.
 * Run: node test-hid.js
 * 
 * Tests if node-hid can write vendor packets to the K68 keyboard
 * without needing the browser/WebHID at all.
 */

const HID = require('node-hid');

const VID = 0x19F5;
const PID = 0xFB2B;
const OUTPUT_MAGIC = 0x55;
const K68_KEYS = 68;
const RGB_BYTES = K68_KEYS * 3; // 204

// ─── Packet building ───

function checksum(buf, start, end) {
  let s = 0;
  for (let i = start; i < end; i++) s += buf[i];
  return s & 0xFF;
}

/**
 * Build a 65-byte node-hid write buffer.
 * Layout: [reportId=0x00] [0x55] [cmd] [0x00] [cksum] [size] [offLo] [offHi] [0x00] [data...]
 * This matches exactly what Chrome WebHID sends (prepend 0x00 report ID).
 */
function buildPacket(cmd, size, offsetLo, offsetHi, payload) {
  const pkt = Buffer.alloc(65, 0);
  pkt[0] = 0x00;         // Report ID
  pkt[1] = OUTPUT_MAGIC; // 0x55
  pkt[2] = cmd;
  pkt[3] = 0x00;         // zero (not checksum here)
  pkt[4] = checksum;     // filled below
  pkt[5] = size;
  pkt[6] = offsetLo;
  pkt[7] = offsetHi;
  pkt[8] = 0x00;
  if (payload) {
    for (let i = 0; i < payload.length && i < 56; i++) pkt[9 + i] = payload[i];
  }
  pkt[4] = checksum(pkt, 5, 65);
  return pkt;
}

function sendPacket(dev, cmd, size, offsetLo, offsetHi, payload) {
  const pkt = buildPacket(cmd, size, offsetLo, offsetHi, payload);
  const t = Date.now();
  dev.write(Array.from(pkt));
  return Date.now() - t;
}

// ─── Commands ───

function cmdCustomMode(dev, brightness = 100) {
  const d = Buffer.alloc(64, 0);
  d[0] = 0x50; d[1] = 0x09; d[2] = 0xAA; d[3] = 0xBB;
  d[4] = 0x01; d[6] = 0x00;
  d[7] = 0x05;          // CUSTOM mode
  d[8] = 0x00;          // effect id = 0 (custom)
  d[9] = brightness;
  d[10] = 0x03;
  d[13] = 0x04;
  d[15] = 0xFF; d[16] = 0x00; d[17] = 0x00;
  d[18] = 0x64;
  d[19] = 0xFF; d[20] = 0x80; d[21] = 0x00;
  d[25] = 0x01; d[26] = 0x32; d[27] = 0x02; d[29] = 0x01;
  for (let i = 30; i < 64; i++) d[i] = 0x10;

  const t1 = sendPacket(dev, 0x06, 56, 0x80, 0x00, d.slice(0, 56));
  const t2 = sendPacket(dev, 0x06, 8,  0xB8, 0x00, d.slice(56, 64));
  return t1 + t2;
}

function cmdSolidColor(dev, r, g, b) {
  const rgb = Buffer.alloc(RGB_BYTES);
  for (let i = 0; i < K68_KEYS; i++) {
    rgb[i * 3]     = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  const base = 512 * 2; // slot 2 = 0x0400
  let total = 0;
  for (let pos = 0; pos < RGB_BYTES; ) {
    const sz = Math.min(56, RGB_BYTES - pos);
    const off = base + pos;
    total += sendPacket(dev, 0x0B, sz, off & 0xFF, (off >> 8) & 0xFF, rgb.slice(pos, pos + sz));
    pos += sz;
  }
  return total;
}

// ─── Main ───

console.log('\n=== K68 Native HID Test ===\n');

const all = HID.devices().filter(d => d.vendorId === VID && d.productId === PID);
if (all.length === 0) {
  console.error('ERROR: Keyboard not found (VID=0x19F5 PID=0xFB2B)');
  process.exit(1);
}

console.log(`Found ${all.length} interfaces:`);
all.forEach(d => console.log(`  interface=${d.interface}  usagePage=0x${(d.usagePage||0).toString(16).padStart(4,'0')}  usage=0x${(d.usage||0).toString(16).padStart(4,'0')}  path=${d.path}`));

// Try every interface
for (const info of all) {
  console.log(`\n--- Testing interface=${info.interface} (usagePage=0x${(info.usagePage||0).toString(16)}) ---`);
  let dev;
  try {
    dev = new HID.HID(info.path);
    console.log('  Opened OK');
  } catch (e) {
    console.log(`  Open failed: ${e.message}`);
    continue;
  }

  try {
    // 1. Set custom mode
    console.log('  Sending CUSTOM mode config...');
    const t1 = cmdCustomMode(dev, 100);
    console.log(`  Config write: ${t1}ms`);

    // Small delay
    const waitMs = 200;
    const start = Date.now();
    while (Date.now() - start < waitMs) {}

    // 2. Solid RED
    console.log('  Sending solid RED...');
    const t2 = cmdSolidColor(dev, 255, 0, 0);
    console.log(`  RGB write (4 chunks): ${t2}ms`);

    console.log('  >>> Is the keyboard RED now? (check in 2 seconds)');
    const wait2 = Date.now();
    while (Date.now() - wait2 < 2000) {}

    // 3. Solid BLUE
    console.log('  Sending solid BLUE...');
    cmdSolidColor(dev, 0, 0, 255);
    const wait3 = Date.now();
    while (Date.now() - wait3 < 2000) {}

    // 4. All OFF
    console.log('  Sending all OFF...');
    cmdSolidColor(dev, 0, 0, 0);
    console.log('  DONE for this interface.\n');
  } catch (e) {
    console.log(`  Write error: ${e.message}`);
  }

  dev.close();
}

console.log('\n=== Test complete. Did any interface change the keyboard colors? ===');
