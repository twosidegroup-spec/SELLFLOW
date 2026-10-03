# Native Android SMS architecture

How an inbound payment SMS becomes money on an order, and where the trust boundary
sits.

Status: **implemented.** Behaviour verified locally. Real-device verification
pending — see `docs/device-qa-checklist.md` and the verification section at the
bottom of this file.

---

## The pipeline

```
payment SMS on the seller's phone
        │
        ▼
SellflowSmsReceiver                 android/src/main/java/…/SellflowSmsReceiver.kt
        │  BroadcastReceiver for android.provider.Telephony.SMS_RECEIVED
        │  manifest-declared, so it runs with the app closed
        ▼
ProviderRegistry                    providers/ProviderRegistry.kt
        │  passes nothing on, so a passcode can never become a ledger row
        ▼
BkashAdapter | NagadAdapter | RocketAdapter | UpayAdapter
        │  one file per provider; parse() returns a PaymentCandidate or a reason
        ▼
PaymentCandidate                    normalised, on-device, no raw text
        │
        ▼
CandidateQueue                      android/…/CandidateQueue.kt
        │  durable, structured fields only, nothing raw
        ▼
SellflowSmsModule  ──── peek / acknowledge ────▶  JavaScript
        │
        ▼
src/features/payments/sms/
        │  resolveAccount → queue (one client_ref) → ingest → match
        ▼
ingest_payment_event                 supabase/migrations/0022 — UNCHANGED
        │
        ▼
match_payment_event                  supabase/migrations/0023 — UNCHANGED
        │
        ▼
settle_event_to_intent → record_payment
        │
        ▼
payment_events → payments            the ledger
        │
        ▼
order.payment_status = paid, finance reconciles
```

**Nothing in the middle of that diagram is new money logic.** Phase 2 added a
producer. The two functions that decide anything — `match_payment_event` and
`record_payment` — are byte-identical to Phase 1, and
`supabase/test/verify_payment_sms_adapter.sql` drives them with the adapter's own
argument shapes to prove they behave the same for a parsed value as for a typed
one.

## Why the parser is Kotlin and not JavaScript

The Phase 1 contract says the raw message body must never be stored — not in
SQLite, not in AsyncStorage, not in the queue, not in logs. That constraint
decides this.

An inbound SMS starts the app process, but **not** the React Native runtime. When
a payment arrives while SellFlow is closed there is no JS context, no
`react-native` runtime and no way to boot one from a broadcast receiver. So
something has to turn the message into structured fields and get them somewhere
durable *before* JavaScript exists.

That something is Kotlin, and what it persists is a `PaymentCandidate`:

| Field | Why it is safe to persist |
| --- | --- |
| `provider` | An enum the database already has. |
| `amount` | The number the engine needs. |
| `transactionId` | The provider's own reference — already the idempotency key. |
| `receiverAccount` / `senderAccount` | Phone numbers, already in the seller's own records. |
| `transactionTimestamp` | When the money moved. |
| `fingerprint` | SHA-256 hex. Cannot be read back into text. |
| `detectedAt`, `parserVersion` | Metadata. |

There is no `messageBody` field on that type, so the queue cannot hold one. The
boundary test asserts this by enumeration rather than by trust: it lists every
file in the module that mentions `messageBody`, and every one of them must be in
the parsing pipeline.

The alternative — parsing in TypeScript — would have needed the raw body written
to an app-private file so a later JavaScript context could read it. That is a
deliberate exception to an absolute rule, taken to avoid writing Kotlin. Phase 1
wrote the rule as absolute, so it stays absolute.

## Why a config plugin rather than `app.json`

`docs/google-play-sms-policy.md` requires the manifest diff for a restricted
permission to be explicit and reviewable. A library manifest arriving silently
through autolinking is the opposite of that.

So the module's own `AndroidManifest.xml` is deliberately empty, and
`plugins/withSellflowSms.js` adds both lines that matter:

```xml
<uses-permission android:name="android.permission.RECEIVE_SMS" />
…
<receiver android:name="com.sellflow.sms.SellflowSmsReceiver" android:exported="true">
  <intent-filter>
    <action android:name="android.provider.Telephony.SMS_RECEIVED" />
  </intent-filter>
</receiver>
```

`app.json` therefore still declares no SMS permission, and the Phase 1 boundary
assertion that said so is kept verbatim rather than rewritten. The plugin is
idempotent — running prebuild twice leaves exactly one permission and one receiver,
asserted by `test:payment-boundary` and verifiable by re-running prebuild.

`app.json` also points autolinking at the module:

```json
"autolinking": { "nativeModulesDir": "./modules" }
```

## What the receiver is careful about

- **The body is not stored.** It lives as one `SmsMessage` for one call to
  `ProviderRegistry.parse`, then goes out of scope.
- **An unrecognised message leaves no trace.** Not even a row saying one arrived.
  A seller's personal messages are not SellFlow's business.
- **A parse crash cannot lose a payment silently.** `ProviderRegistry.parse`
  never throws; a failure becomes a counted reason.
- **A passcode is refused before any provider sees it**, and so is a body too long
  to be a transaction.
- **The payer sending "you have sent" is refused.** Money leaving is not money
  arriving, and the seller's handset receives receipts, not the payer's own
  confirmations — but a mixed-up message must not credit money that never arrived.

## The hand-off, and why it cannot lose a payment

```
peek candidates ──▶ JS persists them into AsyncStorage ──▶ acknowledge
       │
       └── nothing is removed on read
```

`peekCandidatesAsync` does **not** consume. JavaScript persists the batch into its
own durable queue and only then acknowledges the native one. A process death in
between causes a redelivery, never a loss — and redelivery is harmless because the
JavaScript queue recognises a candidate it already has, and the database refuses a
second event for the same `(provider, payment_account_id, transaction_id)`.

## Retry, and the three decisions a failure can produce

`classifySendError` turns a failure into exactly one of:

| Decision | When | Effect |
| --- | --- | --- |
| `retry` | Network down, 5xx, an account not connected yet, an unrecognised error | Backoff and try again. |
| `permanent` | `invalid_amount`, `invalid_transaction_id`, `provider_mismatch` | Stop. A human enters it by hand. |
| `unauthenticated` | 401, `invalid_authorization`, `insufficient_privilege` | **Stop the whole queue.** |

The third is the one that matters most in practice. Every event after an expired
session would fail identically, so the queue pauses and says so rather than
hammering a 401 fifty times on every app resume.

Two more rules, both because the alternative loses a customer's money:

- **A device that knows it is offline attempts nothing.** Ten queued payments in a
  lift must not exhaust the retry budget without ever reaching the network.
- **Backoff is capped and attempts are capped** (`MAX_BACKOFF_MS`, `MAX_ATTEMPTS`),
  and an event that runs out becomes `failed` and stays visible rather than
  looping or disappearing.

## Where the trust boundary is

The APK is an untrusted client. The adapter may say:

> "I detected this payment: bKash, 1,000 BDT, reference 8GHK9XYZ12A, payer
> 01812345678, into the account I have connected, hash `aaa…`, detected by
> `android:14:sms:1.0.0:p1`."

It may not say anything about an org, a store, an order, an intent or a status,
and it has no code that could. `buildIngestArgs` in
`src/features/payments/sms/ingest.ts` is the only function that produces that
payload, and the boundary test asserts it carries exactly the eleven arguments of
`ingest_payment_event` and nothing else.

The server then:

1. resolves the organisation **from** `p_payment_account_id` — never from the
   caller;
2. calls `assert_org_write`;
3. compares the provider against the account it resolved;
4. compares the normalised receiver against that account's number.

A forged account id is `payment_account_not_found`. A read-only staff member is
refused. Neither `settle_event_to_intent` nor `record_payment` is reachable from a
client role at all. All of this is asserted in
`verify_payment_sms_adapter.sql` §3 and `0024_payment_grants.sql`.

## Parser versioning

`PaymentCandidate.parserVersion` starts at 1 and is written onto
`payment_events.detected_by` as `android:<release>:sms:<appVersion>:p<n>`.

There is no dedicated column, and adding one to a money table for a single
integer is not worth a migration. `detected_by` is already the documented
free-form "where did this come from" field, so the parser version rides there —
which means an SMS parsed today can be diagnosed against the rules that produced
it, in support, from the data that already exists.

## Adding a fifth provider

1. Add the value to the `payment_provider` enum (migration).
2. Create `providers/NewAdapter.kt` extending `AbstractProviderAdapter`.
3. Declare its `transferAnchors` and its `canHandle` brand pattern.
4. Register it in `ProviderRegistry.adapters`.
5. Add fixtures to `modules/sellflow-sms/android/src/test/resources/fixtures/`.

The receiver, the queue, the fingerprinting, the JS bridge, the ingestion call and
the engine are untouched. `test:payment-boundary` fails if a provider has no
adapter, or if an adapter never declares its own anchors — which is what keeps four
providers from quietly collapsing into one shared parser.

## Verification status

| Claim | Status | How |
| --- | --- | --- |
| Expo config resolves, module autolinks, manifest is correct and idempotent | **Verified here** | `npx expo prebuild --platform android`; manifest inspected |
| TypeScript, ESLint, expo-doctor | **Verified here** | `npm run typecheck`, `npm run lint`, `npx expo-doctor` |
| Adapter → `ingest_payment_event` → `match_payment_event` → `record_payment` → order paid → finance | **Verified here** | `verify_payment_sms_adapter.sql` §1 |
| Duplicate, replay, forgery, cross-tenant, wrong account, wrong amount, expired, ambiguous, staff | **Verified here** | `verify_payment_sms_adapter.sql` §2–§6 |
| Queue durability, backoff, retry classification, idempotency key reuse | **Verified here** | `scripts/sms-adapter.test.mjs` |
| Corpus integrity and coverage claims | **Verified here** | `scripts/sms-adapter.test.mjs` |
| Provider parsers against the fixture corpus | **NOT EXECUTED** | Kotlin/JUnit needs a JDK: `cd android && ./gradlew :sellflow-sms:testDebugUnitTest` |
| Any parser against a real provider message | **NOT VERIFIED** | Needs a real device; `docs/device-qa-checklist.md` |
| The APK builds and the receiver fires | **NOT VERIFIED** | No JDK, Android SDK, `adb` or device in the authoring environment |

The last two are the honest gap, and they are the reason the release report
distinguishes "representative fixture tested", "unit-tested parser", "real
captured-message tested" and "real-device tested". Only the first is true of any
provider parser today.