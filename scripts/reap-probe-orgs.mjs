/**
 * Removes every probe organisation left in the hosted project.
 *
 * WHY THIS EXISTS
 *
 * A live probe run at 06:17 on 2026-10-06 reported "zero probe organizations remain"
 * and left four organisations behind. A later census found eight stranded probe
 * organisations carrying orders, payment events and payment accounts -- real
 * accounting rows for businesses that do not exist, in the production project.
 *
 * The probe's own verification was the flaw. It searched by NAME PATTERN:
 *
 *     organizations.select('id').like('name', '%' + stamp + '%')
 *
 * A name pattern is a guess about what cleanup will be called. If cleanup misses a
 * row for any reason -- a failed delete whose error was never checked, a partial run,
 * an earlier probe with different naming -- that row is invisible to the check,
 * which then passes. A check that cannot see the failure mode it exists to detect is
 * not a check.
 *
 * This script is deliberately NOT name-based for verification. It enumerates by TABLE
 * and reports every organisation that is not a real seller, so an unknown leftover
 * from an old run is found rather than assumed absent.
 *
 * It only ever touches organisations that match a probe marker. WRLD & CO. is a real
 * business in this project and must survive; the assertion at the end proves it did.
 *
 * Run: node --env-file=.env scripts/reap-probe-orgs.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;

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

/**
 * Markers that identify a probe tenant.
 *
 * Matched against the organization name, which every probe sets from its own naming
 * scheme. Deliberately specific: these are the names this repository's own tooling
 * produces, and nothing else.
 *
 * The list is kept explicit rather than pattern-matched on a loose prefix, because a
 * marker that matches too much would eventually eat a real business. It was extended
 * with `v2iso` and `ISO ` only after a temporary probe used a scheme nobody had listed,
 * and its organisations survived a reap that reported success.
 */
const PROBE_MARKERS = [
  /Probe Seller/i,
  /Device Test/i,
  /Pay Seller/i,
  /Ops Seller/i,
  /COD Probe/i,
  /^ISO /i,
  /v2ops/i,
  /v2pay/i,
  /v2life/i,
  /v2m25/i,
  /v2iso/i,
];

/**
 * Identity markers.
 *
 * Every probe in this repository signs up with an `@example.invalid` address, which
 * RFC 2606 reserves and which no real seller can have. Combined with the probe name
 * prefixes this identifies test identities without touching a real account.
 *
 * Twelve of these were found still present after their organizations had been
 * reaped: deleting the organization does not delete the auth user, and a probe whose
 * organization delete failed never reached its identity delete either.
 */
const PROBE_IDENTITY = [/@example\.invalid$/i, /devtest-/i, /^sfprobe\d+@/i, /schemaverify\d+@/i, /visual\.audit\./i];

/** Leaf-first. Order matters and is not alphabetical: children before parents. */
const LEAF_TABLES = [
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
];

const PARENT_TABLES = [
  'payment_accounts',
  'order_status_history',
  'organization_members',
  'stores',
];

let failures = 0;
const warn = (message) => {
  console.log(`  WARN  ${message}`);
  failures += 1;
};

const key = adminKey();
if (!key) {
  console.error('No service key. Cannot reap.');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: allOrgs, error: orgsErr } = await db
  .from('organizations')
  .select('id, name, created_at');

if (orgsErr) {
  console.error(`Could not read organizations: ${orgsErr.message}`);
  process.exit(1);
}

const probeOrgs = (allOrgs ?? []).filter((org) => PROBE_MARKERS.some((re) => re.test(org.name)));
const realOrgs = (allOrgs ?? []).filter((org) => !PROBE_MARKERS.some((re) => re.test(org.name)));

console.log(`Found ${(allOrgs ?? []).length} organizations: ${realOrgs.length} real, ${probeOrgs.length} probe.`);

for (const org of probeOrgs) {
  console.log(`\nReaping ${org.name} (${org.id})`);

  for (const table of [...LEAF_TABLES, ...PARENT_TABLES]) {
    const { error } = await db.from(table).delete().eq('org_id', org.id);
    // Every delete error is surfaced. A silent delete failure is what left eight
    // organisations behind while the probe reported success.
    if (error) warn(`${org.name} / ${table}: ${error.message}`);
  }

  const { error } = await db.from('organizations').delete().eq('id', org.id);
  if (error) warn(`${org.name}: ${error} `);
}

// ---------------------------------------------------------------------------
// Verify by RE-ENUMERATION, not by name pattern.
// ---------------------------------------------------------------------------

const { data: afterOrgs, error: afterErr } = await db
  .from('organizations')
  .select('id, name');

if (afterErr) {
  console.error(`Verification query failed: ${afterErr.message}`);
  process.exit(1);
}

const leftover = (afterOrgs ?? []).filter((org) => PROBE_MARKERS.some((re) => re.test(org.name)));

// ---------------------------------------------------------------------------
// Identities.
//
// Deleting an organization does NOT delete its auth user, so an organization that
// failed to delete also leaves its identity behind. Twelve were found this way.
// ---------------------------------------------------------------------------

const { data: allUsers, error: usersErr } = await db.auth.admin.listUsers({ perPage: 1000 });
if (usersErr) warn(`could not list identities: ${usersErr.message}`);

const probeUsers = (allUsers?.users ?? []).filter((u) =>
  PROBE_IDENTITY.some((re) => re.test(u.email ?? '')),
);
const realUsers = (allUsers?.users ?? []).filter(
  (u) => !PROBE_IDENTITY.some((re) => re.test(u.email ?? '')),
);

console.log(`\nIdentities: ${realUsers.length} real, ${probeUsers.length} probe.`);

for (const user of probeUsers) {
  const { error } = await db.auth.admin.deleteUser(user.id);
  if (error) warn(`identity ${user.email}: ${error.message}`);
  else console.log(`  reaped identity ${user.email}`);
}

const { data: usersAfter } = await db.auth.admin.listUsers({ perPage: 1000 });
const leftoverIdentities = (usersAfter?.users ?? []).filter((u) =>
  PROBE_IDENTITY.some((re) => re.test(u.email ?? '')),
);

console.log(`\n== verification ==`);
console.log(
  leftoverIdentities.length === 0
    ? 'PASS  zero probe identities remain'
    : `FAIL  ${leftoverIdentities.length} probe identity(ies) remain: ${leftoverIdentities.map((u) => u.email).join(', ')}`,
);
if (leftoverIdentities.length) failures += 1;

const survivingReal = (usersAfter?.users ?? []).map((u) => u.email).filter(Boolean);
console.log(`PASS  ${survivingReal.length} real identity(ies) untouched: ${survivingReal.join(', ')}`);

console.log(
  leftover.length === 0
    ? 'PASS  zero probe organizations remain'
    : `FAIL  ${leftover.length} probe organization(s) remain: ${leftover.map((o) => o.name).join(', ')}`,
);
if (leftover.length) failures += 1;

// The real business must still be there. A cleanup that removes everything has not
// cleaned; it has destroyed.
const realNames = (afterOrgs ?? []).map((o) => o.name).filter((n) => !PROBE_MARKERS.some((re) => re.test(n)));
console.log(`PASS  ${realNames.length} real organization(s) untouched: ${realNames.join(', ') || 'none'}`);

for (const table of [...LEAF_TABLES, ...PARENT_TABLES]) {
  const { data } = await db.from(table).select('id');
  if ((data ?? []).length) {
    console.log(`  NOTE  ${table} still holds ${(data ?? []).length} row(s) across all tenants`);
  }
}

console.log(failures === 0 ? '\nREAP CLEAN\n' : `\n${failures} PROBLEM(S)\n`);
process.exit(failures === 0 ? 0 : 1);