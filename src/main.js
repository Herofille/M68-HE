import { HIDManager } from './hid-manager.js';
import { EffectsEngine, KEYBOARD_LAYOUT, rgbToHex } from './effects-engine.js';
import { MusicAnalyzer } from './music-analyzer.js';
import { decodePacket, colorBufferToRGBArray, sendRGBFrame, interpolateRGB, resetFrameDelta, setStreamMode, sendColorPulse, writeSolidColorSetup, sendEffectConfig, sendSolidColor, sendAllOff, readLightConfig, readLiveRGBFrame, parseLiveRGBChunk, sendStartFastModel, sendEndFastModel, sendCustomMode, buildOutputPacket, EFFECT_MODES, K68_LED_MAP } from './protocol.js';
import { HIDWebSocketClient } from './hid-ws-client.js';

// === Globals ===
const hid = new HIDManager();
const effects = new EffectsEngine();
const music = new MusicAnalyzer();
const wsHid = new HIDWebSocketClient();

let repeatTimer = null;
let musicEffectRunning = false;
let musicAnimFrame = null;
let sendToKeyboard = false;
let useNativeHID = false;  // true = use node-hid server, false = use WebHID
let lastFrameSentAt = 0;
const FRAME_INTERVAL_WEBHID = 72;  // ~14fps for WebHID
const FRAME_INTERVAL_NATIVE = 16;  // ~60fps attempt — server's enqueueRGBFrame is the real bottleneck
let FRAME_INTERVAL_MS = FRAME_INTERVAL_WEBHID;
let nativeConnectPromise = null;
let nativeStatsTimer = null;

// === Tab Navigation ===
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); });
    document.querySelectorAll('.panel').forEach(p => { p.classList.remove('active'); });
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// === Connection ===
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const statusEl = document.getElementById('connection-status');
const statusText = statusEl.querySelector('.status-text');

btnConnect.addEventListener('click', async () => {
  try {
    btnConnect.textContent = 'Connecting...';
    btnConnect.disabled = true;
    const info = await hid.connect();
    statusEl.classList.remove('disconnected');
    statusEl.classList.add('connected');
    statusText.textContent = info.productName || 'Connected';
    btnConnect.classList.add('hidden');
    btnDisconnect.classList.remove('hidden');
    renderDeviceInfo(info);
  } catch (err) {
    alert('Connection failed: ' + err.message);
  } finally {
    btnConnect.textContent = 'Connect Keyboard';
    btnConnect.disabled = false;
  }
});

btnDisconnect.addEventListener('click', async () => {
  await hid.disconnect();
  statusEl.classList.remove('connected');
  statusEl.classList.add('disconnected');
  statusText.textContent = 'Disconnected';
  btnDisconnect.classList.add('hidden');
  btnConnect.classList.remove('hidden');
  document.getElementById('device-info').innerHTML = '<div class="placeholder">No device connected.</div>';
  document.getElementById('collections-list').classList.add('hidden');
});

// === Device Explorer ===
function renderDeviceInfo(info) {
  const container = document.getElementById('device-info');
  container.innerHTML = `
    <dl class="device-detail">
      <dt>Product Name</dt><dd>${info.productName || 'Unknown'}</dd>
      <dt>Vendor ID</dt><dd>0x${info.vendorId.toString(16).padStart(4, '0').toUpperCase()}</dd>
      <dt>Product ID</dt><dd>0x${info.productId.toString(16).padStart(4, '0').toUpperCase()}</dd>
      <dt>Status</dt><dd>${info.opened ? '✅ Open' : '❌ Closed'}</dd>
      <dt>Collections</dt><dd>${info.collections.length}</dd>
    </dl>
  `;

  const colList = document.getElementById('collections-list');
  const colContent = document.getElementById('collections-content');
  colList.classList.remove('hidden');

  colContent.innerHTML = info.collections.map((col, i) => `
    <div class="collection-item">
      <h4>Collection ${i} — Usage Page: 0x${col.usagePage.toString(16).padStart(4, '0')} / Usage: 0x${col.usage.toString(16).padStart(4, '0')}</h4>
      <div class="report-list">
        <strong>Input Reports:</strong>
        ${col.inputReports.length ? col.inputReports.map(r => `<span>ID ${r.reportId} (${r.items?.length || 0} items)</span>`).join('') : '<span>None</span>'}
      </div>
      <div class="report-list">
        <strong>Output Reports:</strong>
        ${col.outputReports.length ? col.outputReports.map(r => `<span>ID ${r.reportId} (${r.items?.length || 0} items)</span>`).join('') : '<span>None</span>'}
      </div>
      <div class="report-list">
        <strong>Feature Reports:</strong>
        ${col.featureReports.length ? col.featureReports.map(r => `<span>ID ${r.reportId} (${r.items?.length || 0} items)</span>`).join('') : '<span>None</span>'}
      </div>
      ${col.children ? `<div class="report-list"><strong>Sub-collections:</strong> <span>${col.children}</span></div>` : ''}
    </div>
  `).join('');
}

// === Diagnostic Probe ===
let diagnosticRunning = false;
const diagLog = document.getElementById('diagnostic-log');

function diagMsg(msg, type = 'info') {
  const colors = { info: '#8888aa', success: '#22c55e', error: '#ef4444', warn: '#eab308', test: '#c084fc' };
  const div = document.createElement('div');
  div.style.cssText = `padding: 2px 0; color: ${colors[type] || colors.info}; font-size: 0.78rem; font-family: var(--font-mono);`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  diagLog.appendChild(div);
  diagLog.scrollTop = diagLog.scrollHeight;
}

document.getElementById('btn-run-diagnostic').addEventListener('click', async () => {
  if (!hid.isConnected) { alert('Connect keyboard first!'); return; }
  diagnosticRunning = true;
  document.getElementById('btn-run-diagnostic').classList.add('hidden');
  document.getElementById('btn-stop-diagnostic').classList.remove('hidden');
  diagLog.innerHTML = '';

  diagMsg('=== Starting Full Diagnostic ===');

  // Step 1: List device info
  const info = hid.getDeviceInfo();
  diagMsg(`Device: ${info.productName} (VID:0x${info.vendorId.toString(16)} PID:0x${info.productId.toString(16)})`);
  diagMsg(`Collections: ${info.collections.length}`);

  const reportIds = hid.getAvailableReportIds();
  diagMsg(`Available Output Report IDs: [${reportIds.output.join(', ')}]`);
  diagMsg(`Available Feature Report IDs: [${reportIds.feature.join(', ')}]`);
  diagMsg(`Available Input Report IDs: [${reportIds.input.join(', ')}]`);

  // Step 2: Try reading feature reports
  diagMsg('');
  diagMsg('=== Phase 1: Reading Feature Reports ===');
  for (const fid of reportIds.feature) {
    if (!diagnosticRunning) break;
    try {
      const data = await hid.receiveFeatureReport(fid);
      const hex = Array.from(data).slice(0, 20).map(b => b.toString(16).padStart(2, '0')).join(' ');
      diagMsg(`Feature Report ${fid}: OK — ${hex}...`, 'success');
    } catch (err) {
      diagMsg(`Feature Report ${fid}: FAILED — ${err.message}`, 'error');
    }
    await sleep(100);
  }

  // Step 3: Try sending output reports with different IDs
  diagMsg('');
  diagMsg('=== Phase 2: Testing Output Reports (all red) ===');
  diagMsg('WATCH YOUR KEYBOARD for any LED changes!');

  // Build a simple all-red payload (64 bytes)
  const redPayload = new Uint8Array(64);
  for (let i = 0; i < 64; i += 3) {
    redPayload[i] = 0xFE;
    redPayload[i + 1] = 0x00;
    redPayload[i + 2] = 0x00;
  }

  for (const oid of reportIds.output) {
    if (!diagnosticRunning) break;
    diagMsg(`Trying Output Report ID ${oid} with raw red data...`, 'test');
    try {
      await hid.sendOutputReport(oid, redPayload);
      diagMsg(`  Output Report ${oid}: Sent OK (did LEDs change?)`, 'success');
    } catch (err) {
      diagMsg(`  Output Report ${oid}: FAILED — ${err.message}`, 'error');
    }
    await sleep(500);
  }

  // Step 4: Try sending feature reports with color data
  diagMsg('');
  diagMsg('=== Phase 3: Testing Feature Reports (write) ===');
  for (const fid of reportIds.feature) {
    if (!diagnosticRunning) break;
    diagMsg(`Trying Feature Report ID ${fid} with red data...`, 'test');
    try {
      await hid.sendFeatureReport(fid, redPayload);
      diagMsg(`  Feature Report ${fid}: Sent OK (did LEDs change?)`, 'success');
    } catch (err) {
      diagMsg(`  Feature Report ${fid}: FAILED — ${err.message}`, 'error');
    }
    await sleep(500);
  }

  // Step 5: Try AA-prefixed packets on all output report IDs
  diagMsg('');
  diagMsg('=== Phase 4: AA-prefixed Protocol Packets ===');

  // Try the config packet format (AA 05)
  const configPkt = new Uint8Array(64);
  configPkt[0] = 0xAA; configPkt[1] = 0x05; configPkt[2] = 0x00; configPkt[3] = 0x00;
  configPkt[4] = 0x38; configPkt[5] = 0x80; configPkt[6] = 0x00; configPkt[7] = 0x00;
  configPkt[8] = 0x50; configPkt[9] = 0x09; configPkt[10] = 0xAA; configPkt[11] = 0xBB;
  configPkt[12] = 0x01; configPkt[15] = 0x04;
  configPkt[16] = 0x01; // static mode
  configPkt[17] = 0x64; // brightness 100
  configPkt[21] = 0x01;
  configPkt[22] = 0xFE; configPkt[23] = 0x00; configPkt[24] = 0x00; // red
  configPkt[26] = 0x64;
  configPkt[27] = 0xFE; configPkt[28] = 0x00; configPkt[29] = 0x00;
  configPkt[32] = 0x01; configPkt[33] = 0x32; configPkt[34] = 0x02;
  configPkt[36] = 0x01;
  for (let i = 37; i < 64; i++) configPkt[i] = 0x10;

  for (const oid of reportIds.output) {
    if (!diagnosticRunning) break;
    diagMsg(`Trying AA 05 config (static red) on Output ID ${oid}...`, 'test');
    try {
      await hid.sendOutputReport(oid, configPkt);
      diagMsg(`  Sent OK on Output ID ${oid}`, 'success');
    } catch (err) {
      diagMsg(`  FAILED on Output ID ${oid}: ${err.message}`, 'error');
    }
    await sleep(500);
  }

  // Try the same as feature reports
  for (const fid of reportIds.feature) {
    if (!diagnosticRunning) break;
    diagMsg(`Trying AA 05 config (static red) on Feature ID ${fid}...`, 'test');
    try {
      await hid.sendFeatureReport(fid, configPkt);
      diagMsg(`  Sent OK on Feature ID ${fid}`, 'success');
    } catch (err) {
      diagMsg(`  FAILED on Feature ID ${fid}: ${err.message}`, 'error');
    }
    await sleep(500);
  }

  // Step 6: Try RGB frame packet on all output IDs
  diagMsg('');
  diagMsg('=== Phase 5: AA DE RGB Frame Packets ===');
  const rgbPkt = new Uint8Array(64);
  rgbPkt[0] = 0xAA; rgbPkt[1] = 0xDE; rgbPkt[2] = 0x00; rgbPkt[3] = 0x00;
  rgbPkt[4] = 0x38; rgbPkt[5] = 0x00; rgbPkt[6] = 0x00; rgbPkt[7] = 0x00;
  for (let i = 8; i < 64; i += 3) {
    rgbPkt[i] = 0x00; rgbPkt[i + 1] = 0xFE; rgbPkt[i + 2] = 0x00; // green
  }

  for (const oid of reportIds.output) {
    if (!diagnosticRunning) break;
    diagMsg(`Trying AA DE RGB frame (green) on Output ID ${oid}...`, 'test');
    try {
      await hid.sendOutputReport(oid, rgbPkt);
      diagMsg(`  Sent OK on Output ID ${oid}`, 'success');
    } catch (err) {
      diagMsg(`  FAILED on Output ID ${oid}: ${err.message}`, 'error');
    }
    await sleep(500);
  }

  // Step 7: Try without AA prefix (maybe AA is not part of the data)
  diagMsg('');
  diagMsg('=== Phase 6: Without AA Prefix (data only) ===');
  const noPrefix = new Uint8Array(64);
  noPrefix[0] = 0x05; noPrefix[1] = 0x00; noPrefix[2] = 0x00;
  noPrefix[3] = 0x38; noPrefix[4] = 0x80; noPrefix[5] = 0x00; noPrefix[6] = 0x00;
  noPrefix[7] = 0x50; noPrefix[8] = 0x09; noPrefix[9] = 0xAA; noPrefix[10] = 0xBB;
  noPrefix[11] = 0x01; noPrefix[14] = 0x04;
  noPrefix[15] = 0x01; noPrefix[16] = 0x64;
  noPrefix[20] = 0x01;
  noPrefix[21] = 0xFE; noPrefix[22] = 0x00; noPrefix[23] = 0x00;
  noPrefix[25] = 0x64;
  noPrefix[26] = 0xFE; noPrefix[27] = 0x00; noPrefix[28] = 0x00;

  for (const oid of reportIds.output) {
    if (!diagnosticRunning) break;
    diagMsg(`Trying config without AA prefix on Output ID ${oid}...`, 'test');
    try {
      await hid.sendOutputReport(oid, noPrefix);
      diagMsg(`  Sent OK on Output ID ${oid}`, 'success');
    } catch (err) {
      diagMsg(`  FAILED on Output ID ${oid}: ${err.message}`, 'error');
    }
    await sleep(500);
  }

  // Step 8: Try smaller packets
  diagMsg('');
  diagMsg('=== Phase 7: Small Probe Packets ===');
  const smallPackets = [
    { name: 'AA 01 00', data: [0xAA, 0x01, 0x00] },
    { name: 'AA 02 00', data: [0xAA, 0x02, 0x00] },
    { name: 'AA 03 00', data: [0xAA, 0x03, 0x00] },
    { name: 'AA 04 00', data: [0xAA, 0x04, 0x00] },
    { name: 'AA 07 00', data: [0xAA, 0x07, 0x00] },
    { name: 'AA 08 00', data: [0xAA, 0x08, 0x00] },
    { name: 'AA 09 00', data: [0xAA, 0x09, 0x00] },
    { name: 'AA 0A 00', data: [0xAA, 0x0A, 0x00] },
    { name: '01 00 00 FE 00 00', data: [0x01, 0x00, 0x00, 0xFE, 0x00, 0x00] },
    { name: '07 0B 01 FE 00 00', data: [0x07, 0x0B, 0x01, 0xFE, 0x00, 0x00] },
  ];

  for (const pkt of smallPackets) {
    if (!diagnosticRunning) break;
    for (const oid of reportIds.output) {
      diagMsg(`Trying [${pkt.name}] on Output ID ${oid}...`, 'test');
      try {
        await hid.sendOutputReport(oid, new Uint8Array(pkt.data));
        diagMsg(`  Sent OK`, 'success');
      } catch (err) {
        diagMsg(`  FAILED: ${err.message}`, 'error');
      }
      await sleep(200);
    }
  }

  diagMsg('');
  diagMsg('=== Diagnostic Complete ===', diagnosticRunning ? 'info' : 'warn');
  diagMsg('If no LED changes occurred, the keyboard may require a USB packet capture.');
  diagMsg('Install Wireshark + USBPcap to capture what hedriver.com sends.');

  diagnosticRunning = false;
  document.getElementById('btn-stop-diagnostic').classList.add('hidden');
  document.getElementById('btn-run-diagnostic').classList.remove('hidden');
});

document.getElementById('btn-stop-diagnostic').addEventListener('click', () => {
  diagnosticRunning = false;
  document.getElementById('btn-stop-diagnostic').classList.add('hidden');
  document.getElementById('btn-run-diagnostic').classList.remove('hidden');
  diagMsg('Diagnostic stopped by user.', 'warn');
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === Packet Sniffer ===
const packetLog = document.getElementById('packet-log');
const packetCount = document.getElementById('packet-count');
const chkAutoScroll = document.getElementById('chk-auto-scroll');
const chkHex = document.getElementById('chk-hex-display');
let capturedCount = 0;

document.getElementById('btn-start-capture').addEventListener('click', () => {
  if (!hid.isConnected) { alert('Connect keyboard first!'); return; }
  hid.startCapture();
  document.getElementById('btn-start-capture').classList.add('hidden');
  document.getElementById('btn-stop-capture').classList.remove('hidden');
  packetLog.innerHTML = '';
});

document.getElementById('btn-stop-capture').addEventListener('click', () => {
  hid.stopCapture();
  document.getElementById('btn-stop-capture').classList.add('hidden');
  document.getElementById('btn-start-capture').classList.remove('hidden');
});

document.getElementById('btn-clear-capture').addEventListener('click', () => {
  hid.clearCapture();
  packetLog.innerHTML = '<div class="log-empty">Start capture to see incoming HID reports...</div>';
  capturedCount = 0;
  packetCount.textContent = '0 packets';
});

hid.on('inputreport', (entry) => {
  capturedCount++;
  packetCount.textContent = `${capturedCount} packets`;

  const logEmpty = packetLog.querySelector('.log-empty');
  if (logEmpty) logEmpty.remove();

  const div = document.createElement('div');
  div.className = 'log-entry';

  const time = new Date(entry.timestamp).toISOString().split('T')[1].replace('Z', '');
  const dataStr = chkHex.checked
    ? Array.from(entry.data).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    : Array.from(entry.data).join(', ');

  // Decode packet using protocol adapter
  const decoded = decodePacket(entry.data);
  let decodedStr = '';
  if (decoded.type === 'rgb_frame') {
    decodedStr = `<span class="log-decoded">[RGB off=0x${decoded.offset.toString(16).padStart(4,'0')} ${decoded.colorCount} colors]</span>`;
  } else if (decoded.type === 'config') {
    decodedStr = `<span class="log-decoded config">[CONFIG mode=${decoded.effectModeName} bright=${decoded.brightness} spd=${decoded.speed} color=rgb(${decoded.primaryColor.r},${decoded.primaryColor.g},${decoded.primaryColor.b})]</span>`;
  } else if (decoded.type === 'config_continuation') {
    decodedStr = `<span class="log-decoded">[CONFIG cont.]</span>`;
  } else if (decoded.type === 'other') {
    decodedStr = `<span class="log-decoded">[${decoded.packetType}]</span>`;
  }

  div.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-type">${entry.type}</span>
    <span class="log-id">ID:${entry.reportId}</span>
    ${decodedStr}
    <span class="log-data">${dataStr}</span>
  `;

  packetLog.appendChild(div);

  if (chkAutoScroll.checked) {
    packetLog.scrollTop = packetLog.scrollHeight;
  }
});

// === Command Sender ===
document.getElementById('btn-send-report').addEventListener('click', async () => {
  if (!hid.isConnected) { alert('Connect keyboard first!'); return; }

  const type = document.getElementById('report-type').value;
  const reportId = parseInt(document.getElementById('report-id').value);
  const dataStr = document.getElementById('report-data').value.trim();
  const repeatCount = parseInt(document.getElementById('repeat-count').value);
  const repeatInterval = parseInt(document.getElementById('repeat-interval').value);

  if (!dataStr) { alert('Enter data bytes!'); return; }

  const bytes = parseHexString(dataStr);
  if (!bytes) { alert('Invalid hex data. Use space-separated hex bytes like: 07 0A FF'); return; }

  const sendOnce = async () => {
    try {
      if (type === 'output') {
        await hid.sendOutputReport(reportId, bytes);
      } else {
        await hid.sendFeatureReport(reportId, bytes);
      }
    } catch (err) {
      alert('Send failed: ' + err.message);
    }
  };

  if (repeatCount <= 1) {
    await sendOnce();
  } else {
    let count = 0;
    document.getElementById('btn-send-report').classList.add('hidden');
    document.getElementById('btn-stop-repeat').classList.remove('hidden');

    repeatTimer = setInterval(async () => {
      count++;
      await sendOnce();
      if (count >= repeatCount) {
        stopRepeat();
      }
    }, repeatInterval);
  }
});

function stopRepeat() {
  if (repeatTimer) {
    clearInterval(repeatTimer);
    repeatTimer = null;
  }
  document.getElementById('btn-stop-repeat').classList.add('hidden');
  document.getElementById('btn-send-report').classList.remove('hidden');
}

document.getElementById('btn-stop-repeat').addEventListener('click', stopRepeat);

function parseHexString(str) {
  const parts = str.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  const bytes = [];
  for (const p of parts) {
    const val = parseInt(p, 16);
    if (isNaN(val) || val < 0 || val > 255) return null;
    bytes.push(val);
  }
  return new Uint8Array(bytes);
}

// === Saved Commands ===
let savedCommands = JSON.parse(localStorage.getItem('kb-rgb-commands') || '[]');
renderSavedCommands();

document.getElementById('btn-save-cmd').addEventListener('click', () => {
  const name = document.getElementById('cmd-name').value.trim();
  if (!name) { alert('Enter a command name'); return; }

  const cmd = {
    name,
    type: document.getElementById('report-type').value,
    reportId: parseInt(document.getElementById('report-id').value),
    data: document.getElementById('report-data').value.trim(),
  };

  savedCommands.push(cmd);
  localStorage.setItem('kb-rgb-commands', JSON.stringify(savedCommands));
  document.getElementById('cmd-name').value = '';
  renderSavedCommands();
});

function renderSavedCommands() {
  const container = document.getElementById('saved-commands-list');
  container.innerHTML = savedCommands.map((cmd, i) => `
    <div class="saved-item">
      <span class="saved-item-name">${cmd.name}</span>
      <span style="color: var(--text-muted); font-size: 0.7rem;">${cmd.type} ID:${cmd.reportId}</span>
      <div class="saved-item-actions">
        <button onclick="loadCommand(${i})">Load</button>
        <button onclick="runSavedCommand(${i})">Run</button>
        <button onclick="deleteCommand(${i})">Del</button>
      </div>
    </div>
  `).join('');
}

window.loadCommand = (i) => {
  const cmd = savedCommands[i];
  document.getElementById('report-type').value = cmd.type;
  document.getElementById('report-id').value = cmd.reportId;
  document.getElementById('report-data').value = cmd.data;
};

window.runSavedCommand = async (i) => {
  const cmd = savedCommands[i];
  const bytes = parseHexString(cmd.data);
  if (!bytes || !hid.isConnected) return;
  try {
    if (cmd.type === 'output') {
      await hid.sendOutputReport(cmd.reportId, bytes);
    } else {
      await hid.sendFeatureReport(cmd.reportId, bytes);
    }
  } catch (err) {
    alert('Run failed: ' + err.message);
  }
};

window.deleteCommand = (i) => {
  savedCommands.splice(i, 1);
  localStorage.setItem('kb-rgb-commands', JSON.stringify(savedCommands));
  renderSavedCommands();
};

// === Quick Presets ===
// Protocol-aware presets using verified 0x55 output protocol
const PRESETS = [
  { name: 'All LEDs OFF', desc: 'Send blank RGB frame (all LEDs off)', type: 'protocol', action: 'all-off' },
  { name: 'Solid RED', desc: 'Direct per-key control: all red', type: 'protocol', action: 'solid', color: [0xFE, 0x00, 0x00] },
  { name: 'Solid GREEN', desc: 'Direct per-key control: all green', type: 'protocol', action: 'solid', color: [0x00, 0xFE, 0x00] },
  { name: 'Solid BLUE', desc: 'Direct per-key control: all blue', type: 'protocol', action: 'solid', color: [0x00, 0x00, 0xFE] },
  { name: 'Solid CYAN', desc: 'Direct per-key control: all cyan', type: 'protocol', action: 'solid', color: [0x00, 0xFE, 0xFE] },
  { name: 'Solid PURPLE', desc: 'Direct per-key control: all purple', type: 'protocol', action: 'solid', color: [0x80, 0x00, 0xFE] },
  { name: 'Solid WHITE', desc: 'Direct per-key control: all white', type: 'protocol', action: 'solid', color: [0xFE, 0xFE, 0xFE] },
  { name: 'Effect: Breathing Red', desc: 'Set keyboard built-in breathing red', type: 'protocol', action: 'config', config: { effectMode: EFFECT_MODES.BREATHING, brightness: 100, speed: 0x13, primaryColor: [0xFF, 0x00, 0x00], secondaryColor: [0xFF, 0x00, 0x00] } },
  { name: 'Effect: Static Yellow', desc: 'Set keyboard built-in static yellow', type: 'protocol', action: 'config', config: { effectMode: EFFECT_MODES.STATIC, brightness: 100, primaryColor: [0xFF, 0xFF, 0x00], secondaryColor: [0xFF, 0xFF, 0x00] } },
  { name: 'Effect: Wave', desc: 'Set keyboard built-in wave effect', type: 'protocol', action: 'config', config: { effectMode: EFFECT_MODES.WAVE, brightness: 100, speed: 0x13 } },
  { name: 'Effect: Flower', desc: 'Set keyboard built-in flower effect', type: 'protocol', action: 'config', config: { effectMode: EFFECT_MODES.FLOWER, brightness: 100, speed: 0x13 } },
  { name: 'Effect: OFF', desc: 'Disable keyboard built-in effect', type: 'protocol', action: 'config', config: { effectMode: EFFECT_MODES.OFF, brightness: 0 } },
  { name: 'Read Light Config', desc: 'Read current RGB config from keyboard', type: 'protocol', action: 'read-config' },
];

const presetGrid = document.getElementById('preset-buttons');
PRESETS.forEach((preset, i) => {
  const btn = document.createElement('button');
  btn.className = 'preset-btn';
  btn.innerHTML = `<span class="preset-name">${preset.name}</span><span class="preset-desc">${preset.desc}</span>`;
  btn.addEventListener('click', async () => {
    if (preset.type === 'protocol') {
      if (!hid.isConnected) { alert('Connect keyboard first!'); return; }
      try {
        if (preset.action === 'all-off') {
          await sendAllOff(hid);
        } else if (preset.action === 'solid') {
          await sendSolidColor(hid, preset.color[0], preset.color[1], preset.color[2]);
        } else if (preset.action === 'config') {
          await sendEffectConfig(hid, preset.config);
        } else if (preset.action === 'read-config') {
          await readLightConfig(hid);
        }
        btn.style.borderColor = 'var(--success)';
        setTimeout(() => btn.style.borderColor = '', 1000);
      } catch (err) {
        alert('Send failed: ' + err.message);
      }
    } else {
      document.getElementById('report-type').value = preset.type;
      document.getElementById('report-id').value = preset.id;
      document.getElementById('report-data').value = preset.data;
    }
  });
  presetGrid.appendChild(btn);
});

// === Effect Mode Tester ===
let currentTestMode = 0x00;
const modeDisplay = document.getElementById('mode-tester-display');
const modeLog = document.getElementById('mode-tester-log');

function updateModeDisplay() {
  modeDisplay.textContent = `Mode 0x${currentTestMode.toString(16).toUpperCase().padStart(2, '0')}`;
}

function logMode(msg) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  modeLog.prepend(line);
}

function hexColor(input) {
  const hex = input.value.replace('#', '');
  return [parseInt(hex.substring(0, 2), 16), parseInt(hex.substring(2, 4), 16), parseInt(hex.substring(4, 6), 16)];
}

document.getElementById('btn-mode-prev').addEventListener('click', () => {
  currentTestMode = (currentTestMode - 1 + 16) % 16;
  updateModeDisplay();
});

document.getElementById('btn-mode-next').addEventListener('click', () => {
  currentTestMode = (currentTestMode + 1) % 16;
  updateModeDisplay();
});

document.getElementById('btn-mode-send').addEventListener('click', async () => {
  if (!hid.isConnected) { alert('Connect keyboard first!'); return; }
  const color = hexColor(document.getElementById('mode-tester-color'));
  const speed = parseInt(document.getElementById('mode-tester-speed').value);
  const brightness = parseInt(document.getElementById('mode-tester-brightness').value);
  const config = {
    effectMode: currentTestMode,
    brightness,
    speed,
    direction: 0x03,
    primaryColor: color,
    secondaryColor: color,
  };
  try {
    await sendEffectConfig(hid, config);
    logMode(`Sent mode 0x${currentTestMode.toString(16).toUpperCase().padStart(2, '0')} | color=[${color}] speed=${speed} bright=${brightness}`);
  } catch (err) {
    logMode(`ERROR: ${err.message}`);
  }
});

// === RGB Effects ===
document.querySelectorAll('.effect-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.effect-item').forEach(e => { e.classList.remove('active'); });
    item.classList.add('active');
    effects.setEffect(item.dataset.effect);
  });
});

document.getElementById('effect-speed').addEventListener('input', (e) => effects.setSpeed(parseInt(e.target.value)));
document.getElementById('effect-brightness').addEventListener('input', (e) => effects.setBrightness(parseInt(e.target.value)));
document.getElementById('effect-color1').addEventListener('input', (e) => effects.setColor1(e.target.value));
document.getElementById('effect-color2').addEventListener('input', (e) => effects.setColor2(e.target.value));
document.getElementById('effect-direction').addEventListener('change', (e) => effects.setDirection(e.target.value));
document.getElementById('chk-send-keyboard').addEventListener('change', async (e) => {
  sendToKeyboard = e.target.checked;
  document.getElementById('chk-music-send-keyboard').checked = e.target.checked;
  if (sendToKeyboard) {
    const connected = await ensureNativeHID(true);
    if (!connected) {
      sendToKeyboard = false;
      e.target.checked = false;
      document.getElementById('chk-music-send-keyboard').checked = false;
    }
  }
});
document.getElementById('chk-music-send-keyboard').addEventListener('change', async (e) => {
  sendToKeyboard = e.target.checked;
  document.getElementById('chk-send-keyboard').checked = e.target.checked;
  if (sendToKeyboard) {
    const connected = await ensureNativeHID(true);
    if (!connected) {
      sendToKeyboard = false;
      e.target.checked = false;
      document.getElementById('chk-send-keyboard').checked = false;
    }
  }
});

/**
 * Enter streaming mode: switch keyboard to Custom effect + fast base-key writes
 */
async function enterStreamingMode() {
  try {
    console.log('[Protocol] Switching to Custom mode...');
    setStreamMode('direct');
    await sendCustomMode(hid, 100);
    console.log('[Protocol] Enabling fast model...');
    await sendStartFastModel(hid);
    resetFrameDelta();
    console.log('[Protocol] Streaming mode active (0xDD base 68 physical keys only).');
  } catch (err) {
    console.warn('[Protocol] Failed to enter streaming mode:', err.message);
  }
}

/**
 * Exit streaming mode: disable fast model
 */
async function exitStreamingMode() {
  try {
    console.log('[Protocol] Disabling fast model...');
    await sendEndFastModel(hid);
    console.log('[Protocol] Streaming mode stopped.');
  } catch (err) {
    console.warn('[Protocol] Failed to exit streaming mode:', err.message);
  }
}

// === Firmware effect tests ===
// CORRECTED layout: configData[7]=category, configData[8]=effectID, configData[26]=speed
// Category 0x04 = built-in effects, 0x05 = custom per-key

/** Send a raw config with correct parameter mapping */
async function sendRawEffect(effectId, speed = 0x32, brightness = 0x64, color1 = [0xFF, 0xFF, 0x00], color2 = [0xFF, 0x80, 0x00]) {
  const configData = new Uint8Array(64);
  configData[0] = 0x50; configData[1] = 0x09; configData[2] = 0xAA; configData[3] = 0xBB;
  configData[4] = 0x01; configData[5] = 0x00; configData[6] = 0x00;
  configData[7] = 0x04;       // category: built-in effects
  configData[8] = effectId;   // the actual effect
  configData[9] = brightness;
  configData[10] = 0x03;      // direction
  configData[11] = 0x00; configData[12] = 0x00;
  configData[13] = 0x04; configData[14] = 0x00;
  configData[15] = color1[0]; configData[16] = color1[1]; configData[17] = color1[2];
  configData[18] = 0x64;
  configData[19] = color2[0]; configData[20] = color2[1]; configData[21] = color2[2];
  configData[22] = 0x00; configData[23] = 0x00; configData[24] = 0x00;
  configData[25] = 0x01;
  configData[26] = speed;     // ACTUAL speed parameter
  configData[27] = 0x02; configData[28] = 0x00; configData[29] = 0x01;
  for (let i = 30; i < 64; i++) configData[i] = 0x10;
  
  // Build and send 2 packets (56+8 bytes at offsets 0x0080 and 0x00B8)
  const pkt1Data = configData.slice(0, 56);
  const pkt2Data = configData.slice(56, 64);
  await hid.sendOutputReport(0, buildOutputPacket(0x06, 56, 0x80, 0x00, pkt1Data));
  await hid.sendOutputReport(0, buildOutputPacket(0x06, 8, 0xB8, 0x00, pkt2Data));
}

window.testFX = async (effectId, speed = 0x32) => {
  if (!hid.isConnected) { console.log('Connect keyboard first'); return; }
  console.log(`[Test] Effect ID=0x${effectId.toString(16)}, speed=0x${speed.toString(16)}`);
  await sendRawEffect(effectId, speed);
  console.log('[Test] Done.');
};

// Sweep through effect IDs to find all effects
window.sweepEffects = async () => {
  if (!hid.isConnected) { console.log('Connect keyboard first'); return; }
  const ids = [0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0x0C,0x0D,0x0E,0x0F,0x10,0x11,0x12,0x13,0x14,0x15];
  console.log(`[Sweep] Testing ${ids.length} effect IDs, 3 seconds each...`);
  for (const id of ids) {
    console.log(`[Sweep] Effect ID = 0x${id.toString(16).padStart(2,'0')} ...`);
    await sendRawEffect(id);
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('[Sweep] Done! Note which IDs produced effects.');
};

window.testCustom = async () => {
  if (!hid.isConnected) { console.log('Connect keyboard first'); return; }
  await sendCustomMode(hid, 100);
  console.log('[Test] Back to CUSTOM mode.');
};

// === Native HID mode (node-hid via WebSocket) ===
async function ensureNativeHID(showError = false) {
  if (useNativeHID && wsHid.isConnected) return true;
  if (nativeConnectPromise) return nativeConnectPromise;

  nativeConnectPromise = (async () => {
    try {
      await wsHid.connect();
      wsHid.initKeyboard(100);
      useNativeHID = true;
      FRAME_INTERVAL_MS = FRAME_INTERVAL_NATIVE;
      sendToKeyboard = true;
      document.getElementById('chk-send-keyboard').checked = true;
      document.getElementById('chk-music-send-keyboard').checked = true;
      statusEl.classList.remove('disconnected');
      statusEl.classList.add('connected');
      statusText.textContent = 'Native HID Connected';
      console.log('[Native] Connected! Frame interval set to 16ms (~60fps), using 0xDD base 68 physical keys only.');
      if (!nativeStatsTimer) nativeStatsTimer = setInterval(() => wsHid.requestStats(), 5000);
      return true;
    } catch (err) {
      console.error('[Native] Failed to connect. Run: node hid-server.js');
      useNativeHID = false;
      sendToKeyboard = false;
      FRAME_INTERVAL_MS = FRAME_INTERVAL_WEBHID;
      document.getElementById('chk-send-keyboard').checked = false;
      document.getElementById('chk-music-send-keyboard').checked = false;
      statusEl.classList.remove('connected');
      statusEl.classList.add('disconnected');
      statusText.textContent = 'Native HID server not running';
      if (showError) alert('Native HID server is not connected. Start it with: npm run hid');
      return false;
    } finally {
      nativeConnectPromise = null;
    }
  })();

  return nativeConnectPromise;
}

window.connectNative = () => ensureNativeHID(true);
window.disconnectNative = () => {
  wsHid.disconnect();
  useNativeHID = false;
  FRAME_INTERVAL_MS = FRAME_INTERVAL_WEBHID;
  sendToKeyboard = false;
  document.getElementById('chk-send-keyboard').checked = false;
  document.getElementById('chk-music-send-keyboard').checked = false;
  if (nativeStatsTimer) {
    clearInterval(nativeStatsTimer);
    nativeStatsTimer = null;
  }
  statusEl.classList.remove('connected');
  statusEl.classList.add('disconnected');
  statusText.textContent = 'Disconnected';
  console.log('[Native] Disconnected.');
};

ensureNativeHID();

/** Send a frame to whichever HID backend is active */
function sendFrame(colorBuffer) {
  const now = performance.now();
  if (now - lastFrameSentAt < FRAME_INTERVAL_MS) return;
  lastFrameSentAt = now;

  const rawRgb = colorBufferToRGBArray(colorBuffer);
  renderOutgoingBaseFrame(rawRgb);

  if (useNativeHID && wsHid.isConnected) {
    wsHid.sendRGBFrame(rawRgb); // raw, no smoothing — fast path
  } else if (!useNativeHID && sendToKeyboard && hid.isConnected) {
    sendRGBFrame(hid, rawRgb); // WebHID path keeps interpolation
  }
}

function sendMusicFrame(colorBuffer) {
  const now = performance.now();
  if (now - lastFrameSentAt < FRAME_INTERVAL_MS) return;
  lastFrameSentAt = now;

  const rawRgb = colorBufferToRGBArray(colorBuffer);
  renderOutgoingBaseFrame(rawRgb);

  if (useNativeHID && wsHid.isConnected) {
    wsHid.sendRGBFrame(rawRgb);
  } else if (!useNativeHID && sendToKeyboard && hid.isConnected) {
    sendRGBFrame(hid, rawRgb);
  }
}

let _topRowCleared = false;

function sendTopRowFrame(colorBuffer) {
  const now = performance.now();
  if (now - lastFrameSentAt < FRAME_INTERVAL_MS) return;
  lastFrameSentAt = now;

  const rawRgb = colorBufferToRGBArray(colorBuffer);
  renderOutgoingBaseFrame(rawRgb);
  if (useNativeHID && wsHid.isConnected) {
    wsHid.sendRGBFrame(rawRgb);
  } else if (!useNativeHID && sendToKeyboard && hid.isConnected) {
    sendRGBFrame(hid, rawRgb); // WebHID fallback: full frame
  }
}

effects.onFrame(async (colorBuffer) => {
  updateKeyboardPreview(colorBuffer);
  if (sendToKeyboard) sendFrame(colorBuffer);
});

document.getElementById('btn-start-effect').addEventListener('click', () => {
  effects.start();
  document.getElementById('btn-start-effect').classList.add('hidden');
  document.getElementById('btn-stop-effect').classList.remove('hidden');
});

document.getElementById('btn-stop-effect').addEventListener('click', () => {
  effects.stop();
  document.getElementById('btn-stop-effect').classList.add('hidden');
  document.getElementById('btn-start-effect').classList.remove('hidden');
});

// === Music Reactive ===
const audioSourceSelect = document.getElementById('audio-source');
audioSourceSelect.addEventListener('change', () => {
  document.getElementById('file-input-group').classList.toggle('hidden', audioSourceSelect.value !== 'file');
});

document.getElementById('music-sensitivity').addEventListener('input', (e) => music.setSensitivity(parseInt(e.target.value)));
document.getElementById('music-smoothing').addEventListener('input', (e) => music.setSmoothing(parseInt(e.target.value)));
document.getElementById('chk-auto-gain').addEventListener('change', (e) => {
  music.setAutoGain(e.target.checked);
  document.getElementById('auto-gain-tune').style.display = e.target.checked ? '' : 'none';
});
document.getElementById('auto-gain-target').addEventListener('input', (e) => {
  const v = parseInt(e.target.value);
  document.getElementById('auto-gain-target-label').textContent = v;
  music.setAutoGainTarget(v);
});
document.getElementById('auto-gain-attack').addEventListener('input', (e) => {
  const v = (parseInt(e.target.value) / 10).toFixed(1);
  document.getElementById('auto-gain-attack-label').textContent = v;
  music.setAutoGainAttack(parseFloat(v));
});
document.getElementById('auto-gain-release').addEventListener('input', (e) => {
  const v = (parseInt(e.target.value) / 10).toFixed(1);
  document.getElementById('auto-gain-release-label').textContent = v;
  music.setAutoGainRelease(parseFloat(v));
});

// Adaptive Freq tuning — only visible when mode is "adaptive-freq"
document.getElementById('music-mode').addEventListener('change', (e) => {
  const tune = document.getElementById('adaptive-freq-tune');
  if (tune) tune.style.display = e.target.value === 'adaptive-freq' ? '' : 'none';
});
// Set initial visibility
(function initAdaptiveFreqVisibility() {
  const mode = document.getElementById('music-mode').value;
  const tune = document.getElementById('adaptive-freq-tune');
  if (tune) tune.style.display = mode === 'adaptive-freq' ? '' : 'none';
})();
document.getElementById('adaptive-peak-count').addEventListener('input', (e) => {
  document.getElementById('adaptive-peak-count-label').textContent = e.target.value;
});
document.getElementById('adaptive-threshold').addEventListener('input', (e) => {
  document.getElementById('adaptive-threshold-label').textContent = e.target.value;
});
document.getElementById('adaptive-spread').addEventListener('input', (e) => {
  document.getElementById('adaptive-spread-label').textContent = e.target.value;
});
document.getElementById('music-palette').addEventListener('change', (e) => {
  const group = document.getElementById('custom-colors-group');
  group.style.display = e.target.value === 'custom' ? '' : 'none';
});
document.getElementById('music-gradient-speed').addEventListener('input', (e) => {
  const v = parseInt(e.target.value);
  document.getElementById('gradient-speed-label').textContent = v;
  effects.setGradientSpeed(v);
});

document.getElementById('btn-start-audio').addEventListener('click', async () => {
  try {
    if (!await ensureNativeHID(true)) return;

    const source = audioSourceSelect.value;
    if (source === 'microphone') {
      await music.startMicrophone();
    } else if (source === 'system-loopback') {
      await music.startSystemAudioLoopback();
    } else if (source === 'system') {
      await music.startSystemAudio();
    } else if (source === 'file') {
      const file = document.getElementById('audio-file').files[0];
      await music.startFile(file);
    }

    musicEffectRunning = true;
    document.getElementById('btn-start-audio').classList.add('hidden');
    document.getElementById('btn-stop-audio').classList.remove('hidden');

    startMusicVisualizer();
    startMusicEffect();
  } catch (err) {
    alert('Audio error: ' + err.message);
  }
});

document.getElementById('btn-stop-audio').addEventListener('click', () => {
  music.stop();
  musicEffectRunning = false;
  if (musicAnimFrame) { musicAnimFrame.terminate(); musicAnimFrame = null; }
  document.getElementById('btn-stop-audio').classList.add('hidden');
  document.getElementById('btn-start-audio').classList.remove('hidden');
});

function startMusicVisualizer() {
  const canvas = document.getElementById('audio-visualizer');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * window.devicePixelRatio;
  canvas.height = canvas.offsetHeight * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;

  music.onUpdate = (data) => {
    // Update meters
    document.getElementById('meter-bass').style.width = `${data.bass * 100}%`;
    document.getElementById('meter-mid').style.width = `${data.mid * 100}%`;
    document.getElementById('meter-treble').style.width = `${data.treble * 100}%`;

    // Draw frequency bars
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, w, h);

    if (data.frequencyData) {
      const barCount = 64;
      const step = Math.floor(data.frequencyData.length / barCount);
      const barWidth = w / barCount;

      for (let i = 0; i < barCount; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
          sum += data.frequencyData[i * step + j];
        }
        const avg = sum / step / 255;
        const barHeight = avg * h * 0.9;

        // Color gradient based on position
        const hue = (i / barCount) * 300;
        ctx.fillStyle = `hsl(${hue}, 80%, ${30 + avg * 40}%)`;
        ctx.fillRect(
          i * barWidth + 1,
          h - barHeight,
          barWidth - 2,
          barHeight
        );
      }
    }
  };
}

function startMusicEffect() {
  let _lastMusicTime = performance.now();

  // Web Worker timer: fires every 16ms regardless of tab visibility.
  // Chrome never throttles worker timers, unlike setInterval/RAF on hidden tabs.
  if (musicAnimFrame) { musicAnimFrame.terminate(); musicAnimFrame = null; }
  const worker = new Worker('/timer-worker.js');
  musicAnimFrame = worker;

  worker.onmessage = () => {
    if (!musicEffectRunning) { worker.terminate(); return; }

    // Drive analyzer from worker tick — no internal RAF loop in analyzer anymore
    music.tick();

    const now = performance.now();
    const dt = Math.min((now - _lastMusicTime) / 1000, 0.1);
    _lastMusicTime = now;

    const mode = document.getElementById('music-mode').value;
    const palette = document.getElementById('music-palette').value;
    const colorDirection = document.getElementById('music-gradient-direction').value;
    const gradientSpeed = parseInt(document.getElementById('music-gradient-speed').value) / 100;
    const customColors = palette === 'custom'
      ? [document.getElementById('music-custom1').value, document.getElementById('music-custom2').value,
         document.getElementById('music-custom3').value, document.getElementById('music-custom4').value]
      : null;

    effects.elapsed += dt * (effects.speed / 50);

    if (mode === 'music-sync-upright') {
      const bands = music.getSmoothedBands(KEYBOARD_LAYOUT.cols);
      effects.applyMusicSyncUpright(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'equalizer') {
      const bands = music.getSmoothedBands(KEYBOARD_LAYOUT.cols);
      effects.applyEqualizer(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'chunky-eq') {
      const bands = music.getSmoothedBands(8);
      effects.applyChunkyEQ(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'column-split') {
      const bands = music.getSmoothedBands(KEYBOARD_LAYOUT.cols);
      effects.applyColumnSplit(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'ridge-line') {
      const bands = music.getSmoothedBands(KEYBOARD_LAYOUT.cols);
      effects.applyRidgeLine(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'bass-floor') {
      const bands = music.getSmoothedBands(KEYBOARD_LAYOUT.cols);
      effects.applyBassFloor(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'sharp-bars') {
      const bands = music.getSmoothedBands(KEYBOARD_LAYOUT.cols);
      effects.applySharpBars(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'top-row-vu') {
      // pure bass — kick drums spike it hard, treble doesn't dilute the punch
      const level = Math.min(1, music.bass * 1.4);
      effects.applyTopRowVU(level, palette, colorDirection, gradientSpeed, customColors);
      if (sendToKeyboard) sendTopRowFrame(effects.colorBuffer);
      return;
    } else if (mode === 'rainbow-flow') {
      const bands = music.getSmoothedBands(KEYBOARD_LAYOUT.cols);
      effects.applyRainbowFlow(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'bass-drop') {
      const bands = music.getSmoothedBands(KEYBOARD_LAYOUT.cols);
      effects.applyBassDrop(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'freq-peak') {
      const bands = music.getSmoothedBands(KEYBOARD_LAYOUT.cols);
      effects.applyFreqPeak(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'waterfall') {
      const bands = music.getSmoothedBands(KEYBOARD_LAYOUT.cols);
      effects.applyWaterfall(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'ripple') {
      const bands = music.getSmoothedBands(KEYBOARD_LAYOUT.cols);
      effects.applyRipple(bands, palette, music.bass, music.mid, music.treble, colorDirection, gradientSpeed, customColors);
    } else if (mode === 'adaptive-freq') {
      const peakCount = parseInt(document.getElementById('adaptive-peak-count')?.value || '8');
      const peakThreshold = parseInt(document.getElementById('adaptive-threshold')?.value || '8') / 100;
      const peakSpread = parseInt(document.getElementById('adaptive-spread')?.value || '12') / 100;
      const peaks = music.getActivePeaks(peakCount, peakThreshold);
      effects.applyAdaptiveFreq(peaks, palette, colorDirection, gradientSpeed, customColors, {
        spread: peakSpread,
      });
    } else {
      effects.applyMusicData(music.bass, music.mid, music.treble, mode, palette);
    }

    // Send to physical keyboard — always, even when tab is in background
    if (sendToKeyboard) sendMusicFrame(effects.colorBuffer);
  };

  // Separate RAF loop: only updates on-screen preview (pauses in background — fine)
  const previewLoop = () => {
    if (!musicEffectRunning) return;
    updateKeyboardPreview(effects.colorBuffer);
    requestAnimationFrame(previewLoop);
  };
  requestAnimationFrame(previewLoop);
}

// === Keyboard Preview ===
function buildKeyboardPreview() {
  const container = document.getElementById('keyboard-visual');
  buildKeyboardLayout(container, {
    className: 'key',
    onKey: (key, row, col) => {
      key.addEventListener('click', () => {
        effects.triggerKey(row, col);
      });
    },
  });
}

function buildKeyboardLayout(container, options = {}) {
  if (!container) return;
  const layout = KEYBOARD_LAYOUT.keyMap;
  const className = options.className || 'key';

  // Define key widths (in units where 1u = standard key)
  const keyWidths = [
    // Row 0
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.15, 1],
    // Row 1
    [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 1],
    // Row 2
    [1.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.25, 0, 1],
    // Row 3
    [2.35, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.85, 0, 1, 1],
    // Row 4
    [1.25, 1.25, 1.25, 0, 0, 6.55, 0, 0, 1, 1, 1, 1, 1, 1, 0],
  ];

  const UNIT = 52; // px per 1u, close to hedriver preview proportions
  const GAP = 4;

  container.style.display = 'block';
  container.style.position = 'relative';
  container.innerHTML = '';

  let totalWidth = 0;

  for (let r = 0; r < layout.length; r++) {
    let x = 0;
    let rowWidth = 0;

    for (let c = 0; c < layout[r].length; c++) {
      const label = layout[r][c];
      const w = keyWidths[r][c];

      if (w === 0 || !label) {
        // Skip empty slots, but for Space bar and other wide keys this is handled by width
        continue;
      }

      const key = document.createElement('div');
      key.className = className;
      key.textContent = label;
      key.dataset.row = r;
      key.dataset.col = c;
      key.style.position = 'absolute';
      key.style.left = `${x}px`;
      key.style.top = `${r * (UNIT + GAP)}px`;
      key.style.width = `${w * UNIT - GAP}px`;
      key.style.height = `${UNIT - GAP}px`;

      if (options.onKey) options.onKey(key, r, c);

      container.appendChild(key);
      x += w * UNIT;
      rowWidth = x;
    }

    totalWidth = Math.max(totalWidth, rowWidth);
  }

  container.style.width = `${totalWidth}px`;
  container.style.height = `${layout.length * (UNIT + GAP)}px`;
}

function updateKeyboardPreview(colorBuffer) {
  const keys = document.querySelectorAll('#keyboard-visual .key');
  keys.forEach(key => {
    const r = parseInt(key.dataset.row);
    const c = parseInt(key.dataset.col);
    if (colorBuffer[r] && colorBuffer[r][c]) {
      const color = colorBuffer[r][c];
      const rr = Math.round(Math.max(0, Math.min(255, color.r)));
      const gg = Math.round(Math.max(0, Math.min(255, color.g)));
      const bb = Math.round(Math.max(0, Math.min(255, color.b)));

      if (rr + gg + bb > 30) {
        key.style.backgroundColor = `rgb(${rr}, ${gg}, ${bb})`;
        key.style.boxShadow = `0 0 8px rgba(${rr}, ${gg}, ${bb}, 0.5), inset 0 0 4px rgba(255,255,255,0.1)`;
        key.style.borderColor = `rgba(${rr}, ${gg}, ${bb}, 0.6)`;
        key.classList.add('lit');
      } else {
        key.style.backgroundColor = '#222233';
        key.style.boxShadow = 'none';
        key.style.borderColor = '#333355';
        key.classList.remove('lit');
      }
    }
  });
}

// === Live RGB Flicker Monitor ===
const liveSlotGrid = document.getElementById('live-slot-grid');
const liveKeyboardVisual = document.getElementById('live-keyboard-visual');
const liveMonitorLog = document.getElementById('live-monitor-log');
const liveMonitorStatus = document.getElementById('live-monitor-status');
const LIVE_BASE_RGB_BYTES = 68 * 3;
const LIVE_FULL_RGB_BYTES = 128 * 3;
let liveMonitorTimer = null;
let liveMonitorBusy = false;
let lastLiveFrame = null;
let liveReadCount = 0;
let liveMonitorIntervalMs = 16;
let liveMonitorDroppedReads = 0;
let lastLiveMonitorLogAt = 0;
let livePassiveFrame = new Uint8Array(LIVE_FULL_RGB_BYTES);
let livePassiveMask = new Uint8Array(LIVE_FULL_RGB_BYTES);
let livePassiveActive = false;
let liveLastChunkAt = 0;

function buildLiveSlotGrid() {
  if (liveKeyboardVisual) {
    buildKeyboardLayout(liveKeyboardVisual, {
      className: 'key live-key',
      onKey: (key, row, col) => {
        const slot = K68_LED_MAP[row]?.[col] ?? -1;
        key.dataset.slot = slot;
        key.title = slot >= 0 ? `${key.textContent} — live slot ${slot}` : `${key.textContent} — unmapped`;
        const slotBadge = document.createElement('span');
        slotBadge.className = 'live-slot-badge';
        slotBadge.textContent = slot >= 0 ? String(slot) : '?';
        key.appendChild(slotBadge);
      },
    });
  }

  if (!liveSlotGrid) return;
  liveSlotGrid.innerHTML = '';
  for (let slot = 68; slot < 128; slot++) {
    const cell = document.createElement('div');
    cell.dataset.slot = slot;
    cell.title = `Live slot ${slot}`;
    cell.textContent = String(slot);
    cell.style.cssText = 'height: 22px; border: 1px solid var(--border); border-radius: 4px; background: #050509; color: rgba(255,255,255,0.72); font: 10px var(--font-mono); display: flex; align-items: center; justify-content: center; transition: border-color 80ms linear, box-shadow 80ms linear;';
    liveSlotGrid.appendChild(cell);
  }
}

function liveLog(message, type = 'info') {
  if (!liveMonitorLog) return;
  const empty = liveMonitorLog.querySelector('.log-empty');
  if (empty) empty.remove();
  const colors = { info: '#8888aa', success: '#22c55e', error: '#ef4444', warn: '#eab308' };
  const div = document.createElement('div');
  div.style.cssText = `padding: 2px 0; color: ${colors[type] || colors.info}; font-size: 0.78rem; font-family: var(--font-mono);`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  liveMonitorLog.prepend(div);
}

function renderLiveFrame(frame) {
  const changedSlots = [];
  const slotCount = Math.min(128, Math.floor(frame.length / 3));
  for (let slot = 0; slot < slotCount; slot++) {
    const base = slot * 3;
    const r = frame[base];
    const g = frame[base + 1];
    const b = frame[base + 2];
    const changed = lastLiveFrame
      && (lastLiveFrame[base] !== r || lastLiveFrame[base + 1] !== g || lastLiveFrame[base + 2] !== b);
    if (changed) changedSlots.push(slot);

    const cell = document.querySelector(`[data-slot="${slot}"]`);
    if (!cell) continue;
    const bright = r + g + b;
    cell.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
    cell.style.color = bright > 360 ? '#08080c' : 'rgba(255,255,255,0.82)';
    cell.style.borderColor = changed ? '#ffffff' : 'var(--border)';
    cell.style.boxShadow = changed ? `0 0 10px rgba(${r}, ${g}, ${b}, 0.9), 0 0 0 1px #fff inset` : 'none';
  }

  lastLiveFrame = new Uint8Array(frame);
  liveReadCount++;
  liveMonitorStatus.textContent = `${liveReadCount} reads | ${changedSlots.length} changed`;
}

function renderOutgoingBaseFrame(rawRgb) {
  if (!livePassiveActive) return;
  const frame = new Uint8Array(LIVE_FULL_RGB_BYTES);
  frame.set(rawRgb.slice(0, LIVE_BASE_RGB_BYTES), 0);
  renderLiveFrame(frame);
  liveLastChunkAt = performance.now();
}

async function readAndRenderLiveRGB() {
  if (liveMonitorBusy) return;
  if (!hid.isConnected) {
    liveLog('Connect with the WebHID "Connect Keyboard" button first. Native WebSocket streaming cannot read 0xDE yet.', 'error');
    return;
  }

  liveMonitorBusy = true;
  liveMonitorStatus.textContent = 'reading 0xDE...';
  try {
    const frame = await readLiveRGBFrame(hid, { timeoutMs: 180 });
    renderLiveFrame(frame);
  } catch (err) {
    liveMonitorDroppedReads++;
    liveMonitorStatus.textContent = `${liveReadCount} reads | ${liveMonitorDroppedReads} missed`;
    const now = performance.now();
    if (now - lastLiveMonitorLogAt < 1000) return;
    lastLiveMonitorLogAt = now;
    liveLog(`Missed live read: ${err.message}`, 'warn');
    const recent = hid.getRecentInputReports?.(3) || [];
    if (recent.length === 0) {
      liveLog('No input reports arrived. Make sure the WebHID device is the vendor interface, not only native WebSocket.', 'warn');
    } else {
      recent.forEach(entry => {
        const bytes = Array.from(entry.data).slice(0, 16).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        liveLog(`Recent input ID:${entry.reportId} ${bytes}`, 'warn');
      });
    }
  } finally {
    liveMonitorBusy = false;
  }
}

hid.on('raw-inputreport', (entry) => {
  if (!livePassiveActive) return;
  const chunk = parseLiveRGBChunk(entry, { allowOutputEcho: true });
  if (!chunk) return;

  livePassiveFrame.set(chunk.payload, chunk.offset);
  livePassiveMask.fill(1, chunk.offset, chunk.offset + chunk.payload.length);
  liveLastChunkAt = performance.now();

  // Current app writes only the base 68 physical keys (204 bytes) so it does not
  // touch FN/layer alias slots 68-127. Older/full live reads can still reach 384.
  // Render at either boundary so the monitor does not wait forever for high slots
  // that we intentionally no longer write.
  const end = chunk.offset + chunk.payload.length;
  const hasBaseFrame = end >= LIVE_BASE_RGB_BYTES
    || livePassiveMask.slice(0, LIVE_BASE_RGB_BYTES).every(v => v === 1);
  const hasFullFrame = end >= LIVE_FULL_RGB_BYTES || livePassiveMask.every(v => v === 1);
  if (hasBaseFrame || hasFullFrame) {
    renderLiveFrame(livePassiveFrame);
    livePassiveMask.fill(0);
    livePassiveFrame.fill(0);
  }
});

document.getElementById('btn-read-live-rgb')?.addEventListener('click', readAndRenderLiveRGB);
document.getElementById('btn-start-live-monitor')?.addEventListener('click', () => {
  if (liveMonitorTimer) return;
  liveMonitorIntervalMs = Math.max(0, parseInt(document.getElementById('live-monitor-interval').value, 10) || 16);
  lastLiveFrame = null;
  liveReadCount = 0;
  liveMonitorDroppedReads = 0;
  lastLiveMonitorLogAt = 0;
  livePassiveFrame = new Uint8Array(LIVE_FULL_RGB_BYTES);
  livePassiveMask = new Uint8Array(LIVE_FULL_RGB_BYTES);
  livePassiveActive = true;
  document.getElementById('btn-start-live-monitor').classList.add('hidden');
  document.getElementById('btn-stop-live-monitor').classList.remove('hidden');
  liveLog('Started RGB monitor. Native/stable mode renders outgoing 68-key frames; WebHID readback still listens for 0xDD/0xDE chunks.', 'info');
  const loop = async () => {
    if (liveReadCount === 0) {
      liveMonitorStatus.textContent = useNativeHID
        ? 'waiting for outgoing 68-key frames...'
        : 'waiting for 0xDD chunks...';
    } else if (performance.now() - liveLastChunkAt > 1000) {
      liveMonitorStatus.textContent = useNativeHID
        ? `${liveReadCount} reads | watching outgoing base frames`
        : `${liveReadCount} reads | no recent 0xDD chunks`;
    }
    if (!liveMonitorTimer) return;
    liveMonitorTimer = setTimeout(loop, liveMonitorIntervalMs);
  };
  liveMonitorTimer = setTimeout(loop, 0);
});

document.getElementById('btn-stop-live-monitor')?.addEventListener('click', () => {
  if (liveMonitorTimer) {
    clearTimeout(liveMonitorTimer);
    liveMonitorTimer = null;
  }
  livePassiveActive = false;
  document.getElementById('btn-stop-live-monitor').classList.add('hidden');
  document.getElementById('btn-start-live-monitor').classList.remove('hidden');
  liveMonitorStatus.textContent = 'stopped';
  liveLog('Stopped live monitor.', 'info');
});

// === Initialize ===
buildKeyboardPreview();
buildLiveSlotGrid();

// Listen for keyboard events to trigger reactive effect
document.addEventListener('keydown', (e) => {
  // Map physical key to our layout for reactive effect
  const keyName = e.key.toUpperCase();
  for (let r = 0; r < KEYBOARD_LAYOUT.keyMap.length; r++) {
    for (let c = 0; c < KEYBOARD_LAYOUT.keyMap[r].length; c++) {
      if (KEYBOARD_LAYOUT.keyMap[r][c].toUpperCase() === keyName ||
          KEYBOARD_LAYOUT.keyMap[r][c].toUpperCase() === e.code.replace('Key', '').replace('Digit', '')) {
        effects.triggerKey(r, c);
        return;
      }
    }
  }
  // Random key trigger for keys we can't map
  const rr = Math.floor(Math.random() * KEYBOARD_LAYOUT.rows);
  const rc = Math.floor(Math.random() * KEYBOARD_LAYOUT.cols);
  effects.triggerKey(rr, rc);
});
