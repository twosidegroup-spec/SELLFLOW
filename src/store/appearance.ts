/**
 * Appearance preference.
 *
 * Kept in a store rather than local layout state so any screen can change the
 * theme without prop-drilling, and so the root layout has a single source of
 * truth to hydrate from disk before its first themed render.
 */

import { create } from 'zustand';

import { StorageKeys, readJson, writeJson } from '@/lib/storage';
import type { AppearancePreference } from '@/theme/ThemeProvider';

interface AppearanceState {
  preference: AppearancePreference;
  setPreference: (preference: AppearancePreference) => void;
  hydrate: () => Promise<void>;
}

export const useAppearance = create<AppearanceState>((set) => ({
  preference: 'system',

  setPreference: (preference) => {
    set({ preference });
    // Persisted in the background; a failed write only costs the preference on
    // next launch, so it must not block the UI.
    void writeJson(StorageKeys.appearance, preference);
  },

  hydrate: async () => {
    const stored = await readJson<AppearancePreference>(StorageKeys.appearance);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      set({ preference: stored });
    }
  },
}));
