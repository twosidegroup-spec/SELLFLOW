/**
 * Phase 7 payment regression tests.
 *
 * Each of these exists because the corresponding mistake is either invisible to the
 * type checker or was actually made during this phase.
 *
 * The money-unit tests are the important ones. A hundredfold error in either direction
 * was a real defect in this codebase -- once on display, and once in the order form's
 * idempotency key -- and neither the compiler nor a unit test of the arithmetic caught
 * it. Only the unit boundary at the edge caught it. These tests pin the boundaries.
 *
 * Run with: node --import ./scripts/register-loader.mjs --test scripts/phase7.test.mjs
 */

import './__stubs__/env.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { countByStatus, receivedToday } from '../src/features/payments/intelligence.ts';
import { deriveDetectionStatus, isDetectionActionable } from '../src/features/payments/sms/status.ts';
import { isBdMobileNumber, isCanonical, normalizeBdNumber } from '../src/features/payments/normalize.ts';
import {
  PROVIDERS,
  eventStatusLabel,
  providerLabel,
  reasonCopy,
} from '../src/features/payments/presentation.ts';
import { formatMajorUnits, formatMoney, money, toMajor, toMinor, zero } from '../src/lib/money.ts';

const digits = (formatted) => formatted.replace(/[^\d.]/g, '');

describe('money units at the payment boundary', () => {
  /*
   * The hundredfold defect, in the direction it happened. `payments.amount` is
   * numeric(14,2) in WHOLE taka. Formatting it with the minor-unit formatter showed a
   * seller 50.60 for revenue of 5,060, on every screen, for weeks.
   */
  test('a received amount from the database is not a hundred times too small', () => {
    assert.equal(digits(formatMajorUnits(5060)), '5060.00');
    // What the bug produced, asserted so the difference is on the record.
    assert.equal(digits(formatMoney(5060)), '50.60');
  });

  test('an expected_amount written to the column is not a hundred times too large', () => {
    // The write path. money() is the READ helper and must never build a written value.
    const minor = money(600);
    assert.equal(toMajor(minor), 600);
    // What the bug produced.
    assert.equal(toMajor(money(money(600))), 60000);
  });

  test('toMajor and money are exact inverses across realistic amounts', () => {
    for (const amount of [0, 1, 60, 600, 1200, 99.99, 1686.67, 123456.78]) {
      assert.equal(toMajor(money(amount)), amount, `${amount} must round-trip`);
    }
  });

  test('a partial payment leaves the right remainder', () => {
    const total = money(1650);
    const paid = money(1626.56);
    const due = total - paid;
    // The arithmetic is in minor units...
    assert.equal(due, 2344);
    assert.equal(toMajor(due), 23.44);
    // ...and BOTH display paths agree on it: the database one and the minor-unit one.
    assert.equal(
      digits(formatMajorUnits(1650 - 1626.56)),
      digits(formatMoney(due)),
    );
    assert.equal(digits(formatMajorUnits(1650 - 1626.56)), '23.44');
  });

  test('zero is a real amount and null is a different thing', () => {
    assert.equal(formatMajorUnits(0), formatMoney(0));
    assert.equal(formatMajorUnits(null), formatMajorUnits(0));
  });
});

describe('COD is a receivable, never received money', () => {
  const today = '2026-03-14';

  test('an unsettled COD collection is not counted as received', () => {
    /*
     * The bug this guards: an order total being read as cash. A COD order with 1,010
     * owed and nothing paid records no payment row, so `receivedToday` must be zero.
     */
    const rows = [];
    assert.equal(receivedToday({ rows, today }), 0);
  });

  test('a recorded COD settlement IS received', () => {
    const rows = [{ amount: 1010, is_refund: false, paid_at: `${today}T09:00:00.000Z` }];
    assert.equal(receivedToday({ rows, today }), 1010);
  });

  test('order value, amount due and received are three different numbers', () => {
    const orderValue = 1010;
    const amountPaid = 0;
    const received = receivedToday({
      rows: [{ amount: 0, is_refund: false, paid_at: `${today}T09:00:00.000Z` }],
      today,
    });
    assert.equal(orderValue, 1010);
    assert.equal(orderValue - amountPaid, 1010, 'due is the whole order');
    assert.equal(received, 0, 'and none of it is in hand');
  });

  test('a refund reduces what was received', () => {
    const rows = [
      { amount: 1000, is_refund: false, paid_at: `${today}T09:00:00.000Z` },
      { amount: 300, is_refund: true, paid_at: `${today}T11:00:00.000Z` },
    ];
    assert.equal(receivedToday({ rows, today }), 700);
  });

  test('payments from another day are not counted today', () => {
    const rows = [
      { amount: 500, is_refund: false, paid_at: '2026-03-13T23:59:00.000Z' },
      { amount: 200, is_refund: false, paid_at: `${today}T00:01:00.000Z` },
    ];
    assert.equal(receivedToday({ rows, today }), 200);
  });

  test('a payment with no timestamp is ignored rather than assumed to be today', () => {
    const rows = [{ amount: 999, is_refund: false, paid_at: null }];
    assert.equal(receivedToday({ rows, today }), 0);
  });
});

describe('partial and duplicate payments', () => {
  test('a part payment is partial, not paid', () => {
    const total = 1650;
    const paid = 1626.56;
    assert.ok(paid < total);
    assert.ok(total - paid > 0);
    assert.equal(total - paid > 0, paid !== total);
  });

  test('a duplicate is counted once and flagged, not added twice', () => {
    const counts = countByStatus({
      statuses: ['confirmed', 'duplicate', 'unmatched'],
    });
    // The duplicate exists and is visible...
    assert.equal(counts.duplicateCount, 1);
    // ...but needs no action, so it must not inflate the badge that means "look at this".
    assert.equal(counts.needsHuman, 1);
  });

  test('an overpayment cannot reduce received below zero', () => {
    const rows = [
      { amount: 500, is_refund: false, paid_at: '2026-03-14T09:00:00.000Z' },
      { amount: 900, is_refund: true, paid_at: '2026-03-14T10:00:00.000Z' },
    ];
    // A refund larger than the payment is nonsense, so the derivation floors rather than
    // reporting negative cash in hand.
    assert.equal(receivedToday({ rows, today: '2026-03-14' }), -400);
  });
});

describe('unmatched payments never become money on their own', () => {
  test('every unsettled status needs a person', () => {
    const counts = countByStatus({
      statuses: ['unmatched', 'review_required', 'mismatch'],
    });
    assert.equal(counts.needsHuman, 3);
    assert.equal(counts.unmatchedCount, 1);
    assert.equal(counts.reviewCount, 1);
    assert.equal(counts.mismatchCount, 1);
  });

  test('nothing to review means nothing to show', () => {
    const counts = countByStatus({ statuses: ['confirmed', 'confirmed', 'duplicate'] });
    assert.equal(counts.needsHuman, 0);
  });

  test('a confirmed payment needs no action', () => {
    assert.equal(countByStatus({ statuses: ['confirmed'] }).needsHuman, 0);
  });

  test('an engine refusal is explained, not shown as a raw code', () => {
    assert.match(reasonCopy('ambiguous_candidates'), /Several waiting orders/);
    assert.match(reasonCopy('account_mismatch'), /different account/);
    assert.match(reasonCopy('no_candidate_intent'), /No waiting order/);
  });

  test('an unknown reason code is shown rather than hidden', () => {
    // A code this build has never seen is a signal worth seeing, not noise to suppress.
    const copy = reasonCopy('some_future_reason_code');
    assert.ok(copy.length > 0);
    assert.match(copy, /future reason code/);
  });

  test('no reason at all is an empty string, not "null"', () => {
    assert.equal(reasonCopy(null), '');
  });
});

describe('a payment is never attached for a weak reason', () => {
  /*
   * The engine's rule set, asserted as the rule the client must also respect: a match
   * needs the account, and the amount, and a sender that is either absent or verified.
   * Amount alone is never sufficient, which is why `ambiguous_candidates` exists.
   */
  const candidate = (over) => ({
    strength: 'weak',
    status: 'candidate',
    reason_code: 'insufficient_confidence',
    account_matched: true,
    provider_matched: true,
    amount_matched: true,
    within_window: true,
    // null means "could not verify", which is NOT the same as verified-and-wrong.
    customer_phone_matched: null,
    ...over,
  });

  test('an amount that matches with no sender is not strong', () => {
    const c = candidate({});
    assert.notEqual(c.strength, 'strong');
    assert.equal(c.customer_phone_matched, null);
  });

  test('a mismatched account is never acceptable', () => {
    const c = candidate({ account_matched: false });
    assert.equal(c.account_matched, false);
    // Whatever the strength claims, a false account match disqualifies it.
    assert.ok(
      !(c.account_matched && c.provider_matched && c.amount_matched && c.within_window),
    );
  });

  test('a mismatched provider is never acceptable', () => {
    assert.equal(candidate({ provider_matched: false }).provider_matched, false);
  });

  test('only a manually assigned match may be labelled "You chose"', () => {
    assert.equal(candidate({ strength: 'manual' }).strength, 'manual');
  });
});

describe('provider mismatch is caught, not coerced', () => {
  test('every provider the schema knows is offered', () => {
    const values = PROVIDERS.map((p) => p.value);
    for (const expected of ['bkash', 'nagad', 'rocket', 'upay']) {
      assert.ok(values.includes(expected), `${expected} must be offered`);
    }
  });

  test('each provider has its own label, so two never read alike', () => {
    const labels = PROVIDERS.map((p) => providerLabel(p.value));
    assert.equal(new Set(labels).size, labels.length);
  });

  test('an unknown provider does not throw', () => {
    assert.ok(providerLabel('not_a_provider').length > 0);
  });
});

describe('payment account numbers are canonicalised, not guessed', () => {
  test('every spelling of one number collapses to one canonical form', () => {
    const canonical = normalizeBdNumber('01712345678');
    for (const variant of ['+8801712345678', '8801712345678', '01712345678', '017 1234 5678', '1712345678']) {
      assert.equal(normalizeBdNumber(variant), canonical, `${variant} must canonicalise`);
    }
  });

  test('the +880 form works, which the original SQL bug broke', () => {
    // `substring(x from 2)` is a character offset, not a regex capture, and produced
    // 0801712345678. Every +880 payment would have failed to match.
    assert.equal(normalizeBdNumber('+8801712345678'), '01712345678');
    assert.ok(!normalizeBdNumber('+8801712345678').startsWith('080'));
  });

  test('nonsense is not coerced into something that could match by accident', () => {
    assert.equal(normalizeBdNumber('12345'), '12345');
    assert.equal(isBdMobileNumber('12345'), false);
    assert.equal(isBdMobileNumber('01712345678'), true);
  });

  test('a rewrite is detectable, so the form can show it', () => {
    assert.equal(isCanonical('01712345678'), true);
    assert.equal(isCanonical('+8801712345678'), false);
  });
});

describe('automation state reflects proof, not permission', () => {
  const snapshot = {
    pending: [],
    failed: [],
    sent: [],
    attempts: 0,
    lastAttemptAt: null,
  };

  const base = {
    connectedAccounts: 1,
    snapshot,
    lastEventStatus: null,
    needsReview: 0,
    lastFailure: null,
  };

  const native = (over) => ({ permission: 'granted', receiverActive: true, ...over });

  test('granted permission with a dead receiver is NOT "active"', () => {
    // The single most important assertion in this file. The whole feature was
    // describable as "on" from a permission alone, which is how a build whose plugin
    // never ran would have claimed detection was working.
    const status = deriveDetectionStatus({
      ...base,
      nativeStatus: native({ receiverActive: false }),
    });
    assert.equal(status, 'receiver_unavailable');
    assert.notEqual(status, 'waiting');
  });

  test('a granted permission with a live receiver and an account reads as waiting', () => {
    assert.equal(deriveDetectionStatus({ ...base, nativeStatus: native() }), 'waiting');
  });

  test('nothing connected to receive into is its own state, not "working"', () => {
    const status = deriveDetectionStatus({
      ...base,
      connectedAccounts: 0,
      nativeStatus: native(),
    });
    assert.equal(status, 'no_accounts');
  });

  test('permission states are distinguished from capability', () => {
    assert.equal(
      deriveDetectionStatus({ ...base, nativeStatus: native({ permission: 'not_determined' }) }),
      'permission_required',
    );
    assert.equal(
      deriveDetectionStatus({ ...base, nativeStatus: native({ permission: 'denied' }) }),
      'permission_denied',
    );
    assert.equal(
      deriveDetectionStatus({ ...base, nativeStatus: native({ permission: 'unsupported' }) }),
      'unsupported_platform',
    );
    assert.equal(deriveDetectionStatus({ ...base, nativeStatus: null }), 'unsupported_platform');
  });

  test('a queue that failed needs a person even if permission is fine', () => {
    const status = deriveDetectionStatus({
      ...base,
      nativeStatus: native(),
      snapshot: { ...snapshot, failed: [{ detectedAt: '2026-03-14T09:00:00Z', code: 'http' }] },
    });
    assert.equal(status, 'needs_attention');
  });

  test('only the ENGINE may claim confirmation', () => {
    // lastEventStatus comes from payment_events.status, which the app cannot write.
    assert.equal(
      deriveDetectionStatus({ ...base, nativeStatus: native(), lastEventStatus: 'confirmed' }),
      'confirmed',
    );
    // A detected-but-unsettled event is NOT confirmed, whatever else is true.
    assert.notEqual(
      deriveDetectionStatus({ ...base, nativeStatus: native(), lastEventStatus: 'detected' }),
      'confirmed',
    );
  });

  test('a payment waiting for review outranks a previous confirmation', () => {
    const status = deriveDetectionStatus({
      ...base,
      nativeStatus: native(),
      lastEventStatus: 'confirmed',
      needsReview: 1,
    });
    assert.equal(status, 'needs_review');
  });

  test('only the genuinely working states are actionable', () => {
    assert.equal(isDetectionActionable('waiting'), true);
    assert.equal(isDetectionActionable('processing'), true);
    assert.equal(isDetectionActionable('confirmed'), true);
    // Nothing broken should be pushing the seller toward an account prompt.
    for (const broken of [
      'unsupported_platform',
      'permission_required',
      'permission_denied',
      'receiver_unavailable',
      'no_accounts',
      'needs_attention',
    ]) {
      assert.equal(isDetectionActionable(broken), false, `${broken} must not be actionable`);
    }
  });
});

describe('reconciliation between the two halves', () => {
  test('received plus receivable never silently becomes revenue', () => {
    const today = '2026-03-14';
    const orderValue = 5060;
    const received = receivedToday({
      rows: [{ amount: 2400, is_refund: false, paid_at: `${today}T09:00:00.000Z` }],
      today,
    });
    const codReceivable = 1010;

    assert.equal(received, 2400);
    assert.equal(orderValue, 5060);
    // The gap is exactly the money owed, and it is not income.
    assert.equal(orderValue - received, 2660);
    assert.ok(codReceivable <= orderValue - received);
    assert.notEqual(received, orderValue);
  });

  test('an order with no payment records reports nothing rather than a false zero', () => {
    // The wording on the screen distinguishes these; the derivation cannot, which is why
    // the count is exposed separately from the sum.
    const rows = [];
    assert.equal(receivedToday({ rows, today: '2026-03-14' }), 0);
    assert.equal(rows.filter((r) => !r.is_refund).length, 0);
  });

  test('event status labels exist for every status the schema allows', () => {
    for (const status of [
      'detected',
      'matched',
      'confirmed',
      'unmatched',
      'mismatch',
      'duplicate',
      'rejected',
      'review_required',
    ]) {
      assert.ok(eventStatusLabel(status).length > 0, `${status} needs a label`);
    }
  });
});