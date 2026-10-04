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
}

export function __dumpSecureStore() {
  return Object.fromEntries(store);
}

export async function getItemAsync(key) {
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
