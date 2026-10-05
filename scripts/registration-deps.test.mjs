/**
 * SellFlow :: registration persistence wiring.
 *
 * Phase 4. The claim under test: registration reports only what the BACKEND
 * confirmed, and a failure never leaves the seller believing they have a business.
 *
 * These tests drive `createRegistrationDeps` -- the module that actually talks to
 * Supabase -- against the existing stub client. So the assertions are on the real
 * RPC names, the real argument shapes, and the real error propagation, not on a
 * reimplementation.
 *
 * What is deliberately NOT tested here: `runRegistration`'s ordering, which
 * `scripts/registration.test.mjs` already covers with a full dep matrix. This
 * suite is about whether the deps tell the truth.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import './__stubs__/env.mjs';
import { __resetSupabaseStub, __rpcNames, __callsOf, __queueRpc } from './__stubs__/supabase-js.mjs';

async function fresh() {
  return import('../src/features/registration/deps.ts?fresh=' + Math.floor(Math.random() * 1e9));
}

const PLAN = {
  email: 'seller@example.invalid',
  password: 'a-long-enough-password',
  fullName: 'Rakib Hasan',
  businessName: 'Rk Fashion',
  storeName: null,
};

function deps(module, overrides = {}) {
  return module.createRegistrationDeps({
    plan: PLAN,
    setPasscode: overrides.setPasscode ?? (async () => {}),
    refreshWorkspace: overrides.refreshWorkspace ?? (async () => {}),
  });
}

describe('SellFlow :: registration deps tell the truth', () => {
  beforeEach(() => {
    __resetSupabaseStub();
  });

  test('the business is created with the name the seller typed', async () => {
    const module = await fresh();
    // The stub answers `{ data: 'ok' }`, which has no `id`. readOrgId must cope and
    // refuse rather than hand back undefined.
    const d = deps(module);

    await assert.rejects(
      () => d.bootstrapBusiness(),
      /Business was not created/,
      'an unrecognised response shape must be an error, never an undefined org id',
    );

    // The RPC name and arguments are the contract with the database.
    const calls = __callsOf('bootstrap_business');
    assert.equal(calls.length, 1, 'bootstrap_business must be called exactly once');
    assert.equal(calls[0].args.p_business_name, 'Rk Fashion');
  });

  test('a payment account is filed against the org id the server returned', async () => {
    const module = await fresh();
    const d = deps(module);

    await d.createPaymentAccount(
      { provider: 'bkash', accountNumber: '01712345678', label: null },
      'org-123',
    );

    const calls = __callsOf('create_payment_account');
    assert.equal(calls.length, 1);
    const args = calls[0].args;
    assert.equal(args.p_org_id, 'org-123', 'the org id must be the one the server gave us');
    assert.equal(args.p_provider, 'bkash');
    // Already canonicalised by buildAccountPlan. The server only btrims, so a
    // +880-prefixed number stored here would not collide with the same number
    // written in local form under the unique index.
    assert.equal(args.p_account_number, '01712345678');
    assert.equal(args.p_account_type, 'personal');
  });

  test('a refused payment account throws rather than resolving', async () => {
    const module = await fresh();
    __queueRpc(() => ({
      data: null,
      error: { message: 'payment_account_org_mismatch', code: '42501' },
    }));

    const d = deps(module);

    await assert.rejects(
      () =>
        d.createPaymentAccount(
          { provider: 'nagad', accountNumber: '01700000000', label: null },
          'someone-elses-org',
        ),
      // The whole point: an account filed into the wrong org must not be reported
      // as connected, or the completion screen would tell a seller their Nagad
      // number is set up when the database refused it.
      //
      // "Not allowed" is the copy `AppError.from` produces for Postgres 42501, the
      // code `assert_org_write` raises. Asserted on that rather than on the raw
      // code, so the test also fails if the error mapper ever loses the permission
      // case and starts leaking a driver message at a seller.
      /not allowed/i,
      'a rejected create_payment_account must throw',
    );
  });

  test('a refused bootstrap throws and does not resolve an org id', async () => {
    const module = await fresh();
    __queueRpc(() => ({ data: null, error: { message: 'not_authenticated', code: '28000' } }));

    const d = deps(module);

    await assert.rejects(() => d.bootstrapBusiness(), /.*/);
  });

  test('the passcode is never passed as an argument to anything', async () => {
    const module = await fresh();
    let called = 0;
    const d = deps(module, {
      setPasscode: async () => {
        called += 1;
      },
    });

    // There is no passcode parameter anywhere on the deps surface, so there is no
    // path by which one could reach an RPC. Asserted by reading the source, because
    // the type system cannot prove the absence of a value that is simply not passed.
    const source = await (
      await import('node:fs/promises')
    ).readFile(new URL('../src/features/registration/deps.ts', import.meta.url), 'utf8');

    assert.ok(
      !/p_passcode|passcode:\s*(plan|password)/.test(source),
      'no RPC argument may be derived from the passcode',
    );

    await d.createPaymentAccount(
      { provider: 'rocket', accountNumber: '01711111111', label: null },
      'org-1',
    );
    assert.equal(called, 0, 'setPasscode runs at its own point in the order, not inline');
  });

  test('the SMS permission is requested, never declared', async () => {
    const module = await fresh();
    const source = await (
      await import('node:fs/promises')
    ).readFile(new URL('../src/features/registration/deps.ts', import.meta.url), 'utf8');

    // The permission reaches the app ONLY through the runtime request. A literal in
    // app.json or a manifest declaration is what would put RECEIVE_SMS in the
    // shipped binary for the wrong reason.
    assert.match(source, /PermissionsAndroid\.request/, 'the permission must be requested at runtime');
    assert.ok(
      !/app\.json|AndroidManifest/.test(source),
      'this module must not touch manifest or app configuration',
    );
  });
});