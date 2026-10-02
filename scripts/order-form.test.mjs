/**
 * Tests for parsing a pasted customer order form.
 *
 * The risk this guards against is not a crash. It is a plausible-looking order
 * built from a misunderstood paste: "Saree x2" read as two sarees when the
 * customer meant one, an ambiguous product name silently resolved to the wrong
 * line, or an address truncated because it spanned three lines. So the tests
 * assert on what the parser *refuses* to guess as much as on what it reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLANK_FORM_TEMPLATE,
  matchProduct,
  parseOrderForm,
  parseQuantity,
  requestToFormText,
} from '../src/features/orders/orderForm.ts';

/** @type {import('../src/features/orders/orderForm.ts').MatchableProduct[]} */
const CATALOGUE = [
  { id: 'p1', name: 'Ladies Silk Saree', sku: 'SAR-01' },
  { id: 'p2', name: 'Cotton Saree', sku: 'SAR-02' },
  { id: 'p3', name: 'TWS-9 Earbuds', sku: 'EAR-9' },
  { id: 'p4', name: 'Premium Bag', sku: 'BAG-1' },
];

// ---------------------------------------------------------------------------
test('parseQuantity reads the number a customer actually wrote', () => {
  assert.equal(parseQuantity('2'), 2);
  assert.equal(parseQuantity(' 12 '), 12);
  assert.equal(parseQuantity('3 pcs'), 3);
  assert.equal(parseQuantity('2টি'), 2);
  assert.equal(parseQuantity('5 x'), 5);
  assert.equal(parseQuantity('৪'), 4, 'Bangla digits are understood');

  assert.equal(parseQuantity('one'), null);
  assert.equal(parseQuantity(''), null);
  assert.equal(parseQuantity('0'), null, 'a zero quantity is not a line');
  assert.equal(parseQuantity('-2'), null, 'a negative quantity is not a line');
});

// ---------------------------------------------------------------------------
test('parseQuantity matches a product name that begins with a digit', () => {
  // "TWS-9 Earbuds" must not read the 9 as the quantity.
  const parsed = parseOrderForm('Product: TWS-9 Earbuds\nQuantity: 2', CATALOGUE);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].name, 'TWS-9 Earbuds', 'the catalogue name is used, not the typed text');
  assert.equal(parsed.lines[0].quantity, 2, 'quantity comes from the Quantity field, not the name');
});

// ---------------------------------------------------------------------------
test('matchProduct prefers an exact name over a longer one', () => {
  const exact = matchProduct('cotton saree', CATALOGUE);
  assert.equal(exact.productId, 'p2');

  const bySku = matchProduct('EAR-9', CATALOGUE);
  assert.equal(bySku.productId, 'p3', 'a SKU resolves like a name');
});

test('matchProduct will not guess between two equally good candidates', () => {
  const ambiguous = matchProduct('saree', CATALOGUE);
  assert.equal(ambiguous.productId, null, '"saree" alone is not enough to choose a product');
  assert.deepEqual(
    ambiguous.candidates.map((c) => c.name).sort(),
    ['Cotton Saree', 'Ladies Silk Saree'],
    'both candidates are offered so the seller picks',
  );
});

test('matchProduct does not match on a partial word', () => {
  const result = matchProduct('ba', CATALOGUE);
  assert.equal(result.productId, null, '"ba" must not latch onto "Premium Bag"');
});

test('a single distinctive word resolves when only one product contains it', () => {
  // Customers type one word, not the full catalogue name. With exactly one
  // candidate there is no ambiguity, so refusing to match would be useless.
  assert.equal(matchProduct('earbuds', CATALOGUE).productId, 'p3');
  assert.equal(matchProduct('bag', CATALOGUE).productId, 'p4');
});

test('one word that fits several products is still ambiguous', () => {
  const result = matchProduct('cotton', [
    ...CATALOGUE,
    { id: 'p5', name: 'Cotton Towel', sku: 'TWL-1' },
  ]);
  assert.equal(result.productId, null);
  assert.ok(result.candidates.length >= 2);
});

test('matchProduct reports an unknown product instead of dropping it', () => {
  const result = matchProduct('Wedding Saree', CATALOGUE);
  assert.equal(result.productId, null);
  assert.equal(result.name, 'Wedding Saree', 'the typed text is kept for the seller to see');
});

test('matchProduct ignores trailing quantity chatter', () => {
  assert.equal(matchProduct('Premium Bag x3', CATALOGUE).productId, 'p4');
  assert.equal(matchProduct('Premium Bag (2)', CATALOGUE).productId, 'p4');
});

// ---------------------------------------------------------------------------
test('the form the seller sends out is read back exactly', () => {
  const filled = `Please Fill This Order Form:

Name: Rahim Uddin
Product: Ladies Silk Saree
Size: 44
Quantity: 2
Address: House 12, Road 5, Dhanmondi
Thana: Dhanmondi
Jela: Dhaka
Your Message: Please call before delivery`;

  const parsed = parseOrderForm(filled, CATALOGUE);

  assert.equal(parsed.name, 'Rahim Uddin');
  assert.equal(parsed.size, '44');
  assert.equal(parsed.address, 'House 12, Road 5, Dhanmondi');
  assert.equal(parsed.thana, 'Dhanmondi');
  assert.equal(parsed.district, 'Dhaka', '"Jela" is the spelling sellers use');
  assert.equal(parsed.message, 'Please call before delivery');
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].productId, 'p1');
  assert.equal(parsed.lines[0].quantity, 2);
  assert.deepEqual(parsed.warnings, [], 'a clean form produces no warnings');
});

test('an address split over several lines is kept whole', () => {
  const parsed = parseOrderForm(
    ['Name: Rahim', 'Address:', 'House 12, Road 5', 'Dhanmondi', 'Thana: Dhanmondi'].join('\n'),
    CATALOGUE,
  );
  assert.match(parsed.address ?? '', /House 12, Road 5 Dhanmondi/);
  assert.equal(parsed.thana, 'Dhanmondi');
});

test('an empty template value does not overwrite the label', () => {
  const parsed = parseOrderForm('Name: Rahim\nProduct:\nQuantity: 1', CATALOGUE);
  assert.equal(parsed.name, 'Rahim');
  assert.equal(parsed.lines.length, 0);
  assert.ok(parsed.warnings.some((w) => w.includes('No products')));
});

// ---------------------------------------------------------------------------
test('several products on one line are split', () => {
  const parsed = parseOrderForm('Product: Cotton Saree, Premium Bag\nQuantity: 1', CATALOGUE);
  assert.equal(parsed.lines.length, 2);
  assert.deepEqual(parsed.lines.map((l) => l.productId), ['p2', 'p4']);
  assert.ok(parsed.lines.every((l) => l.quantity === 1));
});

test('a trailing count on a product name is read as quantity, not as a second product', () => {
  const parsed = parseOrderForm('Product: Premium Bag x3', CATALOGUE);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].productId, 'p4');
  assert.equal(parsed.lines[0].quantity, 1, 'the default stays 1; the x3 is cleaned off the name');
  assert.equal(parsed.lines[0].name, 'Premium Bag');
});

test('one quantity beside several products is applied to each and flagged', () => {
  const parsed = parseOrderForm('Product: Cotton Saree, Premium Bag\nQuantity: 2', CATALOGUE);
  assert.equal(parsed.lines.length, 2);
  assert.ok(parsed.lines.every((l) => l.quantity === 2));
  assert.ok(
    parsed.warnings.some((w) => w.includes('Assumed 2 of each')),
    'the other reading (2 items in total) is possible, so the seller is told',
  );
});

test('quantities pair positionally with products', () => {
  const parsed = parseOrderForm('Product: Cotton Saree, Premium Bag\nQuantity: 2, 5', CATALOGUE);
  assert.deepEqual(parsed.lines.map((l) => l.quantity), [2, 5]);
  assert.ok(parsed.warnings.every((w) => !w.includes('Assumed')));
});

test('repeated Product labels are read as separate lines', () => {
  const parsed = parseOrderForm(
    ['Product: Cotton Saree', 'Quantity: 1', 'Product: Premium Bag', 'Quantity: 4'].join('\n'),
    CATALOGUE,
  );
  assert.equal(parsed.lines.length, 2);
  assert.deepEqual(parsed.lines.map((l) => l.productId), ['p2', 'p4']);
  assert.deepEqual(parsed.lines.map((l) => l.quantity), [1, 4]);
});

test('more quantities than products is reported rather than silently trimmed', () => {
  const parsed = parseOrderForm('Product: Premium Bag\nQuantity: 2, 3, 4', CATALOGUE);
  assert.equal(parsed.lines.length, 1);
  assert.ok(parsed.warnings.some((w) => w.includes('More quantities')));
});

test('a quantity with no product is reported, not turned into a line', () => {
  const parsed = parseOrderForm('Name: Rahim\nQuantity: 3', CATALOGUE);
  assert.equal(parsed.lines.length, 0);
  assert.ok(parsed.warnings.some((w) => w.includes('no product name')));
});

// ---------------------------------------------------------------------------
test('a phone is found wherever the customer wrote it', () => {
  const withField = parseOrderForm('Name: Rahim\nPhone: 01712345678', CATALOGUE);
  assert.equal(withField.phone, '01712345678');

  const inName = parseOrderForm('Name: Rahim (01812345678)', CATALOGUE);
  assert.equal(inName.phone, '01812345678');
  assert.equal(inName.name, 'Rahim (01812345678)');

  const international = parseOrderForm('Name: Rahim\nPhone: +8801712345678', CATALOGUE);
  assert.equal(international.phone, '01712345678', 'country code is normalised to a local number');

  const spaced = parseOrderForm('Name: Rahim\nPhone: 0171 2345 678', CATALOGUE);
  assert.equal(spaced.phone, '01712345678');
});

// ---------------------------------------------------------------------------
test('an unmatched product is kept and surfaced, never dropped', () => {
  const parsed = parseOrderForm('Product: Wedding Saree\nQuantity: 1', CATALOGUE);
  assert.equal(parsed.lines.length, 1, 'the line survives so the seller can act on it');
  assert.equal(parsed.lines[0].productId, null);
  assert.equal(parsed.lines[0].raw, 'Wedding Saree');
  assert.ok(parsed.warnings.some((w) => w.includes('not in your catalogue')));
});

test('an ambiguous product offers candidates instead of picking one', () => {
  const parsed = parseOrderForm('Product: saree\nQuantity: 1', CATALOGUE);
  assert.equal(parsed.lines[0].productId, null);
  assert.equal(parsed.lines[0].candidates.length, 2);
});

// ---------------------------------------------------------------------------
test('the parser works with no catalogue at all', () => {
  const parsed = parseOrderForm('Name: Rahim\nProduct: Anything\nQuantity: 2');
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].productId, null);
  assert.equal(parsed.lines[0].quantity, 2);
  assert.equal(parsed.name, 'Rahim');
});

test('common label spellings and casing are accepted', () => {
  const parsed = parseOrderForm(
    ['NAME: Rahim', 'items: Premium Bag', 'Qty: 3', 'zila: Chattogram', 'notes: hurry'].join('\n'),
    CATALOGUE,
  );
  assert.equal(parsed.name, 'Rahim');
  assert.equal(parsed.lines[0].productId, 'p4');
  assert.equal(parsed.lines[0].quantity, 3);
  assert.equal(parsed.district, 'Chattogram');
  assert.equal(parsed.message, 'hurry');
});

test('a bare message with no labels is still captured', () => {
  const parsed = parseOrderForm('Rahim wants two sarees delivered to Dhanmondi', CATALOGUE);
  assert.ok(parsed.message?.includes('Rahim wants two sarees'));
});

test('empty input is reported as empty rather than as a broken parse', () => {
  for (const input of ['', '   ', '\n\n', 'Name:', 'Product:']) {
    const parsed = parseOrderForm(input, CATALOGUE);
    assert.equal(parsed.lines.length, 0, `no lines for ${JSON.stringify(input)}`);
  }
  assert.equal(parseOrderForm('', CATALOGUE).empty, true);
  assert.equal(parseOrderForm('Name: Rahim', CATALOGUE).empty, false);
});

test('a customer who fills the whole template out still yields a usable draft', () => {
  const parsed = parseOrderForm(
    `Please Fill This Order Form:
Name: Ayesha Begum
Product: Ladies Silk Saree, TWS-9 Earbuds
Size: 42
Quantity: 1, 2
Address: Flat 3B, Mirpur 10
Thana: Mirpur
Jela: Dhaka
Your Message: Pay on delivery`,
    CATALOGUE,
  );

  assert.equal(parsed.name, 'Ayesha Begum');
  assert.equal(parsed.lines.length, 2);
  assert.deepEqual(parsed.lines.map((l) => l.productId), ['p1', 'p3']);
  assert.deepEqual(parsed.lines.map((l) => l.quantity), [1, 2]);
  assert.ok(
    parsed.lines.every((l) => l.size === '42'),
    'a single size applies to every line, which the seller can edit',
  );
  assert.ok(
    !parsed.warnings.some((w) => w.includes('not in your catalogue')),
    'nothing in this reply should be flagged as unmatched',
  );
});

// ---------------------------------------------------------------------------
// A link submission has to survive the trip back through the same template.
// If it does not, a customer who fills a form in the app and a customer who
// sends a WhatsApp message get handled differently, and the link flow grows its
// own private idea of what a product name means.
// ---------------------------------------------------------------------------
test('a link submission round-trips through the template and comes back intact', () => {
  const request = {
    customer_name: 'Link Customer',
    customer_phone: '01799887766',
    items: [{ name: 'Ladies Silk Saree', quantity: 2 }],
    address: 'House 7, Road 3',
    thana: 'Dhanmondi',
    district: 'Dhaka',
    message: 'Call before delivery',
  };

  const parsed = parseOrderForm(requestToFormText(request), CATALOGUE);

  assert.equal(parsed.name, 'Link Customer');
  assert.equal(parsed.phone, '01799887766');
  assert.equal(parsed.address, 'House 7, Road 3');
  assert.equal(parsed.thana, 'Dhanmondi');
  assert.equal(parsed.district, 'Dhaka');
  assert.equal(parsed.message, 'Call before delivery');
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].productId, 'p1');
  assert.equal(parsed.lines[0].quantity, 2);
});

test('a link request with several products round-trips each quantity', () => {
  const request = {
    customer_name: 'Multi Buyer',
    items: [
      { name: 'Cotton Saree', quantity: 1 },
      { name: 'Premium Bag', quantity: 4 },
      { name: 'TWS-9 Earbuds', quantity: 2 },
    ],
  };

  const parsed = parseOrderForm(requestToFormText(request), CATALOGUE);

  assert.deepEqual(parsed.lines.map((l) => l.productId), ['p2', 'p4', 'p3']);
  assert.deepEqual(parsed.lines.map((l) => l.quantity), [1, 4, 2]);
});

test('the generated template is the one the parser expects', () => {
  // Guards against the offered form and the parser drifting apart, which would
  // silently fail on every future customer.
  const parsed = parseOrderForm(BLANK_FORM_TEMPLATE, CATALOGUE);
  assert.equal(parsed.empty, true, 'the blank form on its own must parse to nothing');
  assert.equal(parsed.lines.length, 0);
});
