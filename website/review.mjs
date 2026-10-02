/**
 * Screenshot the built site at desktop and phone widths, and report any
 * console errors, failed requests, layout overflow and accessibility gaps.
 *
 * This is the "inspect the whole site as a potential customer" pass: it looks
 * for the things that make a page feel unfinished rather than checking that the
 * markup merely exists.
 */
import { connect, sleep } from './tools/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8099/';
const OUT = 'C:/Users/Sajidul Haque Sajid/Desktop/SELFLOW/sellflow/website/.review';
mkdirSync(OUT, { recursive: true });

const page = await connect();
const problems = [];
let n = 0;

const errors = [];
const failed = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push(`${m.params.entry.source}: ${m.params.entry.text}`);
  }
  if (m.method === 'Network.loadingFailed') {
    failed.push(`${m.params.type}: ${m.params.errorText}`);
  }
});

const views = [
  ['desktop', 1440, 950, 1],
  ['laptop', 1180, 820, 1],
  ['tablet', 834, 1000, 1],
  ['phone', 390, 844, 2],
];

for (const [label, w, h, s] of views) {
  // Force a light colour scheme. An earlier prefers-color-scheme override on
  // this browser target survives navigation, which once made every "light"
  // capture come out dark.
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: s,
    mobile: w < 700,
  });
  await page.goto(BASE, { waitMs: 2600 });
  // Capture the real first-visit state, not residue left by interactions.mjs.
  await page.evaluate('localStorage.clear()');
  await page.goto(BASE, { waitMs: 1200 });
  await page.evaluate('document.fonts.ready.then(() => true)');
  await sleep(1400);

  // Horizontal overflow is the classic responsive bug; check the whole doc.
  const overflow = await page.evaluate(`(() => {
    const de = document.documentElement;
    const bad = [];
    for (const n of document.querySelectorAll('body *')) {
      const r = n.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > de.clientWidth + 2 || r.left < -2) {
        bad.push(n.tagName.toLowerCase() + '.' + (n.className || '').toString().split(' ')[0]
          + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
      }
    }
    return {
      scrollW: de.scrollWidth, clientW: de.clientWidth,
      offenders: [...new Set(bad)].slice(0, 6),
    };
  })()`);

  if (overflow.scrollW > overflow.clientW + 1) {
    problems.push(`${label}: horizontal overflow ${overflow.scrollW} > ${overflow.clientW} -> ${overflow.offenders.join(', ')}`);
  }

  // Tap targets and images.
  const a11y = await page.evaluate(`(() => {
    const small = [];
    for (const n of document.querySelectorAll('a, button, input, select, textarea')) {
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 32 || r.width < 32) {
        small.push((n.tagName.toLowerCase()) + '.' + (n.className || '').toString().split(' ')[0]
          + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
    }
    const noAlt = [...document.querySelectorAll('img')].filter((i) => i.alt === null || i.alt === undefined).length;
    // An <img> with no src at all is the closed lightbox's empty <img>, which is
    // correct. Only an image that *has* a src and still failed counts.
    const brokenImgs = [...document.querySelectorAll('img')]
      .filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0)
      .map((i) => i.getAttribute('src').split('/').pop());
    const headings = [...document.querySelectorAll('h1,h2,h3,h4')].map((h) => +h.tagName[1]);
    let jump = null;
    for (let i = 1; i < headings.length; i++) if (headings[i] - headings[i - 1] > 1) { jump = i; break; }
    return { small: [...new Set(small)].slice(0, 8), noAlt, brokenImgs, jump, h1: document.querySelectorAll('h1').length };
  })()`);

  if (a11y.noAlt) problems.push(`${label}: ${a11y.noAlt} images with no alt attribute`);
  if (a11y.brokenImgs.length) problems.push(`${label}: images failed to render -> ${a11y.brokenImgs.join(', ')}`);
  if (a11y.h1 !== 1) problems.push(`${label}: expected exactly 1 <h1>, found ${a11y.h1}`);
  if (a11y.jump !== null) problems.push(`${label}: heading level skipped at index ${a11y.jump}`);

  // Section screenshots.
  const shots = [
    ['hero', 0],
    ['rail', '#screens'],
    ['about', '#about'],
    ['safety', '#safety'],
    ['ratings', '#ratings'],
    ['features', '#features'],
    ['faq', '#faq'],
    ['install', '#install'],
    ['release', '#release'],
    ['footer', '.site-footer'],
  ];
  for (const [name, sel] of shots) {
    if (sel) {
      await page.evaluate(`(() => {
        const t = document.querySelector(${JSON.stringify(sel)});
        if (t) window.scrollTo(0, t.offsetTop - 40);
      })()`);
      await sleep(700);
    }
    await page.screenshot(`${String(++n).padStart(2, '0')}-${label}-${name}`);
  }
  console.log(`  ${label.padEnd(8)} ok  overflow ${overflow.scrollW}/${overflow.clientW}  h1 ${a11y.h1}`);
}

if (failed.length) problems.push(`failed requests: ${[...new Set(failed)].slice(0, 5).join(', ')}`);
if (errors.length) problems.push(`console errors: ${[...new Set(errors)].slice(0, 5).join(' | ')}`);

console.log('');
if (problems.length) {
  console.log('ISSUES');
  for (const p of problems) console.log(`  - ${p}`);
} else {
  console.log('No layout, overflow, asset or accessibility issues found.');
}
writeFileSync(`${OUT}/report.txt`, problems.join('\n') || 'clean');
process.exit(0);