import { connect, sleep } from './tools/cdp.mjs';

const page = await connect();
await page.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
await page.goto('http://127.0.0.1:8099/', { waitMs: 2600 });
await sleep(1200);

console.log('  page bg:', await page.evaluate('getComputedStyle(document.body).backgroundColor'));
console.log('  body text:', await page.evaluate('getComputedStyle(document.body).color'));

console.log('\n  tile geometry (container vs image):');
const geo = JSON.parse(
  await page.evaluate(`JSON.stringify([...document.querySelectorAll('.tile')].slice(0,3).map(t => {
    const box = t.querySelector('.tile-shot').getBoundingClientRect();
    const img = t.querySelector('img');
    const r = img.getBoundingClientRect();
    return {
      tileW: Math.round(t.getBoundingClientRect().width),
      shotW: Math.round(box.width), shotH: Math.round(box.height),
      imgW: Math.round(r.width), imgH: Math.round(r.height),
      intrinsic: img.naturalWidth + 'x' + img.naturalHeight,
      objectFit: getComputedStyle(img).objectFit,
      aspect: getComputedStyle(img).aspectRatio,
      pos: getComputedStyle(img).objectPosition,
    };
  }), null, 1)`)
);
for (const g of geo) {
  console.log(`    tile ${g.tileW}px | shot ${g.shotW}x${g.shotH} | img ${g.imgW}x${g.imgH} | intrinsic ${g.intrinsic}`);
  console.log(`      object-fit ${g.objectFit}, aspect-ratio ${g.aspect}, position ${g.pos}`);
}
process.exit(0);