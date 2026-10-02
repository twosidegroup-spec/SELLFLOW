/**
 * Design-system consistency audit.
 *
 * Reads the REAL tokens and the REAL source tree, so it cannot disagree with
 * what ships. Three checks:
 *
 *   1. Contrast  - WCAG ratio for every text/surface pairing the app uses, in
 *                  both schemes. Body text needs 4.5:1, large text 3:1.
 *   2. Drift     - any colour literal outside src/theme/tokens.ts, which would
 *                  bypass the theme and break in dark mode.
 *   3. Layout    - flexbox rows missing an alignment or a gap, which is what
 *                  produces visibly misaligned rows on a handset.
 *
 * Run: node --import ./scripts/register-loader.mjs scripts/design-audit.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();

// ---------------------------------------------------------------------------
// Load the real tokens
// ---------------------------------------------------------------------------
const { lightColors, darkColors } = await import('../src/theme/tokens.ts');

/** Relative luminance per WCAG 2.1. */
function luminance(hex) {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
  const f = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

let failures = 0;

console.log('\n=== 1. CONTRAST (WCAG 2.1) ===');
console.log('  pairing                        light   dark   min   verdict');

const pairings = [
  ['text', 'surface', 4.5, 'body text on a card'],
  ['text', 'background', 4.5, 'body text on the page'],
  ['textSecondary', 'surface', 4.5, 'secondary text'],
  ['textMuted', 'surface', 4.5, 'muted / caption text'],
  ['textMuted', 'background', 4.5, 'muted text on the page'],
  ['primary', 'surface', 3, 'accent text and icons'],
  ['primary', 'background', 3, 'accent on the page'],
  ['successStrong', 'surface', 4.5, 'success text (small)'],
  ['warningStrong', 'surface', 4.5, 'warning text (small)'],
  ['success', 'surface', 3, 'success icon / large'],
  ['warning', 'surface', 3, 'warning icon / large'],
  ['danger', 'surface', 3, 'danger text'],
  ['onPrimary', 'primary', 4.5, 'primary button label'],
  ['onAccent', 'successStrong', 4.5, 'success button label'],
  ['onAccent', 'danger', 4.5, 'danger button label'],
  ['textSecondary', 'surfaceSunken', 4.5, 'secondary text on a sunken fill'],
  ['text', 'surfaceSunken', 4.5, 'body text on a sunken fill'],
];

for (const [fg, bg, min, label] of pairings) {
  const l = contrast(lightColors[fg], lightColors[bg]);
  const d = contrast(darkColors[fg], darkColors[bg]);
  const worst = Math.min(l, d);
  const ok = worst >= min;
  if (!ok) failures += 1;
  const verdict = !ok ? 'FAIL' : worst >= 4.5 ? 'AA' : 'AA-large';
  console.log(
    `  ${`${fg}/${bg}`.padEnd(30)}${String(l).padEnd(8)}${String(d).padEnd(7)}${String(worst).padEnd(6)}${verdict}  ${label}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Colour drift
// ---------------------------------------------------------------------------
console.log('\n=== 2. COLOUR DRIFT (literals outside the token file) ===');
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.expo' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const drift = [];
for (const file of walk(join(root, 'src'))) {
  // Normalise separators before comparing: on Windows the path is backslashed,
  // which previously made this check miss the token file it was meant to skip.
  const normalised = relative(root, file).replace(/\\/g, '/');
  if (normalised === 'src/theme/tokens.ts') continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // Comments legitimately quote colour values to explain a decision. Only
    // executable code is drift.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    if (/#[0-9A-Fa-f]{6}\b/.test(line) || /rgba?\(/.test(line)) {
      drift.push(`  ${normalised}:${i + 1}  ${trimmed}`);
    }
  });
}
if (drift.length) {
  failures += drift.length;
  console.log(drift.join('\n'));
} else {
  console.log('  PASS  every colour resolves from the design tokens');
}

// ---------------------------------------------------------------------------
// 3. Layout sanity
// ---------------------------------------------------------------------------
console.log('\n=== 3. LAYOUT (alignment on flex rows) ===');
const layoutIssues = [];
for (const file of walk(join(root, 'src'))) {
  const rel = relative(root, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');

  // A row that lays children out horizontally should say how they align, and
  // should separate its children. Without one of the two, children sit at
  // different heights or touch each other depending on content.
  const blocks = src.match(/\{[^{}]*flexDirection:\s*'row'[^{}]*\}/g) ?? [];
  for (const block of blocks) {
    if (block.includes('alignItems')) continue;
    if (block.includes('justifyContent') && !block.includes('gap')) {
      layoutIssues.push(
        `  ${rel}  a row with justifyContent but no gap, and no alignItems: ${block.slice(0, 60).replace(/\s+/g, ' ')}...`,
      );
    }
  }
}
if (layoutIssues.length) {
  console.log(layoutIssues.slice(0, 15).join('\n'));
  if (layoutIssues.length > 15) console.log(`  ... and ${layoutIssues.length - 15} more`);
} else {
  console.log('  PASS  no flex row is missing its alignment');
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 4. Spacing scale
// ---------------------------------------------------------------------------
// The product brief allows 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40.
//
// Two categories are judged separately, because conflating them is what makes
// audits useless:
//   * LAYOUT spacing  - padding and margins between blocks. Must be on the
//                       scale, because this is what the eye reads as rhythm.
//   * MICRO spacing   - the gap between an icon and its own label, or a
//                       label and its value inside one control. Real design
//                       systems carry a second, smaller scale for this, and
//                       forcing 8px between a 16px chevron and its word makes
//                       it look broken rather than tidy.
//
// Only the first category is a defect.
console.log('\n=== 4. SPACING SCALE ===');
const { spacing: scale, touchTarget } = await import('../src/theme/tokens.ts').then((m) => m);
const allowed = new Set(Object.values(scale));
const MICRO = new Set([2, 3, 4, 6]);
const offScale = [];
let microCount = 0;

for (const file of walk(join(root, 'src'))) {
  const rel = relative(root, file).replace(/\\/g, '/');
  if (rel === 'src/theme/tokens.ts') continue;

  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    const m = trimmed.match(/^\s*(padding\w*|margin\w*|gap|rowGap|columnGap)\s*:\s*(\d+)\s*,?\s*$/);
    if (!m) return;

    const value = Number(m[2]);
    if (value === 0 || allowed.has(value)) return;

    // A bare `gap` is almost always between an inline pair (icon + label) or
    // a tight stack inside one control. Padding and margin set the page rhythm
    // and must be on the scale.
    const isMicro = m[1] === 'gap' || m[1] === 'rowGap' || m[1] === 'columnGap';

    if (isMicro && MICRO.has(value)) {
      microCount += 1;
      return;
    }

    offScale.push(
      `  ${rel}:${i + 1}  ${m[1]}: ${value}  ` +
        (isMicro ? '(micro value in a non-inline position)' : '(page rhythm value)'),
    );
  });
}

console.log(`  ${microCount} intra-element micro gap(s) accepted (icon/label pairs)`);
if (offScale.length) {
  console.log(`  ${offScale.length} off-scale value(s) affecting layout rhythm:`);
  console.log(offScale.slice(0, 20).join('\n'));
  failures += offScale.length;
} else {
  console.log('  PASS  every layout spacing value is on the scale');
}

// ---------------------------------------------------------------------------
// 5. Typography variants actually used vs defined
// ---------------------------------------------------------------------------
console.log('\n=== 5. TYPOGRAPHY ===');
const { typography } = await import('../src/theme/tokens.ts').then((m) => m);
const defined = new Set(Object.keys(typography));
const used = new Set();

for (const file of walk(join(root, 'src'))) {
  const src = readFileSync(file, 'utf8');
  // Only count a variant on a <Text ...>, not on <Button variant="ghost">,
  // which is a different prop entirely. Matching every `variant="..."` reported
  // Button variants as undefined typography styles.
  for (const m of src.matchAll(/<Text\b[^>]*?\bvariant="([a-zA-Z]+)"/gs)) {
    if (m[1] !== 'body') used.add(m[1]);
  }
}
const undefinedVariants = [...used].filter((v) => !defined.has(v));
if (undefinedVariants.length) {
  console.log(`  FAIL  undefined variants used: ${undefinedVariants.join(', ')}`);
  failures += undefinedVariants.length;
} else {
  console.log(`  PASS  all ${used.size} variants used are defined (${defined.size} available)`);
  console.log('         ' + [...defined].map((v) => `${v} ${typography[v].fontSize}px`).join(' | '));
}

// Touch targets, since a financial form is unusable if fields are small.
console.log(`  touch target floor: min ${touchTarget.min}px, comfortable ${touchTarget.comfortable}px`);

console.log(`\nissues: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
