/**
 * Money FORMAT verification.
 *
 * Separate from money.test.mjs, which covers parsing and arithmetic, because
 * `formatMoney` had no coverage at all -- and was appending the decimal
 * fraction twice, so every amount in the app read "Tk9,440.00.00".
 *
 * These are the exact strings a seller reads off the screen.
 */

import './__stubs__/env.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../src/lib/money.ts');
const { formatMoney, formatCompactMoney, money } = M;

describe('formatMoney — what the seller actually reads', () => {
  test('the fraction appears exactly once', () => {
    // The regression: Intl already emits ".00", and the fraction was then
    // appended again, giving "Tk9,440.00.00".
    assert.equal(formatMoney(944000, 'BDT'), 'Tk9,440.00');
    assert.equal(formatMoney(0, 'BDT'), 'Tk0.00');
    assert.equal(formatMoney(500, 'BDT'), 'Tk5.00');
    assert.equal(formatMoney(1, 'BDT'), 'Tk0.01');
    assert.equal(formatMoney(105, 'BDT'), 'Tk1.05');
  });

  test('there is never more than one decimal point', () => {
    const samples = [0, 1, 7, 99, 100, 101, 999, 1000, 1001, 12345, 99999, 100000, 123456789];
    for (const minor of samples) {
      const text = formatMoney(minor, 'BDT');
      const dots = (text.match(/\./g) ?? []).length;
      assert.equal(dots, 1, `${minor} rendered as "${text}"`);
    }
  });

  test('grouping, sign and symbol', () => {
    assert.equal(formatMoney(125050, 'BDT'), 'Tk1,250.50');
    assert.equal(formatMoney(-441000, 'BDT'), '-Tk4,410.00');
    assert.equal(formatMoney(125050, 'BDT', { showSymbol: false }), '1,250.50');
    assert.equal(formatMoney(123456789, 'BDT'), 'Tk1,234,567.89');
  });

  test('whole-taka mode drops the decimals but keeps the currency', () => {
    assert.equal(formatMoney(245000, 'BDT', { showZeroDecimals: true }), 'Tk2,450');
    assert.equal(formatMoney(-45000, 'BDT', { showZeroDecimals: true }), '-Tk450');
    assert.equal(formatMoney(4380000, 'BDT', { showZeroDecimals: true }), 'Tk43,800');
  });

  test('money() then formatMoney() is an identity, not a multiplication', () => {
    // The whole pipeline the screens use. A whole number in the database must
    // come out as the same number of taka, not a hundred times more.
    for (const major of [0, 5, 60, 320, 2450, 13050, 247500, 1234567]) {
      assert.equal(
        formatMoney(money(major, 'BDT'), 'BDT'),
        `Tk${major.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`,
        `${major} did not survive the read path`,
      );
    }
  });
});

describe('formatCompactMoney — the short form', () => {
  test('takes MINOR units, like every other formatter here', () => {
    // The regression: two hand-rolled copies took major units while their
    // callers passed `money()` output, so "Unpaid to you" read Tk4.2M for a
    // balance of Tk42,000.
    assert.equal(formatCompactMoney(4200000, 'BDT'), 'Tk42k');
    assert.equal(formatCompactMoney(4387000, 'BDT'), 'Tk43.9k');
    assert.equal(formatCompactMoney(234500000, 'BDT'), 'Tk2.3M');
  });

  test('never claims a precision it does not have', () => {
    assert.equal(formatCompactMoney(19000, 'BDT'), 'Tk190');
    assert.equal(formatCompactMoney(99000, 'BDT'), 'Tk990');
    assert.equal(formatCompactMoney(99500, 'BDT'), 'Tk995');
    // Tk999.50 rounds to a thousand, so it moves up a bucket rather than
    // printing "Tk1,000" beside a genuine "Tk1.0k".
    assert.equal(formatCompactMoney(99950, 'BDT'), 'Tk1k');
    assert.equal(formatCompactMoney(5000, 'BDT'), 'Tk50');
    assert.equal(formatCompactMoney(1050, 'BDT'), 'Tk10.5');
  });

  test('zero and negatives', () => {
    assert.equal(formatCompactMoney(0, 'BDT'), 'Tk0');
    assert.equal(formatCompactMoney(-1500000, 'BDT'), '-Tk15k');
  });

  test('no trailing ".0"', () => {
    for (const minor of [100000, 200000, 3000000, 40000000]) {
      assert.ok(
        !formatCompactMoney(minor, 'BDT').includes('.0'),
        `${minor} rendered as "${formatCompactMoney(minor, 'BDT')}"`,
      );
    }
  });
});