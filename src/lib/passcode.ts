/**
 * App passcode.
 *
 * A second lock in front of the account password, used after sign-in. It is not
 * a substitute for the Supabase session -- someone who pulls the session out of
 * device storage still has a valid session -- it protects the everyday case of
 * a borrowed or unattended phone.
 *
 * What actually protects this, stated plainly rather than oversold:
 *   - The record lives only in SecureStore, which on Android is backed by the
 *     hardware keystore. A rooted device cannot read it as plaintext.
 *   - Unlocking still requires a live Supabase session, so the passcode is one
 *     of two factors, not the only one.
 *   - The stored value is salted and hashed, so the passcode itself is not
 *     recoverable from the keystore blob.
 *
 * What it does NOT do: make an 8-digit passcode unguessable offline. No
 * iteration count changes that, because the search space is small by definition.
 * Adding thousands of hash rounds here would be theatre that buys a lockout
 * delay and nothing else, so this uses a single salted SHA-512 and says so.
 *
 * The record is keyed by user id, so two accounts on one phone cannot read or
 * overwrite each other's passcode.
 */

import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const KEY_PREFIX = 'sellflow.passcode.';
const DIGEST = Crypto.CryptoDigestAlgorithm.SHA512;
const MAX_ATTEMPTS = 5;

/**
 * The two lengths a seller can choose.
 *
 * A passcode length has to be *known*, not guessed. The unlock screen used to
 * auto-submit as soon as 4 digits were in, which made a 6, 7 or 8 digit passcode
 * literally impossible to enter: the first four digits were submitted, the rest
 * were swallowed by the in-flight hash, and each attempt burned one of only five
 * lives -- so five tries deleted the passcode and locked the seller out of their
 * own business. The length is now persisted alongside the hash and the keypad
 * waits for exactly that many digits.
 */
export const PASSCODE_LENGTHS = [4, 6] as const;
export type PasscodeLength = (typeof PASSCODE_LENGTHS)[number];
export const DEFAULT_PASSCODE_LENGTH: PasscodeLength = 4;

export interface PasscodeRecord {
  version: 2;
  salt: string;
  hash: string;
  /**
   * How many digits this passcode has. Present from version 2.
   *
   * Records written before this existed have no length. That is not an error to
   * paper over: see {@link readPasscodeLength}, which reports `null` for them and
   * makes the unlock screen fall back to an explicit Continue key rather than
   * guessing a length that would truncate the entry again.
   */
  length?: number;
  updatedAt: string;
}

/** Native SecureStore keys must be alphanumeric plus ".-_". */
const secureKey = (userId: string) => `${KEY_PREFIX}${userId.replace(/[^A-Za-z0-9._-]/g, '_')}`;

function toHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}


/** Salted SHA-512. The separator prevents a passcode being read off the salt. */
async function derive(passcode: string, saltHex: string): Promise<string> {
  return Crypto.digestStringAsync(DIGEST, `${saltHex}:${passcode}`);
}

/** Length-safe, content-safe comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface PasscodeCheck {
  pass: number; // 0-5
  ok: boolean;
  lockedOut: boolean;
  remaining: number;
  message: string;
}

/** Whether a length is one a seller is allowed to pick. */
export function isPasscodeLength(value: number): value is PasscodeLength {
  return (PASSCODE_LENGTHS as readonly number[]).includes(value);
}

/**
 * Validates the shape rules the UI enforces, so the rule lives in one place.
 *
 * `lengths` defaults to accepting any 4-8 digit value, which is what records
 * written before the choice existed used. The registration and setup screens pass
 * `PASSCODE_LENGTHS` so only 4 or 6 can be chosen.
 */
export function validatePasscode(
  passcode: string,
  lengths: readonly number[] = [4, 5, 6, 7, 8],
): { ok: boolean; message: string } {
  if (!/^\d+$/.test(passcode)) return { ok: false, message: 'Digits only.' };

  if (!lengths.includes(passcode.length)) {
    const wanted = lengths.length === 1 ? `${lengths[0]} digits` : `${lengths.join(' or ')} digits`;
    return { ok: false, message: `Use exactly ${wanted}.` };
  }

  if (/^(\d)\1+$/.test(passcode)) {
    return { ok: false, message: 'Do not repeat one digit.' };
  }
  if (isSequential(passcode)) {
    return { ok: false, message: 'Do not use a simple sequence.' };
  }
  return { ok: true, message: '' };
}

/** Rejects 1234, 4321 and their forward/reverse runs. */
function isSequential(passcode: string): boolean {
  const digits = [...passcode].map((c) => Number(c));
  if (digits.length < 3) return false;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < digits.length; i += 1) {
    const prev = digits[i - 1] as number;
    const current = digits[i] as number;
    if (current !== prev + 1) ascending = false;
    if (current !== prev - 1) descending = false;
  }
  return ascending || descending;
}

export async function hasPasscode(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    return (await SecureStore.getItemAsync(secureKey(userId))) !== null;
  } catch {
    // An unreadable keystore must not lock the user out of their own account.
    return false;
  }
}

export async function setPasscode(
  userId: string,
  passcode: string,
  lengths: readonly number[] = PASSCODE_LENGTHS,
): Promise<void> {
  const check = validatePasscode(passcode, lengths);
  if (!check.ok) throw new Error(check.message);

  const salt = toHex(await Crypto.getRandomBytesAsync(16));
  const hash = await derive(passcode, salt);
  const record: PasscodeRecord = {
    version: 2,
    salt,
    hash,
    length: passcode.length,
    updatedAt: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(secureKey(userId), JSON.stringify(record), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await SecureStore.setItemAsync(`${secureKey(userId)}.failed`, '0', {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * How many digits this account's passcode has.
 *
 * Returns `null` when there is no passcode, and also when the stored record
 * predates the length field. The second case is the interesting one: rather than
 * assuming 4, callers get `null` and are expected to ask the seller to press
 * Continue. Assuming 4 is exactly the bug this field was added to remove, so the
 * ambiguity is surfaced instead of resolved by guesswork.
 */
export async function readPasscodeLength(userId: string | undefined): Promise<number | null> {
  if (!userId) return null;
  try {
    const raw = await SecureStore.getItemAsync(secureKey(userId));
    if (!raw) return null;
    const record = JSON.parse(raw) as PasscodeRecord;
    return typeof record.length === 'number' && record.length > 0 ? record.length : null;
  } catch {
    return null;
  }
}

export async function clearPasscode(userId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(secureKey(userId));
    await SecureStore.deleteItemAsync(`${secureKey(userId)}.failed`);
  } catch {
    // Nothing to clear.
  }
}

async function readAttempts(userId: string): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(`${secureKey(userId)}.failed`);
    const n = Number(raw ?? '0');
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeAttempts(userId: string, n: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(`${secureKey(userId)}.failed`, String(n), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch {
    // A failed counter write only weakens throttling; it must not block unlock.
  }
}

/**
 * Verifies a passcode.
 *
 * Failures are counted and the passcode is wiped at MAX_ATTEMPTS. Wiping is the
 * safe default: a passcode someone cannot remember must not be a permanent
 * lockout, and the account password still gets them back in to set a new one.
 */
export async function verifyPasscode(
  userId: string,
  passcode: string,
): Promise<PasscodeCheck> {
  let raw: string | null = null;
  try {
    raw = await SecureStore.getItemAsync(secureKey(userId));
  } catch {
    return { pass: 0, ok: false, lockedOut: false, remaining: 0, message: 'Passcode unavailable.' };
  }
  if (!raw) {
    // No passcode is set, so there is nothing to enforce.
    return { pass: 0, ok: true, lockedOut: false, remaining: MAX_ATTEMPTS, message: '' };
  }

  const attempts = await readAttempts(userId);
  if (attempts >= MAX_ATTEMPTS) {
    return {
      pass: 0,
      ok: false,
      lockedOut: true,
      remaining: 0,
      message: 'Too many attempts. The passcode was removed — sign in again to set a new one.',
    };
  }

  let record: PasscodeRecord;
  try {
    record = JSON.parse(raw) as PasscodeRecord;
  } catch {
    // Corrupt record: treat as absent rather than locking the user out forever.
    await clearPasscode(userId);
    return { pass: 0, ok: true, lockedOut: false, remaining: MAX_ATTEMPTS, message: '' };
  }

  const candidate = await derive(passcode, record.salt);
  if (timingSafeEqual(candidate, record.hash)) {
    await writeAttempts(userId, 0);
    return { pass: 0, ok: true, lockedOut: false, remaining: MAX_ATTEMPTS, message: '' };
  }

  const next = attempts + 1;
  await writeAttempts(userId, next);

  if (next >= MAX_ATTEMPTS) {
    await clearPasscode(userId);
    return {
      pass: 0,
      ok: false,
      lockedOut: true,
      remaining: 0,
      message: 'Too many attempts. The passcode was removed — sign in again to set a new one.',
    };
  }

  const left = MAX_ATTEMPTS - next;
  return {
    pass: next,
    ok: false,
    lockedOut: false,
    remaining: left,
    message: `Incorrect passcode. ${left} attempt${left === 1 ? '' : 's'} left.`,
  };
}

export const PASSCODE_ATTEMPTS = MAX_ATTEMPTS;