/**
 * SellFlow :: passcode lockout policy.
 *
 * Phase 4. The defect this locks in a fix for:
 *
 * V1 counted wrong guesses and, on the fifth, DELETED the passcode record. That
 * is a rate limiter whose fifth action grants access -- the person holding the
 * phone simply continues into the app. It looked like protection and was the
 * opposite.
 *
 * The policy now:
 *   * counts failures
 *   * after MAX_ATTEMPTS refuses entry for LOCKOUT_MS
 *   * leaves the passcode record INTACT throughout
 *   * reopens automatically when the cooldown expires
 *   * keeps the account password as the real recovery route
 *
 * The load-bearing assertion is the negative one: five wrong guesses must still
 * find the passcode in place and must still be refused.
 *
 * `src/lib/passcode.ts` is imported unmodified. Only the native keystore is
 * stubbed, so the hashing, salting, timing-safe comparison and attempt counting
 * under test are the shipping code.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import './__stubs__/env.mjs';
import * as SecureStore from './__stubs__/expo-secure-store.mjs';

const { __resetSecureStore, __secureStoreKeys, __dumpSecureStore, __failNext } = SecureStore;

/** Fresh module copy, as a cold start would get. */
async function fresh() {
  return import('../src/lib/passcode.ts?fresh=' + Math.floor(Math.random() * 1e9));
}

const USER = '11111111-1111-1111-1111-111111111111';
const GOOD = '482913';

describe('SellFlow :: passcode lockout', () => {
  beforeEach(() => __resetSecureStore());

  test('five wrong guesses are refused AND leave the passcode in place', async () => {
    const m = await fresh();
    await m.setPasscode(USER, GOOD, [4, 6]);

    for (let i = 1; i <= 5; i++) {
      const result = await m.verifyPasscode(USER, '000000');
      assert.equal(result.ok, false, `attempt ${i} must be refused`);
      assert.equal(result.pass, i, `the attempt counter must reach ${i}`);
    }

    // The whole point. V1 returned ok:true here: the fifth attempt had already
    // deleted the record, so the next read found nothing to check against.
    assert.equal(
      await m.hasPasscode(USER),
      true,
      'the passcode must survive five wrong guesses -- wiping it is what granted access',
    );
  });

  test('the correct passcode is refused during the cooldown', async () => {
    const m = await fresh();
    await m.setPasscode(USER, GOOD, [4, 6]);
    for (let i = 0; i < 5; i++) await m.verifyPasscode(USER, '111111');

    const during = await m.verifyPasscode(USER, GOOD);

    assert.equal(during.ok, false, 'even the correct passcode is refused during the cooldown');
    assert.equal(during.lockedOut, true);
    assert.match(during.message, /Try again in \d+s/, `unhelpful message: ${during.message}`);
    // The account password must be named, or a locked-out seller has no route out.
    assert.match(during.message, /password/i, 'the message must offer the account password as a way out');
  });

  test('the entry reopens when the cooldown expires', async () => {
    const m = await fresh();
    await m.setPasscode(USER, GOOD, [4, 6]);
    for (let i = 0; i < 5; i++) await m.verifyPasscode(USER, '111111');

    // Rewind the stored marker instead of sleeping 30 seconds. The key and its
    // format are the production ones, so this exercises the real expiry path.
    const key = __secureStoreKeys().find((k) => k.endsWith('.lockedUntil'));
    assert.ok(key, 'a lockout marker must be stored when the cooldown starts');
    await SecureStore.setItemAsync(key, String(Date.now() - 1), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });

    const after = await m.verifyPasscode(USER, GOOD);
    assert.equal(after.ok, true, 'the cooldown must expire on its own, not permanently lock the seller out');
    assert.equal(after.lockedOut, false);
  });

  test('the cooldown is short enough not to punish a forgetful owner', async () => {
    const m = await fresh();
    assert.equal(m.PASSCODE_LOCKOUT_MS, 30_000);
    assert.equal(m.PASSCODE_ATTEMPTS, 5);
  });

  test('a successful guess clears the counter and the cooldown marker', async () => {
    const m = await fresh();
    await m.setPasscode(USER, GOOD, [4, 6]);

    await m.verifyPasscode(USER, '222222');
    await m.verifyPasscode(USER, '222222');
    const after = await m.verifyPasscode(USER, GOOD);

    assert.equal(after.ok, true, 'the right passcode must work');
    assert.equal(after.remaining, m.PASSCODE_ATTEMPTS, 'the counter must reset on success');
    assert.equal(after.lockedOut, false);
  });

  test('the stored record is never the raw passcode', async () => {
    const m = await fresh();
    await m.setPasscode(USER, GOOD, [4, 6]);

    // Read the record itself rather than a JSON blob of the whole store. The dump
    // JSON-encodes each value, which escapes the inner quotes -- so `"hash"`
    // becomes `\"hash\"` and a substring match silently fails. Reading the value
    // and parsing it is also a stronger assertion: it proves the stored value IS
    // a record, not just that the characters h-a-s-h appear somewhere.
    // The record key is `sellflow.passcode.<sanitised-id>`; the two sidecars end in
    // `.failed` and `.lockedUntil`. Identifying it by "has no dot" is wrong --
    // the key prefix contains dots too -- so it is identified by not being a
    // sidecar.
    const key = __secureStoreKeys().find(
      (k) => !k.endsWith('.failed') && !k.endsWith('.lockedUntil'),
    );
    assert.ok(key, `the passcode record must be stored under the account key; saw ${JSON.stringify(__secureStoreKeys())}`);
    const record = JSON.parse(await SecureStore.getItemAsync(key));

    assert.ok(record.hash && record.salt, 'the record must carry a hash and a salt');
    assert.notEqual(record.hash, GOOD, 'the hash must not be the passcode');
    assert.ok(record.hash.length >= 32, 'the hash must not be a short digest');

    // And across every key the module owns, no value contains the raw passcode.
    const all = JSON.stringify(__dumpSecureStore());
    assert.ok(!all.includes(GOOD), 'the raw passcode must not appear anywhere in the keystore');
  });

  test('clearPasscode also clears the cooldown marker', async () => {
    const m = await fresh();
    await m.setPasscode(USER, GOOD, [4, 6]);
    for (let i = 0; i < 5; i++) await m.verifyPasscode(USER, '333333');
    assert.ok(__secureStoreKeys().some((k) => k.endsWith('.lockedUntil')));

    await m.clearPasscode(USER);

    // A stale lockedUntil would mean the seller's NEXT passcode is born already
    // locked out until a timestamp in the past expires.
    assert.ok(
      !__secureStoreKeys().some((k) => k.endsWith('.lockedUntil')),
      'clearing the passcode must clear the lockout too',
    );
  });

  test('a keystore read failure degrades to unavailable, never to unlocked', async () => {
    const m = await fresh();
    await m.setPasscode(USER, GOOD, [4, 6]);
    // The real failure mode: the keystore drops its key after a biometric
    // re-enrolment, and every read throws until the process restarts. Injected
    // through the stub rather than by patching the export, because an ES module
    // namespace is frozen.
    __failNext('read', new Error('KeyPermanentlyInvalidatedException'));

    const result = await m.verifyPasscode(USER, GOOD);

    assert.equal(result.ok, false, 'an unreadable keystore must not authenticate anyone');
    assert.equal(result.message, 'Passcode unavailable.');
  });
});