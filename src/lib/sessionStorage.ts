/**
 * Durable storage for the Supabase auth session.
 *
 * WHY THIS FILE EXISTS
 *
 * `createClient({ auth: { persistSession: true } })` does NOT persist on a
 * phone. Inside `@supabase/auth-js` the client resolves its storage like this
 * (GoTrueClient.js):
 *
 *     if (settings.storage)  this.storage = settings.storage;
 *     else if (supportsLocalStorage()) this.storage = globalThis.localStorage;
 *     else { this.storage = memoryLocalStorageAdapter({}); }
 *
 * and `supportsLocalStorage()` returns false unless `isBrowser()`, which
 * requires `typeof document !== 'undefined'`:
 *
 *     export const isBrowser = () =>
 *       typeof window !== 'undefined' && typeof document !== 'undefined';
 *
 * React Native defines `global.window = global` but never `document`. So on
 * Android and iOS the client silently falls through to an in-memory adapter,
 * `persistSession: true` becomes a no-op, and every cold start needs the
 * seller's email and password again.
 *
 * That is invisible in a browser -- react-native-web supplies `document` and
 * `localStorage` -- which is why it survives web testing and breaks only on a
 * device.
 *
 * WHAT THIS DOES
 *
 * Passes AsyncStorage as an explicit `storage` adapter. `AsyncStorage` already
 * satisfies auth-js's `SupportedStorage` shape (`getItem`/`setItem`/`removeItem`,
 * each returning a Promise), so no wrapping is needed for correctness. The
 * wrapper exists to add two things the raw module does not give us:
 *
 *   1. A storage FAILURE must never crash the app or hang startup. The cached
 *      session is a convenience -- the server enforces RLS either way -- so
 *      degrading to "no session" is both safe and honest.
 *   2. Failures must be visible. A silent catch here is precisely how F1 hid
 *      for so long: nothing throws, nothing logs, the app just forgets you every
 *      launch. So every swallowed error records the key and the error name.
 *
 * SECURITY TRADEOFF, stated plainly
 *
 * AsyncStorage is unencrypted on Android (plain SQLite / file). A session holds
 * an access token and a long-lived refresh token, so this is a real reduction in
 * at-rest protection versus a keystore.
 *
 * It is still the right choice here, because the alternatives are worse:
 *
 *   - expo-secure-store is keystore-backed, but Android caps a single value at
 *     2048 bytes. A session with two JWTs plus the full user object routinely
 *     exceeds that, so a SecureStore adapter either throws or silently truncates
 *     -- reintroducing F1 in a harder-to-diagnose form.
 *   - Hand-rolled encryption means shipping a key. In the same sandbox that buys
 *     obfuscation rather than protection, and adds a new class of corruption
 *     ("key mismatch, signed out forever") to debug.
 *
 * Supabase's own guidance for React Native is AsyncStorage. The device is the
 * trust boundary here; the passcode and RLS are the real protections. A
 * keystore-backed store can be introduced later behind this same interface, so
 * that swapping it touches exactly one file.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Matches auth-js's `SupportedStorage`.
 *
 * Declared structurally rather than imported from their package so that a change
 * upstream surfaces as a compile error at the `createClient` call site in
 * `supabase.ts`, which is where it matters.
 */
export interface SessionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Records that a key could not be read, written or removed.
 *
 * Holds only the KEY and the error's NAME. A storage backend's error message can
 * carry the serialized session -- which contains a refresh token -- so it is
 * never retained. Exported so a diagnostics screen can tell a seller their device
 * storage is not saving, and so tests can prove the failure path was exercised.
 */
export type StorageFault = {
  key: string;
  operation: 'read' | 'write' | 'remove';
  name: string;
};

const faults: StorageFault[] = [];

export function getStorageFaults(): readonly StorageFault[] {
  return faults;
}

export function __resetStorageFaults(): void {
  faults.length = 0;
}

async function guard<T>(
  key: string,
  operation: StorageFault['operation'],
  fallback: T,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    faults.push({ key, operation, name });
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        `[session-storage] ${operation} failed for ${key} (${name}). ` +
          'Treating it as absent; the server remains the authority on access.',
      );
    }
    return fallback;
  }
}

/**
 * The adapter handed to `createClient`.
 *
 * Stateless and cheap to construct, so it is a plain singleton rather than a
 * lazily-resolved value -- `createClient` needs its options object synchronously
 * and there is nothing to await.
 */
export const sessionStorage: SessionStorage = {
  getItem: (key) => guard(key, 'read', null, () => AsyncStorage.getItem(key)),

  setItem: (key, value) =>
    guard(key, 'write', undefined, async () => {
      await AsyncStorage.setItem(key, value);
    }),

  removeItem: (key) =>
    guard(key, 'remove', undefined, async () => {
      await AsyncStorage.removeItem(key);
    }),
};