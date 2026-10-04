/**
 * SellFlow product page behaviour.
 *
 * All repeated content (the screenshot rail, "About this app", Data safety,
 * features, FAQ, release notes) is rendered from `config.js`, which the build
 * generates from site.config.mjs. A caption can therefore never point at a
 * screenshot that is not there, and shipping a release means editing one file.
 *
 * Layout is an app-store product page: white, one big product name, a stats
 * row, one dominant Install button, a horizontal screenshot rail, then factual
 * sections.
 */

import {
  CONFIG,
  SCREENSHOTS,
  TILES,
  ABOUT,
  DATA_SAFETY,
  APP_INFO,
  FEATURES,
  TRUST,
  FAQS,
  CHANGELOG,
  CHANNELS,
} from './config.js';

/* ------------------------------------------------------------------ utils */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

/**
 * Official brand marks for the social channels.
 *
 * Real logos with their real colours, inlined as path data so they cost no
 * extra requests and inherit no external stylesheet. Paths are 24x24 viewBox,
 * the same as every other glyph in this file.
 */
const BRANDS = {
  facebook: { fill: '#0866FF', d: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.625.487-.413.435-.587 1.075-.587 1.98v2.24h4.784l-.387 3.667h-4.397v7.98z' },
  instagram: {
    fill: '#E1306C',
    d: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zm0 10.162a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z',
  },
  whatsapp: {
    fill: '#25D366',
    d: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.2-.298-.435-.051-.634.222-.182.62-.616.79-.834.173-.222.279-.435.403-.713.126-.279.037-.52-.062-.714-.147-.247-.66-1.61-.92-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884a9.82 9.82 0 0 1 6.988 2.896 9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z',
  },
  tiktok: {
    fill: '#111111',
    d: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
  },
  messenger: {
    fill: '#0084FF',
    d: 'M12 2C6.36 2 2 6.13 2 11.7c0 3.09 1.4 5.84 3.64 7.75.13.12.21.29.21.46v2.2c0 .4.42.7.78.55l2.06-.85c.11-.05.23-.06.35-.06h.42a9.66 9.66 0 0 0 3.54-.66.48.48 0 0 0 .22-.62 1.24 1.24 0 0 1-.12-.86c-.57-.32-1.1-.7-1.59-1.12a.44.44 0 0 1-.05-.67c1.36-1.27 2.3-2.99 2.7-4.94.02-.07.02-.14.02-.21a.45.45 0 0 0-.1-.29c-1.87-3.25-5.4-5.38-9.28-5.38zm6.13 8.3c-.28 0-.51-.14-.66-.37l-1.46-2.16-1.42 2.13c-.18.27-.8.27-1.06.01l-2.03-2.65-2.01 2.6a.52.52 0 0 1-.78-.05.51.51 0 0 1 .05-.77l2.31-3c.2-.26.58-.31.83-.1l2.06 2.54 1.96-2.46a.52.52 0 0 1 .83.05l2.4 3.04c.48.6-.33 1.34-.94 1.19z',
  },
  globe: { fill: 'currentColor', d: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.95a15.7 15.7 0 0 0-1.38-3.56A8 8 0 0 1 18.9 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14A8 8 0 0 1 4 12c0-.69.1-1.36.26-2h3.38a16.5 16.5 0 0 0 0 4H4.26zm.84 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.99 7.99 0 0 1 5.1 16zm2.95-8H5.1a8 8 0 0 1 4.33-3.56A15.7 15.7 0 0 0 8.05 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82A13.7 13.7 0 0 1 12 19.96zM14.34 14H9.66a14.7 14.7 0 0 1 0-4h4.68a14.7 14.7 0 0 1 0 4zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14a16.5 16.5 0 0 0 0-4h3.38c.17.63.26 1.31.26 2s-.09 1.36-.26 2h-3.38z',
  },
  phone: { fill: 'currentColor', d: 'M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02z' },
};

/** A filled brand mark, sized to sit on the text baseline. */
function brandGlyph(key) {
  const b = BRANDS[key];
  if (!b) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'brand-mark');
  svg.setAttribute('fill', b.fill);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', b.d);
  svg.append(p);
  return svg;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One consistent 24px outline set, plus a solid star for ratings. */
const ICONS = {
  arrow: 'M5 12h13M13 6l6 6-6 6',
  chevron: 'M9 5l7 7-7 7',
  plus: 'M12 5v14M5 12h14',
  check: 'M4 12.5 9 17.5 20 6.5',
  info: 'M12 16v-5M12 8h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
  share:
    'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6M8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  phone: 'M7 2.5h10a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V4A1.5 1.5 0 0 1 7 2.5M10.5 18.5h3',
  tablet: 'M5 3.5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1M10.5 16h3',
  desktop: 'M3 4.5h18a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1M8 20.5h8M12 17v3.5',
  cpu: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1M10 10h4v4h-4z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1',
  trash: 'M5 7h14M9 7V5h6v2M6.5 7l1 13h9l1-13M10.5 11v5M13.5 11v5',
  eyeOff: 'M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.5 5.2A9.7 9.7 0 0 1 12 5c5 0 9 4.5 9 7 0 .8-.7 2-2 3.2M6.5 7.8C4.6 9 3 10.9 3 12c0 2.5 4 7 9 7 1 0 2-.2 2.9-.5',
  /* feature + data-safety glyphs */
  clipboard: 'M9 4h6v3H9zM8 5.5H6.5A1.5 1.5 0 0 0 5 7v12.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V7a1.5 1.5 0 0 0-1.5-1.5H16M9 12h6M9 16h4',
  box: 'M12 3 4 7v10l8 4 8-4V7zM4 7l8 4 8-4M12 11v10',
  users: 'M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 20v-1.5a4 4 0 0 0-3-3.85M16 3.6a4 4 0 0 1 0 7.75',
  wallet: 'M3 8.5A2.5 2.5 0 0 1 5.5 6H18a1 1 0 0 1 1 1v2M3 8.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M3 8.5h15M21 10.5h-4a1.5 1.5 0 0 0 0 3h4z',
  truck: 'M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M17.5 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  cloudOff: 'M3 3l18 18M7.5 7.5A5 5 0 0 1 17 9.5h.5a3.5 3.5 0 0 1 1 6.9M9.5 18.5H7a4 4 0 0 1-.6-7.96',
  link: 'M10 13a4 4 0 0 0 5.7.4l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7M14 11a4 4 0 0 0-5.7-.4l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7',
  bell: 'M18 8.5a6 6 0 1 0-12 0c0 6-2 7.5-2 7.5h16s-2-1.5-2-7.5M13.7 20a2 2 0 0 1-3.4 0',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5',
  user: 'M12 11.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4.5 21v-1a5.5 5.5 0 0 1 11 0v1',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  building: 'M4 21V4.5h9V21M13 10h7v11M7 8h3M7 12h3M7 16h3M16 14h1.5M16 17.5h1.5',
  message:
    'M20.5 12.5a7.5 7.5 0 0 1-10.9 6.7L4 20.5l1.3-5.6A7.5 7.5 0 1 1 20.5 12.5zM8.5 11h7M8.5 14.5h4.5',
  shield: 'M12 3l7.5 3v5.5c0 4.4-3 8.3-7.5 9.5-4.5-1.2-7.5-5.1-7.5-9.5V6z',
};

function icon(name, extra = {}) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', String(extra.width ?? 1.8));
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  if (extra.class) s.setAttribute('class', extra.class);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] ?? ICONS.info);
  s.append(p);
  return s;
}

/** Solid star, used for every rating display. */
function starGlyph() {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M12 2.6l2.9 6.1 6.6.9-4.8 4.7 1.2 6.7L12 17.8 6.1 21l1.2-6.7L2.5 9.6l6.6-.9z');
  s.append(p);
  return s;
}

const starRow = (value, cls = 'stars') => {
  const row = el('span', { class: cls, 'aria-hidden': 'true' });
  for (let i = 0; i < 5; i++) {
    const wrap = el('span', { class: i < Math.round(value) ? '' : 'off' });
    wrap.append(starGlyph());
    row.append(wrap);
  }
  return row;
};

const ASSET = (p) => `assets/img/${p}`;
const byId = (id) => SCREENSHOTS.find((s) => s.id === id);
const hasRatings = () => Boolean(CONFIG.ratings && CONFIG.reviewCount > 0);

/* ----------------------------------------------------------------- rail */
function renderRail() {
  const host = $('[data-rail]');
  if (!host) return;

  host.replaceChildren(
    ...TILES.map((tile, i) => {
      const shot = byId(tile.id);
      if (!shot) return null;
      return el(
        'button',
        {
          class: 'tile',
          type: 'button',
          'data-index': SCREENSHOTS.indexOf(shot),
          'aria-label': `Enlarge screenshot: ${shot.title}`,
        },
        // A <p>, not a heading: this sits inside a button, and an <h3> there
        // both broke the document outline and read as a section title.
        el('span', { class: `tile-art tint-${tile.tint}` }, el('p', { class: 'tile-head' }, tile.headline)),
        el(
          'span',
          { class: 'tile-shot' },
          el('img', {
            src: ASSET(shot.file),
            alt: shot.alt,
            width: 390,
            height: 700,
            loading: i < 3 ? 'eager' : 'lazy',
            decoding: 'async',
          }),
        ),
        el('span', { class: 'tile-cap' }, shot.title),
      );
    }),
  );

  const note = $('[data-rail-note]');
  if (note) {
    note.replaceChildren(
      document.createTextNode(
        `${SCREENSHOTS.length} screens from the ${CONFIG.version} Android build — all real captures, not illustrations. `,
      ),
      el('a', { href: '#ratings', style: 'color: var(--accent)' }, 'Tap any screen to see it full size.'),
    );
  }

  // The arrow only makes sense while there is more rail to reveal.
  const next = $('[data-rail-next]');
  if (next) {
    const sync = () => {
      const atEnd = host.scrollLeft + host.clientWidth >= host.scrollWidth - 8;
      next.hidden = atEnd || host.scrollWidth <= host.clientWidth + 8;
    };
    next.addEventListener('click', () => {
      host.scrollBy({ left: Math.round(host.clientWidth * 0.8), behavior: 'smooth' });
    });
    host.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    sync();
  }
}

/* ---------------------------------------------------------------- about */
function renderAbout() {
  const host = $('[data-about]');
  if (host) host.replaceChildren(...ABOUT.body.map((p) => el('p', {}, p)));

  const cats = $('[data-categories]');
  if (cats) {
    // No "#1 in ..." label: that is a store ranking and there is no listing.
    cats.replaceChildren(
      el('span', { class: 'chip chip-accent' }, CONFIG.category),
      el('span', { class: 'chip' }, 'Productivity'),
      el('span', { class: 'chip' }, 'Finance'),
      el('span', { class: 'chip' }, `${CONFIG.platform} ${CONFIG.minAndroidVersion.replace('Android ', '')}+`),
      el('span', { class: 'chip' }, 'Direct APK'),
    );
  }

  const info = $('[data-app-info]');
  if (info) {
    info.replaceChildren(
      ...APP_INFO.rows.map((r) => el('div', { class: 'info-row' }, el('span', {}, r.label), el('b', {}, r.value))),
    );
  }

  const facts = $('[data-install-facts]');
  if (facts) {
    facts.replaceChildren(
      ...[
        ['App', `${CONFIG.name} ${CONFIG.version}`],
        ['Build', `${CONFIG.version} (${CONFIG.buildNumber})`],
        ['Updated', CONFIG.releaseDateLabel],
        ['Size', CONFIG.apkSizeLabel],
        ['Requires', CONFIG.minAndroidVersion],
        ['Architectures', CONFIG.abi],
        ['Obtained from', 'Direct download (not Google Play)'],
      ].map(([label, value]) => el('div', { class: 'info-row' }, el('span', {}, label), el('b', {}, value))),
    );
  }
}

/* ----------------------------------------------------------- data safety */
function renderSafety() {
  const intro = $('[data-safety-intro]');
  if (intro) intro.textContent = DATA_SAFETY.intro;

  const host = $('[data-safety]');
  if (!host) return;

  const row = (iconName, block, types) =>
    el(
      'div',
      { class: 'safety-row' },
      el('span', { class: 'safety-icon' }, icon(iconName)),
      el(
        'div',
        {},
        el('h3', {}, block.headline),
        block.detail ? el('p', {}, block.detail) : null,
        types
          ? el(
              'div',
              { class: 'safety-types' },
              ...types.types.map((t) =>
                el('span', { class: 'safety-type' }, icon(t.icon, { width: 1.7 }), el('span', {}, t.label)),
              ),
            )
          : null,
      ),
    );

  host.replaceChildren(
    row('share', DATA_SAFETY.shared),
    row('info', DATA_SAFETY.collected, DATA_SAFETY.collected),
    /*
     * The SMS permission gets its own row, not a clause inside "data not
     * collected".
     *
     * The app does read messages -- bKash, Nagad, Rocket and Upay payment
     * notifications -- so burying that inside a list of things it does not touch
     * would be the wrong shape. It states the permission, what is never asked
     * for, and that message text is never kept, in that order, because that is
     * the order a reader needs it in.
     */
    ...(DATA_SAFETY.permissions
      ? [
          el(
            'div',
            { class: 'safety-row' },
            el('span', { class: 'safety-icon' }, icon('shield')),
            el(
              'div',
              {},
              el('h3', {}, DATA_SAFETY.permissions.headline),
              DATA_SAFETY.permissions.detail
                ? el('p', {}, DATA_SAFETY.permissions.detail)
                : null,
              DATA_SAFETY.permissions.rows?.length
                ? el(
                    'div',
                    { class: 'safety-rows' },
                    ...DATA_SAFETY.permissions.rows.map((r) =>
                      el(
                        'div',
                        { class: 'safety-rows-item' },
                        el('span', { class: 'safety-rows-key' }, r.label),
                        el('span', { class: 'safety-rows-val' }, r.value),
                      ),
                    ),
                  )
                : null,
              /*
               * Stated in public, on the page, rather than only in the repo. The
               * feature is new and unconfirmed against live provider messages, and
               * a seller reading "automatic detection" deserves to know that
               * before they turn it on.
               */
              DATA_SAFETY.permissions.honesty
                ? el('p', { class: 'safety-honesty' }, DATA_SAFETY.permissions.honesty)
                : null,
            ),
          ),
        ]
      : []),
    row('eyeOff', DATA_SAFETY.notCollected),
    row('lock', DATA_SAFETY.transit),
    row('trash', DATA_SAFETY.control),
  );

  /*
   * The engineering claims live in their own card. Folding them into the data
   * safety card blurred two different things: what is collected, and why the
   * numbers can be relied on.
   */
  const quality = $('#quality');
  if (quality) {
    quality.replaceChildren(
      ...TRUST.slice(0, 6).map((t) =>
        el(
          'div',
          { class: 'safety-row' },
          el('span', { class: 'safety-icon' }, icon('check')),
          el('div', {}, el('h3', {}, t.title), el('p', {}, t.body)),
        ),
      ),
    );
  }
}

/* ----------------------------------------------------------- ratings UI */
function renderRatings() {
  const summary = $('[data-rating-summary]');

  if (hasRatings()) {
    // Real ratings exist: show the score and the histogram.
    const bars = el('div', { class: 'bars' });
    for (let star = 5; star >= 1; star--) {
      const pct = Math.round(((CONFIG.ratingCounts?.[star - 1] ?? 0) / CONFIG.reviewCount) * 100);
      bars.append(
        el(
          'div',
          { class: 'bar-row' },
          el('span', {}, String(star)),
          el(
            'span',
            { class: 'bar' },
            el('i', {
              style: `width:${pct}%`,
              role: 'img',
              'aria-label': `${star} stars: ${pct}% of reviews`,
            }),
          ),
        ),
      );
    }
    summary?.replaceChildren(
      el(
        'div',
        { class: 'rating-summary' },
        el(
          'div',
          { class: 'rating-big' },
          el('b', {}, CONFIG.ratings.toFixed(1)),
          starRow(CONFIG.ratings),
          el('span', {}, `${CONFIG.reviewCount} reviews`),
        ),
        bars,
      ),
    );
  } else {
    // Nothing to plot. An all-zero histogram would imply a rating of 1, so the
    // summary is omitted entirely and the empty state below carries the message.
    summary?.replaceChildren();
  }

  const value = $('[data-rating-value]');
  if (value) value.replaceChildren(hasRatings() ? starRow(CONFIG.ratings) : document.createTextNode('No ratings yet'));
  const count = $('[data-rating-count]');
  if (count) count.textContent = hasRatings() ? `${CONFIG.reviewCount} reviews` : 'Be the first to review';

  const emptyStars = $('.reviews-empty .stars');
  if (emptyStars) emptyStars.replaceChildren(...starRow(0).childNodes);

  const verify = $('[data-verify-note]');
  if (verify && !hasRatings()) {
    verify.textContent = 'SellFlow is a new release, so there are no ratings to verify yet.';
  }
}

function renderDevicePills() {
  const host = $('[data-device-pills]');
  if (!host) return;
  const devices = [
    ['Phone', 'phone', true],
    ['Tablet', 'tablet', false],
    ['Desktop', 'desktop', false],
  ];
  host.replaceChildren(
    ...devices.map(([label, ico, on]) =>
      el(
        'button',
        {
          class: 'pill',
          type: 'button',
          'aria-pressed': String(on),
          'data-device': label.toLowerCase(),
        },
        icon(ico),
        label,
      ),
    ),
  );

  // Reviews are not tagged by device yet, so switching filters nothing. Say so
  // rather than presenting a filter that silently does nothing.
  $$('.pill', host).forEach((pill) => {
    pill.addEventListener('click', () => {
      if (pill.dataset.device === 'phone') return;
      pill.setAttribute('aria-busy', 'true');
      setTimeout(() => pill.removeAttribute('aria-busy'), 600);
      const note = $('[data-verify-note]');
      if (note) note.textContent = `Reviews are not tagged by device yet, so only phone reviews exist.`;
    });
  });
}

/* ------------------------------------------------------------- features */
function renderFeatures() {
  const host = $('[data-features]');
  if (!host) return;
  host.replaceChildren(
    ...FEATURES.map((f) =>
      el(
        'div',
        { class: 'feature' },
        el('span', { class: 'feature-icon' }, icon(f.icon)),
        el('div', {}, el('h3', {}, f.title), el('p', {}, f.body)),
      ),
    ),
  );

  const channels = $('[data-channels]');
  if (channels) {
    channels.replaceChildren(
      ...CHANNELS.map((c) => {
        const mark = brandGlyph(c.brand ?? c.glyph);
        return el(
          'li',
          { class: 'channel' },
          el('span', { class: 'channel-mark' }, mark),
          el('span', { class: 'channel-name' }, c.name),
        );
      }),
    );
  }

  const changes = $('[data-changelog]');
  if (changes) {
    changes.replaceChildren(...CHANGELOG.map((c) => el('li', {}, icon('check'), el('span', {}, c))));
  }
}

/* ------------------------------------------------------------------ faq */
function renderFaq() {
  const host = $('[data-faq]');
  if (!host) return;
  host.replaceChildren(
    ...FAQS.map((item, i) => {
      const panelId = `faq-panel-${i}`;
      const btnId = `faq-btn-${i}`;
      const btn = el(
        'button',
        {
          class: 'faq-q',
          type: 'button',
          id: btnId,
          'aria-expanded': 'false',
          'aria-controls': panelId,
        },
        el('span', {}, item.q),
        icon('plus'),
      );
      const wrap = el(
        'div',
        { class: 'faq-item' },
        el('h3', { style: 'margin:0' }, btn),
        el('div', { class: 'faq-a', id: panelId, role: 'region', 'aria-labelledby': btnId }, el('div', {}, el('p', {}, item.a))),
      );
      return wrap;
    }),
  );

  $$('.faq-q', host).forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const open = item.hasAttribute('data-open');
      $$('.faq-item', host).forEach((n) => {
        n.removeAttribute('data-open');
        $('.faq-q', n).setAttribute('aria-expanded', 'false');
      });
      if (!open) {
        item.setAttribute('data-open', '');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });
}

/* ------------------------------------------------------------- lightbox */
function initLightbox() {
  const box = $('[data-lightbox]');
  if (!box) return;
  const img = $('[data-lb-img]', box);
  const cap = $('[data-lb-caption]', box);
  const counter = $('[data-lb-counter]', box);
  let index = 0;
  let lastFocus = null;

  const show = (i) => {
    index = (i + SCREENSHOTS.length) % SCREENSHOTS.length;
    const shot = SCREENSHOTS[index];
    img.src = ASSET(shot.file);
    img.alt = shot.alt;
    cap.replaceChildren(el('b', {}, shot.title), document.createTextNode(shot.caption));
    counter.textContent = `${index + 1} / ${SCREENSHOTS.length}`;
  };

  const open = (i) => {
    lastFocus = document.activeElement;
    show(i);
    box.hidden = false;
    document.body.setAttribute('data-locked', '');
    $('[data-lb-close]', box).focus();
  };

  const close = () => {
    box.hidden = true;
    document.body.removeAttribute('data-locked');
    lastFocus?.focus?.();
  };

  $$('.tile').forEach((card) => card.addEventListener('click', () => open(Number(card.dataset.index))));
  $('[data-lb-close]', box).addEventListener('click', close);
  $('[data-lb-prev]', box).addEventListener('click', () => show(index - 1));
  $('[data-lb-next]', box).addEventListener('click', () => show(index + 1));
  box.addEventListener('click', (e) => {
    if (e.target === box) close();
  });

  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
    else if (e.key === 'Tab') {
      const focusables = $$('button', box);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  let x0 = null;
  box.addEventListener(
    'touchstart',
    (e) => {
      x0 = e.changedTouches[0].clientX;
    },
    { passive: true },
  );
  box.addEventListener(
    'touchend',
    (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 48) show(index + (dx < 0 ? 1 : -1));
      x0 = null;
    },
    { passive: true },
  );
}

/* ------------------------------------------------------------ star input */
let starValue = 0;

function initStarInput() {
  const host = $('[data-stars]');
  if (!host) return;
  const paint = () =>
    $$('.star-btn', host).forEach((b, i) => {
      b.setAttribute('aria-checked', String(i + 1 === starValue));
      b.dataset.on = String(i < starValue);
    });

  host.replaceChildren(
    ...Array.from({ length: 5 }, (_, i) =>
      el(
        'button',
        {
          class: 'star-btn',
          type: 'button',
          role: 'radio',
          'aria-checked': 'false',
          'aria-label': `${i + 1} star${i ? 's' : ''}`,
          onclick: () => {
            starValue = i + 1;
            paint();
            $('[data-star-error]').hidden = true;
          },
          onmouseenter: () => {
            $$('.star-btn', host).forEach((b, j) => (b.dataset.on = String(j <= i)));
          },
        },
        starGlyph(),
      ),
    ),
  );
  host.addEventListener('mouseleave', paint);
}

/* --------------------------------------------------------------- reviews */
/**
 * No public review database exists, so a submitted review is kept in this
 * browser only and labelled as such. It is never counted toward the rating.
 */
const REVIEW_KEY = 'sellflow:reviews:v1';

const readReviews = () => {
  try {
    const raw = localStorage.getItem(REVIEW_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

function reviewCard(r) {
  const date = new Date(r.date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return el(
    'article',
    { class: 'review' },
    el(
      'div',
      { class: 'review-head' },
      el('span', { class: 'review-av', 'aria-hidden': 'true' }, (r.name || '?').trim().charAt(0).toUpperCase()),
      el(
        'span',
        { class: 'review-who' },
        el('b', {}, r.name),
        el('span', {}, [r.business, 'Verified device: Android'].filter(Boolean).join(' · ')),
      ),
      el(
        'button',
        { class: 'review-menu', type: 'button', 'aria-label': `More actions for the review by ${r.name}` },
        (() => {
          const s = document.createElementNS(SVG_NS, 'svg');
          s.setAttribute('viewBox', '0 0 24 24');
          s.setAttribute('aria-hidden', 'true');
          for (const cy of [5, 12, 19]) {
            const c = document.createElementNS(SVG_NS, 'circle');
            c.setAttribute('cx', '12');
            c.setAttribute('cy', String(cy));
            c.setAttribute('r', '1.8');
            s.append(c);
          }
          return s;
        })(),
      ),
    ),
    el('div', { class: 'review-meta' }, starRow(r.rating), el('time', { datetime: r.date }, date)),
    el('p', { class: 'review-text' }, r.review),
    el('p', { class: 'review-help' }, 'Helpful votes are not collected yet.'),
    el('span', { class: 'review-local' }, 'Stored on this device — not published'),
  );
}

function renderReviews() {
  const list = readReviews();
  const host = $('[data-review-list]');
  const empty = $('[data-reviews-empty]');
  if (!list.length) {
    empty?.removeAttribute('hidden');
    if (host) host.hidden = true;
    return;
  }
  empty?.setAttribute('hidden', '');
  host.hidden = false;
  host.replaceChildren(...list.map(reviewCard));
}

/* --------------------------------------------------------------- review form */
function initReviewForm() {
  const form = $('[data-review-form]');
  if (!form) return;
  const status = $('[data-review-status]');

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    // Honeypot: a real person never fills this in.
    if (form.elements.website.value) {
      status.textContent = '';
      return;
    }

    const rating = starValue;
    const name = form.elements.name.value.trim();
    const text = form.elements.review.value.trim();

    const bad = rating === 0 || text.length < 10;
    $('[data-star-error]').hidden = rating > 0;
    $('[data-text-error]').hidden = text.length >= 10;
    form.elements.review.setAttribute('aria-invalid', String(text.length < 10));

    if (bad) {
      status.dataset.tone = 'bad';
      status.textContent = 'Please choose a rating and write at least a short review.';
      return;
    }

    const reviews = [
      { rating, name, business: form.elements.business.value, review: text, date: new Date().toISOString() },
      ...readReviews(),
    ];
    try {
      localStorage.setItem(REVIEW_KEY, JSON.stringify(reviews));
    } catch {
      status.dataset.tone = 'bad';
      status.textContent = 'This browser is blocking local storage, so the review could not be saved.';
      return;
    }

    renderReviews();
    form.reset();
    starValue = 0;
    $$('.star-btn').forEach((b) => (b.dataset.on = 'false'));
    status.dataset.tone = 'ok';
    status.textContent = 'Thank you. Your review is saved on this device and held for moderation.';
  });
}

/* ------------------------------------------------------------------ share */
function initShare() {
  const btn = $('[data-share]');
  const label = $('[data-share-label]');
  if (!btn) return;
  const original = 'Share';

  btn.addEventListener('click', async () => {
    const url = new URL(location.href).toString();
    const data = { title: CONFIG.name, text: `${CONFIG.name} — ${CONFIG.tagline}`, url };
    try {
      if (navigator.share) {
        await navigator.share(data);
        return;
      }
      await navigator.clipboard.writeText(url);
      label.textContent = 'Link copied';
    } catch {
      label.textContent = original;
      return;
    }
    setTimeout(() => (label.textContent = original), 2200);
  });
}

/* --------------------------------------------------------------- download */
/**
 * The APK is a real file, but it is hosted on a GitHub release rather than in
 * this deployment: a Vercel Hobby deployment caps static uploads at 100 MB and
 * the universal APK is 110.1 MB.
 *
 * The HEAD probe that proves the file is really there only works same-origin.
 * A cross-origin HEAD to the release asset is subject to CORS and would report
 * a failure for a perfectly good download, so for an external URL the button
 * makes no claim it cannot verify and simply lets the browser handle it.
 */
function initDownload() {
  const buttons = $$('[data-download]');
  const labels = new WeakMap();
  buttons.forEach((btn) => labels.set(btn, $('[data-download-label]', btn)?.textContent ?? ''));

  const isExternal = /^https?:\/\//i.test(CONFIG.apkHref) && !CONFIG.apkHref.startsWith(location.origin);

  if (isExternal) {
    // No probing. Let the browser own the navigation.
    return;
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const original = labels.get(btn);
      const label = $('[data-download-label]', btn);

      fetch(CONFIG.apkHref, { method: 'HEAD' })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          if (label) label.textContent = 'Downloading…';
          btn.setAttribute('data-state', 'done');
          setTimeout(() => {
            if (label) label.textContent = 'Download started';
          }, 900);
          setTimeout(() => {
            btn.removeAttribute('data-state');
            if (label) label.textContent = original;
          }, 6000);
        })
        .catch(() => {
          btn.setAttribute('data-state', 'error');
          if (label) label.textContent = 'APK unavailable';
          setTimeout(() => {
            btn.removeAttribute('data-state');
            if (label) label.textContent = original;
          }, 5000);
        });
    });
  });
}

/* ------------------------------------------------------- header / mobile */
function initChrome() {
  const header = $('[data-header]');
  const bar = $('[data-mobile-bar]');
  const install = $('#install');

  const onScroll = () => {
    header.toggleAttribute('data-stuck', window.scrollY > 8);
    if (bar && install) {
      bar.toggleAttribute('data-show', window.scrollY > 520 && window.scrollY < install.offsetTop - 220);
    }

    // Highlight the nav item for the section currently in view.
    const links = $$('[data-nav-for]');
    let active = null;
    for (const link of links) {
      const section = document.getElementById(link.dataset.navFor);
      if (section && section.getBoundingClientRect().top <= 140) active = link;
    }
    links.forEach((l) => l.removeAttribute('aria-current'));
    active?.setAttribute('aria-current', 'page');
  };

  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

/* ------------------------------------------------------------------ boot */
renderRail();
renderAbout();
renderSafety();
renderRatings();
renderDevicePills();
renderFeatures();
renderFaq();
renderReviews();
initLightbox();
initStarInput();
initReviewForm();
initShare();
initDownload();
initChrome();

// Anchor links should not fight the sticky header.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  const id = a.getAttribute('href').slice(1);
  if (!id) return;
  const target = document.getElementById(id);
  if (!target) return;
  e.preventDefault();
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  history.replaceState(null, '', `#${id}`);
});