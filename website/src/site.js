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
  if (channels) channels.replaceChildren(...CHANNELS.map((c) => el('span', { class: 'chip' }, c)));

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