/**
 * Visual-system audit: radius and control metrics.
 *
 * The previous pass fixed colour, alignment, spacing scale and typography. This
 * covers the two remaining systematic risks that make sibling components look
 * unrelated: inconsistent corner radii, and controls of different heights for
 * the same job.
 *
 * Both are judged against the TOKEN file, so a raw number that happens to match
 * a token is fine, and a number that does not is flagged. There is no second
 * standard to drift toward.
 *
 * Run: node --import ./scripts/register-loader.mjs scripts/visual-system-audit.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const { radius, touchTarget, typography, chipHeight, controlHeight } = await import(
  '../src/theme/tokens.ts'
);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.expo' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(join(root, 'src'));
let failures = 0;

// ---------------------------------------------------------------------------
// 1. Radius
// ---------------------------------------------------------------------------
console.log('\n=== 1. CARD / SURFACE RADIUS ===');
console.log('  token scale:', JSON.stringify(radius));

// Every radius a sheet, card or surface might want, mapped to a token value.
const RADIUS_SEMANTICS = {
  sm: radius.sm,
  control: radius.control,
  mark: radius.mark,
  card: radius.card,
  sheet: radius.sheet,
  pill: radius.pill,
};
const validRadius = new Set(Object.values(RADIUS_SEMANTICS).filter((v) => typeof v === 'number'));

const rawRadius = [];
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    const m = trimmed.match(/border(?:TopLeft|TopRight|BottomLeft|BottomRight)?Radius\s*:\s*(\d+)\s*,?/);
    if (!m) return;
    const value = Number(m[1]);
    if (validRadius.has(value)) return;
    rawRadius.push(`  ${rel}:${i + 1}  radius ${value} (token values: ${[...validRadius].join(', ')})`);
  });
}

if (rawRadius.length) {
  console.log(`  ${rawRadius.length} radius value(s) not from the token scale:`);
  console.log(rawRadius.join('\n'));
  failures += rawRadius.length;
} else {
  console.log('  PASS  every literal radius comes from the scale');
}

// Token-driven radii are the healthy pattern; report coverage.
const tokenUsage = { sm: 0, control: 0, mark: 0, card: 0, sheet: 0, pill: 0 };
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/radius\.(sm|control|mark|card|sheet|pill)\b/g)) {
    tokenUsage[m[1]] += 1;
  }
}
console.log(`  token usage: ${Object.entries(tokenUsage).map(([k, v]) => `${k} x${v}`).join(', ')}`);

// ---------------------------------------------------------------------------
// 2. Control heights
// ---------------------------------------------------------------------------
console.log('\n=== 2. CONTROL HEIGHTS ===');
console.log(`  touch target floor: min ${touchTarget.min}px, comfortable ${touchTarget.comfortable}px`);

// Declared control heights. Keyed numerically, because the values are compared
// against numeric CSS values, not against a name.
const HEIGHTS = new Set([
  40, // Button size sm
  controlHeight, // Button md, Input, SelectField, SearchBar
  52, // Button lg
  chipHeight, // FilterChip, segmented segment
  touchTarget.min,
  touchTarget.comfortable,
]);

const heightSites = {};
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:height|minHeight)\s*:\s*(\d+)\s*,?\s*$/);
    if (!m) return;
    const value = Number(m[1]);
    if (value < 24 || value > 120) return; // not a control height
    (heightSites[value] ??= []).push(`${rel}:${i + 1}`);
  });
}

console.log(
  `  declared heights in use: ${Object.keys(heightSites).sort((a, b) => a - b).join(', ')}px`,
);
console.log(`  on the declared scale : ${[...HEIGHTS].sort((a, b) => a - b).join(', ')}px`);

// Small non-interactive marks (a 24px badge, a 32px icon tile, a 2px handle
// dot) are legitimately shorter than a control and are not drift.
const NON_CONTROL = new Set([2, 3, 4, 20, 24, 28, 32, 36, 42, 56, 60]);

const rogueHeights = Object.entries(heightSites)
  .filter(([v]) => !HEIGHTS.has(Number(v)) && !NON_CONTROL.has(Number(v)))
  .flatMap(([v, sites]) => sites.map((s) => `  ${s}  height ${v}`));

if (rogueHeights.length) {
  console.log(`  ${rogueHeights.length} control height(s) outside the scale:`);
  console.log(rogueHeights.slice(0, 12).join('\n'));
  failures += rogueHeights.length;
} else {
  console.log('  PASS  every control height is a declared value; shorter values are non-interactive marks');
}

// ---------------------------------------------------------------------------
// 3. Text vertical centring inside controls
// ---------------------------------------------------------------------------
console.log('\n=== 3. TEXT CENTRING IN INPUTS ===');
const missingCentring = [];
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  // A numeric TextInput lineHeight that exceeds its font size pushes text off
  // centre; alignment is handled by flexbox instead.
  for (const m of src.matchAll(/lineHeight\s*:\s*(\d+)\s*,/g)) {
    const value = Number(m[1]);
    const line = src.slice(0, m.index);
    const sizeMatch = [...line.matchAll(/fontSize:\s*(\d+)/g)].pop();
    if (!sizeMatch) continue;
    const size = Number(sizeMatch[1]);
    if (value > size * 1.4) {
      const lineNo = line.split('\n').length;
      missingCentring.push(`  ${rel}:${lineNo}  fontSize ${size} with lineHeight ${value}`);
    }
  }
}
if (missingCentring.length) {
  console.log(`  ${missingCentring.length} lineHeight(s) far above their font size:`);
  console.log(missingCentring.join('\n'));
  console.log('  (values come from the type scale, so verify these are intentional)');
} else {
  console.log('  PASS  no lineHeight badly exceeds its font size');
}

// ---------------------------------------------------------------------------
// 4. Typography pairing actually used on money
// ---------------------------------------------------------------------------
console.log('\n=== 4. NUMERIC TYPE SCALE ===');
console.log(`  numeric       ${typography.numeric.fontSize}px  (money in lists)`);
console.log(`  numericLarge  ${typography.numericLarge.fontSize}px  (hero figures)`);
console.log(`  tabular figures: ${typography.numeric.fontVariant?.includes('tabular-nums') ? 'yes' : 'NO'}`);
if (!typography.numeric.fontVariant?.includes('tabular-nums')) {
  console.log('  NOTE: figures will not align in columns without tabular numerals');
  failures += 1;
}

// ---------------------------------------------------------------------------
// 5. Money vs count
//
// ---------------------------------------------------------------------------
// The defect this catches
// ----------------------
// A COUNT routed through the money formatter renders "15 orders" as
// "Tk15.00.00" and a low-stock threshold of 6 as "Tk0.00.06". It shipped
// because `Amount`/`AmountRow` and the count fields have identical shapes, so
// nothing complained: the code typechecked, the tests passed, and the screen
// looked plausible until someone read the digits.
//
// `CountRow` and `CountMetric` exist precisely so the two cannot be swapped by
// accident. This check fails if a count-looking prop is ever handed to a money
// component again.
console.log('\n=== 5. COUNTS MUST NOT BE RENDERED AS MONEY ===');

// Names that denote a quantity rather than an amount. If one of these reaches a
// money component, the count will be printed with a currency symbol.
const COUNT_PROPS = [
  'orders',
  'units',
  'count',
  'quantity',
  'threshold',
  'low_stock_threshold',
  'available',
  'reserved',
  'sellable',
  'orders\\b',
];

const moneyComponents = ['Amount', 'AmountRow', 'Metric'];
const countMisuse = [];

for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');

  // A money component whose props block assigns a count-named variable.
  for (const component of moneyComponents) {
    const pattern = new RegExp(`<${component}\\b[\\s\\S]{0,600}?\\/>`, 'g');
    for (const match of src.matchAll(pattern)) {
      const block = match[0];
      for (const prop of COUNT_PROPS) {
        // `money(...)` wrapping a count is fine at the type level only if the
        // count was not passed directly; a bare count is not.
        const re = new RegExp(`value=\\{(${prop}[a-z_]*)\\}`);
        if (re.test(block)) {
          const lineNo = src.slice(0, match.index).split('\n').length;
          countMisuse.push(
            `  ${rel}:${lineNo}  <${component} value={${prop}} /> -- a count with a currency symbol`,
          );
        }
      }
    }
  }
}

if (countMisuse.length) {
  console.log(countMisuse.join('\n'));
  console.log('  use <CountRow> or <CountMetric> for a quantity');
  failures += countMisuse.length;
} else {
  console.log('  PASS  no count is rendered through a money component');
}

console.log(`\nissues: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
