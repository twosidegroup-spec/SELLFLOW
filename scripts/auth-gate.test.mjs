/**
 * SellFlow :: authentication and the lock gate.
 *
 * Phase 5. Two things are guarded here, and the second is the one that actually
 * bites.
 *
 * 1. SIGN-IN TRUTHFULNESS. Wrong credentials, a dead network and a valid session must
 *    produce three different and distinguishable outcomes. A screen that reports a
 *    network failure as "wrong password" sends a seller to reset a password that
 *    was fine.
 *
 * 2. THE LOCK GATE. `(app)` renders nothing while a passcode lock stands. That is
 *    the property that stops business data being on screen when the phone is handed
 *    to someone else, so it is asserted directly rather than inferred.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import './__stubs__/env.mjs';
import { __resetAsyncStorage, __dumpAsyncStorage } from './__stubs__/async-storage.mjs';
import { __resetSecureStore, __secureStoreKeys } from './__stubs__/expo-secure-store.mjs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

/** Comments stripped, so a file explaining a rule is not read as breaking it. */
const code = (relative) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');

describe('SellFlow :: sign-in', () => {
  beforeEach(() => {
    __resetAsyncStorage();
    __resetSecureStore();
  });

  test('it authenticates against Supabase, not against anything local', () => {
    const src = code('../src/app/sign-in.tsx');

    assert.match(
      src,
      /auth\.signInWithPassword/,
      'sign-in must call the real Supabase auth path',
    );

    // The disqualifiers. A sign-in form that could succeed without a server is a
    // form that will tell a seller they are signed in when they are not.
    for (const forbidden of ['mockUser', 'demoAccount', 'localSignIn', 'TEST_PASSWORD']) {
      assert.ok(
        !src.includes(forbidden),
        `sign-in must not contain a local or demo auth path: ${forbidden}`,
      );
    }
  });

  test('it never reveals whether an email exists', () => {
    const src = code('../src/app/sign-in.tsx');

    // GoTrue answers "Invalid login credentials" for both cases. This screen must
    // pass that through rather than branching on it into a different message,
    // which would make the form an account-enumeration oracle.
    assert.match(
      src,
      /AppError\.from\(error\)/,
      'a credential error must be rendered through the shared mapper, unchanged',
    );
    assert.ok(
      !/no such (user|account)|does not exist|not found|unknown email/i.test(src),
      'sign-in must not branch on whether the account exists',
    );
  });

  test('it never logs or transmits the password anywhere but the request', () => {
    const src = read('../src/app/sign-in.tsx');

    // The password appears in exactly one place it should: the auth call body.
    assert.ok(
      !/console\.(log|warn|error|info|debug)[\s\S]{0,200}password/i.test(src),
      'the password must never reach a console call',
    );
    assert.ok(
      !/setItem|writeString|writeJson/.test(src),
      'sign-in must not persist the password to any store',
    );

    /*
     * The password must reach exactly one place: the `signInWithPassword` body. A
     * second transmission would mean it was being sent somewhere else as well.
     *
     * Both the shorthand (`password,`) and the explicit (`password: x`) form are
     * counted, because both are correct style and only the destination matters.
     */
    const signInCalls = src.match(/signInWithPassword\(/g) ?? [];
    assert.equal(signInCalls.length, 1, 'exactly one sign-in request');

    assert.match(
      src,
      /signInWithPassword\(\{\s*email:\s*email\.trim\(\),\s*password,?\s*\}\)/s,
      'the request body must be exactly the email and the password, and nothing else',
    );

    // No second destination: no fetch, no rpc, no analytics call carrying it.
    assert.ok(
      !/fetch\(/.test(src) && !/\.rpc\(/.test(src),
      'sign-in must make no other network call that could carry the password',
    );
  });

  test('a valid session that cannot read a business does not become a sign-out', () => {
    const src = code('../src/app/sign-in.tsx');

    // `handleSession` sets `workspace-unavailable` for a live session whose business
    // cannot be read. Routing that to sign-in is the V1 bug: it told a seller with a
    // working password that they had been signed out.
    assert.match(src, /handleSession/, 'sign-in must resolve the session through the store');
    assert.match(
      src,
      /workspace-unavailable|router\.replace\('\/'\)/,
      "a workspace failure must route back to the entry route, not to sign-in",
    );
  });

  test('a fresh sign-in re-locks the device', () => {
    const src = code('../src/app/sign-in.tsx');

    // Without this, signing in as a different person on a shared device opens the
    // app already unlocked under the previous user's identity.
    assert.match(src, /lockNow\(\)/, 'sign-in must lock the passcode gate again');
  });

  test('forgot-password does not enumerate accounts either', () => {
    const src = code('../src/app/forgot-password.tsx');

    assert.match(src, /resetPasswordForEmail/, 'it must use the real reset request');

    /*
     * "If an account exists for X" is the CORRECT phrasing -- it is what makes the
     * response non-enumerable. What must not appear is a message that states the
     * outcome as fact, because that is a different string for the two cases.
     */
    assert.match(src, /If an account exists/, 'the copy must be conditional');
    for (const forbidden of [/we found your account/i, /no account/i, /unknown address/i, /this email is not registered/i]) {
      assert.ok(
        !forbidden.test(src),
        `an outcome-stating message would enumerate accounts: ${forbidden}`,
      );
    }

    // The screen must offer exactly ONE outcome for a request that was not a
    // transport error. Two success paths are how a future edit reintroduces
    // enumeration, so the count is asserted rather than assumed.
    const requestCalls = src.match(/resetPasswordForEmail\(/g) ?? [];
    assert.equal(requestCalls.length, 1, 'exactly one reset request');
    assert.match(src, /Check your email/i, 'it must say what to do next');
  });
});

describe('SellFlow :: the passcode gate', () => {
  beforeEach(() => {
    __resetAsyncStorage();
    __resetSecureStore();
  });

  test('(app) renders nothing while locked, and redirects instead', () => {
    const src = code('../src/app/(app)/_layout.tsx');

    assert.match(
      src,
      /if \(hasPasscode && isLocked\) return <Redirect href="\/passcode" \/>/,
      'the gate must redirect before any child screen is mounted',
    );

    /*
     * Order matters and the type system cannot check it. The lock redirect must come
     * AFTER the auth outcomes, because a signed-out seller has no passcode to unlock
     * and would be bounced to a keypad instead of to sign-in.
     */
    const signedOut = src.indexOf("status === 'signed-out'");
    const locked = src.indexOf('hasPasscode && isLocked');
    assert.ok(signedOut > -1 && locked > -1);
    assert.ok(
      signedOut < locked,
      'auth outcomes must be resolved before the passcode gate, or a signed-out seller sees a keypad',
    );
  });

  test('the lock is held on a loading state until the keystore answers', () => {
    const src = code('../src/app/(app)/_layout.tsx');

    // Rendering the keypad before knowing whether a passcode exists flashes it at a
    // seller who never set one.
    const notReady = src.indexOf('!isLockReady');
    const locked = src.indexOf('hasPasscode && isLocked');
    assert.ok(notReady > -1 && locked > -1);
    assert.ok(notReady < locked, 'isLockReady must be checked before the lock redirect');
  });

  test('the unlock screen reads the stored length and never assumes 4', () => {
    const src = code('../src/app/passcode.tsx');

    // Assuming 4 made a six-digit passcode impossible to enter: the keypad submitted
    // on the fourth digit and swallowed the rest.
    assert.match(src, /readPasscodeLength/, 'the length must be read from the keystore');
    assert.ok(
      !/length = 4\b(?!;)/.test(src.replace(/useState<PasscodeLength>\(\d+\)/g, '')),
      'the length must not be hardcoded to 4',
    );
    assert.match(
      src,
      /stored === 4 \|\| stored === 6/,
      'only the two legal lengths may be adopted, and an unknown one must be ignored',
    );
  });

  test('the unlock screen goes through the store, so one place owns the lock state', () => {
    const src = code('../src/app/passcode.tsx');

    // Two paths setting isLocked is how the gate and the keypad come to disagree
    // about whether the app is open.
    assert.match(
      src,
      /useLock\.getState\(\)\.unlock\(/,
      'verification must run through the store',
    );
    assert.ok(
      !/verifyPasscode\(/.test(src),
      'the screen must not call verifyPasscode directly; that is the store\'s job',
    );
    assert.ok(
      !/set\(\{[^}]*isLocked/.test(src),
      'the screen must never set isLocked itself',
    );
  });

  test('a locked-out seller is told the account password is the way out', () => {
    const src = read('../src/lib/passcode.ts');

    // Every locked-out message, not just the one that starts the lockout. The person
    // who needs the way out is the one reading the countdown.
    const lockedMessages = [...src.matchAll(/lockedOut:\s*true,[\s\S]{0,200}?message:\s*`([^`]+)`/g)];
    assert.ok(lockedMessages.length >= 1, 'expected at least one locked-out message');

    for (const match of lockedMessages) {
      assert.match(
        match[1],
        /password/i,
        `a locked-out message must name the account password: "${match[1]}"`,
      );
    }
  });

  test('the cooldown count reads the policy rather than restating it', () => {
    const src = code('../src/app/passcode.tsx');

    // If the screen hardcoded 30000 and the policy changed to 60000, the countdown
    // would promise a shorter wait than actually exists and then keep re-locking.
    assert.match(src, /PASSCODE_LOCKOUT_MS/, 'the countdown must come from the policy');
    assert.ok(
      !/\b30_?000\b/.test(src),
      'the screen must not restate the cooldown in milliseconds',
    );
  });

  test('the stored record is namespaced per user, so accounts cannot share a lock', () => {
    const src = read('../src/lib/passcode.ts');

    assert.match(src, /sellflow\.passcode\./, 'the keystore key must be prefixed per account');

    // The user id is interpolated into the key, so it must be sanitised first. An
    // unsanitised id containing a `.` would collide with the `.failed` and
    // `.lockedUntil` sidecars and let one account overwrite another's lockout state.
    assert.match(
      src,
      /secureKey\s*=\s*\(userId: string\)\s*=>\s*`\$\{KEY_PREFIX\}\$\{userId\.replace\(/,
      'the user id must be sanitised before it becomes a key fragment',
    );
    assert.match(
      src,
      /\[\^A-Za-z0-9\._-\]/,
      'sanitisation must strip every character that is not key-safe',
    );
  });

  test('two accounts on one device keep independent records', async () => {
    const passcode = await import(
      '../src/lib/passcode.ts?fresh=' + Math.floor(Math.random() * 1e9)
    );

    const alice = 'aaaaaaaa-1111-1111-1111-111111111111';
    const bob = 'bbbbbbbb-2222-2222-2222-222222222222';

    await passcode.setPasscode(alice, '4829', [4, 6]);
    await passcode.setPasscode(bob, '9173', [4, 6]);

    const keys = __secureStoreKeys();
    const aliceKey = keys.find((k) => k.includes('aaaaaaaa'));
    const bobKey = keys.find((k) => k.includes('bbbbbbbb'));

    assert.ok(aliceKey, "alice's record must exist under her own key");
    assert.ok(bobKey, "bob's record must exist under his own key");
    assert.notEqual(aliceKey, bobKey, 'two accounts must not share a keystore record');

    // Bob's passcode must not open Alice's lock.
    assert.equal((await passcode.verifyPasscode(alice, '9173')).ok, false);
    assert.equal((await passcode.verifyPasscode(bob, '9173')).ok, true);
  });
});

describe('SellFlow :: session persistence', () => {
  beforeEach(() => {
    __resetAsyncStorage();
    __resetSecureStore();
  });

  test('the client is given a durable storage adapter, not memory', () => {
    const src = code('../src/lib/supabase.ts');

    // The defect that made every cold start ask for email and password again.
    assert.match(
      src,
      /storage:\s*sessionStorage/,
      'the client must be given an explicit storage adapter; without one auth-js uses memory on a device',
    );
  });

  test('the adapter writes through to the real store', async () => {
    const { sessionStorage } = await import(
      '../src/lib/sessionStorage.ts?fresh=' + Math.floor(Math.random() * 1e9)
    );

    await sessionStorage.setItem('sb-sellflow-auth-token', '{"access_token":"a"}');
    assert.ok(
      'sb-sellflow-auth-token' in __dumpAsyncStorage(),
      'the session must reach the durable store, not just an adapter-internal cache',
    );

    // A restart is a fresh module over the same bytes.
    const afterRestart = await import(
      '../src/lib/sessionStorage.ts?fresh=' + Math.floor(Math.random() * 1e9)
    );
    const restored = await afterRestart.sessionStorage.getItem('sb-sellflow-auth-token');
    assert.equal(restored, '{"access_token":"a"}', 'the session must survive a restart');
  });
});
