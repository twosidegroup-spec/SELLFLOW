# Privacy: what the SMS feature reads

The short version: **SellFlow reads bKash, Nagad, Rocket and Upay payment
notifications, and nothing else.** It never opens the seller's inbox.

This is the promise the implementation is built around, so it is stated precisely
and then enforced by tests rather than by policy.

---

## Read

| | |
| --- | --- |
| Inbound SMS, via `android.provider.Telephony.SMS_RECEIVED` | The platform delivers the message. Nothing is polled, fetched or back-read. |
| Payment notifications from four providers | Only messages a provider adapter claims. |
| The four fields those messages carry | Service, amount, transaction reference, and the phone numbers involved. |

## Never read

| | How it is prevented |
| --- | --- |
| The message inbox, or any other message | No `READ_SMS`, no `content://sms`, no `content://mms`. The boundary test bans `content://sms`, `Telephony.`, `getMessagesFromIntent` and `SmsManager` from `src/`. |
| One-time passcodes and security codes | `looksLikeOtpOrSecurity` runs in the registry **before** any provider adapter sees the message. |
| Contacts | No `READ_CONTACTS`. |
| Call history | No call-log permission. |
| Other apps' notifications | No notification-listener service. |
| The seller's other messages at all | An unrecognised message produces no row, no log line and no count — it leaves no trace. |
| Devices, locations, identifiers | Nothing. No advertising id, no IMEI, no fingerprint. |

## Never stored, never transmitted

**The text of a message is never persisted anywhere.** Not in AsyncStorage, not in
SQLite, not in a file, not in the native queue, not in SharedPreferences, not in a
log line, not in a crash report, not in the request body.

This is enforced three ways:

1. **By type.** `PaymentCandidate` has no field capable of holding text. The queue
   row has no such field.
2. **By enumeration.** `scripts/payment-boundary.test.mjs` lists every file in the
   native module that mentions `messageBody` and requires each one to be in the
   parsing pipeline. `CandidateQueue` is asserted never to contain the word at all.
3. **By the dev tool.** The parser-check panel holds a pasted message as one
   function argument and one native call. The boundary test asserts that
   `diagnostics.ts` touches no storage and has no path to `ingest_payment_event`.

### What is stored on the phone

```
provider · amount · transaction reference · payer number · receiving number
transaction time · detected time · SHA-256 hash · parser version · delivery state
```

Every one of those is either a number the seller's own records already contain, a
figure the payment engine needs, or metadata about the detection. None of them is
the message.

### The one derived value: the hash

`payment_events.fingerprint` is the SHA-256 hex of the message. It exists because
the platform delivers `SMS_RECEIVED` more than once in several situations, and the
engine needs to recognise a re-delivery as the same message.

A SHA-256 digest cannot be read back into text. It is not a copy of the message in
any meaningful sense, and it is the only thing derived from the body that outlives
it.

## What leaves the device

One request, to the seller's own Supabase project, containing only:

```
payment account id (the seller's own connected account)
provider · amount · transaction reference
payer number · receiving number
transaction time · detected time
SHA-256 hash · idempotency key · device support string
```

The support string is `android:<release>:sms:<appVersion>:p<parserVersion>`. It
contains no device identifier, no advertising id and no account number. It exists so
support can tell a parser bug from a delivery problem.

Nothing is sent to a third party. SellFlow sends nothing anywhere — there is no
analytics SDK, no crash reporter and no telemetry in this feature or anywhere in the
app.

## Where it is stored afterwards

In the seller's own Supabase project, in `payment_events`, readable by members of
that business and by nobody else (row-level security in migration 0004). The seller
can query or delete it. Nothing is shared with the provider, and nothing is sold.

## What a seller is told, and when

- The permission is explained in plain words on
  **Payments → Automatic detection** *before* the system dialog appears. The dialog
  itself says only "allow SellFlow to receive SMS".
- Consent is not bundled into sign-up. It is asked for on that screen, only on
  Android, only when the screen is opened.
- Saying no changes nothing else, and the screen says so in as many words.
- The status screen carries a plain list of what is read and what is never read.

## Honest limitations

- **Detection requires the provider's name in the message.** Detection identifies
  the provider from the provider's own branding. If an operator's notification omits
  it, the payment is *not detected* rather than being attributed to the wrong
  provider. This is pinned by a fixture (`payment-without-a-brand-word`) so it
  cannot regress unnoticed, and a learned sender-to-provider map is the documented
  follow-up if device QA shows real messages omitting the brand.
- **The queue holds parsed fields on the device until delivery.** That is necessary
  for offline operation, it is app-private storage, it is removed once the server
  accepts the event, and an event the server refuses stays visible until the seller
  removes it. It is not a message archive.
- **The provider parsers are unverified against real messages.** See
  `modules/sellflow-sms/fixtures/README.md`. This is a correctness risk, not a
  privacy one, and it does not affect what is read.
- **A parse failure is counted, not explained.** Diagnostics can tell you the
  listener saw N messages it could not read. They cannot tell you what they said,
  and deliberately so — that capability would turn the diagnostics into an inbox.

## Verification

| Claim | Where it is checked |
| --- | --- |
| JS never touches the transport | `payment-boundary.test.mjs` — *JavaScript never touches the SMS transport* |
| No raw body in any durable record | `payment-boundary.test.mjs` — *no raw message body is persisted*; *the native module keeps the message body inside one function* |
| Exactly one permission, no forbidden ones | `payment-boundary.test.mjs` — *the native SMS surface lives in one config plugin* |
| No privileged credential in the app | `payment-boundary.test.mjs` — *no privileged credential is reachable from the client* |
| A passcode is never a payment | `ProviderParserTest.kt` — *a passcode is never a payment* |
| An unrelated message leaves nothing | `ProviderParserTest.kt` — *an unrelated message leaves nothing behind* |
| The candidate's fields are exactly the ingest arguments | `ProviderParserTest.kt` — *a candidate carries no message content* |