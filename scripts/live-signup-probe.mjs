/**
 * Live signup probe.
 *
 * Runs the APPLICATION'S OWN supabase client code against the real project, so
 * this answers "does signUp work today?" rather than "should it?".
 *
 * Not part of the normal suite: it needs network access and the project's
 * public anon key. Run deliberately:
 *   node --import ./scripts/register-loader.mjs scripts/live-signup-probe.mjs
 */

import './__stubs__/env.mjs';

// Point the app at the real project. These are the PUBLIC values already
// present in the EAS preview environment; nothing secret is involved.
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://ggnkvlnnfgvyxwlbjfqx.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = process.env.PROBE_ANON_KEY;

if (!process.env.PROBE_ANON_KEY) {
  console.log('Set PROBE_ANON_KEY to the project anon key to run this probe.');
  process.exit(0);
}

const { getSupabase, configStatus } = await import('../src/lib/supabase.ts?fresh=probe');
const { AppError } = await import('../src/lib/errors.ts?fresh=probe');

console.log(`configStatus: ${configStatus}`);
console.log(`isConfigured: ${getSupabase() !== null}`);

const email = `probe${Date.now().toString(36)}@gmail.com`;
const password = `${Math.random().toString(36)}Aa1!x`;

console.log(`\nattempting signUp as ${email} ...`);
const started = Date.now();

const { data, error } = await getSupabase().auth.signUp({
  email,
  password,
  options: { data: { full_name: 'Live Probe' } },
});

console.log(`round trip: ${Date.now() - started}ms`);

if (error) {
  const mapped = AppError.from(error);
  console.log(`\nRESULT: ERROR`);
  console.log(`  raw name    : ${error.name}`);
  console.log(`  raw message : ${error.message}`);
  console.log(`  raw status   : ${error.status ?? '(none)'}`);
  console.log(`  -> user sees : "${mapped.title}" / "${mapped.action}"`);
  process.exit(1);
}

console.log(`\nRESULT: SUCCESS`);
console.log(`  user id          : ${data.user?.id ?? '(none)'}`);
console.log(`  session returned : ${data.session ? 'YES' : 'NO'}`);
console.log(`  identities       : ${data.user?.identities?.length ?? 0}`);

if (!data.session) {
  console.log(`\n  NOTE: no session. This project has email confirmation ON,`);
  console.log(`  so the seller must click the emailed link before they can sign in.`);
  console.log(`  Whether that link returns to the app depends on the project's`);
  console.log(`  Auth > URL Configuration (Site URL / Redirect URLs), which is`);
  console.log(`  dashboard-only and is NOT readable through the public API.`);
}
