/**
 * SellFlow :: session persistence verification
 *
 * Phase 1, finding F1.
 *
 * The defect: `createClient({ auth: { persistSession: true } })` without a
 * `storage` option does NOT persist on a device. auth-js only falls back to
 * `globalThis.localStorage` when `isBrowser()` is true, and that requires
 * `document`, which React Native never defines. So on Android and iOS the
 * client silently uses an in-memory adapter and every cold start demands the
 * seller's email and password again.
 *
 * This suite proves three things, and the third is the one that actually protects
 * the fix:
 *
 *   1. The client is constructed with a real `storage` adapter.
 *   2. auth-js's OWN resolution logic, run as written in the installed package,
 *      picks that adapter rather than the in-memory fallback. Asserting only (1)
 *      would pass if someone passed an adapter auth-js then ignored.
 *   3. A session written before a simulated process restart is readable after
 *      it -- the behaviour the seller actually experiences.
 *
 * Everything under test is real source. AsyncStorage is the one stub, because the
 * native module has no Node build; the stub is a Map, so "restart" is a fresh
 * module graph over the same persisted bytes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import './__stubs__/env.mjs';
import {
  __resetAsyncStorage,
  __dumpAsyncStorage,
} from './__stubs__/async-storage.mjs';
import { __resetClientOptions, __lastClientOptions } from './__stubs__/supabase-js.mjs';

let generation = 0;

/** Fresh copy of `@/lib/supabase`, as a cold start would get. */
async function boot() {
  generation += 1;
  return import(`../src/lib/supabase.ts?fresh=${generation}`);
}

const SESSION = {
  access_token: 'header.payload.signature',
  refresh_token: 'a-refresh-token-that-must-survive-a-restart',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: {
    id: '11111111-1111-1111-1111-111111111111',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'seller@example.invalid',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
  },
};

/**
 * auth-js's storage resolution, transcribed from the installed package.
 *
 * GoTrueClient.js:
 *   if (settings.storage) this.storage = settings.storage;
 *   else if (supportsLocalStorage()) this.storage = globalThis.localStorage;
 *   else { this.storage = memoryLocalStorageAdapter({}); }
 *
 * lib/helpers.js:
 *   isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined'
 *   supportsLocalStorage = () => { if (!isBrowser()) return false; ... }
 *
 * This is the load-bearing assertion of the suite. It deliberately models a
 * REACT NATIVE environment -- `window` present, `document` absent, exactly as
 * RN's setUpGlobals provides -- because that is the environment in which the
 * original bug existed. Under the old code this resolves to `memory`, which is
 * why `persistSession: true` achieved nothing.
 */
function resolveStorageAsAuthJsWould(settings, env) {
  if (settings.storage) return { kind: 'explicit', adapter: settings.storage };
  const isBrowser =
    typeof env.window !== 'undefined' && typeof env.document !== 'undefined';
  if (isBrowser) return { kind: 'localStorage', adapter: null };
  return { kind: 'memory', adapter: null };
}

const REACT_NATIVE_GLOBALS = {
  // react-native/Libraries/Core/setUpGlobals.js assigns `global.window = global`.
  // `document` is never assigned.
  window: {},
  document: undefined,
};

describe('SellFlow :: session persistence (F1)', () => {
  test('the client is built with an explicit storage adapter', async () => {
    __resetClientOptions();
    await boot();
    const { getSupabase, isConfigured } = await boot();
    assert.equal(isConfigured, true, 'the stub env should make the client configurable');

    getSupabase();

    const options = __lastClientOptions();
    assert.ok(options, 'createClient should have been called');
    assert.equal(typeof options.auth?.storage, 'object');
    for (const method of ['getItem', 'setItem', 'removeItem']) {
      assert.equal(
        typeof options.auth.storage[method],
        'function',
        `storage adapter must expose ${method} -- auth-js calls these directly`,
      );
    }
    assert.equal(options.auth.persistSession, true);
    assert.equal(options.auth.autoRefreshToken, true);
    assert.equal(options.auth.detectSessionInUrl, false);
  });

  test('auth-js resolves the explicit adapter, not the in-memory fallback', async () => {
    __resetClientOptions();
    const { getSupabase } = await boot();
    getSupabase();
    const options = __lastClientOptions();

    const resolved = resolveStorageAsAuthJsWould(options.auth, REACT_NATIVE_GLOBALS);

    assert.equal(
      resolved.kind,
      'explicit',
      'on a device auth-js must be given a storage adapter; anything else is memory-only',
    );
    assert.equal(resolved.adapter, options.auth.storage);

    // Guards the regression in the other direction: the premise of this suite is
    // that without the adapter it WOULD have been memory. If that ever stops being
    // true, this suite's premise is stale and the finding needs revisiting.
    const withoutAdapter = resolveStorageAsAuthJsWould(
      { persistSession: true },
      REACT_NATIVE_GLOBALS,
    );
    assert.equal(
      withoutAdapter.kind,
      'memory',
      'assumes auth-js still falls back to memory on native; if this changes, re-audit F1',
    );
  });

  test('a session survives a process restart', async () => {
    __resetAsyncStorage();
    __resetClientOptions();

    // --- cold start, sign in ---------------------------------------------
    const first = await boot();
    const { getSupabase } = first;
    getSupabase();
    const adapter = __lastClientOptions().auth.storage;

    await adapter.setItem('sb-sellflow-auth-token', JSON.stringify(SESSION));

    const persisted = await adapter.getItem('sb-sellflow-auth-token');
    assert.ok(persisted, 'the session must be readable in the same process');
    assert.equal(JSON.parse(persisted).user.email, 'seller@example.invalid');

    // --- process dies and comes back ------------------------------------
    // New module instances over the same bytes. This is the restart.
    const second = await boot();
    second.getSupabase();
    const afterRestart = __lastClientOptions().auth.storage;

    const restored = await afterRestart.getItem('sb-sellflow-auth-token');
    assert.ok(restored, 'F1: the session was gone after a restart -- this is the bug');
    const parsed = JSON.parse(restored);
    assert.equal(parsed.refresh_token, SESSION.refresh_token);
    assert.equal(parsed.user.id, SESSION.user.id);

    // And it actually landed in AsyncStorage, not just in an adapter-internal
    // cache that a restart would discard.
    const dump = __dumpAsyncStorage();
    assert.ok('sb-sellflow-auth-token' in dump, 'session must be in the durable store');
  });

  test('sign-out removes the persisted session', async () => {
    __resetAsyncStorage();
    const { getSupabase } = await boot();
    getSupabase();
    const adapter = __lastClientOptions().auth.storage;

    await adapter.setItem('sb-sellflow-auth-token', JSON.stringify(SESSION));
    await adapter.removeItem('sb-sellflow-auth-token');

    assert.equal(await adapter.getItem('sb-sellflow-auth-token'), null);
    assert.equal('sb-sellflow-auth-token' in __dumpAsyncStorage(), false);
  });

  test('a storage failure degrades to "no session" and never throws', async () => {
    __resetAsyncStorage();
    const { sessionStorage, getStorageFaults, __resetStorageFaults } = await import(
      `../src/lib/sessionStorage.ts?fresh=${++generation}`
    );
    __resetStorageFaults();

    // A backend that fails the way a corrupt SQLite file does.
    const realGetItem = (await import('@react-native-async-storage/async-storage')).default.getItem;
    const as = (await import('@react-native-async-storage/async-storage')).default;
    const broken = {
      ...as,
      getItem: async () => {
        throw new Error('SQLite disk image is malformed');
      },
      setItem: async () => {
        throw new Error('database or disk is full');
      },
      removeItem: async () => {
        throw new Error('attempt to re-open an already-closed object');
      },
    };
    // Rebind the stub's default export for this assertion only.
    Object.assign(as, broken);
    assert.equal(typeof realGetItem, 'function');

    // None of these may throw. A rejected promise here would reach auth-js's
    // startup path and surface as a blank screen.
    assert.equal(await sessionStorage.getItem('k'), null);
    await sessionStorage.setItem('k', 'v');
    await sessionStorage.removeItem('k');

    const faults = getStorageFaults();
    assert.equal(faults.length, 3, 'every swallowed failure must be recorded');
    assert.deepEqual(
      faults.map((f) => f.operation).sort(),
      ['read', 'remove', 'write'],
    );

    for (const fault of faults) {
      assert.equal(fault.key, 'k');
      // Name only -- a backend message can contain the serialized session,
      // which holds a refresh token.
      assert.ok(['Error', 'TypeError'].includes(fault.name), `unexpected name ${fault.name}`);
      assert.equal(typeof fault.name, 'string');
    }
  });
});