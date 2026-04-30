/**
 * WebSocket HID Client — connects to hid-server.js for native USB speed.
 * Drop-in replacement for WebHID sendOutputReport path.
 * 
 * Usage:
 *   const ws = new HIDWebSocketClient();
 *   await ws.connect();     // connect to hid-server
 *   ws.initKeyboard();      // set custom mode + fast model
 *   ws.sendRGBFrame(data);  // send mapped 68-key RGB frame via 0xDD base-key chunks
 */

export class HIDWebSocketClient {
  constructor(url = 'ws://localhost:8484') {
    this.url = url;
    this.ws = null;
    this.isConnected = false;
    this.isKeyboardReady = false;
    this.onStats = null;
    this._resolvers = {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          console.log('[WS-HID] Connected to native HID server');
          this.isConnected = true;
          // Auto-connect keyboard
          this._send({ cmd: 'connect' });
          resolve();
        };

        this.ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) return; // ignore binary (unused)
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            case 'connected':
              console.log(`[WS-HID] Keyboard opened: ${msg.product}`);
              this.isKeyboardReady = false;
              break;
            case 'ready':
              console.log('[WS-HID] Keyboard initialized (custom mode + fast model)');
              this.isKeyboardReady = true;
              break;
            case 'stats':
              console.log(`[WS-HID] Native HID: avg=${msg.avgWriteMs}ms/write, total=${msg.totalWrites}`);
              if (this.onStats) this.onStats(msg);
              break;
            case 'effect_set':
              console.log(`[WS-HID] Effect set: mode=0x${msg.mode.toString(16)}`);
              break;
            case 'error':
              console.error(`[WS-HID] Error: ${msg.msg}`);
              break;
            case 'disconnected':
              console.log('[WS-HID] Keyboard disconnected');
              this.isKeyboardReady = false;
              break;
          }
        };

        this.ws.onclose = () => {
          console.log('[WS-HID] Disconnected from server');
          this.isConnected = false;
          this.isKeyboardReady = false;
        };

        this.ws.onerror = (err) => {
          console.error('[WS-HID] Connection failed. Is hid-server.js running?');
          reject(new Error('WebSocket connection failed'));
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  disconnect() {
    if (this.ws) {
      this._send({ cmd: 'disconnect' });
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isKeyboardReady = false;
  }

  initKeyboard(brightness = 100) {
    this._send({ cmd: 'init', brightness });
  }

  /**
   * Send a raw mapped RGB frame as binary (fastest path).
   * @param {Uint8Array} rgbData - 68 keys × 3 bytes RGB
   */
  sendRGBFrame(rgbData) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (rgbData instanceof Uint8Array) {
      this.ws.send(rgbData.buffer.slice(rgbData.byteOffset, rgbData.byteOffset + rgbData.byteLength));
      return;
    }
    this.ws.send(rgbData);
  }

  /**
   * Compatibility wrapper for older partial-frame callers. The native server uses
   * command 0xDD and writes only the base 68 physical keys; the mask is ignored
   * and the latest complete base-key frame is sent.
   * @param {Uint8Array} rgbData - full 204-byte buffer (only flagged chunks are written)
   * @param {number} chunkMask - bitmask, e.g. 0b1001 = chunks 0 and 3
   */
  sendPartialRGBFrame(rgbData, chunkMask) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const buf = new Uint8Array(205);
    buf[0] = chunkMask & 0xFF;
    buf.set(rgbData instanceof Uint8Array ? rgbData : new Uint8Array(rgbData), 1);
    this.ws.send(buf.buffer);
  }

  /**
   * Set a firmware effect mode
   */
  setEffect(mode, opts = {}) {
    this._send({
      cmd: 'effect',
      mode,
      speed: opts.speed || 0x32,
      brightness: opts.brightness || 100,
      direction: opts.direction || 0x03,
      color1: opts.color1 || [255, 0, 0],
      color2: opts.color2 || [0, 0, 255],
    });
  }

  requestStats() {
    this._send({ cmd: 'stats' });
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}
