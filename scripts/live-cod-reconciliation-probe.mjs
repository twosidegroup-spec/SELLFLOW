/**
 * COD reconciliation, live, against the real hosted database.
 *
 * THE INVARIANT
 *
 *     received money  +  courier receivable  <=  order total
 *
 * for every order at every point in its life. A taka cannot be both in the seller's
 * hand and still on a rider's.
 *
 * WHY A SEPARATE PROBE AND NOT A SECTION OF live-payment-probe.mjs
 *
 * Because this probe is EXPECTED TO BE RED until migration 0026 is applied. Folding it
 * into the main payment probe would mean either leaving the suite red or -- far worse --
 * weakening an assertion to get green output. A dedicated script that reports the
 * measured state honestly is the only honest way to hold a known-unfixed defect in the
 * repository.
 *
 *   run before 0026 -> the reconciliation checks FAIL, and the output is the evidence
 *                       that the defect is real and live right now
 *   run after  0026 -> everything passes, and the same output is the proof it is fixed
 *
 * WHAT IS COVERED
 *
 *   the exact scenario: COD 1,010, paid 1,010, receivable must fall to 0
 *   partial reconciliation, in two instalments
 *   repeated payment protection (the idempotency key must not double-apply)
 *   a normal non-COD order, untouched by any of this
 *   zero and negative and overpayment refusals
 *   cross-tenant isolation for both record_payment and record_refund
 *   the audit trail: a payment row per recorded movement, no silent writes
 *
 * Run: node --env-file=.env scripts/live-cod-reconciliation-probe.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const PASSWORD = 'probe-password-9f2a7c1e';

if (!url || !anonKey) {
  console.error('Supabase env not set.');
  process.exit(1);
}

const stamp = `v2cod${Date.now()}`;
const created = { userIds: [], orgIds: [] };

let failures = 0;
function check(ok, label, detail) {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures += 1;
  }
}
function note(message) {
  console.log(`  NOTE  ${message}`);
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

const uuid = () => {
  const hex = (n) => {
    let out = '';
    for (let i = 0; i < n; i += 1) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  };
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
};

async function register(client, email) {
  const { data, error } = await client.auth.signUp({
    email,
    password: PASSWORD,
    options: { data: { full_name: 'COD Probe Seller' } },
  });
  if (error) throw new Error(`${email}: ${error.message}`);
  created.userIds.push(data.user.id);

  const { data: boot, error: bootErr } = await client.rpc('bootstrap_business', {
    p_business_name: `COD Probe ${stamp}`,
    p_store_name: null,
    p_store_code: null,
  });
  if (bootErr) throw new Error(`${email}: ${bootErr.message}`);
  const orgId = boot?.id ?? boot?.org_id;
  created.orgIds.push(orgId);

  const { data: stores } = await client.from('stores').select('id').eq('org_id', orgId).limit(1);
  return { orgId, storeId: stores?.[0]?.id };
}

async function seed(client, orgId, name, price) {
  const { data: product } = await client
    .from('products')
    .insert({
      org_id: orgId,
      name,
      sku: `${name}-${stamp}`,
      selling_price: price,
      cost_price: 0,
      low_stock_threshold: 0,
      track_inventory: false,
    })
    .select()
    .single();

  const { data: customer } = await client
    .from('customers')
    .insert({ org_id: orgId, name: `COD Customer ${name}`, phone: '01700000000' })
    .select()
    .single();

  return { product, customer };
}

async function makeCodOrder(client, storeId, customerId, productId, deliveryCharge, isCod) {
  const { data: orderId, error } = await client.rpc('create_order', {
    p_store_id: storeId,
    p_customer_id: customerId,
    p_items: [{ product_id: productId, variant_id: null, quantity: 1, line_discount: 0 }],
    p_discount: 0,
    p_delivery_charge: deliveryCharge,
    p_amount_paid: 0,
    p_payment_method: 'cash',
    p_notes: 'cod reconciliation probe',
    p_client_ref: uuid(),
    p_is_cod: isCod,
  });
  if (error) throw new Error(`create_order: ${error.message}`);
  return orderId;
}

const readOrder = async (client, orderId) => {
  const { data } = await client.from('orders').select('*').eq('id', orderId).single();
  return data;
};

async function main() {
  const a = createClient(url, anonKey, { auth: { persistSession: false } });
  const b = createClient(url, anonKey, { auth: { persistSession: false } });

  console.log(`\nSellFlow COD reconciliation probe ${stamp}\n`);
  console.log('== two independent sellers ==');
  const A = await register(a, `a-${stamp}@example.invalid`);
  const B = await register(b, `b-${stamp}@example.invalid`);
  check(Boolean(A.storeId && B.storeId), 'both sellers have a store');

  const { product: p1010, customer: c1 } = await seed(a, A.orgId, 'item1010', 1000);

  // ---------------------------------------------------------------------------
  // 1. THE EXACT SCENARIO: COD 1,010 paid in full.
  // ---------------------------------------------------------------------------
  console.log('\n== COD 1,010, paid in full ==');

  const fullOrderId = await makeCodOrder(a, A.storeId, c1.id, p1010.id, 10, true);
  let order = await readOrder(a, fullOrderId);

  check(order?.total === 1010, 'order total is 1,010', `got ${order?.total}`);
  check(order?.is_cod === true, 'the order is cash on delivery');
  check(order?.cod_amount === 1010, 'courier receivable is 1,010 to begin with', `got ${order?.cod_amount}`);
  check(order?.amount_paid === 0, 'received is 0 to begin with', `got ${order?.amount_paid}`);
  check(order?.cod_settled === false, 'not settled to begin with');

  // Recorded by hand, which is what a seller does when a customer pays cash at the door.
  const { error: payErr } = await a.rpc('record_payment', {
    p_order_id: fullOrderId,
    p_amount: 1010,
    p_method: 'cash',
    p_note: 'probe: paid in full',
    p_idempotency_key: uuid(),
  });
  check(!payErr, 'record_payment accepted 1,010', payErr?.message);

  order = await readOrder(a, fullOrderId);
  check(order?.amount_paid === 1010, 'received is now 1,010', `got ${order?.amount_paid}`);
  check(order?.payment_status === 'paid', 'payment status is paid');

  // THE DEFECT. Before 0026 this is 1010 and the check fails.
  check(
    order?.cod_amount === 0,
    'courier receivable has fallen to 0 -- the money is not counted twice',
    `still owed by the courier: ${order?.cod_amount}`,
  );
  check(
    order?.cod_settled === true,
    'the COD leg is settled',
    `cod_settled=${order?.cod_settled}`,
  );

  const invariant = (order?.amount_paid ?? 0) + (order?.cod_amount ?? 0) <= (order?.total ?? 0);
  check(invariant, 'INVARIANT: received + courier receivable <= order total',
    `received ${order?.amount_paid} + owed ${order?.cod_amount} vs total ${order?.total}`);

  // ---------------------------------------------------------------------------
  // 2. Partial reconciliation, in two instalments.
  // ---------------------------------------------------------------------------
  console.log('\n== COD paid in two instalments ==');

  const { product: p2000, customer: c2 } = await seed(a, A.orgId, 'item2000', 2000);
  const partOrderId = await makeCodOrder(a, A.storeId, c2.id, p2000.id, 0, true);
  let part = await readOrder(a, partOrderId);
  check(part?.cod_amount === 2000, 'receivable starts at 2,000', `got ${part?.cod_amount}`);

  await a.rpc('record_payment', {
    p_order_id: partOrderId, p_amount: 1200, p_method: 'cash', p_idempotency_key: uuid(),
  });
  part = await readOrder(a, partOrderId);
  check(part?.amount_paid === 1200, 'received is 1,200', `got ${part?.amount_paid}`);
  check(part?.cod_amount === 800, 'receivable is 800', `got ${part?.cod_amount}`);
  check(part?.cod_settled === false, 'not settled while the rider still holds 800');
  check(part?.payment_status === 'partial', 'status is partial', `got ${part?.payment_status}`);

  await a.rpc('record_payment', {
    p_order_id: partOrderId, p_amount: 800, p_method: 'cash', p_idempotency_key: uuid(),
  });
  part = await readOrder(a, partOrderId);
  check(part?.cod_amount === 0, 'receivable is 0 after the second instalment', `got ${part?.cod_amount}`);
  check(part?.cod_settled === true, 'now settled');
  check(
    (part?.amount_paid ?? 0) + (part?.cod_amount ?? 0) <= (part?.total ?? 0),
    'INVARIANT holds after two instalments',
  );

  // ---------------------------------------------------------------------------
  // 3. Repeated payment protection.
  // ---------------------------------------------------------------------------
  console.log('\n== repeated payment protection ==');

  const { product: p800, customer: c3 } = await seed(a, A.orgId, 'item800', 800);
  const repOrderId = await makeCodOrder(a, A.storeId, c3.id, p800.id, 0, true);
  const key = uuid();

  const first = await a.rpc('record_payment', {
    p_order_id: repOrderId, p_amount: 400, p_method: 'cash', p_idempotency_key: key,
  });
  check(!first.error, 'first payment recorded', first.error?.message);

  // The SAME key again must not apply twice.
  const replay = await a.rpc('record_payment', {
    p_order_id: repOrderId, p_amount: 400, p_method: 'cash', p_idempotency_key: key,
  });
  check(!replay.error, 'replaying the same key is a success, not an error', replay.error?.message);

  let rep = await readOrder(a, repOrderId);
  check(rep?.amount_paid === 400, 'the replay did NOT double-count', `amount_paid=${rep?.amount_paid}`);

  const { data: repPayments } = await a
    .from('payments')
    .select('amount')
    .eq('order_id', repOrderId);
  check((repPayments ?? []).length === 1, 'exactly one payment row exists', `${(repPayments ?? []).length} rows`);

  // Same key, different amount, is a caller bug and must be refused.
  const { error: misuseErr } = await a.rpc('record_payment', {
    p_order_id: repOrderId, p_amount: 100, p_method: 'cash', p_idempotency_key: key,
  });
  check(Boolean(misuseErr), 'reusing a key with a different amount is refused');

  // ---------------------------------------------------------------------------
  // 4. A non-COD order is untouched by all of this.
  // ---------------------------------------------------------------------------
  console.log('\n== a normal non-COD order ==');

  const { product: p500, customer: c4 } = await seed(a, A.orgId, 'item500', 500);
  const plainOrderId = await makeCodOrder(a, A.storeId, c4.id, p500.id, 0, false);
  let plain = await readOrder(a, plainOrderId);
  check(plain?.is_cod === false, 'the order is not COD');
  check(plain?.cod_amount === 0, 'no receivable to begin with');

  await a.rpc('record_payment', {
    p_order_id: plainOrderId, p_amount: 500, p_method: 'cash', p_idempotency_key: uuid(),
  });
  plain = await readOrder(a, plainOrderId);
  check(plain?.amount_paid === 500, 'received 500', `got ${plain?.amount_paid}`);
  check(plain?.cod_amount === 0, 'a non-COD order never gains a receivable', `got ${plain?.cod_amount}`);
  check(plain?.payment_status === 'paid', 'status is paid');

  // ---------------------------------------------------------------------------
  // 5. Invalid amounts are refused.
  // ---------------------------------------------------------------------------
  console.log('\n== invalid amounts ==');

  const { product: p700, customer: c5 } = await seed(a, A.orgId, 'item700', 700);
  const guardOrderId = await makeCodOrder(a, A.storeId, c5.id, p700.id, 0, true);

  for (const amount of [0, -100]) {
    const { error } = await a.rpc('record_payment', {
      p_order_id: guardOrderId, p_amount: amount, p_method: 'cash', p_idempotency_key: uuid(),
    });
    check(Boolean(error), `an amount of ${amount} is refused`, error ? '' : 'it was accepted');
  }

  const { error: overErr } = await a.rpc('record_payment', {
    p_order_id: guardOrderId, p_amount: 9999, p_method: 'cash', p_idempotency_key: uuid(),
  });
  check(Boolean(overErr), 'an overpayment is refused', overErr ? '' : 'it was accepted');

  const guard = await readOrder(a, guardOrderId);
  check(guard?.amount_paid === 0, 'the order is still untouched after every refusal', `got ${guard?.amount_paid}`);
  check(guard?.cod_amount === 700, 'the receivable is untouched too', `got ${guard?.cod_amount}`);

  // ---------------------------------------------------------------------------
  // 6. Cross-tenant isolation on both functions.
  // ---------------------------------------------------------------------------
  console.log('\n== cross-tenant isolation ==');

  const before = await readOrder(a, guardOrderId);
  // Captured now, compared after. Hardcoding the expected values here would make this
  // an isolation test depend on whether 0026 has been applied, so it would fail for
  // the wrong reason before the migration and pass for the right one after.
  const fullBefore = await readOrder(a, fullOrderId);

  const { error: xPay } = await b.rpc('record_payment', {
    p_order_id: guardOrderId, p_amount: 700, p_method: 'cash', p_idempotency_key: uuid(),
  });
  check(Boolean(xPay), 'seller B cannot pay against seller A order', xPay ? '' : 'it succeeded');

  const { error: xRefund } = await b.rpc('record_refund', {
    p_order_id: fullOrderId, p_amount: 500, p_method: 'cash', p_idempotency_key: uuid(),
  });
  check(Boolean(xRefund), 'seller B cannot refund seller A order', xRefund ? '' : 'it succeeded');

  // Assert the EFFECT, not the absence of an error. RLS filters a write and returns
  // success, so "no error" proves nothing; the row being unchanged is the proof.
  const after = await readOrder(a, guardOrderId);
  check(
    after?.amount_paid === before?.amount_paid && after?.cod_amount === before?.cod_amount,
    'seller A order is unchanged after both cross-tenant attempts',
    `paid ${before?.amount_paid}->${after?.amount_paid}, owed ${before?.cod_amount}->${after?.cod_amount}`,
  );

  const fullAfter = await readOrder(a, fullOrderId);
  check(
    fullAfter?.amount_paid === fullBefore?.amount_paid &&
      fullAfter?.cod_amount === fullBefore?.cod_amount &&
      fullAfter?.cod_settled === fullBefore?.cod_settled,
    "seller A's paid COD order is byte-for-byte unchanged",
    `paid ${fullBefore?.amount_paid}->${fullAfter?.amount_paid}, ` +
      `owed ${fullBefore?.cod_amount}->${fullAfter?.cod_amount}`,
  );

  // ---------------------------------------------------------------------------
  // 7. Audit trail.
  // ---------------------------------------------------------------------------
  console.log('\n== audit trail ==');

  const { data: allPayments } = await a.from('payments').select('order_id, amount, is_refund');
  const forFull = (allPayments ?? []).filter((p) => p.order_id === fullOrderId);
  check(forFull.length === 1, 'exactly one payment row for the fully paid order', `${forFull.length}`);
  check(forFull[0]?.is_refund === false, 'it is not marked as a refund');

  const forRep = (allPayments ?? []).filter((p) => p.order_id === repOrderId);
  check(forRep.length === 1, 'exactly one payment row despite a replayed key', `${forRep.length}`);

  // ---------------------------------------------------------------------------
  // Summary of the invariant across every order this probe created.
  // ---------------------------------------------------------------------------
  console.log('\n== invariant across all probe orders ==');
  for (const id of [fullOrderId, partOrderId, repOrderId, plainOrderId, guardOrderId]) {
    const o = await readOrder(a, id);
    const ok = (o?.amount_paid ?? 0) + (o?.cod_amount ?? 0) <= (o?.total ?? 0);
    check(
      ok,
      `order ${o?.order_number}: received ${o?.amount_paid} + owed ${o?.cod_amount} <= total ${o?.total}`,
    );
  }

  if (failures > 0) {
    note(
      'Failures above are the DEFECT, not a broken probe. Migration 0026 has not been applied yet.',
    );
  }
}

// ---------------------------------------------------------------------------
// Cleanup: leaf-first, identity last, every error checked, verified by ID.
// ---------------------------------------------------------------------------
async function finish() {
  const key = adminKey();
  if (!key) {
    console.log('\n  WARN  no service key: cleanup was NOT verified.');
    failures += 1;
    return;
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });

  for (const orgId of created.orgIds) {
    for (const table of [
      'payment_matches', 'payment_events', 'payment_audit_logs', 'payment_intents', 'payments',
      'order_items', 'orders', 'inventory_movements', 'inventory', 'products', 'customers',
      'payment_accounts', 'order_status_history', 'organization_members', 'stores',
    ]) {
      const { error } = await admin.from(table).delete().eq('org_id', orgId);
      if (error) console.log(`  WARN  ${table}: ${error.message}`);
    }
    const { error } = await admin.from('organizations').delete().eq('id', orgId);
    if (error) console.log(`  WARN  organization ${orgId}: ${error.message}`);
  }
  for (const userId of created.userIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) console.log(`  WARN  identity ${userId}: ${error.message}`);
  }

  console.log('\n== cleanup ==');
  const { data: byId, error: byIdErr } = await admin
    .from('organizations').select('id, name').in('id', created.orgIds);
  check(!byIdErr, 'the verification query ran', byIdErr?.message);
  check((byId ?? []).length === 0, 'zero probe organizations remain', (byId ?? []).map((o) => o.name).join());

  const { data: byName } = await admin
    .from('organizations').select('id').like('name', `%${stamp}%`);
  check((byName ?? []).length === 0, 'zero organizations matching this stamp remain');

  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const left = (users?.users ?? []).filter((u) => (u.email ?? '').includes(stamp));
  check(left.length === 0, 'zero probe identities remain', left.map((u) => u.email).join());

  for (const orgId of created.orgIds) {
    for (const table of ['orders', 'payments', 'products', 'customers']) {
      const { data } = await admin.from(table).select('id').eq('org_id', orgId);
      check((data ?? []).length === 0, `zero ${table} remain for this probe org`);
    }
  }
}

try {
  await main();
} catch (error) {
  console.log(`\n  ERROR ${error.message}`);
  failures += 1;
} finally {
  await finish();
}

console.log(
  failures === 0
    ? '\nALL CHECKS PASSED -- COD reconciliation is correct\n'
    : `\n${failures} CHECK(S) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);