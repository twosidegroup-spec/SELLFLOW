# Payment detection and matching engine

How a payment becomes money on an order in SellFlow, and why each step is built the
way it is.

Implemented in `supabase/migrations/0022_payment_tables.sql` (schema and ingestion)
and `supabase/migrations/0023_payment_matching.sql` (matching and settlement).
Verified by `supabase/test/verify_payment_engine.sql`.

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

## What is deliberately not here

- **No SMS permission, receiver or parser.** That is Phase 3, gated on the policy
  work in `docs/google-play-sms-policy.md`. The schema and engine are complete
  without it, and `source = 'manual'` already works end to end.
- **No subscription settlement.** `subscription` intents record and audit correctly,
  but there is no subscription table yet, so nothing pretends to have activated
  anything. The non-order branch of `settle_event_to_intent` is where Phase 3 grows
  the real settlement.
- **No raw message storage.** See the minimum-scope section of the Play policy doc;
  this is a policy requirement as much as a design choice.
- **No client queries layer yet.** The tables are readable and the RPCs are callable,
  but no React Query hooks or screens exist. Phase 2 is the foundation; the UI comes
  next, including the review queue the engine is designed to feed.