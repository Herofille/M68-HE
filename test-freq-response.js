/**
 * test-freq-response.js — Frequency Spectrum Response Tester
 *
 * Feeds synthetic frequency spectra through the effects engine and prints
 * per-key ASCII heatmaps showing exactly which physical keys light up for
 * each frequency band. No hardware required.
 *
 * Usage:  node test-freq-response.js              # all tests
 *         node test-freq-response.js --effect bass-floor   # single effect
 *         node test-freq-response.js --test bass  # bass-only test
 */

// ── Replicated geometry constants (mirror src/effects-engine.js) ──
const KEYBOARD_LAYOUT = {
  rows: 5,
  cols: 16,
  keyMap: [
    ['ESC','1 !','2 @','3 #','4 $','5 %','6 ^','7 &','8 *','9 (','0 )','- _','+ =','BACK','Ins'],
    ['TAB','Q','W','E','R','T','Y','U','I','O','P','[ {','] }','\\ |','Del'],
    ['CAPS','A','S','D','F','G','H','J','K','L','; :','" \'','ENTER','','PGUP'],
    ['SHIFT','Z','X','C','V','B','N','M',', <','. >','/ ?','SHIFT','','↑','PGDN'],
    ['CTRL','WIN','ALT','','','SPACE','','','ALT','FN1','Ctrl','←','↓','→',''],
  ]
};

const clamp01 = v => Math.max(0, Math.min(1, v));

function isPhysicalKey(row, col) {
  return Boolean(KEYBOARD_LAYOUT.keyMap[row]?.[col]);
}

function keyGeometry(row, col) {
  const visibleCols = KEYBOARD_LAYOUT.keyMap[0].length;
  const rowStagger = [0, 0.35, 0.65, 0.95, 1.45][row] || 0;
  const x = col + rowStagger;
  const maxX = visibleCols - 1 + rowStagger;
  return {
    x, y: row,
    nx: Math.max(0, Math.min(1, x / maxX)),
    ny: row / Math.max(1, KEYBOARD_LAYOUT.rows - 1),
  };
}

function sampleFrequencyAt(bands, nx) {
  if (!bands.length) return 0;
  const bandPos = (1 - nx) * (bands.length - 1);
  const lo = Math.max(0, Math.min(bands.length - 1, Math.floor(bandPos)));
  const hi = Math.max(0, Math.min(bands.length - 1, lo + 1));
  const mix = bandPos - lo;
  return (bands[lo] || 0) * (1 - mix) + (bands[hi] || 0) * mix;
}

function smoothBar(level, ny, softness) {
  const height = Math.min(1, level);
  const fromBottom = 1 - ny;
  return Math.max(0, Math.min(1, (height - fromBottom + softness) / softness));
}

function forEachPhysicalKey(callback) {
  for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
    for (let c = 0; c < KEYBOARD_LAYOUT.cols; c++) {
      if (!isPhysicalKey(r, c)) continue;
      callback(r, c, keyGeometry(r, c));
    }
  }
}

// ── Synthetic spectrum generators ──
function makeSpectrum(numBands, peakBand, width) {
  const bands = new Float32Array(numBands);
  for (let i = 0; i < numBands; i++) {
    const dist = Math.abs(i - peakBand) / (width || 1.5);
    bands[i] = clamp01(1 - dist) * 0.85;
  }
  return bands;
}

function makeFlatSpectrum(numBands) {
  const bands = new Float32Array(numBands);
  bands.fill(0.3);
  return bands;
}

// ── Effect simulators (simplified from src/effects-engine.js) ──
function runEffect(bands, effectName, bass, mid, treble) {
  const br = 1; // normalize brightness for testing
  const result = []; // [[row, col, intensity]]
  const energy = clamp01(bass * 0.2 + mid * 0.15 + treble * 0.1);

  forEachPhysicalKey((r, c, key) => {
    const bandLevel = sampleFrequencyAt(bands, key.nx);
    let intensity = 0;

    switch (effectName) {
      // ── Spectrum-first effects ──
      case 'equalizer':
      case 'music-sync-upright':
      case 'musical-field': {
        const styleGain = effectName === 'equalizer' ? 1.18 : 1.08;
        const softness = effectName === 'equalizer' ? 0.24 : 0.32;
        const threshold = 0.035;
        const localLevel = clamp01(bandLevel * styleGain);
        const active = Math.max(0, localLevel - threshold) / Math.max(0.001, 1 - threshold);
        const bar = smoothBar(active, key.ny, softness);
        const peak = Math.max(0, 1 - Math.abs((1 - key.ny) - active) / 0.16) * 0.32;
        intensity = clamp01(bar + peak + energy * 0.04);
        break;
      }
      case 'chunky-eq': {
        const styleGain = 1.28;
        const softness = 0.18;
        const threshold = 0.055;
        const localLevel = clamp01(bandLevel * styleGain);
        const active = Math.max(0, localLevel - threshold) / Math.max(0.001, 1 - threshold);
        const bar = smoothBar(active, key.ny, softness);
        const peak = Math.max(0, 1 - Math.abs((1 - key.ny) - active) / 0.16) * 0.32;
        intensity = clamp01(bar + peak + energy * 0.04);
        break;
      }
      case 'sharp-bars': {
        const barHeight = 1 - key.ny;
        const cutoff = bandLevel * 0.95;
        const bar = barHeight <= cutoff ? 1 : Math.max(0, 1 - (barHeight - cutoff) / 0.08);
        const peak = Math.abs(barHeight - cutoff) < 0.06 ? 0.7 : 0;
        intensity = clamp01(bar * bandLevel + peak);
        break;
      }
      case 'column-split': {
        const ZONES = 5;
        const zone = Math.min(ZONES - 1, Math.floor(key.nx * ZONES));
        const zoneNx = Math.min(1, Math.max(0, (zone + 0.5) / ZONES));
        const zoneLevel = sampleFrequencyAt(bands, zoneNx);
        const bar = key.ny <= zoneLevel ? 1 : Math.max(0, 1 - (key.ny - zoneLevel) / 0.12);
        intensity = clamp01(bar * zoneLevel);
        break;
      }
      case 'ridge-line': {
        const targetRow = (1 - bandLevel) * (KEYBOARD_LAYOUT.rows - 1);
        const dist = Math.abs(r - targetRow);
        const focus = dist < 0.6 ? 1 : dist < 1.2 ? 0.6 : 0;
        intensity = clamp01(focus * bandLevel);
        break;
      }
      case 'bass-floor': {
        const floorHeight = bandLevel * 0.9 + energy * 0.25;
        const barHeight = 1 - key.ny;
        const rowFade = barHeight <= floorHeight ? 1 : Math.max(0, 1 - (barHeight - floorHeight) / 0.12);
        intensity = clamp01((bandLevel * 0.8 + energy * 0.3) * rowFade);
        break;
      }
      case 'bass-drop': {
        const bassWeight = 1 - key.nx;
        const localHit = clamp01(bandLevel * (0.3 + bassWeight * 0.9));
        const rowFactor = 1 - key.ny;
        const reach = 0.28 + localHit * 0.55;
        const inReach = rowFactor >= 0.95 - reach ? 1 : Math.max(0, 1 - (0.95 - reach - rowFactor) / 0.15);
        intensity = clamp01(localHit * inReach * (0.6 + rowFactor * 0.7));
        break;
      }
      case 'freq-peak': {
        let peakIdx = 0, peakVal = 0;
        for (let i = 0; i < bands.length; i++) {
          if (bands[i] > peakVal) { peakVal = bands[i]; peakIdx = i; }
        }
        const bandPos = (1 - key.nx) * (bands.length - 1);
        const dist = Math.abs(bandPos - peakIdx);
        const focus = dist < 1 ? 1 : dist < 2.5 ? 1 - (dist - 1) / 1.5 : 0;
        intensity = clamp01(focus * peakVal * (0.6 + focus * 0.6));
        break;
      }
      case 'waterfall': {
        // Simplified: just current spectrum projection
        const bar = key.ny <= bandLevel ? 1 : Math.max(0, 1 - (key.ny - bandLevel) / 0.1);
        intensity = clamp01(bar * bandLevel);
        break;
      }
      case 'ripple': {
        // Continuous rings — intensity proportional to band level and distance from center
        const centerX = (KEYBOARD_LAYOUT.keyMap[0].length - 1) / 2 + 0.7;
        const dist = Math.sqrt(((key.x - centerX) * 0.7) ** 2 + ((key.y - 2) * 1.3) ** 2);
        const normDist = dist / 5.5;
        // Rings spawn at various radii — test at a mid-radius point
        const ringAt = 0.4;
        const inRing = 1 - Math.min(1, Math.abs(normDist - ringAt) / 0.1);
        intensity = clamp01(inRing * bandLevel * 1.2 + bandLevel * 0.35);
        break;
      }
      case 'rainbow-flow': {
        intensity = clamp01((bandLevel * 0.85 + energy * 0.3) * (0.55 + bandLevel * 0.6));
        break;
      }
      default:
        intensity = bandLevel;
    }

    if (intensity > 0.025) {
      result.push([r, c, clamp01(intensity)]);
    }
  });

  return result;
}

// ── Heatmap renderer ──
const HEAT_CHARS = [' ', '░', '▒', '▓', '█'];

function heatChar(intensity) {
  if (intensity < 0.03) return ' ';
  if (intensity < 0.18) return '░';
  if (intensity < 0.40) return '▒';
  if (intensity < 0.70) return '▓';
  return '█';
}

function printHeatmap(result, label) {
  const grid = {};
  for (const [r, c, intensity] of result) {
    grid[`${r},${c}`] = Math.max(grid[`${r},${c}`] || 0, intensity);
  }

  console.log(`\n  ┌${'─'.repeat(32)}┐`);
  console.log(`  │ ${label.padEnd(30)} │`);
  console.log(`  └${'─'.repeat(32)}┘`);

  const width = KEYBOARD_LAYOUT.cols;

  // Column header
  let header = '    ';
  for (let c = 0; c < width; c++) header += c % 10;
  console.log(header);

  for (let r = 0; r < KEYBOARD_LAYOUT.rows; r++) {
    let row = `R${r}  `;
    for (let c = 0; c < width; c++) {
      if (!isPhysicalKey(r, c)) {
        row += ' ';
      } else {
        const intensity = grid[`${r},${c}`] || 0;
        row += heatChar(intensity);
      }
    }
    console.log(row);
  }

  // Legend
  const litKeys = result.length;
  const totalKeys = [...Array(KEYBOARD_LAYOUT.rows).keys()]
    .flatMap(r => [...Array(width).keys()].filter(c => isPhysicalKey(r, c)))
    .length;
  console.log(`  █ = brightest  ░ = dim  [${litKeys}/${totalKeys} keys]\n`);
}

// ── Summary table ──
function printSummary(resultsByTest) {
  console.log('\n' + '═'.repeat(70));
  console.log('  SPECTRUM RESPONSE SUMMARY — keys lit per frequency band');
  console.log('═'.repeat(70));
  console.log(`${'Test'.padEnd(18)} ${'Bass'.padStart(6)} ${'LoMid'.padStart(6)} ${'Mid'.padStart(6)} ${'HiMid'.padStart(6)} ${'Treb'.padStart(6)} ${'Flat'.padStart(6)}`);
  console.log('─'.repeat(70));

  for (const [testName, results] of Object.entries(resultsByTest)) {
    let line = testName.padEnd(18);
    for (const r of results) {
      line += `${r.toString().padStart(6)}`;
    }
    console.log(line);
  }
  console.log('═'.repeat(70));
  console.log('  Higher numbers = more keys responding = wider frequency spread.\n');
}

// ── Main ──
const args = process.argv.slice(2);
const filterEffect = args.includes('--effect') ? args[args.indexOf('--effect') + 1] : null;
const filterTest = args.includes('--test') ? args[args.indexOf('--test') + 1] : null;

const EFFECTS = filterEffect
  ? [filterEffect]
  : ['music-sync-upright', 'equalizer', 'chunky-eq', 'sharp-bars', 'column-split',
     'ridge-line', 'bass-floor', 'bass-drop', 'freq-peak', 'waterfall', 'ripple', 'rainbow-flow'];

const NUM_BANDS = 16;

const TESTS = {
  'Pure Bass':    { bands: makeSpectrum(NUM_BANDS, 0, 2),     label: 'Bass only (band 0 peak)' },
  'Lo-Mid':       { bands: makeSpectrum(NUM_BANDS, 4, 2),     label: 'Low-mid (band 4 peak)' },
  'Mid':          { bands: makeSpectrum(NUM_BANDS, 8, 2),     label: 'Mid (band 8 peak)' },
  'Hi-Mid':       { bands: makeSpectrum(NUM_BANDS, 12, 2),    label: 'High-mid (band 12 peak)' },
  'Pure Treble':  { bands: makeSpectrum(NUM_BANDS, 15, 2),    label: 'Treble only (band 15 peak)' },
  'Flat/White':   { bands: makeFlatSpectrum(NUM_BANDS),       label: 'All bands equal' },
  'Low-Pass':     { bands: makeSpectrum(NUM_BANDS, 0, 5),     label: 'Low-pass (bass heavy, all bands on)' },
  'High-Pass':    { bands: makeSpectrum(NUM_BANDS, 15, 5),    label: 'High-pass (treble heavy, all bands on)' },
  'Narrow Band':  { bands: makeSpectrum(NUM_BANDS, 7, 0.7),   label: 'Narrow mid band (band 7, tight)' },
  'Dual Peak':    (() => {
    const b = makeSpectrum(NUM_BANDS, 1, 1.5);
    const t = makeSpectrum(NUM_BANDS, 13, 1.5);
    for (let i = 0; i < NUM_BANDS; i++) b[i] = Math.max(b[i], t[i]);
    return { bands: b, label: 'Dual peak (bass + treble)' };
  })(),
};

const filteredTests = {};
for (const [name, test] of Object.entries(TESTS)) {
  if (!filterTest || name.toLowerCase().includes(filterTest.toLowerCase())) {
    filteredTests[name] = test;
  }
}

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║    FREQUENCY SPECTRUM RESPONSE TEST — Per-Effect Heatmaps       ║');
console.log('║    Tests: ' + Object.keys(filteredTests).length + ' frequency shapes × ' + EFFECTS.length + ' effects');
console.log('║    Bands: ' + NUM_BANDS + '  |  Keyboard: ' + KEYBOARD_LAYOUT.rows + ' rows × ' + KEYBOARD_LAYOUT.cols + ' cols');
console.log('╚══════════════════════════════════════════════════════════════════╝');

const resultsByTest = {};

for (const [testName, test] of Object.entries(filteredTests)) {
  console.log(`\n\n${'▀'.repeat(60)}`);
  console.log(`  TEST: ${testName} — ${test.label}`);
  console.log(`${'▀'.repeat(60)}`);

  for (const effectName of EFFECTS) {
    const result = runEffect(test.bands, effectName, 0.3, 0.3, 0.3);
    printHeatmap(result, `${effectName} · ${testName}`);
  }

  // Compute summary: keys lit per test per effect
  resultsByTest[testName] = [];
  for (const effectName of EFFECTS) {
    const result = runEffect(test.bands, effectName, 0.3, 0.3, 0.3);
    resultsByTest[testName].push(result.length);
  }
}

printSummary(resultsByTest);

  // ── Frequency mapping table ──
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  KEY → FREQUENCY POSITION MAP');
console.log('  Right side (Ins/Del/nav) → bass  |  Left side (ESC) → treble');
console.log('  NOTE: the actual mapping in sampleFrequencyAt is bandPos = (1-nx)*15');
console.log('        so nx=0(right)→band 15(treble), nx=1(left)→band 0(bass)');
console.log('        Comment says opposite. This may need investigation.');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`${'Key'.padEnd(18)} ${'Col'.padStart(4)} ${'Row'.padStart(4)} ${'nx'.padStart(8)} ${'Band'.padStart(8)}`);
console.log('─'.repeat(60));

forEachPhysicalKey((r, c, key) => {
  const label = KEYBOARD_LAYOUT.keyMap[r][c];
  const bandIdx = Math.round((1 - key.nx) * (NUM_BANDS - 1));
  console.log(`${label.padEnd(18)} ${c.toString().padStart(4)} ${r.toString().padStart(4)} ${key.nx.toFixed(3).padStart(8)} ${bandIdx.toString().padStart(8)}`);
});

console.log('\n✅ Done. Each effect heatmap shows which physical keys respond when\n   a specific frequency band is dominant. The "Flat" test shows the\n   effect\'s default spread across all keys.\n');
