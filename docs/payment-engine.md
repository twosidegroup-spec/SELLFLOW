# Payment detection and matching engine

How a payment becomes money on an order in SellFlow, and why each step is built the
way it is.

Implemented in `supabase/migrations/0022_payment_tables.sql` (schema and ingestion),
`0023_payment_matching.sql` (matching and settlement) and
`0024_payment_grants.sql` (explicit least privilege).
Verified by `supabase/test/verify_payment_engine.sql` (behaviour) and
`supabase/test/verify_payment_schema.sql` (structural contract).

---

## A privilege trap that only a hosted project can show

Migration 0024 exists because of a finding that local testing structurally
could not produce.

Supabase projects carry project-level **default privileges** on the `public`
schema that grant `arwdDxtm` — INSERT, SELECT, UPDATE, DELETE, TRUNCATE,
REFERENCES, TRIGGER, MAINTAIN — to **both `anon` and `authenticated`** for every
table created in `public`. Local verification runs on vanilla Postgres, which has
no such defaults.

So after 0022/0023 applied cleanly, the payment tables looked correctly
SELECT-only locally and on hosted carried:

```
ACL payment_events : postgres=arwdDxtm/postgres
                     anon=arwdDxtm/postgres
                     authenticated=arwdDxtm/postgres
```

The app was not exploitable: RLS has no INSERT/UPDATE/DELETE policy on those
tables, so RLS default-denied every write, and the only SELECT policy is
`is_org_member(org_id)`, false for anon. But the entire write protection of a money
ledger was resting on *the absence of a policy* — anyone who later added a policy
for an unrelated reason, or created a project with different defaults, would have
inherited table-level CRUD silently. "Passes locally, fails on hosted" was the
only symptom.

`0024` therefore revokes explicitly and asserts the result in the same
transaction, so a migration whose revokes fail loudly instead of being recorded as
applied. The rule worth carrying forward: **on this schema, never rely on a
privilege being absent. Revoke it.**

Two related notes, stated plainly rather than overclaimed:

- The settlement functions are revoked from `service_role` too, because default
  privileges grant it EXECUTE on every function. That does **not** stop a holder
  of the service key from writing the tables directly, since `service_role` has
  `BYPASSRLS`. That is inherent to the admin role and cannot be revoked away; the
  real protection is that the app never ships the service key.
- The behavioural suites (`verify_payment_engine.sql` and the app-wide suites)
  **cannot run against the hosted project**. `supabase test db --linked` connects
  as a restricted role that cannot write the `auth` schema, and
  `profiles.id → auth.users`, so no fixture can be created. `verify_concurrency`
  is additionally excluded everywhere-hosted because it commits fixtures and
  creates `dblink`. Hosted is therefore verified structurally (61 checks) and by
  a write-counter leak check; behaviour is verified locally against
  byte-identical migrations.

---

## The shape of it

```
transport            normalised event        decision           settlement
─────────            ─────────────────        ────────           ──────────
SMS on the device  ┐
MFS API (future)   ├─▶ ingest_payment_event ─▶ match_payment_event ─▶ record_payment
manual entry today ┘        (0022)               (0023)                (existing)
seller taps                                                        │
                                                                    ▼
                                                       payment_events -> payments
                                                       (detected)         (the ledger)
```

Two rules hold the whole design together.

**The engine never learns where a payment came from.** `payment_event_source`
(`sms`, `api`, `manual`, `import`) is recorded as data on the event. Nothing in the
matching or settlement path branches on it. Replacing SMS with an official bKash or
Nagad API later is a new source value and a new ingest caller — not a rewrite. This
is also the reason the engine is safe to ship if Google Play refuses the SMS
permission exception; see `docs/google-play-sms-policy.md`.

**The engine never decides that money arrived.** It decides which waiting request a
payment *probably* belongs to, and only an unambiguous strong match is confirmed
without a human. Settling an order happens exclusively through the existing
`record_payment(...)`, which is already the audited, idempotent money path in
SellFlow. The new tables are a ledger and a decision record, not a second ledger.

## The tables

| Table | What it is |
| --- | --- |
| `payment_accounts` | An MFS account a seller's customers pay into. |
| `payment_intents` | "I expect this much, from roughly this person, for this thing." |
| `payment_events` | Append-only ledger of detected payments. One row per payment, forever. |
| `payment_matches` | Every candidate considered, accepted or rejected. |
| `payment_audit_logs` | Append-only history of every action, with a typed actor. |

`payment_intents.type` is `order | subscription | invoice | other`, so the same
engine can collect a seller subscription as well as a customer's order. `reference_id`
points at the target without a foreign key, because the target table differs per
type and a polymorphic reference cannot be constrained — so the settlement path
validates it against the real table instead of trusting it.

### Why `payment_provider` and `payment_method` are separate

`payment_method` (how the seller says they took the money: cash, card, bkash, …) is
an existing enum. `payment_provider` (which MFS reported it: bKash, Nagad, Rocket,
Upay) is new.

They are related but not the same fact, and they grow at different rates. Upay has
no `payment_method` value, so it records as `other`. Conflating them would mean every
new MFS forces a migration to add a method value. Keeping them apart means adding a
provider is one row in a new enum.

## Money can only be counted once

This is the property that matters most, so it is enforced in the database rather than
in application code that can be bypassed:

- `uq_payment_events_identity` — UNIQUE on
  `(provider, payment_account_id, transaction_id)`. A provider transaction id is
  unique for an account. A phone that reconnects and re-reads the same SMS produces
  the same key, so it cannot create a second ledger row.
- `uq_payment_events_client_ref` — UNIQUE per account, for callers that supply their
  own retry key.
- `uq_payment_matches_accepted_event` — at most one accepted match per event.
- `uq_payment_intents_settled_event` — an intent can only be settled once.
- `uq_payment_intents_client_ref` — a retried intent request cannot open a second
  intent that would later swallow an unrelated payment.

Then the settlement itself: `record_payment` is called with
`p_idempotency_key => payment_events.id`, which it already supports. A replayed
match, a retried request, or two devices racing all present the same key, and
`uq_payments_client_ref` admits only one money row for it. Double settlement is
structurally impossible rather than merely unlikely.

`ingest_payment_event` checks for a duplicate before inserting so the caller gets a
friendly `"will not be counted twice"` response, and catches `unique_violation` to
handle two devices racing — but the constraint underneath is what actually makes it
safe. The test suite proves the constraint holds by writing a duplicate row directly
as the table owner, bypassing the RPC entirely.

## Matching, and why it refuses so much

`score_payment_match` scores one intent against one event and returns the individual
signals, not just a verdict, so both the audit trail and the tests can see the
reasoning:

| Signal | Meaning |
| --- | --- |
| `account_matched` | The number that received the money is the connected account. |
| `provider_matched` | Provider agrees (validated at ingest). |
| `amount_matched` | Amount equals the expected amount exactly. |
| `customer_phone_matched` | Sender number is known and equals the customer's, or `null` if unknown. |
| `within_window` | The intent has not expired. |

Those combine into:

| Strength | When | Settles itself? |
| --- | --- | --- |
| `strong` | account + exact amount + in window + sender verified as the customer | **Yes, if unique** |
| `medium` | account + exact amount, sender could not be verified | No |
| `weak` | amount differs, sender is known and different, or wrong account / expired | No |

Three refusals deserve their reasons stated plainly, because each is a case where a
smarter-looking engine would be wrong:

**Amount alone is not identity.** Two customers can each owe 500 BDT. Confirming a
payment because the amount matches a waiting request is a coin flip with a real
customer's money attached, so an unverified payer is `medium` and waits for a human.

**A tie is not a decision.** Two 500 BDT orders on one account is an ordinary day.
When more than one intent reaches the top strength, the engine refuses with
`ambiguous_candidates` and shows the seller the candidates. Picking one silently is
how the wrong customer gets credited. This check applies only at `strong`: a tie
among `medium` or `weak` candidates is not an ambiguity, because nothing was going to
settle anyway, and reporting it as one would send the seller looking for a choice
that does not exist.

**Confidence is ranked explicitly, not by enum order.**
`payment_match_strength` is declared `('strong','medium','weak')`, which makes
`'strong'` the *smallest* value. An enum comparison therefore ranks confidence
backwards, and a later weak candidate silently displaces a strong one. The matcher
uses an explicit integer rank so it cannot be inverted by reordering the enum. This
was a real bug, caught by the test suite.

The bias is deliberate and one-directional: a missed auto-confirmation costs the
seller one tap; a wrong auto-confirmation credits a real order with money that never
arrived, and `record_payment` has no way to notice.

### The seller always has the last word

Everything automatic refuses is settleable by hand via `assign_payment_match`, with
the same validation, the same settlement path and the same audit trail. It records
strength `manual` while preserving the underlying signals, so the difference between
"the engine was sure" and "the seller was sure" survives in the data.

That is what makes the conservative policy affordable. The review queue is a feature,
not a gap.

### Refusals that are not the seller's fault

If `record_payment` rejects the settlement — most often because the seller already
recorded part of it by hand, so the outstanding balance is smaller than the amount
that just arrived — the failure becomes a review item carrying the real reason
(`record_payment_refused`), not a stuck event and not a partial write. The call sits
in a plpgsql subtransaction, so a failed settlement leaves nothing behind: no partial
payment, no half-updated order.

## Tenant isolation and the trust boundary

Every table has RLS via `is_org_member`, and only `authenticated` holds `SELECT`.
There is no client `INSERT`/`UPDATE`/`DELETE` grant and no client write policy on any
of them, so every mutation is a `SECURITY DEFINER` function that re-authorises.

- The org is always **derived**, never accepted. `ingest_payment_event` resolves it
  from the payment account; settlement derives it through `record_payment`. A client
  cannot file a payment into somebody else's business.
- `create_payment_account` takes an org argument but validates it with
  `assert_org_write`, so it is safe *and* correct for a seller who runs more than one
  business. Deriving "the seller's first org by `created_at`" would quietly attach
  the account to the wrong one.
- A read-only staff member cannot connect an account, ingest, match or settle.
- Money-writing RPCs are deliberately **not** granted to `service_role`. A relay with
  the service key has no human behind it, and money entering the ledger should always
  be attributable to a session. A future API relay must present the seller's session
  or use a separately reviewed path.
- `payment_audit_logs` carries a CHECK constraint tying `actor_kind` to `actor_id`, so
  an automatic settlement can never be read as a person having approved it.

`orders` is never written by any of this. The test suite asserts, across every order
it creates, that `amount_paid` reconciles with the sum of the payment rows — any path
that touched orders without going through the ledger shows up there.

## Bangladeshi phone numbers

The same number arrives as `018…`, `+88018…`, `88018…` and `18…`.
`payment_normalize_bk_number` canonicalises to `01XXXXXXXXX` so those compare equal;
if they did not, a genuine payment would silently fail to match. Non-mobile input
passes through untouched rather than being coerced into something that could match by
accident. Normalised forms are used for matching only, never for display.

## The client layer

`src/features/payments/` holds the only code that talks to these tables.

- `queries.ts` — reads. The review queue deliberately reads `payment_matches`,
  including the rejected candidates, because "why did this not settle my order?"
  is unanswerable without them.
- `mutations.ts` — writes, and every one is an RPC. There is no `.insert()`,
  `.update()` or `.upsert()` against a payment table anywhere.
- `normalize.ts` — the client mirror of `payment_normalize_bk_number`, used only
  to show the seller the canonical form of what they typed. The server
  normalises again and is the authority.

`database.types.ts` declares all five payment tables with `Insert: never` and
`Update: never`. That is load-bearing rather than shorthand: the write path being
unavailable is then a **compile error at the point the code is written**, not a
request that fails at runtime and gets retried.

Screens:

| Screen | Route | Purpose |
| --- | --- | --- |
| Payments | `/(app)/payments` | Accounts, what needs review, how detection decides |
| Connect an account | `/(app)/payment-account/new` | The number customers pay into |
| Wait for a payment | `/(app)/payment-intent/new?orderId=` | Publishes an intent from an order |
| Review payments | `/(app)/payment-review` | The queue, with candidates and reasons |

Payments is a pushed route, not a sixth tab: the tab bar is five fixed
destinations by design. It is reached from **More**, which surfaces the pending
review count on the row so the seller learns there is work waiting without
opening anything.

On an order, "Record payment" and "Wait for a mobile payment" sit next to each
other because they are opposites. The first is the seller asserting money moved.
The second publishes an intent for the engine to match a real notification
against, so the order can be paid without touching the screen again.

## Verification

Two kinds of verification, and they are **not** interchangeable. Conflating them
is how a project ends up claiming hosted behavioural coverage it does not have.

### Local behavioural verification

Full end-to-end behaviour, against vanilla Postgres with the auth shim.

| Suite | Covers |
| --- | --- |
| `verify_payment_engine.sql` | The matching rules and their refusals, idempotency, tenant isolation |
| `verify_payment_lifecycle.sql` | The whole lifecycle in one flow, the matrix gaps, financial invariants, finance/COD reconciliation, audit semantics |
| `verify_payment_sms_adapter.sql` | The same engine driven with the native adapter's own argument shapes, plus forgery and replay |
| `verify_payment_schema.sql` | 100 structural assertions: indexes, signatures, grants, policies, trust boundary |

`verify_payment_lifecycle.sql` is the controlled end-to-end proof, and it drives
**only the RPCs the app has**: `bootstrap_business`, `create_payment_account`,
`create_payment_intent`, `ingest_payment_event`, `match_payment_event`,
`assign_payment_match`, `create_order`, `record_payment`. Nothing writes a payment
table directly, because that boundary is what the suite exists to defend.

The lifecycle it proves:

```
account -> intent -> event -> normalise -> match -> settle
        -> record_payment -> order payment state -> finance
```

with the +880 normaliser folding `+8801822000111` onto the connected account, the
settled amount appearing in `get_finance`, and the automated steps audited as
`actor_kind = system`.

### Hosted contract verification

Structural and privilege checks against the real project, via
`npm run db:verify:hosted`. 98 of 100 assertions run; two skip because the
restricted role cannot reach the objects they need.

**Behavioural suites cannot run on hosted.** `supabase test db --linked` connects
as a role that cannot write the `auth` schema, and `profiles.id → auth.users` is a
foreign key, so no fixture can be created. `verify_concurrency` is excluded
everywhere-hosted because it commits fixtures by design and creates `dblink`.

What hosted *does* prove, and it is worth a lot precisely because it is the
environment that created the original problem: no `anon` privilege on any payment
table; `authenticated` read-only including `TRUNCATE`; `PUBLIC` holding no
`EXECUTE` on any payment function; `anon` and `service_role` unable to execute
the money functions; and the intended public surface — the customer order link —
still reachable by `anon`.

### Client boundary

`scripts/payment-boundary.test.mjs` (24 assertions, static) fails the build if:

- any payment table stops being `Insert: never` / `Update: never`
- any source file writes a payment table directly
- `features/payments` contains a write call at all
- an unreviewed payment RPC is introduced
- `record_payment` is called from anywhere but `features/orders`
- a payment screen bypasses the feature layer
- the review queue loses a field needed to explain a refusal
- an SMS permission appears in `app.json` or `eas.json`
- the native SMS surface exists anywhere but the one config plugin
- the module's own manifest declares a permission or a receiver
- JavaScript touches the SMS transport, or any of the message plumbing
- a raw message body is persisted, transmitted or logged anywhere
- the native module handles a body outside the parsing pipeline
- the adapter posts through anything but `ingest_payment_event` / `match_payment_event`
- the client implements matching, scoring or settlement of its own
- a privileged credential is reachable from app code
- an idempotency key could be minted anywhere but the first-queue path
- a provider lacks its own adapter, or an adapter declares no anchors of its own
- the module is not registered and autolinkable

The last eight were added in Phase 2. The Phase 1 rule "no SMS code may exist at
all" was **removed, not relaxed** — it is replaced by rules about what SMS code may
do, which is a stricter position: before, any SMS code failed the build; now,
specific SMS code passes and specific violations fail.

## Registration

Email confirmation is **off**, deliberately. It was documented as off in both
`sign-up.tsx` and `config.toml` but hosted still had it on — a release step never
performed. It could not have worked anyway: hosted `site_url` was
`http://localhost:3000` with no `additional_redirect_urls`, so a confirmation link
dead-ends on a handset.

`scripts/verify-auth.mjs` proves the intended lifecycle against hosted with a
throwaway identity that is deleted and confirmed gone: register → session,
already-confirmed, duplicate refused, bad password refused, unknown user refused,
login, refresh, reuse detection, logout, re-login. 17/17.

**One documented gap:** password recovery still uses the hosted default
`site_url` of `http://localhost:3000`, so a recovery email links to localhost.
Fixing it needs `sellflow://` intent-filter and callback plumbing — a feature, not
a config change, and out of scope here.

## What is deliberately not here

- **No client-side decision of any kind.** The Android app detects, normalises and
  posts. It has no order lookup, no amount comparison and no "is this paid". See
  `docs/native-sms-architecture.md` and the boundary assertions in
  `scripts/payment-boundary.test.mjs`.
- **No subscription settlement.** `subscription` intents record and audit
  correctly, and an SMS payment reaches one through the same engine — that is proved
  in `verify_payment_sms_adapter.sql` §6 — but there is no subscription table yet,
  so nothing pretends to have activated anything. The non-order branch of
  `settle_event_to_intent` is where that grows.
- **No raw message storage, anywhere.** Not in the native queue, not in
  AsyncStorage, not in logs. The parser produces a normalised candidate and the body
  is unreachable the moment it returns. See `docs/privacy-sms.md`, which is enforced
  by enumeration in the boundary test rather than by policy.
- **No verified-against-real-messages parser.** The four provider parsers run
  against representative fixtures whose provenance is labelled in the corpus file,
  because the provider notification texts are not publicly documented. They have not
  been executed at all, because the authoring environment has no JDK. The
  authoritative statement of what is and is not verified is the table at the bottom
  of `docs/native-sms-architecture.md`; the gate is `docs/device-qa-checklist.md`.

## Phase 2: the native SMS producer

Added in Phase 2, and deliberately nothing more than a producer:

| | |
| --- | --- |
| Native module | `modules/sellflow-sms` — Kotlin `BroadcastReceiver`, four provider adapters, a candidate queue, a JS bridge |
| Manifest | `plugins/withSellflowSms.js` — `RECEIVE_SMS` and one receiver, nothing else |
| Client layer | `src/features/payments/sms/` — account resolution, durable queue, ingest and match, status |
| Screen | `/(app)/payment-sms` — status, permission explanation, queue, privacy summary |
| Tests | `scripts/sms-adapter.test.mjs`, `supabase/test/verify_payment_sms_adapter.sql`, `ProviderParserTest.kt` |

`ingest_payment_event` and `match_payment_event` are unchanged, `record_payment` is
unchanged, and no migration was needed: `payment_events` already had `fingerprint`,
`client_ref` and `detected_by`.

Two tables hold the boundary and both got stronger in Phase 2. The old rule was "no
SMS code may exist"; the new rules are about what SMS code may do — one permission,
no inbox access, no raw text retained, no client-side matching, and ingestion
through exactly one function. See `docs/sms-adapter-contract.md` for what changed
and why it is stricter.