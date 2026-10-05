# SellFlow V2 — Phase 0: Inventory, Checkpoint, Deletion Plan

**Status:** COMPLETE. **Nothing deleted. Nothing coded. Awaiting checkpoint approval.**
**Branch:** `rebuild/v2-zero-based` (created from `fda08a1`)
**Safety tag:** `pre-rebuild-2026-10-05` → `fda08a1`
**Agent 2 work:** uncommitted in `src/store/lock.ts`, preserved in the working tree AND backed up to `%TEMP%\opencode\agent2-lock-work.patch` (2995 bytes)

---

## 0. Two of the four referenced technologies do not exist

Recorded here because the brief depends on them, and I will not install or call something that is not there.

| Reference | DNS | npm | Verdict |
| --- | --- | --- | --- |
| `https://threejs.org/` | resolves | `three@0.186.1`, `@react-three/fiber@9.8.1`, `expo-three@8.0.0` | **Real. Usable.** |
| `https://gsap.com/` | resolves | `gsap@3.15.0` | **Real. Web-only.** See §6. |
| `https://testskill.dev/` | **NO DNS RECORD** | — | **Does not exist.** Cannot be installed or fetched. |
| `https://twentyones.com/` | resolves to AWS parking IPs | — | **Parked domain.** No product. Search returns "Twenty One Ton", a defunct Toronto agency. |

`testskill.dev` has no DNS record whatsoever. `twentyones.com` resolves but serves nothing.

**Consequence:** §16 (TestSkill.dev in the testing workflow) and §17 (Twentyones as a design reference) have no implementable target. I will deliver the *intent* of both using what exists — the repo's own test harness (`scripts/`, `node:test`, pgTAP) and the design-direction prose in the brief — and I will label it as such rather than pretend the sites exist. If these were typos, tell me the correct names.

---

## 1. Inventory: what is the old application implementation

The repo splits cleanly into an **application layer** (the UI to be replaced) and a **platform layer** (must survive).

### DELETE — old application implementation

| Path | Files | Bytes | Note |
| --- | --- | --- | --- |
| `src/app/**` | 39 | 482,400 | All screens + layouts. Routes, nav UI, every screen. |
| `src/components/ui/**` | 17 | 115,564 | Old design system: Button, Card, Input, Screen, Badge, Dialog, BottomSheet, Feedback, PasscodeKeypad, Amount, Controls, ListRow, Refresh, Text, BrandMark, SetupCompleteView, index |
| `src/components/*.tsx` | 3 | 12,838 | FormScreen, ScreenHeader, ConnectionBanner |
| `src/components/courier/**` | 2 | 31,166 | DispatchSheet, TrackingCard |
| `src/components/web/**` | 1 | 14,578 | WebShell (sidebar/drawer/topbar) |
| `src/components/BootError.tsx` | 1 | 8,339 | **KEEP** — see §3 |
| `src/theme/**` | 2 | 14,964 | Old tokens + ThemeProvider. Replaced by V2 tokens. |
| `src/store/appearance.ts` | 1 | 1,194 | Theme preference store — **KEEP**, small and useful |
| **Total** | **65** | **~690,000** | |

### SPLIT — `src/features/` is mostly data logic, not UI

This is the critical judgement in the plan. `src/features` is 26 files / 248,219 bytes, but only **one** is a component:

| File | Bytes | Verdict |
| --- | --- | --- |
| `orders/PasteOrderSheet.tsx` | 9,102 | **DELETE** — old UI |
| `orders/orderForm.ts` | 18,059 | **KEEP** — order extraction parser. Bangla/Banglish, tested, 15k assertions. |
| `orders/queries.ts`, `mutations.ts`, `calculations.ts` | 28,826 | **KEEP** — data layer over existing RPCs |
| `customers/`, `products/`, `dashboard/`, `expenses/` queries+mutations | 48,989 | **KEEP** |
| `payments/*` (13 files, non-tsx) | 103,646 | **KEEP** — SMS listener, ingest, queue, matching, normalize |
| `courier/queries.ts` | 17,478 | **KEEP** |
| `orderForms/client.ts` | 9,097 | **KEEP** — public order-form client |
| `registration/plan.ts` | 13,376 | **KEEP** — registration orchestration, resumable |

Deleting `src/features` wholesale would destroy the working SMS payment pipeline and the order parser — the two most differentiated parts of the product — and force a rewrite against a database I am forbidden to change. **That would be the "patch symptoms when the architecture is wrong" trap, in reverse.**

### PRESERVE — platform layer

| Path | Why |
| --- | --- |
| `src/lib/**` (14 files, 126,754) | `database.types.ts` (35KB, mirrors 24 migrations), `supabase.ts`, `sessionStorage.ts`, `passcode.ts`, `money.ts`, `errors.ts`, `outbox.ts`, `connectivity.ts`, `queryClient.ts`, `storage.ts`, `navigation.ts`, `useViewport.ts`, `bootWatchdog.ts`, `format.ts` — all non-visual, all tested |
| `src/store/session.ts` | Workspace/org/store resolution, RLS-shaped reads |
| `src/store/lock.ts` | **Agent 2's uncommitted work.** Do not touch. |
| `src/store/appearance.ts` | Theme preference |
| `supabase/migrations/**` (24 files) | **The live schema.** Live orders/payments. Never delete. |
| `supabase/functions/**` (2) | pathao-shipment, pathao-webhook — valid integrations |
| `supabase/test/**` (15 suites) | ~600 pgTAP assertions proving RLS and money correctness |
| `modules/sellflow-sms/**` | 13 Kotlin files + JUnit parser suite. Android SMS producer. |
| `plugins/withSellflowSms.js` | Manifest permission/receiver control |
| `plugins/withAndroidDesugaring.js`, `verify-desugaring.mjs` | **Agent 2's staged blank-APK fix.** F2. Not mine. |
| `app.json`, `app.config.js`, `eas.json` | Android package `com.sellflow.app`, versionCode, iOS bundle id, projectId |
| `vercel.json`, `.vercelignore` | Deploy routing. `.vercelignore` anchored patterns are load-bearing. |
| `package.json` | **The `overrides: react-dom 19.2.3` entry is build-critical.** Removing it breaks `eas build`. |
| `website/**` | Marketing site + RN-web dashboard export |
| `scripts/**` (30 files) | Test harness. Reused by V2. |
| `docs/**` | Audit, payment engine, SMS contracts |

### Explicitly NOT touched
Git repo · Git history · Supabase project · Supabase database · production data · migrations · RLS · Edge Functions · Android package identity · iOS bundle identity · EAS config · deployment infrastructure · credentials.

---

## 2. Checkpoints created

| Artifact | Value |
| --- | --- |
| Annotated tag | `pre-rebuild-2026-10-05` → commit `fda08a1` |
| Branch | `rebuild/v2-zero-based` (all V2 work lands here, never on `main`) |
| Agent 2 patch backup | `%TEMP%\opencode\opencode\agent2-lock-work.patch` → `%TEMP%\opencode\agent2-lock-work.patch` (2995 B) |
| Prior release tags | `v1.0.0`, `v1.1.0`, `v1.1.1` untouched |

Recovery from any point: `git checkout pre-rebuild-2026-10-05` restores the entire old implementation byte-for-byte. No commit on `main` can be lost, because the tag precedes every deletion.

---

## 3. What I am keeping from the old app, and why

You said do not use the old UI as the visual foundation. Agreed — all 39 screens and the 17-component design system are deleted. But four things are **not** UI, and deleting them would be actively harmful:

1. **`src/components/BootError.tsx`** — the Phase 2 boundary + `src/lib/bootWatchdog.ts`. §20 "ZERO BLANK SCREEN RULE" requires it. It is not a screen; it is the thing that makes every other screen safe. It reads raw tokens, has no dependency on the old theme, and will be restyled to V2 tokens.
2. **`src/lib/sessionStorage.ts`** — F1. Without it the passcode-only login in §7 cannot work across a restart. One-line defect, already fixed and tested.
3. **`src/features/orders/orderForm.ts`** — §10 order capture. Already parses the exact "Bhai 2 ta black cargo pant lagbe" shape. Rebuilding it would be the giant rewrite you told me to avoid.
4. **`src/lib/passcode.ts`** — §7. Salted SHA-512, keystore, never raw. §7 requires "never store raw passcodes" and it already complies. It does have the F3 lockout defect (deletes the record on the 5th wrong try), which Phase 4 fixes.

Everything else visual goes.

---

## 4. Deletion plan, phase by phase

Each phase is a separate commit. `main` is never touched. `git add .` is never used.

### PHASE 1 — remove the old application implementation

```
DELETE  src/app/                          39 files   482,400 B
DELETE  src/components/ui/                17 files   115,564 B
DELETE  src/components/FormScreen.tsx
DELETE  src/components/ScreenHeader.tsx
DELETE  src/components/ConnectionBanner.tsx
DELETE  src/components/courier/            2 files    31,166 B
DELETE  src/components/web/                1 file     14,578 B
DELETE  src/features/orders/PasteOrderSheet.tsx       9,102 B
DELETE  src/theme/tokens.ts               (replaced in Phase 2)
DELETE  src/theme/ThemeProvider.tsx       (replaced in Phase 2)
DELETE  src/lib/navigation.ts             (nav registry for the old routes)

KEEP    src/app/_layout.tsx temporarily -> rewritten in Phase 3, not now
```

Deleting `src/theme` and `src/app` in the same commit leaves nothing that compiles. So Phase 1 must land together with **a minimal bootable shell**: one `src/app/_layout.tsx` + one `src/app/index.tsx` + a new `src/theme/tokens.ts`. Otherwise the app cannot launch and §20 is violated by the deletion itself.

Revised: **Phase 1 = delete + minimal bootable shell**, verified by launching. Not "delete then break."

### PHASE 2 — new design system
New `src/theme/` tokens (colour, type, spacing, radius, elevation, border, motion), light + dark. New primitive components replacing all 17 old ones. Verified: the repo's own `scripts/design-audit.mjs` passes at 0 issues.

### PHASE 3 — startup + navigation
Boot sequence, error boundary restyled to V2 tokens, startup watchdog, route group structure, tabs, headers.

### PHASE 4 — registration + authentication
Registration per §6 (per-provider payment numbers, one mandatory). Passcode 4/6 with confirmation (fixes F4). Rate limiting + lockout that no longer grants access (fixes F3). Biometric via `expo-local-authentication` (absent today). Device association.

### PHASE 5 — business + dashboard
### PHASE 6 — orders / products / customers
### PHASE 7 — payments + automation
### PHASE 8 — profit intelligence
### PHASE 9 — subscriptions
### PHASE 10 — AI / order capture polish
### PHASE 11 — Three.js + GSAP polish
### PHASE 12 — web
### PHASE 13 — full test matrix
### PHASE 14 — release candidates
### PHASE 15 — production

---

## 5. Risks I will not hide

| # | Risk | Status |
| --- | --- | --- |
| R1 | **No emulator on this machine.** No `emulator.exe`, no system images, no AVDs, no Android Studio. `adb` exists at `AppData\Local\Temp\opencode\toolchain\android-sdk`. | **§26 requires real-device testing. Blocked.** Installable (~1.5 GB) with your permission. |
| R2 | **Local APK builds fail on this Windows host**: `ld.lld: undefined symbol: __cxa_allocate_exception` (NDK 27 + `libc++_shared`, `docs/deployment.md:62-77`). | Even with an emulator there is no APK. Needs fixing or EAS. |
| R3 | **`sellflow-v1.vercel.app` returns 404 on every path.** Nothing deployed. `sellflow.app` (the canonical URL in every shipped build) does not resolve. | §12/§15 web gate cannot pass until deployed. |
| R4 | **Docker not running** → `db:test` (~600 pgTAP assertions, the RLS/money safety net) cannot execute. | Needs Docker started. |
| R5 | **F2 blank-APK fix is uncommitted.** `app.json:69` references `./plugins/withAndroidDesugaring`, which exists in no pushed commit. | Agent 2's. **Yours to land**, or say the word and I will commit those three files as one atomic unit. |
| R6 | **Agent 2's `src/store/lock.ts` is uncommitted** and now sits on the rebuild branch. | Preserved + patched. Will not be staged by me. |
| R7 | **`VERCEL_OIDC_TOKEN` in `.env.local`** and in `.vercel/.env.preview.local`. | Flagged, not touched. Should be removed. |

---

## 6. Three.js and GSAP: where they can and cannot go

Both are real. Neither can be used the way the brief's §14/§15 implies for the *app*, and I will not force them.

**GSAP is DOM-only.** React Native has no DOM. There is no `react-native-gsap` on npm. In the app, motion must be `react-native-reanimated` (already a dependency, v4.5.1) — which supports `withTiming`, spring physics, and `reducedMotion`. The repo already has `motion` tokens in `src/theme/tokens.ts:396`.

**Three.js is WebGL.** It cannot render a list row, read an SMS, or run on the low-end Android hardware this audience uses. It also costs ~600 KB and a WebGL context.

Where they genuinely fit, and where I will use them in Phase 11 / Phase 12:

| Surface | Library | Guardrail |
| --- | --- | --- |
| Marketing hero (`website/src/index.html:88`) | **Three.js + GSAP** | The real answer. Static site, real Chrome, real GPU. |
| Premium onboarding scene | **Three.js via `expo-three`** | Lazy `import()`, behind a capability check, static poster fallback. |
| Business/flow visualisation | **Three.js** | Explicit opt-in. Never on a CRUD screen. |
| Web dashboard motion | **GSAP** | Gated on `prefers-reduced-motion`. |
| All in-app motion | **Reanimated** | Native-safe, interruptible, already installed. |

Every WebGL surface must degrade: `WebGL.isWebGLAvailable`, a static fallback, `AccessibilityInfo.isReduceMotionEnabled`, and no blocking of startup.

---

## 7. Phase 0 gate

- [x] Repository inventoried — 65 files to delete, ~690 KB; platform layer identified
- [x] Old application implementation identified precisely
- [x] `src/features` split into data logic (keep) vs UI (delete)
- [x] Agent 2's uncommitted work identified, preserved in-tree, and backed up to a patch file
- [x] Supabase backend identified as preserved — 24 migrations, 29 tables, 15 pgTAP suites, 2 Edge Functions
- [x] Safety checkpoint created — annotated tag `pre-rebuild-2026-10-05`
- [x] Isolated rebuild branch created — `rebuild/v2-zero-based`
- [x] Deletion/replacement plan produced
- [x] **Zero files deleted**
- [x] **Zero files created in `src/`**

**Awaiting approval to begin Phase 1.**

### Decisions needed before Phase 1

1. **May I delete `src/app`, `src/components/ui`, `src/components/{courier,web}`, `src/theme`, and `src/features/orders/PasteOrderSheet.tsx` on this branch?** Everything stays recoverable via the tag.
2. **R5 — commit Agent 2's desugaring files?** `app.json` + `plugins/withAndroidDesugaring.js` + `plugins/verify-desugaring.mjs`, as one atomic commit. It is the blank-APK fix and blocks every Android gate.
3. **R1 — install the Android emulator (~1.5 GB)?** §26 cannot be satisfied without it.
4. **R4 — start Docker** so `db:test` can run?
5. **TestSkill.dev / Twentyones** — correct names, or proceed with the substitutes in §0?