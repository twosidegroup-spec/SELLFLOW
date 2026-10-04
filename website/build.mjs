/**
 * Build the deployable site into website/dist.
 *
 * Everything release-specific comes from site.config.mjs; nothing about the
 * version, size or APK path is written into the markup by hand.
 *
 * The build fails if the APK is missing or if any screenshot referenced by the
 * config is not on disk. A marketing page that ships a broken download button
 * or an empty gallery tile is worse than no page, so these are hard errors
 * rather than warnings.
 */
import {
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  appConfig,
  screenshots,
  showcases,
  features,
  trustPoints,
  audiences,
  faqs,
  changelog,
  channels,
  tiles,
  about,
  dataSafety,
  appInfo,
} from './site.config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'src');
const PUBLIC = join(HERE, 'public');
const DIST = join(HERE, 'dist');

/** Set to the real domain once the site is hosted. */
const SITE_URL = process.env.SELLFLOW_SITE_URL ?? 'https://sellflow.app/';

const problems = [];
const warn = (m) => problems.push(m);

/* ------------------------------------------------------------ token pass */
const apkPath = appConfig.apkPath.startsWith('/') ? appConfig.apkPath.slice(1) : appConfig.apkPath;
const apkAbs = join(PUBLIC, apkPath);

/**
 * The APK may be served from the deployment or from anywhere else.
 *
 * A Vercel Hobby deployment caps static uploads at 100 MB and the universal
 * APK is 110.1 MB, so the binary is hosted on a GitHub release and the page
 * links to it directly. In that case the build must not demand the file
 * locally, and must not copy it into dist -- otherwise the deployment fails
 * on size.
 */
const apkIsExternal = /^https?:\/\//i.test(apkPath);

// Where the artifact is measured, and what happens when it is not on disk.
//
// Previously an external APK skipped the size check entirely, so `apkSizeBytes`
// only ever got refreshed for a self-hosted file. That contradicted the claim in
// README.md that the displayed size "cannot go stale", and in practice it left the
// public page advertising the size of the previous release.
//
// So: prefer a local copy named by `apkFileName` when one exists, whatever the
// URL is, and use it to correct the size. A missing local copy is a warning, not a
// failure -- the download still works, it just cannot be measured here.
const localApk = join(PUBLIC, 'downloads', appConfig.apkFileName ?? 'sellflow-latest.apk');

if (apkIsExternal) {
  console.log(`  apk          external -> ${apkPath}`);
  if (existsSync(localApk)) {
    const bytes = statSync(localApk).size;
    if (bytes !== appConfig.apkSizeBytes) {
      appConfig.apkSizeBytes = bytes;
      console.log(`               size corrected from local copy -> ${(bytes / 1048576).toFixed(1)} MB`);
    }
  } else {
    warn(
      `No local copy at public/downloads/${appConfig.apkFileName ?? 'sellflow-latest.apk'} -- ` +
        'the displayed APK size comes from the config and cannot be verified here.',
    );
  }
} else {
  if (!existsSync(apkAbs)) {
    warn(`APK not found at public/${apkPath} -- the download button would 404.`);
  } else {
    const bytes = statSync(apkAbs).size;
    if (bytes !== appConfig.apkSizeBytes) {
      // Keep the displayed size honest rather than stale.
      appConfig.apkSizeBytes = bytes;
    }
  }
}

const mb = appConfig.apkSizeBytes / 1024 / 1024;

for (const shot of screenshots) {
  for (const key of ['file', 'dark']) {
    const rel = shot[key];
    if (!rel) continue;
    if (!existsSync(join(PUBLIC, 'assets/img', rel))) {
      warn(`Missing screenshot "${shot.id}" (${key}): assets/img/${rel}`);
    }
  }
}

for (const tile of tiles) {
  if (!screenshots.some((s) => s.id === tile.id)) {
    warn(`Tile "${tile.headline}" references unknown screenshot id "${tile.id}".`);
  }
}

for (const block of showcases) {
  for (const id of block.screens) {
    if (!screenshots.some((s) => s.id === id)) {
      warn(`Showcase "${block.id}" references unknown screenshot id "${id}".`);
    }
  }
}

if (problems.length) {
  console.error('\nBuild stopped. Fix these first:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}

/* ---------------------------------------------------------------- build */
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
};

// CSS (+ the generated font CSS it imports)
copy(join(SRC, 'fonts.css'), join(DIST, 'assets/css/fonts.css'));
copy(join(SRC, 'site.css'), join(DIST, 'assets/css/site.css'));

// JS
copy(join(SRC, 'site.js'), join(DIST, 'assets/js/site.js'));

// Client config, so the page and the config can never disagree.
writeFileSync(
  join(DIST, 'assets/js/config.js'),
  `/* Generated by build.mjs from site.config.mjs -- do not edit. */\n\nexport const CONFIG = ${JSON.stringify(
    {
      ...appConfig,
      apkHref: apkPath,
      apkSizeLabel: `~${Math.round(mb)} MB`,
      exactSizeLabel: `${mb.toFixed(1)} MB`,
    },
    null,
    2,
  )};\n\nexport const SCREENSHOTS = ${JSON.stringify(screenshots, null, 2)};\n` +
    `export const SHOWCASES = ${JSON.stringify(showcases, null, 2)};\n` +
    `export const FEATURES = ${JSON.stringify(features, null, 2)};\n` +
    `export const TRUST = ${JSON.stringify(trustPoints, null, 2)};\n` +
    `export const AUDIENCES = ${JSON.stringify(audiences, null, 2)};\n` +
    `export const FAQS = ${JSON.stringify(faqs, null, 2)};\n` +
    `export const CHANGELOG = ${JSON.stringify(changelog, null, 2)};\n` +
    `export const CHANNELS = ${JSON.stringify(channels, null, 2)};\n` +
    `export const TILES = ${JSON.stringify(tiles, null, 2)};\n` +
    `export const ABOUT = ${JSON.stringify(about, null, 2)};\n` +
    `export const DATA_SAFETY = ${JSON.stringify(dataSafety, null, 2)};\n` +
    `export const APP_INFO = ${JSON.stringify(appInfo, null, 2)}\n`
);

// Static assets: images, fonts, and the APK only when it is self-hosted.
const SKIP = apkIsExternal ? new Set(['downloads']) : new Set();
const walk = (dir, dest, skip = new Set()) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = join(dir, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) walk(from, to, skip);
    else copy(from, to);
  }
};
walk(PUBLIC, DIST, SKIP);

// --------------------------------------------------------------- HTML pass
const tokens = {
  name: appConfig.name,
  tagline: appConfig.tagline,
  shortDescription: appConfig.shortDescription,
  category: appConfig.category,
  version: appConfig.version,
  buildNumber: appConfig.buildNumber,
  releaseChannel: appConfig.releaseChannel,
  releaseDateLabel: appConfig.releaseDateLabel,
  releaseDateShort: appConfig.releaseDateShort ?? appConfig.releaseDateLabel,
  heroSupport: appConfig.heroSupport ?? appConfig.shortDescription,
  platform: appConfig.platform,
  apkHref: apkPath,
  apkSizeLabel: `~${Math.round(mb)} MB`,
  minAndroidVersion: appConfig.minAndroidVersion,
  abi: appConfig.abi,
  developer: appConfig.developer,
  appInfoTitle: appInfo.title,
  appInfoFootnote: appInfo.footnote,
  supportEmail: appConfig.supportEmail,
  year: appConfig.year,
  siteUrl: SITE_URL,
};

const render = (file) =>
  readFileSync(join(SRC, file), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (key in tokens) return tokens[key];
    warn(`Template used {{${key}}} but no value was supplied (in ${file}).`);
    return m;
  });

writeFileSync(join(DIST, 'index.html'), render('index.html'));
writeFileSync(join(DIST, 'privacy.html'), render('privacy.html'));
writeFileSync(join(DIST, 'terms.html'), render('terms.html'));

/* ------------------------------------------------------------ side files */
writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`);

writeFileSync(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${SITE_URL}</loc>\n    <lastmod>${appConfig.releaseDate}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>\n`
);

/*
 * A root favicon.ico, copied from the 32px PNG.
 *
 * The page already declares <link rel="icon" href="assets/img/favicon-32.png">,
 * but browsers still request /favicon.ico on their own and log a 404 when it is
 * missing. A PNG at that path is served fine -- every current browser sniffs the
 * content -- and it is the difference between a clean console and a permanent 404.
 */
copyFileSync(join(PUBLIC, 'assets/img/favicon-32.png'), join(DIST, 'favicon.ico'));

writeFileSync(join(DIST, 'manifest.webmanifest'),
  JSON.stringify(
    {
      name: `${appConfig.name} — ${appConfig.tagline}`,
      short_name: appConfig.name,
      description: appConfig.shortDescription,
      start_url: '/',
      display: 'standalone',
      background_color: '#0b1120',
      theme_color: '#0b1120',
      icons: [
        { src: 'assets/img/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'assets/img/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'assets/img/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
null,
      2,
    )
);

/*
 * Content-version every asset URL, before the Vercel headers are written.
 *
 * Why this exists: `/assets/(.*)` is served `max-age=31536000, immutable`. That is
 * the right header for a content-addressed asset and the wrong header for a fixed
 * filename. Deploying new site.js / config.js to the same URLs left returning
 * visitors running the previous release indefinitely -- the page loaded, the hero
 * rendered, and nothing that JavaScript draws ever updated.
 *
 * So the asset URLs carry a hash of their own content. Immutable caching then does
 * exactly what it promises: a URL changes when the bytes change, and a returning
 * visitor gets the new build.
 *
 * The version is derived from the built files rather than the release version, so
 * editing a screenshot or a stylesheet is enough to bust the cache.
 */
const assetVersion = createHash('sha256')
  .update(readFileSync(join(DIST, 'assets/js/site.js')))
  .update(readFileSync(join(DIST, 'assets/css/site.css')))
  .update(readFileSync(join(DIST, 'assets/js/config.js')))
  .digest('hex')
  .slice(0, 10);

/** Appends `?v=<hash>` to an asset path, leaving anything else untouched. */
function versionAsset(match) {
  if (/\?/.test(match)) return match;
  return `${match}?v=${assetVersion}`;
}

/**
 * Matches a relative `url()` in a stylesheet, skipping data URIs, absolute URLs
 * and root-relative paths (which the deployment rewrites anyway).
 */
const CSS_URL = /url\((['"]?)(?!data:|https?:|\/)([^)'"]+)\1\)/g;

// HTML: src/href attributes that point into assets/.
for (const page of ['index.html', 'privacy.html', 'terms.html']) {
  const file = join(DIST, page);
  const html = readFileSync(file, 'utf8').replace(
    /((?:src|href)="assets\/[^"?]+)/g,
    versionAsset,
  );
  writeFileSync(file, html);
}

// site.js imports config.js as an ES module; the query has to go on the import
// specifier or the browser keeps the cached config.js.
{
  const file = join(DIST, 'assets/js/site.js');
  const js = readFileSync(file, 'utf8').replace(
    /(['"])\.\/config\.js\1/g,
    `$1./config.js?v=${assetVersion}$1`,
  );
  writeFileSync(file, js);
}

// site.css references images and fonts with url().
{
  const file = join(DIST, 'assets/css/site.css');
  const css = readFileSync(file, 'utf8').replace(CSS_URL, (whole, quote, path) => {
    if (/\?/.test(path)) return whole;
    return `url(${quote}${path}?v=${assetVersion}${quote})`;
  });
  writeFileSync(file, css);
}

/*
 * fonts.css is the same story one level down: it is the stylesheet that
 * `@import`s nothing and points straight at the woff2 files, and it is copied
 * rather than rendered, so it does not pick up the pass above.
 */
{
  const file = join(DIST, 'assets/css/fonts.css');
  const css = readFileSync(file, 'utf8').replace(CSS_URL, (whole, quote, path) => {
    if (/\?/.test(path)) return whole;
    return `url(${quote}${path}?v=${assetVersion}${quote})`;
  });
  writeFileSync(file, css);
}

// manifest.webmanifest names its own icons, and the service worker fetch of the
// manifest is not a browser sub-resource load, so it never gets the HTML's query.
{
  const file = join(DIST, 'manifest.webmanifest');
  const manifest = readFileSync(file, 'utf8').replace(
    /("src"\s*:\s*")([^"?]+)(")/g,
    (_all, open, path, close) => `${open}${path}?v=${assetVersion}${close}`,
  );
  writeFileSync(file, manifest);
}

console.log(`  asset version   ${assetVersion} (appended to every asset URL)`);

/*
 * A vercel.json inside dist as well, so the built folder can be deployed on its
 * own as the project root.
 *
 * Deploying `website/dist` directly is the path that actually works: pointing
 * Vercel at `outputDirectory: website/dist` with a null buildCommand copied only
 * the six files at the root of dist and dropped the whole assets/ tree, which
 * left every stylesheet, script and screenshot 404ing. Dist as the project root
 * has no such ambiguity.
 */
writeFileSync(
  join(DIST, 'vercel.json'),
  JSON.stringify(
    {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      cleanUrls: true,
      trailingSlash: false,
      headers: [
        {
          source: '/assets/(.*)',
          headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
        },
        {
          source: '/(.*)',
          headers: [
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          ],
        },
      ],
    },
    null,
    2,
  )
);

/* --------------------------------------------------------------- report */
if (problems.length) {
  console.error('\nUnresolved template values:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const human = (n) => `${(n / 1024).toFixed(0)} KB`;
const sizeOf = (dir) => {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(p) : statSync(p).size;
  }
  return total;
};

const shots = screenshots.length;
const dark = screenshots.filter((s) => s.dark).length;

console.log(`\n  ${appConfig.name} site -> ${relative(process.cwd(), DIST) || 'website/dist'}\n`);
console.log(`  version      ${appConfig.version} (build ${appConfig.buildNumber}), ${appConfig.releaseDateLabel}`);
console.log(`  apk          ${apkIsExternal ? apkPath : `public/${apkPath}`}  ${mb.toFixed(1)} MB  [${apkIsExternal ? 'external' : 'present'}]`);
console.log(`  screenshots  ${shots} captures (${dark} with a dark-theme pair)`);
console.log(`  icons        favicon-32, favicon-96, apple-touch, 192, 512, og-image`);
console.log(`  fonts        Inter latin + latin-ext (self-hosted)`);
console.log(`  total        ${human(sizeOf(DIST))} including the APK\n`);