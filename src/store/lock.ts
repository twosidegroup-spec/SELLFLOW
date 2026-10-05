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
  readPasscodeLength,
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
  /**
   * How many digits this account's passcode has, or `null` when it is unknown.
   *
   * `null` happens when the record was written before lengths were persisted.
   * The unlock screen then asks for an explicit Continue instead of guessing,
   * because guessing 4 made longer passcodes impossible to enter.
   */
  length: number | null;

  hydrate: (userId: string | undefined) => Promise<void>;
  setPasscode: (
    userId: string,
    passcode: string,
    lengths?: readonly number[],
  ) => Promise<{ ok: boolean; message: string }>;
  clearPasscode: (userId: string) => Promise<void>;
  /**
   * `lockedOut` is surfaced rather than folded into the message because the
   * consequence is different: the record is gone, so the screen has to offer the
   * account password instead of another few tries that cannot work.
   */
  unlock: (
    userId: string,
    passcode: string,
  ) => Promise<{ ok: boolean; message: string; lockedOut: boolean }>;
  lockNow: () => void;
  markOffered: () => void;
  reset: () => void;
}

export const useLock = create<LockState>((set, get) => ({
  hasPasscode: false,
  isLocked: false,
  isReady: false,
  isOffered: false,
  length: null,

  /**
   * Reads the stored state for the signed-in user.
   *
   * The user id is part of the state so a sign-in as somebody else cannot leave
   * the previous user's lock flag behind, which would either lock the new user
   * out or unlock the old one.
   */
  hydrate: async (userId) => {
    if (!userId) {
      set({ hasPasscode: false, isLocked: false, isReady: true, isOffered: false, length: null });
      return;
    }

    /*
     * Read the stored state, but never let a read failure block the app.
     *
     * Both reads go through expo-secure-store, which is backed by the Android
     * Keystore -- and the Keystore fails in ways nothing in our control predicts:
     * `KeyPermanentlyInvalidatedException` after the seller changes their lock
     * screen or re-enrols a biometric, `UserNotAuthenticatedException` when the
     * device has been locked, and outright corruption on some OEM ROMs.
     *
     * Unhandled, that rejection is fatal in the worst possible way. `isReady`
     * never becomes true, `(app)/_layout` sits on `if (!isLockReady) return
     * <LoadingState />` forever, and the caller is `void hydrateLock(userId)` --
     * a floating promise, so nothing is reported anywhere. The result is an app
     * that opens to a permanently blank screen with no crash, no error and no way
     * out. That is exactly what a broken Keystore looks like to a seller, and it
     * is not recoverable without reinstalling.
     *
     * So a failed read resolves as "no passcode stored" and the seller gets in.
     * That is a deliberate trade: the passcode is a local guard against handing
     * your unlocked phone to someone, while the Supabase session is the actual
     * account credential. Refusing to open the app protects nothing that the
     * sign-in does not already protect, and bricking the app protects the seller
     * from nothing at all.
     *
     * It also does not create a passcode, does not clear one, and does not mark
     * setup as offered -- only this one read is abandoned.
     */
    let present = false;
    let length: number | null = null;

    try {
      [present, length] = await Promise.all([hasPasscode(userId), readPasscodeLength(userId)]);
    } catch (error) {
      // The error name only. A Keystore failure message can carry the alias and
      // key material, and none of it belongs in a log or on a screen.
      if (__DEV__) {
        console.warn(
          `[lock] passcode read failed for ${userId}: ${
            error instanceof Error ? error.name : 'unknown'
          }. Continuing without the local passcode lock.`,
        );
      }
    }

    set({
      hasPasscode: present,
      // A stored passcode means the next entry has to clear it.
      isLocked: present,
      isReady: true,
      length,
    });
  },

  setPasscode: async (userId, passcode, lengths) => {
    const check = validatePasscode(passcode, lengths);
    if (!check.ok) return { ok: false, message: check.message };
    await storePasscode(userId, passcode, lengths);
    // Setting it deliberately unlocks: the seller has just proved they know it.
    set({ hasPasscode: true, isLocked: false, isOffered: true, length: passcode.length });
    return { ok: true, message: '' };
  },

  clearPasscode: async (userId) => {
    await clearStoredPasscode(userId);
    set({ hasPasscode: false, isLocked: false, isOffered: true, length: null });
  },

  unlock: async (userId, passcode) => {
    const result = await verifyPasscode(userId, passcode);
    if (result.ok) {
      set({ isLocked: false });
      return { ok: true, message: '', lockedOut: false };
    }

    /*
     * A lockout stays locked.
     *
     * This used to clear `hasPasscode` and `isLocked` when `result.lockedOut` was
     * true, on the theory that the record had been wiped so the flags should follow.
     * That was the same bug one layer up: the limiter deleted the record on the
     * fifth guess, so the sixth call reported success and the store then unlocked
     * the app. `verifyPasscode` no longer deletes anything, so clearing the flag
     * here would hand out access that the keystore is still actively refusing --
     * the lockout screen would show and the rest of the app would be reachable.
     *
     * Staying locked is also the correct behaviour independent of the history: a
     * refused passcode must not become a granted one on a later render.
     */
    if (result.lockedOut) {
      // `isLocked` stays true on purpose. Nothing else changes.
    }

    return { ok: false, message: result.message, lockedOut: result.lockedOut };
  },

  lockNow: () => {
    if (get().hasPasscode) set({ isLocked: true });
  },

  markOffered: () => set({ isOffered: true }),

  reset: () =>
    set({ hasPasscode: false, isLocked: false, isReady: false, isOffered: false, length: null }),
}));