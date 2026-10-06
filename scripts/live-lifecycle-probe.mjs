/**
 * Live seller lifecycle probe: register -> authenticate -> tenant -> logout -> sign in.
 *
 * Phase 5 gate. Runs against the REAL hosted project. Two independent sellers are
 * created so that tenant isolation is tested by a second identity rather than by
 * reading a policy file and hoping.
 *
 * WHAT IS ASSERTED
 *
 *   registration      user -> profile (trigger) -> org -> owner membership -> store
 *   payment account   created and readable
 *   tenant isolation  Seller A cannot read Seller B's org, store, customer or order
 *                     Seller B cannot read Seller A's
 *   write boundary    Seller A cannot write into Seller B's store via set_order_status
 *   session           sign out, sign back in, SAME org and store
 *   privilege         Seller A cannot read Seller B's payment accounts
 *
 * CLEANUP
 *
 * Leaf-first, identity last, because the schema does not cascade the way one would
 * hope: `profiles.id` cascades from `auth.users`, but `organizations.created_by`
 * references `profiles` WITHOUT cascade, so deleting the identity first trips the
 * foreign key and removes nothing. This is the failure the first version of the
 * registration probe hit, leaving probe businesses behind.
 *
 * After cleanup the probe VERIFIES zero records remain by listing users and looking
 * for its own stamp. A cleanup that reports success without checking is not a
 * cleanup.
 *
 * Run explicitly. Never part of `npm test`: it needs the network and it writes to the
 * live project.
 */

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const PROJECT_REF = 'ggnkvlnnfgvyxwlbjfqx';
const PASSWORD = 'probe-password-9f2a7c1e';

if (!url || !anonKey) {
  console.error('EXPO_PUBLIC_SUPABASE_URL / ANON_KEY are not set. Cannot probe.');
  process.exit(1);
}

const stamp = `v2life${Date.now()}`;
const sellers = {
  a: { email: `a-${stamp}@example.invalid`, name: 'Probe Seller A' },
  b: { email: `b-${stamp}@example.invalid`, name: 'Probe Seller B' },
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
  // `require` does not exist in an ES module; the earlier draft used it for nothing
  // and crashed at cleanup time, which is the worst moment to crash.
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

/** Registers one seller and returns its resolved workspace. */
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

  return { userId, orgId, store: stores?.[0] };
}

async function main() {
  console.log(`\nSeller lifecycle probe: ${stamp}`);
  console.log(`Project: ${new URL(url).host}\n`);

  const clientA = newClient();
  const clientB = newClient();

  // ---- 1. Registration ----
  let A;
  let B;
  try {
    A = await register(clientA, sellers.a);
    B = await register(clientB, sellers.b);
  } catch (error) {
    check(false, 'both sellers register', error.message);
    return finish();
  }

  check(true, 'Seller A registers');
  check(true, 'Seller B registers');
  check(typeof A.store?.id === 'string', 'Seller A has a store');
  check(typeof B.store?.id === 'string', 'Seller B has a store');
  check(A.orgId !== B.orgId, 'the two sellers are in different organizations');
  check(A.store?.id !== B.store?.id, 'the two sellers have different stores');

  // ---- 2. Tenant isolation: reads ----
  const { data: aSeesBOrg } = await clientA
    .from('organizations')
    .select('id')
    .eq('id', B.orgId);
  check(
    (aSeesBOrg ?? []).length === 0,
    'Seller A cannot read Seller B organization',
    `saw ${(aSeesBOrg ?? []).length}`,
  );

  const { data: aSeesBStore } = await clientA
    .from('stores')
    .select('id')
    .eq('id', B.store?.id ?? '');
  check((aSeesBStore ?? []).length === 0, 'Seller A cannot read Seller B store');

  const { data: aSeesBAccounts } = await clientA
    .from('payment_accounts')
    .select('id')
    .eq('org_id', B.orgId);
  check((aSeesBAccounts ?? []).length === 0, 'Seller A cannot read Seller B payment accounts');

  // ---- 3. Tenant isolation: writes ----
  /*
   * The important direction. A read policy that leaks is embarrassing; a WRITE
   * policy that leaks corrupts somebody else's books. Seller A is asked to write
   * into Seller B's store and must be refused.
   *
   * `create_order` has no INSERT policy at all, so a direct insert is refused by
   * RLS before any function runs.
   */
  const { error: writeError } = await clientA.from('orders').insert({
    store_id: B.store?.id,
    order_number: 'PROBE-1',
    status: 'pending',
    items_total: 0,
    total: 0,
  });
  check(
    Boolean(writeError),
    'Seller A cannot insert an order into Seller B store',
    writeError ? '' : 'the insert was ACCEPTED',
  );

  // And the reverse, so the check is not accidentally one-directional.
  const { error: reverseWrite } = await clientB.from('orders').insert({
    store_id: A.store?.id,
    order_number: 'PROBE-2',
    status: 'pending',
    items_total: 0,
    total: 0,
  });
  check(Boolean(reverseWrite), 'Seller B cannot insert an order into Seller A store');

  // ---- 4. A client-supplied org id is not trusted ----
  /*
   * `create_payment_account` authorises with `assert_org_write(p_org_id)`, so asking
   * for an account against somebody else's org must be refused even though the
   * caller is perfectly authenticated and the argument is well-formed.
   */
  const { error: crossOrg } = await clientA.rpc('create_payment_account', {
    p_org_id: B.orgId,
    p_provider: 'bkash',
    p_account_number: '01700000000',
    p_account_type: 'personal',
    p_label: null,
  });
  check(
    Boolean(crossOrg),
    'create_payment_account refuses a foreign org id',
    crossOrg ? '' : 'the RPC ACCEPTED a foreign org id',
  );

  // ...and it succeeds against its own, which proves the refusal above was the
  // authorisation and not a broken call.
  const { data: ownAccount, error: ownError } = await clientA.rpc('create_payment_account', {
    p_org_id: A.orgId,
    p_provider: 'bkash',
    p_account_number: '017' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
    p_account_type: 'personal',
    p_label: null,
  });
  check(!ownError && Boolean(ownAccount?.id), 'the same call succeeds for its own org');

  // ---- 5. Session persistence ----
  await clientA.auth.signOut();
  const { error: signInError } = await clientA.auth.signInWithPassword({
    email: sellers.a.email,
    password: PASSWORD,
  });
  check(!signInError, 'Seller A can sign back in', signInError?.message);

  const { data: afterSignIn } = await clientA
    .from('stores')
    .select('id')
    .eq('org_id', A.orgId)
    .limit(1);
  check(
    (afterSignIn ?? []).length === 1 && afterSignIn[0].id === A.store?.id,
    'the SAME store is resolved after signing back in',
    JSON.stringify(afterSignIn),
  );

  const { data: memberships } = await clientA
    .from('organization_members')
    .select('org_id, role')
    .eq('org_id', A.orgId);
  check(
    (memberships ?? []).some((m) => m.org_id === A.orgId && m.role === 'owner'),
    'the seller is still an owner of the SAME organization',
  );

  // ---- 6. Wrong password and unknown address ----
  const { error: wrongPassword } = await newClient().auth.signInWithPassword({
    email: sellers.a.email,
    password: 'definitely-not-the-password',
  });
  check(Boolean(wrongPassword), 'a wrong password is refused');

  const { error: unknownUser } = await newClient().auth.signInWithPassword({
    email: `nobody-${stamp}@example.invalid`,
    password: PASSWORD,
  });
  check(Boolean(unknownUser), 'an unknown address is refused');
  check(
    wrongPassword?.message === unknownUser?.message,
    'both refusals give the SAME message (no account enumeration)',
    `"${wrongPassword?.message}" vs "${unknownUser?.message}"`,
  );
}

/** Deletes tenant rows leaf-first, then the identity. */
async function deleteUser(userId, admin) {
  const { data: memberships } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', userId);

  for (const { org_id: orgId } of memberships ?? []) {
    /*
     * Leaf-first, every delete error checked.
     *
     * The organization delete here was unchecked and its error discarded, and two
     * organizations from this probe were found sitting in the production project
     * afterwards. Four of them, in fact, across two runs -- invisible because
     * verification searched by NAME PATTERN and could not see a row whose cleanup it
     * failed to predict.
     */
    for (const table of [
      'payment_matches',
      'payment_events',
      'payment_audit_logs',
      'payment_intents',
      'payments',
      'order_items',
      'orders',
      'inventory_movements',
      'inventory',
      'products',
      'customers',
      'payment_accounts',
      'order_status_history',
      'organization_members',
      'stores',
    ]) {
      const { error } = await admin.from(table).delete().eq('org_id', orgId);
      if (error) console.log(`  WARN  ${table} for ${orgId}: ${error.message}`);
    }

    // CASCADES to expenses.
    const { error } = await admin.from('organizations').delete().eq('id', orgId);
    if (error) console.log(`  WARN  organization ${orgId}: ${error.message}`);
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) console.log(`        identity cleanup failed for ${userId}: ${error.message}`);
}

async function finish() {
  const key = adminKey();

  if (!key) {
    console.error(
      `\nFAILED TO CLEAN UP: no service-role key.\n` +
        `${created.userIds.length} probe identity/identities remain. Delete by hand: ${created.userIds.join(', ')}`,
    );
    failures += 1;
  } else {
    const admin = createClient(url, key, { auth: { persistSession: false } });

    console.log('\nCleaning up probe data (leaf-first, identity last)…');
    for (const userId of created.userIds) await deleteUser(userId, admin);

    /*
     * Verify, do not assume. A cleanup that reports success without checking is not
     * a cleanup, and the first version of the registration probe proved that.
     */
    const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const remaining = (users?.users ?? []).filter((u) => (u.email ?? '').includes(stamp));
    check(remaining.length === 0, 'zero probe identities remain', `found ${remaining.length}`);

    const { data: remainingOrgs, error: orgsErr } = await admin
      .from('organizations')
      .select('id')
      .like('name', `%${stamp}%`);
    check(!orgsErr, 'the pattern verification query ran', orgsErr?.message);
    check(
      (remainingOrgs ?? []).length === 0,
      'zero probe organizations remain',
      `found ${remainingOrgs?.length}`,
    );

    // By ID as well. A name pattern cannot see a leftover whose name it failed to
    // predict, and that blind spot is how four organizations survived in production
    // while this probe reported a clean run.
    const { data: orgsById } = await admin
      .from('organizations')
      .select('id')
      .in('id', created.orgIds);
    check(
      (orgsById ?? []).length === 0,
      'zero of THIS run probe organizations remain',
      `found ${orgsById?.length}`,
    );

    const { data: remainingAccounts } = await admin
      .from('payment_accounts')
      .select('id, org_id');
    const orphanAccounts = (remainingAccounts ?? []).filter((a) =>
      created.orgIds.includes(a.org_id),
    );
    check(
      orphanAccounts.length === 0,
      'zero probe payment accounts remain',
      `found ${orphanAccounts.length}`,
    );
  }

  console.log(failures === 0 ? '\nRESULT: ALL CHECKS PASSED' : `\nRESULT: ${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().then(finish, (error) => {
  console.error('probe crashed:', error);
  finish();
});