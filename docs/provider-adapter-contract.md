# Provider adapter contract

What a `ProviderAdapter` must do, what it must never do, and how one is added.

Implemented by `modules/sellflow-sms/android/src/main/java/com/sellflow/sms/providers`.
The full pipeline is in `docs/native-sms-architecture.md`; the high-level rules the
adapter inherits from Phase 1 are in `docs/sms-adapter-contract.md`.

---

## The interface

```kotlin
interface ProviderAdapter {
    val provider: Provider
    val parserVersion: Int
    val transferAnchors: List<String>

    fun canHandle(message: SmsMessage): Boolean
    fun parse(message: SmsMessage): ParseOutcome
}
```

| Member | Responsibility |
| --- | --- |
| `provider` | Which `payment_provider` value this adapter speaks for. |
| `parserVersion` | Bumped when an extracted field could change. Written onto every candidate. |
| `transferAnchors` | This provider's own words that introduce the **transfer** amount, most specific first. |
| `canHandle` | "Is this my message?" — cheap, and *not* "is this valid?". |
| `parse` | Extract a candidate, or refuse with a reason. |

Almost everything is inherited: `AbstractProviderAdapter` owns the order of checks,
the OTP guard, the reference plausibility test and the shape of the result, so an
adapter cannot accidentally skip one.

## `canHandle` answers ownership, not validity

`canHandle` must be cheap and must not extract amounts. Everything it does not
claim is discarded before any parsing work starts, so an unrelated message is never
interpreted.

In practice: the provider's own name, plus a receive verb, minus a send verb. It
deliberately does **not** require a currency token or an amount — a bKash receipt
with an unreadable amount is still bKash's message, it is just one this adapter has
to refuse with a reason that tells a developer whether the wording or the figure is
at fault. Folding validity into detection makes every malformation look like "not a
payment message", which is a diagnostic nobody can act on.

## `parse` rules

### Extract by shape, never by position

Operators reword and reorder these messages. `text.substring(40)` is not a parser.
Every extraction is anchored to a label (`TrxID`, `from`, `To account`) or to a
token shape (a number, a clock, a date).

### The balance is not the amount

A real notification states the transfer **and** the resulting balance in the same
message:

```
You have received Tk 1,000.00 from 01812345678 …
Your bKash balance Tk 15,000.00. TrxID: 8GHK9XYZ12A
```

Reading the wrong number is not an edge case here; it is the normal case, and it
fails by producing plausible amounts that silently never match an order. So:

1. `transferAnchors` locates the transfer specifically;
2. amounts inside a balance word's window are excluded;
3. if more than one amount survives, the message is **refused**
   (`ambiguous_fields`) rather than resolved by taking the first.

### Never invent a transaction reference

A re-read of one SMS must not be able to look like a second payment. If no
reference can be recovered, the adapter refuses. It never synthesises one.

A reference is accepted when it is 4–32 characters, alphanumeric, contains at least
one digit, and is not itself a phone number, a date or a clock. A reference that is
`01712345678` is refused: it would make one SMS idempotent against a number rather
than a transaction.

### Digits inside a reference are not an amount

`TrxID: BKMISSAMT1` contains a `1`. Without an explicit rule, a message with a
currency token and no figure becomes a payment of 1 taka. `isMoneyToken` skips a
digit run touching letters, unless the letters are exactly a currency token — which
is what keeps `Tk1000` working while `8GHK9XYZ12A` contributes nothing.

### A passcode is never a payment

Checked in the registry, before any adapter runs, and again in `parse`. This is the
single most damaging thing this module could get wrong: turning someone's two-factor
code into a ledger row would make SellFlow unusable for a bank-grade customer.

### Never use the body in the result

`SmsMessage.messageBody` is a parameter, not a field of anything returned. The only
thing that leaves `parse` is a `PaymentCandidate`, and that type has no field capable
of holding text.

### Absent is normal

| Field | When the message does not state it |
| --- | --- |
| `senderAccount` | `null`. A walk-in customer with no number is real. The engine downgrades the match to `medium` and waits for a human, which is correct. |
| `receiverAccount` | `null`, resolved on the JS side from the seller's own connected account. Most notifications name the payer, not the payee. |
| `transactionTimestamp` | `null`. The server falls back to detection time; `payment_events` keeps both, and the gap is itself a signal. |

An **ambiguous** date such as `03/04/2024` is refused rather than assumed
day-first or month-first. A wrong timestamp is a wrong intent window.

## Outcomes

```kotlin
sealed class ParseOutcome {
    data class Parsed(val candidate: PaymentCandidate) : ParseOutcome()
    data class Rejected(val reason: RejectionReason) : ParseOutcome()
}
```

| Reason | Meaning |
| --- | --- |
| `not_a_payment_message` | Not one of the four providers, or nothing we read. |
| `otp_or_security_message` | A passcode. Never a payment. |
| `unsupported_provider` | Reads as a received payment in a currency, but no adapter claimed it. Usually a provider we do not parse — a missing parser, not a filter misfiring. |
| `missing_amount` | Named the provider and a transfer, no figure. |
| `malformed_amount` | A currency token with nothing usable after it. |
| `missing_transaction_id` | No reference anywhere. |
| `malformed_transaction_id` | A reference label with an unusable value. |
| `ambiguous_fields` | Two or more plausible amounts. |

Rejections are **counted, never stored**. Diagnostics need to know "the listener
saw 412 messages and recognised 3 payments", not what the other 409 said.

## Versioning

`parserVersion` starts at 1. Bump it when an extracted field could change — a new
wording accepted, a previously-accepted one refused, a field extracted where it was
not before. It lands on `payment_events.detected_by` as
`android:<release>:sms:<appVersion>:p<n>`.

Do not bump it for a refactor that changes no output. A version that does not
correspond to a behavioural change makes the recorded value useless for support.

## Tests

Table-driven over `android/src/test/resources/fixtures/payment-sms.json`, which the
Node suite also reads so the corpus's coverage claims are checkable without a JDK:

```bash
cd android && ./gradlew :sellflow-sms:testDebugUnitTest
```

**Those fixtures are representative, not captured.** The provider notification texts
are not publicly documented. A green run means the parser behaves as specified
against a representative corpus — it does not mean any parser has seen a real
payment. `modules/sellflow-sms/fixtures/README.md` explains the gap and how to
close it.

`ProviderParserTest` also asserts two things that are easy to lose and expensive to
notice later: that **exactly one** adapter claims any message (bKash and Nagad
wording overlap enough that a loose brand pattern would attribute a customer's
payment to whichever adapter happened to be registered first), and that
`PaymentCandidate`'s fields are exactly the ingest arguments — a field carrying
message text would be a privacy failure no type error would catch.

## Adding a provider

1. Migration: add the value to `payment_provider`.
2. `providers/NewAdapter.kt extends AbstractProviderAdapter`.
3. Declare `transferAnchors`, `canHandle` brand and receive/send patterns.
4. Register in `ProviderRegistry.adapters`.
5. Fixtures: positives and every negative category.
6. `test:payment-boundary` fails if a provider has no adapter, or an adapter
   declares no anchors of its own.