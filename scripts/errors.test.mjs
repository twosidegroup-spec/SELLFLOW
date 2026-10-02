/**
 * Error-mapper regression tests.
 *
 * This exists because of a real report: creating an account produced
 * "Connection problem - check your internet connection and try again."
 *
 * The cause was not connectivity. The installed APK had been built before the
 * database schema was deployed, so the first RPC the Home screen calls
 * (`get_dashboard`) did not exist server-side. PostgREST answered PGRST202, the
 * mapper had no entry for it, and the final fallthrough told the seller their
 * internet was broken.
 *
 * That is the failure mode these tests guard: a server REFUSAL must never be
 * reported as a NETWORK fault, because it sends the user to fix the wrong thing.
 */

import './__stubs__/env.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { AppError } = await import('../src/lib/errors.ts?fresh=errors');

/** Builds a shape that matches what supabase-js actually hands the mapper. */
function pgError(code, message, details = null) {
  return { code, message, details, hint: null };
}

/**
 * Builds the shape of a real `AuthApiError`.
 *
 * Reproduced from `signInWithPassword` against a live GoTrue instance:
 *
 *   constructor AuthApiError
 *   own+proto keys  stack, message, __isAuthError, name, status, code
 *   code            'invalid_credentials'
 *   status          400
 *   __isAuthError   true
 *   message         'Invalid login credentials'
 *
 * The earlier fixture for this case was a bare `{ message }` with no `code`,
 * so the loose PostgREST duck-type did not match it and the test passed for the
 * wrong reason -- while the real error, which DOES carry `code`, was routed to
 * the database mapper and told the seller their connection was fine. These
 * fixtures carry every field the real object has.
 */
function authError({ code, status, message, name = 'AuthApiError' }) {
  const e = new Error(message);
  e.name = name;
  e.__isAuthError = true;
  e.status = status;
  e.code = code;
  return e;
}

describe('AppError.from', () => {
  test('an app-level raise is mapped to its own message', () => {
    const error = AppError.from(pgError('P0001', 'insufficient_stock'));
    assert.equal(error.title, 'Not enough stock');
    assert.match(error.action, /stock/i);
  });

  test('PGRST202 is NOT reported as a network problem', () => {
    const error = AppError.from(
      pgError('PGRST202', 'Could not find the function public.get_dashboard in the schema cache'),
    );
    assert.doesNotMatch(error.title, /connection/i);
    assert.doesNotMatch(error.action, /internet/i);
    assert.match(error.title, /temporarily unavailable/i);
  });

  test('PGRST203 overload ambiguity is NOT a network problem', () => {
    const error = AppError.from(
      pgError('PGRST203', 'Could not choose the best function overload for create_order'),
    );
    assert.doesNotMatch(error.action, /internet/i);
  });

  test('an RLS violation is reported as access, not connectivity', () => {
    const error = AppError.from(
      pgError('42501', 'new row violates row-level security policy for table "products"'),
    );
    assert.doesNotMatch(error.title, /connection/i);
    assert.doesNotMatch(error.action, /internet/i);
  });

  test('a 42501 code maps to a permissions message', () => {
    const error = AppError.from(pgError('42501', 'permission denied for function bootstrap_business'));
    assert.match(error.title, /not allowed/i);
  });

  test('an unmapped server rejection never claims a network fault', () => {
    // Nothing matches: unknown code, prose message, no known raise code.
    const error = AppError.from(
      pgError('XX999', 'something entirely unexpected happened inside the database engine'),
    );
    assert.doesNotMatch(error.action, /internet/i);
    assert.doesNotMatch(error.action, /check your internet/i);
    // The server's own wording is carried so the cause is identifiable.
    assert.match(error.action, /something entirely unexpected/);
  });

  test('a genuine network failure IS still reported as a network failure', () => {
    const error = AppError.from(new TypeError('Network request failed'));
    assert.match(error.title, /no connection/i);
    assert.match(error.action, /internet connection/i);
  });

  // -------------------------------------------------------------------------
  // The other direction of the same distinction.
  //
  // supabase-js reports a transport failure as a PostgREST error with an empty
  // `code` and the raw JS error as the message. That shape reaches the mapper
  // looking exactly like a server refusal, and fell through to the last-resort
  // branch, which told a seller with no signal that "your connection is fine --
  // the request was rejected. (TypeError: Failed to fetch)".
  //
  // Two separate lies: the connectivity claim is the opposite of the truth, and
  // a raw exception string was being rendered on the seller's screen.
  // -------------------------------------------------------------------------
  test('a fetch failure arriving as a PostgREST error IS a network fault', () => {
    const error = AppError.from(pgError('', 'TypeError: Failed to fetch'));
    assert.match(error.title, /no connection/i);
    assert.match(error.action, /internet connection/i);
  });

  test('a fetch failure never claims the connection was fine', () => {
    const error = AppError.from(pgError('', 'TypeError: Failed to fetch'));
    assert.doesNotMatch(error.action, /connection is fine/i);
    assert.doesNotMatch(error.action, /request was rejected/i);
  });

  test('a fetch failure never leaks the raw exception into the UI', () => {
    const error = AppError.from(pgError('', 'TypeError: Failed to fetch'));
    assert.doesNotMatch(error.title, /TypeError/);
    assert.doesNotMatch(error.action, /TypeError/);
    assert.doesNotMatch(error.action, /Failed to fetch/);
    // It is still preserved for logging, which is the only place it belongs.
    assert.ok(error.cause, 'the original error must remain available for logging');
  });

  test('a real server response is still not called a network fault', () => {
    // The empty-code check must not swallow a genuine response.
    const error = AppError.from(pgError('PGRST202', 'Could not find the function get_dashboard'));
    assert.doesNotMatch(error.action, /internet/i);
    assert.match(error.title, /temporarily unavailable/i);
  });

  test('auth failures keep their own wording', () => {
    assert.match(
      AppError.from({ message: 'Invalid login credentials' }).title,
      /incorrect email or password/i,
    );
    assert.match(AppError.from({ message: 'Email not confirmed' }).title, /confirm your email/i);
  });

  // -------------------------------------------------------------------------
  // The reported defect.
  //
  // A real `AuthApiError` carries BOTH `code` and `message`, so the loose
  // `isPostgrestError` duck-type matched it, and because that check ran first,
  // every wrong password was handled by the DATABASE mapper. Nothing there
  // recognises "Invalid login credentials", so it fell through to the last
  // resort and the sign-in screen said:
  //
  //   "The server could not complete that
  //    Your connection is fine -- the request was rejected.
  //    (Invalid login credentials)"
  //
  // A seller with a typo was told to check their internet instead of their
  // password, and a raw server string was rendered on the screen.
  // -------------------------------------------------------------------------
  test('a real AuthApiError is auth, not a database error', () => {
    const error = AppError.from(
      authError({ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }),
    );
    assert.match(error.title, /incorrect email or password/i);
  });

  test('a real AuthApiError never blames the connection', () => {
    const error = AppError.from(
      authError({ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }),
    );
    assert.doesNotMatch(error.action, /connection is fine/i);
    assert.doesNotMatch(error.action, /request was rejected/i);
    assert.doesNotMatch(error.title, /could not complete/i);
  });

  test('a real AuthApiError never leaks the raw server string', () => {
    const error = AppError.from(
      authError({ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }),
    );
    assert.doesNotMatch(error.action, /Invalid login credentials/);
    // Still preserved for logging, which is the only place it belongs.
    assert.ok(error.cause, 'the original error must remain available for logging');
  });

  test('the other GoTrue auth codes map to their own wording', () => {
    const cases = [
      [{ code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' }, /confirm your email/i],
      [{ code: 'user_already_exists', status: 400, message: 'User already registered' }, /already registered/i],
      [{ code: 'weak_password', status: 422, message: 'Password should be at least 6 characters' }, /too short/i],
      [{ code: 'over_request_rate_limit', status: 429, message: 'Email rate limit exceeded' }, /too many attempts/i],
      [{ code: 'bad_jwt_token', status: 403, message: 'Invalid Refresh Token: Refresh Token Not Found' }, /session has expired/i],
    ];
    for (const [shape, expected] of cases) {
      const error = AppError.from(authError(shape));
      assert.match(error.title, expected, `${shape.code} -> "${error.title}"`);
      assert.doesNotMatch(error.action, /connection is fine/i, `${shape.code} blamed the connection`);
    }
  });

  test('an unrecognised auth code still gets a real auth message', () => {
    // Not in the table above, but still definitively an auth error.
    const error = AppError.from(
      authError({ code: 'sso_provider_not_found', status: 400, message: 'Single sign-on provider not found' }),
    );
    assert.doesNotMatch(error.action, /connection is fine/i);
    assert.doesNotMatch(error.title, /could not complete/i);
  });

  test('a database error is not stolen by the auth message pattern', () => {
    // 'details' + 'hint' identify a PostgREST error structurally, so a message
    // that happens to contain a short auth-ish word cannot redirect it. These
    // are real SQL messages, not invented ones.
    const stolen = AppError.from(
      pgError('42P01', 'relation "session_log" does not exist'),
    );
    assert.doesNotMatch(stolen.title, /sign you in/i);
    assert.doesNotMatch(stolen.title, /session has expired/i);
    assert.match(stolen.title, /database is not ready/i);
  });

  test('an existing AppError is not re-classified', () => {
    const original = new AppError('Incorrect email or password', 'Check your details and try again.');
    assert.equal(AppError.from(original), original);
  });

  test('reused idempotency key is explained, not blamed on the network', () => {
    const error = AppError.from(pgError('P0001', 'idempotency_key_reused'));
    assert.doesNotMatch(error.action, /internet/i);
    assert.match(error.title, /already recorded/i);
  });

  test('an AppError passes through unchanged', () => {
    const original = new AppError('T', 'A');
    assert.equal(AppError.from(original), original);
  });
});
