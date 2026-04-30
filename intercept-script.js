// ============================================================
// WebHID Interceptor Script for hedriver.com
// ============================================================
// 
// HOW TO USE:
// 1. Open https://www.hedriver.com/ in Chrome
// 2. Press F12 to open DevTools
// 3. Go to the Console tab
// 4. Paste this ENTIRE script and press Enter
// 5. Now click "Connect" on hedriver.com and connect your keyboard
// 6. Change an RGB effect (e.g. switch from one effect to another)
// 7. All sent commands will be logged in the console
// 8. Copy the logged output and share it
//
// The script intercepts sendReport() and sendFeatureReport()
// calls to see exactly what the website sends to your keyboard.
// ============================================================

(function() {
  const logs = [];
  
  // Store original methods
  const origSendReport = HIDDevice.prototype.sendReport;
  const origSendFeatureReport = HIDDevice.prototype.sendFeatureReport;
  const origReceiveFeatureReport = HIDDevice.prototype.receiveFeatureReport;
  const origOpen = HIDDevice.prototype.open;

  function toHex(data) {
    const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer || data);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  // Intercept sendReport (output reports)
  HIDDevice.prototype.sendReport = function(reportId, data) {
    const hex = toHex(data);
    const entry = {
      time: new Date().toISOString(),
      type: 'OUTPUT',
      reportId: reportId,
      length: data.byteLength || data.length,
      hex: hex
    };
    logs.push(entry);
    console.log(
      `%c[HID OUTPUT] %cID:${reportId} %c(${entry.length}B)%c ${hex}`,
      'color: #22c55e; font-weight: bold',
      'color: #3b82f6',
      'color: #888',
      'color: #eab308; font-family: monospace'
    );
    return origSendReport.call(this, reportId, data);
  };

  // Intercept sendFeatureReport
  HIDDevice.prototype.sendFeatureReport = function(reportId, data) {
    const hex = toHex(data);
    const entry = {
      time: new Date().toISOString(),
      type: 'FEATURE_WRITE',
      reportId: reportId,
      length: data.byteLength || data.length,
      hex: hex
    };
    logs.push(entry);
    console.log(
      `%c[HID FEATURE WRITE] %cID:${reportId} %c(${entry.length}B)%c ${hex}`,
      'color: #f97316; font-weight: bold',
      'color: #3b82f6',
      'color: #888',
      'color: #c084fc; font-family: monospace'
    );
    return origSendFeatureReport.call(this, reportId, data);
  };

  // Intercept receiveFeatureReport
  HIDDevice.prototype.receiveFeatureReport = async function(reportId) {
    console.log(
      `%c[HID FEATURE READ] %cID:${reportId}`,
      'color: #06b6d4; font-weight: bold',
      'color: #3b82f6'
    );
    const result = await origReceiveFeatureReport.call(this, reportId);
    const hex = toHex(result);
    console.log(
      `%c[HID FEATURE READ RESPONSE] %cID:${reportId} %c${hex}`,
      'color: #06b6d4',
      'color: #3b82f6',
      'color: #888; font-family: monospace'
    );
    return result;
  };

  // Intercept open to know when device is connected
  HIDDevice.prototype.open = async function() {
    console.log(
      `%c[HID OPEN] %c${this.productName} (VID:0x${this.vendorId.toString(16)} PID:0x${this.productId.toString(16)})`,
      'color: #22c55e; font-weight: bold',
      'color: white'
    );
    console.log('[HID OPEN] Collections:', this.collections);
    return origOpen.call(this);
  };

  // Helper: dump all logs
  window.dumpHIDLogs = function() {
    console.log('=== ALL HID OUTPUT LOGS ===');
    logs.forEach(l => {
      console.log(`[${l.time}] ${l.type} ID:${l.reportId} (${l.length}B): ${l.hex}`);
    });
    console.log(`=== Total: ${logs.length} commands ===`);
    
    // Also copy to clipboard
    const text = logs.map(l => `${l.type} ID:${l.reportId} (${l.length}B): ${l.hex}`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      console.log('%c Copied to clipboard!', 'color: #22c55e; font-weight: bold');
    });
    return logs;
  };

  // Helper: clear logs
  window.clearHIDLogs = function() {
    logs.length = 0;
    console.log('Logs cleared.');
  };

  console.log('%c WebHID Interceptor Active!', 'color: #22c55e; font-weight: bold; font-size: 16px');
  console.log('%c Now connect your keyboard on hedriver.com and change an effect.', 'color: #eab308');
  console.log('%c Type dumpHIDLogs() to see all captured output commands.', 'color: #888');
  console.log('%c Type clearHIDLogs() to reset.', 'color: #888');
})();
