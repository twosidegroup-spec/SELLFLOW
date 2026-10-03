# Device QA checklist

The gate for the native SMS payment adapter. Nothing in this file has been executed
by the authoring environment, which has no JDK, no Android SDK, no `adb` and no
connected handset. Every row below is therefore **NOT TESTED**, and must not be
reported as verified until it has actually been run.

Sign-off means: every row executed on real hardware against a real provider
message, with the evidence column filled in.

**Test device** ______________________  **Android version** ____________
**App build** ________________________  **Signed profile** ______________
**Tester** ____________________________  **Date** _________________________

---

## A. Environment

| # | Step | Command / action | Expected | Result |
| --- | --- | --- | --- | --- |
| A1 | Install dependencies | `npm ci` | Completes | NOT TESTED |
| A2 | Regenerate native project | `npx expo prebuild --platform android` | Completes | NOT TESTED |
| A3 | Manifest has exactly one permission | `grep -c "android.permission.RECEIVE_SMS" android/app/src/main/AndroidManifest.xml` | `1` | NOT TESTED |
| A4 | Manifest has exactly one receiver | `grep -c "<receiver" android/app/src/main/AndroidManifest.xml` | `1` | NOT TESTED |
| A5 | Manifest has exactly one application | `grep -c "<application" android/app/src/main/AndroidManifest.xml` | `1` | NOT TESTED |
| A6 | No forbidden permission | `grep -cE "READ_SMS\|SEND_SMS\|WRITE_SMS\|RECEIVE_MMS\|RECEIVE_WAP_PUSH\|BROADCAST_SMS\|READ_CONTACTS\|CALL_LOG" android/app/src/main/AndroidManifest.xml` | `0` | NOT TESTED |
| A7 | The module autolinks | `npx expo-modules-autolinking resolve --platform android --json \| grep SellflowSmsModule` | One match | NOT TESTED |
| A8 | Prebuild is idempotent | Re-run A2, then A3–A5 | Still `1`/`1`/`1` | NOT TESTED |
| A9 | Repository verification | `npm test` | All green | NOT TESTED |
| A10 | Provider parser suite | `cd android && ./gradlew :sellflow-sms:testDebugUnitTest` | Passes | NOT TESTED |

> A10 is the first execution of the Kotlin provider parsers. If a fixture fails
> here, the parser disagrees with the corpus in
> `modules/sellflow-sms/android/src/test/resources/fixtures/payment-sms.json` —
> fix whichever is wrong before going further, and note which.

## B. Build and install

| # | Step | Command / action | Expected | Result |
| --- | --- | --- | --- | --- |
| B1 | Device visible | `adb devices` | Device listed, state `device` | NOT TESTED |
| B2 | Build and launch | `npx expo run:android` | App opens | NOT TESTED |
| B3 | Metro reachable | App loads screens, no red screen | Loads | NOT TESTED |
| B4 | Package id is correct | `adb shell pm list packages \| grep sellflow` | `com.sellflow.app` | NOT TESTED |
| B5 | APK installs cleanly | `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` | `Success` | NOT TESTED |

## C. Sign in and connect an account

| # | Step | Action | Expected | Result |
| --- | --- | --- | --- | --- |
| C1 | Email + password sign-in | Sign in | Lands on the dashboard | NOT TESTED |
| C2 | No phone/password auth | Observe the sign-in screen | Email and password only | NOT TESTED |
| C3 | Connect a payment account | Payments → `+` → bKash number `017XXXXXXXX` | Row appears, masked | NOT TESTED |
| C4 | Number normalised | Enter `+880171…` | Saved as `0171…`, rewrite shown | NOT TESTED |
| C5 | A bad number is refused | Enter `12345` | Save disabled | NOT TESTED |
| C6 | Opening the screen | Payments → Automatic detection | Status screen opens | NOT TESTED |
| C7 | **Before** permission | Status shows *Permission needed* | No "connected" state | NOT TESTED |

## D. Permission

| # | Step | Action | Expected | Result |
| --- | --- | --- | --- | --- |
| D1 | Explanation is shown first | Read the card | States why, in plain words | NOT TESTED |
| D2 | The OS dialog appears | Tap *Allow payment messages* | System dialog | NOT TESTED |
| D3 | Grant | Allow | Status becomes *Waiting for payment* | NOT TESTED |
| D4 | Listener is active | Status → *Device listener* | `Active` | NOT TESTED |
| D5 | Receiver is registered | `adb shell dumpsys package com.sellflow.app \| grep SMS_RECEIVED` | Present | NOT TESTED |
| D6 | Revocation is honoured | `adb shell pm revoke com.sellflow.app android.permission.RECEIVE_SMS` | Status → *Permission not granted* | NOT TESTED |
| D7 | The app still works after denial | Record a payment by hand on an order | Order records the payment | NOT TESTED |
| D8 | No fake healthy state | After D6 | No green "connected" anywhere | NOT TESTED |
| D9 | Re-grant | Re-enable in Settings, reopen the screen | Returns to *Waiting* | NOT TESTED |

## E. Detection: no real money yet

| # | Step | Action | Expected | Result |
| --- | --- | --- | --- | --- |
| E1 | Empty state is honest | Look at *Waiting to send* | Empty | NOT TESTED |
| E2 | Nothing claimed yet | Look at *Last detected* | *Nothing yet* | NOT TESTED |
| E3 | An unrelated message is ignored | Send a personal SMS to the device | No event appears | NOT TESTED |
| E4 | A marketing blast is ignored | Send a bKash promotional SMS | No event appears | NOT TESTED |
| E5 | A bank alert is not treated as MFS | Send a bank credit SMS | No event, or unsupported-provider count only | NOT TESTED |

## F. A REAL payment message

The section that matters. Requires someone to actually send money to the connected
account.

| # | Step | Action | Expected | Result |
| --- | --- | --- | --- | --- |
| F1 | Make a real payment | Send 50 BDT to the connected number from another phone | Provider SMS arrives | NOT TESTED |
| F2 | Receiver fires | `adb logcat -s SellflowSms:V` | A candidate is queued | NOT TESTED |
| F3 | Provider identified | Status / parser check | Correct provider | NOT TESTED |
| F4 | Fields parsed | Parser check panel | Correct amount, reference, payer | NOT TESTED |
| F5 | **Balance not read as amount** | Parser check on the real message | Transfer, not balance | NOT TESTED |
| F6 | Timestamp | Parser check | Present, or honestly absent | NOT TESTED |
| F7 | Normalised event created | Event appears in Payments → Review or activity | Present | NOT TESTED |
| F8 | Reaches the backend | Event has a `payment_events` row | Yes | NOT TESTED |
| F9 | Fingerprint stored | Inspect the row | 64-hex hash, no message text | NOT TESTED |
| F10 | `detected_by` recorded | Inspect the row | `android:<rel>:sms:<ver>:p<n>` | NOT TESTED |
| F11 | Matching ran | Inspect `payment_matches` | A candidate exists | NOT TESTED |
| F12 | Settlement boundary called | Inspect `payments` | One row, `client_ref` = event id | NOT TESTED |
| F13 | Order becomes paid | Open the order | `payment_status` = paid | NOT TESTED |
| F14 | Finance reconciles | Finance screen | The amount appears | NOT TESTED |
| F15 | UI reflects backend truth | Status screen | *Confirmed*, from the engine's verdict | NOT TESTED |

### Record the captured message

Copy the **real** provider message into
`modules/sellflow-sms/android/src/test/resources/fixtures/payment-sms.json` with
`"captured": true` and a note naming the operator and handset, then re-run A10.

**Until this is done for a provider, that provider's parser is "representative
fixture tested" and nothing more.** Do not describe it as verified.

## G. Duplicate and replay

| # | Step | Action | Expected | Result |
| --- | --- | --- | --- | --- |
| G1 | Redeliver the message | Re-send the identical SMS, or `adb shell am broadcast` the intent | One event only | NOT TESTED |
| G2 | Reparse | Parser check on the same text, then ingest | `duplicate: true` | NOT TESTED |
| G3 | Queue dedupe | Force a redelivery while queued | One queued row | NOT TESTED |
| G4 | One ledger row | Inspect `payments` | Exactly one | NOT TESTED |
| G5 | Ten flushes, one payment | Trigger many passes | One `payment_events`, one `payments` | NOT TESTED |
| G6 | Replayed with a new fingerprint | Same TrxID, different hash | Still a duplicate | NOT TESTED |

## H. Negative cases

| # | Step | Action | Expected | Result |
| --- | --- | --- | --- | --- |
| H1 | Underpayment | Intent 1,000, send 400 | Review, order unpaid | NOT TESTED |
| H2 | Overpayment | Intent 500, send 1,000 | Review, not silent settlement | NOT TESTED |
| H3 | Wrong receiving account | Message naming an unconnected number | `account_mismatch`, review | NOT TESTED |
| H4 | Unknown customer | Payment with no payer number | Review, `medium` | NOT TESTED |
| H5 | No sender invented | Walk-in payment | `sender_account` is null | NOT TESTED |
| H6 | Two orders, same amount | Two intents for 500, send 500 | `ambiguous_candidates`, review | NOT TESTED |
| H7 | Expired intent | Wait out the window, then pay | No settlement, review | NOT TESTED |
| H8 | Disconnected account | Switch the account off, then pay | Refused or review | NOT TESTED |
| H9 | Seller's manual entry | Record by hand | Works, same boundary | NOT TESTED |

## I. Offline, retry, background

| # | Step | Action | Expected | Result |
| --- | --- | --- | --- | --- |
| I1 | Airplane mode | Enable, receive a payment | Detected, shown as queued | NOT TESTED |
| I2 | No attempt burned | Inspect the queue | 0 attempts consumed | NOT TESTED |
| I3 | Restore the network | Disable airplane mode | Sent within ~30 s | NOT TESTED |
| I4 | Sent once | Inspect the backend | One event | NOT TESTED |
| I5 | App killed | `adb shell am force-stop com.sellflow.app`, receive a payment | Candidate queued natively | NOT TESTED |
| I6 | App closed, then opened | Open the app | Delivered | NOT TESTED |
| I7 | Device reboot | `adb reboot`, wait, open the app | Queue intact | NOT TESTED |
| I8 | Many offline payments | Ten payments while offline | All queued, all delivered once | NOT TESTED |
| I9 | Server down | Stop the backend, pay | Retried, then delivered | NOT TESTED |
| I10 | Session expired | Sign out, receive a payment | Queue pauses, says *Sign in to send* | NOT TESTED |
| I11 | Permanent refusal | A malformed message | Stops retrying, shown as needing attention | NOT TESTED |

## J. Privacy

The rows that must hold, with a way to check each one rather than a promise.

| # | Step | Command / action | Expected | Result |
| --- | --- | --- | --- | --- |
| J1 | No inbox access | `adb shell dumpsys package com.sellflow.app \| grep -c READ_SMS` | `0` | NOT TESTED |
| J2 | Not the default SMS app | Settings → default SMS app is not SellFlow | Unchanged | NOT TESTED |
| J3 | **No message text in logs** | `adb logcat -d \| grep -i "Tk\|received Tk\|TrxID:"` after a payment | **No match** | NOT TESTED |
| J4 | No message text on disk | `adb shell run-as com.sellflow.app ls -R files shared_prefs` | No message content | NOT TESTED |
| J5 | No message text in storage | Inspect AsyncStorage via the dev menu | Structured fields only | NOT TESTED |
| J6 | No message text on the wire | Proxy or server log of `ingest_payment_event` | 11 fields, no text | NOT TESTED |
| J7 | Nothing to a third party | Capture all traffic during a payment | Only the seller's own Supabase host | NOT TESTED |
| J8 | Hash only | Inspect `payment_events.fingerprint` | 64 hex characters | NOT TESTED |
| J9 | Unrelated messages leave nothing | Send five unrelated SMS | No rows, no counts, no logs | NOT TESTED |
| J10 | A passcode is not a payment | Receive an OTP | No event | NOT TESTED |
| J11 | Diagnostics stores nothing | Paste a message in the parser check | Nothing persisted | NOT TESTED |

> J3 is the single most important row here. A single line of message text in
> `logcat` invalidates every claim in `docs/privacy-sms.md`. If it fails, that is a
> release blocker, not a bug to note.

## K. Security — a hostile device

| # | Step | Action | Expected | Result |
| --- | --- | --- | --- | --- |
| K1 | Replay a captured request | Replay an `ingest_payment_event` body | `duplicate: true` | NOT TESTED |
| K2 | Forge an account id | Substitute another business's account id | `payment_account_not_found` | NOT TESTED |
| K3 | Forge a tenant | Add `org_id` / `store_id` to the body | Ignored; no effect | NOT TESTED |
| K4 | Forge an order or intent | Add `order_id` / `intent_id` | Ignored; no effect | NOT TESTED |
| K5 | Forge an amount | Any amount | Server validates; mismatches never settle | NOT TESTED |
| K6 | Forge a reference | Any reference | Must be ≥ 4 chars; duplicates refused | NOT TESTED |
| K7 | Forge a status | Add `payment_status: paid` | Ignored; no column for it | NOT TESTED |
| K8 | Call `record_payment` directly | From the client | Not reachable | NOT TESTED |
| K9 | Call settlement directly | From the client | Not granted to any client role | NOT TESTED |
| K10 | Read-only staff | Sign in as staff, connect an account, detect a payment | Refused | NOT TESTED |
| K11 | Anonymous | Call ingest without a session | Refused | NOT TESTED |
| K12 | No key in the APK | `unzip -p app-release.apk \| grep service_role` | No match | NOT TESTED |

## L. Per-provider real-message check

One row per provider. **Run this before release.** A provider without a captured
message is unverified, and saying so is required.

| Provider | Captured message added to the corpus | Parser accepts it | Fields correct | Re-run A10 |
| --- | --- | --- | --- | --- |
| bKash | NOT DONE | NOT TESTED | NOT TESTED | NOT TESTED |
| Nagad | NOT DONE | NOT TESTED | NOT TESTED | NOT TESTED |
| Rocket | NOT DONE | NOT TESTED | NOT TESTED | NOT TESTED |
| Upay | NOT DONE | NOT TESTED | NOT TESTED | NOT TESTED |

## M. Cross-platform regression

| # | Step | Command / action | Expected | Result |
| --- | --- | --- | --- | --- |
| M1 | iOS config unaffected | `npx expo prebuild --platform ios` | No SMS entries in `Info.plist` | NOT TESTED |
| M2 | Web still runs | `npm run dev:web` | Loads; detection reports unsupported | NOT TESTED |
| M3 | Expo config valid | `npx expo config --type prebuild` | Resolves, no warnings | NOT TESTED |
| M4 | expo-doctor | `npx expo-doctor` | No issues | NOT TESTED |

---

## Findings

| # | Section | What happened | Severity | Follow-up |
| --- | --- | --- | --- | --- |
| | | | | |

## Sign-off

Automatic payment detection may be announced as available when:

1. Sections A–K pass on real hardware against a real provider message.
2. **Every provider in section L has a captured message in the fixture corpus**, or
   the report states in plain words which providers are unverified.
3. Section J shows no message text in logs, storage, or on the wire.

Until then the correct description of this feature is: *implemented and verified
locally; real-device verification pending.*

| | Name | Date |
| --- | --- | --- |
| Implemented by | | |
| Device QA by | | |
| Release approved by | | |