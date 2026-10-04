/**
 * Builds the authenticated web dashboard into `website/dist/app/`.
 *
 * The marketing site and the dashboard are one deployment but two builds. This is
 * the dashboard half, and it is deliberately separate from `build.mjs` rather than
 * folded into it:
 *
 *  - `build.mjs` wipes `dist/` and is the fast path. Coupling a ~90s Metro export
 *    into it would make every marketing copy tweak slow, and a failed export
 *    would take the public site down with it.
 *  - Order matters. Run `build.mjs` first (it deletes `dist/`), then this.
 *
 * What it produces is the *existing Expo app* rendered by react-native-web. No
 * second frontend, no duplicated business logic, no duplicated design system: the
 * same screens, hooks, queries and theme tokens the Android APK ships. It reads
 * and writes the same Supabase project through the same anon key, so Row Level
 * Security is what isolates a tenant here exactly as it does on the device.
 *
 * Run:
 *   node website/build-dashboard.mjs
 *
 * Env:
 *   EXPO_ROUTER_BASE_PATH   subpath to mount at. Defaults to /app, which is what
 *                           the Vercel rewrite and the marketing nav assume.
 *   SELLFLOW_SKIP_DASHBOARD set to 1 to make this a no-op (used by the site-only
 *                           release path, where the dashboard is unchanged).
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DIST = join(HERE, 'dist');
const TARGET = join(DIST, 'app');
const STAGING = join(HERE, '.dashboard-build');

const BASE_PATH = (process.env.EXPO_ROUTER_BASE_PATH ?? '/app').trim() || '/app';

if (process.env.SELLFLOW_SKIP_DASHBOARD === '1') {
  console.log('build-dashboard: SELLFLOW_SKIP_DASHBOARD=1, leaving dist/app untouched.');
  process.exit(0);
}

const fail = (message) => {
  console.error(`\nbuild-dashboard: ${message}\n`);
  process.exit(1);
};

/**
 * The marketing build must have run first.
 *
 * `build.mjs` starts with `rmSync(DIST)`, so a dashboard build that ran first
 * would be deleted by the next marketing build with no warning. Checking for the
 * public entry point turns that silent data loss into a build failure.
 */
if (!existsSync(join(DIST, 'index.html'))) {
  fail(
    'website/dist/index.html is missing. Run `node website/build.mjs` first -- it clears dist/.',
  );
}

/*
 * The Supabase project, resolved explicitly.
 *
 * Expo loads `.env.local` *before* `.env` and `.env.local` wins. That is right for
 * app development -- it is how you point a phone at a local stack -- and wrong for
 * this build, because the dashboard's env is compiled into the bundle rather than
 * read at runtime.
 *
 * The failure is silent and total: the export succeeds, the sign-in page renders
 * perfectly, and every login fails with "Incorrect email or password" because the
 * browser is talking to `http://127.0.0.1:54321`. A deployed dashboard would ship
 * that way, and it would look like bad credentials rather than bad configuration.
 *
 * So the values are resolved here and handed to the child process, which no dotenv
 * file can then override:
 *
 *   1. The environment, which is how CI supplies them.
 *   2. `.env`, the developer's hosted-project config.
 *
 * A local address is refused outright unless ALLOW_LOCAL_SUPABASE=1, because
 * "works on my machine" is exactly how this bug gets committed.
 */
const LOCAL_HOSTS = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(:\d+)?/i;

function readDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const dotEnv = readDotEnv(join(REPO, '.env'));

const SUPABASE_URL = (
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  dotEnv.EXPO_PUBLIC_SUPABASE_URL ??
  ''
).trim();
const SUPABASE_ANON_KEY = (
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  dotEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  ''
).trim();

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  fail(
    'No Supabase configuration for the dashboard.\n' +
      '  Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in the\n' +
      '  environment, or put them in .env at the repository root.\n' +
      '  This build will not guess: a dashboard compiled against the wrong project\n' +
      '  accepts no logins and reports it as a bad password.',
  );
}

if (LOCAL_HOSTS.test(SUPABASE_URL) && process.env.ALLOW_LOCAL_SUPABASE !== '1') {
  fail(
    `Refusing to build a dashboard against ${SUPABASE_URL}.\n` +
      '  That is a local Supabase stack. The dashboard is a deployed artefact: it\n' +
      '  would render, then reject every sign-in as an incorrect password.\n' +
      '  Set the hosted project in EXPO_PUBLIC_SUPABASE_URL, or pass\n' +
      '  ALLOW_LOCAL_SUPABASE=1 if you really are testing against local.',
  );
}

console.log(`build-dashboard: Supabase ${new URL(SUPABASE_URL).host}`);

/*
 * The local Expo CLI, run through the current node binary.
 *
 * Not `npx`: on Windows `execFileSync` has to go through `npx.cmd`, which fails
 * intermittently for reasons that have nothing to do with this build, and paying
 * npx's resolution cost on a ~3 minute command is pure waste. Running the CLI
 * entry directly is both faster and the same code path `npx expo` would take.
 */
const expoCli = join(REPO, 'node_modules', 'expo', 'bin', 'cli');
if (!existsSync(expoCli)) {
  fail('node_modules/expo/bin/cli is missing. Run `npm ci` first.');
}

console.log(`build-dashboard: exporting the web app at ${BASE_PATH} …`);

rmSync(STAGING, { recursive: true, force: true });

try {
  execFileSync(
    process.execPath,
    [expoCli, 'export', '--platform', 'web', '--output-dir', STAGING, '--clear'],
    {
      cwd: REPO,
      stdio: 'inherit',
      env: {
        ...process.env,
        EXPO_ROUTER_BASE_PATH: BASE_PATH,
        EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        EXPO_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
      },
    },
  );
} catch {
  fail('`expo export --platform web` failed. See the output above.');
}

const entry = join(STAGING, 'index.html');
if (!existsSync(entry)) fail('the export produced no index.html.');

/*
 * Verify the base path actually landed, rather than trusting it.
 *
 * This is the one failure mode that would otherwise ship as a page that loads and
 * then 404s its own bundle: an export built without the base path emits absolute
 * `/_expo/...` URLs, which resolve to the marketing site instead of the
 * dashboard. A wrong prefix here is a bug that only shows up in production, so it
 * is checked here.
 */
const html = readFileSync(entry, 'utf8');
const scriptMatch = html.match(/<script[^>]+src="([^"]+)"/);
if (!scriptMatch) fail('the exported index.html has no <script src>, so it is not an app shell.');

const src = scriptMatch[1];
if (!src.startsWith(`${BASE_PATH}/`)) {
  fail(
    `the export emitted ${src} but the dashboard is mounted at ${BASE_PATH}. ` +
      'EXPO_ROUTER_BASE_PATH did not reach expo-router, so every asset URL is wrong.',
  );
}

/*
 * Read the Supabase project back out of the bundle that was actually produced.
 *
 * This is the assertion that catches the `.env.local` trap described above. The
 * child process was handed the right values, but "we passed the right env" is a
 * claim about our intent; "the shipped bytes contain the hosted host" is a fact
 * about the artefact. A bundler that resolved the project some other way would
 * sail past an env check and ship a dashboard that rejects every login.
 */
const bundleName = src.slice(`${BASE_PATH}/`.length);
const bundlePath = join(STAGING, bundleName);
if (!existsSync(bundlePath)) fail(`the exported bundle ${bundleName} is not on disk.`);

const bundle = readFileSync(bundlePath, 'utf8');
const expectedHost = new URL(SUPABASE_URL).host;

if (LOCAL_HOSTS.test(bundle.match(/https?:\/\/[^\s"'`\\]+supabase\.co|127\.0\.0\.1:54321|localhost:54321/)?.[0] ?? '')) {
  fail(
    'the exported bundle points at a local Supabase, not the hosted project.\n' +
      '  Every sign-in would fail as an incorrect password. Check which .env file\n' +
      '  is winning during the export.',
  );
}
if (!bundle.includes(expectedHost)) {
  fail(
    `the exported bundle does not contain the hosted host ${expectedHost}.\n` +
      '  It was built against a different Supabase project than this build resolved.',
  );
}

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(dirname(TARGET), { recursive: true });
cpSync(STAGING, TARGET, { recursive: true });

/*
 * `web.output` is "single", so there is exactly one HTML file and every route is
 * resolved on the client. Recorded next to it so the reason is discoverable from
 * the deployed artifact rather than only from this script.
 */
writeFileSync(
  join(TARGET, 'DEPLOY.txt'),
  [
    'SellFlow web dashboard',
    '',
    `Mounted at: ${BASE_PATH}`,
    'Built from: the Expo app in this repository, rendered by react-native-web.',
    'Backend:   the same Supabase project as the Android APK, via the same anon',
    '           key. Row Level Security is the only thing separating tenants.',
    '',
    'This directory contains a single index.html on purpose (`web.output: "single"`).',
    'Every route below it, including deep links such as /app/orders, is resolved by',
    'the client. The Vercel rewrite in vercel.json sends any /app/* request that',
    'does not match a real file to /app/index.html. Without that rewrite a hard',
    'refresh on a deep link returns 404.',
    '',
    'Do not add raw SMS content to this build. The dashboard reads normalised',
    'payment fields only; the message body never leaves the device that received',
    'it.',
    '',
  ].join('\n'),
);

rmSync(STAGING, { recursive: true, force: true });

const sizeOf = (dir) => {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(full) : statSync(full).size;
  }
  return total;
};

console.log(
  `build-dashboard: wrote ${TARGET} ` +
    `(entry ${src}, ${(sizeOf(TARGET) / 1024 / 1024).toFixed(1)} MB).`,
);
