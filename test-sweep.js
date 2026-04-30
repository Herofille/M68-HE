/**
 * Exhaustive HID Command and Offset Sweeper
 * Run: node test-sweep.js
 * 
 * This script will try various commands and offsets to see if we can find
 * a faster, direct-LED writing method that actually updates the keyboard.
 * It will send a solid color and wait for user confirmation.
 */

const HID = require('node-hid');
const readline = require('readline');

const VID = 0x19F5;
const PID = 0xFB2B;
const OUTPUT_MAGIC = 0x55;
const K68_KEYS = 68;
const RGB_BYTES = K68_KEYS * 3; // 204

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

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

function sendFrame(dev, cmd, baseOffset, rgbData) {
  let ok = true;
  for (let pos = 0; pos < RGB_BYTES; ) {
    const sz = Math.min(56, RGB_BYTES - pos);
    const off = baseOffset + pos;
    const payload = rgbData.slice(pos, pos + sz);
    const pkt = buildPacket(cmd, sz, off & 0xFF, (off >> 8) & 0xFF, payload);
    try {
      dev.write(Array.from(pkt));
    } catch (err) {
      console.log(`    [!] Write failed at offset ${off}`);
      ok = false;
      break;
    }
    pos += sz;
  }
  return ok;
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

function getSolidColorData(r, g, b) {
  const rgbData = Buffer.alloc(RGB_BYTES);
  for (let i = 0; i < K68_KEYS; i++) {
    rgbData[i * 3] = r;
    rgbData[i * 3 + 1] = g;
    rgbData[i * 3 + 2] = b;
  }
  return rgbData;
}

// Ensure the keyboard is in CUSTOM mode before we start testing colors
function cmdCustomMode(dev) {
  const d = Buffer.alloc(64, 0);
  d[0] = 0x50; d[1] = 0x09; d[2] = 0xAA; d[3] = 0xBB;
  d[4] = 0x01; d[6] = 0x00;
  d[7] = 0x05;          // CUSTOM mode
  d[8] = 0x00;          // speed
  d[9] = 100;           // brightness
  d[10] = 0x03;
  d[13] = 0x04;
  d[15] = 0xFF; d[16] = 0x00; d[17] = 0x00;
  d[18] = 0x64;
  d[19] = 0xFF; d[20] = 0x80; d[21] = 0x00;
  d[25] = 0x01; d[26] = 0x32; d[27] = 0x02; d[29] = 0x01;
  for (let i = 30; i < 64; i++) d[i] = 0x10;

  const pkt1 = buildPacket(0x06, 56, 0x80, 0x00, d.slice(0, 56));
  const pkt2 = buildPacket(0x06, 8,  0xB8, 0x00, d.slice(56, 64));
  try {
    dev.write(Array.from(pkt1));
    dev.write(Array.from(pkt2));
  } catch (e) {}
}

async function runTest() {
  console.log('\n=== M68 HE: Exhaustive Command & Offset Sweeper ===');
  console.log('We will try various command bytes and offsets.');
  console.log('For each test, we will attempt to set the keyboard to a specific color.');
  
  const dev = findDevice();
  if (!dev) {
    console.error('ERROR: Keyboard not found. Please connect it.');
    process.exit(1);
  }

  console.log('\n[Init] Setting keyboard to CUSTOM mode...');
  cmdCustomMode(dev);
  await new Promise(r => setTimeout(r, 500));

  // Let's clear the keyboard to black first using the known good method (0x0B at offset 0x0400)
  console.log('[Init] Clearing keyboard to BLACK (using known good 0x0B at 0x0400)...');
  sendFrame(dev, 0x0B, 0x0400, getSolidColorData(0, 0, 0));
  await new Promise(r => setTimeout(r, 500));

  const testCases = [
    // Format: { cmd, offset, colorName, rgb }
    
    // 1. Try commands we know might be related to LED control, at offset 0x0000 (Direct?)
    { cmd: 0x0A, offset: 0x0000, colorName: 'RED',   rgb: [255, 0, 0] },
    { cmd: 0x0C, offset: 0x0000, colorName: 'GREEN', rgb: [0, 255, 0] },
    { cmd: 0x0D, offset: 0x0000, colorName: 'BLUE',  rgb: [0, 0, 255] },
    { cmd: 0x0E, offset: 0x0000, colorName: 'YELLOW',rgb: [255, 255, 0] },
    { cmd: 0x0F, offset: 0x0000, colorName: 'CYAN',  rgb: [0, 255, 255] },

    // 2. Try the 0x0B command (known good) but at different offsets to see if there's a direct buffer
    { cmd: 0x0B, offset: 0x0000, colorName: 'PURPLE',rgb: [255, 0, 255] },
    { cmd: 0x0B, offset: 0x0100, colorName: 'WHITE', rgb: [255, 255, 255] },
    { cmd: 0x0B, offset: 0x0200, colorName: 'RED',   rgb: [255, 0, 0] },
    { cmd: 0x0B, offset: 0x0300, colorName: 'GREEN', rgb: [0, 255, 0] },
    
    // 3. Try other potential direct write commands at offset 0x0400 (the custom profile slot)
    { cmd: 0x0A, offset: 0x0400, colorName: 'BLUE',  rgb: [0, 0, 255] },
    { cmd: 0x0C, offset: 0x0400, colorName: 'YELLOW',rgb: [255, 255, 0] },
    { cmd: 0x0D, offset: 0x0400, colorName: 'CYAN',  rgb: [0, 255, 255] },

    // 4. Test higher range commands that might be unmapped or direct
    { cmd: 0x10, offset: 0x0000, colorName: 'PURPLE',rgb: [255, 0, 255] },
    { cmd: 0x11, offset: 0x0000, colorName: 'WHITE', rgb: [255, 255, 255] },
    { cmd: 0x20, offset: 0x0000, colorName: 'RED',   rgb: [255, 0, 0] },
    { cmd: 0xA0, offset: 0x0000, colorName: 'GREEN', rgb: [0, 255, 0] },
    { cmd: 0xDD, offset: 0x0000, colorName: 'BLUE',  rgb: [0, 0, 255] },
    { cmd: 0xDF, offset: 0x0000, colorName: 'YELLOW',rgb: [255, 255, 0] },
  ];

  let successfulMethods = [];

  for (const t of testCases) {
    console.log(`\n--- Test: CMD 0x${t.cmd.toString(16).padStart(2, '0').toUpperCase()} | OFFSET 0x${t.offset.toString(16).padStart(4, '0').toUpperCase()} ---`);
    console.log(`Sending ${t.colorName}...`);
    
    const colorData = getSolidColorData(t.rgb[0], t.rgb[1], t.rgb[2]);
    sendFrame(dev, t.cmd, t.offset, colorData);
    
    const answer = await askQuestion(`Did the keyboard turn ${t.colorName}? (y/n): `);
    
    if (answer.toLowerCase().startsWith('y')) {
      console.log(`  => SUCCESS! Command 0x${t.cmd.toString(16).toUpperCase()} at offset 0x${t.offset.toString(16).toUpperCase()} works!`);
      successfulMethods.push(t);
      
      // Clear it back to black using known good method
      sendFrame(dev, 0x0B, 0x0400, getSolidColorData(0, 0, 0));
      await new Promise(r => setTimeout(r, 300));
    } else {
      console.log('  => Failed.');
      // It might have worked but messed up the buffer, reset config just in case
      cmdCustomMode(dev);
      sendFrame(dev, 0x0B, 0x0400, getSolidColorData(0, 0, 0));
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log('\n=== Sweep Complete ===');
  if (successfulMethods.length > 0) {
    console.log('The following alternative methods successfully updated the keyboard:');
    successfulMethods.forEach(m => {
      console.log(` - CMD: 0x${m.cmd.toString(16).toUpperCase()}, OFFSET: 0x${m.offset.toString(16).toUpperCase()}`);
    });
  } else {
    console.log('No alternative methods worked. We may be stuck with 0x0B at 0x0400.');
  }

  dev.close();
  rl.close();
}

runTest();