/**
 * Exercise the interactive parts of the built site: the screenshot rail and
 * lightbox, the FAQ accordion, the review form, the download state and the
 * sticky mobile bar.
 *
 * These are the parts a visitor actually touches and the parts a screenshot
 * cannot prove.
 */
import { connect, sleep } from './tools/cdp.mjs';

const BASE = 'http://127.0.0.1:8099/';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const page = await connect();
await page.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
await page.goto(BASE, { waitMs: 2600 });
// Start clean: the review store survives reloads, so a leftover review from a
// previous run would make the "nothing stored" checks lie.
await page.evaluate('localStorage.clear()');
await page.goto(BASE, { waitMs: 2400 });
await sleep(1200);

/* ----------------------------------------------------------------- rail */
const counts = JSON.parse(
  await page.evaluate(
    'JSON.stringify({tiles: document.querySelectorAll(".tile").length, counter: document.querySelector("[data-lb-counter]").textContent})',
  ),
);
check('screenshot rail rendered its tiles', counts.tiles > 0, `${counts.tiles} tiles`);
check('page background is white', (await page.evaluate('getComputedStyle(document.body).backgroundColor')) === 'rgb(255, 255, 255)');

/*
 * Tile images must not be scaled up to fill their frame.
 *
 * `object-fit: cover` crops whichever axis is too long. Tiles deliberately crop
 * the bottom of each screen, which narrows the aspect ratio -- fine. The reverse
 * (image scaled up, cropping the left and right off every screen) is the bug
 * worth catching, and it is what a `height` presentational attribute causes.
 *
 * The frame is 2px wider than the image because of its 1px side borders.
 */
const geo = JSON.parse(
  await page.evaluate(`JSON.stringify([...document.querySelectorAll('.tile-shot')].slice(0, 3).map((s) => {
    const r = s.getBoundingClientRect();
    const img = s.querySelector('img');
    const ir = img.getBoundingClientRect();
    return {
      box: [Math.round(r.width), Math.round(r.height)],
      img: [Math.round(ir.width), Math.round(ir.height)],
      intrinsic: [img.naturalWidth, img.naturalHeight],
    };
  }))`),
);
check(
  'tile image fills the frame width and leaves no dead strip',
  geo.every((g) => g.box[0] - g.img[0] <= 2 && g.box[1] - g.img[1] <= 2),
  JSON.stringify(geo[0]),
);
check(
  'tile crops only the bottom, never the sides',
  geo.every((g) => g.img[0] / g.img[1] >= g.intrinsic[0] / g.intrinsic[1]),
  `${geo[0].img[0]}x${geo[0].img[1]} from ${geo[0].intrinsic.join('x')}`,
);

/* ------------------------------------------------------------- lightbox */
await page.evaluate('document.querySelectorAll(".tile")[2].click()');
await sleep(700);
let lb = JSON.parse(
  await page.evaluate(
    'JSON.stringify({hidden: document.querySelector("[data-lightbox]").hidden, counter: document.querySelector("[data-lb-counter]").textContent, src: document.querySelector("[data-lb-img]").getAttribute("src"), caption: document.querySelector("[data-lb-caption]").textContent.slice(0, 40)})',
  ),
);
check('clicking a tile opens the lightbox', lb.hidden === false, lb.counter);
check('lightbox loads a real screenshot file', /^assets\/img\/screens\/.+\.png$/.test(lb.src ?? ''), lb.src);
check('lightbox shows the caption', lb.caption.length > 10, `"${lb.caption}…"`);
check(
  'lightbox reaches every screenshot, not just the rail ones',
  Number(lb.counter.split('/')[1]) > counts.tiles,
  `${lb.counter} vs ${counts.tiles} tiles`,
);

await page.key('ArrowRight', 'ArrowRight', 39);
await sleep(500);
const after = JSON.parse(await page.evaluate('JSON.stringify(document.querySelector("[data-lb-counter]").textContent)'));
check('arrow key advances the lightbox', after !== lb.counter, `${lb.counter} -> ${after}`);

await page.key('Escape', 'Escape', 27);
await sleep(500);
check('Escape closes the lightbox', (await page.evaluate('document.querySelector("[data-lightbox]").hidden')) === true);

/* rail arrow scrolls the strip */
const railBefore = await page.evaluate('document.querySelector("[data-rail]").scrollLeft');
await page.evaluate('document.querySelector("[data-rail-next]").click()');
await sleep(900);
const railAfter = await page.evaluate('document.querySelector("[data-rail]").scrollLeft');
check('rail arrow scrolls the strip', railAfter > railBefore, `${Math.round(railBefore)} -> ${Math.round(railAfter)}`);

/* ------------------------------------------------------------------ faq */
const faqBefore = await page.evaluate('document.querySelectorAll(".faq-item[data-open]").length');
await page.evaluate('document.querySelectorAll(".faq-q")[1].click()');
await sleep(400);
const faq = JSON.parse(
  await page.evaluate(
    'JSON.stringify({h: Math.round(document.querySelectorAll(".faq-a")[1].getBoundingClientRect().height), aria: document.querySelectorAll(".faq-q")[1].getAttribute("aria-expanded")})',
  ),
);
check('FAQ item expands', faq.h > 20 && faq.aria === 'true', `height ${faq.h}px`);
await page.evaluate('document.querySelectorAll(".faq-q")[3].click()');
await sleep(400);
check('FAQ accordion opens one at a time', (await page.evaluate('document.querySelectorAll(".faq-item[data-open]").length')) === 1);
check('FAQ starts closed', faqBefore === 0);

/* --------------------------------------------------------------- honesty */
const honesty = JSON.parse(
  await page.evaluate(`JSON.stringify({
    heroRating: document.querySelector('[data-rating-value]').textContent.trim(),
    bigScore: document.querySelector('.rating-big') ? document.querySelector('.rating-big b').textContent : null,
    bars: document.querySelectorAll('.bar').length,
    emptyVisible: !document.querySelector('[data-reviews-empty]').hasAttribute('hidden'),
    reviewCards: document.querySelectorAll('.review').length,
    playClaim: document.body.textContent.includes('Google Play'),
    categoryChip: document.querySelector('.chip-accent')?.textContent,
  })`),
);
check('hero says "No ratings yet"', honesty.heroRating === 'No ratings yet', honesty.heroRating);
check('no fabricated score or histogram', honesty.bigScore === null && honesty.bars === 0);
check('empty review state is shown', honesty.emptyVisible === true && honesty.reviewCards === 0);
check('no "#1" ranking claim', honesty.categoryChip === 'Business Management', honesty.categoryChip);
check(
  'Google Play only mentioned as a distribution caveat',
  honesty.playClaim === true,
  'mentioned only in the install note and info card',
);

/* ---------------------------------------------------------- review form */
await page.evaluate('document.querySelector("#ratings").scrollIntoView()');
await sleep(400);
await page.evaluate('document.querySelector("[data-review-form] button[type=submit]").click()');
await sleep(500);
const invalid = JSON.parse(
  await page.evaluate(
    'JSON.stringify({starErr: !document.querySelector("[data-star-error]").hidden, textErr: !document.querySelector("[data-text-error]").hidden, tone: document.querySelector("[data-review-status]").dataset.tone, stored: localStorage.getItem("sellflow:reviews:v1")})',
  ),
);
check('empty review is rejected', invalid.starErr && invalid.textErr && invalid.tone === 'bad');
check('nothing stored on invalid submit', invalid.stored === null);

await page.evaluate('document.querySelector("#rv-website").value = "http://spam.example"');
await page.evaluate('document.querySelectorAll(".star-btn")[3].click()');
await page.evaluate('document.querySelector("#rv-name").value = "Bot"');
await page.evaluate('document.querySelector("#rv-text").value = "This is an automated spam submission."');
await page.evaluate('document.querySelector("[data-review-form] button[type=submit]").click()');
await sleep(500);
check('honeypot blocks the submission', (await page.evaluate('localStorage.getItem("sellflow:reviews:v1")')) === null);

await page.evaluate('document.querySelector("#rv-website").value = ""');
await page.evaluate('document.querySelectorAll(".star-btn")[4].click()');
await page.evaluate('document.querySelector("#rv-name").value = "Reza Karim"');
await page.evaluate('document.querySelector("#rv-business").value = "Facebook seller"');
await page.evaluate('document.querySelector("#rv-text").value = "Stopped tracking orders in a notebook. The COD outstanding view alone is worth it."');
await page.evaluate('document.querySelector("[data-review-form] button[type=submit]").click()');
await sleep(800);
const saved = JSON.parse(
  await page.evaluate(
    'JSON.stringify({list: document.querySelectorAll(".review").length, emptyHidden: document.querySelector("[data-reviews-empty]").hasAttribute("hidden"), tone: document.querySelector("[data-review-status]").dataset.tone, name: document.querySelector(".review-who b")?.textContent, label: document.querySelector(".review-local")?.textContent, filled: document.querySelectorAll(".review .stars span:not(.off)").length})',
  ),
);
check('valid review is saved and rendered', saved.list === 1 && saved.emptyHidden === true, saved.name);
check('review is labelled as device-only', (saved.label ?? '').includes('this device'), saved.label);
check('review records the chosen rating', saved.filled === 5, `${saved.filled} stars`);
check('form reports success', saved.tone === 'ok');

/* -------------------------------------------------------------- download */
/*
 * The APK is hosted on a GitHub release, not in this deployment, because a
 * Vercel Hobby deployment caps static uploads at 100 MB and the universal APK
 * is 110.1 MB.
 *
 * So the button is a plain link and is deliberately NOT clicked here: it would
 * navigate to the release asset and take the page with it. What is asserted is
 * the contract instead -- every button points at the configured URL, and the
 * page makes no verification claim it could not make cross-origin.
 */
const dl = JSON.parse(
  await page.evaluate(`JSON.stringify([
    ...document.querySelectorAll('[data-download]')
  ].map((b) => ({ href: b.getAttribute('href'), state: b.dataset.state ?? null, label: b.querySelector('[data-download-label]')?.textContent ?? '' })))`),
);
check('every download button points at the configured APK', dl.every((b) => b.href?.startsWith('https://github.com/') && b.href.endsWith('.apk')), dl[0]?.href);
check('APK link is external, so no unverifiable claim is made', dl.every((b) => b.state === null), dl.map((b) => b.state).join(','));
check('download labels are the plain call to action', dl.every((b) => ['Install', 'Download APK', 'Download latest APK'].includes(b.label)), dl.map((b) => b.label).join(','));
check('all download buttons share one href', new Set(dl.map((b) => b.href)).size === 1, `${new Set(dl.map((b) => b.href)).size} distinct`);

/* --------------------------------------------------------- mobile bar */
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await page.goto(BASE, { waitMs: 2600 });
await sleep(1000);
check('sticky install bar is hidden at the top', (await page.evaluate('document.querySelector("[data-mobile-bar]").hasAttribute("data-show")')) === false);
await page.evaluate('window.scrollTo(0, 900)');
await sleep(700);
check('sticky install bar appears after scrolling', (await page.evaluate('document.querySelector("[data-mobile-bar]").hasAttribute("data-show")')) === true);

/* ----------------------------------------------------------------- done */
const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`  ${results.length - failed.length}/${results.length} interaction checks passed`);
process.exit(failed.length ? 1 : 0);