/**
 * Stub for `@react-native-async-storage/async-storage`.
 *
 * A Map that can be wiped, which is how a test simulates the process being
 * killed: clearing it leaves only whatever the app was told to persist, and a
 * fresh module instance re-reads it as a cold start would.
 */

let store = new Map();

export const __resetAsyncStorage = () => {
  store = new Map();
};

/** Snapshot of everything currently persisted. */
export const __dumpAsyncStorage = () => Object.fromEntries(store);

export const getItem = async (key) => (store.has(key) ? store.get(key) : null);

export const setItem = async (key, value) => {
  store.set(key, value);
};

export const removeItem = async (key) => {
  store.delete(key);
};

export const getAllKeys = async () => [...store.keys()];

export const clear = async () => {
  store = new Map();
};

export const multiRemove = async (keys) => {
  for (const key of keys) store.delete(key);
};

export default {
  getItem,
  setItem,
  removeItem,
  getAllKeys,
  clear,
  multiRemove,
};
