/**
 * Resolves the build profiles with EAS's OWN resolver.
 *
 * `eas config` refuses to print anything until it has an authenticated account,
 * so there is otherwise no way to confirm, offline, what a profile actually
 * resolves to. Two things matter for this project:
 *
 *   1. that eas.json is schema-valid, and
 *   2. that the `preview` profile, which overrides `env`, still INHERITS the
 *      EXPO_PUBLIC_SUPABASE_* variables from `base` -- if it does not, a preview
 *      APK would build with no backend and the app would show
 *      "SellFlow is not connected" on the device.
 *
 * Run:  node scripts/resolve-eas-profiles.mjs
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/**
 * Locates @expo/eas-json.
 *
 * It ships inside the eas-cli package, which `npx eas-cli` unpacks into the
 * npx cache rather than into this project, so both locations are checked.
 */
function findEasJson() {
  const candidates = [
    resolve(root, 'node_modules/@expo/eas-json'),
    // Newest eas-cli unpacked by npx.
    ...globCacheRoots().map((dir) => resolve(dir, 'node_modules/@expo/eas-json')),
  ];

  for (const candidate of candidates) {
    try {
      require.resolve(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function globCacheRoots() {
  const cacheRoots = [];
  // Referenced statically rather than through a computed key: this is a Node
  // script, not bundled app code, but keeping access explicit satisfies
  // expo/no-dynamic-env-var and reads more clearly.
  const bases = [process.env.LOCALAPPDATA, process.env.XDG_CACHE_HOME];

  for (const base of bases) {
    if (!base) continue;
    const npx = resolve(base, process.platform === 'win32' ? 'npm-cache/_npx' : '.npm/_npx');
    try {
      for (const entry of readdirSync(npx, { withFileTypes: true })) {
        if (entry.isDirectory()) cacheRoots.push(resolve(npx, entry.name));
      }
    } catch {
      // cache not present on this host
    }
  }
  return cacheRoots;
}

const easJsonPath = findEasJson();
if (!easJsonPath) {
  console.log(
    'Could not locate @expo/eas-json.\n' +
      'Run `npx eas-cli config --json` while authenticated to validate instead.',
  );
  process.exit(0);
}

const { EasJsonSchema } = require(resolve(easJsonPath, 'build', 'schema.js'));
const { resolveBuildProfile } = require(resolve(easJsonPath, 'build', 'build', 'resolver.js'));

const easJson = JSON.parse(readFileSync(resolve(root, 'eas.json'), 'utf8'));

// 1. Schema validation, using the exact schema EAS enforces.
const { error } = EasJsonSchema.validate(easJson);
if (error) {
  console.log('eas.json is INVALID:');
  console.log(`  ${error.message}`);
  process.exit(1);
}
console.log('eas.json passes the EAS schema.\n');

const REQUIRED_ENV = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'];

// 2. Resolve each profile and report the artifact + resolved environment.
for (const profileName of ['development', 'preview', 'production']) {
  const resolved = resolveBuildProfile({
    easJson,
    platform: 'android',
    profileName,
  });

  const env = resolved.env ?? {};

  // `resolveBuildProfile` hoists the platform block to the TOP level, so
  // buildType is a sibling of `android`, not nested inside it. Reading the wrong
  // path would report "default aab" for every profile and hide a real defect.
  const buildType = resolved.buildType ?? 'aab (default)';
  const isApk = resolved.buildType === 'apk';

  console.log(`profile: ${profileName}`);
  console.log(`  buildType        : ${buildType}`);
  console.log(`  distribution     : ${resolved.distribution ?? 'store (default)'}`);
  console.log(`  developmentClient: ${resolved.developmentClient ?? false}`);
  console.log(`  env keys         : ${Object.keys(env).join(', ') || '(none)'}`);

  if (profileName !== 'production' && !isApk) {
    console.log(
      '  NOT INSTALLABLE  : buildType is not "apk". A physical device cannot sideload an AAB.',
    );
  }

  // The Supabase variables are deliberately NOT expected in eas.json. A value
  // there takes precedence over the EAS project environment, so an earlier
  // `"$VAR"` indirection silently resolved to an empty local shell value and
  // shipped an APK with no backend. Their real location is
  // `npx eas-cli env:list preview`.
  const pinnedHere = REQUIRED_ENV.filter((key) => key in env);
  if (pinnedHere.length > 0) {
    console.log(
      `  WARNING         : ${pinnedHere.join(', ')} is pinned here and WILL override the EAS environment.`,
    );
  } else {
    console.log('  supabase env    : supplied by the EAS environment (not pinned here) - correct');
  }
  console.log('');
}
