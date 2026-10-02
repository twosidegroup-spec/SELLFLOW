/**
 * Screenshot the live Vercel deployment and check it really works in the
 * browser -- not just that it returns 200.
 */
import { connect, sleep } from './tools/cdp.mjs';

const SITE = process.argv[2] ?? 'https://sellflow-omega.vercel.app/';
const problems = [];

const page = await connect();
await page.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });

const errors = [];
const failed = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text ?? 'exception');
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  if (m.method === 'Network.loadingFailed') failed.push(`${m.params.type} ${m.params.errorText}`);
});

await page.goto(SITE, { waitMs: 5000 });
await sleep(3000);

const state = JSON.parse(
  await page.evaluate(`JSON.stringify({
    title: document.title,
    h1: document.querySelector('h1')?.textContent,
    tiles: document.querySelectorAll('.tile').length,
    features: document.querySelectorAll('.feature').length,
    safety: document.querySelectorAll('.safety-row').length,
    faqs: document.querySelectorAll('.faq-item').length,
    chips: document.querySelectorAll('.chip').length,
    styled: getComputedStyle(document.body).fontFamily,
    bg: getComputedStyle(document.body).backgroundColor,
    installHref: document.querySelector('.btn-install')?.getAttribute('href'),
    apkButtons: document.querySelectorAll('[data-download]').length,
    brokenImgs: [...document.querySelectorAll('img')].filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src')),
  })`),
);

console.log(`  ${SITE}`);
console.log(`    title        ${state.title}`);
console.log(`    h1           ${state.h1}`);
console.log(`    font         ${state.styled.split(',')[0]}`);
console.log(`    background   ${state.bg}`);
console.log(`    rail tiles   ${state.tiles}`);
console.log(`    features     ${state.features}`);
console.log(`    safety rows  ${state.safety}`);
console.log(`    faq items    ${state.faqs}`);
console.log(`    chips        ${state.chips}`);
console.log(`    install href ${state.installHref}`);
console.log(`    apk buttons  ${state.apkButtons}`);
if (state.brokenImgs.length) problems.push(`broken images: ${state.brokenImgs.join(', ')}`);
if (errors.length) problems.push(`console errors: ${[...new Set(errors)].slice(0, 4).join(' | ')}`);
if (failed.length) problems.push(`failed requests: ${[...new Set(failed)].slice(0, 4).join(', ')}`);
if (!state.tiles) problems.push('screenshot rail did not render');

await page.screenshot('LIVE-01-hero');
await page.evaluate('document.querySelector("#screens").scrollIntoView()');
await sleep(900);
await page.screenshot('LIVE-02-rail');
await page.evaluate('document.querySelector("#safety").scrollIntoView()');
await sleep(900);
await page.screenshot('LIVE-03-safety');
await page.evaluate('document.querySelector("#ratings").scrollIntoView()');
await sleep(900);
await page.screenshot('LIVE-04-ratings');

console.log('');
console.log(problems.length ? `  ISSUES:\n${problems.map((p) => `   - ${p}`).join('\n')}` : '  No console errors, failed requests or broken images.');
process.exit(problems.length ? 1 : 0);