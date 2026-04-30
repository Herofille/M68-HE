const { spawn } = require('node:child_process');
const net = require('node:net');

const IOT_DIR = 'C:/Program Files/iot_manager';
const COMMON_HID = `${IOT_DIR}/common_hid_rs.exe`;

const SESSION_ID = `m68-readonly-${Date.now()}`;

const SERVICES = {
  hid: 'http://127.0.0.1:3838',
};

const SAFE_METHODS = new Set([
  '/hid.HidService/GetVersion',
  '/hid.HidService/StartDeviceMonitoring',
]);

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

async function waitForPort(port, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(250);
  }
  console.log(`[probe] ${label} port ${port} did not open within ${timeoutMs}ms`);
  return false;
}

function startProcess(exe, label) {
  console.log(`[probe] starting ${label}: ${exe}`);
  const child = spawn(exe, [], { cwd: IOT_DIR, windowsHide: true });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${label}:out] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}:err] ${chunk}`));
  child.on('exit', (code, signal) => console.log(`[probe] ${label} exited code=${code} signal=${signal}`));
  return child;
}

function stopProcess(child, label) {
  if (!child || child.killed) return;
  console.log(`[probe] stopping ${label} pid=${child.pid}`);
  child.kill();
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

function msg(field, body) {
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
}

function frameGrpcWeb(payload) {
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
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
    } else if (wire === 5) {
      fields.push({ field, wire, value: buffer.readUInt32LE(pos) });
      pos += 4;
    } else if (wire === 1) {
      fields.push({ field, wire, hex: buffer.subarray(pos, pos + 8).toString('hex') });
      pos += 8;
    } else {
      fields.push({ field, wire, unsupported: true });
      break;
    }
  }
  return fields;
}

function decodeGrpcWeb(buffer) {
  const messages = [];
  let pos = 0;
  while (pos + 5 <= buffer.length) {
    const flags = buffer[pos];
    const len = buffer.readUInt32BE(pos + 1);
    pos += 5;
    const data = buffer.subarray(pos, pos + len);
    pos += len;
    messages.push({ flags, len, data, proto: (flags & 0x80) ? undefined : decodeProto(data) });
  }
  return messages;
}

async function grpc(base, service, method, payload = Buffer.alloc(0), timeoutMs = 5000) {
  const path = `/${service}/${method}`;
  if (!SAFE_METHODS.has(path)) throw new Error(`blocked unsafe method ${path}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/grpc-web+proto',
        'x-grpc-web': '1',
      },
      body: frameGrpcWeb(payload),
      signal: controller.signal,
    });
    const body = Buffer.from(await response.arrayBuffer());
    return { ok: response.ok, status: response.status, headers: Object.fromEntries(response.headers), frames: decodeGrpcWeb(body) };
  } finally {
    clearTimeout(timer);
  }
}

function takeGrpcWebFrames(buffer) {
  const frames = [];
  let pos = 0;
  while (pos + 5 <= buffer.length) {
    const flags = buffer[pos];
    const len = buffer.readUInt32BE(pos + 1);
    if (pos + 5 + len > buffer.length) break;
    pos += 5;
    const data = buffer.subarray(pos, pos + len);
    pos += len;
    frames.push({ flags, len, data, proto: (flags & 0x80) ? undefined : decodeProto(data) });
  }
  return { frames, rest: buffer.subarray(pos) };
}

async function grpcStreamSample(base, service, method, payload = Buffer.alloc(0), timeoutMs = 5000) {
  const path = `/${service}/${method}`;
  if (!SAFE_METHODS.has(path)) throw new Error(`blocked unsafe method ${path}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const frames = [];
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/grpc-web+proto',
        'x-grpc-web': '1',
      },
      body: frameGrpcWeb(payload),
      signal: controller.signal,
    });
    let rest = Buffer.alloc(0);
    if (!response.body) return { ok: response.ok, status: response.status, headers: Object.fromEntries(response.headers), frames };
    const reader = response.body.getReader();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        sleep(Math.min(deadline - Date.now(), 1000)).then(() => ({ timeout: true })),
      ]);
      if (read.timeout) break;
      if (read.done) break;
      rest = Buffer.concat([rest, Buffer.from(read.value)]);
      const parsed = takeGrpcWebFrames(rest);
      frames.push(...parsed.frames);
      rest = parsed.rest;
      if (frames.length >= 10) break;
    }
    try { await reader.cancel(); } catch {}
    return { ok: response.ok, status: response.status, headers: Object.fromEntries(response.headers), frames };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return { ok: false, aborted: true, frames };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function printResult(label, result) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(result, (key, value) => key === 'data' ? `<${value.length} bytes>` : value, 2));
}

function hidDeviceFilter({ vendorId, productId, usagePage, usage, interfaceNumber }) {
  const parts = [
    u32(1, vendorId),
    u32(2, productId),
    u32(3, usagePage),
    u32(4, usage),
  ];
  if (Number.isInteger(interfaceNumber)) parts.push(u32(5, interfaceNumber));
  return Buffer.concat(parts);
}

function hidStartDeviceMonitoringRequest(filters) {
  return Buffer.concat(filters.map((filter) => msg(1, hidDeviceFilter(filter))));
}

async function main() {
  const started = [];
  if (!(await portOpen(3838))) {
    started.push(['common_hid', startProcess(COMMON_HID, 'common_hid')]);
    await waitForPort(3838, 'common_hid', 10000);
  }

  try {
    console.log(`[probe] session=${SESSION_ID}`);
    console.log('[probe] SAFE MODE: not calling Write, SendFeatureReport, ControlFeature, ControlDeviceLight, or IotManager session APIs.');

    if (await portOpen(3838)) {
      printResult('HidService.GetVersion', await grpc(SERVICES.hid, 'hid.HidService', 'GetVersion'));
    }

    const filters = [
      { vendorId: 0x19f5, productId: 0xffa1, usagePage: 0xff00, usage: 1 },
      { vendorId: 0x19f5, productId: 0xfb2b, usagePage: 0xff00, usage: 0, interfaceNumber: 1 },
      { vendorId: 0x19f5, productId: 0xfb2b, usagePage: 1, usage: 6 },
    ];
    console.log('\n[probe] monitoring only real M68 filters:', JSON.stringify(filters));
    if (await portOpen(3838)) {
      printResult(
        'HidService.StartDeviceMonitoring(real M68 filters, stream sample)',
        await grpcStreamSample(SERVICES.hid, 'hid.HidService', 'StartDeviceMonitoring', hidStartDeviceMonitoringRequest(filters), 5000),
      );
    }
  } finally {
    for (const [label, child] of started.reverse()) stopProcess(child, label);
    await sleep(500);
  }
}

main().catch((error) => {
  console.error('[probe] failed:', error?.stack ? error.stack : error);
  process.exitCode = 1;
});
