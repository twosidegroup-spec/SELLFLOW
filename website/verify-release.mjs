/**
 * Asserts the parts of the page this task is responsible for actually render.
 *
 * `review.mjs` checks layout and overflow. This checks content: that the SMS
 * permission disclosure is present, that the download button points at the APK
 * the config names, and that no forbidden claim ("no Android permissions",
 * "messages") survives anywhere on the page.
 *
 * Defaults to the local preview server (node serve.mjs 8099). Set SITE_URL to verify a deployed URL:
 */
import { connect } from './tools/cdp.mjs';

const BASE = process.env.SITE_URL ?? 'http://127.0.0.1:8099/';

const session = await connect();
await session.goto(BASE, { waitMs: 2600 });
await session.evaluate('document.fonts.ready.then(() => true)');

const results = [];
const check = (name, pass, detail = '') =>
  results.push({ name, pass, detail });

// --- 1. The SMS permission disclosure renders -------------------------------
const safety = await session.evaluate(`(() => {
  const rows = [...document.querySelectorAll('.safety-row')];
  const rowsText = rows.map((r) => r.innerText).join('\\n');
  const items = [...document.querySelectorAll('.safety-rows-item')]
    .map((n) => n.innerText.replace(/\\s+/g, ' ').trim());
  return {
    rowCount: rows.length,
    hasHeading: rows.some((r) => /one permission/i.test(r.innerText)),
    items,
    honesty: document.querySelector('.safety-honesty')?.innerText ?? '',
    wholeSection: rowsText,
  };
})()`);

check('permission row renders', safety.hasHeading);
check(
  'RECEIVE_SMS named explicitly',
  safety.items.some((i) => i.includes('android.permission.RECEIVE_SMS')),
);
check(
  'states the inbox is never opened',
  safety.items.some((i) => /never opened/i.test(i)),
);
check(
  'states passcodes are ignored',
  safety.items.some((i) => /one-time passcode|OTP/i.test(i)),
);
check(
  'states message text is never stored',
  safety.items.some((i) => /never/i.test(i) && /text|stored/i.test(i)),
);
check('honesty note present', safety.honesty.length > 40, safety.honesty.slice(0, 90));

// --- 2. The now-false claims must be gone ------------------------------------
const bodyText = await session.evaluate(`document.body.innerText`);
const forbidden = [
  'requests no Android permissions',
  'does not ask for location, photos, contacts, messages',
];
for (const phrase of forbidden) {
  check(`removed false claim: "${phrase.slice(0, 40)}..."`, !bodyText.includes(phrase));
}

// --- 3. Nothing overclaims the SMS feature ------------------------------------
const overclaims = [
  /banking[- ]grade/i,
  /production[- ]verified/i,
  /fully verified/i,
  /guaranteed payment/i,
  /google play approved/i,
];
for (const pattern of overclaims) {
  check(`no overclaim ${pattern}`, !pattern.test(bodyText));
}

// --- 4. Download wiring -------------------------------------------------------
const dl = await session.evaluate(`(() => {
  const buttons = [...document.querySelectorAll('[data-download]')];
  return {
    count: buttons.length,
    hrefs: [...new Set(buttons.map((b) => b.getAttribute('href')))],
    label: buttons[0]?.innerText.trim() ?? '',
  };
})()`);

check('a download action exists', dl.count > 0, `${dl.count} button(s)`);
check(
  'every download button points at one URL',
  dl.hrefs.length === 1,
  dl.hrefs.join(' | '),
);
check(
  'download URL is an APK',
  dl.hrefs.every((h) => /\.apk(\?|$)/.test(h ?? '')),
  dl.hrefs[0] ?? '',
);

// --- 5. Branding preserved ----------------------------------------------------
const brand = await session.evaluate(`(() => ({
  h1: document.querySelector('h1')?.innerText.trim() ?? '',
  title: document.title,
  powered: /TSG|Technologies/i.test(document.body.innerText),
  faq: /faq/i.test(document.body.innerText),
  dataSafety: /data safety/i.test(document.body.innerText),
  packages: /110|MB/i.test(document.body.innerText),
}))()`);
check('hero h1 renders', brand.h1.length > 0, brand.h1);
check('page title intact', /sellflow/i.test(brand.title), brand.title);
check('Powered by TSG preserved', brand.powered);
check('FAQ section preserved', brand.faq);
check('data safety section preserved', brand.dataSafety);
check('package size still shown', brand.packages);

let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? 'PASS ' : 'FAIL '} ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} content checks passed`);

await session.close();
process.exit(failed === 0 ? 0 : 1);