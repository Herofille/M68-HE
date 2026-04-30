/**
 * Test script for investigating the 0xDD command payload structure.
 * Run: node test-dd.js
 * 
 * 0xDD produced "random colors" when we sent a solid block of blue [0, 0, 255].
 * This suggests the payload format is NOT a simple flat [R, G, B, R, G, B] array.
 * It might be packed (e.g., RGB565), or structured differently (e.g., [Index, R, G, B]).
 */

const HID = require('node-hid');

const VID = 0x19F5;
const PID = 0xFB2B;
const OUTPUT_MAGIC = 0x55;
const K68_KEYS = 68;

function checksum(buf, start, end) {
  let s = 0;
  for (let i = start; i < end; i++) s += buf[i];
  return s & 0xFF;
}

function buildPacket(cmd, size, offsetLo, offsetHi, payload) {
  const pkt = Buffer.alloc(65, 0);
  pkt[0] = 0x00;
  pkt[1] = OUTPUT_MAGIC;
  pkt[2] = cmd;
  pkt[3] = 0x00;
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

function findDevice() {
  const all = HID.devices().filter(d => d.vendorId === VID && d.productId === PID);
  let pick = all.find(d => d.interface === 1 && d.usage === 0x0000) || all.find(d => d.interface === 1) || all[0];
  if (!pick) return null;
  try {
    return new HID.HID(pick.path);
  } catch (e) {
    return null;
  }
}

async function runTest() {
  console.log('\n=== Investigating 0xDD Command Format ===');
  
  const dev = findDevice();
  if (!dev) {
    console.error('ERROR: Keyboard not found.');
    process.exit(1);
  }

  // Helper to send a single packet
  const sendRaw = (cmd, payload, off = 0) => {
    const pkt = buildPacket(cmd, payload.length, off & 0xFF, (off >> 8) & 0xFF, payload);
    dev.write(Array.from(pkt));
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Ensure custom mode
  console.log('[Init] Setting custom mode...');
  const d = Buffer.alloc(64, 0);
  d[0] = 0x50; d[1] = 0x09; d[2] = 0xAA; d[3] = 0xBB;
  d[4] = 0x01; d[7] = 0x05; d[9] = 100; d[10] = 0x03; d[13] = 0x04;
  d[15] = 0xFF; d[18] = 0x64; d[19] = 0xFF; d[20] = 0x80; d[25] = 0x01; d[26] = 0x32; d[27] = 0x02; d[29] = 0x01;
  for (let i = 30; i < 64; i++) d[i] = 0x10;
  sendRaw(0x06, d.slice(0, 56), 0x80);
  sendRaw(0x06, d.slice(56, 64), 0xB8);
  await sleep(500);

  // Clear using known good 0x0B
  console.log('[Init] Clearing to black using 0x0B...');
  const black = Buffer.alloc(204, 0);
  for(let pos = 0; pos < 204; pos+=56) sendRaw(0x0B, black.slice(pos, pos+56), 0x0400 + pos);
  await sleep(1000);

  // -------------------------------------------------------------------------
  // Hypothesis 1: 0xDD expects [Index, R, G, B] packets (Addressable mode)
  // Let's try sending 1 key: Index 0, Red 255, Green 0, Blue 0
  // -------------------------------------------------------------------------
  console.log('\n[Test 1] Trying [Index, R, G, B] format (Lighting Key 0 to Red)...');
  const payload1 = Buffer.from([0x00, 0xFF, 0x00, 0x00]); 
  sendRaw(0xDD, payload1, 0x0000);
  await sleep(3000);

  // Clear
  for(let pos = 0; pos < 204; pos+=56) sendRaw(0x0B, black.slice(pos, pos+56), 0x0400 + pos);
  await sleep(500);

  // -------------------------------------------------------------------------
  // Hypothesis 2: 0xDD expects [R, G, B] but offset is the Key Index (0-67)
  // Let's try sending Red to offset 0, Green to offset 1
  // -------------------------------------------------------------------------
  console.log('\n[Test 2] Trying Offset = Key Index (Offset 0=Red, Offset 1=Green)...');
  sendRaw(0xDD, Buffer.from([0xFF, 0x00, 0x00]), 0x0000);
  sendRaw(0xDD, Buffer.from([0x00, 0xFF, 0x00]), 0x0001);
  await sleep(3000);

  // Clear
  for(let pos = 0; pos < 204; pos+=56) sendRaw(0x0B, black.slice(pos, pos+56), 0x0400 + pos);
  await sleep(500);

  // -------------------------------------------------------------------------
  // Hypothesis 3: 0xDD expects GRB or BGR instead of RGB
  // We sent solid Blue [0, 0, 255] in the sweep, which was: 
  // 00 00 FF 00 00 FF 00 00 FF ...
  // Let's try sending a sequence like 01 02 03 04 05 06 to see what happens
  // -------------------------------------------------------------------------
  console.log('\n[Test 3] Sending sequence 01 02 03 04 05 06... to see color mapping');
  const payload3 = Buffer.alloc(56);
  for(let i=0; i<56; i++) payload3[i] = i * 4; // increasing brightness
  sendRaw(0xDD, payload3, 0x0000);
  await sleep(3000);
  
  // Clear
  for(let pos = 0; pos < 204; pos+=56) sendRaw(0x0B, black.slice(pos, pos+56), 0x0400 + pos);

  console.log('\nTests finished. Look at the terminal output to tell me what you saw!');
  dev.close();
}

runTest();