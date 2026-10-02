/**
 * Stub for `expo-network`.
 *
 * Backed by a plain in-memory object the test drives, so connectivity can be
 * toggled exactly as it would be by the OS.
 */

let state = { isConnected: true, isInternetReachable: true };
const listeners = new Set();

export const __setNetworkState = (next) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener(state);
};

export const getNetworkStateAsync = async () => state;

export const addNetworkStateListener = (listener) => {
  listeners.add(listener);
  return {
    remove: () => {
      listeners.delete(listener);
    },
  };
};
