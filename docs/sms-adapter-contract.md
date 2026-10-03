# Future native SMS adapter contract

Status: **specification only. Not implemented, not started, not permitted yet.**

This document defines what a future Android native adapter must produce and, just
as importantly, what it must never do. It exists so that when the work is
unblocked, the adapter has a contract to satisfy rather than a design to
reinvent — and so that the boundary is reviewable *before* a single line of it
exists.

Two gates must both be open before any adapter code is written:

1. **Policy.** `RECEIVE_SMS` is a restricted permission. SellFlow's eligibility
   rests on the *SMS-based financial transactions* exception, which is granted per
   project and must be declared. See `docs/google-play-sms-policy.md` for the
   full position, the eight release blockers, and the fallback plan.
2. **This contract.** The adapter must produce a normalised event and nothing
   more.

If either gate is closed, the engine still works: `source = 'manual'` is
implemented and tested today.

---

## The shape

```
Android native layer
  ├─ BroadcastReceiver for incoming SMS
  ├─ Provider-specific parser (bKash / Nagad / Rocket / Upay)
  ├─ LOCAL QUEUE (retry, survives reboot)
  └─ posts a normalised event to JS
        │
        ▼
  ingest_payment_event(...)        ← the ONLY write the adapter causes
        │
        ▼
  matching engine                  ← decides; the adapter never does
        │
        ▼
  settle_event_to_intent → record_payment   ← the financial ledger
```

The native layer's entire responsibility is: **decide whether this SMS is a
payment notification, and if so produce structured fields.** Everything about
whether that payment pays an order is decided by existing, tested code.

## What the adapter must produce

Exactly the arguments of `ingest_payment_event`, which is the single authorised
write path:

| Argument | Meaning | Rules |
| --- | --- | --- |
| `p_payment_account_id` | Which connected account received the money | Must be resolved from a locally cached list of the seller's own accounts. **Never** from the message body. |
| `p_provider` | `bkash` \| `nagad` \| `rocket` \| `upay` | From which parser matched, not from string sniffing. |
| `p_receiver_account` | The number the money arrived at | The literal number from the message, un-normalised. The server normalises. |
| `p_sender_account` | The payer's number | `null` when the message genuinely does not contain it. Never guessed. |
| `p_amount` | Whole taka as a number | `1000`, not `1000.00` and never in poisha. The column is `numeric(14,2)` in major units. |
| `p_transaction_id` | The provider's TrxID | The provider's own reference. This is the idempotency key: see below. |
| `p_transaction_timestamp` | When the provider says the transfer happened | ISO 8601 with offset, from the message. Not `now()`. The gap between the two is signal. |
| `p_source` | `sms` | The only value an adapter may send. |
| `p_fingerprint` | Hash of the raw message | SHA-256 hex. Lets the server recognise a re-delivered identical message. **The hash, never the text.** |
| `p_client_ref` | Idempotency key for retries | A UUID generated once when the event is first queued and reused for every retry. |
| `p_detected_by` | Where it came from | Free-form platform/build string, e.g. `android:14:sms:1.0.0`. For support only. |

### Normalised metadata needed for verification

The engine's confidence scoring depends on three things the adapter must get
right, because a wrong value here causes a *refusal*, not a wrong payment:

1. **`p_receiver_account` must equal the connected account.** The engine compares
   the normalised receiver against the account the seller connected. If the
   adapter sends the sender's number here by mistake, every match becomes
   `account_mismatch` and nothing ever settles.
2. **`p_sender_account` must be the payer.** This is what upgrades a match from
   `medium` (amount only, waits for a human) to `strong` (settles itself). A
   parser that puts the receiver in the sender field silently disables automatic
   confirmation for every payment.
3. **`p_amount` must be the transfer amount**, not a balance, a fee, or a
   running total. A parser that reports a balance produces plausible amounts that
   never match an order.

These three are the whole contract in practice. Everything else is bookkeeping.

## What the adapter must never do

| Prohibition | Why |
| --- | --- |
| **Send the SMS inbox to the server.** | The policy exception covers payment notifications only. Reading or transmitting a user's messages is a different, much broader permission and an immediate grounds for removal. Only the fields above leave the device. |
| **Store the raw message body.** | Not in AsyncStorage, not in SQLite, not in the local queue, not in logs. The fingerprint is a hash. This is both a policy requirement and a privacy one — see the minimum-scope section of the Play policy doc. |
| **Contain or request a service-role key.** | The adapter runs in the app, where any secret is extractable. It uses the user's own Supabase session, so RLS and the engine's own authorisation apply. |
| **Write payment tables directly.** | `Insert: never` / `Update: never` in the types, revoked grants in the database, and an automated boundary test. The adapter goes through `ingest_payment_event`. |
| **Call `record_payment`.** | Settlement is the engine's. A client-side `record_payment` would move money without an event, without a match, and without the audit trail explaining why. |
| **Implement matching or scoring.** | No amount comparison, no phone comparison, no "is this order paid?". The engine owns every decision, and it is the part that has been adversarially tested. A second implementation is a second set of bugs. |
| **Retry by generating a new `p_client_ref`.** | That defeats idempotency. One event, one `client_ref`, reused until it succeeds. |
| **Invent a transaction id.** | If the message has no TrxID, do not fabricate one. Re-reading the same SMS then looks like a new payment, which is exactly the double-count this engine is built to prevent. Decline and let the seller enter it by hand. |

## Failure behaviour

The engine already treats these as normal outcomes, and the adapter must not try
to "fix" them:

- An SMS that is not a payment notification → ignore silently. Do not log the body.
- A payment notification for an account the seller has not connected → the server
  refuses it (`payment_account_not_found`). Surface nothing; it is not the
  seller's money.
- No network → the local queue retries with the same `client_ref`.
- A duplicate message → the server returns `duplicate: true`. That is success,
  not an error.
- An amount that matches no open order → `unmatched`, shown in the review queue.
  Correct outcome, not a failure.

## Testing the adapter, when it exists

The adapter's parsing is the one genuinely new piece of logic, and it is
provider-specific string handling. It must be tested as such:

- Table-driven tests over real message fixtures per provider, asserting the exact
  `ingest_payment_event` arguments.
- Negative fixtures: balance messages, OTPs, marketing, malformed amounts.
- A round-trip test proving a re-delivered message yields `duplicate: true` and
  one ledger row.
- No test may assert on matching or settlement behaviour — those are the engine's,
  already covered by `verify_payment_engine.sql` and `verify_payment_lifecycle.sql`.

None of this exists yet. `scripts/payment-boundary.test.mjs` currently asserts
its **absence**: no SMS permission in `app.json`, and no receiver, `pdus`,
`SmsReceiver` or SMS-body handling anywhere in `src/`. If someone starts this
work without unblocking the gates, that test fails — which is the intended
behaviour.