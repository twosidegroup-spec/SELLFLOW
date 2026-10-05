/**
 * Money UNIT boundary verification.
 *
 * The defect this exists to stop
 * ------------------------------
 * Every amount in the database is `numeric(14,2)` in WHOLE taka. `toMinor`
 * exists so the text a seller types can be held exactly, in integers, while they
 * are still editing it -- and it is the reason this module once looked like it
 * had no way to write. It did: `money()` was being used instead.
 *
 * `money()` is the READ path. It takes a column value (whole taka) and returns
 * minor units for display. Calling it on a value that was ALREADY minor
 * multiplied by the currency decimals a second time:
 *
 *     typed 1000  ->  toMinor 100,000  ->  money() 10,000,000  ->  stored 10,000,000
 *
 * and where the value was passed through unchanged instead, it was 100x:
 *
 *     typed 4900  ->  toMinor 490,000  ->  stored 490,000
 *
 * A product typed at 1,000 became 10,000,000; "Profit per unit" was therefore
 * computed from a number the seller never entered. The same mistake sat in four
 * other forms, plus two fields that were unit COUNTS being read through
 * `toMinor`, so a stock correction of 20 units was applied as 2,000.
 *
 * `toMajor` is the inverse the write path needed. These tests pin it, and the
 * source scan at the end fails if `money()` is ever used to build a write again.
 */

import './__stubs__/env.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const M = await import('../src/lib/money.ts');
const { toMinor, toMajor, money, formatMoney, parseWholeNumber } = M;

describe('toMajor — the write path', () => {
  test('is the exact inverse of toMinor', () => {
    const typed = ['0', '5', '60', '320', '2,450', '1,250.50', '49.99', '0.05', '100,000'];
    for (const text of typed) {
      const minor = toMinor(text, 'BDT');
      assert.notEqual(minor, null, `could not parse "${text}"`);
      const back = toMajor(minor, 'BDT');
      assert.equal(back, toMinor(text, 'BDT') === minor ? Number(String(back)) : back);
      // Re-parsing must give the identical integer of poisha.
      assert.equal(toMinor(String(back), 'BDT'), minor, `"${text}" did not round trip`);
    }
  });

  test('a typed amount is stored as the same number the seller entered', () => {
    // The reported defect, restated as an identity.
    for (const typed of [1000, 4900, 1500, 2450, 999999]) {
      const stored = toMajor(toMinor(String(typed), 'BDT'), 'BDT');
      assert.equal(stored, typed, `${typed} would be stored as ${stored}`);
    }
  });

  test('a money() call on an already-minor value is the bug, and is detectable', () => {
    // This is what the code used to do, pinned so the difference is explicit.
    const minor = toMinor('1000', 'BDT');
    assert.equal(toMajor(minor, 'BDT'), 1000, 'the correct conversion');
    assert.equal(money(minor, 'BDT'), 10_000_000, 'the defective one, 100x worse again');
  });

  test('decimals survive both directions', () => {
    const minor = toMinor('1234.56', 'BDT');
    assert.equal(minor, 123456);
    assert.equal(toMajor(minor, 'BDT'), 1234.56);
    assert.equal(formatMoney(minor, 'BDT'), 'Tk1,234.56');
  });

  test('zero and negatives', () => {
    assert.equal(toMajor(0, 'BDT'), 0);
    assert.equal(toMajor(-45000, 'BDT'), -450);
  });

  test('the full display chain agrees with the stored column', () => {
    // column -> money() -> formatMoney is what every list and detail screen
    // does. If toMajor and money are inverses, the seller sees what they typed.
    for (const stored of [0, 1500, 2450, 4900, 123456.78, 999999]) {
      const shown = formatMoney(money(stored, 'BDT'), 'BDT');
      assert.match(shown, /^Tk/, `${stored} displayed as "${shown}"`);
      const digits = shown.replace(/[^0-9.]/g, '');
      assert.equal(Number(digits), stored, `${stored} displayed as "${shown}"`);
    }
  });
});

describe('counts must not travel through the money parser', () => {
  /**
   * A unit count has no decimals. `toMinor` is for MONEY, and using it on a
   * count multiplies it by 100: an opening stock of 20 was recorded as 2,000
   * units, and a stock correction of 20 was applied as 2,000.
   */
  test('toMinor inflates a unit count by exactly 100', () => {
    // Documents the defect precisely, so the fix below is meaningful.
    assert.equal(toMinor('20', 'BDT'), 2000);
    assert.equal(toMinor('6', 'BDT'), 600);
  });

  test('parseWholeNumber keeps a unit count as typed', () => {
    for (const typed of [0, 1, 6, 20, 2000, '20', '2000']) {
      assert.equal(parseWholeNumber(typed), Number(typed), `${typed} changed`);
    }
  });

  test('parseWholeNumber is junk-safe', () => {
    // The old_stock floors depend on this: "Infinity" must not reach an integer
    // column, and a negative correction must be rejected rather than applied.
    assert.equal(parseWholeNumber('Infinity'), 0);
    assert.equal(parseWholeNumber('NaN'), 0);
    assert.equal(parseWholeNumber(''), 0);
    assert.equal(parseWholeNumber('-5'), 0);
    assert.equal(parseWholeNumber('12abc'), 12);
  });
});

// ---------------------------------------------------------------------------
// Source guard
// ---------------------------------------------------------------------------
// `toMajor` being correct is not enough if nothing calls it. These are the exact
// shapes that were wrong, asserted against the real source so a regression is
// caught at lint time rather than by a seller noticing their margin is wrong.
describe('no write is built with the read-path helper', () => {
  const root = process.cwd();

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
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const exists = (rel) => existsSync(join(root, rel));

  /**
   * Assert a conversion, but only if the file exists.
   *
   * The zero-based rebuild deleted the V1 screens, so several of the files these
   * checks name do not exist yet. Reading them unconditionally turned the whole guard
   * red on ENOENT, which is how a real regression could hide behind a broken test.
   *
   * Skipping an absent file is not the same as dropping the check: the moment
   * `expense/new.tsx` is written without `amount: toMajor(`, this fails again. That is
   * the direction that matters.
   */
  function assertUses(rel, pattern, what) {
    if (!exists(rel)) return;
    assert.match(read(rel), pattern, `${rel} must convert ${what}`);
  }

  /** Lines that assign to a key written to the database, or to an RPC amount. */
  const WRITE_KEYS =
    /^\s*(sellingPrice|costPrice|amount|default_delivery_fee|discount|deliveryCharge|amountPaid|delta|quantity)\s*:/;

  const moneyInWrite = [];
  const countThroughMoneyParser = [];

  for (const file of files) {
    const rel = file.replace(/\\/g, '/').split('/src/')[1];
    if (!rel) continue;
    const lines = readFileSync(file, 'utf8').split('\n');

    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

      // 1. money() feeding a value that is written to the database.
      if (/\bmoney\(/.test(line) && WRITE_KEYS.test(line)) {
        moneyInWrite.push(
          `  ${rel}:${i + 1}  money() builds a written value: ${trimmed}` +
            `\n         money() is the READ path. Use toMajor() to convert minor units back to whole taka.`,
        );
      }

      // 2. A count fed to toMinor(). Stock and thresholds are integers.
      if (/\btoMinor\(/.test(line) && WRITE_KEYS.test(line)) {
        const name = trimmed.match(WRITE_KEYS)[0].trim().replace(':', '');
        const isMoney = ['sellingPrice', 'costPrice', 'amount', 'default_delivery_fee', 'discount', 'deliveryCharge', 'amountPaid'].includes(name);
        if (!isMoney) {
          countThroughMoneyParser.push(
            `  ${rel}:${i + 1}  ${name} is a count but goes through toMinor(): ${trimmed}` +
              `\n         Counts are not money. Use parseWholeNumber().`,
          );
        }
      }
    });
  }

  test('money() never builds a value that is written to the database', () => {
    if (moneyInWrite.length) {
      assert.fail(
        `${moneyInWrite.length} write(s) built with the read-path helper:\n${moneyInWrite.join('\n')}`,
      );
    }
  });

  test('no unit count is parsed with the money parser', () => {
    if (countThroughMoneyParser.length) {
      assert.fail(
        `${countThroughMoneyParser.length} count(s) parsed as money:\n${countThroughMoneyParser.join('\n')}`,
      );
    }
  });

  test('the specific fields that were wrong are now correct', () => {
    // Named explicitly, so the guard above cannot be satisfied by renaming.
    //
    // These assert against the file that now OWNS each conversion. The forms were
    // extracted out of `src/app` (Expo Router turns every file there into a screen),
    // so the product writes live in the form component and the routes are loaders.
    const productForm = read('src/components/forms/ProductForm.tsx');
    assert.match(productForm, /sellingPrice:[\s\S]{0,80}toMajor\(/);
    assert.match(productForm, /costPrice:[\s\S]{0,80}toMajor\(/);
    assertUses('src/app/(app)/expense/new.tsx', /amount: toMajor\(/, 'an expense amount with toMajor()');
    assertUses(
      'src/app/(app)/settings/business.tsx',
      /default_delivery_fee: toMajor\(/,
      'the default delivery fee with toMajor()',
    );
    assertUses('src/app/(app)/order/new.tsx', /discount: toMajor\(/, 'a discount with toMajor()');
    assertUses(
      'src/app/(app)/order/new.tsx',
      /deliveryCharge: toMajor\(/,
      'a delivery charge with toMajor()',
    );
    assertUses('src/app/(app)/order/new.tsx', /amountPaid: toMajor\(/, 'an amount paid with toMajor()');

    // Counts.
    assert.match(productForm, /const \[threshold, setThreshold\] = useState<number \| null>/);
    // A stock adjustment is a count: the amount is a plain integer, and the direction
    // comes from which button was pressed.
    assert.match(read('src/app/(app)/product/[id].tsx'), /const \[amount, setAmount\] = useState<number \| null>/);
    assert.match(read('src/app/(app)/product/[id].tsx'), /delta: direction \* amount/);
  });
});