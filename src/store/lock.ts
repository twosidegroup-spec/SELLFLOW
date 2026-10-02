/**
 * Passcode lock state.
 *
 * Separate from the session store on purpose: the session answers "who is signed
 * in", this answers "is this device currently unlocked". Conflating them would
 * mean locking a user out of their account, which is not what a screen lock does.
 */

import { create } from 'zustand';

import {
  clearPasscode as clearStoredPasscode,
  hasPasscode,
  setPasscode as storePasscode,
  validatePasscode,
  verifyPasscode,
} from '@/lib/passcode';

interface LockState {
  /** True when a passcode exists for the signed-in user. */
  hasPasscode: boolean;
  /** True when the app must be unlocked before the workspace is usable. */
  isLocked: boolean;
  /** False until the stored passcode has been read, so the gate cannot flash open. */
  isReady: boolean;
  /** Set once the seller chooses to skip or complete setup. */
  isOffered: boolean;

  hydrate: (userId: string | undefined) => Promise<void>;
  setPasscode: (userId: string, passcode: string) => Promise<{ ok: boolean; message: string }>;
  clearPasscode: (userId: string) => Promise<void>;
  unlock: (userId: string, passcode: string) => Promise<{ ok: boolean; message: string }>;
  lockNow: () => void;
  markOffered: () => void;
  reset: () => void;
}

export const useLock = create<LockState>((set, get) => ({
  hasPasscode: false,
  isLocked: false,
  isReady: false,
  isOffered: false,

  /**
   * Reads the stored state for the signed-in user.
   *
   * The user id is part of the state so a sign-in as somebody else cannot leave
   * the previous user's lock flag behind, which would either lock the new user
   * out or unlock the old one.
   */
  hydrate: async (userId) => {
    if (!userId) {
      set({ hasPasscode: false, isLocked: false, isReady: true, isOffered: false });
      return;
    }
    const present = await hasPasscode(userId);
    set({
      hasPasscode: present,
      // A stored passcode means the next entry has to clear it.
      isLocked: present,
      isReady: true,
    });
  },

  setPasscode: async (userId, passcode) => {
    const check = validatePasscode(passcode);
    if (!check.ok) return { ok: false, message: check.message };
    await storePasscode(userId, passcode);
    // Setting it deliberately unlocks: the seller has just proved they know it.
    set({ hasPasscode: true, isLocked: false, isOffered: true });
    return { ok: true, message: '' };
  },

  clearPasscode: async (userId) => {
    await clearStoredPasscode(userId);
    set({ hasPasscode: false, isLocked: false, isOffered: true });
  },

  unlock: async (userId, passcode) => {
    const result = await verifyPasscode(userId, passcode);
    if (result.ok) {
      set({ isLocked: false });
      return { ok: true, message: '' };
    }
    // A lockout wipes the record server-side of the keystore, so reflect that.
    if (result.lockedOut) {
      set({ hasPasscode: false, isLocked: false });
    }
    return { ok: false, message: result.message };
  },

  lockNow: () => {
    if (get().hasPasscode) set({ isLocked: true });
  },

  markOffered: () => set({ isOffered: true }),

  reset: () => set({ hasPasscode: false, isLocked: false, isReady: false, isOffered: false }),
}));