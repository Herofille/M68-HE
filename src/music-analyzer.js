/**
 * Music Analyzer - Web Audio API frequency analysis for music-reactive RGB
 */
export class MusicAnalyzer {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.dataArray = null;
    this.isActive = false;
    this.sensitivity = 1.0;
    this.smoothing = 0.1; // Reduced for lower latency (default was 0.3)

    // Frequency band levels (0-1)
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;

    // Envelope smoothing — time-based exponential decay (frame-rate independent)
    // For sub-100ms alignment, attack must be <10ms and release around 50ms
    this._smoothBass = 0;
    this._smoothMid = 0;
    this._smoothTreble = 0;
    this._attackTC = 0.005;  // 5ms attack (was 20ms)
    this._releaseTC = 0.05;  // 50ms release (was 120ms)
    this._lastAnalyzeTime = null;

    // Per-band smoothing for column spectrum effect
    this._smoothedBands = null;  // Float32Array, lazily initialized

    // Auto gain / automatic sensitivity
    this.autoGain = false;    // off by default — user toggles via UI
    this._gainFactor = 1.0;   // current auto-gain multiplier
    this._runningLevel = 0;   // slow-responding average of overall energy
    this._gainAttackTC = 1.5; // seconds — how fast gain rises when level is low
    this._gainReleaseTC = 3.0;// seconds — slower when level is high (avoid pumping)
    this._targetLevel = 0.45; // target average adjusted level ~45%

    this.onUpdate = null;
  }

  setAutoGain(enabled) {
    this.autoGain = enabled;
    if (!enabled) this._gainFactor = 1.0;
  }

  setAutoGainTarget(val) {
    this._targetLevel = Math.max(0.05, Math.min(0.9, val / 100));
  }

  setAutoGainAttack(seconds) {
    this._gainAttackTC = Math.max(0.3, Math.min(10, seconds));
  }

  setAutoGainRelease(seconds) {
    this._gainReleaseTC = Math.max(0.3, Math.min(10, seconds));
  }

  async startMicrophone() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._setupAudio(this.stream);
    } catch (err) {
      throw new Error('Microphone access denied: ' + err.message);
    }
  }

  async startSystemAudio() {
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: 1, height: 1 }
      });
      // Stop the video track since we only need audio
      this.stream.getVideoTracks().forEach(t => t.stop());
      const audioTracks = this.stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error('No audio track captured. Make sure to check "Share audio" when selecting the screen.');
      }
      const audioStream = new MediaStream(audioTracks);
      this._setupAudio(audioStream);
    } catch (err) {
      throw new Error('System audio capture failed: ' + err.message);
    }
  }

  /** Electron desktop audio loopback — captures system audio without screensharing dialog. */
  async startSystemAudioLoopback() {
    try {
      if (!window.electronAPI?.isElectron) {
        throw new Error('Loopback only available in the Electron desktop app.');
      }
      // getDisplayMedia auto-resolves via setDisplayMediaRequestHandler — no picker dialog.
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: 1, height: 1 },
      });
      // Immediately stop the tiny video track — we only need audio.
      this.stream.getVideoTracks().forEach(t => t.stop());
      const audioTracks = this.stream.getAudioTracks();
      if (!audioTracks.length) throw new Error('No audio track captured');
      this._setupAudio(new MediaStream(audioTracks));
    } catch (err) {
      throw new Error('System audio loopback failed: ' + err.message);
    }
  }

  async startFile(file) {
    if (!file) throw new Error('No file provided');

    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = this.smoothing;

    const audioElement = new Audio();
    audioElement.src = URL.createObjectURL(file);
    audioElement.crossOrigin = 'anonymous';

    this.source = this.audioContext.createMediaElementSource(audioElement);
    this.source.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.isActive = true;

    audioElement.play();
    this._audioElement = audioElement;
    this._analyze();
  }

  _setupAudio(stream) {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = this.smoothing;

    this.source = this.audioContext.createMediaStreamSource(stream);
    this.source.connect(this.analyser);

    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.isActive = true;
    this._analyze();
  }

  _analyze() {
    if (!this.isActive) return;

    this.analyser.getByteFrequencyData(this.dataArray);
    const len = this.dataArray.length;

    // Split into frequency bands
    // Bass: 20-250 Hz (roughly first ~12% of bins)
    // Mid: 250-4000 Hz (~12-50% of bins)
    // Treble: 4000-20000 Hz (~50-100% of bins)
    const bassEnd = Math.floor(len * 0.12);
    const midEnd = Math.floor(len * 0.5);

    let bassSum = 0, midSum = 0, trebleSum = 0;
    for (let i = 0; i < bassEnd; i++) bassSum += this.dataArray[i];
    for (let i = bassEnd; i < midEnd; i++) midSum += this.dataArray[i];
    for (let i = midEnd; i < len; i++) trebleSum += this.dataArray[i];

    const bassAvg = bassEnd > 0 ? bassSum / bassEnd / 255 : 0;
    const midAvg = (midEnd - bassEnd) > 0 ? midSum / (midEnd - bassEnd) / 255 : 0;
    const trebleAvg = (len - midEnd) > 0 ? trebleSum / (len - midEnd) / 255 : 0;

    // ── Auto gain / automatic sensitivity ──────────────────────────────
    const now = performance.now();

    const effectiveSensitivity = this.autoGain
      ? this.sensitivity * this._gainFactor
      : this.sensitivity;

    // Track a slow average of the total energy across the whole spectrum.
    // The gain factor adjusts so the average lands near _targetLevel.
    if (this.autoGain) {
      const totalAvg = bassSum + midSum + trebleSum;
      const normalized = totalAvg / (len * 255); // 0-1 rough
      const gainDt = Math.min((now - this._lastAnalyzeTime) / 1000, 0.1);
      const gainRate = 1 - Math.exp(-gainDt / (normalized > this._runningLevel ? this._gainAttackTC : this._gainReleaseTC));
      this._runningLevel += (normalized - this._runningLevel) * gainRate;

      if (this._runningLevel > 0.005) {
        const desired = this._targetLevel / Math.max(0.01, this._runningLevel * this.sensitivity);
        const gainRate2 = 1 - Math.exp(-gainDt / this._gainAttackTC);
        this._gainFactor += (desired - this._gainFactor) * gainRate2;
        this._gainFactor = Math.max(0.25, Math.min(4.0, this._gainFactor));
      }
    }

    // Apply sensitivity (with auto-gain multiplier if active)
    const rawBass = Math.min(1, bassAvg * effectiveSensitivity);
    const rawMid = Math.min(1, midAvg * effectiveSensitivity);
    const rawTreble = Math.min(1, trebleAvg * effectiveSensitivity);

    // Time-based envelope: compute dt so result is fps-independent
    const dt = this._lastAnalyzeTime ? Math.min((now - this._lastAnalyzeTime) / 1000, 0.1) : 1/60;
    this._lastAnalyzeTime = now;
    const attackRate  = 1 - Math.exp(-dt / this._attackTC);
    const releaseRate = 1 - Math.exp(-dt / this._releaseTC);

    this._smoothBass   += (rawBass   - this._smoothBass)   * (rawBass   > this._smoothBass   ? attackRate : releaseRate);
    this._smoothMid    += (rawMid    - this._smoothMid)    * (rawMid    > this._smoothMid    ? attackRate : releaseRate);
    this._smoothTreble += (rawTreble - this._smoothTreble) * (rawTreble > this._smoothTreble ? attackRate : releaseRate);

    this.bass = this._smoothBass;
    this.mid = this._smoothMid;
    this.treble = this._smoothTreble;

    if (this.onUpdate) {
      this.onUpdate({
        bass: this.bass,
        mid: this.mid,
        treble: this.treble,
        frequencyData: this.dataArray,
      });
    }

    // Update per-band smoothing if anyone is using getSmoothedBands
    if (this._smoothedBands) {
      const raw = this.getBands(this._smoothedBands.length);
      for (let i = 0; i < raw.length; i++) {
        const r = raw[i];
        const rate = r > this._smoothedBands[i] ? attackRate : releaseRate;
        this._smoothedBands[i] += (r - this._smoothedBands[i]) * rate;
      }
    }

  }

  tick() {
    if (this.isActive) this._analyze();
  }

  /**
   * Get smoothed per-band levels (0-1) with time-based attack/release.
   * First call initialises the buffer. Same TC as bass/mid/treble smoothing.
   */
  getSmoothedBands(numBands = 16) {
    if (!this._smoothedBands || this._smoothedBands.length !== numBands) {
      this._smoothedBands = new Float32Array(numBands);
    }
    return this._smoothedBands;
  }

  setSensitivity(val) {
    this.sensitivity = val / 100;
  }

  setSmoothing(val) {
    this.smoothing = val / 100;
    if (this.analyser) {
      this.analyser.smoothingTimeConstant = this.smoothing;
    }
  }

  stop() {
    this.isActive = false;
    if (this._audioElement) {
      this._audioElement.pause();
      this._audioElement = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  getFrequencyData() {
    return this.dataArray;
  }

  /**
   * Get frequency data split into N equal-ish bands (logarithmic scale)
   * Returns array of normalized levels (0-1) for each band
   * @param {number} numBands - Number of bands to split into
   * @returns {Float32Array} Band levels (0-1)
   */
  getBands(numBands = 16) {
    if (!this.dataArray || !this.analyser) {
      return new Float32Array(numBands);
    }

    const bands = new Float32Array(numBands);
    const freqData = this.dataArray;
    const binCount = freqData.length;
    const sampleRate = this.audioContext.sampleRate;
    const nyquist = sampleRate / 2;

    // Use logarithmic frequency scale: 20Hz to nyquist
    const minFreq = 20;
    const maxFreq = Math.min(nyquist, 20000);
    const logMin = Math.log10(minFreq);
    const logMax = Math.log10(maxFreq);

    for (let i = 0; i < numBands; i++) {
      const freqLow = Math.pow(10, logMin + (logMax - logMin) * (i / numBands));
      const freqHigh = Math.pow(10, logMin + (logMax - logMin) * ((i + 1) / numBands));

      const binLow = Math.max(0, Math.floor(freqLow / nyquist * binCount));
      const binHigh = Math.min(binCount - 1, Math.floor(freqHigh / nyquist * binCount));

      let sum = 0;
      let count = 0;
      for (let b = binLow; b <= binHigh; b++) {
        sum += freqData[b];
        count++;
      }

      const bandSensitivity = this.autoGain
        ? this.sensitivity * this._gainFactor
        : this.sensitivity;
      bands[i] = count > 0 ? Math.min(1, (sum / count / 255) * bandSensitivity) : 0;
    }

    return bands;
  }

  /**
   * Find dominant frequency peaks in the current spectrum.
   * Scans FFT bins for local maxima, sorts by intensity, returns top peaks.
   * @param {number} count   Max peaks to return (default 8)
   * @param {number} threshold  Minimum normalized intensity 0-1 (default 0.08)
   * @returns {{freq: number, intensity: number}[]}  Peaks sorted strongest-first
   */
  getActivePeaks(count = 8, threshold = 0.08) {
    if (!this.dataArray || !this.analyser) return [];

    const freqData = this.dataArray;
    const binCount = freqData.length;
    const sampleRate = this.audioContext.sampleRate;
    const nyquist = sampleRate / 2;

    const bandSensitivity = this.autoGain
      ? this.sensitivity * this._gainFactor
      : this.sensitivity;

    // Find local maxima (a bin that is >= its neighbours)
    const peaks = [];
    for (let i = 1; i < binCount - 1; i++) {
      const val = (freqData[i] / 255) * bandSensitivity;
      if (val < threshold) continue;
      const left  = (freqData[i - 1] / 255) * bandSensitivity;
      const right = (freqData[i + 1] / 255) * bandSensitivity;
      if (val >= left && val >= right) {
        const freq = i / binCount * nyquist;
        // Sub-pixel parabolic interpolation for more accurate frequency
        const delta = (right - left) / (2 * (2 * val - left - right) + 0.0001);
        const fineFreq = (i + delta) / binCount * nyquist;
        peaks.push({
          freq: Math.max(20, Math.min(nyquist, fineFreq)),
          intensity: Math.min(1, val),
        });
      }
    }

    // Sort by intensity descending, take top N
    peaks.sort((a, b) => b.intensity - a.intensity);
    return peaks.slice(0, count);
  }
}
