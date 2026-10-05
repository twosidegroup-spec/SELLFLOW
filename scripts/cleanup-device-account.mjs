/**
 * Removes device-verification accounts.
 *
 * `device-test-account.mjs` deliberately leaves its identity behind so the UI can be
 * driven by hand on an emulator. This is the other half: it deletes those, and any
 * left by an interrupted run, and then VERIFIES none remain.
 *
 * Cleanup is leaf-first and identity last, for the reason recorded in the lifecycle
 * probe: `profiles.id` cascades from `auth.users`, but `organizations.created_by`
 * references `profiles` without cascading, so deleting the identity first trips the
 * foreign key and removes nothing.
 */

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error('Supabase env not set.');
  process.exit(1);
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
  return key && !key.includes('***') ? key : null;
}

const key = adminKey();
if (!key) {
  console.error('No service-role key. Delete the devtest identities by hand.');
  process.exit(1);
}

const admin = createClient(url, key, { auth: { persistSession: false } });

/** The specific account this run created, plus any left by an interrupted run. */
let target = null;
try {
  target = JSON.parse(readFileSync('.device-test-account.json', 'utf8'));
} catch {
  // No marker file; the prefix sweep below still finds everything.
}

const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
const victims = (users?.users ?? []).filter(
  (u) => (u.email ?? '').startsWith('devtest-') || (target && u.email === target.email),
);

if (victims.length === 0) {
  console.log('No device-test accounts to remove.');
} else {
  console.log(`Removing ${victims.length} device-test account(s)…`);

  for (const user of victims) {
    const { data: memberships } = await admin
      .from('organization_members')
      .select('org_id')
      .eq('user_id', user.id);

    for (const { org_id: orgId } of memberships ?? []) {
      await admin.from('payment_accounts').delete().eq('org_id', orgId);
      await admin.from('orders').delete().eq('org_id', orgId);
      await admin.from('customers').delete().eq('org_id', orgId);
      // CASCADES to stores, members, payment_intents, expenses.
      const { error } = await admin.from('organizations').delete().eq('id', orgId);
      if (error) console.log(`  org cleanup failed for ${orgId}: ${error.message}`);
    }

    const { error } = await admin.auth.admin.deleteUser(user.id);
    console.log(`  ${user.email}: ${error ? `FAILED ${error.message}` : 'removed'}`);
  }
}

/* Verify rather than assume. */
const { data: after } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
const remaining = (after?.users ?? []).filter((u) => (u.email ?? '').startsWith('devtest-'));

const { data: orgs } = await admin
  .from('organizations')
  .select('id')
  .like('name', 'Device Test Biz%');

const { data: allAccounts } = await admin.from('payment_accounts').select('id, org_id');
const dangling = (allAccounts ?? []).filter((a) => {
  if (!a.org_id) return true;
  return false;
});

console.log(`\nIdentities remaining:  ${remaining.length}`);
console.log(`Organizations remaining: ${(orgs ?? []).length}`);
console.log(`Payment accounts with no org: ${dangling.length}`);

const clean = remaining.length === 0 && (orgs ?? []).length === 0 && dangling.length === 0;
console.log(clean ? 'RESULT: CLEAN' : 'RESULT: NOT CLEAN');
process.exitCode = clean ? 0 : 1;
