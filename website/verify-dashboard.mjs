/**
 * Dashboard smoke check.
 *
 * Loads the exported dashboard in real Chrome at three widths and asserts the two
 * things a broken export actually looks like: a blank shell, and a console error.
 * Cheap enough to run after every dashboard build, which is the point -- the
 * expensive failure this catches is a deploy that 404s its own bundle, and that
 * only shows up when a browser really asks for it.
 *
 *   node website/verify-dashboard.mjs
 *
 * Env:
 *   DASHBOARD_BASE   default http://127.0.0.1:8099/app
 *
 * It checks the SIGNED-OUT surface. Reaching the signed-in dashboard needs real
 * credentials; this script deliberately does not create an account in the live
 * Supabase project to get one.
 */

import { launch, connect } from './tools/cdp.mjs';

const BASE = process.env.DASHBOARD_BASE ?? 'http://127.0.0.1:8099/app';

const WIDTHS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures.push(label);
};

const { child } = await launch({ width: 1440, height: 900, scale: 1 });
const session = await connect();

const consoleErrors = [];
session.on((msg) => {
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push(msg.params.entry.text);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails.text);
  }
  if (msg.method === 'Network.loadingFailed') {
    const { errorText, type } = msg.params;
    // A cancelled request is what a navigation away looks like, not a failure.
    if (errorText !== 'net::ERR_ABORTED') consoleErrors.push(`network ${type}: ${errorText}`);
  }
});

for (const size of WIDTHS) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
    mobile: size.width < 768,
  });

  await session.goto(`${BASE}/sign-in`, { waitMs: 5000 });

  const state = JSON.parse(
    await session.evaluate(`(() => {
      const root = document.getElementById('root');
      const body = document.body;
      return JSON.stringify({
        mounted: !!root && root.children.length > 0,
        renderedChars: root ? root.innerHTML.length : 0,
        text: (body.innerText || '').replace(/\\s+/g, ' ').trim(),
        horizontalOverflow: body.scrollWidth > window.innerWidth + 1,
        path: location.pathname,
      });
    })()`),
  );

  check(`${size.name} renders`, state.mounted && state.renderedChars > 500, `${state.renderedChars} chars`);
  check(`${size.name} shows the sign-in form`, /sign in/i.test(state.text));
  check(`${size.name} has no horizontal overflow`, !state.horizontalOverflow);
  await session.fullPage(`dashboard-${size.name}-signin`);
}

check('no console or network errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await session.close();
child.kill();

console.log(`\n${failures.length ? `${failures.length} FAILED` : `all checks passed at ${WIDTHS.length} widths`}`);
process.exit(failures.length ? 1 : 0);
