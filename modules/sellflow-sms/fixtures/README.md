# Provider message fixtures

**Every fixture in `payment-sms.json` is REPRESENTATIVE and UNVERIFIED.**

## What that means

The notification texts sent by bKash, Nagad, Rocket and Upay are **not publicly
documented**. They are delivered by the operators' SMS shortcodes, they are
proprietary, and the wording changes. Search finds marketing pages, not formats.

So the fixtures here encode the *structure* of a money-in notification — the shape
that is widely reported and consistent across the operators:

```
<receive verb> <currency> <amount> from <payer number>
    [ on <date> <time> ]
    [ . <provider> balance <currency> <amount> ]
    . TrxID: <reference>
```

They are **not** any provider's exact current wording, and a green test run does
**not** mean any parser is real-world verified. It means the parser behaves as
specified against a representative corpus.

## What this file is and is not

| | |
| --- | --- |
| Proves | The parser extracts only from labelled/shaped fields, refuses ambiguity, never invents a reference, never reads a balance as a transfer, and never treats a passcode as money. |
| Proves | Exactly one provider claims any given message. |
| Does **not** prove | That a real bKash message contains the word "bKash". |
| Does **not** prove | That any of these four parsers has seen a real payment. |

## Closing the gap

This is an explicit device-QA step, not a nice-to-have. See
`docs/device-qa-checklist.md`.

1. Send a real payment to a connected account.
2. Open **Payments → Automatic detection → Parser check (development only)**.
3. Paste the real message. Nothing is saved and nothing is sent.
4. If it is refused, or a field comes out wrong, the adapter needs extending.
5. Add the real message to this file with `"captured": true` and a `note`
   recording which operator and handset it came from.

A `captured: true` fixture is the only thing that moves a parser from
"unit-tested" to "real captured-message tested", and only a real device test moves
it to "real-device tested". Those are three different claims and the release report
has to distinguish them.

## Covered by every provider

Valid payment, compact wording, currency spelled differently, no space after the
currency token, alternate reference label, time-first ordering, no payer number
(a walk-in customer, which must still parse), receiving number stated.

## Covered as negatives

Wrong provider · unrelated personal SMS · marketing naming a provider · OTP · bare
digits · labelled code · missing amount · malformed amount · missing reference ·
malformed reference · reference that is a phone number · payer's own "you sent"
confirmation · balance-only message · two conflicting amounts · a message with no
provider name · a broadcast longer than any real notification.

## Not covered here, and why

- **Duplicate transactions, replay, offline retry, matching, settlement.** These
  are not parser concerns and a stateless parser cannot express them. They live in
  `scripts/sms-adapter.test.mjs` and `supabase/test/verify_payment_sms_adapter.sql`,
  where the engine is actually involved.
- **Cross-tenant and forged-argument attacks.** Also not parser concerns; the parser
  cannot forge an account because it never touches one. Covered in the database
  suite.