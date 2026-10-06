/**
 * Verifies migration 0025: the function exists, executes, is correctly gated, and
 * reports the truth about unrecorded costs.
 *
 * Four claims, because they fail independently:
 *
 *   exists     PostgREST can see it at all. A function that compiled but was not
 *              exposed looks exactly like a typo from the client.
 *   executes   It returns the documented keys for a store the caller OWNS.
 *   truthful   An order containing a product with no recorded cost price makes
 *              `profit_is_partial` true. This is the entire point of the migration:
 *              `get_dashboard` sums `coalesce(unit_cost, 0)`, so a missing cost is
 *              silently counted as zero and the profit figure is too high. If this
 *              flag does not flip, the migration has achieved nothing.
 *   gated      anon refused; authenticated allowed for its own store; refused for
 *              another; and refused even for the SERVICE ROLE, because
 *              `assert_store_access` authorises on membership rather than on
 *              privilege. There is no privileged bypass path into this function, which
 *              is the property worth having on a security definer function.
 *
 * The refusals are indistinguishable from "store not found" by design (migration 0004
 * comments that deliberately: naming an existing store would leak its existence).
 * So the test asserts the refusal, not the wording.
 *
 * Creates one throwaway seller and one order, both removed afterwards.
 *
 * Run with: node --env-file=.env scripts/verify-0025.mjs
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

const stamp = `v2m25${Date.now()}`;
const today = new Date().toISOString().slice(0, 10);

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

const service = createClient(url, adminKey(), { auth: { persistSession: false } });
const seller = createClient(url, anonKey, { auth: { persistSession: false } });

const created = { userId: null, orgId: null };

// -------------------------------------------------- a seller with an order
console.log('\n== set up a seller with a real order ==');

const { data: signUp, error: signUpErr } = await seller.auth.signUp({
  email: `${stamp}@example.invalid`,
  password: PASSWORD,
  options: { data: { full_name: 'Migration 0025 Probe' } },
});
check(!signUpErr, 'registered a throwaway seller', signUpErr?.message);
created.userId = signUp?.user?.id;

const { data: boot, error: bootErr } = await seller.rpc('bootstrap_business', {
  p_business_name: `Migration 0025 Probe ${stamp}`,
  p_store_name: null,
  p_store_code: null,
});
check(!bootErr, 'bootstrapped its business', bootErr?.message);
created.orgId = boot?.id ?? boot?.org_id;

const { data: ownStores } = await seller.from('stores').select('id').eq('org_id', created.orgId).limit(1);
const ownStoreId = ownStores?.[0]?.id;
check(Boolean(ownStoreId), 'it has a store');

// Two products, differing only in whether the cost was recorded.
const { data: uncosted } = await seller
  .from('products')
  .insert({
    org_id: created.orgId,
    name: 'No cost recorded',
    sku: `M25A-${stamp}`,
    selling_price: 500,
    cost_price: null,
    low_stock_threshold: 1,
    track_inventory: false,
  })
  .select()
  .single();

const { data: costed } = await seller
  .from('products')
  .insert({
    org_id: created.orgId,
    name: 'Cost recorded',
    sku: `M25B-${stamp}`,
    selling_price: 500,
    cost_price: 300,
    low_stock_threshold: 1,
    track_inventory: false,
  })
  .select()
  .single();

check(Boolean(uncosted && costed), 'seeded one costed and one uncosted product');

/*
 * `orders.client_ref` is a uuid column.
 *
 * Worth recording that the first version of this script generated a readable stamp
 * here and hit `invalid input syntax for type uuid` -- the identical mistake the order
 * form was making before it was fixed. The lesson from that bug applies to probes too:
 * generate the server's real type independently rather than assuming, because an
 * assumption shared between probe and app fails identically in both and proves nothing.
 */
const clientRef = () => {
  const hex = (k) => {
    let out = '';
    for (let i = 0; i < k; i += 1) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  };
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
};

const { data: cleanOrderId, error: cleanErr } = await seller.rpc('create_order', {
  p_store_id: ownStoreId,
  p_customer_id: null,
  p_items: [{ product_id: costed.id, variant_id: null, quantity: 1, line_discount: 0 }],
  p_discount: 0,
  p_delivery_charge: 0,
  p_amount_paid: 500,
  p_payment_method: 'cash',
  p_notes: 'migration 0025 probe, fully costed',
  p_client_ref: clientRef(),
});
check(!cleanErr, 'created an order using only the COSTED product', cleanErr?.message);

const { data: dirtyOrderId, error: dirtyErr } = await seller.rpc('create_order', {
  p_store_id: ownStoreId,
  p_customer_id: null,
  p_items: [{ product_id: uncosted.id, variant_id: null, quantity: 1, line_discount: 0 }],
  p_discount: 0,
  p_delivery_charge: 0,
  p_amount_paid: 500,
  p_payment_method: 'cash',
  p_notes: 'migration 0025 probe, uncosted product',
  p_client_ref: clientRef(),
});
check(!dirtyErr, 'created an order using the UNCOSTED product', dirtyErr?.message);

// ------------------------------------------------------------- executes
console.log('\n== exists and executes ==');

const { data: payload, error: callErr } = await seller.rpc('get_profit_completeness', {
  p_store_id: ownStoreId,
  p_today: today,
});
check(!callErr, 'get_profit_completeness executes', callErr?.message);
check(Boolean(payload), 'it returned a payload');

const WINDOWS = ['today', 'week', 'month', 'costs'];
if (payload) {
  const present = WINDOWS.filter((w) => payload[w] !== undefined);
  check(
    present.length === WINDOWS.length,
    'all four documented windows are present',
    `only ${present.join(', ')}`,
  );
  for (const w of present) {
    check(
      typeof payload[w]?.profit_is_partial === 'boolean',
      `${w}.profit_is_partial is a real boolean`,
      `got ${JSON.stringify(payload[w]?.profit_is_partial)}`,
    );
  }
}

// ------------------------------------------------------------- truthful
console.log('\n== it tells the truth about unrecorded costs ==');

if (payload) {
  /*
   * The order using the uncosted product exists, so every window covering today must
   * report partial. `get_dashboard` will show profit for that order as if the cost
   * were zero, which is the whole defect this migration exists to expose.
   */
  check(
    payload.today?.profit_is_partial === true,
    "today is PARTIAL because an order today sold a product with no cost price",
    `got ${JSON.stringify(payload.today?.profit_is_partial)}`,
  );
  check(
    payload.costs?.profit_is_partial === true,
    'the 30-day cost block is partial too',
    `got ${JSON.stringify(payload.costs?.profit_is_partial)}`,
  );
  check(
    payload.today?.unknown_lines >= 1,
    'it counts how many lines are unrecorded, not just that some are',
    `got ${JSON.stringify(payload.today?.unknown_lines)}`,
  );
}

// A business with no orders at all must report complete, not unknown. "Not recorded"
// is for missing data; a seller who has sold nothing has a complete, empty picture.
const second = createClient(url, anonKey, { auth: { persistSession: false } });
const { data: signUp2 } = await second.auth.signUp({
  email: `b-${stamp}@example.invalid`,
  password: PASSWORD,
  options: { data: { full_name: 'Migration 0025 Probe B' } },
});
const { data: boot2 } = await second.rpc('bootstrap_business', {
  p_business_name: `Migration 0025 Probe B ${stamp}`,
  p_store_name: null,
  p_store_code: null,
});
const org2 = boot2?.id ?? boot2?.org_id;
const { data: stores2 } = await second.from('stores').select('id').eq('org_id', org2).limit(1);
const { data: empty, error: emptyErr } = await second.rpc('get_profit_completeness', {
  p_store_id: stores2?.[0]?.id,
  p_today: today,
});
check(!emptyErr, 'a second seller reads its own completeness', emptyErr?.message);
check(
  empty?.today?.profit_is_partial === false,
  'a business that has sold NOTHING reports complete, not unknown',
  `got ${JSON.stringify(empty?.today?.profit_is_partial)}`,
);

// ------------------------------------------------------------------ gated
console.log('\n== grants and tenant isolation ==');

const anon = createClient(url, anonKey, { auth: { persistSession: false } });
const { error: anonErr } = await anon.rpc('get_profit_completeness', {
  p_store_id: ownStoreId,
  p_today: today,
});
check(Boolean(anonErr), 'anon is refused -- a security definer function is never world-callable');

const { error: crossErr } = await second.rpc('get_profit_completeness', {
  p_store_id: ownStoreId,
  p_today: today,
});
check(Boolean(crossErr), 'an authenticated seller is refused another tenant store');

const { error: svcErr } = await service.rpc('get_profit_completeness', {
  p_store_id: ownStoreId,
  p_today: today,
});
check(
  Boolean(svcErr),
  'the SERVICE ROLE is refused too: authorisation is by membership, not by privilege',
  'service_role reached a store it does not belong to',
);

/*
 * The dashboard this exists to qualify must still behave EXACTLY as it did.
 *
 * Note what the profit figure is: 700, not 500. The uncosted order's product has a NULL
 * `unit_cost`, and `get_dashboard` sums `coalesce(unit_cost, 0)`, so its full 500 of
 * revenue is counted as pure profit. The migration deliberately does not change that
 * number -- changing it would silently alter every historical profit figure -- and
 * `profit_is_partial` is the flag that tells the client not to believe it.
 *
 * Asserting profit === 500 here would have been the wrong test: it would have demanded
 * a behaviour change nobody asked for, and would have passed only if the migration had
 * overreached.
 */
const { data: dash, error: dashErr } = await seller.rpc('get_dashboard', {
  p_store_id: ownStoreId,
  p_today: today,
});
check(!dashErr, 'get_dashboard still executes after the migration', dashErr?.message);
check(
  dash?.today?.revenue === 1000,
  'get_dashboard revenue is unchanged: two 500 orders',
  `revenue=${dash?.today?.revenue}`,
);
check(
  dash?.today?.profit === 700,
  'get_dashboard profit is UNCHANGED at 700, counting the uncosted line as zero cost',
  `profit=${dash?.today?.profit}`,
);
check(
  dash?.today?.profit === 700 && payload?.today?.profit_is_partial === true,
  'so the optimistic figure is reported WITH the flag that marks it unreliable',
  `profit=${dash?.today?.profit} partial=${payload?.today?.profit_is_partial}`,
);

// --------------------------------------------------------------- cleanup
console.log('\n== cleanup ==');

for (const orgId of [created.orgId, org2].filter(Boolean)) {
  for (const table of ['order_items', 'orders', 'products', 'inventory', 'inventory_movements']) {
    await service.from(table).delete().eq('org_id', orgId);
  }
  await service.from('organization_members').delete().eq('org_id', orgId);
  await service.from('payment_accounts').delete().eq('org_id', orgId);
  await service.from('stores').delete().eq('org_id', orgId);
  await service.from('organizations').delete().eq('id', orgId);
}

for (const uid of [created.userId, signUp2?.user?.id].filter(Boolean)) {
  await service.auth.admin.deleteUser(uid);
}

const { data: leftoverOrgs } = await service
  .from('organizations')
  .select('id')
  .like('name', `%${stamp}%`);
check((leftoverOrgs ?? []).length === 0, 'zero probe organizations remain');

for (const table of ['orders', 'products', 'order_items']) {
  const { data } = await service.from(table).select('id').like('sku', `%${stamp}%`);
  check((data ?? []).length === 0, `zero probe ${table} remain`);
}

const { data: leftoverUsers } = await service.auth.admin.listUsers({ perPage: 1000 });
check(
  (leftoverUsers?.users ?? []).filter((u) => u.email?.includes(stamp)).length === 0,
  'zero probe identities remain',
);

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);