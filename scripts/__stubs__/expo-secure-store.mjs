/**
 * Platform keystore, in memory.
 *
 * `src/lib/passcode.ts` is the real production source and it reaches for
 * `expo-secure-store`, which is a native module with no Node build. This stands in
 * for exactly that module and nothing else -- `src/lib/passcode.ts` itself is
 * imported unmodified, so the hashing, the salting, the timing-safe comparison
 * and the attempt counting under test are the shipping code.
 *
 * The real module on Android is backed by the hardware keystore. What that buys
 * and what it does not is documented at the top of `src/lib/passcode.ts`; this
 * fake has the same *interface*, not the same security, and the tests make no
 * claim about the latter.
 */

/** keychainAccessible values, so a test can assert what was requested. */
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';

const store = new Map();

/** Every write, so a test can assert the accessibility option was passed. */
export const writes = [];

export function __resetSecureStore() {
  store.clear();
  writes.length = 0;
  failures.read = null;
  failures.write = null;
}

/**
 * Keys that exist, for tests that need to inspect the whole record rather than
 * guess a suffix. Used by the passcode lockout suite to assert that no stored
 * value contains the raw passcode.
 */
export function __secureStoreKeys() {
  return [...store.keys()];
}

export function __dumpSecureStore() {
  return Object.fromEntries(store);
}

/**
 * Set to make the next read or write throw, the way a real keystore does after a
 * biometric re-enrolment. Cleared by `__resetSecureStore`.
 *
 * A control channel rather than monkey-patching the export: an ES module
 * namespace object is frozen, so assigning to `getItemAsync` throws.
 */
export const failures = { read: null, write: null };

export function __failNext(kind, error) {
  failures[kind] = error ?? new Error(`${kind} failed`);
}

export async function getItemAsync(key) {
  if (failures.read) {
    const error = failures.read;
    failures.read = null;
    throw error;
  }
  return store.has(key) ? store.get(key) : null;
}

export async function setItemAsync(key, value, options) {
  store.set(key, value);
  writes.push({ key, options: options ?? null });
}

export async function deleteItemAsync(key) {
  store.delete(key);
}

export async function isAvailableAsync() {
  return true;
}
