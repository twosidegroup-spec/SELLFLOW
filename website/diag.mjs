import { connect, sleep } from './tools/cdp.mjs';

const page = await connect();
await page.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await page.goto('http://127.0.0.1:8099/', { waitMs: 2000 });
await page.evaluate('localStorage.clear()');
await page.goto('http://127.0.0.1:8099/', { waitMs: 1500 });
await sleep(1000);

const targets = [
  ['G-channels', '[data-channels]'],
  ['G-ratings', '#ratings'],
  ['G-faq', '#faq'],
  ['G-install', '#install'],
];
for (const [name, sel] of targets) {
  await page.evaluate(`(() => {
    const t = document.querySelector('${sel}');
    if (t) {
      const top = t.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, top - 150));
    }
  })()`);
  await sleep(700);
  await page.screenshot(name);
}
console.log('  captured', targets.map((t) => t[0]).join(', '));
process.exit(0);