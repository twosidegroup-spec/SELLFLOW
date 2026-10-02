/**
 * SellFlow database verification runner.
 *
 * Applies every migration in order, then runs every SQL suite against a clean
 * database. Exits non-zero on the first failure so CI cannot go green on a
 * broken migration.
 *
 *   npm run db:up        # start the local postgres
 *   npm run db:test
 *
 * Options:
 *   --container <name>   container to use (default sellflow-pg)
 *   --keep              do not drop and recreate the database first
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const container = args.includes('--container') ? args[args.indexOf('--container') + 1] : 'sellflow-pg';
const keep = args.includes('--keep');

const DB = 'sellflow';
const USER = 'postgres';

/** Runs SQL through psql inside the container and streams the output back. */
function psql(label, sql, { onErrorStop = true } = {}) {
  const result = spawnSync(
    'docker',
    ['exec', '-i', container, 'psql', '-q', '-U', USER, '-d', DB, ...(onErrorStop ? ['-v', 'ON_ERROR_STOP=1'] : []), '-f', '-'],
    { input: sql, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failed = result.status !== 0 || /(^|\n)(ERROR|FATAL):/.test(output);

  console.log(`\n  ${label}`);
  if (failed) {
    // Surface the actual error rather than a generic failure.
    const error = output.split('\n').filter((line) => /ERROR|FATAL/.test(line));
    for (const line of error) console.log(`    ${line.trim()}`);
    process.exitCode = 1;
    return false;
  }

  // Notices carry the useful numbers, so they are worth showing.
  for (const line of output.split('\n')) {
    if (/NOTICE:/.test(line) && !/already exists, skipping/.test(line)) {
      console.log(`    ${line.replace(/^.*NOTICE:\s*/, '').trim()}`);
    }
  }
  return true;
}

function readSql(path) {
  return readFileSync(path, 'utf8');
}

// --- clean slate -----------------------------------------------------------

if (!keep) {
  // The `auth` schema is Supabase-provided. The shim recreates just enough of
  // it for the migrations and suites to run against vanilla Postgres, so this is
  // a LOCAL verification aid only -- it is never applied to a real project.
  psql('Resetting the database', `
    drop schema if exists public cascade;
    drop schema if exists auth cascade;
    drop schema if exists extensions cascade;
    create schema public;
    grant usage on schema public to public;
  `, { onErrorStop: true });

  if (!psql('auth shim', readSql(join(process.cwd(), 'supabase', 'test', 'auth_shim.sql')))) {
    process.exit(1);
  }
}

/*
 * Pin the session timezone for every suite that follows.
 *
 * The suites model a seller in Asia/Dhaka (migration 0021 makes that the default
 * store timezone) and express "today" as `current_date`, while inserting rows
 * with `now()`. Both resolve through the *session* timezone.
 *
 * The container defaults to UTC, so between 00:00 and 06:00 Dhaka time
 * `current_date` is still the previous day while `now()` is already the new one.
 * Every "today" assertion then reads the wrong business day and fails with
 * messages like "today revenue should be 10000, got 0".
 *
 * That is a real time bomb rather than a flake: it fails for six hours every
 * night and passes for the other eighteen, which is exactly how a bug ends up
 * blamed on an unrelated change.
 *
 * `ALTER DATABASE` rather than `SET`, because each suite is a separate psql
 * process and a plain SET would not survive into the next one. It applies to new
 * connections, which is every suite from here on.
 */
psql('Pin session timezone', `alter database ${DB} set timezone = 'Asia/Dhaka';`, { onErrorStop: false });

const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

console.log(`\nApplying ${migrations.length} migration(s)`);
for (const name of migrations) {
  if (!psql(name, readSql(join(migrationsDir, name)))) {
    console.log(`\n  MIGRATION FAILED: ${name}`);
    process.exit(1);
  }
}

console.log(`\n${migrations.length} migration(s) applied`);

// --- test suites -----------------------------------------------------------

const testDir = join(process.cwd(), 'supabase', 'test');
const suites = readdirSync(testDir)
  .filter((name) => name.startsWith('verify') && name.endsWith('.sql'))
  .sort();

console.log(`\nRunning ${suites.length} suite(s)`);

let passed = 0;
for (const name of suites) {
  if (psql(name, readSql(join(testDir, name)))) {
    passed += 1;
  }
}

console.log(`\n  ${passed}/${suites.length} database suite(s) passed`);
if (passed !== suites.length) process.exit(1);
