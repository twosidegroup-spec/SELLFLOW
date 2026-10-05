/**
 * Creates a real seller account for on-device verification.
 *
 * Distinct from the probes: this one is NOT deleted immediately, because the point
 * is to sign in with it on the emulator. It prints the credentials so the UI can be
 * driven by hand, and `cleanup-device-account.mjs` removes it afterwards.
 *
 * The email carries a `devtest` prefix so cleanup can find it, and so an account
 * left behind by an interrupted run is identifiable rather than looking like a real
 * seller.
 */

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error('Supabase env not set.');
  process.exit(1);
}

const PASSWORD = 'DeviceTest-2026-xk9';
const stamp = Date.now();
const email = `devtest-${stamp}@example.invalid`;
const fullName = 'Device Test Seller';
const businessName = `Device Test Biz ${stamp}`;

const client = createClient(url, anonKey, { auth: { persistSession: false } });

const { data, error } = await client.auth.signUp({
  email,
  password: PASSWORD,
  options: { data: { full_name: fullName } },
});
if (error) {
  console.error('signUp failed:', error.message);
  process.exit(1);
}

const { data: boot, error: bootError } = await client.rpc('bootstrap_business', {
  p_business_name: businessName,
  p_store_name: null,
  p_store_code: null,
});
if (bootError) {
  console.error('bootstrap_business failed:', bootError.message);
  process.exit(1);
}

const orgId = boot?.id ?? boot?.org_id;

const { error: accountError } = await client.rpc('create_payment_account', {
  p_org_id: orgId,
  p_provider: 'bkash',
  p_account_number: '017' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
  p_account_type: 'personal',
  p_label: null,
});
if (accountError) console.error('create_payment_account failed (continuing):', accountError.message);

const { data: stores } = await client.from('stores').select('id, code, name').eq('org_id', orgId).limit(1);

console.log(JSON.stringify({ email, password: PASSWORD, orgId, store: stores?.[0], stamp }, null, 2));

/*
 * Persisted so cleanup does not need to be told the email, and so an interrupted
 * run leaves a recoverable record rather than an unidentifiable orphan.
 */
const { writeFileSync } = await import('node:fs');
writeFileSync('.device-test-account.json', JSON.stringify({ email, stamp }, null, 2));
void spawnSync;
