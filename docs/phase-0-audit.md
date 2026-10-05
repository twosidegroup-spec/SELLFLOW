# SellFlow — Phase 0: Freeze + Full Audit

**Status:** COMPLETE. No source file, config file, migration, or database was modified.
**Date:** 2026-10-05
**Repo:** `C:\Users\Sajidul Haque Sajid\Desktop\SELFLOW\sellflow`
**HEAD:** `068bd71` "Record that pushing to main does not deploy, and why dist must be the root"
**Branch:** `main`, up to date with `origin/main`, nothing unpushed.

---

## 0. Environment baseline

| Fact | Value |
| --- | --- |
| Expo SDK | `57.0.27` (`expo ~57.0.26`) |
| React Native | `0.86.3`, New Architecture ON, Hermes ON |
| React | `19.2.3` |
| Node | `v26.3.0` (EAS pins `22.13.0`) |
| TypeScript | `~6.0.3` |
| `npx tsc --noEmit` | **PASS, 0 errors** |
| `npx expo lint` | **0 errors, 1 warning** (`src/features/payments/queries.ts:452` — `Array<T>` style) |
| Node test suites sampled | **128 tests, 128 pass, 0 fail** |
| Docker | **NOT RUNNING.** `db:test` and any migration replay are unavailable locally. |
| Env files | `.env` (2 keys), `.env.local` (3 keys), `.env.example` (2 keys). All gitignored. |

**`.env.local` contains `VERCEL_OIDC_TOKEN`.** It is gitignored and never committed, but it lives in the repo working directory and is loaded by Expo into the build environment. It must be removed from `.env.local` — a build token has no business in an app env file. Flagged, not touched.

---

## 1. Architecture map

```
sellflow/
├─ app.json                 Expo config. Plugins, icons, splash, fonts, EAS projectId.
├─ app.config.js            ONLY injects EXPO_ROUTER_BASE_PATH for the web export.
├─ eas.json                 3 build profiles: development / preview / production.
├─ vercel.json              Static deploy of website/dist. buildCommand=null.
├─ .vercelignore            Load-bearing. Anchored patterns. See §5.
│
├─ src/app/                 Expo Router (root="src/app"). 30 screens.
│  ├─ _layout.tsx           Root: fonts, theme, query client, connectivity, outbox, auth listener.
│  ├─ index.tsx             Entry router. loading / error / signed-out / onboarding.
│  ├─ register.tsx          The single registration flow (29 KB).
│  ├─ passcode.tsx          Local screen lock gate.
│  ├─ set-passcode.tsx      Passcode setup WITH confirmation.
│  ├─ order-form/[token]    PUBLIC route. Customer order form, no session.
│  ├─ (auth)/               sign-in, forgot-password.
│  └─ (app)/                Auth guard + passcode gate + WebShell + 27 screens.
│
├─ src/components/
│  ├─ ui/                   16 primitives: Button, Card, Input, Screen, Badge, Dialog,
│  │                        Feedback (ErrorState/LoadingState/EmptyState), PasscodeKeypad, …
│  ├─ web/WebShell.tsx      Desktop sidebar + top bar + drawer. Web only.
│  ├─ courier/              DispatchSheet, TrackingCard.
│  ├─ FormScreen, ScreenHeader, ConnectionBanner.
│
├─ src/theme/               tokens.ts (12 KB: colors light+dark, spacing, radius, typography,
│                           iconSize, touchTarget, elevation, motion, layout) + ThemeProvider.
├─ src/features/            orders, products, customers, payments(+sms), dashboard, courier,
│                           expenses, orderForms, registration.
├─ src/lib/                 supabase, passcode, storage, outbox, connectivity, money, format,
│                           errors, navigation, queryClient, useViewport, database.types.
├─ src/store/               session.ts, lock.ts, appearance.ts.
│
├─ modules/sellflow-sms/    LOCAL EXPO MODULE. Android-only native SMS producer.
│                           13 Kotlin files + 35 KB JUnit parser suite + fixtures.
├─ plugins/                 withSellflowSms.js (committed)
│                           withAndroidDesugaring.js + verify-desugaring.mjs (STAGED, UNCOMMITTED)
│
├─ supabase/migrations/     24 files, 29 tables, 2 Edge Functions.
├─ supabase/test/           15 pgTAP suites (~600 assertions) + auth_shim.sql.
├─ supabase/functions/      pathao-shipment (verify_jwt=true), pathao-webhook (verify_jwt=false).
│
├─ website/                 Static marketing site + RN-web dashboard export.
│  ├─ build.mjs             → dist/            (marketing)
│  ├─ build-dashboard.mjs   → dist/app/        (RN-web export)
│  ├─ serve.mjs, review.mjs, verify-release.mjs, audit-dashboard.mjs, …
│  └─ public/downloads/     sellflow-1.1.1.apk (110 MB)
│
├─ scripts/                 30 files. Test suites, DB runner, build verifiers.
├─ docs/                    11 docs. No Vercel coverage at all.
├─ android/                 GENERATED, gitignored, STALE on this machine.
└─ images/  assets/         10 assets, all referenced paths present, none missing.
```

### Core business chain (verified in migrations)

```
auth.users
  └─ profiles (1:1, DB trigger only)
       └─ organizations ─┬─ organization_members (role: owner/manager/staff)
                         ├─ stores (timezone → business day)
                         │    ├─ products ── product_variants
                         │    ├─ inventory / inventory_movements (immutable ledger)
                         │    ├─ orders ─┬─ order_items (snapshotted price+cost)
                         │    │          ├─ order_status_history
                         │    │          ├─ shipments ── shipment_events
                         │    │          ├─ settlements (COD)
                         │    │          └─ payments
                         │    ├─ expenses
                         │    ├─ order_forms ── order_requests (PUBLIC, token-hashed)
                         │    └─ payment_accounts ─┬─ payment_intents
                         │                          ├─ payment_events (append-only ledger)
                         │                          ├─ payment_matches
                         │                          └─ payment_audit_logs
                         └─ courier_connections ── courier_locations
```

**Isolation model:** `SECURITY DEFINER` helper predicates (`is_org_member`, `can_write_org`, `is_org_owner`, `assert_store_access`) over `org_id`, which is denormalised on every tenant table. RLS enabled on all 29 tables. No policy targets `anon`. Money columns on `orders` have **no** INSERT/UPDATE policy at all — every mutation goes through a `SECURITY DEFINER` RPC.

This architecture is **sound and must be preserved.**

---

## 2. What currently WORKS

| Area | Evidence |
| --- | --- |
| TypeScript | 0 errors |
| Lint | 0 errors |
| Node unit tests | 128/128 pass (5 of ~15 suites sampled; remainder not run) |
| Design system | `scripts/design-audit.mjs` → 2 issues, both cosmetic (one literal colour in WebShell scrim, one 10px gap). Contrast AA or better on every token pair. Touch target floor 44px, comfortable 48px. No hardcoded hex outside `theme/` except 4 occurrences, 1 of them in `WebShell.tsx:334`. |
| Colour | Full light + dark token sets, resolved through `ThemeProvider`. No white flash on cold start (deliberate, `_layout.tsx:86-89`). |
| Passcode storage | Salted single-pass SHA-512 in `expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, per-user key, constant-time compare, `length` recorded. **No raw passcode is ever logged, sent over the network, or written off-keystore.** Verified by full read of `src/lib/passcode.ts` and `src/app/register.tsx`. |
| Registration | Collects full name, email, business name, 4-or-6-digit passcode, and **four separate payment method numbers** (bKash / Nagad / Rocket / Upay — `register.tsx:649-697`). Builds profile (trigger) → org → store → payment_accounts in a fixed, resumable order (`plan.ts:222-324`), all via `SECURITY DEFINER` RPCs with server-side `assert_org_write`. Fails loudly, never optimistically. |
| Login security | Real Supabase email/password. No demo accounts, no bypass (`sign-in.tsx:4`). |
| Payment grants | `0024_payment_grants.sql` is excellent. `anon` has **zero** privileges on all 5 payment tables and executes **zero** payment functions. Money functions revoked from `service_role` too. Asserted in-transaction by the migration itself and by `verify_payment_schema.sql`. |
| SMS privacy | APK carries exactly `RECEIVE_SMS`, exactly one receiver, **zero** forbidden permissions. Message body never stored — SHA-256 fingerprint only. |
| Offline outbox | 2 replayable kinds, both server-idempotent, oldest-first, serial, re-entrancy guarded. Server rejection keeps the item rather than dropping it. |
| No fake data | Grep for mock/fake/demo/sample/placeholder across all app and feature sources: **zero fabricated business numbers.** Empty states are real. |
| Order capture | Already partly built — `orderForm.ts` (18 KB) parses the Bangla/Banglish "Please Fill This Order Form" reply shape, is forgiving about shape and strict about what it claims, and returns `warnings` / `unmatched` for review. `PasteOrderSheet.tsx` is the review surface. **Never auto-creates an order.** |
| Assets | All 10 referenced asset paths exist. Adaptive icon, splash, and 4 Inter fonts generated at all 5 densities. |
| Marketing site | Hand-written static HTML, zero frameworks, one CSS file, one ES module. Build is fast and verifiable. |

---

## 3. What currently FAILS

Ordered by blast radius against the stated priority order.

### F1 — CRITICAL / RELIABILITY: Supabase session is MEMORY-ONLY on Android and iOS

`src/lib/supabase.ts:53-66` passes `persistSession: true` but **no `storage` adapter**.

Traced through `node_modules/@supabase/auth-js/dist/module/GoTrueClient.js:245-256`:

```js
if (settings.storage) { this.storage = settings.storage; }
else {
  if (supportsLocalStorage()) { this.storage = globalThis.localStorage; }
  else { this.memoryStorage = {}; this.storage = memoryLocalStorageAdapter(this.memoryStorage); }
}
```

`supportsLocalStorage()` → `isBrowser()` → `typeof window !== 'undefined' && typeof document !== 'undefined'` (`helpers.js:24,32-35`). React Native sets `global.window = global` but **never `document`**. Therefore on device the client silently falls back to **in-memory storage**.

Consequences, all of them contradicting comments written in this repo:
- `supabase.ts:55-57` — "makes the app survive a restart with the user still signed in" → **false on device.**
- `passcode.tsx:8-10` — "persisted on the device, restored at launch" → **false.**
- **Every cold start on a phone requires a fresh email + password.** The passcode-only unlock — the primary login UX in the product spec — **cannot survive an app restart.**
- Web is unaffected (react-native-web provides `document` and `localStorage`), so this will never reproduce in a browser test.

`@react-native-async-storage/async-storage` is already a dependency (`package.json:8`). One-line fix. **This is the single highest-value defect found.**

### F2 — CRITICAL / RELIABILITY: the blank-APK fix is staged but NOT COMMITTED

`git status`:
```
M  app.json                            ← adds "./plugins/withAndroidDesugaring" to plugins
A  plugins/withAndroidDesugaring.js
A  plugins/verify-desugaring.mjs
 M src/store/lock.ts
```

`app.json:69` references a plugin that **does not exist in any pushed commit**. EAS builds the pushed commit, so the two possible outcomes are both bad:
- `app.json` lands without the plugin files → prebuild fails, or
- nothing lands → **another non-desugared APK**, i.e. the identical blank-screen bug.

Verified against the shipped artefact: `website/public/downloads/sellflow-1.1.1.apk` contains **zero** desugar markers in any of its four dex files (`j$/time/Desugar*`, `com/android/tools/desugar`), and its embedded `app.config` plugin list ends at `./plugins/withSellflowSms`. The APK does contain `Ljava/time/Duration;`, `Ljava/time/LocalDate;`, `ZonedDateTime`, `kotlin/time/jdk8/*`, `kotlinx/serialization/internal/DurationSerializer` — classes that are API 26+ — while its binary manifest declares `minSdkVersion 24`.

**Best-supported hypothesis for the blank APK:** `minSdk 24` + no core library desugaring → `NoClassDefFoundError: Ljava/time/Duration;` on a native path on Android 7.x/8.0 → no red box, app launches, every data-backed screen renders empty. *Honest limit: this mechanism is corroborated by the dex contents and the minSdk/site mismatch; no logcat in the repo proves the specific throw.* A decisive test is an API-24 emulator plus logcat.

**Independently verifiable:** `website/site.config.mjs:84` and `website/src/index.html:648` advertise *"Android 8.0 (API 26) or newer"*, but the APK installs on API 24. The app and the site disagree about the floor.

**Rule 9 conflict — REPORTING, NOT RESOLVING:** these three staged entries are Agent 2's desugaring work. It is correct and its reasoning is documented. It is **not mine to commit or rewrite.** Phase 1 must proceed around it.

### F3 — HIGH / SECURITY: passcode "rate limiting" grants access on the 5th attempt

`src/lib/passcode.ts:277-289`. Five wrong entries call `clearPasscode(userId)` — which **deletes the passcode record** and unlocks the app for whoever holds the authenticated session. The counter also resets to `0` if the sidecar key is unreadable (`:214-216`), there is no backoff and no time-based lockout, and nothing is enforced server-side.

The passcode is a *local screen lock*, not the account credential — that architecture is defensible and documented. But the lockout mechanism is backwards: it is the one code path that turns an attack into a successful access.

### F4 — HIGH / CORRECTNESS: registration has NO passcode confirmation

`register.tsx:579-631` is single-stage. `set-passcode.tsx:37,74-89` **does** confirm. A mistyped passcode at registration is an immediate self-lockout: the seller lands on the keypad, every entry counts as an attempt, and 5 entries delete the record (F3), after which they must sign in with their password. This exact bug was already found and fixed in `set-passcode`; `register` was missed.

### F5 — HIGH / CORRECTNESS: password recovery cannot be completed

`forgot-password.tsx:43-46` sends a reset to `sellflow://sign-in`. Across all of `src` there is **no** `exchangeCodeForSession`, **no** `verifyOtp`, **no** `PASSWORD_RECOVERY` handler, and **no** `/reset-password` route. `app/_layout.tsx:75-77` receives the auth event and discards `_event`. The reset link opens the app with no way to set a new password. `config.toml:64-65` has `additional_redirect_urls = []` and `site_url = http://localhost:3000`.

### F6 — HIGH / CORRECTNESS: the Pathao webhook is functionally broken

`supabase/functions/pathao-webhook/index.ts` authenticates with the **service-role** key and calls `apply_shipment_update` / `set_order_status`. Both RPCs open with `assert_store_access()` → `is_org_member()` → `auth.uid()`. A service-role JWT carries no `sub`, so `auth.uid()` is NULL and `store_not_found` is raised on every call. The function returns HTTP 500, so Pathao retries forever and **no courier status ever lands**.

No test suite covers a NULL-`auth.uid()` service-role call — every suite does `set request.jwt.claim.sub = ...` — which is why all 15 suites stay green while this is broken.

### F7 — MEDIUM / SECURITY: function grants leaking to `PUBLIC`

Three functions are granted to `authenticated` with **no** `revoke ... from public, anon`. Postgres grants `EXECUTE` to `PUBLIC` on creation and **no `alter default privileges` exists in any of the 24 migrations**:
- `store_timezone(uuid)` — `0021:69-87`. Performs **no authorisation at all**. Any store UUID → its timezone, unauthenticated.
- `set_stock(...)` — `0018:97`. Blocked by `assert_store_access`, but the grant claim is false.
- the 6-arg `record_payment` / 5-arg `record_refund` — `0013:246`. **These are money functions.**

`0020:120-124` gets this right for its own functions. `0024` gets it right for the payment engine. The gap is in `0013`, `0018`, `0021`.

### F8 — MEDIUM / SECURITY: dead permissive RLS policy + blind registry guard

`payment_audit_logs_select_own` (`0022:597`) is **dead code** — `payment_audit_logs_select_member` (`0022:591`) already ORs in every row for any org member, so any seller can read another member's manual payment decisions.

The `0015` registry guard (`0015:89-117`, duplicated `0022:1215-1239`) tests `p.polqual is not null`. For a `FOR INSERT ... WITH CHECK` policy Postgres stores the expression in **`polwithcheck`**, where `polqual` is NULL. The guard is structurally blind to the exact policy shape it was written to detect.

### F9 — MEDIUM / DATA SAFETY: the offline outbox is not account-scoped

`connectivity.ts:156-160` writes one unkeyed queue to AsyncStorage containing `storeId`, `customerId`, full line items, `amountPaid`, and free-text `notes`. `session.ts:213-231` `signOut()` does **not** clear it. A queued order for org A is replayed under whatever account signs in next, and the previous owner's order payload sits on the device and in Settings → Data. Storage is unencrypted. There is no queue cap and no attempt ceiling.

### F10 — MEDIUM / SECURITY: `.vercel/.env.preview.local` holds `VERCEL_OIDC_TOKEN` in plaintext

Gitignored and not committed, but present on disk inside a persisted build directory, and `.vercelignore` has no `.vercel` rule of its own. Same token name also sits in `sellflow/.env.local`.

### F11 — MEDIUM / WEB: canonical domain is wrong in every shipped build

`build.mjs:48` defaults `SITE_URL` to `https://sellflow.app/` and `SELLFLOW_SITE_URL` has never been set. Every build declares that as canonical in `index.html`, `robots.txt`, `sitemap.xml`, and all OG/Twitter tags. The only Vercel URL in the tree is `https://sellflow-omega.vercel.app/` (`live-check.mjs:7`). `README.md:19,22` still points at the v1.0.0 APK while `site.config.mjs:80` serves v1.1.1.

### F12 — LOW-MED / WEB: dead and orphaned URLs and headers

- `src/features/orderForms/client.ts:284` falls back to `https://app.sellflow.app`, a domain that appears nowhere else. Native builds generate broken customer links. Its `EXPO_PUBLIC_WEB_ORIGIN` override is absent from `.env.example`, `eas.json`, and the export env.
- `app.config.js:6` names `sellflow-site.vercel.app` in a comment. **There is no separate marketing project.** The marketing site is `website/` inside this repo and shares `website/dist` with the dashboard. The comment is stale and could mislead someone into a destructive split.
- `vercel.json:29` rewrites `/app` → `/app/index.html` while the generated `dist/vercel.json:67` uses `/app`. With `cleanUrls: true` that is a redirect-loop risk; `build.mjs:444-446` says so about its own choice.
- Header order in `vercel.json` works by accident: `/app/:path*` (`must-revalidate`, line 57) is declared **before** the two `immutable` rules (65, 71). Vercel applies the last match, so correctness depends on ordering.
- No `Content-Security-Policy`, `Strict-Transport-Security`, or `Permissions-Policy`.
- `SYSTEM_ALERT_WINDOW` lands in the **release** manifest via `expo-dev-client`'s plugin. Not forbidden, but it is the one permission a store reviewer would question.

### F13 — LOW / BUILD: no CI, and one gate is wired to nothing

There is **no `.github/`, no CI of any kind.** `plugins/verify-desugaring.mjs` is referenced by **no** npm script and is not in `npm test`. It reports 13/13 PASS on the **stale** `android/` tree, and its `sourceCompatibility JavaVersion.VERSION_11` checks are textual — RN 0.86's `JdkConfiguratorUtils.kt:41-51` overwrites them to 17 in `finalizeDsl`, so it prints a green that does not reflect the built artefact. `db:up` is not part of `npm test`, so `db:test` fails on a clean machine with a docker error instead of a useful message.

`docs/native-sms-architecture.md:120-124` shows an `app.json` key (`autolinking.nativeModulesDir`) that does not exist; `docs/deployment.md:89-91` correctly explains why it must not.

---

## 4. What must be PRESERVED

**Database (do not touch semantics, do not delete migrations, do not reset Supabase):**
1. All 24 migrations. `0024_payment_grants.sql` above all — the `anon` zero-privilege grant model is the single best security artefact in the repo.
2. The RPC-owned money model. No INSERT/UPDATE policy on `orders`, `payments`, `order_items`, `shipments`, `settlements`, `inventory*`, or any `payment_*` table. Every write goes through a `SECURITY DEFINER` function that re-authorises.
3. `org_id` denormalisation on every tenant table — it is what makes RLS a single indexed equality.
4. Idempotency keys: `orders.client_ref`, `payments.client_ref`, `shipments.idempotency_key`, `payment_events` identity + `client_ref`, `payment_intents.client_ref`. `settle_event_to_intent` depends on `payments.client_ref`.
5. `order_items` price/cost snapshotting — a price edit must never rewrite history.
6. `inventory_movements` as an append-only ledger.
7. `stores.timezone` + `store_timezone()` store-local business day. `verify_day_boundary.sql` pins this and is the reason Dhaka days are not UTC days.
8. `order_forms.token_hash` (sha256), and the rule that a submission never becomes an order.

**Auth:**
9. Supabase Auth. Do not replace it.
10. Passcode in `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, hashed, per-user key. Never raw.
11. Registration's per-method payment number fields. One generic field is explicitly forbidden by spec.

**App:**
12. `android/`, `ios/` are generated. Never hand-edit. Configure via `app.json` + plugins.
13. `app.config.js` gates `EXPO_ROUTER_BASE_PATH` on being set. Never set it globally, or the APK gets `/app` deep links.
14. `app.json` `web.output: "single"` and the `/app/:path*` rewrite in both `vercel.json` files.
15. `.vercelignore` anchored `/` patterns (lines 36-44). Unanchored `assets` previously matched `dist/assets` **and** `dist/app/assets` and shipped a site whose HTML loaded with its entire asset tree missing. This is the documented cause of the raw/un-styled production page.
16. `build.mjs` before `build-dashboard.mjs` (enforced at `build-dashboard.mjs:59-63`).
17. `package.json` `overrides: react-dom 19.2.3`. Removing it breaks `eas build` in INSTALL_DEPENDENCIES.
18. `WebShell.tsx:79` — `if (Platform.OS !== 'web')` **after** every hook. Line 125 must stay a `View`, never a `ScrollView`.
19. `modules/sellflow-sms` autolinking via the default `./modules` convention. Do not add `expo.autolinking` — it is not in the SDK 57 schema and fails `expo-doctor`.
20. Deployment stays **manual**, Vercel not connected to the repo. `website/README.md:242-259` records that a git-clone build serves nothing at all, silently.

---

## 5. What should be REBUILT

Nothing in the database. Nothing in the design system. Nothing in the marketing site.

| Priority | Target | Action |
| --- | --- | --- |
| 1 | `src/lib/supabase.ts` storage adapter | **Fix.** AsyncStorage, or a SecureStore-backed adapter. Unblocks passcode login across restarts. |
| 2 | Startup failure surface | **Build.** A top-level error boundary does not exist anywhere in `src` (grep for `ErrorBoundary`/`componentDidCatch`/`getDerivedStateFromError`: **zero hits**). Add one above `ThemeProvider`. Add an initialization timeout — the only startup hang guard today is the Agent 2 `lock.ts` fix, which is uncommitted. |
| 3 | `register.tsx` passcode confirmation | **Fix.** Mirror `set-passcode.tsx:37,74-89`. |
| 4 | `passcode.ts` attempt policy | **Fix.** Delete the record on the 5th attempt → replace with a real time-based lockout that does not grant access. |
| 5 | Password recovery completion | **Build.** `/reset-password` route + `PASSWORD_RECOVERY` handling. Register real HTTPS redirect URLs in Supabase. |
| 6 | Grants audit for `PUBLIC` EXECUTE | **Add migration `0025`.** Revoke from `PUBLIC`/`anon` on `store_timezone`, `set_stock`, the `0013` `record_payment`/`record_refund` overloads. Add `alter default privileges`. Never edit `0024`. |
| 7 | `pathao-webhook` service-role auth | **Fix.** Needs a service-role-reachable path in the RPCs, or a separate definer function. Touches DB semantics → isolate, own commit, its own gate. |
| 8 | Outbox account scoping | **Fix.** Key the queue by org, clear on sign-out. |
| 9 | Biometric unlock | **Build.** `expo-local-authentication` is **not** a dependency. Spec requires it as optional. |
| 10 | Subscription + entitlement layer | **Build (Phase 10).** No `subscriptions` table, no entitlement code, no `plan_id` anywhere in `src`. Prices must live in one config surface, not in the bundle. |
| 11 | AI / Autopilot | **Build (Phase 9).** Nothing exists. `orderForm.ts` is the foundation to extend. |

## 6. What can be REMOVED later (Phase 15+)

- `android/` local stale tree — regenerated, never committed.
- `.vercel/output/` — stale build artifact, `index.html` 20 KB vs `dist/` 25 KB, and it predates the current `vercel.json`.
- `scripts/db-verify.ps1`, `sms-audit.mjs`, `splash-audit.mjs` — confirm with their callers first.
- Hardcoded absolute paths at `website/review.mjs:13`, `og-render.mjs:13`, `fetch-fonts.mjs:11` (`C:/Users/Sajidul Haque Sajid/Desktop/SELFLOW/...`) — replace with `import.meta.url` resolution.

## 7. Agent 2 uncommitted files — OWNERSHIP

| File | State | Owner | Conflict risk |
| --- | --- | --- | --- |
| `plugins/withAndroidDesugaring.js` | staged, new | **Agent 2** | **HIGH.** `app.json:69` depends on it. Any commit touching `app.json` without these files breaks EAS prebuild. |
| `plugins/verify-desugaring.mjs` | staged, new | **Agent 2** | LOW — unreferenced by any script. |
| `app.json` | staged, +1 line (plugin entry) | **Agent 2** | **HIGH.** Same file holds `web`, `version`, `versionCode`, icons, splash. Must not be clobbered. |
| `src/store/lock.ts` | unstaged, +45/-3 | **Agent 2** | **MEDIUM.** The change is a Keystore fail-open guard. It is correct and directly serves Phase 2. `git add` on this file would take ownership of Agent 2's work. |

**Constraint for all later phases:** do not `git add` any of these four paths. If a phase needs `app.json` changed, stage the file's specific hunk via an explicit path only after confirming the staged desugaring entries are committed as one atomic unit — and **STOP and report** if that is not possible.

---

## 8. Component reuse vs replace

**Reuse as-is (Phase 1 target surface):** `src/theme/*`, all 16 `src/components/ui/*`, `WebShell.tsx`, `Screen.tsx`, `useViewport.ts`, `navigation.ts`, `src/lib/errors.ts`, `money.ts`, `format.ts`, `queryClient.ts`, `app.config.js`, `website/build*.mjs`, `plugins/withSellflowSms.js`, `modules/sellflow-sms/**`.

**Replace or extend:** `src/lib/supabase.ts` (storage), add a root error boundary, `src/app/register.tsx` (confirmation step), `src/lib/passcode.ts` (attempt policy), `src/lib/connectivity.ts` (outbox scoping).

**Do not touch:** `supabase/migrations/*` except new append-only `00NN_*.sql`; `supabase/test/*`; `modules/**`; `.vercelignore`; `package.json` `overrides`.

---

## 9. Gate assessment

| Gate | Status |
| --- | --- |
| TypeScript | **PASS** |
| Lint | **PASS** (1 warning, cosmetic) |
| Unit tests (sampled) | **PASS** 128/128 |
| DB tests | **CANNOT RUN** — Docker not running |
| Android dev build launches | **NOT VERIFIED.** Cannot: `ld.lld: undefined symbol: __cxa_allocate_exception` (NDK 27 on Windows host, `docs/deployment.md:62-77`). EAS/Linux only. |
| iOS dev build launches | **NOT VERIFIED.** No macOS host. |
| Web dev build launches | **NOT VERIFIED.** Not started. |
| No blank screen | **FAILS BY INFERENCE.** F2 — the shipped 1.1.1 APK has no desugaring and installs on API 24 while carrying API-26 classes. |

## 10. Phase 1 plan (proposed, for approval)

Small isolated commits, each verified:

1. **`supabase.ts` storage adapter.** Wire AsyncStorage (or SecureStore). Add `scripts/supabase-storage.test.mjs` asserting the adapter is passed and is durable. **This alone fixes the passcode-login-after-restart defect.**
2. **Root error boundary + initialization timeout.** New `src/components/BootError.tsx` + `BootGuard`. New test. No behaviour change on the happy path.
3. **`app.json` conflict check.** Report before touching anything staged by Agent 2.
4. **Startup hardening** — timeout, retry, config-missing screen, on the now-verified foundation.
5. Re-run `tsc` + `lint` + all Node suites after every commit.

Light/dark, typography, spacing, icons, and safe-area handling **already exist** in `src/theme/`. Phase 1 is mostly verification plus the two gaps above, not a rebuild. The design audit reports 2 cosmetic issues.

## 11. Open questions for the owner

1. **Agent 2's desugaring commit** — may I include the already-staged `app.json` + two plugin files as one atomic commit, or is that yours to make? This is the blocker for F2 and therefore for every Android gate.
2. **Canonical domain** — is production `sellflow.app` or `sellflow-omega.vercel.app`? F11 cannot be fixed without the answer.
3. **is `sellflow-site` a separate Vercel project** that should hold the dashboard at `/app`? `app.config.js:6` implies it exists; nothing in the repo references it and the linked project is `sellflow`.
4. **Docker** — should it be started so `db:test` can run? It is currently the only gate I cannot execute.
5. **Min SDK** — desugar to keep `minSdk 24`, or raise to 26 and drop the plugin? The site currently claims 8.0+ while the APK installs on 7.0. These cannot both be right.