/**
 * Render the Open Graph / Twitter card from src/og.html.
 *
 * The card is authored as HTML+CSS and screenshotted rather than being composed
 * in a raster tool, so it always matches the site's own type scale, colour
 * tokens and the real dashboard screenshot.
 */
import { connect, sleep } from './tools/cdp.mjs';
import { copyFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = 'C:/Users/Sajidul Haque Sajid/Desktop/SELFLOW/sellflow/website';
const url = pathToFileURL(join(ROOT, 'src/og.html')).href;

const page = await connect();
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 1200,
  height: 630,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await page.goto(url, { waitMs: 3000 });
// give the webfont a beat so the card never renders in a fallback face
await sleep(1500);
await page.evaluate(`document.fonts.ready.then(() => true)`);
await sleep(600);

const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const out = join(ROOT, 'public/assets/img/og-image.png');
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(data, 'base64'));
console.log(`  og-image.png written (1200x630, ${Math.round(Buffer.from(data, 'base64').length / 1024)} KB)`);

// A smaller card for surfaces that cap the long edge.
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 1200,
  height: 630,
  deviceScaleFactor: 0.5,
  mobile: false,
});
await page.goto(url, { waitMs: 2500 });
await sleep(1200);
const small = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
writeFileSync(join(ROOT, 'public/assets/img/og-image.jpg'), Buffer.from(small.data, 'base64'));
console.log('  og-image.jpg written (600x315 jpeg)');
void copyFileSync;
process.exit(0);