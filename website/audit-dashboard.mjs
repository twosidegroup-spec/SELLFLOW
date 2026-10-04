/**
 * Signed-in dashboard audit.
 *
 * Walks every dashboard route in a real Chrome window, at every width the spec
 * names, in both themes, and reports what it finds. Screenshots land in
 * `$CDP_SHOTS` for eyeballing.
 *
 * **This is read-only.** It navigates and it looks. It never presses a button that
 * writes, never submits a form, and never calls a mutating endpoint. The routes it
 * visits are all reads, and it deliberately stops short of any "create" screen's
 * submit.
 *
 * ## Why a human signs in
 *
 * The obvious version reads credentials from an environment variable. That puts a
 * real seller's password into a process argument, a shell history entry and this
 * script's memory, and it is the reason so many audit scripts end up with a
 * committed `.env`. So instead:
 *
 *   1. Chrome opens visibly, on a persistent profile.
 *   2. *You* type the email and password into that window.
 *   3. This script waits for the dashboard to appear, then takes over.
 *
 * The password never touches this file, its arguments, or its output. Supabase
 * stores the session in the profile, which is why `reuseProfile` is on.
 *
 * ## Usage
 *
 *   npm run web:serve                      # in one shell
 *   node website/dashboard-build && node website/audit-dashboard.mjs
 *
 * Env:
 *   DASHBOARD_BASE  default http://127.0.0.1:8099/app
 *   AUDIT_SKIP_SIGNIN set to 1 to audit the signed-out routes only
 *   AUDIT_SIGNIN_TIMEOUT seconds to wait for a human, default 180
 */

import { launch, connect, sleep, SHOTS } from './tools/cdp.mjs';

const BASE = process.env.DASHBOARD_BASE ?? 'http://127.0.0.1:8099/app';
const SIGNIN_TIMEOUT = Number(process.env.AUDIT_SIGNIN_TIMEOUT ?? 180) * 1000;
const SKIP_SIGNIN = process.env.AUDIT_SKIP_SIGNIN === '1';

/** Read-only routes. No create/edit form is ever submitted. */
const ROUTES = [
  { key: 'dashboard', path: '/', label: 'Dashboard' },
  { key: 'orders', path: '/orders', label: 'Orders' },
  { key: 'products', path: '/products', label: 'Products' },
  { key: 'customers', path: '/customers', label: 'Customers' },
  { key: 'payments', path: '/payments', label: 'Payments overview' },
  { key: 'payment-review', path: '/payment-review', label: 'Payment review queue' },
  { key: 'payment-automation', path: '/payment-sms', label: 'Payment automation' },
  { key: 'finance', path: '/finance', label: 'Finance' },
  { key: 'analytics', path: '/analytics', label: 'Analytics' },
  { key: 'expense', path: '/expense', label: 'Expenses' },
  { key: 'order-requests', path: '/order-requests', label: 'Order requests' },
  { key: 'notifications', path: '/notifications', label: 'Notifications' },
  { key: 'settings-account', path: '/settings/account', label: 'Settings · account' },
  { key: 'settings-business', path: '/settings/business', label: 'Settings · business' },
  { key: 'settings-appearance', path: '/settings/appearance', label: 'Settings · appearance' },
];

const WIDTHS = [
  { key: '360', width: 360, height: 780 },
  { key: '390', width: 390, height: 844 },
  { key: '768', width: 768, height: 1024 },
  { key: '1024', width: 1024, height: 800 },
  { key: '1440', width: 1440, height: 900 },
];

const failures = [];
const warnings = [];

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ''}`);
};

const warn = (message) => {
  console.log(`  WARN  ${message}`);
  warnings.push(message);
};

console.log('dashboard audit\n');
console.log(`  base      ${BASE}`);
console.log(`  shots     ${SHOTS}`);
console.log(`  routes    ${ROUTES.length}`);
console.log(`  widths    ${WIDTHS.map((w) => w.key).join(', ')}\n`);

const { child } = await launch({
  width: 1280,
  height: 900,
  scale: 1,
  headless: false,
  reuseProfile: true,
});
const session = await connect();

const consoleErrors = [];
session.on((msg) => {
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push(msg.params.entry.text);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails.text);
  }
});

const setSize = (width, height) =>
  session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 768,
  });

const setTheme = async (scheme) => {
  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
};

/**
 * Whether the signed-in shell is up.
 *
 * Presence of the sidebar is the signal rather than the URL: the router can be
 * sitting on `/sign-in` while a session already exists, and waiting on a path
 * would race the redirect.
 */
const isSignedIn = async () =>
  session.evaluate(`(() => {
    const hasNav = !!document.querySelector('[data-testid^="web-nav-"]');
    const text = document.body.innerText || '';
    return hasNav || /sign in|create an account/i.test(text) === false && text.length > 200;
  })()`);

const probe = () =>
  session.evaluate(`(() => {
    const body = document.body;
    const text = body.innerText || '';
    const root = document.getElementById('root');
    // Anything the UI should never show a seller.
    const leaks = [];
    for (const bad of ['undefined', 'NaN', '[object Object]', 'null']) {
      if (new RegExp('(^|\\\\s|>)' + bad + '(\\\\s|<|$)').test(text)) leaks.push(bad);
    }
    // Elements wider than the viewport: the usual cause of a sideways scrollbar.
    const overflowing = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2)
      .slice(0, 3)
      .map((el) => el.tagName.toLowerCase() + (el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : ''));
    return JSON.stringify({
      mounted: !!root && root.children.length > 0,
      chars: root ? root.innerHTML.length : 0,
      textLength: text.length,
      excerpt: text.replace(/\\s+/g, ' ').trim().slice(0, 120),
      horizontalOverflow: body.scrollWidth > window.innerWidth + 1,
      overflowing,
      leaks,
      hasSidebar: !!document.querySelector('[data-testid^="web-nav-"]'),
      h1Count: document.querySelectorAll('h1').length,
      imgNoAlt: Array.from(document.images).filter((i) => !i.hasAttribute('alt')).length,
      unlabelledButtons: Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter((b) => !(b.innerText || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby'))
        .length,
    });
  })()`);

await setSize(1280, 900);

/* --------------------------------------------------------------- sign in */

if (SKIP_SIGNIN) {
  console.log('SIGN-IN SKIPPED (AUDIT_SKIP_SIGNIN=1). Auditing signed-out routes only.\n');
} else {
  await session.goto(`${BASE}/sign-in`, { waitMs: 3000 });

  console.log('  A Chrome window is open on the SellFlow sign-in page.');
  console.log('  Please sign in there now. This script will continue by itself.\n');
  console.log(`  Waiting up to ${SIGNIN_TIMEOUT / 1000}s …`);

  const deadline = Date.now() + SIGNIN_TIMEOUT;
  let signedIn = false;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      if (await isSignedIn()) {
        signedIn = true;
        break;
      }
    } catch {
      // Navigation mid-poll is expected while the router settles.
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n\n');

  check('signed in', signedIn);
  if (!signedIn) {
    console.log('  Could not sign in within the timeout. Close the Chrome window and try again.');
    await session.close();
    child.kill();
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ audit */

const signedOut = SKIP_SIGNIN;
const auditRoutes = signedOut ? ROUTES.filter((r) => r.key === 'dashboard') : ROUTES;

for (const size of WIDTHS) {
  console.log(`\n--- ${size.key}px ---`);
  await setSize(size.width, size.height);

  for (const scheme of signedOut ? ['light'] : ['light', 'dark']) {
    await setTheme(scheme);
    const theme = signedOut ? '' : ` ${scheme}`;

    for (const route of auditRoutes) {
      await session.goto(`${BASE}${route.path}`, { waitMs: 2600 });

      let state;
      try {
        state = JSON.parse(await probe());
      } catch (error) {
        check(`${route.label}${theme} probe`, false, String(error).slice(0, 90));
        continue;
      }

      const mounted = state.mounted && state.chars > 400;
      if (!mounted) {
        check(`${route.label}${theme} renders`, false, state.excerpt || 'blank');
        continue;
      }

      const problems = [];
      if (state.horizontalOverflow) problems.push(`h-overflow ${state.overflowing.join(',')}`);
      if (state.leaks.length) problems.push(`leaks ${state.leaks.join(',')}`);
      if (state.imgNoAlt) problems.push(`${state.imgNoAlt} img without alt`);
      if (state.unlabelledButtons) problems.push(`${state.unlabelledButtons} unlabelled button`);

      /*
       * The sidebar is the whole point of Phase 1, so it is asserted rather than
       * eyeballed: below 1024 there must be none, at 1024 and above there must be.
       *
       * Only when signed in. A signed-out browser is on the sign-in screen at every
       * width and never renders the shell, so asserting the sidebar there would
       * fail on correct code.
       */
      if (!signedOut) {
        const wantsSidebar = size.width >= 1024;
        if (state.hasSidebar !== wantsSidebar) {
          problems.push(wantsSidebar ? 'sidebar missing on desktop' : 'sidebar present on narrow');
        }
      }

      if (problems.length) {
        check(`${route.label}${theme}`, false, problems.join('; '));
      } else {
        check(`${route.label}${theme}`, true, `${state.chars} chars`);
      }

      await session.fullPage(`dash-${route.key}-${size.key}-${scheme}${theme ? '' : '-x'}`);
    }
  }
}

/* ----------------------------------------------------------------- report */

console.log('\n--- console ---');
const noisy = consoleErrors.filter(
  (e) => !/favicon|Download the React DevTools|ERR_ABORTED/i.test(e),
);
check('no console errors', noisy.length === 0, noisy.slice(0, 3).join(' | '));

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w}`);
}

console.log(`\nscreenshots: ${SHOTS}`);
console.log(failures.length ? `\n${failures.length} FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}` : '\nAll checks passed.');

await session.close();
child.kill();
process.exit(failures.length ? 1 : 0);
