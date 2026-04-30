/**
 * RGB Effects Engine - Generates color data for keyboard effects
 * Works independently of the HID protocol - outputs color arrays
 * that get mapped to HID commands via a protocol adapter
 */

// Website-style 65% keyboard layout. Labels match the hedriver/qmk visual preview
// and the physical legends: Ins / Del / PGUP / PGDN on the right cluster.
export const KEYBOARD_LAYOUT = {
  rows: 5,
  cols: 16,
  totalKeys: 68,
  keyMap: [
    ['ESC','1 !','2 @','3 #','4 $','5 %','6 ^','7 &','8 *','9 (','0 )','- _','+ =','BACK','Ins'],
    ['TAB','Q','W','E','R','T','Y','U','I','O','P','[ {','] }','\\ |','Del'],
    ['CAPS','A','S','D','F','G','H','J','K','L','; :','\" \'','ENTER','','PGUP'],
    ['SHIFT','Z','X','C','V','B','N','M',', <','. >','/ ?','SHIFT','','↑','PGDN'],
    ['CTRL','WIN','ALT','','','SPACE','','','ALT','FN1','Ctrl','←','↓','→',''],
  ]
};

export class EffectsEngine {
  constructor() {
    this.running = false;
    this.currentEffect = 'rainbow-wave';
    this.frameCallback = null;
    this.animFrame = null;
    this.lastTime = 0;
    this.elapsed = 0;

    // Settings
    this.speed = 50;
    this.brightness = 200;
    this.color1 = { r: 255, g: 0, b: 0 };
    this.color2 = { r: 0, g: 0, b: 255 };
    this.direction = 'left';

    // Key state for reactive effects
    this.keyStates = new Array(KEYBOARD_LAYOUT.rows).fill(null)
      .map(() => new Array(KEYBOARD_LAYOUT.cols).fill(0));

    // Color buffer: [row][col] = {r, g, b}
    this.colorBuffer = this._createBuffer();
  }

  _createBuffer() {
    return new Array(KEYBOARD_LAYOUT.rows).fill(null)
      .map(() => new Array(KEYBOARD_LAYOUT.cols).fill(null).map(() => ({ r: 0, g: 0, b: 0 })));
  }

  setEffect(name) { this.currentEffect = name; }
  setSpeed(val) { this.speed = val; }
  setBrightness(val) { this.brightness = val; }
  setDirection(val) { this.direction = val; }

  setColor1(hex) {
    this.color1 = hexToRgb(hex);
  }

  setColor2(hex) {
    this.color2 = hexToRgb(hex);
  }

  onFrame(callback) {
    this.frameCallback = callback;
  }

  triggerKey(row, col) {
    if (row >= 0 && row < KEYBOARD_LAYOUT.rows && col >= 0 && col < KEYBOARD_LAYOUT.cols) {
      this.keyStates[row][col] = 1.0;
    }
  }

  start() {
    this.running = true;
    this.lastTime = performance.now();
    this.elapsed = 0;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
  }

  _loop() {
    if (!this.running) return;

    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.elapsed += dt * (this.speed / 50);

    this._computeFrame();

    if (this.frameCallback) {
      this.frameCallback(this.colorBuffer);
    }

    this.animFrame = requestAnimationFrame(() => this._loop());
  }

  _computeFrame() {
    const t = this.elapsed;
    const br = this.brightness / 255;

    switch (this.currentEffect) {
      case 'rainbow-wave': this._rainbowWave(t, br); break;
      case 'breathing': this._breathing(t, br); break;
      case 'color-cycle': this._colorCycle(t, br); break;
      case 'reactive': this._reactive(t, br); break;
      case 'rain': this._digitalRain(t, br); break;
      case 'gradient': this._staticGradient(br); break;
      case 'fire': this._fire(t, br); break;
      case 'ripple': this._ripple(t, br); break;
    }
  }

  _rainbowWave(t, br) {
    for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
      for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
        let phase;
        switch (this.direction) {
          case 'right': phase = -c / KEYBOARD_LAYOUT.cols; break;
          case 'up': phase = r / KEYBOARD_LAYOUT.rows; break;
          case 'down': phase = -r / KEYBOARD_LAYOUT.rows; break;
          case 'center': {
            const cx = KEYBOARD_LAYOUT.cols / 2, cy = KEYBOARD_LAYOUT.rows / 2;
            phase = Math.sqrt((c - cx) ** 2 + (r - cy) ** 2) / 10;
            break;
          }
          default: phase = c / KEYBOARD_LAYOUT.cols;
        }
        const hue = ((t * 0.5 + phase) % 1 + 1) % 1;
        const rgb = hslToRgb(hue, 1.0, 0.5);
        this.colorBuffer[r][c] = { r: rgb.r * br, g: rgb.g * br, b: rgb.b * br };
      }
    }
  }

  _breathing(t, br) {
    const intensity = (Math.sin(t * 2) + 1) / 2;
    for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
      for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
        this.colorBuffer[r][c] = {
          r: this.color1.r * intensity * br,
          g: this.color1.g * intensity * br,
          b: this.color1.b * intensity * br,
        };
      }
    }
  }

  _colorCycle(t, br) {
    const hue = (t * 0.3) % 1;
    const rgb = hslToRgb(hue, 1.0, 0.5);
    for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
      for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
        this.colorBuffer[r][c] = { r: rgb.r * br, g: rgb.g * br, b: rgb.b * br };
      }
    }
  }

  _reactive(t, br) {
    for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
      for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
        const state = this.keyStates[r][c];
        if (state > 0.01) {
          const rgb = lerpColor(this.color1, this.color2, 1 - state);
          this.colorBuffer[r][c] = { r: rgb.r * state * br, g: rgb.g * state * br, b: rgb.b * state * br };
          this.keyStates[r][c] *= 0.95;
        } else {
          this.keyStates[r][c] = 0;
          this.colorBuffer[r][c] = { r: 0, g: 0, b: 0 };
        }
      }
    }
  }

  _digitalRain(t, br) {
    // Shift existing colors down
    for (let r = KEYBOARD_LAYOUT.rows - 1; r > 0; r--) {
      for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
        const above = this.colorBuffer[r - 1][c];
        this.colorBuffer[r][c] = {
          r: above.r * 0.7,
          g: above.g * 0.85,
          b: above.b * 0.7,
        };
      }
    }
    // Random drops on top row
    for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
      if (Math.random() < 0.08) {
        this.colorBuffer[0][c] = { r: 0, g: 255 * br, b: 0 };
      } else {
        const existing = this.colorBuffer[0][c];
        this.colorBuffer[0][c] = {
          r: existing.r * 0.6,
          g: existing.g * 0.6,
          b: existing.b * 0.6,
        };
      }
    }
  }

  _staticGradient(br) {
    for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
      for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
        let t;
        switch (this.direction) {
          case 'right': t = 1 - c / (KEYBOARD_LAYOUT.cols - 1); break;
          case 'up': t = r / (KEYBOARD_LAYOUT.rows - 1); break;
          case 'down': t = 1 - r / (KEYBOARD_LAYOUT.rows - 1); break;
          default: t = c / (KEYBOARD_LAYOUT.cols - 1);
        }
        const rgb = lerpColor(this.color1, this.color2, t);
        this.colorBuffer[r][c] = { r: rgb.r * br, g: rgb.g * br, b: rgb.b * br };
      }
    }
  }

  _fire(t, br) {
    // Bottom row = bright fire source
    for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
      const flicker = 0.6 + Math.random() * 0.4;
      this.colorBuffer[KEYBOARD_LAYOUT.rows - 1][c] = {
        r: 255 * flicker * br,
        g: (80 + Math.random() * 100) * flicker * br,
        b: 0,
      };
    }
    // Propagate upward with cooling
    for (let r = 0; r < KEYBOARD_LAYOUT.rows - 1; r++) {
      for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
        const below = this.colorBuffer[r + 1][c];
        const cool = 0.55 + Math.random() * 0.2;
        this.colorBuffer[r][c] = {
          r: Math.max(0, below.r * cool),
          g: Math.max(0, below.g * cool * 0.7),
          b: 0,
        };
      }
    }
  }

  _ripple(t, br) {
    const cx = KEYBOARD_LAYOUT.cols / 2;
    const cy = KEYBOARD_LAYOUT.rows / 2;
    const waveRadius = (t * 4) % 20;

    for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
      for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
        const dist = Math.sqrt((c - cx) ** 2 + ((r - cy) * 3) ** 2);
        const wave = Math.max(0, 1 - Math.abs(dist - waveRadius) / 2);
        const rgb = lerpColor(this.color1, this.color2, wave);
        this.colorBuffer[r][c] = {
          r: rgb.r * wave * br,
          g: rgb.g * wave * br,
          b: rgb.b * wave * br,
        };
      }
    }
  }

  _isPhysicalKey(row, col) {
    return Boolean(KEYBOARD_LAYOUT.keyMap[row]?.[col]);
  }

  _clearMusicBuffer() {
    for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
      for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
        this.colorBuffer[r][c] = { r: 0, g: 0, b: 0 };
      }
    }
  }

  _forEachPhysicalKey(callback) {
    for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
      for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
        if (!this._isPhysicalKey(r, c)) continue;
        callback(r, c, this._keyGeometry(r, c));
      }
    }
  }

  _keyGeometry(row, col) {
    // Real 65% keyboards are row-staggered: lower rows sit slightly to the right.
    // Use that gentle diagonal so frequency fields flow through physical key centers,
    // not through imaginary straight columns.
    const visibleCols = KEYBOARD_LAYOUT.keyMap[0].length;
    const rowStagger = [0, 0.35, 0.65, 0.95, 1.45][row] || 0;
    const x = col + rowStagger;
    const maxX = visibleCols - 1 + rowStagger;
    return {
      x,
      y: row,
      nx: Math.max(0, Math.min(1, x / maxX)),
      ny: row / Math.max(1, KEYBOARD_LAYOUT.rows - 1),
    };
  }

  _sampleFrequencyAt(bands, nx) {
    if (!bands.length) return 0;
    // Left side is treble, right side is bass.
    const bandPos = (1 - nx) * (bands.length - 1);
    const lo = Math.max(0, Math.min(bands.length - 1, Math.floor(bandPos)));
    const hi = Math.max(0, Math.min(bands.length - 1, lo + 1));
    const mix = bandPos - lo;
    return (bands[lo] || 0) * (1 - mix) + (bands[hi] || 0) * mix;
  }

  _smoothBar(level, ny, softness = 0.22) {
    const height = Math.min(1, level);
    const fromBottom = 1 - ny;
    return Math.max(0, Math.min(1, (height - fromBottom + softness) / softness));
  }

  _clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  _applyMusicalField(bands, bass, mid, treble, palette, style = 'fluid', colorDirection = 'right-to-left') {
    const br = this.brightness / 255;
    const energy = this._clamp01(bass * 0.5 + mid * 0.34 + treble * 0.24);
    const styleGain = style === 'equalizer' ? 1.18 : style === 'chunky' ? 1.28 : 1.08;
    const softness = style === 'chunky' ? 0.18 : style === 'equalizer' ? 0.24 : 0.32;
    const threshold = style === 'fluid' ? 0.035 : 0.055;

    this._clearMusicBuffer();
    this._forEachPhysicalKey((r, c, key) => {
      const direct = this._sampleFrequencyAt(bands, key.nx);
      const left = this._sampleFrequencyAt(bands, this._clamp01(key.nx - 0.055));
      const right = this._sampleFrequencyAt(bands, this._clamp01(key.nx + 0.055));
      const localLevel = this._clamp01((direct * 0.72 + left * 0.14 + right * 0.14) * styleGain);
      const active = Math.max(0, localLevel - threshold) / Math.max(0.001, 1 - threshold);

      if (active <= 0) {
        this.colorBuffer[r][c] = { r: 0, g: 0, b: 0 };
        return;
      }

      const bar = this._smoothBar(active, key.ny, softness);
      const peak = Math.max(0, 1 - Math.abs((1 - key.ny) - active) / 0.16) * 0.32;
      const intensity = this._clamp01(bar + peak + energy * 0.04);

      if (intensity < 0.035) {
        this.colorBuffer[r][c] = { r: 0, g: 0, b: 0 };
        return;
      }

      const color = this._frequencyColor(palette, key.nx, colorDirection, this.elapsed);
      this.colorBuffer[r][c] = {
        r: color.r * intensity * br,
        g: color.g * intensity * br,
        b: color.b * intensity * br,
      };
    });
  }

  _frequencyColor(palette, nx, colorDirection = 'right-to-left', time = 0) {
    const basePosition = colorDirection === 'left-to-right' ? nx : 1 - nx;
    const motion = colorDirection === 'left-to-right' ? time * 0.28 : -time * 0.28;
    const position = (basePosition + motion + 1) % 1;
    const smoothMix = (1 - Math.cos(position * Math.PI * 2)) / 2;
    switch (palette) {
      case 'fire': return lerpColor({ r: 255, g: 230, b: 60 }, { r: 255, g: 20, b: 0 }, smoothMix);
      case 'ocean': return lerpColor({ r: 0, g: 255, b: 255 }, { r: 0, g: 40, b: 220 }, smoothMix);
      case 'neon': return lerpColor({ r: 170, g: 0, b: 255 }, { r: 255, g: 0, b: 170 }, smoothMix);
      case 'custom': return lerpColor(this.color1, this.color2, smoothMix);
      default:
        return hslToRgb(position, 1.0, 0.5);
    }
  }

  /**
   * Equalizer: 16 smooth frequency bands projected onto the keyboard's staggered
   * physical key geometry. Bass lives on the right, treble on the left.
   */
  applyEqualizer(bands, palette, bass = 0, mid = 0, treble = 0, colorDirection = 'right-to-left') {
    this._applyMusicalField(bands, bass, mid, treble, palette, 'equalizer', colorDirection);
  }

  /**
   * Top-row VU: only row 0 lights up, filling right→left (Ins→Esc) based on level.
   * All other keys stay black. Needs only 2 HID chunks (0 + 3) — 2× faster than full frame.
   * @param {number} level  0-1 overall music level
   * @param {string} palette
   */
  applyTopRowVU(level, palette, colorDirection = 'right-to-left') {
    const br = this.brightness / 255;
    const cols = KEYBOARD_LAYOUT.cols; // 16 (but row 0 has 15 physical keys, cols 0-14)
    const rows = KEYBOARD_LAYOUT.rows;
    const TOP_ROW_KEYS = 15; // cols 0-14

    // Clear all keys
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        this.colorBuffer[r][c] = { r: 0, g: 0, b: 0 };

    // How many keys to light (right to left)
    const litKeys = level * TOP_ROW_KEYS;

    for (let i = 0; i < TOP_ROW_KEYS; i++) {
      // i=0 is rightmost (Ins/Del, col 14), i=14 is leftmost (Esc, col 0)
      const col = TOP_ROW_KEYS - 1 - i;
      const intensity = Math.max(0, Math.min(1, litKeys - i));
      if (intensity < 0.01) continue;

      // Color: rainbow across the top row — leftmost=red, rightmost=violet
      const position = col / (TOP_ROW_KEYS - 1); // 0=Esc(left), 1=Ins(right)
      const motion = colorDirection === 'left-to-right' ? this.elapsed * 0.28 : -this.elapsed * 0.28;
      const hue = (colorDirection === 'left-to-right' ? position + motion : 1 - position + motion + 1) % 1;
      let color;
      switch (palette) {
        case 'fire':   color = lerpColor({ r: 255, g: 255, b: 100 }, { r: 255, g: 20, b: 0 }, hue); break;
        case 'ocean':  color = lerpColor({ r: 120, g: 255, b: 220 }, { r: 0, g: 0, b: 200 }, hue); break;
        case 'neon':   color = lerpColor({ r: 100, g: 255, b: 80  }, { r: 255, g: 0, b: 180 }, hue); break;
        default:       color = hslToRgb(hue * 0.8, 1.0, 0.5); break; // rainbow
      }

      this.colorBuffer[0][col] = {
        r: color.r * intensity * br,
        g: color.g * intensity * br,
        b: color.b * intensity * br,
      };
    }
  }

  /**
   * Flanker: far-left 2 cols = treble glow, far-right 2 cols = bass glow.
   * Entire column brightens/dims as one unit. Everything else stays black.
   */
  applyFlanker(bass, mid, treble, palette) {
    const br = this.brightness / 255;
    const rows = KEYBOARD_LAYOUT.rows;
    const cols = KEYBOARD_LAYOUT.cols;

    const PALETTE_COLORS = {
      fire:    { bass: { r: 255, g: 30,  b: 0   }, treble: { r: 255, g: 220, b: 80  } },
      ocean:   { bass: { r: 0,   g: 0,   b: 220 }, treble: { r: 0,   g: 230, b: 255 } },
      neon:    { bass: { r: 255, g: 0,   b: 180 }, treble: { r: 160, g: 0,   b: 255 } },
      rainbow: { bass: { r: 255, g: 20,  b: 0   }, treble: { r: 60,  g: 0,   b: 255 } },
    };
    const pal = PALETTE_COLORS[palette] || PALETTE_COLORS.rainbow;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c <= 1) {
          // Far-left 2 cols: treble
          this.colorBuffer[r][c] = {
            r: pal.treble.r * treble * br,
            g: pal.treble.g * treble * br,
            b: pal.treble.b * treble * br,
          };
        } else if (c >= 13) {
          // Far-right 2 cols (cols 13-14 = nav keys): bass
          this.colorBuffer[r][c] = {
            r: pal.bass.r * bass * br,
            g: pal.bass.g * bass * br,
            b: pal.bass.b * bass * br,
          };
        } else {
          this.colorBuffer[r][c] = { r: 0, g: 0, b: 0 };
        }
      }
    }
  }

  /**
   * Chunky EQ: 8 frequency bands, each spanning 2 columns.
   * Every band has its own distinct fixed color + bright peak key at the bar top.
   * @param {Float32Array} bands - 8 smoothed levels (0-1), index 0=bass, 7=treble
   */
  applyChunkyEQ(bands, palette, bass = 0, mid = 0, treble = 0, colorDirection = 'right-to-left') {
    this._applyMusicalField(bands, bass, mid, treble, palette, 'chunky', colorDirection);
  }

  /**
   * Frequency columns: each vertical column = one log-spaced frequency band.
   * Bass right, treble left. All rows in a column glow uniformly.
   * Only 16 unique brightness values drive the whole keyboard.
   * @param {Float32Array} bands - smoothed band levels (0-1), index 0=bass, n-1=treble
   * @param {string} palette
   */
  applyColumnSpectrum(bands, palette) {
    const br = this.brightness / 255;
    const cols = KEYBOARD_LAYOUT.cols;
    const visibleCols = KEYBOARD_LAYOUT.keyMap[0].length;
    const rows = KEYBOARD_LAYOUT.rows;
    const n = bands.length;

    for (let c = 0; c < cols; c++) {
      // col 0 = left = treble (high band), col cols-1 = right = bass (low band)
      const visibleCol = Math.min(c, visibleCols - 1);
      const bandIdx = Math.round((visibleCols - 1 - visibleCol) / (visibleCols - 1) * (n - 1));
      const level = Math.min(1, bands[Math.min(bandIdx, n - 1)] || 0);

      // pos: 0=left(treble/blue), 1=right(bass/red)
      const pos = visibleCol / (visibleCols - 1);

      let color;
      switch (palette) {
        case 'fire':
          color = lerpColor({ r: 255, g: 200, b: 0 }, { r: 255, g: 0, b: 0 }, pos);
          break;
        case 'ocean':
          color = lerpColor({ r: 0, g: 220, b: 255 }, { r: 0, g: 0, b: 200 }, pos);
          break;
        case 'neon':
          color = lerpColor({ r: 160, g: 0, b: 255 }, { r: 255, g: 0, b: 140 }, pos);
          break;
        default:
          // blue(240°) → green(120°) → red(0°) across columns
          color = hslToRgb((1 - pos) * 0.667, 1.0, 0.5);
          break;
      }

      for (let r = 0; r < rows; r++) {
        this.colorBuffer[r][c] = {
          r: color.r * level * br,
          g: color.g * level * br,
          b: color.b * level * br,
        };
      }
    }
  }

  /** Website light option: LightMusicFollow2 / "Music Sync" variant "upright". */
  applyMusicSyncUpright(bands, palette, bass = 0, mid = 0, treble = 0, colorDirection = 'right-to-left') {
    this._applyMusicalField(bands, bass, mid, treble, palette, 'fluid', colorDirection);
  }

  /** Website light option: LightMusicFollow2 / "Music Sync" variant "separate". */
  applyMusicSyncSeparate(bands, palette, bass, mid, treble) {
    const br = this.brightness / 255;
    const rows = KEYBOARD_LAYOUT.rows;
    const cols = KEYBOARD_LAYOUT.cols;
    const center = (KEYBOARD_LAYOUT.keyMap[0].length - 1) / 2;
    const energy = Math.min(1, bass * 0.7 + mid * 0.45 + treble * 0.3);

    for (let r = 0; r < rows; r++) {
      const rowWeight = 1 - r / Math.max(1, rows - 1);
      for (let c = 0; c < cols; c++) {
        const distance = Math.abs(Math.min(c, center * 2) - center) / center;
        const bandIdx = Math.min(bands.length - 1, Math.round(distance * (bands.length - 1)));
        const band = Math.min(1, bands[bandIdx] || 0);
        const split = Math.max(0, 1 - distance * 0.25) * Math.max(0, band * 0.9 + energy * 0.35 - rowWeight * 0.2);
        const color = this._musicSyncColor(palette, c < center ? 0.58 + distance * 0.22 : 0.02 + distance * 0.2, split);
        this.colorBuffer[r][c] = {
          r: color.r * split * br,
          g: color.g * split * br,
          b: color.b * split * br,
        };
      }
    }
  }

  /** Website light option: LightMusicFollow2 / "Music Sync" variant "intersect". */
  applyMusicSyncIntersect(bands, palette, bass, mid, treble) {
    const br = this.brightness / 255;
    const rows = KEYBOARD_LAYOUT.rows;
    const cols = KEYBOARD_LAYOUT.cols;
    const visibleCols = KEYBOARD_LAYOUT.keyMap[0].length;
    const energy = Math.min(1, bass * 0.6 + mid * 0.5 + treble * 0.35);
    const leftPos = (this.elapsed * (2.5 + energy * 4.0)) % (visibleCols - 1);
    const rightPos = (visibleCols - 1) - leftPos;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const visibleCol = Math.min(c, visibleCols - 1);
        const bandIdx = Math.round((visibleCols - 1 - visibleCol) / (visibleCols - 1) * (bands.length - 1));
        const band = Math.min(1, bands[bandIdx] || 0);
        const sweep = Math.max(0, 1 - Math.min(Math.abs(visibleCol - leftPos), Math.abs(visibleCol - rightPos)) / 3);
        const rowPulse = 0.65 + 0.35 * Math.sin(this.elapsed * 7 + r * 1.4);
        const intensity = Math.min(1, sweep * rowPulse * (0.35 + energy * 0.55) + band * 0.45);
        const color = this._musicSyncColor(palette, (visibleCol / visibleCols + this.elapsed * 0.08) % 1, intensity);
        this.colorBuffer[r][c] = {
          r: color.r * intensity * br,
          g: color.g * intensity * br,
          b: color.b * intensity * br,
        };
      }
    }
  }

  _musicSyncColor(palette, position, intensity) {
    const t = Math.max(0, Math.min(1, position));
    switch (palette) {
      case 'fire': return lerpColor({ r: 255, g: 0, b: 0 }, { r: 255, g: 220, b: 40 }, intensity);
      case 'ocean': return lerpColor({ r: 0, g: 30, b: 220 }, { r: 0, g: 255, b: 255 }, intensity);
      case 'neon': return lerpColor({ r: 255, g: 0, b: 180 }, { r: 0, g: 255, b: 180 }, t);
      case 'custom': return lerpColor(this.color1, this.color2, t);
      default:
        return hslToRgb(t, 1.0, 0.5);
    }
  }

  // Apply music data to color buffer
  applyMusicData(bassLevel, midLevel, trebleLevel, mode, palette) {
    const br = this.brightness / 255;
    const getColor = (intensity, band) => {
      switch (palette) {
        case 'fire': return lerpColor({ r: 255, g: 0, b: 0 }, { r: 255, g: 200, b: 0 }, intensity);
        case 'ocean': return lerpColor({ r: 0, g: 0, b: 128 }, { r: 0, g: 255, b: 255 }, intensity);
        case 'neon': return lerpColor({ r: 255, g: 0, b: 128 }, { r: 0, g: 255, b: 255 }, intensity);
        case 'rainbow': return hslToRgb(intensity * 0.8, 1.0, 0.5);
        default: return lerpColor(this.color1, this.color2, intensity);
      }
    };

    switch (mode) {
      case 'spectrum': {
        // Map frequency bands to rows
        const levels = [trebleLevel, trebleLevel, midLevel, bassLevel, bassLevel];
        for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
          const level = levels[r] || 0;
          for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
            const colFactor = c / KEYBOARD_LAYOUT.cols;
            const intensity = level * (0.5 + 0.5 * Math.sin(colFactor * Math.PI));
            const color = getColor(intensity, r);
            this.colorBuffer[r][c] = { r: color.r * br * intensity, g: color.g * br * intensity, b: color.b * br * intensity };
          }
        }
        break;
      }
      case 'pulse': {
        const intensity = bassLevel;
        const color = getColor(intensity);
        for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
          for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
            this.colorBuffer[r][c] = { r: color.r * br * intensity, g: color.g * br * intensity, b: color.b * br * intensity };
          }
        }
        break;
      }
      case 'wave': {
        const t = this.elapsed;
        for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
          for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
            const wave = (Math.sin(c * 0.5 - t * (1 + bassLevel * 5)) + 1) / 2;
            const intensity = wave * (0.3 + midLevel * 0.7);
            const color = getColor(intensity);
            this.colorBuffer[r][c] = { r: color.r * br * intensity, g: color.g * br * intensity, b: color.b * br * intensity };
          }
        }
        break;
      }
      case 'vumeter': {
        const totalLevel = (bassLevel + midLevel + trebleLevel) / 3;
        const litCols = Math.floor(totalLevel * KEYBOARD_LAYOUT.cols);
        for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
          for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
            if (c <= litCols) {
              const intensity = c / KEYBOARD_LAYOUT.cols;
              const color = getColor(intensity);
              this.colorBuffer[r][c] = { r: color.r * br, g: color.g * br, b: color.b * br };
            } else {
              this.colorBuffer[r][c] = { r: 0, g: 0, b: 0 };
            }
          }
        }
        break;
      }
    }
  }
}

// === Color Utilities ===

export function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : { r: 0, g: 0, b: 0 };
}

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
}

export function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

export function lerpColor(c1, c2, t) {
  t = Math.max(0, Math.min(1, t));
  return {
    r: c1.r + (c2.r - c1.r) * t,
    g: c1.g + (c2.g - c1.g) * t,
    b: c1.b + (c2.b - c1.b) * t,
  };
}
