# SellFlow — official product & download page

The public page for the SellFlow Android app. Laid out as an **app-store
product page**: a white page, one very large product name, a stats row, a
single dominant Install button, a horizontal screenshot rail, then factual
sections — About this app, Data safety, Ratings and reviews, FAQ, Install.

```
website/
  site.config.mjs        <- THE config. Version, size, APK path, copy, data safety.
  build.mjs              Renders site.config.mjs + src/ into dist/.
  serve.mjs              Local preview server (node serve.mjs [port], default 8099).
  fetch-fonts.mjs        Downloads the self-hosted Inter subsets and regenerates src/fonts.css.
  og-render.mjs          Renders src/og.html to the Open Graph / Twitter card.
  review.mjs             Screenshots every breakpoint and reports overflow / a11y / asset problems.
  interactions.mjs       Drives the rail, lightbox, FAQ, review form and download button.
  diag.mjs               Ad-hoc DOM inspection helper for debugging a layout.

  src/                   Templates and source assets (edit these)
  public/                Static passthrough: images, fonts, the APK
  dist/                  Build output. This is what you deploy.
```

## Commands

```bash
node build.mjs        # build dist/
node serve.mjs 8099   # preview dist/ at http://127.0.0.1:8099
node review.mjs       # layout + accessibility + asset audit (needs serve.mjs running)
node interactions.mjs # functional test of the interactive parts
```

## Shipping a new release

Everything release-specific lives in one object at the top of
`site.config.mjs`. Nothing about the version, size or download path is written
into the markup by hand.

**1. Put the new APK in place**

```bash
cp path/to/new-build.apk website/public/downloads/sellflow-latest.apk
```

**2. Update the config**

```js
export const appConfig = {
  version: '1.1.0',
  buildNumber: '2',
  releaseDate: '2026-11-14',
  releaseDateLabel: '14 November 2026',
  releaseDateShort: '14 Nov 2026',
  apkSizeBytes: 115_000_000,
};
```

`apkSizeBytes` is re-read from the file at build time, so the displayed size
cannot go stale.

`apkPath` defaults to `downloads/sellflow-latest.apk`. To host the APK
elsewhere, point it at an absolute URL:

```js
apkPath: 'https://cdn.example.com/sellflow/1.1.0/sellflow-1.1.0.apk',
```

**3. Build and preview**

```bash
node build.mjs && node serve.mjs
```

The build **fails loudly** if the APK is missing, if a screenshot referenced by
the config is not on disk, or if a rail tile points at an unknown screenshot id.
A download button that 404s is worse than no page.

Set the real domain once you host it:

```bash
SELLFLOW_SITE_URL=https://sellflow.app/ node build.mjs
```

## Honest-by-default content

Four things on this page are deliberately *empty*, and the code keeps them that
way until real data exists. There is a test for each one in `interactions.mjs`.

| Where | Config | Current state |
| --- | --- | --- |
| Ratings | `appConfig.ratings`, `reviewCount` | `null` / `0` → "No ratings yet", and **no histogram at all** (an all-zero bar chart reads as a 1-star rating) |
| Reviews | `localStorage` only | Stored in the visitor's own browser, labelled "Stored on this device — not published", never counted toward the rating |
| Store ranking | — | No "#1 top free ..." label. There is no listing, so there is no ranking to claim |
| Play Store | `appConfig.playStoreUrl` | `null` → the page says "Direct APK" and mentions Play only to explain the unknown-source prompt |

If real ratings arrive, set `ratings`, `reviewCount` and `ratingCounts` in the
config and the score plus star histogram appear automatically.

The review form already has a honeypot field, rating and length validation, and
a confirmation state. Wiring it to a backend means replacing the `REVIEW_KEY`
handling in `src/site.js` with a fetch.

## Data safety claims

`dataSafety` in `site.config.mjs` was written against the code, not from
template. Verified before writing:

- `package.json` contains **no** analytics, advertising, attribution or crash
  reporting SDK.
- `app.json` declares **no Android permissions**.
- All traffic goes to Supabase over HTTPS.
- The app ships only a public, read-restricted key; privileged access stays on
  the server.

If you later add an analytics SDK or request a permission, those claims become
false — update `dataSafety` in the same change.

## Screenshots

Every image in `public/assets/img/screens/` is a real capture of the shipped app
rendered in a real browser. The rail shows 12 of them as headline tiles; the
lightbox reaches all 20.

To refresh them after a UI change:

```bash
# 1. Start the app:  npx expo start --web
# 2. Sign in as the seeded business
# 3. Capture each route at 390x844, deviceScaleFactor 2, once per theme
```

Captured routes: `/`, `/orders`, `/order/[id]`, `/products`, `/product/[id]`,
`/customers`, `/customer/[id]`, `/finance`, `/analytics`, `/notifications`,
`/order-requests`, `/more`, `/settings/appearance`, plus the signed-out
`/sign-in` and `/sign-up`, the public order-link page, and the onboarding and
preparing states.

Two traps worth knowing if you re-capture:

- The app persists an explicit appearance preference in
  `localStorage["sellflow:v1:appearance"]`. Setting the OS colour scheme alone
  does nothing once that is set — write the key directly. (`review.mjs` had the
  same bug: a stale `Emulation.setEmulatedMedia` override made every "light"
  capture come out dark.)
- Detail routes are **singular** (`/order/[id]`), while the tab routes are
  **plural** (`/orders`).

## Design

The page is light-only and deliberately so: an app-store product page is a
white page. The app itself supports dark mode and the screenshots show it, but
the page around them stays light so the product page reads as a product page.

The accent is SellFlow blue (`--accent`) rather than a store green, so the page
still matches the app. Type is Inter, self-hosted from
`public/assets/fonts/` (latin + latin-ext only). To re-fetch:

```bash
node fetch-fonts.mjs
```

One CSS rule that is load-bearing rather than cosmetic, documented in place:

```css
img { height: auto; }
```

Without it the `height` attribute in the markup beats `width: 100%`, the tile
frame becomes 232x700 around a 416px-tall image, and `object-fit: cover` then
crops the left and right off every screenshot in the rail.

## Notes

- No framework and no client-side dependencies. Static HTML, one stylesheet,
  one ES module.
- The APK download button issues a `HEAD` request first and says "APK
  unavailable" if the file is not actually there, rather than pretending to
  start a download.
- `robots.txt`, `sitemap.xml` and `manifest.webmanifest` are generated by the
  build.
- `public/downloads/` and `dist/` are gitignored. Do not commit the APK.