/**
 * Registration and passcode, run against the real production sources.
 *
 * `src/features/registration/plan.ts`, `src/lib/passcode.ts` and the number
 * normaliser are imported unmodified through `scripts/test-loader.mjs`. Only the
 * outside world is stood in for: the keystore (expo-secure-store, which is what
 * the real app uses) and the backend (injected dependency functions).
 *
 * The behaviours worth protecting here are not cosmetic. They are:
 *
 *   - registration cannot report success it did not achieve
 *   - a partial receiving-account failure keeps the accounts that worked
 *   - payment automation is never "active" without a confirmed account AND the
 *     OS permission
 *   - a 6-digit passcode is actually enterable (it was not: the unlock screen
 *     submitted on the 4th digit, so the last two were unreachable and every try
 *     burned one of five attempts)
 *   - a passcode length recorded before lengths were stored degrades to an
 *     explicit Continue rather than a wrong guess
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  automationCopy,
  buildAccountPlan,
  deriveAutomation,
  hasErrors,
  runRegistration,
  validateRegistration,
} from '@/features/registration/plan';
import {
  PASSCODE_LENGTHS,
  isPasscodeLength,
  readPasscodeLength,
  validatePasscode,
} from '@/lib/passcode';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

/** @returns {import('@/features/registration/plan').RegistrationPlan} */
function plan(overrides = {}) {
  return {
    email: 'seller@example.com',
    password: 'correct horse battery',
    fullName: 'Rahim Uddin',
    businessName: 'Apex Traders',
    storeName: null,
    passcodeLength: 4,
    passcode: '4821',
    accounts: [{ provider: 'bkash', accountNumber: '01712345678', label: null }],
    ...overrides,
  };
}

/** Records every call so ordering and partial failure can be asserted. */
/** @returns {{ deps: import('@/features/registration/plan').RegistrationDeps, calls: string[], created: {provider: string, number: string, orgId: string}[] }} */
function deps(overrides = {}) {
  const calls = [];
  /** @type {{provider: string, number: string, orgId: string}[]} */
  const created = [];

  const base = {
    createAccount: async () => {
      calls.push('createAccount');
      return USER_ID;
    },
    bootstrapBusiness: async () => {
      calls.push('bootstrapBusiness');
      return ORG_ID;
    },
    createPaymentAccount: async (account, orgId) => {
      calls.push(`createPaymentAccount:${account.provider}`);
      created.push({ provider: account.provider, number: account.accountNumber, orgId });
    },
    setPasscode: async () => {
      calls.push('setPasscode');
    },
    refreshWorkspace: async () => {
      calls.push('refreshWorkspace');
    },
    requestSmsPermission: async () => {
      calls.push('requestSmsPermission');
      return 'granted';
    },
  };

  // An override must not blind the recorder, or "was this call attempted?" stops
  // being answerable -- which is exactly what the partial-failure tests ask.
  const wrapped = { ...base };
  for (const [name, override] of Object.entries(overrides)) {
    wrapped[name] = async (...args) => {
      if (name === 'createPaymentAccount') {
        calls.push(`createPaymentAccount:${args[0].provider}`);
      } else {
        calls.push(name);
      }
      return override(...args);
    };
  }

  return { deps: wrapped, calls, created };
}

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

test('registration: a complete plan has no errors', () => {
  assert.equal(hasErrors(validateRegistration(plan())), false);
});

test('registration: every required field is checked', () => {
  const errors = validateRegistration(
    plan({ email: '', password: '', fullName: '', businessName: '', accounts: [] }),
  );
  assert.equal(errors.email, 'Enter your email address.');
  assert.equal(errors.password, 'Choose a password.');
  assert.equal(errors.fullName, 'Enter your full name.');
  assert.equal(errors.businessName, 'Enter your business or page name.');
  assert.equal(errors.accounts, 'Choose at least one payment method.');
});

test('registration: malformed email is rejected, whitespace is trimmed', () => {
  assert.match(validateRegistration(plan({ email: 'not-an-email' })).email, /does not look like/);
  assert.equal(validateRegistration(plan({ email: '  seller@example.com  ' })).email, undefined);
});

test('registration: a short password is rejected', () => {
  assert.match(validateRegistration(plan({ password: 'short' })).password, /at least 8/);
});

test('registration: at least one receiving account is required', () => {
  assert.equal(validateRegistration(plan({ accounts: [] })).accounts, 'Choose at least one payment method.');
});

test('registration: an invalid receiving number names the provider that is wrong', () => {
  const errors = validateRegistration(
    plan({
      accounts: [
        { provider: 'bkash', accountNumber: '01712345678', label: null },
        { provider: 'nagad', accountNumber: '12345', label: null },
      ],
    }),
  );
  assert.match(errors.accounts, /nagad/);
});

// ---------------------------------------------------------------------------
// Account planning
// ---------------------------------------------------------------------------

test('account plan: canonicalises every typed form to 01XXXXXXXXX', () => {
  const built = buildAccountPlan(
    ['bkash', 'nagad', 'rocket', 'upay'],
    {
      bkash: '+8801712345678',
      nagad: '01812345678',
      rocket: '8801912345678',
      upay: '0171 234 5678',
    },
  );
  assert.deepEqual(
    built.map((a) => a.accountNumber),
    ['01712345678', '01812345678', '01912345678', '01712345678'],
  );
});

test('account plan: a provider with an unusable number is dropped, not sent broken', () => {
  const built = buildAccountPlan(['bkash', 'nagad'], { bkash: '01712345678', nagad: '' });
  assert.equal(built.length, 1);
  assert.equal(built[0].provider, 'bkash');
});

test('account plan: the same number may serve two providers', () => {
  const built = buildAccountPlan(['bkash', 'nagad'], { bkash: '01712345678', nagad: '01712345678' });
  assert.equal(built.length, 2);
});

// ---------------------------------------------------------------------------
// Execution order and success truthfulness
// ---------------------------------------------------------------------------

test('registration: stages run in dependency order', async () => {
  const { deps: d, calls } = deps();
  const result = await runRegistration({ plan: plan(), deps: d });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    'createAccount',
    'bootstrapBusiness',
    'createPaymentAccount:bkash',
    'setPasscode',
    'refreshWorkspace',
    'requestSmsPermission',
  ]);
});

test('registration: the receiving account is created against the new organisation', async () => {
  const { deps: d, created } = deps();
  await runRegistration({ plan: plan(), deps: d });
  assert.equal(created.length, 1);
  assert.equal(created[0].orgId, ORG_ID);
  assert.equal(created[0].number, '01712345678');
});

test('registration: one provider', async () => {
  const { deps: d } = deps();
  const result = await runRegistration({
    plan: plan({ accounts: [{ provider: 'bkash', accountNumber: '01712345678', label: null }] }),
    deps: d,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.connected, ['bkash']);
});

test('registration: two providers', async () => {
  const { deps: d, calls } = deps();
  const result = await runRegistration({
    plan: plan({
      accounts: [
        { provider: 'bkash', accountNumber: '01712345678', label: null },
        { provider: 'nagad', accountNumber: '01812345678', label: null },
      ],
    }),
    deps: d,
  });
  assert.equal(result.ok, true);
  assert.equal(result.connected.length, 2);
  assert.ok(calls.includes('createPaymentAccount:nagad'));
});

test('registration: three providers', async () => {
  const { deps: d } = deps();
  const result = await runRegistration({
    plan: plan({
      accounts: [
        { provider: 'bkash', accountNumber: '01712345678', label: null },
        { provider: 'nagad', accountNumber: '01812345678', label: null },
        { provider: 'rocket', accountNumber: '01912345678', label: null },
      ],
    }),
    deps: d,
  });
  assert.equal(result.ok, true);
  assert.equal(result.connected.length, 3);
});

test('registration: all four providers', async () => {
  const { deps: d } = deps();
  const result = await runRegistration({
    plan: plan({
      accounts: [
        { provider: 'bkash', accountNumber: '01712345678', label: null },
        { provider: 'nagad', accountNumber: '01812345678', label: null },
        { provider: 'rocket', accountNumber: '01912345678', label: null },
        { provider: 'upay', accountNumber: '01612345678', label: null },
      ],
    }),
    deps: d,
  });
  assert.equal(result.ok, true);
  assert.equal(result.connected.length, 4);
});

// ---------------------------------------------------------------------------
// Failure: never claim more than happened
// ---------------------------------------------------------------------------

test('registration: a failed account call is NOT success', async () => {
  const { deps: d } = deps({
    createPaymentAccount: async () => {
      throw new Error('duplicate key value violates unique constraint');
    },
  });
  const result = await runRegistration({ plan: plan(), deps: d });

  assert.equal(result.ok, false, 'a rejected receiving account must not read as success');
  assert.equal(result.connected.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].provider, 'bkash');
});

test('registration: a partial failure keeps the accounts that worked', async () => {
  const { deps: d } = deps({
    createPaymentAccount: async (account) => {
      if (account.provider === 'nagad') throw new Error('network unreachable');
    },
  });
  const result = await runRegistration({
    plan: plan({
      accounts: [
        { provider: 'bkash', accountNumber: '01712345678', label: null },
        { provider: 'nagad', accountNumber: '01812345678', label: null },
        { provider: 'upay', accountNumber: '01612345678', label: null },
      ],
    }),
    deps: d,
  });

  assert.equal(result.ok, false, 'one failure among three is still a failed registration');
  assert.deepEqual(result.connected, ['bkash', 'upay'], 'the two that persisted are kept');
  assert.equal(result.failed[0].provider, 'nagad');
});

test('registration: one bad account does not stop the others being attempted', async () => {
  const { deps: d, calls } = deps({
    createPaymentAccount: async (account) => {
      if (account.provider === 'bkash') throw new Error('boom');
    },
  });
  await runRegistration({
    plan: plan({
      accounts: [
        { provider: 'bkash', accountNumber: '01712345678', label: null },
        { provider: 'nagad', accountNumber: '01812345678', label: null },
      ],
    }),
    deps: d,
  });
  assert.ok(calls.includes('createPaymentAccount:bkash'));
  assert.ok(calls.includes('createPaymentAccount:nagad'), 'nagad must still be attempted');
});

test('registration: a failed account creation stops before the workspace is trusted', async () => {
  const { deps: d, calls } = deps({
    createPaymentAccount: async () => {
      throw new Error('nope');
    },
  });
  const result = await runRegistration({ plan: plan(), deps: d });
  assert.equal(result.ok, false);
  assert.equal(result.automation, 'needs_attention');
  assert.ok(calls.includes('refreshWorkspace'));
});

test('registration: signUp failure stops immediately and creates nothing', async () => {
  const { deps: d, calls, created } = deps({
    createAccount: async () => {
      throw new Error('User already registered');
    },
  });
  const result = await runRegistration({ plan: plan(), deps: d });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'account');
  assert.equal(result.userId, null);
  assert.equal(created.length, 0, 'no payment account may exist without a user');
  assert.equal(calls.includes('bootstrapBusiness'), false);
  assert.match(result.message, /already registered/);
});

test('registration: a business failure stops before any receiving account', async () => {
  const { deps: d, calls, created } = deps({
    bootstrapBusiness: async () => {
      throw new Error('insufficient_stock');
    },
  });
  const result = await runRegistration({ plan: plan(), deps: d });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'business');
  assert.equal(created.length, 0);
  assert.equal(calls.includes('createPaymentAccount:bkash'), false);
});

test('registration: a workspace read failure is reported, not swallowed', async () => {
  const { deps: d } = deps({
    refreshWorkspace: async () => {
      throw new Error('PGRST116');
    },
  });
  const result = await runRegistration({ plan: plan(), deps: d });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'workspace');
  assert.match(result.message, /PGRST116/);
});

test('registration: a passcode write failure does not fake success and does not abort', async () => {
  const { deps: d, calls } = deps({
    setPasscode: async () => {
      throw new Error('keystore unavailable');
    },
  });
  const result = await runRegistration({ plan: plan(), deps: d });

  // The business and its receiving account are real, so registration succeeded.
  assert.equal(result.ok, true);
  assert.deepEqual(result.connected, ['bkash']);
  // And the workspace was still refreshed, i.e. the passcode did not abort the run.
  assert.ok(calls.includes('refreshWorkspace'));
});

// ---------------------------------------------------------------------------
// Resumability
// ---------------------------------------------------------------------------

test('registration: a retry does not re-create the user or the business', async () => {
  const { deps: d, calls } = deps({
    createPaymentAccount: async (account) => {
      if (account.provider === 'nagad') throw new Error('timeout');
    },
  });
  const accounts = [
    { provider: 'bkash', accountNumber: '01712345678', label: null },
    { provider: 'nagad', accountNumber: '01812345678', label: null },
  ];

  const first = await runRegistration({ plan: plan({ accounts }), deps: d });
  assert.equal(first.ok, false);

  // The retry knows the user, the business and bKash already exist.
  const second = await runRegistration({
    plan: plan({ accounts }),
    deps: d,
    existingUserId: first.userId,
    existingOrgId: first.orgId,
    alreadyConnected: first.connected,
  });

  assert.equal(calls.filter((c) => c === 'createAccount').length, 1, 'signUp must happen once');
  assert.equal(calls.filter((c) => c === 'bootstrapBusiness').length, 1, 'business must happen once');
  assert.equal(
    calls.filter((c) => c === 'createPaymentAccount:bkash').length,
    1,
    'a connected provider must not be re-sent, or it would hit the unique index',
  );
});

// ---------------------------------------------------------------------------
// Automation truthfulness
// ---------------------------------------------------------------------------

test('automation: active requires a confirmed account AND granted permission', () => {
  assert.equal(deriveAutomation(1, 'granted'), 'active');
  assert.equal(deriveAutomation(4, 'granted'), 'active');
});

test('automation: no account is never active', () => {
  assert.equal(deriveAutomation(0, 'granted'), 'needs_attention');
  assert.equal(deriveAutomation(0, 'denied'), 'needs_attention');
});

test('automation: a denied permission leaves it waiting, not active and not broken', () => {
  assert.equal(deriveAutomation(2, 'denied'), 'waiting_for_permission');
});

test('automation: an unavailable platform is manual-only, not "waiting for permission"', () => {
  // Asking for a permission that cannot exist on this platform would be nonsense.
  assert.equal(deriveAutomation(2, 'unavailable'), 'manual_only');
});

test('automation: any failed account blocks the active claim', () => {
  assert.equal(deriveAutomation(2, 'granted', 1), 'needs_attention');
});

test('automation: every state has honest copy', () => {
  for (const state of ['active', 'waiting_for_permission', 'manual_only', 'needs_attention']) {
    const copy = automationCopy(state);
    assert.ok(copy.title.length > 0);
    assert.ok(copy.body.length > 0);
  }
  assert.match(automationCopy('waiting_for_permission').title, /waiting/i);
  assert.doesNotMatch(automationCopy('manual_only').title, /active/i);
});

test('automation: denied permission still completes registration', async () => {
  const { deps: d } = deps({ requestSmsPermission: async () => 'denied' });
  const result = await runRegistration({ plan: plan(), deps: d });

  assert.equal(result.ok, true, 'declining a permission must not fail registration');
  assert.deepEqual(result.connected, ['bkash']);
  assert.equal(result.permission, 'denied');
  assert.equal(result.automation, 'waiting_for_permission');
});

test('automation: a throwing permission prompt degrades to manual-only', async () => {
  const { deps: d } = deps({
    requestSmsPermission: async () => {
      throw new Error('no such module');
    },
  });
  const result = await runRegistration({ plan: plan(), deps: d });
  assert.equal(result.ok, true);
  assert.equal(result.automation, 'manual_only');
});

// ---------------------------------------------------------------------------
// Passcode
// ---------------------------------------------------------------------------

test('passcode: only 4 and 6 digits may be chosen', () => {
  assert.deepEqual([...PASSCODE_LENGTHS], [4, 6]);
  assert.equal(validatePasscode('4821', PASSCODE_LENGTHS).ok, true);
  assert.equal(validatePasscode('482137', PASSCODE_LENGTHS).ok, true);
  assert.equal(validatePasscode('48213', PASSCODE_LENGTHS).ok, false);
  assert.equal(validatePasscode('4821379', PASSCODE_LENGTHS).ok, false);
});

test('passcode: the chosen-length message is exact about the choice', () => {
  assert.match(validatePasscode('48213', PASSCODE_LENGTHS).message, /4 or 6/);
});

test('passcode: non-digits, repeats and runs are still refused', () => {
  assert.equal(validatePasscode('abcd', PASSCODE_LENGTHS).ok, false);
  assert.equal(validatePasscode('1111', PASSCODE_LENGTHS).ok, false);
  assert.equal(validatePasscode('1234', PASSCODE_LENGTHS).ok, false);
  assert.equal(validatePasscode('4321', PASSCODE_LENGTHS).ok, false);
  assert.equal(validatePasscode('1357', PASSCODE_LENGTHS).ok, true);
});

test('passcode: legacy 4-8 digit values still verify (backwards compatibility)', () => {
  // Records written before the 4/6 choice existed can be any length 4-8, and
  // must keep unlocking. Tightening validation here would lock those sellers out.
  for (const code of ['4821', '48213', '482137', '4821379', '48213795']) {
    assert.equal(validatePasscode(code).ok, true, `${code} must remain valid`);
  }
});

test('passcode length: recorded, and readable back', async () => {
  const { setPasscode: store, readPasscodeLength: read, hasPasscode } = await import('@/lib/passcode');
  const user = 'user-length-4';
  await store(user, '4821', PASSCODE_LENGTHS);
  assert.equal(await read(user), 4);
  assert.equal(await hasPasscode(user), true);

  const user6 = 'user-length-6';
  await store(user6, '482137', PASSCODE_LENGTHS);
  assert.equal(await read(user6), 6);
});

test('passcode length: is null with no passcode and for an unknown user', async () => {
  const { readPasscodeLength: read } = await import('@/lib/passcode');
  assert.equal(await read('nobody-at-all'), null);
  assert.equal(await read(undefined), null);
});

test('passcode length: an unknown length is reported, never guessed as 4', async () => {
  const { readPasscodeLength: read } = await import('@/lib/passcode');
  // A record with no `length` field -- what version 1 wrote.
  const SecureStore = await import('expo-secure-store');
  await SecureStore.setItemAsync(
    'sellflow.passcode.user-legacy',
    JSON.stringify({
      version: 1,
      salt: 'aa',
      hash: 'bb',
      updatedAt: new Date().toISOString(),
    }),
  );

  assert.equal(
    await read('user-legacy'),
    null,
    'guessing 4 here is the bug that made 6-digit passcodes unenterable',
  );
});

test('passcode length: only 4 and 6 pass isPasscodeLength', () => {
  assert.equal(isPasscodeLength(4), true);
  assert.equal(isPasscodeLength(6), true);
  assert.equal(isPasscodeLength(5), false);
  assert.equal(isPasscodeLength(8), false);
});

test('passcode: a 6-digit passcode is accepted end to end, and 5 attempts are not burned', async () => {
  const { setPasscode: store, verifyPasscode } = await import('@/lib/passcode');
  const user = 'user-six-digits';
  await store(user, '482137', PASSCODE_LENGTHS);

  // The bug: submitting at 4 digits produced a hash mismatch. Verify that the
  // full six digits are what is needed and what succeeds.
  const truncated = await verifyPasscode(user, '4821');
  assert.equal(truncated.ok, false, 'the first four digits must not unlock a six-digit passcode');

  const full = await verifyPasscode(user, '482137');
  assert.equal(full.ok, true, 'the six digits the seller chose must unlock');
  assert.equal(full.remaining, 5, 'the truncated try must not have consumed a second attempt');
});
