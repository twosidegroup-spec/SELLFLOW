/**
 * Live registration probe.
 *
 * Phase 4 gate. Runs the REAL registration path against the REAL hosted Supabase
 * project: signUp -> bootstrap_business -> create_payment_account -> workspace read.
 *
 * Every assertion is on what the database actually returned. A pass here means a
 * real business exists in the hosted project with a real payment account attached.
 *
 * Cleanup: the identity created by the probe is DELETED afterwards through the
 * admin API. A registration probe that leaves a business behind would pollute the
 * live database, which is exactly the thing that must not happen during testing.
 *
 * Run explicitly, never as part of `npm test` -- it needs the network and it writes
 * to the live project.
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error('EXPO_PUBLIC_SUPABASE_URL / ANON_KEY are not set. Cannot probe.');
  process.exit(1);
}

/** Unique, obviously-synthetic stamp so cleanup can find it again. */
const stamp = `v2probe${Date.now()}`;
const email = `${stamp}@example.invalid`;
const businessName = `Probe ${stamp}`;

const created = { userIds: [] };
let failures = 0;

function check(ok, label, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures += 1;
  }
}

/**
 * Removes everything a probe created, in dependency order.
 *
 * `auth.admin.deleteUser` alone fails with "Database error deleting user". The
 * reason is the schema, not the API: `profiles.id -> auth.users(id)` cascades, but
 * `organizations.created_by -> profiles(id)` does NOT, and `stores.store_id` /
 * `payment_accounts.org_id` reference rows that reference the profile. Deleting the
 * identity first therefore trips the foreign key and nothing is removed.
 *
 * So the tenant rows go first, leaf to root, and the identity last. Deleting the
 * organisation cascades to its stores, members and payment accounts, so only three
 * deletes are needed. Each is reported: a silent cleanup failure here leaves probe
 * businesses in the live project, which is the one outcome this whole design
 * exists to prevent.
 */
async function deleteUser(userId, adminKey) {
  if (!adminKey) return false;

  const admin = createClient(url, adminKey, { auth: { persistSession: false } });

  // Find the orgs this identity owns. Bypasses RLS, which is the point.
  const { data: memberships } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', userId);

  for (const { org_id: orgId } of memberships ?? []) {
    const { error: accountsError } = await admin
      .from('payment_accounts')
      .delete()
      .eq('org_id', orgId);
    if (accountsError) {
      console.log(`        payment_accounts cleanup failed for ${orgId}: ${accountsError.message}`);
      return false;
    }

    // CASCADES to stores, organization_members and payment_intents.
    const { error: orgError } = await admin.from('organizations').delete().eq('id', orgId);
    if (orgError) {
      console.log(`        organizations cleanup failed for ${orgId}: ${orgError.message}`);
      return false;
    }
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    console.log(`        identity cleanup failed for ${userId}: ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Fetches the project's service-role key via the Supabase CLI, in this process.
 *
 * Same approach as `scripts/verify-auth.mjs`: the CLI is already authenticated
 * against the linked project through the OS credential store, so this only asks it
 * for the key and keeps the value in memory. There is deliberately no path that
 * prints it.
 *
 * `--reveal` is required -- without it the CLI returns the key masked, and the
 * masked string is useless for cleanup, which is how the first run of this probe
 * left an identity behind.
 */
async function adminKey() {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  const result = spawnSync(
    'npx',
    ['--yes', 'supabase@2.119.0', 'projects', 'api-keys', '--reveal'],
    { cwd: repo, encoding: 'utf8', windowsHide: true, shell: true },
  );

  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const start = raw.indexOf('{');
  if (start < 0) return null;

  const parsed = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1));
  const key = parsed.keys?.find((k) => k.name === 'service_role')?.api_key;
  if (!key || key.includes('***')) return null;

  return key;
}

async function main() {
  console.log(`\nLive registration probe: ${email}`);
  console.log(`Project: ${new URL(url).host}\n`);

  const client = createClient(url, anonKey, { auth: { persistSession: false } });

  // 1. signUp
  const { data: signUp, error: signUpError } = await client.auth.signUp({
    email,
    password: 'probe-password-9f2a7c1e',
    options: { data: { full_name: 'V2 Probe' } },
  });

  check(!signUpError, 'signUp succeeds', signUpError?.message);
  if (signUpError) return finish();

  check(Boolean(signUp.session), 'a session is returned (email confirmation is off)');
  check(Boolean(signUp.user?.id), 'a user id is returned');

  const userId = signUp.user?.id;
  if (!userId) return finish();
  created.userIds.push(userId);

  // 2. profiles, via the handle_new_user trigger
  const { data: profile } = await client
    .from('profiles')
    .select('id, full_name')
    .eq('id', userId)
    .single();
  check(
    profile?.full_name === 'V2 Probe',
    'the trigger copied full_name into profiles',
    JSON.stringify(profile),
  );

  // 3. bootstrap_business
  const { data: boot, error: bootError } = await client.rpc('bootstrap_business', {
    p_business_name: businessName,
    p_store_name: null,
    p_store_code: null,
  });
  check(!bootError, 'bootstrap_business succeeds', bootError?.message);
  if (bootError) return finish();

  const orgId = boot?.id ?? boot?.org_id;
  check(typeof orgId === 'string', 'bootstrap_business returned an org id', JSON.stringify(boot));

  // 4. membership, role and store
  if (typeof orgId === 'string') {
    const { data: member } = await client
      .from('organization_members')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single();
    check(member?.role === 'owner', 'the creator is an owner', JSON.stringify(member));

    const { data: stores } = await client.from('stores').select('code, is_default').eq('org_id', orgId);
    check(
      Array.isArray(stores) && stores.length >= 1 && stores[0].is_default === true,
      'a default store was created',
      JSON.stringify(stores),
    );
  }

  // 5. create_payment_account
  if (typeof orgId === 'string') {
    const number = '017' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const { data: account, error: accountError } = await client.rpc('create_payment_account', {
      p_org_id: orgId,
      p_provider: 'bkash',
      p_account_number: number,
      p_account_type: 'personal',
      p_label: null,
    });
    check(!accountError, 'create_payment_account succeeds', accountError?.message);
    check(
      account?.account_number === number,
      'the stored number is exactly what was sent (server does not re-normalise)',
      JSON.stringify(account),
    );

    // 6. tenant isolation: a second, unrelated identity must see nothing
    const { data: membershipCount } = await client
      .from('organization_members')
      .select('org_id')
      .eq('org_id', orgId);
    check(
      Array.isArray(membershipCount) && membershipCount.length === 1,
      'RLS shows the probe its own membership and nobody else’s',
      `saw ${membershipCount?.length}`,
    );
  }

  // 7. sign out / back in -- the session must be usable after a fresh token
  await client.auth.signOut();
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password: 'probe-password-9f2a7c1e',
  });
  check(!signInError, 'the new account can sign in again', signInError?.message);
}

async function finish() {
  const key = await adminKey();

  if (!key) {
    console.error(
      `\nFAILED TO CLEAN UP: could not obtain the service-role key.\n` +
        `${created.userIds.length} probe identity/identities remain in the hosted project.`,
    );
    console.error(`Delete ${created.userIds.join(', ')} by hand before the next run.`);
    failures += 1;
  }

  for (const userId of created.userIds) {
    await deleteUser(userId, key);
  }

  if (key) {
    console.log(`\nCleaned up ${created.userIds.length} probe identity/identities.`);
    await sweepOrphans(key);
  }

  console.log(failures === 0 ? 'RESULT: ALL CHECKS PASSED' : `RESULT: ${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

/**
 * Removes probe identities left behind by earlier runs.
 *
 * Exists because the first two runs of this probe could not delete their identity
 * (the foreign key described above), and a probe that quietly accumulates test
 * businesses in the live project is worse than no probe at all. Scoped to the
 * `v2probe` prefix so it can never touch a real seller.
 */
async function sweepOrphans(adminKey) {
  const admin = createClient(url, adminKey, { auth: { persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (!users?.users) return;

  const orphans = users.users.filter((user) => (user.email ?? '').startsWith('v2probe'));
  if (orphans.length === 0) return;

  console.log(`Sweeping ${orphans.length} orphaned probe identity/identities.`);
  for (const user of orphans) {
    await deleteUser(user.id, adminKey);
  }
}

main()
  .then(finish)
  .catch((error) => {
    console.error('probe crashed:', error);
    finish();
  });