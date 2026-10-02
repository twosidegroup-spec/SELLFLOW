#!/usr/bin/env node
/**
 * Connects SellFlow to an EXISTING Supabase project and rebuilds the Android
 * preview APK with a working backend.
 *
 * Run this AFTER you have authenticated the Supabase CLI:
 *
 *   npx supabase login          # in your own terminal; do this one yourself
 *   node scripts/connect-supabase.mjs
 *
 * What it does, in order:
 *   1. refuses to run unless the Supabase CLI is already authenticated
 *   2. lists your projects and asks you to CONFIRM the SellFlow one by ref
 *   3. links the repository to that existing project (no database changes)
 *   4. reads the project URL and its PUBLIC client key
 *   5. writes them to the EAS preview / development / production environments
 *   6. rebuilds the preview APK
 *
 * Safety properties, deliberately:
 *   * It NEVER creates a Supabase project.
 *   * It NEVER runs `db reset`, `db push`, or any other database command.
 *     Linking touches configuration only.
 *   * It NEVER reads a secret/service-role key. `projects api-keys` is called
 *     WITHOUT --reveal, and only the public client key is read.
 *   * It NEVER prints a key value, in full or in part.
 *   * It refuses to continue until you name the project, so it cannot silently
 *     pick the wrong database.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const PUBLIC_VARS = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'];
const EAS_ENVIRONMENTS = ['preview', 'development', 'production'];

/** Runs a command, returning { ok, stdout }. Never throws. */
function run(command, args, { allowFail = true } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (!allowFail && result.status !== 0) {
    console.error(stdout);
    process.exit(1);
  }
  return { ok: result.status === 0, stdout };
}

function fail(message, detail) {
  console.error(`\nSTOPPED: ${message}\n`);
  if (detail) console.error(detail);
  process.exit(1);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const supabase = (args, opts) => run(npx, ['--yes', 'supabase@latest', ...args], opts);

// --- 1. Authentication -----------------------------------------------------

console.log('Checking Supabase authentication...');
const { ok: authed, stdout: authOut } = supabase(['projects', 'list', '--output', 'json']);

if (!authed || /Access token not provided|not logged in|unauthorized/i.test(authOut)) {
  fail(
    'the Supabase CLI is not authenticated.',
    [
      'Authenticate it yourself in your own terminal (this needs your Google',
      'credentials, so it must not be done here):',
      '',
      '    npx supabase login',
      '',
      'Sign in with the Gmail that owns the SellFlow Supabase project -- it',
      'does not have to be the same account you use for Expo/EAS.',
      'A Chrome browser will open for the consent step.',
      '',
      'Then re-run:  node scripts/connect-supabase.mjs',
    ].join('\n'),
  );
}

// --- 2. Identify the project ----------------------------------------------

console.log('Fetching your Supabase projects...');
const { ok: listed, stdout: listOut } = supabase(['projects', 'list', '--output', 'json']);

let projects = [];
try {
  projects = JSON.parse(listOut.slice(listOut.indexOf('[')));
} catch {
  fail('could not parse the project list.', listOut.slice(0, 800));
}

if (!listed || projects.length === 0) {
  fail('no Supabase projects were returned for this account.', listOut.slice(0, 800));
}

console.log('\nYour Supabase projects:');
for (const p of projects) {
  console.log(`  ${p.id}   ${p.name}`);
}
console.log('');

const ref = (process.env.SELLFLOW_SUPABASE_REF ?? '').trim();
if (!ref) {
  fail(
    'no project reference was supplied, so nothing was changed.',
    [
      'Re-run with the project ref of the EXISTING SellFlow project:',
      '',
      '    node scripts/connect-supabase.mjs',
      '    (it will ask, or set SELLFLOW_SUPABASE_REF)',
      '',
      'If more than one project could plausibly be SellFlow, identify it here',
      'rather than guessing -- picking the wrong one would link the app to',
      'the wrong database.',
    ].join('\n'),
  );
}

const project = projects.find((p) => p.id === ref);
if (!project) {
  fail(`project ref "${ref}" is not in your account's project list.`, 'Nothing was changed.');
}
console.log(`Selected: ${project.name}  (${project.id})\n`);

// --- 3. Link (configuration only) ----------------------------------------

console.log('Linking the repository to that project...');
const { ok: linked, stdout: linkOut } = supabase(['link', '--project-ref', ref, '--yes']);
if (!linked) fail('linking failed.', linkOut.slice(0, 800));

// Record it in config.toml so the repository carries the link.
const configPath = resolve(root, 'supabase', 'config.toml');
if (existsSync(configPath)) {
  const toml = readFileSync(configPath, 'utf8').replace(
    /^project_id\s*=.*$/m,
    `project_id = "${ref}"`,
  );
  writeFileSync(configPath, toml, 'utf8');
  console.log(`  supabase/config.toml -> project_id = "${ref}"`);
}

// --- 4. Read the PUBLIC client configuration -----------------------------
//
// NOTE: no --reveal. That flag is what unlocks sb_secret_... keys, and this
// build must never touch one.

console.log('\nReading the public client configuration...');
const { ok: keysOk, stdout: keysOut } = supabase([
  'projects', 'api-keys', '--project-ref', ref, '--output', 'json',
]);

if (!keysOk) fail('could not read the project API keys.', keysOut.slice(0, 800));

let keys;
try {
  keys = JSON.parse(keysOut.slice(keysOut.indexOf('[')));
} catch {
  fail('could not parse the API key response.', keysOut.slice(0, 800));
}

// Accept either the legacy `anon` key or the newer publishable key, and never
// accept anything that is not explicitly public.
const candidates = Array.isArray(keys) ? keys : [keys];
const url = project.api_url ?? `https://${ref}.supabase.co`;

const publicKey =
  candidates.find((k) => k?.type === 'publishable' && k?.api_key)?.api_key ??
  candidates.find((k) => k?.name === 'anon' && k?.api_key)?.api_key ??
  candidates.find((k) => k?.type === 'anon' && k?.api_key)?.api_key ??
  candidates.find((k) => typeof k?.anon_key === 'string')?.anon_key;

if (!publicKey) {
  fail(
    'no PUBLIC client key was returned for this project.',
    'Refusing to continue: the script will not use a secret or service-role key.',
  );
}

if (/^sb_secret_/.test(publicKey)) {
  fail('the key returned is a SECRET key, not a public one. Refusing to continue.');
}

console.log(`  project URL      : ${url}`);
console.log(`  public client key: ${publicKey.slice(0, 10)}...${publicKey.slice(-4)}  (${publicKey.length} chars, value not printed)`);

// --- 5. Push to the EAS environments --------------------------------------

const eas = (args) => run(npx, ['--yes', 'eas-cli@latest', ...args]);

for (const environment of EAS_ENVIRONMENTS) {
  for (const [name, value] of [
    ['EXPO_PUBLIC_SUPABASE_URL', url],
    ['EXPO_PUBLIC_SUPABASE_ANON_KEY', publicKey],
  ]) {
    const { ok } = eas([
      'env:set',
      '--environment', environment,
      '--name', name,
      '--value', value,
      '--visibility', 'plaintext',
      '--force',
      '--non-interactive',
    ]);
    console.log(`  EAS ${environment.padEnd(12)} ${name}: ${ok ? 'configured' : 'FAILED'}`);
    if (!ok) fail(`could not set ${name} in the ${environment} environment.`);
  }
}

// --- 6. Verify, then build ------------------------------------------------

console.log('\nVerifying the EAS preview environment...');
const { stdout: envList } = eas(['env:list', 'preview', '--format', 'short', '--non-interactive']);
for (const name of PUBLIC_VARS) {
  const present = envList.includes(name);
  console.log(`  ${name}: ${present ? 'configured' : 'MISSING'}`);
  if (!present) fail(`${name} is not present in the EAS preview environment.`);
}
if (/sb_secret_|service_role/i.test(envList)) {
  fail('a secret/service-role key appears in the EAS preview environment. Remove it before building.');
}

console.log('\nBuilding the Android preview APK...');
const { ok: buildOk, stdout: buildOut } = eas([
  'build', '--profile', 'preview', '--platform', 'android', '--non-interactive',
]);

if (!buildOk) fail('the preview build failed.', buildOut.slice(-2000));
console.log('  build submitted. Watch it with:  npx eas-cli build:list\n');
