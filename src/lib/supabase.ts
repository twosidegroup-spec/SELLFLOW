/**
 * Supabase client.
 *
 * The app ships only the public anon key. Row Level Security in the database is
 * what actually protects tenant data -- the `authenticated` role this client
 * runs as can read a row only if a policy allows it. There is no code path in
 * this app that uses a service-role key, and adding one to the client bundle
 * would silently disable every policy in 0004_rls.sql.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from './database.types';
import { sessionStorage } from './sessionStorage';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export type ConfigStatus = 'ready' | 'missing_url' | 'missing_key';

/**
 * Whether the app is pointed at a real backend.
 *
 * Checked once at startup so the app can show an honest configuration error
 * instead of failing every query with an opaque network message. It never
 * falls back to mock data.
 */
export const configStatus: ConfigStatus = !url
  ? 'missing_url'
  : !anonKey
    ? 'missing_key'
    : 'ready';

export const isConfigured = configStatus === 'ready';

let client: SupabaseClient<Database> | null = null;

/**
 * The shared client.
 *
 * Throws when configuration is missing. Call `isConfigured` (or the
 * `assertConfigured` guard) before reaching this if you want a friendly screen
 * rather than a thrown error.
 */
export function getSupabase(): SupabaseClient<Database> {
  if (!client) {
    if (!isConfigured) {
      throw new Error(
        `Supabase is not configured (${configStatus}). ` +
          'Copy .env.example to .env and fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.',
      );
    }

    client = createClient<Database>(url as string, anonKey as string, {
      auth: {
        /*
         * The `storage` option is REQUIRED on a device, not an optimisation.
         *
         * Without it auth-js falls back to `globalThis.localStorage` only when
         * `isBrowser()` is true -- which needs `document`, which React Native
         * never defines -- and otherwise uses an in-memory adapter. So
         * `persistSession: true` alone is a no-op on Android and iOS: the app
         * launches, the seller is asked to sign in again, and the passcode
         * unlock never gets a chance because there is no session to unlock.
         *
         * AsyncStorage is what Supabase recommends for React Native. See
         * src/lib/sessionStorage.ts for the full reasoning and the keystore
         * tradeoff.
         */
        storage: sessionStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: {
        headers: { 'x-application-name': 'sellflow' },
      },
      db: { schema: 'public' },
    });
  }

  return client;
}

/** Headers sent by Realtime postgres_changes. Part of the published contract. */
export const REALTIME_CHANNEL = 'sellflow';
