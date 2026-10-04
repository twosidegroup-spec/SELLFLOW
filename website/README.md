# SellFlow â€” official product & download page

The public page for the SellFlow Android app. Laid out as an **app-store
product page**: a white page, one very large product name, a stats row, a
single dominant Install button, a horizontal screenshot rail, then factual
sections â€” About this app, Data safety, Ratings and reviews, FAQ, Install.

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
cp path/to/new-build.apk website/public/downloads/sellflow-1.1.0.apk
```

The file name must match `apkFileName`, which is what the build uses to measure
and verify the artifact. See "Where the APK is hosted" above for why the download
points at a GitHub Release rather than at this file.

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

`apkSizeBytes` is re-measured from the local copy at build time â€” including when
`apkPath` is an external URL â€” so the displayed size cannot go stale.

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
| Ratings | `appConfig.ratings`, `reviewCount` | `null` / `0` â†’ "No ratings yet", and **no histogram at all** (an all-zero bar chart reads as a 1-star rating) |
| Reviews | `localStorage` only | Stored in the visitor's own browser, labelled "Stored on this device â€” not published", never counted toward the rating |
| Store ranking | â€” | No "#1 top free ..." label. There is no listing, so there is no ranking to claim |
| Play Store | `appConfig.playStoreUrl` | `null` â†’ the page says "Direct APK" and mentions Play only to explain the unknown-source prompt |

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
- All traffic goes to Supabase over HTTPS.
- The app ships only a public, read-restricted key; privileged access stays on
  the server.

**Revised after Phase 2.** The previous version of this section claimed "`app.json`
declares **no** Android permissions`". That was true when written and stopped being
true when the native SMS listener shipped: the app now requests exactly one
permission, `android.permission.RECEIVE_SMS`, added by `plugins/withSellflowSms.js`
rather than by `app.json` (which is why a scan of `app.json` alone still finds
nothing â€” see `docs/google-play-sms-policy.md` Â§3).

`dataSafety` now states the permission, what is never asked for, that the message
inbox is never opened, that passcodes are ignored, that message text is never
stored, and that automatic detection has not yet been confirmed against live
provider messages. If you later add an analytics SDK, request another permission,
or turn automatic detection into something that reads more of a message, those
claims become false â€” update `dataSafety` in the same change.

## Where the APK is hosted

**A GitHub Release, not this repository and not Vercel.** `apkPath` points at
`https://github.com/twosidegroup-spec/SELLFLOW/releases/download/<tag>/<asset>`.

That is deliberate on two counts:

- The APK is **110 MB**, because it is a universal build carrying all four ABIs
  (arm64-v8a, armeabi-v7a, x86, x86_64). Vercel caps a single deployment file
  well below that, so a static asset would fail the build.
- `public/downloads/` and `dist/` are gitignored. The project policy is that a
  110 MB binary does not belong in Git history, and it does not.

Shipping a new APK:

```bash
# 1. Build it (EAS; the local Windows build fails on third-party C++ under NDK 27)
eas build --platform android --profile preview --non-interactive --no-wait

# 2. Publish it as a release asset
gh release create v1.1.0 sellflow-1.1.0.apk --repo twosidegroup-spec/SELLFLOW \
  --title "SellFlow 1.1.0 (Android preview)"

# 3. Put a copy in public/downloads/ so the build can measure and verify the size
cp sellflow-1.1.0.apk website/public/downloads/

# 4. Point the config at the new tag and rebuild
#    version / buildNumber / releaseDate / apkPath / apkFileName
node website/build.mjs
```

`build.mjs` re-measures the APK from `public/downloads/<apkFileName>` even when
`apkPath` is an external URL, and corrects `apkSizeBytes` to match. Without a local
copy it warns and falls back to the configured size, which is how the page
advertised the previous release's size for a while.

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
  does nothing once that is set â€” write the key directly. (`review.mjs` had the
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
## Deploying

**The site is a static bundle. Deploy `website/dist` as the project files.**

```bash
node build.mjs
cd dist && vercel deploy --prod
```

Two things that will silently break the site if they are changed, both learned
the hard way:

1. **`outputDirectory` drops `assets/`.** Pointing the Vercel project at
   `outputDirectory: website/dist` with a null buildCommand serves the six files at
   the root of `dist` and 404s the entire `assets/` tree — every stylesheet,
   script and screenshot. The page loads and looks broken. The project's
   `outputDirectory` and `rootDirectory` are both cleared; `dist` is uploaded as
   the project files instead.

2. **`/assets/(.*)` is served `max-age=31536000, immutable` at fixed URLs.** That
   header is only safe if the URL changes when the bytes do. Without versioning,
   deploying a new `config.js` or `site.js` left returning visitors running the
   previous release indefinitely: the HTML was fresh and nothing JavaScript draws
   ever updated. `build.mjs` therefore appends `?v=<hash>` to every asset URL —
   in the HTML, in `site.js`'s `import './config.js'`, and in `url()` inside
   `site.css` — where the hash is derived from the built files themselves.
   `dist/vercel.json` is generated by the build and carries the immutable header.

Verify a deployment against the real URL, not the CLI's success message:

```bash
SITE_URL=https://<the-deployment-url>/ node verify-release.mjs
```

`verify-release.mjs` asserts in a real browser (via the CDP helper in `tools/`)
that the download buttons exist and point at one `.apk`, that the SMS permission
disclosure renders, that the claims it replaced are gone, and that nothing
overclaims the SMS feature. `review.mjs` covers layout, overflow and
accessibility at four widths.
