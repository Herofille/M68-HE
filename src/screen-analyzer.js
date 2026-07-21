/**
 * Screen Color Analyzer — captures screen pixels and maps them to keyboard zones.
 * Used by the Screen Mirror effect to reflect on-screen content on the keyboard.
 */
export class ScreenAnalyzer {
  constructor() {
    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.isActive = false;
    this._lastSample = null;
    this._previewCanvas = null;
    this._gridCols = 16;
    this._gridRows = 5;
  }

  /**
   * Start screen capture.
   * Returns a promise that resolves when video is ready.
   */
  async start() {
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 320 }, height: { ideal: 100 }, frameRate: { ideal: 15 } },
      audio: false,
    });

    this.video = document.createElement('video');
    this.video.srcObject = this.stream;
    this.video.playsInline = true;
    this.video.muted = true;
    await this.video.play();

    // Pre-scale canvas — 320×100 matches the video capture size exactly,
    // so drawImage doesn't lose color fidelity through tiny downscale.
    this.canvas = document.createElement('canvas');
    this.canvas.width = 320;
    this.canvas.height = 100;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });

    // Target grid is 16 cols × 5 rows
    this._gridCols = 16;
    this._gridRows = 5;

    this.isActive = true;

    // Watch for stream end (user stops sharing)
    this.stream.getVideoTracks()[0].addEventListener('ended', () => this.stop());
  }

  /**
   * Attach a preview canvas element. The sampled 16×5 grid will be drawn
   * here (scaled up) so the user can see exactly what the keyboard sees.
   * @param {HTMLCanvasElement} el
   */
  setPreviewCanvas(el) {
    this._previewCanvas = el;
    if (el) {
      el.width = 160;
      el.height = 50;
    }
  }

  /**
   * Sample current video frame, returning a 5×16 grid of {r,g,b} colors.
   * Returns null if capture is not active.
   */
  sample() {
    if (!this.isActive || !this.video || !this.ctx) return this._lastSample;

    try {
      this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      const pw = this.canvas.width / this._gridCols;   // pixels per cell
      const ph = this.canvas.height / this._gridRows;

      const grid = [];
      for (let row = 0; row < this._gridRows; row++) {
        const rowColors = [];
        for (let col = 0; col < this._gridCols; col++) {
          // Sample a block from the full-res canvas for accurate color averaging
          const block = this.ctx.getImageData(
            Math.floor(col * pw), Math.floor(row * ph),
            Math.ceil(pw), Math.ceil(ph)
          );
          let sr = 0, sg = 0, sb = 0;
          const len = block.data.length;
          for (let i = 0; i < len; i += 4) {
            sr += block.data[i];
            sg += block.data[i + 1];
            sb += block.data[i + 2];
          }
          const count = len / 4;
          rowColors.push({
            r: Math.round(sr / count),
            g: Math.round(sg / count),
            b: Math.round(sb / count),
          });
        }
        grid.push(rowColors);
      }
      this._lastSample = grid;

      this._drawPreview(grid);
      return grid;
    } catch (_) {
      return this._lastSample;
    }
  }

  /** Draw sampled grid to the preview canvas (scaled up). */
  _drawPreview(grid) {
    const el = this._previewCanvas;
    if (!el || !grid) return;
    const pctx = el.getContext('2d', { willReadFrequently: false });
    if (!pctx) return;
    const cw = el.width, ch = el.height;
    const pw = cw / 16, ph = ch / 5;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 16; c++) {
        const px = grid[r]?.[c] || { r: 0, g: 0, b: 0 };
        pctx.fillStyle = `rgb(${px.r},${px.g},${px.b})`;
        pctx.fillRect(c * pw, r * ph, pw, ph);
      }
    }
  }

  /** Stop screen capture and clean up. */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
    this.ctx = null;
    this.canvas = null;
    this._previewCanvas = null;
    this.isActive = false;
    this._lastSample = null;
  }
}
