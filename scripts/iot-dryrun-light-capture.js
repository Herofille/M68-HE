const { execFileSync, spawn } = require('node:child_process');
const http2 = require('node:http2');
const net = require('node:net');

const IOT_DIR = 'C:/Program Files/iot_manager';
const IOT_MANAGER = `${IOT_DIR}/iot_manager_rs.exe`;
const IOT_PORT = 6015;
const FAKE_HID_PORT = 3838;

const M68_DEVICE_PATHS = [
  '\\\\?\\HID#VID_19F5&PID_FB2B&MI_00#8&32c913ea&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}\\KBD',
  '\\\\?\\HID#VID_19F5&PID_FB2B&MI_02&Col01#8&c68db6e&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}\\KBD',
];

const CANDIDATE_PROFILE_IDS = [
  2301, // K68 / Common68_ZAP68 candidate
  2755, // X68MAX / Common68_K80X68 candidate
  3719, // WOMIER M68 HE PRO / Common67_K2506MA candidate
];

const captured = [];
const scenarioResults = [];
let activeProfileId = CANDIDATE_PROFILE_IDS[0];
let fakeServerRequests = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 500 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(250);
  }
  throw new Error(`${label} port ${port} did not open`);
}

function varint(value) {
  const out = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint((field << 3) | wire);
}

function u32(field, value) {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

function str(field, value) {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
}

function bytes(field, value) {
  return Buffer.concat([tag(field, 2), varint(value.length), value]);
}

function msg(field, body) {
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
}

function frameGrpcWeb(payload, trailer = false) {
  const header = Buffer.alloc(5);
  header[0] = trailer ? 0x80 : 0;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function grpcNativeOk(payload = Buffer.alloc(0)) {
  return frameGrpcWeb(payload);
}

function readVarint(buffer, offset) {
  let shift = 0;
  let value = 0;
  let pos = offset;
  while (pos < buffer.length) {
    const byte = buffer[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, pos };
    shift += 7;
  }
  throw new Error('truncated varint');
}

function decodeProto(buffer, depth = 0) {
  const fields = [];
  let pos = 0;
  while (pos < buffer.length) {
    const key = readVarint(buffer, pos);
    pos = key.pos;
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (wire === 0) {
      const value = readVarint(buffer, pos);
      pos = value.pos;
      fields.push({ field, wire, value: value.value });
    } else if (wire === 2) {
      const len = readVarint(buffer, pos);
      pos = len.pos;
      const data = buffer.subarray(pos, pos + len.value);
      pos += len.value;
      const text = data.every((b) => b >= 0x09 && (b === 0x0a || b === 0x0d || b === 0x09 || (b >= 0x20 && b < 0x7f)))
        ? data.toString('utf8')
        : undefined;
      let nested;
      if (depth < 2 && data.length > 0) {
        try { nested = decodeProto(data, depth + 1); } catch { nested = undefined; }
      }
      fields.push({ field, wire, length: len.value, text, hex: data.toString('hex'), nested });
    } else {
      fields.push({ field, wire, unsupported: true });
      break;
    }
  }
  return fields;
}

function decodeGrpcWeb(buffer) {
  const frames = [];
  let pos = 0;
  while (pos + 5 <= buffer.length) {
    const flags = buffer[pos];
    const len = buffer.readUInt32BE(pos + 1);
    pos += 5;
    const data = buffer.subarray(pos, pos + len);
    pos += len;
    frames.push({ flags, len, data, proto: (flags & 0x80) ? undefined : decodeProto(data) });
  }
  return frames;
}

async function grpcUnary(base, service, method, payload = Buffer.alloc(0), timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/${service}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
      body: frameGrpcWeb(payload),
      signal: controller.signal,
    });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: Object.fromEntries(response.headers), frames: decodeGrpcWeb(body) };
  } finally {
    clearTimeout(timer);
  }
}

async function openClientMonitoring(timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch('http://127.0.0.1:6015/iot_manager.IotManager/StartClientMonitoring', {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: frameGrpcWeb(Buffer.alloc(0)),
    signal: controller.signal,
  });
  clearTimeout(timer);
  if (!response.body) throw new Error('missing client monitoring body');
  const reader = response.body.getReader();
  const first = await reader.read();
  const frames = decodeGrpcWeb(Buffer.from(first.value || []));
  const sessionId = findText(frames.flatMap((frame) => frame.proto || []), (text) => /^[0-9a-f-]{36}$/i.test(text));
  return {
    sessionId,
    close: async () => {
      controller.abort();
      try { await reader.cancel(); } catch {}
    },
  };
}

function findText(fields, predicate) {
  for (const field of fields) {
    if (field.text && predicate(field.text)) return field.text;
    if (field.nested) {
      const found = findText(field.nested, predicate);
      if (found) return found;
    }
  }
  return undefined;
}

function startIotManager() {
  console.log(`[dryrun] starting ${IOT_MANAGER}`);
  const child = spawn(IOT_MANAGER, [], { cwd: IOT_DIR, windowsHide: true });
  child.stdout.on('data', (chunk) => process.stdout.write(`[iot:out] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[iot:err] ${chunk}`));
  child.on('exit', (code, signal) => console.log(`[dryrun] iot_manager exited code=${code} signal=${signal}`));
  return child;
}

function killByImage(image) {
  try {
    execFileSync('taskkill.exe', ['/IM', image, '/F'], { stdio: 'pipe' });
    console.log(`[dryrun] killed ${image}`);
  } catch {
    console.log(`[dryrun] no ${image} process to kill`);
  }
}

function fakeVersionResponse() {
  return Buffer.concat([str(1, '0.1.1'), str(2, 'fakehid'), str(3, '0.1.1-fakehid')]);
}

function fakeClientInfo() {
  return msg(1, Buffer.concat([u32(1, 999), str(2, 'fake-hid-session')]));
}

function fakeDevice() {
  return Buffer.concat([
    str(1, M68_DEVICE_PATHS[0]),
    u32(2, 0x19f5),
    u32(3, 0xfb2b),
    str(4, 'M68 HE'),
    str(5, 'G-COME'),
    u32(6, 0),
    u32(7, 1),
    u32(8, 6),
  ]);
}

function fakeIdentityReport(profileId) {
  const report = Buffer.alloc(64);
  report[0] = 0x8f;
  report.writeUInt32LE(profileId >>> 0, 1);
  return report;
}

function summarizeFrames(frames) {
  return frames.map((frame) => ({
    flags: frame.flags,
    len: frame.len,
    proto: frame.proto,
  }));
}

function fakeDeviceEventList() {
  const event = Buffer.concat([u32(1, 1), msg(2, fakeDevice())]);
  return msg(2, msg(1, event));
}

function iotReport({ reportId = 0, reportCount = 64, reportType = 0 }) {
  const parts = [];
  if (reportId !== 0) parts.push(u32(1, reportId));
  if (reportCount !== 0) parts.push(u32(2, reportCount));
  if (reportType !== 0) parts.push(u32(3, reportType));
  return Buffer.concat(parts);
}

function iotDeviceFilter({ deviceType, vendorId, productId, usage, usagePage, interfaceNumber }) {
  const parts = [
    u32(1, deviceType),
    u32(2, vendorId),
    u32(3, productId),
    u32(4, usage),
    u32(5, usagePage),
    msg(7, iotReport({ reportId: 0, reportCount: 64, reportType: 0 })),
  ];
  if (Number.isInteger(interfaceNumber)) parts.splice(5, 0, u32(6, interfaceNumber));
  return Buffer.concat(parts);
}

function addDeviceFilterRequest(sessionId) {
  const filters = [
    { deviceType: 4, vendorId: 0x19f5, productId: 0xffa1, usage: 1, usagePage: 0xff00 },
    { deviceType: 0, vendorId: 0x19f5, productId: 0xfb2b, usage: 0, usagePage: 0xff00, interfaceNumber: 1 },
    { deviceType: 0, vendorId: 0x19f5, productId: 0xfb2b, usage: 6, usagePage: 1 },
  ];
  return Buffer.concat([str(1, sessionId), ...filters.map((filter) => msg(2, iotDeviceFilter(filter)))]);
}

function startFakeHidServer() {
  const server = http2.createServer();
  const openMonitoringStreams = new Set();
  server.closeOpenStreams = () => {
    for (const stream of openMonitoringStreams) {
      try { stream.close(); } catch {}
    }
    openMonitoringStreams.clear();
  };

  server.on('stream', (stream, headers) => {
    const chunks = [];
    const path = headers[':path'];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const body = Buffer.concat(chunks);
      const frames = decodeGrpcWeb(body);
      fakeServerRequests += 1;
      captured.push({ profileId: activeProfileId, path, requestFrames: summarizeFrames(frames) });
      console.log(`[fake-hid] profile=${activeProfileId} ${headers[':method']} ${path} frames=${frames.length}`);

      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' });
      if (path === '/hid.HidService/GetVersion') {
        stream.end(grpcNativeOk(fakeVersionResponse()));
      } else if (path === '/hid.HidService/StartDeviceMonitoring') {
        openMonitoringStreams.add(stream);
        stream.on('close', () => openMonitoringStreams.delete(stream));
        stream.write(frameGrpcWeb(fakeClientInfo()));
        stream.write(frameGrpcWeb(fakeDeviceEventList()));
        setTimeout(() => {
          if (!stream.destroyed) stream.write(frameGrpcWeb(fakeDeviceEventList()));
        }, 500);
      } else if (path === '/hid.HidService/Write' || path === '/hid.HidService/SendFeatureReport') {
        stream.end(grpcNativeOk(Buffer.alloc(0)));
      } else if (path === '/hid.HidService/GetFeatureReport') {
        stream.end(grpcNativeOk(bytes(1, fakeIdentityReport(activeProfileId))));
      } else {
        stream.end(grpcNativeOk(Buffer.alloc(0)));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(FAKE_HID_PORT, '127.0.0.1', () => {
      server.off('error', reject);
      console.log(`[fake-hid] listening on h2c 127.0.0.1:${FAKE_HID_PORT}`);
      resolve(server);
    });
  });
}

function controlDeviceLightRequest(devicePath, sessionId, light) {
  const parts = [str(1, devicePath), str(4, sessionId)];
  if (light !== 0) parts.splice(1, 0, u32(2, light));
  return Buffer.concat(parts);
}

function controlDeviceLoopCheckStatusRequest(devicePath, sessionId, isStart) {
  const parts = [str(1, devicePath), str(4, sessionId)];
  if (isStart) parts.splice(1, 0, u32(2, 1));
  return Buffer.concat(parts);
}

async function callIot(method, payload, timeoutMs = 7000) {
  return grpcUnary(
    'http://127.0.0.1:6015',
    'iot_manager.IotManager',
    method,
    payload,
    timeoutMs,
  );
}

async function runProfileScenario(profileId, sessionId) {
  activeProfileId = profileId;
  const beforeCount = fakeServerRequests;
  console.log(`\n[dryrun] === candidate profile ${profileId} ===`);

  console.log('[dryrun] re-adding real M68 filters while fake HID is active');
  const addFilterResult = await callIot('AddDeviceFilter', addDeviceFilterRequest(sessionId));
  await sleep(2000);

  const perPath = [];
  for (const devicePath of M68_DEVICE_PATHS) {
    console.log(`[dryrun] nudging loop-check state for ${devicePath}`);
    const loopStop = await callIot('ControlDeviceLoopCheckStatus', controlDeviceLoopCheckStatusRequest(devicePath, sessionId, false));
    const loopStart = await callIot('ControlDeviceLoopCheckStatus', controlDeviceLoopCheckStatusRequest(devicePath, sessionId, true));
    await sleep(1000);

    console.log(`[dryrun] calling ControlDeviceLight(MUSIC=0) for ${devicePath}`);
    const musicResult = await callIot('ControlDeviceLight', controlDeviceLightRequest(devicePath, sessionId, 0));
    perPath.push({ devicePath, loopStop, loopStart, musicResult });
  }

  const scenarioCalls = captured.slice(beforeCount);
  const writeLikeCalls = scenarioCalls.filter((call) => (
    call.path === '/hid.HidService/Write'
    || call.path === '/hid.HidService/SendFeatureReport'
    || call.path === '/hid.HidService/GetFeatureReport'
  ));
  const result = { profileId, addFilterResult, perPath, fakeHidCallCount: scenarioCalls.length, writeLikeCallCount: writeLikeCalls.length, fakeHidCalls: scenarioCalls };
  scenarioResults.push(result);
  console.log(`[dryrun] profile ${profileId}: fake HID calls=${scenarioCalls.length}, write/read-like calls=${writeLikeCalls.length}`);
}

async function main() {
  let iot;
  let fake;
  let monitoring;
  try {
    killByImage('iot_manager_rs.exe');
    killByImage('common_hid_rs.exe');
    killByImage('rhythm_service.exe');
    killByImage('screen_capture_service.exe');

    iot = startIotManager();
    await waitForPort(IOT_PORT, 'iot_manager');

    monitoring = await openClientMonitoring();
    const sessionId = monitoring.sessionId;
    console.log(`[dryrun] session from StartClientMonitoring: ${sessionId || 'not found'}`);
    if (!sessionId) throw new Error('could not obtain IOT session id');

    console.log('[dryrun] adding real M68 filters to IOT manager session with real common_hid still active');
    const addFilterResult = await grpcUnary(
      'http://127.0.0.1:6015',
      'iot_manager.IotManager',
      'AddDeviceFilter',
      addDeviceFilterRequest(sessionId),
      7000,
    );
    console.log(JSON.stringify(addFilterResult, (key, value) => key === 'data' ? `<${value.length} bytes>` : value, 2));
    await sleep(1500);

    killByImage('common_hid_rs.exe');
    await sleep(500);
    if (await portOpen(FAKE_HID_PORT)) throw new Error('port 3838 still occupied after killing real common_hid');
    fake = await startFakeHidServer();

    for (const profileId of CANDIDATE_PROFILE_IDS) {
      await runProfileScenario(profileId, sessionId);
    }

    console.log('\n[dryrun] scenario summary:');
    console.log(JSON.stringify(scenarioResults, (key, value) => key === 'data' ? `<${value.length} bytes>` : value, 2));
  } finally {
    if (monitoring) await monitoring.close();
    if (fake) {
      if (typeof fake.closeOpenStreams === 'function') fake.closeOpenStreams();
      await new Promise((resolve) => fake.close(resolve));
    }
    if (iot && !iot.killed) iot.kill();
    await sleep(500);
    killByImage('iot_manager_rs.exe');
    killByImage('common_hid_rs.exe');
    killByImage('rhythm_service.exe');
    killByImage('screen_capture_service.exe');
  }
}

main().catch((error) => {
  console.error('[dryrun] failed:', error?.stack ? error.stack : error);
  process.exitCode = 1;
});
