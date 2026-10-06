/**
 * COD must never be counted twice: once as received, once as still owed.
 *
 * Found on a real device by recording a payment against an unsettled cash-on-delivery
 * order and then reading the database. `record_payment` moved `amount_paid` but left
 * `cod_amount` untouched, so the dashboard reported the same 1,010 taka as MONEY
 * RECEIVED TODAY and, on the same screen, as CASH ON DELIVERY -- OWED TO YOU.
 *
 * The rule the fix encodes, stated so a regression is a red test rather than a question
 * in review:
 *
 *     received money  +  courier receivable  <=  order total
 *
 * for every order, at every point in its life.
 *
 * The arithmetic here mirrors the migration rather than reimplementing it, and a
 * separate group asserts the SQL itself says the same thing -- because a test that only
 * checks its own copy of the logic would pass just as happily if the migration were
 * wrong.
 */

import './__stubs__/env.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0026_cod_payment_reconciliation.sql'),
  'utf8',
);

/** What the migration does to an order when a payment is recorded. */
function applyPayment({ total, amountPaid, codAmount, isCod }, amount) {
  const paid = amountPaid + amount;
  return {
    total,
    amountPaid: paid,
    codAmount: isCod ? Math.max(0, codAmount - amount) : codAmount,
    isCod,
    settled: isCod ? codAmount - amount <= 0 : false,
    status: paid >= total ? 'paid' : 'partial',
  };
}

/** And when one is refunded. */
function applyRefund({ total, amountPaid, codAmount, isCod }, amount) {
  const paid = amountPaid - amount;
  return {
    total,
    amountPaid: paid,
    codAmount: isCod ? Math.min(total, codAmount + amount) : codAmount,
    isCod,
    settled: false,
    status: paid <= 0 ? 'unpaid' : paid < total ? 'partial' : 'paid',
  };
}

function assertNoDoubleCount(order, label) {
  assert.ok(
    order.amountPaid + order.codAmount <= order.total,
    `${label}: received ${order.amountPaid} plus still owed ${order.codAmount} ` +
      `must not exceed the order total ${order.total}`,
  );
}

describe('COD is never counted as both received and still owed', () => {
  const codOrder = { total: 1010, amountPaid: 0, codAmount: 1010, isCod: true };
  const prepaidOrder = { total: 1010, amountPaid: 0, codAmount: 0, isCod: false };

  test('a COD order starts consistent', () => {
    assertNoDoubleCount(codOrder, 'new COD order');
    assertNoDoubleCount(prepaidOrder, 'new prepaid order');
  });

  test('paying a COD order in full removes the receivable', () => {
    // The exact case found on device.
    const after = applyPayment(codOrder, 1010);
    assert.equal(after.amountPaid, 1010);
    assert.equal(after.codAmount, 0, 'nothing is left for the courier to collect');
    assert.equal(after.settled, true);
    assert.equal(after.status, 'paid');
    assertNoDoubleCount(after, 'COD paid in full');
  });

  test('a part payment on COD leaves only the remainder collectable', () => {
    const after = applyPayment(codOrder, 400);
    assert.equal(after.amountPaid, 400);
    assert.equal(after.codAmount, 610);
    assert.equal(after.settled, false, 'not settled while the rider still holds part');
    assertNoDoubleCount(after, 'COD part paid');
  });

  test('two instalments settle exactly once and never over-collect', () => {
    const mid = applyPayment(codOrder, 600);
    const end = applyPayment(mid, 410);
    assert.equal(end.codAmount, 0);
    assert.equal(end.settled, true);
    assertNoDoubleCount(end, 'COD paid in two instalments');
  });

  test('a payment cannot drive the collectable negative', () => {
    const over = applyPayment({ ...codOrder, codAmount: 100 }, 1010);
    assert.equal(over.codAmount, 0);
    assertNoDoubleCount(over, 'payment larger than the COD leg');
  });

  test('a refund puts the money back on the courier account', () => {
    const paid = applyPayment(codOrder, 1010);
    const refunded = applyRefund(paid, 300);
    assert.equal(refunded.amountPaid, 710);
    assert.equal(refunded.codAmount, 300, 'the courier is owed the refunded part again');
    assert.equal(refunded.settled, false);
    assertNoDoubleCount(refunded, 'COD refunded in part');
  });

  test('a refunded COD order is not left settled', () => {
    const paid = applyPayment(codOrder, 1010);
    assert.equal(paid.settled, true);
    const refunded = applyRefund(paid, 1);
    assert.equal(refunded.settled, false, 'a single taka back reopens the receivable');
  });

  test('a refund cannot push the collectable above the order value', () => {
    const paid = applyPayment(codOrder, 1010);
    const refunded = applyRefund(paid, 1010);
    assert.equal(refunded.codAmount, 1010, 'capped at the order total');
    assertNoDoubleCount(refunded, 'COD fully refunded');
  });

  test('a prepaid order is untouched by all of this', () => {
    const after = applyPayment(prepaidOrder, 500);
    assert.equal(after.codAmount, 0, 'a non-COD order never gains a receivable');
    assertNoDoubleCount(after, 'prepaid part paid');
  });
});

describe('migration 0026 actually encodes that invariant', () => {
  test('record_payment reduces cod_amount by the payment', () => {
    assert.match(
      migration,
      /greatest\(0,\s*coalesce\(v_cod_amount,\s*0\)\s*-\s*p_amount\)/,
      'a payment must reduce what the courier still owes, floored at zero',
    );
  });

  test('record_payment moves amount_paid and cod_amount in ONE statement', () => {
    // Two statements would leave a window where a dashboard read sees half the truth.
    const start = migration.indexOf('update public.orders');
    const update = migration.slice(start, migration.indexOf('where id = p_order_id', start));
    assert.ok(update.includes('amount_paid'), 'amount_paid must be written');
    assert.ok(update.includes('cod_amount'), 'cod_amount must be written');
    assert.ok(update.includes('cod_settled'), 'cod_settled must be written');
  });

  test('record_refund restores the receivable', () => {
    assert.match(
      migration,
      /least\(v_total,\s*coalesce\(v_cod_amount,\s*0\)\s*\+\s*p_amount\)/,
      'a refund must put the money back on the courier, capped at the order value',
    );
  });

  test('the signature, rejections and idempotency rules are unchanged', () => {
    // A fix that quietly loosened a guard would be worse than the defect.
    for (const guard of [
      'order_not_found',
      'idempotency_key_reused',
      'order_closed',
      'invalid_payment',
      'overpayment',
    ]) {
      assert.ok(migration.includes(guard), `${guard} must still be refused`);
    }
    assert.match(
      migration,
      /p_idempotency_key\s+uuid\s+default\s+null/,
      'the idempotency key argument keeps its position and default',
    );
  });

  test('nothing in 0026 touches a table definition', () => {
    for (const destructive of [
      /alter\s+table/i,
      /drop\s+table/i,
      /truncate/i,
      /delete\s+from/i,
      /drop\s+column/i,
      /drop\s+policy/i,
    ]) {
      assert.ok(
        !destructive.test(migration),
        `0026 must not contain ${destructive} -- it replaces two functions and nothing else`,
      );
    }
  });
});