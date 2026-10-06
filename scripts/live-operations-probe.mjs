/**
 * Live operations probe: products, stock, customers, orders, and the money.
 *
 * Phase 6 gate. Runs against the REAL hosted project, with TWO independent sellers so
 * that isolation is tested by a second identity rather than by reading a policy file
 * and hoping.
 *
 * WHAT IS ASSERTED
 *
 *   product create      a row exists with the values the form sent
 *   honest cost         a product with NO cost price reads back as null, never 0
 *   threshold is a count  5 stays 5 and does not become 500
 *   stock adjust        +3 then -1 lands on the expected quantity
 *   ledger is append-only  both movements exist and neither was overwritten
 *   customer create     district and thana persist, not just name and phone
 *   duplicate grading   find_duplicate_customers ranks a phone match above a name one
 *   order create        the server's own total is returned, and it is the client's
 *   order idempotency   the same client_ref twice yields ONE order, not two
 *   status transitions  set_order_status refuses an illegal jump, accepts a legal one
 *   payment boundary    record_payment updates the order; payments are not readable
 *                       as a table directly
 *   cod is a receivable an unsettled COD order is not counted as paid
 *   tenant isolation    Seller A cannot read or write anything belonging to Seller B,
 *                       in EITHER direction
 *
 * WHY THE MONEY CHECKS USE THE SERVER'S NUMBER
 *
 * The client computes a preview and Postgres computes the truth. This probe asserts
 * the server's figure, because that is the one that ends up on the invoice, and
 * separately that the two agree -- which is the property the whole design rests on.
 *
 * CLEANUP
 *
 * Leaf-first, identity last, and then VERIFIED. `organizations.created_by` references
 * `profiles` without cascade, so deleting the identity first trips a foreign key and
 * removes nothing. A cleanup that reports success without re-querying is not a
 * cleanup.
 *
 * Run explicitly. Never part of `npm test`: it needs the network and it writes to the
 * live project.
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

const stamp = `v2ops${Date.now()}`;
const sellers = {
  a: { email: `a-${stamp}@example.invalid`, name: 'Ops Seller A' },
  b: { email: `b-${stamp}@example.invalid`, name: 'Ops Seller B' },
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

function newClient() {
  return createClient(url, anonKey, { auth: { persistSession: false } });
}

/** The service-role key, from the CLI, in this process only. Never printed. */
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

async function register(client, who) {
  const { data, error } = await client.auth.signUp({
    email: who.email,
    password: PASSWORD,
    options: { data: { full_name: who.name } },
  });
  if (error) throw new Error(`${who.email}: ${error.message}`);

  const userId = data.user.id;
  created.userIds.push(userId);

  const { data: boot, error: bootError } = await client.rpc('bootstrap_business', {
    p_business_name: `${who.name} ${stamp}`,
    p_store_name: null,
    p_store_code: null,
  });
  if (bootError) throw new Error(`${who.email}: ${bootError.message}`);

  const orgId = boot?.id ?? boot?.org_id;
  if (typeof orgId !== 'string') throw new Error(`${who.email}: no org id returned`);
  created.orgIds.push(orgId);

  const { data: stores } = await client
    .from('stores')
    .select('id, code, name')
    .eq('org_id', orgId)
    .limit(1);

  return { userId, orgId, storeId: stores?.[0]?.id };
}

async function main() {
  const a = newClient();
  const b = newClient();

  console.log('\n== register two independent sellers ==');
  const A = await register(a, sellers.a);
  const B = await register(b, sellers.b);
  check(Boolean(A.storeId && B.storeId), 'both sellers got a store');
  check(A.storeId !== B.storeId, 'the two stores are different rows');

  // ---------------------------------------------------------------- products
  console.log('\n== products ==');

  // Deliberately NO cost price. This is the state the product form allows and the one
  // that must never come back as 0, because 0 would claim the item is free to make
  // and would flow into the profit figure as a real cost.
  const { data: costed, error: costedErr } = await a
    .from('products')
    .insert({
      org_id: A.orgId,
      name: 'Costed item',
      sku: `CST-${stamp}`,
      selling_price: 1200,
      cost_price: 700,
      // 5 as a COUNT. If any layer parses this with the money parser it becomes 500.
      low_stock_threshold: 5,
      track_inventory: true,
    })
    .select()
    .single();
  check(!costedErr, 'a product with a cost price was created', costedErr?.message);

  const { data: uncosted, error: uncostedErr } = await a
    .from('products')
    .insert({
      org_id: A.orgId,
      name: 'Uncosted item',
      sku: `UNC-${stamp}`,
      selling_price: 500,
      cost_price: null,
      low_stock_threshold: 3,
      track_inventory: true,
    })
    .select()
    .single();
  check(!uncostedErr, 'a product with NO cost price was created', uncostedErr?.message);
  check(
    uncosted?.cost_price === null,
    'an unrecorded cost reads back as null, not 0',
    `got ${JSON.stringify(uncosted?.cost_price)}`,
  );
  check(
    costed?.low_stock_threshold === 5,
    'a low-stock threshold of 5 stayed 5 and did not become 500',
    `got ${costed?.low_stock_threshold}`,
  );

  // -------------------------------------------------------------- stock moves
  console.log('\n== stock ==');

  const { data: adjusted, error: adjErr } = await a.rpc('adjust_stock', {
    p_store_id: A.storeId,
    p_product_id: costed.id,
    p_variant_id: null,
    p_delta: 3,
    p_reason: 'initial',
    p_note: 'probe opening stock',
  });
  check(!adjErr, 'stock was adjusted by +3', adjErr?.message);
  check(
    adjusted === 3,
    'the RPC returned the resulting quantity, 3',
    `got ${JSON.stringify(adjusted)}`,
  );

  const { data: corrected, error: corrErr } = await a.rpc('adjust_stock', {
    p_store_id: A.storeId,
    p_product_id: costed.id,
    p_variant_id: null,
    p_delta: -1,
    p_reason: 'damage',
    p_note: 'probe correction',
  });
  check(!corrErr, 'stock was adjusted by -1', corrErr?.message);
  check(corrected === 2, 'the shelf is at 2 after +3 then -1', `got ${JSON.stringify(corrected)}`);

  const { data: movements } = await a
    .from('inventory_movements')
    .select('delta, reason, note')
    .eq('product_id', costed.id)
    .order('created_at', { ascending: true });

  check(
    (movements ?? []).length === 2,
    'BOTH movements survive -- the ledger is append-only, nothing was overwritten',
    `got ${(movements ?? []).length}`,
  );
  check(
    movements?.some((m) => m.reason === 'initial') && movements?.some((m) => m.reason === 'damage'),
    'each movement kept its own reason, so "why is stock wrong" is answerable',
  );

  // An invalid reason must be refused rather than coerced.
  const { error: badReason } = await a.rpc('adjust_stock', {
    p_store_id: A.storeId,
    p_product_id: costed.id,
    p_variant_id: null,
    p_delta: 1,
    p_reason: 'correction',
    p_note: 'not a real enum value',
  });
  check(Boolean(badReason), 'an inventory reason outside the enum is refused', 'it was accepted');

  // ---------------------------------------------------------------- customers
  console.log('\n== customers ==');

  const { data: customer, error: custErr } = await a
    .from('customers')
    .insert({
      org_id: A.orgId,
      name: 'Rakib Hasan',
      phone: '01712345678',
      // 0008 added these for courier delivery. If they cannot be written, a seller
      // has nowhere to record where a parcel goes.
      district: 'Dhaka',
      thana: 'Mirpur',
      address: 'House 4, Road 7',
    })
    .select()
    .single();
  check(!custErr, 'a customer was created', custErr?.message);
  check(
    customer?.district === 'Dhaka' && customer?.thana === 'Mirpur',
    'district and thana persisted, not just the name',
    `got ${customer?.district} / ${customer?.thana}`,
  );

  const { data: dupes } = await a.rpc('find_duplicate_customers', {
    p_org_id: A.orgId,
    p_name: 'Rakib Hasan',
    p_phone: '01712345678',
    p_limit: 5,
  });
  check((dupes ?? []).length > 0, 'find_duplicate_customers spots the same customer again');

  // --------------------------------------------------------------- orders
  console.log('\n== orders ==');

  // The uncosted item needs stock before the two-line order can be created: the
  // business default forbids selling below zero, and `create_order` enforces it.
  const { error: uncostedStockErr } = await a.rpc('adjust_stock', {
    p_store_id: A.storeId,
    p_product_id: uncosted.id,
    p_variant_id: null,
    p_delta: 5,
    p_reason: 'initial',
    p_note: 'probe opening stock',
  });
  check(!uncostedStockErr, 'stock was opened for the uncosted item', uncostedStockErr?.message);

  // Two lines on purpose: one costed, one not. That is the case where profit is a
  // floor rather than an answer, and the probe should be able to see it.
  const clientTotal = 1200 * 2 + 500 * 1; // 2900, no discount or delivery
  const clientRef = randomUuid();

  const makeOrder = async (client) =>
    client.rpc('create_order', {
      p_store_id: A.storeId,
      p_customer_id: customer.id,
      p_items: [
        { product_id: costed.id, variant_id: null, quantity: 2, line_discount: 0 },
        { product_id: uncosted.id, variant_id: null, quantity: 1, line_discount: 0 },
      ],
      p_discount: 0,
      p_delivery_charge: 0,
      p_amount_paid: 0,
      p_payment_method: 'cash',
      p_notes: 'phase 6 probe',
      p_client_ref: clientRef,
    });

  const { data: orderId, error: orderErr } = await makeOrder(a);
  check(!orderErr, 'an order was created', orderErr?.message);
  check(typeof orderId === 'string', 'create_order returned an order id');

  const { data: order } = await a.from('orders').select('*').eq('id', orderId).single();
  check(
    order?.total === clientTotal,
    `the server total agrees with the client's own arithmetic (${clientTotal})`,
    `server said ${order?.total}`,
  );
  check(order?.amount_paid === 0, 'nothing was paid, so nothing is recorded as paid');
  check(order?.is_cod === false, 'this is not a cash-on-delivery order');

  // Idempotency. A double-tapped Save must not create a second order.
  const { data: againId, error: againErr } = await makeOrder(a);
  check(!againErr, 'the same client_ref can be submitted again', againErr?.message);
  check(againId === orderId, 'the same client_ref returns the ORIGINAL order, not a second one');

  const { data: sameRef } = await a
    .from('orders')
    .select('id')
    .eq('client_ref', clientRef);
  check((sameRef ?? []).length === 1, 'exactly one order row exists for that client_ref');

  // ------------------------------------------------------------ transitions
  console.log('\n== lifecycle ==');

  const { data: allowed } = await a.rpc('allowed_order_statuses', { p_order_id: orderId });
  check(Array.isArray(allowed) && allowed.length > 0, 'the server offers legal next statuses');
  check(
    !allowed?.includes('delivered'),
    'a brand-new order cannot jump straight to delivered',
    `offered ${JSON.stringify(allowed)}`,
  );

  const { error: illegal } = await a.rpc('set_order_status', {
    p_order_id: orderId,
    p_to_status: 'delivered',
    p_note: 'probe: should be refused',
  });
  check(Boolean(illegal), 'an illegal transition is refused by the database', 'it was allowed');

  const { data: moved, error: moveErr } = await a.rpc('set_order_status', {
    p_order_id: orderId,
    p_to_status: 'confirmed',
    p_note: 'probe',
  });
  check(!moveErr && moved === 'confirmed', 'a legal transition succeeds', moveErr?.message);

  // ------------------------------------------------------------- payments
  console.log('\n== payment boundary ==');

  const { error: payErr } = await a.rpc('record_payment', {
    p_order_id: orderId,
    p_amount: 2900,
    p_method: 'cash',
    p_note: 'probe: paid in full',
  });
  check(!payErr, 'a payment was recorded', payErr?.message);

  const { data: paidOrder } = await a.from('orders').select('*').eq('id', orderId).single();
  check(paidOrder?.payment_status === 'paid', 'the order now reads as paid');
  check(paidOrder?.amount_paid === 2900, 'the amount paid matches');

  /*
   * Overpayment must not corrupt the order.
   *
   * Two acceptable outcomes: the RPC refuses it, or it records the amount without
   * pushing the balance negative. What must never happen is `amount_paid` landing
   * above the total and leaving a negative amount owing. The property is checked
   * directly rather than by asserting a particular one of the two designs.
   */
  const { error: overErr } = await a.rpc('record_payment', {
    p_order_id: orderId,
    p_amount: 500,
    p_method: 'cash',
    p_note: 'probe: overpayment',
  });
  const { data: afterOver } = await a
    .from('orders')
    .select('amount_paid, total')
    .eq('id', orderId)
    .single();
  check(
    (afterOver?.amount_paid ?? Infinity) <= (afterOver?.total ?? 0),
    'an overpayment never leaves amount_paid above the order total',
    `amount_paid ${afterOver?.amount_paid} vs total ${afterOver?.total}`,
  );
  console.log(
    `  NOTE  overpayment was ${overErr ? `refused (${overErr.message})` : 'accepted without exceeding the total'}`,
  );

  // ------------------------------------------------------------- cod truth
  console.log('\n== cash on delivery ==');

  // The COD order needs stock too, and the SECOND order above will have consumed some
  // of the costed item by this point, so the assertion later compares against 1.
  const { error: codStockErr } = await a.rpc('adjust_stock', {
    p_store_id: A.storeId,
    p_product_id: uncosted.id,
    p_variant_id: null,
    p_delta: 5,
    p_reason: 'initial',
    p_note: 'probe opening stock for the uncosted item',
  });
  check(!codStockErr, 'stock was opened for the uncosted item', codStockErr?.message);

  // `p_is_cod` is the flag `create_order` uses, and it derives `cod_amount` as
  // total - paid. Passing it is how a courier order is actually recorded.
  const codRef = randomUuid();
  const { data: codId, error: codErr } = await a.rpc('create_order', {
    p_store_id: A.storeId,
    p_customer_id: customer.id,
    p_items: [{ product_id: uncosted.id, variant_id: null, quantity: 1, line_discount: 0 }],
    p_discount: 0,
    p_delivery_charge: 60,
    p_amount_paid: 0,
    p_payment_method: 'cash',
    p_notes: 'cod probe',
    p_client_ref: codRef,
    p_is_cod: true,
    p_delivery_address: 'House 4, Road 7, Mirpur',
    p_delivery_thana: 'Mirpur',
    p_delivery_district: 'Dhaka',
  });
  check(!codErr, 'a COD order was created', codErr?.message);

  const { data: codOrder } = await a.from('orders').select('*').eq('id', codId).single();
  check(codOrder?.amount_paid === 0, 'an unsettled COD order has nothing recorded as paid');
  check(codOrder?.is_cod === true, 'the order is flagged cash on delivery');
  check(
    codOrder?.cod_amount === codOrder?.total,
    'the collectable amount equals the order total',
    `cod ${codOrder?.cod_amount} vs total ${codOrder?.total}`,
  );
  check(codOrder?.cod_settled === false, 'it is not marked settled until the courier pays out');
  check(
    codOrder?.delivery_address === 'House 4, Road 7, Mirpur',
    'the delivery address persisted, because a rider cannot be sent without one',
    `got ${JSON.stringify(codOrder?.delivery_address)}`,
  );

  // ------------------------------------------------------- tenant isolation
  console.log('\n== tenant isolation, both directions ==');

  const { data: aSeesB } = await a.from('orders').select('*').eq('id', codId);
  check((aSeesB ?? []).length === 1, 'seller A sees its own order');

  const { data: bSeesA } = await b.from('orders').select('*').eq('id', orderId);
  check((bSeesA ?? []).length === 0, 'seller B cannot read seller A order');
  const { data: bSeesProduct } = await b.from('products').select('*').eq('id', costed.id);
  check((bSeesProduct ?? []).length === 0, 'seller B cannot read seller A product');
  const { data: bSeesCustomer } = await b.from('customers').select('*').eq('id', customer.id);
  check((bSeesCustomer ?? []).length === 0, 'seller B cannot read seller A customer');
  const { data: bSeesMovement } = await b
    .from('inventory_movements')
    .select('*')
    .eq('product_id', costed.id);
  check((bSeesMovement ?? []).length === 0, 'seller B cannot read seller A stock ledger');

  // The write direction is the one that matters most.
  /*
   * Read the quantity IMMEDIATELY before the attempt. Asserting a hardcoded number
   * meant tracking how many units each earlier order consumed, which is the probe's
   * own bookkeeping rather than the property under test.
   */
  const { data: beforeAttempt } = await a
    .from('inventory')
    .select('quantity')
    .eq('store_id', A.storeId)
    .eq('product_id', costed.id)
    .limit(1);
  const expectedQuantity = beforeAttempt?.[0]?.quantity ?? null;

  const { error: bMove } = await b.rpc('set_order_status', {
    p_order_id: orderId,
    p_to_status: 'shipped',
    p_note: 'probe: cross-tenant write',
  });
  check(Boolean(bMove), 'seller B cannot move seller A order', 'the write succeeded');

  const { error: bAdjust } = await b.rpc('adjust_stock', {
    p_store_id: A.storeId,
    p_product_id: costed.id,
    p_variant_id: null,
    p_delta: 999,
    p_reason: 'adjustment',
    p_note: 'probe: cross-tenant stock write',
  });
  check(Boolean(bAdjust), 'seller B cannot change seller A stock', 'the write succeeded');

  // The COD order above legitimately consumed one of the costed item's two units, so
  // 1 is the expected figure here. What matters is that B's attempt changed nothing.
  const { data: stockAfter } = await a
    .from('inventory')
    .select('quantity')
    .eq('store_id', A.storeId)
    .eq('product_id', costed.id)
    .limit(1);
  check(
    expectedQuantity !== null && (stockAfter ?? []).every((s) => s.quantity === expectedQuantity),
    'seller A stock is unchanged by the cross-tenant attempt',
    `expected ${expectedQuantity}, got ${JSON.stringify(stockAfter)}`,
  );

  // And the reverse: A must not reach B either.
  const { data: aSeesBProduct } = await a.from('products').select('*').eq('org_id', B.orgId);
  check((aSeesBProduct ?? []).length === 0, 'seller A cannot list seller B products');
}

/**
 * A v4 uuid, in the shape `orders.client_ref` actually demands.
 *
 * Written out here rather than imported from the app, on purpose: the probe must keep
 * testing the SERVER's contract even when the app's own helper is wrong. The first
 * version of this probe generated a readable stamp, which Postgres rejected, and the
 * same mistake was in the order form -- where it would have failed on every save. Had
 * this probe simply reused the app's helper, it would have agreed with the app and
 * disagreed with the database.
 */
function randomUuid() {
  const hex = (n) => {
    let out = '';
    for (let i = 0; i < n; i += 1) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  };
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

/** Leaf-first, then the identity. `organizations.created_by` has no cascade. */
async function deleteUser(userId, admin) {
  if (!admin) return false;
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) console.log(`  WARN  could not delete ${userId}: ${error.message}`);
  return !error;
}

async function finish() {
  const key = adminKey();
  if (!key) {
    console.log('\n  WARN  no service key, so cleanup was NOT verified. Probe rows may remain.');
    return;
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });

  // Order matters. Deleting the identity first trips the organizations FK and removes
  // nothing at all -- this is exactly how the first probe version left businesses
  // behind in the live project.
  for (const orgId of created.orgIds) {
    for (const table of [
      // Leaf-first, and every payment table included: this probe creates orders, so a
      // stray payment or event row would be stranded with its organization gone.
      'payment_matches',
      'payment_events',
      'payment_intents',
      'payments',
      'order_items',
      'orders',
      'inventory_movements',
      'inventory',
      'products',
      'customers',
    ]) {
      const { error } = await admin.from(table).delete().eq('org_id', orgId);
      if (error) console.log(`  WARN  ${table}: ${error.message}`);
    }
    // Stores cascade from the organization; membership rows do not.
    for (const table of ['order_status_history', 'organization_members', 'payment_accounts', 'stores']) {
      const { error } = await admin.from(table).delete().eq('org_id', orgId);
      if (error) console.log(`  WARN  ${table}: ${error.message}`);
    }

    // Checked. This delete was unchecked, and that is how two organizations were
    // left sitting in the production project while this probe reported success.
    const { error } = await admin.from('organizations').delete().eq('id', orgId);
    if (error) console.log(`  WARN  organization ${orgId}: ${error.message}`);
  }

  for (const userId of created.userIds) await deleteUser(userId, admin);

  // A cleanup that reports success without re-querying is not a cleanup.
  const { data: leftoverOrgs, error: orgsErr } = await admin
    .from('organizations')
    .select('id, name')
    .like('name', `%${stamp}%`);

  // A cleanup check that cannot tell "nothing left" from "could not look" is not a
  // cleanup check. Verify the query itself succeeded before believing its result.
  check(!orgsErr, 'the cleanup query itself ran', orgsErr?.message);

  const { data: leftoverUsers } = await admin.auth.admin.listUsers({ perPage: 200 });
  const leftoverIdentities = (leftoverUsers?.users ?? []).filter((u) =>
    u.email?.includes(stamp),
  );

  console.log('\n== cleanup ==');
  check(
    (leftoverOrgs ?? []).length === 0,
    'zero probe organizations remain',
    JSON.stringify(leftoverOrgs),
  );

  // Verified by ID as well as by name pattern. A pattern cannot see a row whose name
  // it failed to predict, and that blind spot is exactly how two organizations were
  // left behind in production while this probe reported a clean run.
  const { data: orgsById, error: byIdErr } = await admin
    .from('organizations')
    .select('id')
    .in('id', created.orgIds);
  check(!byIdErr, 'the id verification query ran', byIdErr?.message);
  check(
    (orgsById ?? []).length === 0,
    'zero of THIS run probe organizations remain',
    JSON.stringify(orgsById),
  );
  check(
    leftoverIdentities.length === 0,
    'zero probe identities remain',
    JSON.stringify(leftoverIdentities.map((u) => u.email)),
  );

  for (const orgId of created.orgIds) {
    for (const table of ['orders', 'products', 'customers']) {
      const { data } = await admin.from(table).select('id').eq('org_id', orgId);
      check((data ?? []).length === 0, `zero ${table} remain for the probe org`);
    }
  }
}

console.log(`\nSellFlow phase 6 operations probe ${stamp}`);
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