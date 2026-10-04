/**
 * Cryptographic primitives, backed by Node.
 *
 * `src/lib/passcode.ts` calls `expo-crypto` for two things: a salted SHA-512 of
 * the passcode, and 16 random bytes for the salt. The real package is a native
 * module with no Node build, so this stands in for it.
 *
 * The substitution is faithful rather than convenient. Node's `createHash
 * ('sha512')` is the same SHA-512 that `expo-crypto` calls into, and it is
 * rendered as lowercase hex, which is what `digestStringAsync` returns. So the
 * production code under test -- the salting, the `salt:passcode` separator, the
 * timing-safe comparison, the attempt counter -- is exercised for real, and a
 * digest computed here matches one computed on a device.
 *
 * What this does NOT claim: that SHA-512 is a good choice for a 4- or 6-digit
 * passcode. It is not, and `src/lib/passcode.ts` says so at length. This file
 * only makes the existing arithmetic runnable under Node.
 */

import { createHash, randomBytes } from 'node:crypto';

/** Mirrors the subset of `CryptoDigestAlgorithm` the app uses. */
export const CryptoDigestAlgorithm = {
  SHA512: 'SHA-512',
  SHA256: 'SHA-256',
};

export async function digestStringAsync(algorithm, data) {
  const nodeName = String(algorithm).toUpperCase().replace('-', '');
  return createHash(nodeName).update(data, 'utf8').digest('hex');
}

export async function getRandomBytesAsync(byteCount) {
  return new Uint8Array(randomBytes(byteCount));
}

export async function getRandomValuesAsync(array) {
  const bytes = randomBytes(array.length);
  array.set(bytes);
  return array;
}

/** Present on the real module; unused by the app but cheap to mirror. */
export async function randomUUID() {
  return crypto.randomUUID();
}
