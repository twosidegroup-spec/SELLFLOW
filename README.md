# SellFlow

**From order to delivered — all in one place.**

SellFlow is a mobile business operating system for social-commerce sellers.
Manage orders, products, inventory, customers, couriers, COD payments, finance
and profit from one Android app.

This repository contains two things:

| | |
| --- | --- |
| **The app** | An Expo / React Native Android app backed by Supabase. |
| **The website** | The official product and download page, in [`website/`](website/). |

## Downloading the app

The Android APK is published on the
[v1.0.0 release](https://github.com/twosidegroup-spec/SELLFLOW/releases/tag/v1.0.0).

```
https://github.com/twosidegroup-spec/SELLFLOW/releases/download/v1.0.0/sellflow-1.0.0.apk
```

- Universal APK: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`
- Requires Android 8.0 (API 26) or newer
- ~110 MB

Android will ask you to allow installation from an unknown source, because the
APK is distributed directly rather than through Google Play.

## What is in the app

- **Orders** — an explicit, enforced lifecycle. The database refuses invalid
  transitions, so a pending order cannot quietly become delivered.
- **Products & inventory** — available, reserved and sellable stock tracked
  separately, with every movement written to a ledger.
- **Customers** — contact details, order history, total spent and outstanding
  balance.
- **Finance** — revenue, product cost, courier cost and expenses separated, so
  you can see what the business actually keeps.
- **Couriers** — assign a courier, record tracking, and follow the parcel status
  and event timeline.
- **Analytics** — product performance and costs, measured against your store's
  business day and timezone.
- **Customer order links** — send a link, the buyer fills in the order from
  their own phone. Nobody installs anything.
- **Offline support** — keep working through a dropped connection; queued
  changes sync when you reconnect.
- **Light and dark themes.**

## Repository layout

```
src/          Expo Router app: every file is a screen
supabase/     SQL migrations, RLS policies, edge functions and DB tests
assets/       App icon, splash, monochrome icon, bundled Inter
scripts/      Verification and design-audit tooling
docs/         Release runbook and product notes
website/      The static product & download site (see website/README.md)
```

## Running the app locally

```bash
npm install
cp .env.example .env        # then fill in your Supabase URL and anon key
npx supabase start          # local database
npx expo start
```

`.env` is git-ignored and must never be committed. The app ships only a public,
read-restricted anon key; the `service_role` key stays on the server.

## Tests

```bash
npm test                    # unit, outbox, money, formatting, connectivity, design audits
npm run typecheck
npm run lint
```

Database suites run against a local Postgres container via
`supabase/test/verify_*.sql`.

## Building the Android APK

```bash
npx eas-cli build --profile preview --platform android
```

The `preview` profile produces an internal-distribution APK. Never commit the
built artifact — release binaries are published as GitHub release assets.

## The website

```bash
cd website
node build.mjs              # renders website/dist from site.config.mjs + src/
node serve.mjs              # preview at http://127.0.0.1:8099
node review.mjs             # layout, overflow and accessibility audit
node interactions.mjs       # drives the rail, lightbox, FAQ and review form
```

Every release-specific value — version, size, APK path, changelog — lives in
[`website/site.config.mjs`](website/site.config.mjs). The build fails if the
referenced screenshots or the APK are missing, so the page cannot ship a broken
download.

## Licence

MIT. See [LICENSE](LICENSE).