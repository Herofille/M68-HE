/**
 * WebHID Manager - Connects to keyboard and manages communication
 *
 * M68 HE / K68 exposes two HID interfaces with different PIDs:
 *   - PID 0xFB2B (64299): Keyboard interface (usagePage:1) — NO vendor reports
 *   - PID 0xFFA1 (65425): Vendor-specific interface (usagePage:0xFF00) — has output reports for RGB
 */

// Known device filters (from hedriver.com source)
const HE_KEYBOARD_FILTERS = [
  // M68 HE / K68 — vendor-specific interface (RGB control)
  { vendorId: 0x19F5, productId: 0xFFA1, usagePage: 0xFF00, usage: 1 },
  // Fallback: also match keyboard interface (user can still pick it)
  { vendorId: 0x19F5, productId: 0xFB2B, usagePage: 1, usage: 0 },
  // Other Step One HE models (from hedriver.com filters)
  { vendorId: 0x19F5, productId: 0xFF7B, usagePage: 0xFF00, usage: 1 },
  { vendorId: 0x19F5, productId: 0xFF81, usagePage: 0xFF00, usage: 1 },
  { vendorId: 0x19F5, productId: 0xFF8B, usagePage: 0xFF00, usage: 1 },
];

export class HIDManager {
  constructor() {
    this.device = null;
    this.isConnected = false;
    this.listeners = new Map();
    this.inputReportLog = [];
    this.captureActive = false;
    this.pendingInputReports = [];
    this.recentInputReports = [];
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const cbs = this.listeners.get(event) || [];
    cbs.forEach(cb => {
      cb(data);
    });
  }

  async connect() {
    if (!('hid' in navigator)) {
      throw new Error('WebHID is not supported in this browser. Use Chrome or Edge.');
    }

    try {
      // First try with specific VID/PID/usagePage filters for vendor-specific interface
      let devices = await navigator.hid.requestDevice({ filters: HE_KEYBOARD_FILTERS });
      if (!devices || devices.length === 0) {
        throw new Error('No device selected.');
      }

      // Prefer the vendor-specific device (usagePage 0xFF00) over keyboard interface
      let selected = devices.find(d =>
        d.collections?.some(c => c.usagePage === 0xFF00)
      ) || devices[0];

      this.device = selected;

      if (!this.device.opened) {
        await this.device.open();
      }

      this.isConnected = true;

      // Validate: check if we have output reports
      const hasOutputReports = this.device.collections?.some(c =>
        c.outputReports && c.outputReports.length > 0
      );
      if (!hasOutputReports) {
        console.warn('[HID] WARNING: Connected device has no output reports!');
        console.warn('[HID] You may have selected the keyboard interface (PID 0xFB2B) instead of the vendor interface (PID 0xFFA1).');
        console.warn('[HID] Try disconnecting and reconnecting — pick the OTHER "M68 HE" entry in the device picker.');
      } else {
        console.log('[HID] Connected to vendor-specific interface with output reports.');
      }

      // Listen for input reports
      this.device.addEventListener('inputreport', (event) => {
        this._handleInputReport(event);
      });

      this.emit('connected', this.getDeviceInfo());
      return this.getDeviceInfo();
    } catch (err) {
      this.isConnected = false;
      throw err;
    }
  }

  async disconnect() {
    if (this.device && this.device.opened) {
      await this.device.close();
    }
    this.device = null;
    this.isConnected = false;
    this.emit('disconnected');
  }

  getDeviceInfo() {
    if (!this.device) return null;
    const d = this.device;
    return {
      productName: d.productName,
      vendorId: d.vendorId,
      productId: d.productId,
      opened: d.opened,
      collections: d.collections.map((col, i) => ({
        index: i,
        usage: col.usage,
        usagePage: col.usagePage,
        inputReports: col.inputReports?.map(r => ({
          reportId: r.reportId,
          items: r.items?.map(item => ({
            usagePage: item.usagePage,
            usageMinimum: item.usageMinimum,
            usageMaximum: item.usageMaximum,
            reportSize: item.reportSize,
            reportCount: item.reportCount,
            isAbsolute: item.isAbsolute,
            isRange: item.isRange,
          }))
        })) || [],
        outputReports: col.outputReports?.map(r => ({
          reportId: r.reportId,
          items: r.items?.map(item => ({
            usagePage: item.usagePage,
            reportSize: item.reportSize,
            reportCount: item.reportCount,
          }))
        })) || [],
        featureReports: col.featureReports?.map(r => ({
          reportId: r.reportId,
          items: r.items?.map(item => ({
            usagePage: item.usagePage,
            reportSize: item.reportSize,
            reportCount: item.reportCount,
          }))
        })) || [],
        children: col.children?.length || 0,
      }))
    };
  }

  _handleInputReport(event) {
    const { data, device, reportId } = event;
    const bytes = new Uint8Array(data.buffer);
    const entry = {
      timestamp: Date.now(),
      reportId,
      data: bytes,
      type: 'input',
    };

    this.recentInputReports.push(entry);
    if (this.recentInputReports.length > 20) this.recentInputReports.shift();
    this.emit('raw-inputreport', entry);

    for (let i = this.pendingInputReports.length - 1; i >= 0; i--) {
      const pending = this.pendingInputReports[i];
      if (!pending.predicate || pending.predicate(entry)) {
        clearTimeout(pending.timer);
        this.pendingInputReports.splice(i, 1);
        pending.resolve(entry);
      }
    }

    if (this.captureActive) {
      this.inputReportLog.push(entry);
      this.emit('inputreport', entry);
    }
  }

  waitForInputReport(predicate, timeoutMs = 1000) {
    if (!this.device || !this.device.opened) {
      return Promise.reject(new Error('Device not connected'));
    }

    return new Promise((resolve, reject) => {
      const pending = {
        predicate,
        resolve,
        reject,
        timer: null,
      };
      pending.timer = setTimeout(() => {
        const index = this.pendingInputReports.indexOf(pending);
        if (index >= 0) this.pendingInputReports.splice(index, 1);
        reject(new Error('Timed out waiting for input report'));
      }, timeoutMs);
      this.pendingInputReports.push(pending);
    });
  }

  getRecentInputReports(limit = 5) {
    return this.recentInputReports.slice(-limit);
  }

  startCapture() {
    this.captureActive = true;
    this.emit('capture-started');
  }

  stopCapture() {
    this.captureActive = false;
    this.emit('capture-stopped');
  }

  clearCapture() {
    this.inputReportLog = [];
    this.emit('capture-cleared');
  }

  async sendOutputReport(reportId, data) {
    if (!this.device || !this.device.opened) {
      throw new Error('Device not connected');
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this.device.sendReport(reportId, bytes);
    this.emit('report-sent', { type: 'output', reportId, data: bytes });
  }

  async sendFeatureReport(reportId, data) {
    if (!this.device || !this.device.opened) {
      throw new Error('Device not connected');
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this.device.sendFeatureReport(reportId, bytes);
    this.emit('report-sent', { type: 'feature', reportId, data: bytes });
  }

  async receiveFeatureReport(reportId) {
    if (!this.device || !this.device.opened) {
      throw new Error('Device not connected');
    }
    const dataView = await this.device.receiveFeatureReport(reportId);
    const bytes = new Uint8Array(dataView.buffer);
    this.emit('feature-received', { reportId, data: bytes });
    return bytes;
  }

  getAvailableReportIds() {
    if (!this.device) return { input: [], output: [], feature: [] };
    const result = { input: [], output: [], feature: [] };
    for (const col of this.device.collections) {
      for (const r of (col.inputReports || [])) result.input.push(r.reportId);
      for (const r of (col.outputReports || [])) result.output.push(r.reportId);
      for (const r of (col.featureReports || [])) result.feature.push(r.reportId);
    }
    return result;
  }
}
