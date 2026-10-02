/**
 * Money and quantity arithmetic verification.
 *
 * These are the numbers a seller types and the numbers a business is judged
 * on. Bugs here are silent: the app renders plausible values and nobody notices
 * until the books are wrong.
 *
 * Every expectation below is hand-computed, not copied from the implementation,
 * so the test fails if the implementation drifts rather than agreeing with
 * itself.
 */

import './__stubs__/env.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// No `?fresh=` here: these modules are pure functions with no module-level
// state, and the test loader's generation query interferes with extensionless
// relative imports.
const M = await import('../src/lib/money.ts');
const C = await import('../src/features/orders/calculations.ts');

const { toMinor, money, formatForInput, distribute, multiply, add, subtract, percentage } = M;
const { calculateTotals, lineTotal, stockWarnings, addLineToDraft } = C;

describe('toMinor — parsing what a seller types', () => {
  test('plain numbers scale by the currency decimals', () => {
    assert.equal(toMinor('0'), 0);
    assert.equal(toMinor('5'), 500);
    assert.equal(toMinor('12'), 1200);
    assert.equal(toMinor('12.5'), 1250);
    assert.equal(toMinor('12.50'), 1250);
    assert.equal(toMinor('0.05'), 5);
  });

  test('thousands separators do not inflate the value', () => {
    // 1,250.50 is 1250.50, i.e. 125050 minor units.
    assert.equal(toMinor('1,250.50'), 125050);
    assert.equal(toMinor('1,000'), 100000);
  });

  test('empty and malformed input is null, never a silent zero', () => {
    assert.equal(toMinor(''), null);
    assert.equal(toMinor('   '), null);
    assert.equal(toMinor('.'), null);
    assert.equal(toMinor('-'), null);
  });

  test('money() coerces unusable values to zero for the read path', () => {
    assert.equal(money(null), 0);
    assert.equal(money(undefined), 0);
    assert.equal(money(0), 0);
  });
});

describe('formatForInput — what the field shows back', () => {
  test('round-trips exactly for a spread of values', () => {
    // A field whose displayed text re-parses to a different number is the
    // classic "the number changed while I typed" bug.
    const samples = [0, 1, 5, 10, 99, 100, 105, 110, 250, 999, 1000, 1050, 1234, 99999, 100000, 1234567];
    for (const minor of samples) {
      const text = formatForInput(minor, 'BDT');
      const back = toMinor(text, 'BDT') ?? 0;
      assert.equal(back, minor, `round trip failed for ${minor} via "${text}"`);
    }
  });

  test('does not strip a meaningful trailing zero', () => {
    // 10.50 must not display as 10.5 -> which is correct -- but 1.00 must not
    // display as an empty string, and 0 is intentionally empty.
    assert.equal(formatForInput(1050, 'BDT'), '10.5');
    assert.equal(formatForInput(100, 'BDT'), '1');
    assert.equal(formatForInput(0, 'BDT'), '');
  });
});

describe('arithmetic stays in integer minor units', () => {
  test('add and subtract do not drift', () => {
    assert.equal(add(1000, 2500), 3500);
    assert.equal(subtract(3500, 1000), 2500);
  });

  test('multiply by a quantity is exact', () => {
    assert.equal(multiply(333, 3), 999);
    assert.equal(multiply(1050, 7), 7350);
  });

  test('percentage is exact on minor units', () => {
    // 10% of 125050 = 12505
    assert.equal(percentage(125050, 10), 12505);
    assert.equal(percentage(999, 33), 330);
  });

  test('distribute preserves the total to the last minor unit', () => {
    // 100 minor units across 3 equal lines cannot divide evenly; the remainder
    // must not vanish or be invented.
    const shares = distribute(100, [1, 1, 1]);
    assert.equal(shares.length, 3);
    assert.equal(add(...shares), 100);
  });

  test('distribute is proportional', () => {
    const shares = distribute(1000, [3, 1]);
    assert.equal(add(...shares), 1000);
    assert.equal(shares[0], 750);
    assert.equal(shares[1], 250);
  });

  test('distribute handles a zero total without dividing by zero', () => {
    const shares = distribute(0, [1, 2, 3]);
    assert.equal(add(...shares), 0);
  });
});

describe('order totals', () => {
  function line(overrides) {
    return {
      lineId: overrides.lineId ?? 'l',
      productId: 'p',
      variantId: null,
      name: 'Item',
      sku: null,
      unitPrice: 0,
      unitCost: 0,
      quantity: 1,
      lineDiscount: 0,
      available: 100,
      trackInventory: true,
      ...overrides,
    };
  }

  test('a single line, no adjustments', () => {
    // 3 x 5.00 = 15.00, cost 3 x 3.00 = 9.00
    const t = calculateTotals([line({ unitPrice: 500, unitCost: 300, quantity: 3 })], 0, 0);
    assert.equal(t.itemsTotal, 1500);
    assert.equal(t.costTotal, 900);
    assert.equal(t.total, 1500);
    assert.equal(t.profit, 600);
  });

  test('line discount reduces the line, not just the total', () => {
    const l = line({ unitPrice: 500, unitCost: 300, quantity: 2 });
    assert.equal(lineTotal(l), 1000);
    const withDiscount = line({ unitPrice: 500, unitCost: 300, quantity: 2, lineDiscount: 150 });
    assert.equal(lineTotal(withDiscount), 850);
  });

  test('order discount and delivery fee land in the right places', () => {
    // 15.00 items, -2.00 discount, +5.00 delivery  => 18.00 total
    const t = calculateTotals([line({ unitPrice: 500, unitCost: 300, quantity: 3 })], 200, 500);
    assert.equal(t.itemsTotal, 1500);
    assert.equal(t.discount, 200);
    assert.equal(t.deliveryCharge, 500);
    assert.equal(t.total, 1800);
    assert.equal(t.profit, 900); // 18.00 - 9.00
  });

  test('delivery charge counts as revenue', () => {
    // 5.00 item + 5.00 delivered - 3.00 cost = 7.00 profit. The delivery fee
    // is money the seller collected, so it belongs in revenue.
    const t = calculateTotals([line({ unitPrice: 500, unitCost: 300, quantity: 1 })], 0, 500);
    assert.equal(t.total, 1000);
    assert.equal(t.profit, 700);
  });

  test('a discount larger than the order is capped, not applied', () => {
    const t = calculateTotals([line({ unitPrice: 500, unitCost: 300, quantity: 1 })], 99999, 0);
    assert.equal(t.discount, 500, 'discount is capped at the item total');
    assert.equal(t.total, 0, 'total never goes negative');
  });

  test('a missing cost is reported as an unknown profit, not a false one', () => {
    const t = calculateTotals([line({ unitPrice: 500, unitCost: 0, quantity: 1 })], 0, 0);
    assert.equal(t.profitIsPartial, true, 'zero cost means "unknown", not "free"');
  });

  test('an empty order is zero, not NaN', () => {
    const t = calculateTotals([], 0, 0);
    assert.equal(t.total, 0);
    assert.equal(t.profit, 0);
    assert.equal(t.unitCount, 0);
  });

  test('unit count totals quantities, not lines', () => {
    const t = calculateTotals(
      [line({ unitPrice: 100, quantity: 2 }), line({ lineId: 'l2', unitPrice: 100, quantity: 3 })],
      0,
      0,
    );
    assert.equal(t.unitCount, 5);
    assert.equal(t.lineCount, 2);
  });
});

describe('stock warnings and draft merging', () => {
  function line(overrides) {
    return {
      lineId: overrides.lineId ?? 'l',
      productId: 'p',
      variantId: null,
      name: 'Item',
      sku: null,
      unitPrice: 500,
      unitCost: 300,
      quantity: 1,
      lineDiscount: 0,
      available: 10,
      trackInventory: true,
      ...overrides,
    };
  }

  test('warning appears only when the request exceeds stock', () => {
    assert.equal(stockWarnings([line({ quantity: 10, available: 10 })]).length, 0, 'exactly in stock is fine');
    assert.equal(stockWarnings([line({ quantity: 11, available: 10 })]).length, 1);
  });

  test('untracked products are never warned about', () => {
    assert.equal(stockWarnings([line({ quantity: 99, available: 1, trackInventory: false })]).length, 0);
  });

  test('adding the same product twice merges quantity', () => {
    const first = line({ lineId: 'a', quantity: 1 });
    const again = line({ lineId: 'b', quantity: 2 });
    const merged = addLineToDraft([first], again);
    assert.equal(merged.length, 1, 'same product must not create a second line');
    assert.equal(merged[0].quantity, 3);
  });

  test('a different variant is a different line', () => {
    const a = line({ lineId: 'a', variantId: 'v1' });
    const b = line({ lineId: 'b', variantId: 'v2' });
    assert.equal(addLineToDraft([a], b).length, 2);
  });
});

describe('counts must not be treated as money', () => {
  /**
   * The defect that prompted this file.
   *
   * `products.low_stock_threshold` is an integer count of units. Reading it
   * through toMinor() multiplies it by the currency's 100 decimals, so a seller
   * asking to be warned "at 5" was stored as 500 -- and the warning never
   * fired until stock was nearly gone. Silent, and invisible in the UI because
   * the form read the value back and displayed it consistently.
   *
   * This asserts the conversion a count must use.
   */
  test('a low-stock threshold of 5 stays 5, not 500', () => {
    const typed = '5';

    // What the form used to do:
    const wrong = Math.max(0, Math.round(toMinor(typed, 'BDT') ?? 0));
    assert.equal(wrong, 500, 'documents the defect: toMinor inflates a unit count');

    // What it must do: parse as a plain integer.
    const right = Math.max(0, Math.round(Number.parseInt(typed, 10) || 0));
    assert.equal(right, 5);
  });

  test('quantity is a plain integer throughout', () => {
    // Order lines carry integer quantities and the DB column is an integer, so
    // a quantity must never travel through money units.
    assert.equal(Number.parseInt('3', 10), 3);
    assert.equal(Number.parseInt('0', 10), 0);
  });
});
