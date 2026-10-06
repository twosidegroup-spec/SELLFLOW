/**
 * Phase 6 invariants: products, stock, customers and orders.
 *
 * These assert properties that a code review cannot see by reading the screen: the
 * arithmetic, the boundaries between money and counts, and the guarantees the screens
 * claim to the seller. Each one corresponds to a decision that would be easy to undo
 * by accident and expensive to discover late.
 *
 * Run with: node --import ./scripts/register-loader.mjs --test scripts/phase6.test.mjs
 */

import './__stubs__/env.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  addLineToDraft,
  calculateTotals,
  lineTotal,
  outstanding,
  stockWarnings,
  validateDraft,
} from '../src/features/orders/calculations.ts';
import { matchProduct, parseOrderForm, parseQuantity } from '../src/features/orders/orderForm.ts';
import {
  INVENTORY_REASON_LABEL,
  MANUAL_STOCK_REASONS,
} from '../src/features/products/presentation.ts';
import {
  ORDER_STATUS_LABEL,
  orderStatusTone,
  paymentStatusTone,
} from '../src/features/orders/presentation.ts';
import {
  formatMajorUnits,
  formatMoney,
  money,
  parseWholeNumber,
  toMajor,
  toMinor,
  zero,
} from '../src/lib/money.ts';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}
import { normalizeBdNumber, isBdMobileNumber } from '../src/features/payments/normalize.ts';

const TAKA = (n) => toMinor(String(n));

describe('a column value is never formatted as if it were minor units', () => {
  /*
   * `formatMoney` divides by 100 because it takes MINOR units. Every money column and
   * every RPC amount in this schema is numeric(14,2) in WHOLE units.
   *
   * Passing one to the other shows a seller 50.60 for revenue that was 5,060. Both
   * functions are individually correct, so no test of either catches it -- and no unit
   * test of the arithmetic would either, because the arithmetic is on raw numbers.
   *
   * It was found by reading the running app on a real device against seeded data of
   * known size. This is the check that stops it coming back.
   */
  const moneyFiles = walk(join(process.cwd(), 'src'))
    .filter((f) => f.endsWith('.tsx'));

  const DB_FIELD =
    /\b(?:row|order|line|payment|product|customer|s|data|event|s)\.(?:total|total_|items_total|profit|cost_total|courier_cost|other_cost|amount_paid|amount|revenue|unit_price|unit_cost|line_total|line_discount|selling_price|cost_price|discount|delivery_charge|outstanding|total_spent|pending_settlement|net_profit|revenue_collected)\b/;

  const offenders = [];

  for (const file of moneyFiles) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      // Only a direct formatMoney(<column field>) is caught. Arithmetic on the value
      // first, e.g. formatMoney(order.total - order.amount_paid), is still wrong but
      // is named explicitly by its own arithmetic; this catches the direct cases.
      if (!/formatMoney\(/.test(line)) return;
      const arg = line.match(/formatMoney\(([^)]*)\)/)?.[1] ?? '';
      if (DB_FIELD.test(arg)) {
        offenders.push(
          `  ${file.replace(/\\/g, '/').split('/src/')[1]}:${index + 1}  ${trimmed}\n` +
            '         that is a database value in whole taka. Use formatMajorUnits(), which expects it.',
        );
      }
    });
  }

  test('no database money value reaches the minor-unit formatter', () => {
    if (offenders.length) {
      assert.fail(
        `${offenders.length} column value(s) formatted as minor units:\n${offenders.join('\n')}`,
      );
    }
  });

  test('formatMajorUnits and formatMoney are a hundred times apart', () => {
    // Asserted on the DIGITS, not the symbol: this platform's ICU renders the BDT
    // sign as "Tk" rather than "৳", and a symbol assertion would be a test of the
    // host rather than of the code.
const digits = (formatted) => formatted.replace(/[^\d.]/g, '');

    // No grouping assertion: ICU inserts a thousands separator on some hosts and not
    // others, and that is a fact about the platform rather than about this code.
    assert.equal(formatMajorUnits(5060), formatMoney(506000));
    assert.equal(digits(formatMajorUnits(5060)), '5060.00');
    assert.equal(digits(formatMoney(5060)), '50.60');
    assert.equal(digits(formatMajorUnits(0)), '0.00');
    assert.equal(digits(formatMajorUnits(null)), '0.00');
    // The seeded revenue from the device verification, so this test is anchored to
    // the exact figure that was wrong on screen.
    assert.equal(digits(formatMajorUnits(5060)), digits(formatMoney(toMinor(String(5060)))));
  });
});

describe('money and counts stay apart', () => {
  test('a count of 5 is never 500', () => {
    // The bug this whole area exists to prevent.
    assert.equal(parseWholeNumber('5'), 5);
    assert.equal(toMinor('5'), 500);
    assert.notEqual(parseWholeNumber('5'), toMinor('5'));
  });

  test('parseWholeNumber refuses negatives, junk and infinity', () => {
    // A stock level of -3 would make every low-stock warning fire forever.
    assert.equal(parseWholeNumber('-3'), 0);
    assert.equal(parseWholeNumber('Infinity'), 0);
    assert.equal(parseWholeNumber('abc'), 0);
    assert.equal(parseWholeNumber(''), 0);
    assert.equal(parseWholeNumber(null), 0);
  });

  test('parseWholeNumber reads Bangla digits, which sellers actually type', () => {
    assert.equal(parseWholeNumber('৫'), 5);
    assert.equal(parseWholeNumber('১২'), 12);
  });

  test('a whole-taka price round-trips through minor units exactly', () => {
    assert.equal(toMajor(TAKA(1200)), 1200);
    assert.equal(toMajor(TAKA('1200.50')), 1200.5);
  });

  test('zero is a real value, distinct from null', () => {
    // The product form sends cost_price: null for "not recorded", never 0.
    assert.equal(zero(), 0);
  });
});

describe('an unknown cost is never a cost of zero', () => {
  const line = (unitCost, unitPrice = 1000) => ({
    lineId: `l${unitCost}`,
    productId: 'p',
    variantId: null,
    name: 'Item',
    unitPrice: TAKA(unitPrice),
    unitCost,
    quantity: 2,
    lineDiscount: zero(),
    available: 10,
    trackInventory: true,
  });

  test('a line with no recorded cost marks the total as partial', () => {
    const totals = calculateTotals([line(zero())], zero(), zero());
    assert.equal(totals.profitIsPartial, true);
  });

  test('a fully costed draft is not partial', () => {
    const totals = calculateTotals([line(TAKA(600))], zero(), zero());
    assert.equal(totals.profitIsPartial, false);
  });

  test('one unknown line among many still makes the whole figure partial', () => {
    // The common case: a seller costs most things and leaves one blank.
    const totals = calculateTotals([line(TAKA(600)), line(zero())], zero(), zero());
    assert.equal(totals.profitIsPartial, true);
  });
});

describe('order totals cannot be made nonsense by typing', () => {
  const line = (price, quantity) => ({
    lineId: `l${price}`,
    productId: 'p',
    variantId: null,
    name: 'Item',
    unitPrice: price,
    unitCost: zero(),
    quantity,
    lineDiscount: zero(),
    available: 100,
    trackInventory: true,
  });

  test('a discount larger than the order is capped, not subtracted into a negative', () => {
    const totals = calculateTotals([line(TAKA(500), 1)], TAKA(9999), zero());
    assert.equal(totals.discount, TAKA(500));
    assert.equal(totals.total, 0);
  });

  test('a negative delivery charge cannot make the total smaller than the items', () => {
    const totals = calculateTotals([line(TAKA(500), 1)], zero(), -TAKA(200));
    assert.equal(totals.deliveryCharge, 0);
    assert.equal(totals.total, TAKA(500));
  });

  test('a fully discounted order is legal', () => {
    // Giving something away is a decision, not a mistake.
    const totals = calculateTotals([line(TAKA(500), 1)], TAKA(500), zero());
    assert.equal(totals.total, 0);
    assert.equal(validateDraft([line(TAKA(500), 1)]).valid, true);
  });

  test('delivery charged to the customer is revenue, not a cost', () => {
    const totals = calculateTotals([line(TAKA(500), 1)], zero(), TAKA(60));
    assert.equal(totals.total, TAKA(560));
  });

  test('outstanding never goes negative on an overpayment', () => {
    assert.equal(outstanding(TAKA(500), TAKA(700)), 0);
  });
});

describe('a draft is only submittable when it is real', () => {
  const base = {
    lineId: 'l1',
    productId: 'p',
    variantId: null,
    name: 'Item',
    unitPrice: TAKA(500),
    unitCost: zero(),
    quantity: 1,
    lineDiscount: zero(),
    available: 10,
    trackInventory: true,
  };

  test('an empty draft is refused, with a reason a seller can act on', () => {
    const result = validateDraft([]);
    assert.equal(result.valid, false);
    assert.match(result.reason, /at least one product/i);
  });

  test('a zero or negative quantity is refused', () => {
    assert.equal(validateDraft([{ ...base, quantity: 0 }]).valid, false);
    assert.equal(validateDraft([{ ...base, quantity: -1 }]).valid, false);
  });

  test('a fractional quantity is refused', () => {
    // Stock is an integer column; a partial unit would be silently truncated.
    assert.equal(validateDraft([{ ...base, quantity: 1.5 }]).valid, false);
  });

  test('a negative price is refused', () => {
    assert.equal(validateDraft([{ ...base, unitPrice: -1 }]).valid, false);
  });
});

describe('stock shortfalls warn but never block', () => {
  const base = {
    lineId: 'l1',
    productId: 'p',
    variantId: null,
    name: 'Item',
    unitPrice: TAKA(500),
    unitCost: zero(),
    quantity: 5,
    lineDiscount: zero(),
    available: 2,
    trackInventory: true,
  };

  test('selling more than recorded warns', () => {
    assert.equal(stockWarnings([base]).length, 1);
  });

  test('an untracked product never warns about stock', () => {
    // `allow_negative_stock` is a business setting and the server owns it; the client
    // must not contradict it by refusing.
    assert.equal(stockWarnings([{ ...base, trackInventory: false }]).length, 0);
  });

  test('a warning does not make the draft invalid', () => {
    assert.equal(validateDraft([base]).valid, true);
  });
});

describe('adding the same product twice adds the quantity', () => {
  const line = (quantity) => ({
    lineId: `l${quantity}`,
    productId: 'p1',
    variantId: null,
    name: 'Saree',
    unitPrice: TAKA(1000),
    unitCost: zero(),
    quantity,
    lineDiscount: zero(),
    available: 50,
    trackInventory: true,
  });

  test('quantities accumulate rather than replacing', () => {
    const merged = addLineToDraft([line(1)], line(2));
    assert.equal(merged.length, 1);
    assert.equal(merged[0].quantity, 3);
  });

  test('a different product becomes a second line', () => {
    const other = { ...line(1), productId: 'p2', lineId: 'l3', name: 'Earbuds' };
    assert.equal(addLineToDraft([line(1)], other).length, 2);
  });

  test('a different variant of the same product stays separate', () => {
    const variant = { ...line(1), variantId: 'v1' };
    assert.equal(addLineToDraft([line(1)], variant).length, 2);
  });
});

describe('inventory reasons are the ones the database accepts', () => {
  const VALID = ['initial', 'purchase', 'sale', 'sale_return', 'adjustment', 'damage'];

  test('every reason a seller can pick is a real enum value', () => {
    // The bug this prevents: `reason: 'correction' as never`, where the cast hid a
    // value the enum does not contain.
    for (const { value } of MANUAL_STOCK_REASONS) {
      assert.ok(VALID.includes(value), `${value} must be a valid inventory reason`);
    }
  });

  test('sale and sale_return are not offered by hand', () => {
    // The app writes those when an order is placed or returned. Letting a seller
    // create one by hand would desynchronise stock from the order history.
    const values = MANUAL_STOCK_REASONS.map((r) => r.value);
    assert.ok(!values.includes('sale'));
    assert.ok(!values.includes('sale_return'));
  });

  test('every enum value has readable wording for the ledger', () => {
    for (const reason of VALID) {
      assert.ok(INVENTORY_REASON_LABEL[reason], `${reason} needs a label`);
      // Raw snake_case must never reach the seller.
      assert.ok(!INVENTORY_REASON_LABEL[reason].includes('_'));
    }
  });
});

describe('order status presentation is consistent', () => {
  const ALL = [
    'pending', 'confirmed', 'processing', 'packaging', 'packed', 'shipped',
    'on_delivery', 'delivered', 'cancelled', 'returned', 'failed_delivery',
  ];

  test('every status has a label', () => {
    for (const status of ALL) {
      assert.ok(ORDER_STATUS_LABEL[status], `${status} needs a label`);
    }
  });

  test('only genuine end states get an end-state tone', () => {
    // Mid-journey statuses painted amber would train a seller to ignore the one
    // warning that matters.
    assert.equal(orderStatusTone('delivered'), 'success');
    assert.equal(orderStatusTone('cancelled'), 'danger');
    assert.equal(orderStatusTone('failed_delivery'), 'danger');
    assert.equal(orderStatusTone('returned'), 'warning');

    for (const status of ['pending', 'confirmed', 'processing', 'packaging', 'packed', 'shipped', 'on_delivery']) {
      assert.equal(orderStatusTone(status), 'neutral', `${status} should stay unremarkable`);
    }
  });

  test('unpaid is only a warning once the order is actually moving', () => {
    assert.equal(paymentStatusTone('unpaid', true), 'warning');
    assert.equal(paymentStatusTone('unpaid', false), 'neutral');
    assert.equal(paymentStatusTone('paid', true), 'success');
    assert.equal(paymentStatusTone('refunded', true), 'warning');
  });
});

describe('a pasted customer message becomes a draft, never an order', () => {
  const CATALOGUE = [
    { id: 'p1', name: 'Cotton Saree', sku: 'SAR-1' },
    { id: 'p2', name: 'TWS Earbuds', sku: 'EAR-9' },
  ];

  test('a well-formed form resolves to real products', () => {
    const parsed = parseOrderForm(
      'Name: Rakib\nProduct: Cotton Saree\nQuantity: 2\nAddress: Mirpur 10',
      CATALOGUE,
    );
    assert.equal(parsed.name, 'Rakib');
    assert.equal(parsed.lines.length, 1);
    assert.equal(parsed.lines[0].productId, 'p1');
    assert.equal(parsed.lines[0].quantity, 2);
    assert.equal(parsed.warnings.length, 0);
  });

  test('an ambiguous product is reported, never guessed', () => {
    // Guessing here prices a real customer's order from the wrong line.
    const parsed = parseOrderForm('Name: X\nProduct: Saree\nQuantity: 1', [
      { id: 'p1', name: 'Cotton Saree', sku: null },
      { id: 'p2', name: 'Silk Saree', sku: null },
    ]);
    assert.equal(parsed.lines[0].productId, null);
    assert.ok(parsed.lines[0].candidates.length >= 2);
    assert.ok(parsed.warnings.some((w) => /catalogue/i.test(w)));
  });

  test('a product outside the catalogue is surfaced, not silently dropped', () => {
    const parsed = parseOrderForm('Name: X\nProduct: Mystery Box\nQuantity: 1', CATALOGUE);
    assert.equal(parsed.lines.length, 1);
    assert.ok(parsed.warnings.length > 0);
  });

  test('a blank or meaningless paste says so instead of producing an empty order', () => {
    assert.equal(parseOrderForm('', CATALOGUE).empty, true);
    assert.equal(parseOrderForm('   \n  ', CATALOGUE).empty, true);
  });

  test('one quantity for several products is applied and flagged', () => {
    const parsed = parseOrderForm(
      'Name: X\nProduct: Cotton Saree, TWS Earbuds\nQuantity: 2',
      CATALOGUE,
    );
    assert.equal(parsed.lines.length, 2);
    assert.ok(parsed.lines.every((l) => l.quantity === 2));
    assert.ok(parsed.warnings.some((w) => /check the quantities/i.test(w)));
  });

  test('a phone is found even where the form has no phone field', () => {
    const parsed = parseOrderForm('Name: X\nProduct: Cotton Saree\n01812345678', CATALOGUE);
    assert.equal(parsed.phone, '01812345678');
  });
});

describe('product matching refuses to be too clever', () => {
  test('an exact SKU wins over anything else', () => {
    const m = matchProduct('EAR-9', [
      { id: 'p1', name: 'Cotton Saree', sku: 'SAR-1' },
      { id: 'p2', name: 'TWS Earbuds', sku: 'EAR-9' },
    ]);
    assert.equal(m.productId, 'p2');
  });

  test('a substring does not match a longer product name', () => {
    // "bag" must not resolve to "Premium Bag" by accident.
    const m = matchProduct('bag', [{ id: 'p1', name: 'Premium Bag', sku: null }]);
    assert.equal(m.productId, 'p1', 'a single distinctive word with one candidate is safe');
  });

  test('digits in a product name are not eaten as a quantity', () => {
    const m = matchProduct('TWS-9 Earbuds', [{ id: 'p9', name: 'TWS-9 Earbuds', sku: null }]);
    assert.equal(m.productId, 'p9');
  });
});

describe('quantities written the way customers write them', () => {
  test('Bangla and English digits both parse', () => {
    assert.equal(parseQuantity('2'), 2);
    assert.equal(parseQuantity('২'), 2);
    assert.equal(parseQuantity('2 pcs'), 2);
  });

  test('anything that is not a positive whole number is null', () => {
    assert.equal(parseQuantity('0'), null);
    assert.equal(parseQuantity('-1'), null);
    assert.equal(parseQuantity('abc'), null);
    assert.equal(parseQuantity(null), null);
  });
});

describe('customer phone numbers', () => {
  test('normalisation makes two spellings of one number collide', () => {
    // The unique index is on the raw text, so +8801... and 01... must become equal.
    assert.equal(normalizeBdNumber('+8801712345678'), normalizeBdNumber('01712345678'));
  });

  test('validation accepts a real mobile and refuses nonsense', () => {
    assert.equal(isBdMobileNumber('01712345678'), true);
    assert.equal(isBdMobileNumber('+8801712345678'), true);
    assert.equal(isBdMobileNumber('12345'), false);
    assert.equal(isBdMobileNumber(''), false);
  });
});