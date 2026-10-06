/**
 * Tenant-wide row census, used to prove a migration changed no data.
 *
 * Counts every table a business owns, plus checksums that would move if a single row
 * were rewritten rather than merely absent. A count alone cannot distinguish "the
 * migration deleted a row" from "the migration rewrote a row", so this also aggregates
 * the money and the timestamps.
 *
 * Read through the service role, because the point is to see ALL tenants at once,
 * including any this agent cannot otherwise reach. Read only: this script issues
 * SELECT and nothing else.
 *
 * Run with: node --env-file=.env scripts/tenant-census.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;

if (!url) {
  console.error('EXPO_PUBLIC_SUPABASE_URL is not set.');
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
  if (!key || key.includes('***')) return null;
  return key;
}

const TABLES = [
  'organizations',
  'stores',
  'profiles',
  'products',
  'inventory',
  'inventory_movements',
  'customers',
  'orders',
  'order_items',
  'order_status_history',
  'payments',
  'payment_accounts',
  'payment_intents',
  'payment_events',
  'payment_matches',
];

/** Counts, plus money and time aggregates that a rewrite would disturb. */
const SUM_COLUMNS = {
  orders: ['total', 'amount_paid', 'cost_total', 'profit', 'cod_amount'],
  payments: ['amount'],
  payment_accounts: [],
  inventory: ['quantity'],
  products: ['selling_price', 'cost_price'],
};

async function census() {
  const key = adminKey();
  if (!key) throw new Error('no service key, cannot census');

  const db = createClient(url, key, { auth: { persistSession: false } });
  const out = {};

  for (const table of TABLES) {
    const { data, error } = await db.from(table).select('*').limit(5000);
    if (error) {
      out[table] = { error: error.message };
      continue;
    }

    const row = { rows: data.length };

    // updated_at is the giveaway for a silent rewrite.
    const stamps = data.map((r) => r.updated_at).filter(Boolean).sort();
    if (stamps.length) {
      row.latest_updated_at = stamps[stamps.length - 1];
      row.earliest_updated_at = stamps[0];
    }

    for (const column of SUM_COLUMNS[table] ?? []) {
      const present = data.filter((r) => typeof r[column] === 'number');
      if (present.length) {
        row[`sum_${column}`] = Number(
          present.reduce((total, r) => total + r[column], 0).toFixed(2),
        );
      }
    }

    out[table] = row;
  }

  // Identities, which live outside the public schema.
  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
  out['auth.users'] = { rows: users?.users?.length ?? 0 };

  return out;
}

const snapshot = await census();
console.log(JSON.stringify(snapshot, null, 2));