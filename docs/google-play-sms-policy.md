# Google Play SMS permission: release gate for automatic payment detection

Status: **conditional go** for building the native listener. Not a clearance to ship.
Last verified: 3 October 2026, against the live policy pages linked below.

This document exists because automatic bKash/Nagad/Rocket detection depends on
reading one inbound SMS, and `RECEIVE_SMS` is a restricted permission. It records
what the policy actually says, which part of it applies to SellFlow, and what we
must do before an SMS build can be published.

---

## 1. What the policy says

Google Play restricts the SMS and Call Log permission groups. An app may hold them
only when it falls within a permitted use **and** only to enable its *critical core
functionality*. There are three routes:

1. **Default handler** — the app is the registered default SMS, Phone or Assistant
   handler.
2. **A named exception** in the policy's exception table.
3. **A pre-2019 APK policy exception** — not available to us.

SellFlow is not, and will not become, a default SMS handler. It has no feature that
reads, composes, forwards or manages the user's message inbox. So route 1 is closed
by design, and route 3 does not apply. **Route 2 is the only viable path.**

Two exceptions in the table cover SellFlow's use:

| Exception | Example given by Google | Eligible permissions |
| --- | --- | --- |
| **SMS-based financial transactions** | "Unified Payments Interface (UPI), verifications for financial transactions" | `READ_SMS`, `RECEIVE_MMS`, `RECEIVE_SMS`, `RECEIVE_WAP_PUSH`, `SEND_SMS` |
| **SMS-based money management** | "apps that track and manage budget" | `READ_SMS`, `RECEIVE_MMS`, `RECEIVE_SMS`, `RECEIVE_WAP_PUSH` |

SellFlow sits squarely in the first: it reads an inbound payment-notification SMS to
confirm that a customer actually paid, which is a financial transaction. The second
applies to the same feature from the seller's side — the app tracks money owed and
received.

`RECEIVE_SMS` is the only permission we need. We do **not** need `READ_SMS`,
`SEND_SMS`, `RECEIVE_MMS`, `RECEIVE_WAP_PUSH` or anything in Call Log. Requesting
only what we use is both a policy requirement and simpler review.

## 2. The two conditions that are not automatic

Google grants an exception when **both** hold:

1. **The permission enables the listed core functionality**, and
2. **"there's currently no alternative method to provide the core functionality."**

Both are judgment calls made by Play review. Being in the table is necessary, not
sufficient. Our position on each:

**Core functionality.** Defensible, but it constrains product design. The store
listing must prominently document automatic payment detection as a primary feature,
and the app must be genuinely less useful without it. This is why the app is built
so the engine works for every source, not just SMS: we can ship a Play-compliant
build that detects payments by API or manual entry, but we may not quietly remove
the SMS path and present the feature as though it still works.

**No alternative method.** This is the weaker claim and the one most likely to be
challenged. There is no free, low-cost, generally-available API that lets a small
Bangladesh merchant be notified when an arbitrary customer sends them money via
bKash/Nagad/Rocket — the merchant-facing products that do exist are commercial
products with their own eligibility and cost. Manual entry is not an equivalent
alternative in Google's sense: it is the same seller doing the same clerical work,
so it does not displace the feature. **This must be argued in the declaration form.
It cannot be assumed, and it must be re-checked before each submission** — if a
competitor ships a compliant notification API, this claim weakens.

## 3. What is forbidden here, and how the design already complies

The policy lists use cases that will not be permitted, including "SMS and contacts
management", "SMS or phone notification enhancement and alerts", research on SMS,
and any transfer or sale of the data. It also requires compliance with the Spyware
policy — no exfiltrating SMS unrelated to the declared functionality — and
forbids undisclosed or unimplemented uses.

The Phase 2 schema was built to the minimum scope the policy expects, and this is a
design constraint rather than a coincidence:

- **No inbox access.** We use `RECEIVE_SMS` and a broadcast receiver, never
  `content://sms` and never `READ_SMS`. Reading the inbox is a different and much
  broader permission.
- **The raw message body is never stored or transmitted.** Parsing happens on the
  device; only the normalised fields are sent — amount, sender, receiver,
  transaction id, timestamp. `payment_events.fingerprint` is a hash, kept so a
  repeated message can be recognised, and it cannot be read back into text.
- **Payment SMS only.** The listener matches the connected account's number and the
  provider, and discards everything else immediately. Unrelated messages are never
  parsed, logged or uploaded.
- **No new permission is added to the manifest implicitly.** `app.json` currently
  declares no SMS permissions. Any native change goes through a config plugin so
  the manifest diff is explicit and reviewable.
- **Nothing is sold or shared.** Payment data stays in the seller's own Supabase
  project.

If a future change would require reading the inbox, forwarding messages, or keeping
message bodies, it is out of policy and out of scope. Treat that as a stop sign
rather than a design problem.

## 4. Obligations before an SMS build can be published

These are release blockers, not nice-to-haves.

1. **Permissions Declaration Form** in Play Console, declaring `RECEIVE_SMS` and
   naming *SMS-based financial transactions* as the use case. Without it the app
   "may be removed from Google Play". Resubmit the form whenever the way we use the
   permission changes.
2. **Prominent disclosure and consent** in-app before the permission is requested —
   a real screen explaining that SellFlow reads incoming payment messages to confirm
   payments, with an explicit accept/decline, and a working path when declined.
   Consent must not be bundled into sign-up.
3. **Privacy Policy** updated to describe SMS handling, the fields extracted, and
   the retention period for normalised payment events.
4. **Data safety form** updated to declare the SMS-derived data and its use.
5. **Store listing** must prominently document automatic payment detection as core
   functionality. No euphemism, and no claiming a capability we cannot ship.
6. **"No alternative" argument written out** for the declaration form.
7. **Spyware policy compliance** review: confirm no unrelated SMS data leaves the
   device.
8. **Play policy review sign-off recorded** before release. Approval is not
   guaranteed, and a rejection is a normal outcome to plan for, not a defect.

## 5. Fallback if the exception is refused

This is the reason Phase 2 is a source-agnostic engine rather than an SMS feature.
`payment_event_source` is `sms`, `api`, `manual` or `import`, and the matching,
idempotency, audit and settlement logic is identical for all of them.

If Play refuses the exception, we remove `RECEIVE_SMS` from the manifest and ship
the same feature through the sources that need no restricted permission:

- **manual** — the seller types the transaction id; already implemented and tested.
- **api** — an MFS or aggregator API, when one is commercially available.
- **import** — a bank or MFS statement the seller uploads.

No matching rule, ledger, audit trail or idempotency guarantee is lost. The cost of a
refusal is seller convenience, not the feature.

**We will not respond to a refusal by misdeclaring the permission's use.** The
policy is explicit that deceptive and non-declared use can suspend the app and
terminate the developer account. Losing the account would cost every seller's
business, which is a far worse outcome than shipping a slower feature honestly.

## 6. Upcoming policy change (tracked, not blocking)

Google's announced July 2026 policy update removes one exception —
*account verification via phone call* for `READ_CALL_LOG` — effective
**27 January 2027**.

It does not touch `RECEIVE_SMS`, and both exceptions SellFlow relies on
(*SMS-based financial transactions*, *SMS-based money management*) remain in the
preview text of the updated article. So the change does not block us. We re-check
this page before every release anyway, since a rule that changes on a two-year cycle
today can change faster later.

## 7. Sources

Verified 3 October 2026.

- Use of SMS or Call Log permission groups (current) —
  <https://support.google.com/googleplay/android-developer/answer/10208820>
- Preview: Use of SMS or Call Log permission groups (July 2026 update) —
  <https://support.google.com/googleplay/android-developer/answer/17225965>
- Declare permissions for your app (Permissions Declaration Form) —
  <https://support.google.com/googleplay/android-developer/answer/9214102>
- Understand Google Play's Spyware policy —
  <https://support.google.com/googleplay/android-developer/answer/16558241>
- Financial services policy —
  <https://support.google.com/googleplay/android-developer/answer/9876821>
- Understand restricted permissions and minimum scope —
  <https://support.google.com/googleplay/android-developer/answer/13849271>
- Android default-handler roles (why SellFlow will not use route 1) —
  <https://developer.android.com/guide/topics/permissions/default-handlers>

Policy pages are living documents. The dates above are the honest ones: if this file
is more than a few months old, re-verify before trusting it.