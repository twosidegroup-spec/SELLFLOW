# SellFlow V1 — Release Candidate Runbook

Everything a human needs to take this from the repository to a phone, and to run
the full verification suite. Commands are copy-pasteable and were executed as
written on Windows 11.

---

## 1. What is verified, and what is not

| Area | State |
|---|---|
| TypeScript, ESLint, Expo Doctor | verified, green |
| Android and iOS JS bundles | verified, green |
| Database suites (8 files) | verified on a clean database |
| Outbox runtime | verified against the real module |
| Courier (Pathao) | **not verified** — no credentials |
| Physical device | **not verified** — no device or SDK on this host |
| iOS device | **not possible** — Windows host |

See `docs/device-qa-checklist.md` for the manual plan.

---

## 2. Local database

```bash
npm run db:up      # postgres:16 on port 55432
npm run db:test    # applies 14 migrations to a clean schema, runs 8 suites
npm run db:down
```

`db:test` prints each suite's own numbers, e.g.:

```
parallel batch: 2 accepted, 13 rejected
after 15 parallel orders of 4 units: 2 order(s) accepted, 8 unit(s) sold, stock = 2
parallel cancel: 5 racers, stock moved by exactly 6 unit(s)
mixed race: 3 sales + 3 corrections settled at 13 units, ledger agrees
finance -- gross 9960.00 | product cost 7000.00 | net before expenses 2960.00 | net after 2460.00
rankings -- units: Cheap Clip | revenue: Premium Bag | profit: Premium Bag
inbox: 10 notification(s) produced by the journey, all readable and markable
```

---

## 3. A real Supabase project

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push                                  # applies supabase/migrations
npx supabase functions deploy pathao-shipment
npx supabase functions deploy pathao-webhook
```

Then set the courier secrets, **server side only**:

```bash
npx supabase secrets set \
  PATHAO_CLIENT_ID=<...> \
  PATHAO_CLIENT_SECRET=<...> \
  PATHAO_WEBHOOK_SECRET=<...>
```

These never enter the mobile bundle. `read_vault_secret()` is SECURITY DEFINER
and granted to `service_role` only, so the anon key in the app cannot obtain
them.

---

## 4. Local environment

```bash
cp .env.example .env
```

Fill in `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`. The anon
key is the **only** credential the app receives. No service-role key, ever.

### 4a. Connecting the EXISTING Supabase project (one-time)

The Android preview build ships with **no backend** unless the two public
Supabase variables are configured. Do this once:

```bash
npx supabase login     # YOU run this, in your own terminal. It uses your Google
                       # account for Supabase, which may be a DIFFERENT account
                       # from the one used for Expo/EAS. Chrome opens for the
                       # consent step.
npm run supabase:connect
```

`supabase:connect` then, without further input:

1. lists your Supabase projects and **stops** until you confirm which ref is
   SellFlow's — it will not guess, because linking the app to the wrong
   database is worse than not linking at all;
2. runs `supabase link` — **configuration only; no database changes**;
3. reads the project URL and its **public** client key, calling
   `projects api-keys` *without* `--reveal` so no secret key is ever readable;
4. sets both variables in the EAS `preview`, `development` and `production`
   environments via `eas env:set`;
5. verifies the `preview` environment contains no secret or service-role key;
6. rebuilds the preview APK.

It never runs `db push` or `db reset`, never creates a project, and never prints
a key value.

---

## 5. Build for a physical Android phone

```bash
npx eas login
npx eas build --profile preview --platform android
```

`preview` produces an **APK** that installs by enabling "install unknown apps"
on the handset. No store review, no production submission.

For a dev-client build that talks to a local Metro server:

```bash
npx eas build --profile development --platform android
npx expo start --dev-client
```

Locally, with the Android SDK installed:

```bash
npx expo run:android --device
```

`eas.json` also defines a `production` profile that produces an **AAB** for Play
submission. Do not use it for QA.

## 6. iOS

Building, signing and installing an iOS app requires macOS with Xcode plus an
Apple developer account. It cannot be done from Windows, and an iOS device test
must be performed by someone with an iPhone.

```bash
npx eas build --profile preview --platform ios
```

---

## 7. Full verification

```bash
npm run typecheck
npm run lint
npm run doctor
npm run test:outbox
npm run db:test
```

Bundles:

```bash
npx expo export --platform android --output-dir .verify-android
npx expo export --platform ios     --output-dir .verify-ios
```

---

## 8. Identifiers

| | |
|---|---|
| Android application ID | `com.sellflow.app` |
| iOS bundle identifier | `com.sellflow.app` |
| Deep link scheme | `sellflow://` |
| Supabase auth redirect | `sellflow://`, `sellflow://sign-in`, `sellflow://onboarding` |

Change the package/bundle identifier in `app.json` before shipping anything
under a real organisation name. A bundle identifier cannot be changed after a
store submission without a new app listing.

---

## 9. Release blockers that remain external

1. **Physical-device QA** — no Android SDK, emulator, or device on this host.
2. **Pathao authenticated E2E** — no credentials available. Endpoints were
   verified reachable (`/aladdin/api/v1` returns 400 unauthenticated, `/bogus`
   returns 404) but no authenticated shipment has been created.
3. **REDX** — no publicly reachable API specification. The manual fallback is
   the supported path.

None of these can be closed by writing more code in this environment.
