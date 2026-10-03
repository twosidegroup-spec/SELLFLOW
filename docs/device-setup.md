# Device setup: automatic payment detection

Everything a seller — and whoever tests this for them — needs to turn the feature
on, and what happens when they do not.

---

## What is supported

| | |
| --- | --- |
| Platform | **Android only.** The feature does nothing on iOS or web. |
| Android version | 7.0 (API 24) and above. |
| Permission | `android.permission.RECEIVE_SMS`, and nothing else. |
| Distribution | APK from the SellFlow website. No Play Store requirement. |
| Providers | bKash, Nagad, Rocket, Upay. |

## Why only `RECEIVE_SMS`

`RECEIVE_SMS` is the minimum that reads an inbound payment notification, and it is
delivered to every app that asks for it — not only the default SMS handler. That is
what lets SellFlow read a payment notification **without becoming a message app**,
and it is why no other permission is requested.

Not requested, and not needed for anything:

| Permission | Why not |
| --- | --- |
| `READ_SMS` | Would give access to the seller's entire inbox. Reading one notification is not reading the inbox. |
| `SEND_SMS`, `WRITE_SMS` | Unused. |
| `RECEIVE_MMS`, `RECEIVE_WAP_PUSH` | Unused. |
| `BROADCAST_SMS` | Gates `SMS_DELIVER`, which only the default SMS app may receive. Requesting a permission the feature cannot use is a worse look than not requesting it. |
| Contacts, call log, notifications | Unused. |

`docs/google-play-sms-policy.md` carries the full position on restricted
permissions.

## Setting it up, as a seller

1. **Install SellFlow** and sign in with email and password.
2. **Connect a payment account** — Payments → the `+` next to *Connected accounts*.
   Enter the bKash, Nagad, Rocket or Upay number your customers pay into. Save it in
   the form; it is normalised to `01XXXXXXXXX` and the canonical form is shown.
3. **Open Payments → Automatic detection.**
4. **Read the explanation**, then tap **Allow payment messages**. The Android dialog
   appears and asks for the same thing.
5. The screen then reports **Waiting for payment**.

Nothing else is required. There is no setup, no account and no configuration beyond
the connected payment account.

## What the status means

| Status | What it means | What to do |
| --- | --- | --- |
| **Not available on this device** | Not Android, or a build without the native listener. | Manual payment entry works. |
| **Permission needed** | The listener has not asked yet. | Tap *Allow payment messages*. |
| **Permission not granted** | Declined, or blocked in system settings. | Nothing is broken. Record payments by hand, or allow the permission in Android Settings → Apps → SellFlow → Permissions. |
| **Listener not running** | Permission granted but the receiver is not registered — a build where the plugin did not run. | Report it. This is a defect, not a setting. |
| **No payment account connected** | Nothing to detect against. | Connect an account. |
| **Sign in to send** | A payment was detected but the session ended before it could be sent. | Sign in. It goes on its own. |
| **Offline — queued** | A payment is waiting for a connection. | Nothing. It sends itself. |
| **Needs your attention** | A payment could not be sent automatically — a malformed message, or an account that is not connected. | Record it by hand, or remove it. The event is never deleted silently. |
| **Payment detected** | Sending now. | Nothing. |
| **Confirmed** | The engine matched a payment to an order by itself. | Nothing. |
| **Needs review** | A payment arrived that the engine would not settle without you. | Payments → Review. |
| **Waiting for payment** | Connected and listening. | Nothing. |

**Confirmed** and **Needs review** come from `payment_events.status`, which only the
engine writes. The app cannot set that column, so the app cannot show a
false confirmation.

## If permission is denied

Everything else keeps working. Orders, stock, customers, finance, reports, and
**manual payment entry through the same `record_payment` boundary as before** — the
automatic listener is an addition, not a replacement.

The status screen says so in as many words rather than showing a healthy-looking
state, and there is no "connected" badge anywhere that a denied permission could
light up.

## What is stored on the phone

Structured payment fields only, in the app's private storage:

```
provider · amount · transaction reference · payer number · receiving number
transaction time · detected time · SHA-256 hash · parser version · delivery state
```

**Never** the text of a message. Not in the queue, not in AsyncStorage, not in a
log, not in a crash report, not on the network. See `docs/privacy-sms.md`.

The hash exists so an identical redelivered message can be recognised as the same
message. It cannot be read back into text.

## Testing the listener yourself

You cannot make a real payment notification appear by sending yourself an SMS — the
message has to come from the provider's shortcode. To check the listener without a
payment:

1. Connect a payment account.
2. Open **Payments → Automatic detection**.
3. Scroll to **Waiting to send**. It will be empty, and **Last detected** reads
   *Nothing yet*. That is the correct starting state, not a failure.
4. Ask someone to send you money to that account, or make a small real payment.
5. Within a few seconds the event should appear as confirmed, or in the review queue.

To check the parser without moving money, and in a development build only, the
status screen has a **Parser check** panel: paste a real provider message and the
real Kotlin parser reports what it made of it. Nothing is saved and nothing is sent.
That is the intended way to confirm a parser against a real message — see
`modules/sellflow-sms/fixtures/README.md`.

## Reading the diagnostics

The status screen shows queue depth and, in a development build, why messages were
not recognised (as counts by reason). It never shows a message body — there is no
place in the UI where one could appear.

If detection is not working, the useful things to collect are:

- the Android version and handset model;
- whether the connected account's provider matches the SMS sender;
- a **hash** from the parser check for the real message, never the message itself;
- the status text from the screen.

## Uninstalling

Uninstalling removes the queue with the app. Nothing on the server is lost —
`payment_events` and the ledger are in the seller's own Supabase project.