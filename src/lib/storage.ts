/**
 * Local persistence.
 *
 * Thin wrapper over AsyncStorage. Everything the app caches lives under a
 * versioned key prefix so a schema change can invalidate stale caches without
 * a migration path through old shapes.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'sellflow:v1:';

export const StorageKeys = {
  appearance: `${PREFIX}appearance`,
  activeStore: `${PREFIX}active-store`,
  pendingMutations: `${PREFIX}pending-mutations`,
  lastSyncAt: `${PREFIX}last-sync`,
  onboardingSeen: `${PREFIX}onboarding-seen`,
} as const;

export async function readString(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    // A cache miss is always safe to treat as "no value"; a storage failure must
    // never take the app down.
    return null;
  }
}

export async function writeString(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    // Losing a cache write degrades the offline experience but must not break
    // the current screen.
  }
}

export async function remove(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // Same rationale as above.
  }
}

export async function readJson<T>(key: string): Promise<T | null> {
  const raw = await readString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt cache: drop it rather than crash on every launch.
    await remove(key);
    return null;
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  await writeString(key, JSON.stringify(value));
}
