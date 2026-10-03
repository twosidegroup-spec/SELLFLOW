/**
 * Payment boundary: the client cannot write the ledger, and the future SMS
 * adapter has a defined contract.
 *
 * These are static assertions over the source rather than runtime tests, and
 * that is the point. The rules being defended are architectural:
 *
 *   * The five payment tables are readable and NOT writable from the app. The
 *     database enforces this with revoked grants (migration 0024); this enforces
 *     it at authoring time by failing the build when the types say `never` and
 *     when someone reaches past them.
 *   * Every payment mutation goes through the engine's RPCs. A new one cannot be
 *     added without being listed here, so the trust boundary stays reviewable.
 *   * record_payment is not called from the payment feature. Settlement belongs
 *     to the engine; a client-side shortcut would bypass the audit trail.
 *   * No SMS permission exists anywhere, because the native adapter is not
 *     started yet. This test will fail loudly if one appears.
 *
 * It also pins the data the review queue needs, so "why didn't SellFlow match
 * this?" cannot silently lose its answer.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const SRC = join(REPO, 'src');

const PAYMENT_TABLES = [
  'payment_accounts',
  'payment_intents',
  'payment_events',
  'payment_matches',
  'payment_audit_logs',
];

/**
 * Money functions that predate the engine and are still legitimately called by
 * the app -- record_payment is how a seller records a cash payment by hand.
 *
 * They are NOT engine functions. The engine calls record_payment itself; the
 * payment feature must not (asserted separately below). The orders feature is the
 * one caller allowed to invoke it directly.
 */
const LEGACY_MONEY_RPCS = new Set(['record_payment', 'record_refund']);
const ENGINE_RPCS = new Set([
  'create_payment_account',
  'set_payment_account_status',
  'create_payment_intent',
  'cancel_payment_intent',
  'ingest_payment_event',
  'match_payment_event',
  'assign_payment_match',
  'reject_payment_match',
  'expire_stale_payment_intents',
  'payment_normalize_bk_number',
  'payment_provider_method',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const rel = (f) => relative(REPO, f).replace(/\\/g, '/');
const read = (f) => readFileSync(f, 'utf8');

/**
 * Removes comments before scanning.
 *
 * This matters more than it looks. features/payments/mutations.ts documents its
 * own guarantee in prose -- "there is no `.insert()`, no `.update()`" -- so a
 * scanner that reads comments reports that file as violating the very rule it
 * states. The comment is worth keeping; the scanner has to be the smarter one.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}

/** Source with comments removed, for pattern scanning. */
function code(f) {
  return stripComments(read(f));
}

describe('payment boundary', () => {
  test('all five payment tables exist in the generated types', () => {
    const types = read(join(SRC, 'lib', 'database.types.ts'));
    for (const table of PAYMENT_TABLES) {
      assert.ok(
        types.includes(`${table}: {`),
        `${table} must be declared in database.types.ts`,
      );
    }
  });

  test('payment tables are Insert: never and Update: never', () => {
    const types = read(join(SRC, 'lib', 'database.types.ts'));

    for (const table of PAYMENT_TABLES) {
      const start = types.indexOf(`${table}: {`);
      assert.ok(start > -1, `${table} missing`);
      // The block is short and fixed-shape; a window is enough and avoids
      // depending on the exact formatting of the file.
      const block = types.slice(start, start + 400);

      assert.match(block, /Insert: never;/, `${table} must be Insert: never`);
      assert.match(block, /Update: never;/, `${table} must be Update: never`);
    }
  });

  test('no source file writes a payment table directly', () => {
    const writeCalls = /\.(insert|upsert|update|delete)\s*\(/;
    const offenders = [];

    for (const file of files) {
      const src = code(file);

      for (const match of src.matchAll(/\.from\(\s*['"]([a-z_]+)['"]\s*\)/g)) {
        const table = match[1];
        if (!PAYMENT_TABLES.includes(table)) continue;

        // Look only at the statement the .from() belongs to, so an unrelated
        // later .update() in the same file is not misattributed.
        const statement = src.slice(match.index, match.index + 400).split(';')[0];
        if (writeCalls.test(statement)) {
          offenders.push(`${rel(file)} -> .from('${table}') then a write call`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `the app must never write payment tables directly:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('the payment feature contains no table writes at all', () => {
    const dir = join(SRC, 'features', 'payments');
    assert.ok(existsSync(dir), 'features/payments must exist');

    const offenders = [];
    for (const file of walk(dir)) {
      const src = code(file);
      if (/\.(insert|upsert|delete)\s*\(/.test(src)) {
        offenders.push(`${rel(file)} contains an insert/upsert/delete call`);
      }
      if (/\.update\s*\(/.test(src)) {
        offenders.push(`${rel(file)} contains an update call`);
      }
    }

    assert.deepEqual(offenders, [], offenders.join('\n  '));
  });

  test('every payment RPC the app calls is a known engine function', () => {
    const called = new Map();

    for (const file of files) {
      const src = code(file);
      for (const match of src.matchAll(/\.rpc\(\s*['"]([a-z_]+)['"]/g)) {
        const name = match[1];
        if (!called.has(name)) called.set(name, new Set());
        called.get(name).add(rel(file));
      }
    }

    const paymentish = [...called.keys()].filter(
      (n) => n.startsWith('payment_') || n.includes('payment') || n.startsWith('match_') || n.startsWith('assign_') || n.startsWith('ingest_'),
    );

    const unknown = paymentish.filter(
      (n) => !ENGINE_RPCS.has(n) && !LEGACY_MONEY_RPCS.has(n),
    );

    assert.deepEqual(
      unknown,
      [],
      `these payment RPCs are not in the reviewed allow-lists:\n  ${unknown.join('\n  ')}`,
    );

    // A legacy money RPC may only be called from the orders feature, which is
    // the manual-payment path. Anywhere else it is a bypass.
    for (const [name, callers] of called) {
      if (!LEGACY_MONEY_RPCS.has(name)) continue;
      for (const caller of callers) {
        assert.ok(
          caller.startsWith('src/features/orders/'),
          `${name} is only for the manual-payment path; ${caller} must go through the payment engine instead`,
        );
      }
    }

    // The engine surface the app actually depends on should not shrink silently.
    for (const required of [
      'create_payment_account',
      'create_payment_intent',
      'ingest_payment_event',
      'match_payment_event',
      'assign_payment_match',
      'reject_payment_match',
    ]) {
      assert.ok(called.has(required), `the app should call ${required}`);
    }
  });

  test('the payment feature never calls record_payment directly', () => {
    for (const file of walk(join(SRC, 'features', 'payments'))) {
      const src = code(file);
      assert.ok(
        !/rpc\(\s*['"]record_payment['"]/.test(src),
        `${rel(file)} calls record_payment. Settlement belongs to the engine: the engine calls it, so the audit trail records the event as the cause.`,
      );
    }
  });

  test('the four payment screens exist and are registered', () => {
    const screens = [
      'src/app/(app)/payments.tsx',
      'src/app/(app)/payment-review.tsx',
      'src/app/(app)/payment-account/new.tsx',
      'src/app/(app)/payment-intent/new.tsx',
    ];

    for (const screen of screens) {
      assert.ok(existsSync(join(REPO, screen)), `${screen} must exist`);
    }

    const layout = read(join(SRC, 'app', '(app)', '_layout.tsx'));
    for (const name of [
      'payments',
      'payment-review',
      'payment-account/new',
      'payment-intent/new',
    ]) {
      assert.ok(
        layout.includes(`name="${name}"`),
        `${name} must be registered in the (app) stack`,
      );
    }
  });

  test('payment screens read through the feature layer, not the tables', () => {
    const screens = [
      'src/app/(app)/payments.tsx',
      'src/app/(app)/payment-review.tsx',
      'src/app/(app)/payment-account/new.tsx',
      'src/app/(app)/payment-intent/new.tsx',
    ];

    for (const screen of screens) {
      const src = code(join(REPO, screen));

      assert.ok(
        /@\/features\/payments\//.test(src),
        `${screen} should take payment data from @/features/payments`,
      );

      // No direct Supabase table access for payment tables.
      for (const table of PAYMENT_TABLES) {
        assert.ok(
          !new RegExp(`\\.from\\(\\s*['"]${table}['"]`).test(src),
          `${screen} must not read payment table '${table}' directly`,
        );
      }

      assert.ok(
        !/getSupabase\(\)/.test(src),
        `${screen} should not hold a Supabase client; mutations belong in the feature layer`,
      );
    }
  });

  test('the review queue can answer why a payment did not match', () => {
    // The queue selects '*', so the columns it can show are guaranteed by the
    // row type rather than by the select string. Assert the guarantee where it
    // actually lives.
    const types = read(join(SRC, 'lib', 'database.types.ts'));
    const start = types.indexOf('export type PaymentEventRow');
    assert.ok(start > -1, 'PaymentEventRow must exist');
    const rowType = types.slice(start, types.indexOf('export type PaymentMatchRow'));

    for (const column of [
      'amount',
      'provider',
      'receiver_account',
      'sender_account',
      'transaction_id',
      'detected_at',
      'mismatch_reason',
      'status',
      'payment_account_id',
    ]) {
      assert.ok(
        rowType.includes(column),
        `PaymentEventRow must carry ${column} for the review queue to show it`,
      );
    }

    const queries = read(join(SRC, 'features', 'payments', 'queries.ts'));

    // Rejected candidates must be readable, or a seller cannot see why an order
    // was ruled out.
    assert.ok(
      queries.includes('payment_matches'),
      'the review queue must read payment_matches, including rejected candidates',
    );

    // The queue must select the states that need a human, and must not select
    // the ones already settled.
    assert.ok(
      queries.includes("'review_required'"),
      'the queue must include payments awaiting a decision',
    );
    assert.ok(queries.includes("'unmatched'"), "the queue must include payments with no waiting order");
  });

  test('the review screen surfaces the refusal reason and candidates', () => {
    const screen = read(join(REPO, 'src/app/(app)/payment-review.tsx'));

    for (const needle of [
      'reasonCopy', // machine reason -> seller-facing sentence
      'PaymentEventStatusBadge',
      'PaymentMatchBadge', // confidence per candidate
      'payment_matches', // candidates, not just the winner
      'transaction_id',
      'sender_account',
      'providerLabel',
    ]) {
      assert.ok(screen.includes(needle), `payment-review must use ${needle}`);
    }
  });

  test('the intent form takes its amount and order from the real order', () => {
    const form = read(join(REPO, 'src/app/(app)/payment-intent/new.tsx'));

    assert.ok(form.includes('useOrderPaymentContext'), 'must read the actual order');
    assert.ok(form.includes('outstanding'), 'must default to the outstanding amount');
    assert.ok(form.includes('useCreatePaymentIntent'), 'must create a real intent');
    // toMajor, not money(): money() is the read path and would multiply by 100.
    assert.ok(
      form.includes('toMajor'),
      'expected_amount is a major-unit column and must use toMajor',
    );
  });

  test('the account form uses the real RPC and shows the canonical number', () => {
    const form = read(join(REPO, 'src/app/(app)/payment-account/new.tsx'));

    assert.ok(form.includes('useCreatePaymentAccount'), 'must use the real mutation');
    assert.ok(form.includes('normalizeBdNumber'), 'must normalise what was typed');
    assert.ok(
      form.includes('features/payments/normalize'),
      'must use the shared, tested normaliser rather than a second copy',
    );
  });

  test('no SMS permission exists anywhere in the app configuration', () => {
    const appJson = read(join(REPO, 'app.json'));
    const easJson = read(join(REPO, 'eas.json'));
    const combined = `${appJson}\n${easJson}`;

    for (const permission of [
      'RECEIVE_SMS',
      'READ_SMS',
      'SEND_SMS',
      'WRITE_SMS',
      'RECEIVE_MMS',
      'RECEIVE_WAP_PUSH',
      'READ_CALL_LOG',
      'WRITE_CALL_LOG',
    ]) {
      assert.ok(
        !combined.includes(permission),
        `${permission} must not be declared: the native SMS adapter has not started`,
      );
    }
  });

  test('no SMS parsing or receiver has been implemented yet', () => {
    const banned = [
      /SmsReceiver/i,
      /RECEIVE_SMS/i,
      /BroadcastReceiver/i,
      /Telephony\.Sms/i,
      /pdus/,
      /sms_body/i,
    ];

    const offenders = [];
    for (const file of files) {
      const src = code(file);
      for (const pattern of banned) {
        if (pattern.test(src)) offenders.push(`${rel(file)} matches ${pattern}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `native SMS work must not exist yet:\n  ${offenders.join('\n  ')}`,
    );
  });
});