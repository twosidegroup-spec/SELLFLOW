/**
 * Finance revenue-block presentation.
 *
 * A UI regression test, not a calculation test. The numbers in the revenue
 * block were always right; what was wrong was that a seller could reasonably
 * read them as a sum:
 *
 *     Gross sales          Tk45,750
 *     Delivery charged      Tk1,370
 *     ---------------------
 *     ?                     Tk47,120
 *
 * They are not a sum. `gross_sales` is the sum of order totals, and an order
 * total is items - discount + delivery, so the delivery and discount lines are
 * components already INSIDE gross sales. Adding them double-counts delivery.
 *
 * get_finance is unchanged, so this file locks the PRESENTATION contract: the
 * screen must say delivery is included, and must not label it in a way that
 * invites addition.
 */

import { readFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const finance = readFileSync('src/app/(app)/finance.tsx', 'utf8');

/** The revenue card: from its heading to the costs card. */
function revenueBlock() {
  const start = finance.indexOf('{/* Revenue');
  const end = finance.indexOf('{/* Costs');
  assert.ok(start >= 0 && end > start, 'the revenue and costs cards must still exist');
  return finance.slice(start, end);
}

describe('Finance — delivery must not read as an addition', () => {
  test('the block says delivery is already inside gross sales', () => {
    const block = revenueBlock();

    // A single, explicit statement of the relationship. Not "part of" and not
    // "do not add again" on their own: it has to say which number contains it.
    assert.match(
      block,
      /Already inside gross sales — not added to it/i,
      'the revenue block must state that delivery and discounts are already counted',
    );
  });

  test('the delivery line is not labelled as a separate revenue stream', () => {
    const block = revenueBlock();

    // It must not be a peer of gross sales: gross sales is the only emphasised
    // figure, and the components sit under their own heading below it.
    const deliveryIndex = block.indexOf('Delivery charged');
    assert.ok(deliveryIndex > 0, 'the delivery line must still be shown');
    assert.ok(
      deliveryIndex > block.indexOf('Already inside gross sales'),
      'the delivery line must come after the "already inside" heading, not beside gross sales',
    );

    // A label that reads like an instruction to add is a defect, not a style.
    assert.doesNotMatch(block, /do not add again/i);
    assert.doesNotMatch(block, /part of gross sales/i);
  });

  test('the discount line says the same thing about itself', () => {
    const block = revenueBlock();
    assert.match(block, /Discounts given/);
    // Discounts are already deducted, so they are shown negative and grouped
    // with delivery rather than presented as a positive revenue line.
    assert.match(block, /value=\{-\s*money\(data\.revenue\.discount_given/);
  });

  test('gross sales is the emphasised figure, so there is one total', () => {
    const block = revenueBlock();
    assert.match(block, /label="Gross sales"[\s\S]*?emphasis/);
  });

  test('the calculation itself is untouched', () => {
    // Guards against a future "fix" that edits the formula to match the
    // presentation. If this fails, the numbers changed, not just the wording.
    const sql = readFileSync('supabase/migrations/0017_dashboard_count_types.sql', 'utf8');
    assert.doesNotMatch(sql, /gross_sales/, 'gross_sales is computed in get_finance, not here');

    const queries = readFileSync('src/features/dashboard/queries.ts', 'utf8');
    assert.match(queries, /gross_sales: num\(revenue\.gross_sales\)/);
    assert.match(queries, /delivery_charged: num\(revenue\.delivery_charged\)/);
  });
});

describe('Finance — no dead cards', () => {
  test('every card on the screen has content, not just a heading and a hint', () => {
    // "Expenses by category" shipped as a heading and one sentence pointing
    // elsewhere: a card that occupies space and tells the seller nothing.
    assert.doesNotMatch(finance, /Expenses by category/);
  });

  test('the COD sentence reports pending and settled separately', () => {
    // It previously summed them and called the total "tied up in parcels",
    // which described settled money as if the courier still had it.
    assert.match(finance, /still\s+with the courier/);
    assert.match(finance, /has reached you/);
    assert.doesNotMatch(finance, /tied up in parcels/);
  });
});