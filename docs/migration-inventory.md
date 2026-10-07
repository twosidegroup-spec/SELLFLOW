# Migration Inventory — React Native → Flutter

**Reference:** `rebuild/v2-zero-based` @ `aef35af` (frozen, unmodified)
**Target:** Flutter / Dart, Android-first, same Supabase backend.

This is the behavioural specification the Flutter client must satisfy. It records what
the product *does*, not how React Native did it. Where the reference has a wart worth
fixing, that is noted explicitly rather than silently carried over.

---

## 1. Screens and routes (30 route files)

### 1.1 Unauthenticated
| Route | Purpose |
|---|---|
| `/welcome` | First-run entry, brand, CTA |
| `/sign-in` | Email + password sign-in |
| `/register` | Account creation (see §3) |
| `/set-passcode` | Choose 4- or 6-digit passcode |
| `/passcode` | Unlock keypad (post sign-in) |
| `/forgot-password` | Recovery request |
| `/setup-complete` | Post-registration confirmation |

### 1.2 Authenticated shell — `(app)/`
| Route | Purpose |
|---|---|
| `(tabs)/index` | Dashboard |
| `(tabs)/orders` | Order list |
| `(tabs)/customers` | Customer list |
| `(tabs)/products` | Product/inventory list |
| `finance` | Finance summary |
| `payments` | Payment activity list |
| `payment-review` | Match review queue |
| `payment-account/new` | Connect a receiving account |
| `payment-intent/new` | Expect a payment for an order |
| `order/new` | Create order |
| `order/[id]` | Order detail |
| `customer/new` | Create customer |
| `customer/[id]` | Customer detail |
| `customer/[id]/edit` | Edit customer |
| `product/new` | Create product |
| `product/[id]` | Product detail |
| `product/[id]/edit` | Edit product |
| `settings/account` | Account settings |

### 1.3 Not-yet-routed capabilities present in code
These exist as feature modules with RPC coverage but have **no screen** in the
reference. Flagged because a Flutter port could silently lose them:

- `features/courier/` — shipments, shipment events, settlements (`register_shipment`,
  `apply_shipment_update`, `record_settlement`, `get_couriers`)
- `features/expenses/` — expense CRUD
- `features/orderForms/` — public shareable order forms + inbound requests
  (`create_order_form`, `revoke_order_form`, `public_order_form`,
  `submit_order_request`, `decide_order_request`)

**Decision required** before port: surface these, or explicitly drop them. Dropping is
a product change and needs sign-off.

---

## 2. Backend contract (must not change)

26 migrations applied. **No backend changes are part of this migration.** The Flutter
client is a new consumer of the existing contract.

### 2.1 RPCs (35 distinct)

| Domain | RPCs |
|---|---|
| Bootstrap | `bootstrap_business` |
| Orders | `create_order`, `set_order_status`, `allowed_order_statuses` |
| Payments | `create_payment_account`, `set_payment_account_status`, `create_payment_intent`, `cancel_payment_intent`, `expire_stale_payment_intents`, `record_payment`, `record_refund`, `ingest_payment_event`, `match_payment_event`, `assign_payment_match`, `reject_payment_match` |
| Reporting | `get_dashboard`, `get_analytics`, `get_finance`, `get_sales_report`, `get_product_performance`, `get_product_stats`, `get_profit_completeness` |
| Customers | `get_customer_stats`, `find_duplicate_customers`, `delete_customer` |
| Products | `delete_product`, `adjust_stock`, `set_stock` |
| Courier | `register_shipment`, `apply_shipment_update`, `record_settlement`, `get_couriers` |
| Order forms | `create_order_form`, `revoke_order_form`, `public_order_form`, `submit_order_request`, `decide_order_request` |

### 2.2 Tables read directly (RLS-governed)
`organizations`, `organization_members`, `stores`, `customers`, `products`,
`inventory`, `inventory_movements`, `orders`, `order_items`, `order_status_history`,
`payments`, `payment_accounts`, `payment_intents`, `payment_events`,
`payment_audit_logs`, `expenses`, `shipments`, `shipment_events`, `settlements`,
`order_requests`.

### 2.3 Payment write boundary — hard rule
The RN client **never writes a payment table directly.** All payment movement goes
through RPC. `payment-boundary.test.mjs` (25 assertions) enforces:
- payment tables are `Insert: never` / `Update: never` in generated types
- no source file writes a payment table
- the payment feature contains **no table writes at all**
- the feature never calls `record_payment` directly
- every payment RPC the app calls is a known engine function

**Flutter must reproduce this boundary and its equivalent test.** Direct `.insert()` /
`.update()` on any payment table is a defect, not an optimisation.

---

## 3. Authentication

### 3.1 Registration inputs (all required)
1. Full name
2. Email
3. Business / page name
4. ≥1 payment receiving method
5. Provider-associated payment number
6. Passcode — 4 **or** 6 digits
7. Passcode confirmation

Providers: **bKash, Nagad, Rocket, Upay**.

Sequence: `bootstrap_business` → `create_payment_account` → set passcode.

### 3.2 Passcode model (port verbatim — this has bitten before)
- Stored **only** in SecureStore (Android hardware keystore), keyed `sellflow.passcode.<userId>`
  so two accounts on one device cannot collide
- Salted **SHA-512**, separator `:` so the passcode can't be read off the salt
- **Single** hash round by design — a 4–6 digit space is small regardless; extra rounds
  buy a lockout delay, not security. Do not "improve" this.
- Length persisted in the record (`version: 2`). Legacy records without `length` must
  report `null` and fall back to an explicit **Continue** key, **never** assume 4 —
  auto-submitting at 4 digits once made 6/7/8-digit codes impossible to enter and
  burned the attempt budget.
- `timingSafeEqual` for comparison
- `WHEN_UNLOCKED_THIS_DEVICE_ONLY` accessibility
- Record keyed by user id → logout/account switch must not leak the other account's state

### 3.3 Validation rules
- digits only
- length ∈ {4, 6} (registration); legacy reads accept 4–8
- **no single repeated digit** (`1111` rejected)
- **no simple sequence** ascending or descending, length ≥ 3 (`1234`, `4321` rejected)

### 3.4 Lockout (behaviour that must be preserved exactly)
| Rule | Value |
|---|---|
| Max attempts | 5 |
| On 5th failure | **cooldown**, NOT wipe |
| Cooldown | 30 s |
| On cooldown expiry | counter resets, entry reopens |
| Reset on success | yes (counter + marker cleared) |
| Corrupt record | treated as absent, not as a permanent lock |

The old behaviour deleted the record on the 5th guess — a lockout that *grants* access.
The cooldown exists because a seller who forgets their code must not be locked out of
live orders. Both facts are deliberate; preserve them.

---

## 4. Money

**Money is integer minor units.** `type Money = number`. Default currency **BDT**.

Full surface to port: `toMinor`, `normaliseDigits`, `parseWholeNumber`, `money`,
`formatMajorUnits`, `toMajor`, `formatMoney`, `formatCompactMoney`, `formatForInput`,
`add`, `subtract`, `negate`, `multiply`, `percentage`, `isNegative`, `isPositive`,
`equals`, `max`, `min`, `clampToZero`, `distribute`, `sum`.

`formatMajorUnits` exists because a 100× undercount bug shipped once when minor/major
units were confused. `distribute` exists so a split leaves no lost remainder.

**Flutter: use `int` for `Money`, never `double`.** No `double` may touch a monetary
value anywhere in the client.

---

## 5. Orders

`calculateTotals`, `lineTotal`, `allocateDiscount`, `discountByLine`, `outstanding`,
`validateDraft`, `stockWarnings`, `addLineToDraft`.

Discount allocation across lines is proportional with remainder distribution — port
`allocateDiscount` exactly, including its rounding, and port its tests.

Status changes go through `set_order_status`; permitted transitions are read from
`allowed_order_statuses` (server-owned, never hardcoded in the client).

---

## 6. Payments

### 6.1 Financial authority
The **backend owns** every financial truth: received, outstanding, COD receivable,
settled state. The UI may *display* these; it must not recompute them.

Post-`0026`, `record_payment`/`record_refund` adjust `cod_amount`/`cod_settled`
alongside `amount_paid`. Invariant: **received + courier receivable ≤ order total.**
The Flutter client must not reintroduce the pre-0026 double-count in any display path
(e.g. by summing received + owed itself).

### 6.2 Provider + phone normalisation
`normalizeBdNumber` handles `+880…`, `0…`, local forms → canonical `01…`.
`isBdMobileNumber`, `isCanonical` validate. Account matching **must** go through this
normalisation or genuine payments silently fail to match.

### 6.3 Payment statuses
`confirmed`, `detected`, `matched`, `review_required`, `duplicate`. Only the engine
writes these. `confirmed` in the UI is derived from `payment_events.status` — the client
cannot produce it.

---

## 7. SMS automation

### 7.1 Architecture (Kotlin is already correct — port, don't redesign)
```
BroadcastReceiver  →  ProviderRegistry.detect/parse
                   →  CandidateQueue (durable, native)
                   →  [MethodChannel/EventChannel]  →  Dart
                   →  durable JS/Dart queue (AsyncStorage-equivalent)
                   →  ingest_payment_event  →  match_payment_event
```
Files to port: `SellflowSmsReceiver`, `SellflowSmsModule`, `CandidateQueue`,
`Fingerprint`, `ProviderRegistry`, `ProviderAdapter`, `SenderIdentity`, `MessageText`,
`BkashAdapter`, `NagadAdapter`, `RocketAdapter`, `UpayAdapter`,
`ProviderParserTest.kt`.

In Flutter this becomes `MethodChannel` (status/peek/ack/discard/parse) +
`EventChannel` (`onPaymentCandidateDetected`).

### 7.2 Gates, in order — must not be reordered
1. `MessageText.looksSuspicious` → reject as `NOT_A_PAYMENT_MESSAGE`
2. `MessageText.looksLikeOtpOrSecurity` → reject as `OTP_OR_SECURITY_MESSAGE`
3. `ProviderRegistry.detect` → null ⇒ reject (`UNSUPPORTED_PROVIDER` if it mentions a
   currency + receive verb, else `NOT_A_PAYMENT_MESSAGE`)
4. `adapter.parse` — never throws; a `RuntimeException` counts as `AMBIGUOUS_FIELDS`

OTP is refused **before** provider detection so the diagnostic is actionable.

### 7.3 Registration order is deliberate
Fixed order `[Bkash, Nagad, Rocket, Upay]`; **first match wins**, not best score. No
scoring exists on purpose — silently changing which provider is attributed to a
customer's money is not a decision to automate. Server re-checks provider anyway.

### 7.4 Privacy invariants (non-negotiable, must be asserted in tests)
- Raw message body **never** persisted, logged, uploaded, or placed in analytics
- `PaymentCandidate` carries no `messageBody` field — the type has no such member
- A parse failure logs a **count**, never the text
- Only `parseMessageForDiagnostics` ever takes a raw String, and only in the dev
  diagnostics panel, with no path from it into the queue
- Permission surface: **RECEIVE_SMS only.** Forbidden: `READ_SMS`, `SEND_SMS`,
  `WRITE_SMS`, `RECEIVE_MMS`, `RECEIVE_WAP_PUSH`, `BROADCAST_SMS`,
  `BROADCAST_WAP_PUSH`, contacts, call log.

### 7.5 Queue semantics
- Native queue is **peeked**, not drained; acknowledged only after the candidate is
  durably in the Dart queue. Process death in between ⇒ redelivery, never loss.
- Duplicate suppression is by `candidateIdentity`; the **first** `clientRef` wins so a
  replay cannot become a second payment.
- Offline device attempts **nothing** and spends no attempt.
- Backoff is capped; `MAX_ATTEMPTS` → `failed` (stays visible, needs a human).
- An `invalid_authorization` failure **stops the whole queue** and reports
  `blocked: true` — one 401 means the rest fail identically.
- Order is **money-arrival order** (oldest first), not insertion order.
- `retry()` reuses the same `clientRef`; `dismiss()` drops.

### 7.6 Detection status precedence
`needs_attention` > `needs_review` > `confirmed` > `offline_queued` >
`receiver_unavailable` > `permission_denied` > `no_accounts` > `sign_in_required` >
`unsupported_platform`.
A denied permission or missing receiver must **never** read as connected/healthy.

---

## 8. Tenant isolation (security requirement)

- Never trust a client-supplied `org_id`; org comes from session + membership
- Never cache cross-tenant data, never retain another user's state across sign-in
- No service-role key in the client, ever
- Every table read is RLS-governed; cross-tenant attempts must be tested explicitly
  for **both** `record_payment` and `record_refund`

---

## 9. Reference test suite (21 suites) → must become Flutter tests

`auth-gate`, `auto-push`, `boot-watchdog`, `cod-reconciliation`, `connectivity`,
`errors`, `money-format`, `money`, `order-form`, `outbox`, `passcode-lockout`,
`payment-boundary`, `payment-normalize`, `phase6`, `phase7`, `registration-deps`,
`registration`, `session-storage`, `sms-adapter`, `splash-assets`, `units`.

Plus Kotlin `ProviderParserTest.kt`.

These are **behavioural specifications**, not disposable scaffolding. The RN suite is
418 tests; the Flutter suite must cover the same behaviours. A test count that drops
without a stated reason is a regression.

---

## 10. Known warts — do not port blindly

| Reference behaviour | Why not to copy |
|---|---|
| `NativeModules.SellflowSms` lookup | Was the bug that silently disabled all detection (`d07e822`). Flutter must use the plugin/platform-channel registry. |
| Auto-submit passcode at 4 digits | Made 6/8-digit codes unenterable. Persisted `length` instead. |
| Wipe passcode after 5 attempts | A lockout that grants access. Replaced with cooldown. |
| Receipt of any number = payment | Provider + sender + amount + reference all required. |
| Single-clone passcode hashing | Correct — do not "upgrade" to a KDF. |

---

## 11. Migration order

1. Foundation — toolchain, `go_router`, Riverpod, Material 3 theme, light/dark
2. Core — money, errors, connectivity, secure storage, session
3. Auth — sign-in, register, passcode, lockout, session restore (**+ tests**)
4. Dashboard / analytics
5. Orders + calculations (**+ tests**)
6. Products, customers, inventory
7. Payments — accounts, intents, review, recording (**+ boundary test**)
8. SMS — Kotlin bridge + providers + queue (**+ adapter & parser tests**)
9. Courier / expenses / order-forms — *decision pending from §1.3*
10. Motion, performance, accessibility, small-screen passes
11. Release build

Backend is unchanged throughout. If a Flutter requirement genuinely cannot be met by
the existing contract, that is a stop-and-ask, not a unilateral schema change.
