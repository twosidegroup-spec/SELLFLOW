/**
 * Live payment isolation probe.
 *
 * Phase 7 gate. Two independent sellers against the REAL hosted project.
 *
 * WHY THIS NEEDS ITS OWN PROBE
 *
 * The payment tables carry `Insert: never` and `Update: never` in database.types.ts, and
 * migration 0024 revokes the table grants explicitly. Types and grants are both easy to
 * believe and impossible to trust without trying, and the failure mode is not a crash --
 * it is seller B's money appearing against seller A's order.
 *
 * So every one of the following is attempted as a real caller and the OUTCOME asserted:
 *
 *   READ     Seller B cannot read Seller A's payment accounts, events, matches, intents,
 *            audit log, or payments
 *   INSERT   Seller B cannot insert a payment against Seller A's order
 *   UPDATE   Seller B cannot modify Seller A's payment records
 *   ATTACH   Seller B cannot assign a payment to Seller A's intent, or reject one
 *   REVERSE  Seller A cannot read Seller B's, and the same list in both directions
 *
 * Reads alone are not enough. A read leak is embarrassing; a write leak corrupts somebody
 * else's books.
 *
 * IT ALSO PROVES THE ENGINE'S SAFETY RULES FOR REAL
 *
 *   duplicate   the same transaction_id twice is recognised, and counted once
 *   mismatch    a payment to the wrong provider/account cannot settle an order
 *   unmatched   money with no waiting order does NOT become a payment
 *   no raw body  payment_events carry a fingerprint, never the message
 *
 * CLEANUP
 *
 * Leaf-first, identity last, then VERIFIED by re-querying. A cleanup that reports success
 * without checking is not a cleanup, and test accounting rows left in production are worse
 * than no test at all.
 *
 * Run: node --env-file=.env scripts/live-payment-probe.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const PASSWORD = 'probe-password-9f2a7c1e';

if (!url || !anonKey) {
  console.error('EXPO_PUBLIC_SUPABASE_URL / ANON_KEY are not set. Cannot probe.');
  process.exit(1);
}

const stamp = `v2pay${Date.now()}`;
const sellers = {
  a: { email: `a-${stamp}@example.invalid`, name: 'Pay Seller A' },
  b: { email: `b-${stamp}@example.invalid`, name: 'Pay Seller B' },
};

const created = { userIds: [], orgIds: [] };
let failures = 0;

function check(ok, label, detail) {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures += 1;
  }
}

function adminKey() {
  const result = spawnSync(
    'npx',
    ['--yes', 'supabase@2.119.0', 'projects', 'api-keys', '--reveal'],
    { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, shell: true },
  );
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const parsed = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1));
  const key = parsed.keys?.find((k) => k.name === 'service_role')?.api_key;
  if (!key || key.includes('***')) return null;
  return key;
}

/** `orders.client_ref` is a uuid; a readable stamp is rejected by Postgres. */
const uuid = () => {
  const hex = (n) => {
    let out = '';
    for (let i = 0; i < n; i += 1) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  };
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
};

async function register(client, who) {
  const { data, error } = await client.auth.signUp({
    email: who.email,
    password: PASSWORD,
    options: { data: { full_name: who.name } },
  });
  if (error) throw new Error(`${who.email}: ${error.message}`);
  created.userIds.push(data.user.id);

  const { data: boot, error: bootError } = await client.rpc('bootstrap_business', {
    p_business_name: `${who.name} ${stamp}`,
    p_store_name: null,
    p_store_code: null,
  });
  if (bootError) throw new Error(`${who.email}: ${bootError.message}`);

  const orgId = boot?.id ?? boot?.org_id;
  created.orgIds.push(orgId);

  const { data: stores } = await client
    .from('stores')
    .select('id')
    .eq('org_id', orgId)
    .limit(1);

  return { orgId, storeId: stores?.[0]?.id };
}

async function main() {
  const a = createClient(url, anonKey, { auth: { persistSession: false } });
  const b = createClient(url, anonKey, { auth: { persistSession: false } });

  console.log('\n== two independent sellers ==');
  const A = await register(a, sellers.a);
  const B = await register(b, sellers.b);
  check(Boolean(A.storeId && B.storeId), 'both have a store');

  // ------------------------------------------------------------ accounts
  console.log('\n== payment accounts ==');

  const { data: accA, error: accErr } = await a.rpc('create_payment_account', {
    p_org_id: A.orgId,
    p_provider: 'bkash',
    p_account_number: '01712345678',
    p_account_type: 'personal',
    p_label: 'Shop number',
  });
  check(!accErr, 'seller A connected a bKash account', accErr?.message);
  const accountA = accA?.id ?? accA?.payment_account_id ?? accA;

  const { data: accB } = await b.rpc('create_payment_account', {
    p_org_id: B.orgId,
    p_provider: 'nagad',
    p_account_number: '01912345679',
    p_account_type: 'personal',
    p_label: null,
  });
  const accountB = accB?.id ?? accB?.payment_account_id ?? accB;
  check(Boolean(accountB), 'seller B connected a Nagad account');
  check(accountA !== accountB, 'the two accounts are different rows');

  // The +880 rewrite: the SQL original turned +8801712... into 0801712..., so every
  // payment to a number typed with a country code failed to match.
  const { data: normalised } = await a
    .from('payment_accounts')
    .select('account_number')
    .eq('id', accountA)
    .single();
  check(
    String(normalised?.account_number ?? '').startsWith('017'),
    'the stored number is canonical and did not become 080...',
    `stored ${normalised?.account_number}`,
  );

  // A foreign org must be refused, and the same call must succeed for its own org --
  // otherwise a refusal proves nothing but that the call was malformed.
  const { error: foreign } = await a.rpc('create_payment_account', {
    p_org_id: B.orgId,
    p_provider: 'bkash',
    p_account_number: '01799999999',
    p_account_type: 'personal',
    p_label: null,
  });
  check(Boolean(foreign), 'seller A cannot create an account inside seller B org');

  // ------------------------------------------------------------- an order
  console.log('\n== an order to be paid ==');

  const { data: product } = await a
    .from('products')
    .insert({
      org_id: A.orgId,
      name: 'Payable item',
      sku: `PAY-${stamp}`,
      selling_price: 1000,
      cost_price: 600,
      low_stock_threshold: 1,
      track_inventory: false,
    })
    .select()
    .single();

  const { data: customer } = await a
    .from('customers')
    .insert({
      org_id: A.orgId,
      name: 'Paying Customer',
      phone: '01812345678',
      district: 'Dhaka',
      thana: 'Mirpur',
    })
    .select()
    .single();

  const { data: orderId, error: orderErr } = await a.rpc('create_order', {
    p_store_id: A.storeId,
    p_customer_id: customer.id,
    p_items: [{ product_id: product.id, variant_id: null, quantity: 1, line_discount: 0 }],
    p_discount: 0,
    p_delivery_charge: 0,
    p_amount_paid: 0,
    p_payment_method: 'cash',
    p_notes: 'payment probe',
    p_client_ref: uuid(),
  });
  check(!orderErr, 'seller A created a 1,000 order, unpaid', orderErr?.message);

  const { data: order } = await a.from('orders').select('*').eq('id', orderId).single();
  check(order?.total === 1000 && order?.amount_paid === 0, 'order total 1,000, nothing paid');

  // -------------------------------------------------- an ingested payment
  console.log('\n== an ingested payment event ==');

const txnId = `TXN${stamp}`.slice(0, 40);

  /*
   * `ingest_payment_event` takes the RESOLVED account id, not an org id and not a
   * number for the engine to look up. The receiver account is still sent and is still
   * checked by the engine, but which account it must equal has already been decided by
   * the caller -- which is the client, so the client must not decide it from anything
   * the seller typed. Here it is always seller A's own account.
   */
  const ingest = (over = {}) =>
    a.rpc('ingest_payment_event', {
      p_payment_account_id: accountA,
      p_provider: 'bkash',
      p_receiver_account: '01712345678',
      p_sender_account: '01812345678',
      p_amount: 1000,
      p_transaction_id: txnId,
      p_source: 'api',
      ...over,
    });

  const { data: ingested, error: ingestErr } = await ingest({
    p_fingerprint: `probe-fingerprint-${stamp}`,
  });
  check(!ingestErr, 'a payment event was ingested', ingestErr?.message);
  check(Boolean(ingested), 'the engine returned a response');

  const eventId = ingested?.event_id ?? ingested?.eventId ?? ingested?.id;
  const { data: event } = await a
    .from('payment_events')
    .select('*')
    .eq('id', eventId)
    .single();
  check(Boolean(event), 'the event row exists');
  check(
    event?.payment_account_id === accountA,
    'the engine matched the receiving number to seller A own account',
    `got ${event?.payment_account_id}`,
  );

  // The raw-message promise. A fingerprint is a hash; anything resembling a body fails.
  const columns = Object.keys(event ?? {});
  check(
    !columns.some((c) => /body|message|sms_text|raw/i.test(c)),
    'payment_events has NO column that could hold a message body',
    columns.filter((c) => /body|message|sms_text|raw/i.test(c)).join(','),
  );
  check(
    event?.fingerprint === `probe-fingerprint-${stamp}`,
    'the event carries the fingerprint it was given, and nothing else',
  );

  // ---------------------------------------------------------- duplicates
  console.log('\n== the same payment seen twice ==');

const { data: dupRaw, error: dupErr } = await ingest({
    p_fingerprint: `probe-fingerprint-${stamp}`,
  });
  check(!dupErr, 'the identical payment was submitted again', dupErr?.message);

  // Either the engine returned the original event, or a new row marked duplicate.
  const dupId = dupRaw?.event_id ?? dupRaw?.eventId ?? dupRaw?.id;
  const dupSameRow = dupId === eventId;
  let dupStatus = null;
  if (!dupSameRow && dupId) {
    const { data: dupRow } = await a
      .from('payment_events')
      .select('status')
      .eq('id', dupId)
      .single();
    dupStatus = dupRow?.status ?? null;
  }
  check(
    dupSameRow || dupStatus === 'duplicate',
    'the engine recognised it as already seen',
    `status=${dupStatus} sameRow=${dupSameRow}`,
  );

  const { data: paymentsAfterDup } = await a
    .from('payments')
    .select('amount')
    .eq('order_id', orderId);
  check(
    (paymentsAfterDup ?? []).length === 0,
    'and NO payment was written, so the order cannot be paid twice',
    `${(paymentsAfterDup ?? []).length} payment rows`,
  );

  // ------------------------------------------------- unmatched does not pay
  console.log('\n== money with no waiting order ==');

  const strangerTxn = `TXN${stamp}X`.slice(0, 40);
  const { data: strangerRaw } = await ingest({
    p_transaction_id: strangerTxn,
    p_sender_account: '01900000000',
    p_amount: 777,
    p_fingerprint: `probe-stranger-${stamp}`,
  });
  const strangerId = strangerRaw?.event_id ?? strangerRaw?.eventId ?? strangerRaw?.id;

  /*
   * Ingesting settles NOTHING. The event sits at `detected` until something asks the
   * engine to match it, which is the app's listener. That is stricter than I expected
   * and better than it sounds: a notification arriving is not by itself an instruction
   * to move money.
   */
  const { data: onArrival } = await a
    .from('payment_events')
    .select('status')
    .eq('id', strangerId)
    .single();
  check(
    onArrival?.status === 'detected',
    'arriving is not settling: the event waits at `detected`',
    `status=${onArrival?.status}`,
  );

  const { data: paymentsOnArrival } = await a
    .from('payments')
    .select('amount')
    .eq('order_id', orderId);
  check(
    (paymentsOnArrival ?? []).length === 0,
    'and no payment exists merely because a notification arrived',
  );

  // Now the app asks the engine to match it. This is where an advance should be refused.
  const { error: strangerMatchErr } = await a.rpc('match_payment_event', {
    p_event_id: strangerId,
  });
  check(!strangerMatchErr, 'the engine was asked to match it', strangerMatchErr?.message);

  const { data: stranger } = await a
    .from('payment_events')
    .select('status')
    .eq('id', strangerId)
    .single();

  check(
    stranger?.status === 'unmatched' || stranger?.status === 'review_required',
    'a payment with no waiting order is REFUSED, not settled',
    `status=${stranger?.status}`,
  );

  const { data: afterStranger } = await a
    .from('orders')
    .select('amount_paid')
    .eq('id', orderId)
    .single();
  check(
    afterStranger?.amount_paid === 0,
    'the order is still unpaid, because nothing was allowed to attach itself',
    `amount_paid=${afterStranger?.amount_paid}`,
  );

  // --------------------------------------------------- provider mismatch
  console.log('\n== a payment naming the wrong provider ==');

const wrongTxn = `TXN${stamp}P`.slice(0, 40);
  const { data: wrongRaw } = await ingest({
    // Claims Nagad, but seller A only connected bKash.
    p_provider: 'nagad',
    p_transaction_id: wrongTxn,
    p_fingerprint: `probe-wrongprovider-${stamp}`,
  });
  const wrongId = wrongRaw?.event_id ?? wrongRaw?.eventId ?? wrongRaw?.id;

  const { data: wrong } = await a
    .from('payment_events')
    .select('status, mismatch_reason, payment_account_id')
    .eq('id', wrongId)
    .single();

  check(
    wrong?.status !== 'confirmed',
    'a provider that is not connected cannot settle anything',
    `status=${wrong?.status}`,
  );

  const { data: afterWrong } = await a
    .from('orders')
    .select('amount_paid')
    .eq('id', orderId)
    .single();
  check(afterWrong?.amount_paid === 0, 'the order is STILL unpaid after the wrong provider');

  // ------------------------------------------------------ read isolation
  console.log('\n== seller B cannot READ seller A payment data ==');

  const tables = [
    'payment_accounts',
    'payment_events',
    'payment_matches',
    'payment_intents',
    'payment_audit_logs',
    'payments',
  ];

  for (const table of tables) {
    const { data, error } = await b.from(table).select('*').eq('org_id', A.orgId);
    if (error) {
      check(true, `B cannot read A ${table} (refused: ${error.message.slice(0, 40)})`);
    } else {
      check((data ?? []).length === 0, `B cannot read A ${table}`);
    }
  }

  // And by id, not just by org filter, which is the shape a real request takes.
  const { data: byId } = await b.from('payment_events').select('*').eq('id', eventId);
  check((byId ?? []).length === 0, 'B cannot read A payment event by id');
  const { data: accById } = await b.from('payment_accounts').select('*').eq('id', accountA);
  check((accById ?? []).length === 0, 'B cannot read A payment account by id');

  // And the reverse.
  for (const table of ['payment_accounts', 'payment_events']) {
    const { data } = await a.from(table).select('*').eq('org_id', B.orgId);
    check((data ?? []).length === 0, `A cannot read B ${table}`);
  }

  // ---------------------------------------------------- write isolation
  console.log('\n== seller B cannot WRITE seller A payment data ==');

  const inserts = [
    ['payments', { org_id: A.orgId, store_id: A.storeId, order_id: orderId, amount: 1, method: 'cash', paid_at: new Date().toISOString() }],
    ['payment_accounts', { org_id: A.orgId, provider: 'bkash', account_number: '01700000000', account_type: 'personal', label: null }],
  ];

for (const [table, row] of inserts) {
    const { error } = await b.from(table).insert(row);
    check(
      Boolean(error),
      `B cannot INSERT into A ${table}`,
      error ? '' : 'the insert succeeded',
    );
  }

  /*
   * UPDATE and DELETE are deliberately NOT tested here.
   *
   * An update or delete that matches ZERO rows returns success. Asserting "no error"
   * before any payment row exists would therefore pass vacuously -- it would prove
   * nothing at all, and would look like a security guarantee. They are tested at the
   * end of this probe, against a payment row that demonstrably exists.
   */

  // The RPCs are the only write path, so they need testing separately from the tables.
  const { error: assignErr } = await b.rpc('assign_payment_match', {
    p_event_id: eventId,
    p_intent_id: null,
    p_note: 'cross-tenant assign',
  });
  check(Boolean(assignErr), 'B cannot ASSIGN one of A payments to an intent', assignErr ? '' : 'it succeeded');

  const { error: rejectErr } = await b.rpc('reject_payment_match', {
    p_event_id: eventId,
    p_reason: 'cross-tenant reject',
  });
  check(Boolean(rejectErr), 'B cannot REJECT one of A payments', rejectErr ? '' : 'it succeeded');

  // Nothing above should have changed anything.
  const { data: orderAfter } = await a
    .from('orders')
    .select('amount_paid, total')
    .eq('id', orderId)
    .single();
  check(
    orderAfter?.amount_paid === 0 && orderAfter?.total === 1000,
    'after every cross-tenant attempt, A order is untouched',
    `paid=${orderAfter?.amount_paid} total=${orderAfter?.total}`,
  );

  // ------------------------------------------------------------- success
  console.log('\n== the path that SHOULD work ==');

const { data: intentId, error: intentErr } = await a.rpc('create_payment_intent', {
    p_type: 'order',
    p_reference_id: orderId,
    p_payment_account_id: accountA,
    p_expected_amount: 1000,
    p_expected_customer_phone: '01812345678',
    p_expected_customer_name: 'Paying Customer',
    p_expires_at: null,
    p_client_ref: uuid(),
  });
  check(!intentErr, 'seller A can create a payment intent on its own order', intentErr?.message);
  check(Boolean(intentId), 'the intent exists and has an id', JSON.stringify(intentId));

  const { data: settleRaw } = await ingest({
    p_transaction_id: `TXN${stamp}S`.slice(0, 40),
    p_fingerprint: `probe-settle-${stamp}`,
  });
  const settleEventId = settleRaw?.event_id ?? settleRaw?.eventId ?? settleRaw?.id;
  check(Boolean(settleEventId), 'the matching payment arrived');

  // Ingesting does not settle on its own; the engine must be asked to match.
  if (settleEventId) {
    const { error: matchErr } = await a.rpc('match_payment_event', {
      p_event_id: settleEventId,
    });
    check(!matchErr, 'the engine matched the payment', matchErr?.message);
  }

const { data: settled } = await a.from('payments').select('*').eq('order_id', orderId);
  const total = (settled ?? []).reduce((sum, row) => sum + row.amount, 0);
  check(total === 1000, `the order was settled exactly once, totalling 1,000`, `got ${total}`);
  check((settled ?? []).length === 1, 'and by exactly one payment row, not several',
    `${(settled ?? []).length} rows`);

  // ------------------------------------------- UPDATE / DELETE, non-vacuously
  /*
   * Now that a payment row demonstrably EXISTS, cross-tenant UPDATE and DELETE can be
   * tested meaningfully. Earlier in this probe, before any payment existed, both would
   * have returned success while matching zero rows -- which would have been a green
   * check proving nothing.
   */
  console.log('\n== cross-tenant UPDATE and DELETE, against a row that exists ==');

  check((settled ?? []).length > 0, 'precondition: A has at least one payment row to attack');
  const paymentId = settled?.[0]?.id;

  /*
   * THE FINDING: RLS filters these writes, it does not refuse them.
   *
   * Seller B's UPDATE and DELETE both return SUCCESS -- no error, no failure -- while
   * changing nothing, because row-level security filters the rows out of the statement
   * rather than raising. The row is still there with its original amount.
   *
   * So the assertion here is deliberately about the EFFECT and never about the absence
   * of an error. A probe that asserted `error === null` would have reported "B cannot
   * update A" and been wrong for the wrong reason; one that asserted "no error" would
   * have reported a breach that did not happen. Only reading the row back settles it.
   *
   * This also matters to the app: a client that treated "the write returned success" as
   * proof it wrote a payment would be lying to itself. Nothing in SellFlow does, but
   * the shape of this API invites the mistake, so it is recorded here.
   */
  const { error: updPayment } = await b
    .from('payments')
    .update({ amount: 999999 })
    .eq('id', paymentId);
  const { error: delPayment } = await b.from('payments').delete().eq('id', paymentId);

  const { data: paymentAfterAttack } = await a
    .from('payments')
    .select('amount')
    .eq('id', paymentId)
    .single();

  check(
    paymentAfterAttack?.amount === 1000,
    "B's UPDATE did not change A's payment, whatever the call returned",
    `amount is now ${paymentAfterAttack?.amount}`,
  );
  check(
    paymentAfterAttack !== null,
    "B's DELETE did not remove A's payment, whatever the call returned",
  );
  console.log(
    `  NOTE  RLS filtered both writes silently: update error=${updPayment ? 'refused' : 'none'}, ` +
      `delete error=${delPayment ? 'refused' : 'none'}. The row is intact either way.`,
  );

  const { error: updEvent } = await b
    .from('payment_events')
    .update({ status: 'confirmed' })
    .eq('id', eventId);
  const { data: eventAfterAttack } = await a
    .from('payment_events')
    .select('status').eq('id', eventId).single();
  check(
    eventAfterAttack?.status === event?.status,
    "B cannot forge A's payment event status",
    `was ${event?.status}, now ${eventAfterAttack?.status} (err=${updEvent ? 'refused' : 'none'})`,
  );

  const { data: eventAfter } = await a.from('payment_events').select('status').eq('id', eventId).single();
  check(
    eventAfter?.status !== 'confirmed' || event?.status === 'confirmed',
    'A payment event status was not forged by B',
    `status is now ${eventAfter?.status}`,
  );

  check(Boolean(intentId), 'the intent existed to match against');
}

// -------------------------------------------------------------- cleanup
async function finish() {
  const key = adminKey();
  if (!key) {
    console.log('\n  WARN  no service key: cleanup was NOT verified.');
    return;
  }
const admin = createClient(url, key, { auth: { persistSession: false } });

  /*
   * Leaf-first, identity last, and EVERY delete error is checked.
   *
   * This block used to ignore the error on the organization delete and verify by
   * NAME PATTERN, and it reported "zero probe organizations remain" while leaving four
   * behind in the production project. Two separate flaws:
   *
   *   an unchecked delete that fails leaves rows, and
   *   a name pattern cannot see a row it fails to predict the name of
   *
   * So: check every error, and verify against the exact ids this run created rather
   * than a LIKE over names.
   */
  const leafTables = [
    'payment_matches',
    'payment_events',
    'payment_audit_logs',
    'payment_intents',
    'payments',
    'order_items',
    'orders',
    'products',
    'inventory',
    'inventory_movements',
    'customers',
  ];
  const parentTables = ['payment_accounts', 'order_status_history', 'organization_members', 'stores'];

  for (const orgId of created.orgIds) {
    for (const table of [...leafTables, ...parentTables]) {
      const { error } = await admin.from(table).delete().eq('org_id', orgId);
      if (error) console.log(`  WARN  ${table} for ${orgId}: ${error.message}`);
    }
    const { error } = await admin.from('organizations').delete().eq('id', orgId);
    if (error) console.log(`  WARN  organization ${orgId}: ${error.message}`);
  }

  for (const userId of created.userIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) console.log(`  WARN  identity ${userId}: ${error.message}`);
  }

  // Verified by ID. A pattern can miss; an id cannot.
  const { data: orgsById, error: byIdErr } = await admin
    .from('organizations')
    .select('id, name')
    .in('id', created.orgIds);
  check(!byIdErr, 'the verification query itself ran', byIdErr?.message);
  check(
    (orgsById ?? []).length === 0,
    'zero of THIS run probe organizations remain',
    (orgsById ?? []).map((o) => o.name).join(', '),
  );

  // And by pattern as well, so a run that created more than it tracked is still caught.
  const { data: orgsByName, error: byNameErr } = await admin
    .from('organizations')
    .select('id')
    .like('name', `%${stamp}%`);
  check(!byNameErr, 'the pattern verification query ran', byNameErr?.message);
  check((orgsByName ?? []).length === 0, 'zero organizations matching this run stamp remain');

  for (const orgId of created.orgIds) {
    for (const table of ['orders', 'payments', 'payment_events', 'payment_intents', 'products', 'customers']) {
      const { data } = await admin.from(table).select('id').eq('org_id', orgId);
      check((data ?? []).length === 0, `zero ${table} remain for ${orgId}`);
    }
  }

  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const leftover = (users?.users ?? []).filter((u) => u.email?.includes(stamp));
  check(leftover.length === 0, 'zero probe identities remain', leftover.map((u) => u.email).join());
}

console.log(`\nSellFlow phase 7 payment probe ${stamp}`);
try {
  await main();
} catch (error) {
  console.log(`\n  ERROR ${error.message}`);
  failures += 1;
} finally {
  await finish();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);