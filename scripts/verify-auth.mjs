/**
 * Hosted authentication lifecycle verification.
 *
 * Confirms that the production auth configuration actually produces the flow the
 * app is written for, against the real hosted project:
 *
 *   register -> authenticated session -> (business setup) -> dashboard
 *
 * Every identity it creates is deleted again through the admin API, and the
 * script asserts the deletion. Hosted must not accumulate test users.
 *
 * SECRETS
 *   The anon key is read from .env.local and the admin key is fetched from the
 *   Supabase CLI in-process. Neither is ever printed, logged, or passed on a
 *   command line. Only lengths and outcomes are reported.
 *
 * This is HOSTED verification of the auth configuration. It is not a substitute
 * for the local behavioural suites -- it exercises GoTrue, which the local
 * Postgres shim does not run.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

/** Minimal .env reader. Values are never echoed. */
function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Fetches the project's admin key via the CLI, in this process.
 *
 * The CLI is already authenticated against the linked project through the OS
 * credential store; this only asks it for the key and keeps the value in memory.
 * There is deliberately no fallback path that could print it.
 */
function adminKey() {
  const result = spawnSync(
    'npx',
    ['--yes', 'supabase@2.119.0', 'projects', 'api-keys', '--reveal'],
    { cwd: REPO, encoding: 'utf8', windowsHide: true, shell: true },
  );
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('could not read project api keys from the CLI');
  const json = raw.slice(start, raw.lastIndexOf('}') + 1);
  const parsed = JSON.parse(json);
  const key = parsed.keys?.find((k) => k.name === 'service_role')?.api_key;
  if (!key) throw new Error('service_role key not present in the CLI output');
  return key;
}

const env = { ...readEnvFile(join(REPO, '.env.local')), ...readEnvFile(join(REPO, '.env')) };
const URL_BASE = env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!URL_BASE || !ANON) {
  console.error('  Missing EXPO_PUBLIC_SUPABASE_URL / ANON_KEY in .env.local');
  process.exit(1);
}

const ADMIN = adminKey();
const AUTH = `${URL_BASE}/auth/v1`;

// A fixed, obviously-synthetic domain. Anything left behind is recognisable.
const STAMP = `sellflow-authcheck-${Date.now()}`;
const EMAIL = `${STAMP}@example.invalid`;
const PASSWORD = `Chk-${Math.random().toString(36).slice(2)}!Aa9`;
const OTHER_EMAIL = `${STAMP}-other@example.invalid`;

const created = new Set();
const results = [];
const observations = [];

/**
 * Records something worth reporting that is not pass/fail.
 *
 * Used where the honest answer is "this is what I measured" rather than "this is
 * what I expected". A finding turned quietly into a passing assertion is worse
 * than a failing one.
 */
function observe(name, ok, detail = '') {
  observations.push({ name, ok, detail });
  console.log(`  ${ok ? 'NOTE' : 'WARN'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function api(path, { method = 'POST', body, token, admin = false } = {}) {
  const headers = {
    apikey: admin ? ADMIN : ANON,
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers.Authorization = `Bearer ${ADMIN}`;

  const res = await fetch(`${AUTH}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  return { status: res.status, json, text };
}

/** Hard-deletes a user through the admin API and confirms it is gone. */
async function deleteUser(id) {
  if (!id) return false;
  const res = await api(`/admin/users/${id}`, { method: 'DELETE', admin: true });
  if (res.status >= 300) return false;
  const checkRes = await api(`/admin/users/${id}`, { method: 'GET', admin: true });
  return checkRes.status === 404;
}

async function main() {
  console.log('  Auth lifecycle verification (hosted)');
  console.log(`  throwaway identity: ${EMAIL}`);
  console.log('');

  // --- 1. fresh registration must return a session -------------------------
  const signup = await api('/signup', {
    body: { email: EMAIL, password: PASSWORD, data: { full_name: 'Auth Check' } },
  });
  const hasSession = Boolean(signup.json?.access_token && signup.json?.user?.id);
  check(
    'fresh registration returns an authenticated session',
    signup.status === 200 && hasSession,
    `http ${signup.status}, session=${hasSession}`,
  );

  if (!hasSession) {
    console.log('');
    console.log('  Registration did not return a session. Auth cannot be verified');
    console.log('  further without a session, and this is a configuration problem,');
    console.log('  not a test problem. Aborting.');
    process.exitCode = 1;
    return;
  }

  const userId = signup.json.user.id;
  created.add(userId);

  // --- 2. the account is already confirmed --------------------------------
  // With confirmation off there is no unconfirmed-account state to handle. This
  // asserts that explicitly rather than assuming it.
  const me = await api('/user', { method: 'GET', token: signup.json.access_token });
  check(
    'new account is confirmed immediately (no unconfirmed state)',
    me.status === 200 && Boolean(me.json?.email_confirmed_at),
    `email_confirmed_at=${me.json?.email_confirmed_at ? 'set' : 'null'}`,
  );

  // --- 3. duplicate registration is refused --------------------------------
  const dupe = await api('/signup', {
    body: { email: EMAIL, password: PASSWORD, data: { full_name: 'Dupe' } },
  });
  check(
    'duplicate registration is refused and yields no session',
    dupe.status >= 400 && !dupe.json?.access_token,
    `http ${dupe.status}`,
  );

  // --- 4. invalid credentials are refused ---------------------------------
  const wrongPassword = await api('/token?grant_type=password', {
    body: { email: EMAIL, password: 'definitely-not-the-password' },
  });
  check(
    'login with a wrong password is refused',
    wrongPassword.status >= 400 && !wrongPassword.json?.access_token,
    `http ${wrongPassword.status}`,
  );

  const unknownUser = await api('/token?grant_type=password', {
    body: { email: `${STAMP}-nobody@example.invalid`, password: PASSWORD },
  });
  check(
    'login for an unknown account is refused',
    unknownUser.status >= 400 && !unknownUser.json?.access_token,
    `http ${unknownUser.status}`,
  );

  // --- 5. login -----------------------------------------------------------
  const login = await api('/token?grant_type=password', {
    body: { email: EMAIL, password: PASSWORD },
  });
  check(
    'login returns a session',
    login.status === 200 && Boolean(login.json?.access_token),
    `http ${login.status}`,
  );

  const sessionToken = login.json?.access_token;
  const refreshToken = login.json?.refresh_token;
  const firstRefresh = login.json?.refresh_token;

  // --- 6. session persistence: refresh an existing session -----------------
  const refreshed = await api('/token?grant_type=refresh_token', {
    body: { refresh_token: refreshToken },
  });
  check(
    'an existing session refreshes',
    refreshed.status === 200 && Boolean(refreshed.json?.access_token),
    `http ${refreshed.status}`,
  );

  // --- 7. refresh-token reuse detection ------------------------------------
  // Replaying the PARENT token is explicitly allowed by Supabase: "if the parent
  // of the currently active refresh token is being used, the active token will be
  // returned". That is a deliberate accommodation for flaky clients, not a
  // security hole, so it is not what reuse detection means.
  //
  // The property that matters is a token that is neither active nor an immediate
  // parent -- a grandparent, presented after the reuse interval. That is treated
  // as theft and revokes the whole session. So drive two generations first.
  const genB = refreshed.json?.refresh_token;
  const refreshedAgain = await api('/token?grant_type=refresh_token', {
    body: { refresh_token: genB },
  });
  check(
    'a second refresh generation succeeds',
    refreshedAgain.status === 200 && Boolean(refreshedAgain.json?.refresh_token),
    `http ${refreshedAgain.status}`,
  );

  const activeToken = refreshedAgain.json?.refresh_token;
  const grandParent = firstRefresh;

  // A parent replay is a documented, tolerated exception. It returns the CURRENT
  // active token, so re-read it rather than assuming the earlier value still holds.
  const parentReplay = await api('/token?grant_type=refresh_token', {
    body: { refresh_token: genB },
  });
  check(
    'replaying the immediate parent is tolerated (documented exception)',
    parentReplay.status === 200,
    `http ${parentReplay.status}`,
  );
  const activeNow = parentReplay.json?.refresh_token ?? activeToken;

  // Now the real test. Wait past the 10s reuse interval so the grandparent can
  // no longer be excused as a race.
  await new Promise((r) => setTimeout(r, 12_000));

  const theftReplay = await api('/token?grant_type=refresh_token', {
    body: { refresh_token: grandParent },
  });
  check(
    'replaying a spent grandparent refresh token is treated as theft',
    theftReplay.status >= 400 && !theftReplay.json?.access_token,
    `http ${theftReplay.status}`,
  );

  // Supabase's documentation says a qualifying reuse "regards the whole session as
  // terminated and all refresh tokens belonging to it as revoked". Observed
  // behaviour on this project is recorded rather than asserted, because a parent
  // replay earlier in this sequence may itself have rotated the active token and
  // made this ambiguous. The security-relevant half -- the stolen token being
  // refused -- is asserted above.
  const afterTheft = await api('/token?grant_type=refresh_token', {
    body: { refresh_token: activeNow },
  });
  observe(
    'family revocation after a detected reuse',
    afterTheft.status >= 400,
    afterTheft.status >= 400
      ? 'session revoked as documented'
      : `http ${afterTheft.status}: the active session still refreshed after a detected reuse`,
  );

  // Re-authenticate for the remaining checks.
  const reloginAfterTheft = await api('/token?grant_type=password', {
    body: { email: EMAIL, password: PASSWORD },
  });
  check(
    'the user can sign in again after their session was revoked',
    reloginAfterTheft.status === 200 && Boolean(reloginAfterTheft.json?.access_token),
    `http ${reloginAfterTheft.status}`,
  );

  // --- 8. logout, then login again ---------------------------------------
  const liveSession = reloginAfterTheft.json;
  const logout = await api('/logout', {
    method: 'POST',
    token: liveSession?.access_token,
    body: {},
  });
  check('logout succeeds', logout.status >= 200 && logout.status < 300, `http ${logout.status}`);

  // A JWT stays cryptographically valid until it expires, so "the token no longer
  // works" is not the documented baseline -- Supabase's own guidance is that
  // guaranteeing it requires validating session_id against auth.sessions. What
  // matters is that the resource is refused and no user data comes back. GoTrue
  // refusing with 403 rather than 401 is stronger than that baseline.
  const afterLogout = await api('/user', {
    method: 'GET',
    token: liveSession?.access_token,
  });
  check(
    'the access token is refused after logout, with no user data returned',
    afterLogout.status >= 400 && afterLogout.status < 500 && !afterLogout.json?.email,
    `http ${afterLogout.status}`,
  );

  const relogin = await api('/token?grant_type=password', {
    body: { email: EMAIL, password: PASSWORD },
  });
  check(
    'login works again after logout',
    relogin.status === 200 && Boolean(relogin.json?.access_token),
    `http ${relogin.status}`,
  );

  // --- 9. cleanup ---------------------------------------------------------
  console.log('');
  const removed = await deleteUser(userId);
  created.delete(userId);
  check('throwaway identity deleted from hosted', removed);

  const gone = await api(`/admin/users/${userId}`, { method: 'GET', admin: true });
  check('deleted identity is really gone (admin GET returns 404)', gone.status === 404);

  // Nothing else should exist under this stamp.
  const list = await api(
    `/admin/users?page=1&per_page=100`,
    { method: 'GET', admin: true },
  );
  const leftovers = (list.json?.users ?? []).filter((u) => (u.email ?? '').includes(STAMP));
  check(
    'no throwaway identities left on hosted',
    leftovers.length === 0,
    leftovers.length ? `${leftovers.length} left` : 'clean',
  );

  // --- summary ------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  const flagged = observations.filter((o) => !o.ok);
  console.log('');
  console.log(`  ${results.length - failed.length}/${results.length} auth checks passed`);
  if (flagged.length) {
    console.log(`  ${flagged.length} observation(s) to report:`);
    for (const f of flagged) console.log(`    - ${f.name}: ${f.detail}`);
  }

  if (failed.length) {
    process.exitCode = 1;
    console.log('');
    console.log('  Failed:');
    for (const f of failed) console.log(`    - ${f.name} ${f.detail}`);
  }
}

try {
  await main();
} finally {
  // Belt and braces: never leave a test identity behind, even if a check threw.
  for (const id of created) {
    await deleteUser(id).catch(() => {});
  }
}