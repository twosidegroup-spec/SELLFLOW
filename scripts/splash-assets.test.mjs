/**
 * Splash and brand-asset audit.
 *
 * The splash is the one screen a seller cannot dismiss, theme or scroll past, and
 * the brand mark is the first thing on the lock screen they see every morning. So
 * the properties that matter are checked here rather than trusted:
 *
 *   1. **The native splash colours are the app's colours.** `app.json` hardcodes
 *      them because there is no way to read a token from native config, which
 *      makes drift the default rather than the risk. These assertions compare
 *      `app.json` against `src/theme/tokens.ts`, the same source the running UI
 *      uses.
 *   2. **The splash image is transparent.** One image is configured for both
 *      schemes. An opaque plate in that file renders a pale square on the dark
 *      splash, which is the classic dark-mode flash.
 *   3. **The runtime brand mark has no baked-in background.** `assets/icon.png` is
 *      a launcher tile with a pale plate and no alpha channel; using it in-app is
 *      what produced a near-invisible tile in light mode and a glaring one in dark.
 *
 * Decodes the PNGs directly (see `splash-audit.mjs`), so there is no image-library
 * dependency and this runs anywhere Node does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readPng } from './splash-audit.mjs';

const appJson = JSON.parse(readFileSync('app.json', 'utf8'));
const tokensSrc = readFileSync('src/theme/tokens.ts', 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The `expo-splash-screen` plugin block from app.json. */
function splashPlugin() {
  const entry = appJson.expo.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen',
  );
  assert.ok(entry, 'app.json must configure expo-splash-screen');
  return entry[1];
}

/** A hex literal from the palette in tokens.ts. */
function palette(name) {
  const match = tokensSrc.match(new RegExp(`\\b${name}:\\s*'(#[0-9A-Fa-f]{6})'`));
  assert.ok(match, `tokens.ts must define palette.${name}`);
  return match[1].toUpperCase();
}

function toRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(hexA, hexB) {
  const [x, y] = [relativeLuminance(toRgb(hexA)), relativeLuminance(toRgb(hexB))].sort((a, b) => b - a);
  return (x + 0.05) / (y + 0.05);
}

// ---------------------------------------------------------------------------
// 1. Splash background must equal the theme background
// ---------------------------------------------------------------------------

test('splash: the native background is the light theme background', () => {
  const plugin = splashPlugin();
  const expected = palette('slate50');
  assert.equal(
    plugin.backgroundColor.toUpperCase(),
    expected,
    'the splash would flash a different colour than the first screen',
  );
});

test('splash: the dark background is the dark theme background', () => {
  const plugin = splashPlugin();
  const expected = palette('night950');
  assert.equal(
    plugin.dark.backgroundColor.toUpperCase(),
    expected,
    'a dark-mode seller would get a flash of the wrong colour on every cold start',
  );
});

test('splash: light and dark backgrounds actually differ', () => {
  const plugin = splashPlugin();
  assert.notEqual(
    plugin.backgroundColor.toUpperCase(),
    plugin.dark.backgroundColor.toUpperCase(),
  );
});

test('splash: the adaptive icon plate matches the splash background', () => {
  // Otherwise the launcher icon sits on a slightly different tile than the splash
  // the seller has just been looking at.
  assert.equal(
    appJson.expo.android.adaptiveIcon.backgroundColor.toUpperCase(),
    palette('slate50'),
  );
});

// ---------------------------------------------------------------------------
// 2. The splash image must be safe on both backgrounds
// ---------------------------------------------------------------------------

test('splash image: its corners are transparent, so one file serves both schemes', () => {
  const plugin = splashPlugin();
  const png = readPng(plugin.image.replace('./', ''));

  assert.equal(png.hasAlphaChannel, true, `${plugin.image} has no alpha channel`);

  for (const [corner, px] of Object.entries(png.corners)) {
    assert.ok(
      px.a < 16,
      `${plugin.image} ${corner} is opaque rgb(${px.r},${px.g},${px.b}) -- ` +
        'this will render as a pale square on the dark splash',
    );
  }
});

test('splash image: the wordmark is vertically centred and not clipped', () => {
  const plugin = splashPlugin();
  const png = readPng(plugin.image.replace('./', ''));

  /*
   * This asset is a 4.75:1 wordmark spanning the full canvas width, which is a
   * deliberate lockup rather than a square mark. So the margins that matter are
   * the vertical ones: a mark sitting high or low reads as misaligned, and one
   * touching the canvas edge reads as clipped by whatever the launcher crops.
   */
  const gapAbove = png.ink.top;
  const gapBelow = 1 - (png.ink.top + png.ink.height);
  const drift = Math.abs(gapAbove - gapBelow);

  assert.ok(
    drift < 0.08,
    `the mark sits ${(drift * 100).toFixed(1)}% off centre vertically ` +
      `(${(gapAbove * 100).toFixed(1)}% above, ${(gapBelow * 100).toFixed(1)}% below)`,
  );
  assert.ok(gapAbove > 0.15, 'the mark is jammed against the top of the canvas');
  assert.ok(gapBelow > 0.15, 'the mark is jammed against the bottom of the canvas');
});

test('splash image: resizeMode contain, so the mark is never stretched', () => {
  assert.equal(splashPlugin().resizeMode, 'contain');
});

// ---------------------------------------------------------------------------
// 3. The runtime brand mark must be the plate-free asset
// ---------------------------------------------------------------------------

test('brand mark: the asset the app renders has an alpha channel', () => {
  // `assets/icon.png` is a launcher tile: colour type 2, no alpha, pale plate.
  const launcher = readPng(appJson.expo.icon.replace('./', ''));
  const foreground = readPng(appJson.expo.android.adaptiveIcon.foregroundImage.replace('./', ''));

  assert.equal(
    foreground.hasAlphaChannel,
    true,
    'the foreground must be plate-free so it can sit on the theme background',
  );
  // Recorded so the reason BrandMark exists stays visible: the launcher icon
  // genuinely is opaque, which is why it must not be used in-app. If this ever
  // starts failing, someone exported a transparent launcher icon and BrandMark
  // could go back to using it directly.
  assert.equal(
    launcher.hasAlphaChannel,
    false,
    'assets/icon.png gained an alpha channel -- BrandMark may be able to use it directly again',
  );
});

test('brand mark: it is legible on the dark theme background', () => {
  const foreground = readPng(appJson.expo.android.adaptiveIcon.foregroundImage.replace('./', ''));
  assert.equal(foreground.hasAlphaChannel, true);
  // The mark's ink is a mid blue; the lock screen in dark mode is near-black.
  assert.ok(
    contrast(palette('blue600'), palette('night950')) > 3,
    'the mark must be clearly visible on the lock screen in dark mode',
  );
});

test('brand mark: no screen renders the launcher tile', () => {
  /*
   * A filesystem walk rather than an import graph: the mistake is a literal
   * `require('...icon.png')`, and this catches it wherever it appears, including in
   * a file this test never imports.
   *
   * Matched against the `require()` call rather than the bare path, so that
   * `BrandMark.tsx` -- whose whole job is to explain why the launcher tile is not
   * used -- does not trip its own guard.
   */
  const offenders = [];
  const requireCall = /require\(\s*['"][^'"]*assets\/icon\.png['"]\s*\)/;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry.name) && requireCall.test(readFileSync(path, 'utf8'))) {
        offenders.push(path);
      }
    }
  };
  walk('src');

  assert.deepEqual(offenders, [], `the launcher tile is still rendered in-app: ${offenders.join(', ')}`);
});
