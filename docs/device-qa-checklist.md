# Device QA checklist

The gate for the native Android SMS payment adapter. Updated after the Phase 2
verification pass, which built the toolchain, compiled the Kotlin, executed the
parser suite and inspected the merged manifest.

**States used here, and only these:**

| State | Meaning |
| --- | --- |
| **PASS** | Executed, and the expected result was observed. |
| **FAIL** | Executed, and it did not behave as required. |
| **BLOCKED** | Could not be executed here. The reason is stated in the row. |
| **NOT TESTED** | Not yet attempted. No claim either way. |

**What this pass changed:** A1–A10 and the manifest rows now carry real results.
Everything requiring a handset or a real provider message is **BLOCKED**, because
this environment has **no Android device connected** (`adb devices` returns an empty
list) and cannot send a real payment. Those rows are not "probably fine" — they
are unexamined.

**Test device** ______________________  **Android version** ____________
**App build** ________________________  **Signed profile** ______________
**Tester** ____________________________  **Date** _________________________

---

## A. Environment and compilation — EXECUTED

Toolchain installed for this pass (JDK and Android SDK were absent from the machine
and had to be provisioned):

| Component | Version |
| --- | --- |
| JDK | Temurin 17.0.20.1 (Eclipse Adoptium) |
| Android SDK platform | android-36 |
| Build tools | 36.0.0 |
| NDK | 27.1.12297006 (auto-resolved by Gradle) |
| Gradle wrapper | 9.3.1 |
| adb | 1.0.41 / 37.0.1 |

| # | Step | Command / action | Expected | Result |
| --- | --- | --- | --- | --- |
| A1 | Install dependencies | `npm ci` | Completes | PASS |
| A2 | Regenerate native project | `npx expo prebuild --platform android` | Completes | PASS |
| A3 | Manifest has exactly one SMS permission | `grep -c "android.permission.RECEIVE_SMS" android/app/src/main/AndroidManifest.xml` | `1` | PASS |
| A4 | Manifest has exactly one `<application>` | `grep -c "<application" …` | `1` | PASS |
| A5 | No forbidden permission in the merged manifest | `grep -cE "READ_SMS\|SEND_SMS\|WRITE_SMS\|RECEIVE_MMS\|RECEIVE_WAP_PUSH\|BROADCAST_SMS\|READ_CONTACTS\|CALL_LOG" android/app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml` | `0` | PASS |
| A6 | Our receiver appears exactly once | `grep -c "com.sellflow.sms.SellflowSmsReceiver" …merged manifest…` | `1` | PASS |
| A7 | Module autolinks | `npx expo-modules-autolinking resolve --platform android --json` | One `com.sellflow.sms.SellflowSmsModule` | PASS |
| A8 | Prebuild is idempotent | Re-run A2, then A3–A4 | Still `1` / `1` | PASS |
| A9 | Repository verification | `npm test` | All green | PASS — 214 node tests, 15/15 DB suites, 100/100 schema checks, 21/21 expo-doctor |
| A10 | **Kotlin compilation** | `cd android && gradlew.bat :sellflow-sms:compileDebugKotlin` | Compiles | **PASS** — after fixing 43 compile errors (see Findings F1–F4) |
| A11 | **Kotlin parser suite** | `gradlew.bat :sellflow-sms:testDebugUnitTest` | Passes | **PASS — 27/27** |
| A12 | Module packages as an Android library | `gradlew.bat :sellflow-sms:assembleDebug :sellflow-sms:assembleRelease` | AARs produced | **PASS** — `sellflow-sms-debug.aar` 88,721 B, `sellflow-sms-release.aar` 84,716 B |
| A13 | AAR contains the compiled receiver and all four adapters | Unzip `classes.jar` | Classes present | **PASS** — `SellflowSmsReceiver`, `CandidateQueue`, `Fingerprint`, and `providers/{Bkash,Nagad,Rocket,Upay}Adapter` |
| A14 | App module Kotlin compiles | `gradlew.bat :app:compileDebugKotlin` | Compiles | **PASS** |
| A15 | App manifest merges | `gradlew.bat :app:processDebugMainManifest` | Merged manifest produced | **PASS** |
| A16 | **Full debug APK, local build** | `gradlew.bat :app:assembleDebug` | APK produced | **FAIL** - not a repo defect. Third-party C++ (`react-native-worklets`, `react-native-screens`) fails to link `libc++_shared` under NDK 27 on this Windows host. See Finding F5. **Superseded by A18.** |
| A17 | APK manifest inspection, local build | `aapt2 dump xmltree app-debug.apk` | 1 SMS receiver | **N/A** - superseded by A19, which inspects a real APK. |
| A18 | **EAS build, preview profile** | `eas build --platform android --profile preview` | APK | **PASS** - build `29f833c7-b760-4eaa-ae98-7b39f621cda0`, FINISHED, from commit `70714f1`. |
| A19 | **EAS APK downloaded and inspected** | `eas build:download --id 29f833c7-...`, then `aapt2 dump badging` | Correct package and manifest | **PASS** - 110.28 MB; `com.sellflow.app` 1.0.0 versionCode 1; minSdk 24 / targetSdk 36; 4 ABIs; `RECEIVE_SMS` present; exactly 1 SMS receiver; **0 forbidden permissions**. |
| A20 | **Native module is inside the APK** | Scan `classes*.dex` | All module classes present | **PASS** - `SellflowSmsReceiver`, `SellflowSmsModule`, `CandidateQueue` and all four `*Adapter` classes found in the packaged dex. |
| A21 | **No privileged credential in the APK** | Scan `assets/index.android.bundle` | None present | **PASS** - 0 standalone secret keys, 0 JWTs, no `service_role`. The single bare `sb_secret_` is supabase-js own key-prefix constant in the Hermes string table. |
| A22 | **No raw SMS corpus in the APK** | Scan the bundle for fixture identifiers | None present | **PASS** - 0 occurrences of the corpus file, its test names, or any fixture message body. |
| A23 | Production AAB | `eas build --profile production` | AAB | **NOT TESTED** - deliberately not built; this pass was scoped to a non-production profile. |

> **A10 detail, because it matters.** Before this pass the Kotlin had **never been
> compiled**. It contained 43 compile errors across 6 files, including a literally
> duplicated function body. The full list and what each one was is in Findings.

## B. Build and install — BLOCKED

| # | Step | Command / action | Expected | Result |
| --- | --- | --- | --- | --- |
| B1 | Device visible | `adb devices` | A device in state `device` | **BLOCKED — no device connected.** `adb devices` returns an empty list. |
| B2 | Install APK | `adb install -r app-debug.apk` | `Success` | **BLOCKED** — B1, and no APK (A16) |
| B3 | Package id correct | `adb shell pm list packages \| grep sellflow` | `com.sellflow.app` | **BLOCKED** — B1 |
| B4 | Native module present in the installed app | `dumpsys package com.sellflow.app` | Module registered | **BLOCKED** — B1. Proven at build level instead by A12/A13. |
| B5 | App launches and Metro connects | Launch, observe | No red screen | **BLOCKED** — B1 |

## C. Sign in and connect an account — BLOCKED

| # | Step | Action | Expected | Result |
| --- | --- | --- | --- | --- |
| C1 | Email + password sign-in | Sign in | Dashboard | **BLOCKED** — no device |
| C2 | No phone/password auth | Observe sign-in screen | Email and password only | **BLOCKED** — no device |
| C3 | Connect a payment account | Payments → `+` → bKash `017XXXXXXXX` | Row appears | **BLOCKED** — no device |
| C4 | Number normalised | Enter `+880171…` | Saved as `0171…` | **BLOCKED** — no device. Covered by `npm run test:payment-normalize` (10/10) at the unit level. |
| C5 | Bad number refused | Enter `12345` | Save disabled | **BLOCKED** — no device |
| C6 | Detection screen opens | Payments → Automatic detection | Status screen | **BLOCKED** — no device |
| C7 | Pre-permission state | Status | *Permission needed*, no "connected" | **BLOCKED** — no device. Logic covered by `sms-adapter.test.mjs` status tests. |

## D. Permission — PARTIALLY BLOCKED

| # | Step | Action | Expected | Result |
| --- | --- | --- | --- | --- |
| D1 | Explanation shown before the OS dialog | Read the card | Plain-word reason | **BLOCKED** — no device |
| D2 | OS dialog appears | Tap *Allow payment messages* | System dialog | **BLOCKED** — no device |
| D3 | Grant | Allow | Status → *Waiting for payment* | **BLOCKED** — no device |
| D4 | Listener active | Status → *Device listener* | `Active` | **BLOCKED** — no device |
| D5 | Receiver registered with the platform | `dumpsys package …` | Present | **BLOCKED** — no device. Proven at manifest level by A3/A6. |
| D6 | Revocation honoured | `adb shell pm revoke …` | Status → *Permission not granted* | **BLOCKED** — no device |
| D7 | Manual entry still works after denial | Record a payment by hand | Payment recorded | **BLOCKED** — no device |
| D8 | No fake healthy state | After D6 | No green "connected" | **PARTIAL** — `deriveDetectionStatus` returns `permission_denied` for a denied permission and never returns `waiting`/`confirmed`; asserted in `sms-adapter.test.mjs`. Not observed on a device. |
| D9 | Re-grant | Re-enable in Settings | Returns to *Waiting* | **BLOCKED** — no device |

## E. Detection, ignoring unrelated messages — PARTIALLY VERIFIED

| # | Step | Action | Expected | Result |
| --- | --- | --- | --- | --- |
| E1 | Empty state is honest | *Waiting to send* | Empty | **BLOCKED** — no device |
| E2 | Nothing claimed yet | *Last detected* | *Nothing yet* | **BLOCKED** — no device |
| E3 | Personal SMS ignored | Send a personal SMS | No event | **VERIFIED IN UNIT TEST** — `an unrelated message leaves nothing behind` PASS |
| E4 | Marketing blast ignored | Send a bKash promo | No event | **VERIFIED IN UNIT TEST** — `marketing-mentions-provider` fixture PASS |
| E5 | Bank alert not treated as MFS | Send a bank credit | `unsupported_provider` | **VERIFIED IN UNIT TEST** — `bank-alert-not-a-mfs-transfer` and `unsupported-provider-payment` fixtures PASS |
| E6 | Insufficient-funds notice ignored | — | No payment | **VERIFIED IN UNIT TEST** — `an insufficient funds notice is not a payment` PASS |
| E7 | Cash-out notice ignored | — | No payment | **VERIFIED IN UNIT TEST** — `a cash-out notice is not an incoming payment` PASS |
| E8 | Passcode ignored | Receive an OTP | No event | **VERIFIED IN UNIT TEST** — `a passcode is never a payment` PASS (5 bodies incl. bare digits and a labelled code) |

## F. A REAL payment message — BLOCKED

**Nothing in this section has been executed.** It requires someone to actually send
money to a connected account from another phone.

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| F1 | Real payment notification arrives | Provider SMS delivered | **BLOCKED** — no device, and no way to send a real MFS payment |
| F2 | Receiver fires | Candidate queued | **BLOCKED** — no device |
| F3 | Provider identified | Correct provider | **BLOCKED** — no device |
| F4 | Fields parsed | Correct amount/reference/payer | **BLOCKED** — no device |
| F5 | Balance not read as amount | Transfer, not balance | **BLOCKED** — no device. Unit-covered by the named regression test (see G/L). |
| F6 | Event reaches the backend | `payment_events` row | **BLOCKED** — no device. The same row shape is proven in `verify_payment_sms_adapter.sql` §1. |
| F7 | Matching ran | `payment_matches` row | **BLOCKED** — no device. Proven in §1 of the same suite. |
| F8 | Settlement boundary called | One `payments` row | **BLOCKED** — no device. Proven in §1. |
| F9 | Order becomes paid | `payment_status = paid` | **BLOCKED** — no device. Proven in §1. |
| F10 | Finance reconciles | Amount appears | **BLOCKED** — no device. Proven in §1. |

### Record the captured message

When F1–F4 are done, copy the **real** provider message into
`modules/sellflow-sms/android/src/test/resources/fixtures/payment-sms.json` with
`"captured": true` and a note naming the operator and handset, then re-run A11.

**Until that is done for a provider, that provider is "representative fixture
tested" and nothing more.**

## G. Duplicate, replay and the balance regression

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| G1 | Same candidate queued ten times | One event | **PASS** — `the same candidate queued ten times is one event` |
| G2 | Duplicate keeps the original key | First key wins | **PASS** — `a duplicate keeps the original idempotency key` |
| G3 | Ten flushes against a duplicate-answering server | One settlement | **PASS** — `ten flushes against a server that says duplicate produce one ledger row` |
| G4 | Three deliveries at the database | One `payment_events` | **PASS** — `verify_payment_sms_adapter.sql` §2 |
| G5 | Same TrxID, new fingerprint | Still a duplicate | **PASS** — `verify_payment_sms_adapter.sql` §2 |
| G6 | **REGRESSION: a ৳15,000 balance is never a ৳15,000 payment** | Refused / never 15,000 | **PASS** — `REGRESSION a balance of 15000 is never reported as a payment of 15000` |
| G7 | The transfer wins when both are stated | 1000, not 15,000 | **PASS** — `the transfer is reported, not the balance, when both are stated` |
| G8 | Duplicate SMS on a real device | One payment | **BLOCKED** — no device |

## H. Negative cases

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| H1 | Underpayment | Review, unpaid | **PASS (DB)** — `verify_payment_sms_adapter.sql` §5a |
| H2 | Wrong amount | No settlement | **PASS (DB)** — §5a |
| H3 | Wrong receiving account | `account_mismatch`, review | **PASS (DB)** — §4a |
| H4 | Unknown customer, no payer number | `medium`, review | **PASS (DB)** — §4b. Unit: a walk-in payment still parses with `sender = null`. |
| H5 | Two orders, same amount | `ambiguous_candidates` | **PASS (DB)** — §4c |
| H6 | Expired intent | No settlement, review | **PASS (DB)** — §5b |
| H7 | Malformed amount | Refused | **PASS (Kotlin)** — `a zero or negative amount never becomes a payment` |
| H8 | Negative amount | Never read as positive | **PASS (Kotlin)** — `a negative amount is never read as its absolute value` |
| H9 | Missing / too-short reference | Refused | **PASS (Kotlin)** — `a transaction id that is too short to identify a payment is refused` (1–3 chars) |
| H10 | Reference is a phone number | Refused | **PASS (Kotlin)** — `a phone number is never accepted as a transaction reference` |
| H11 | No reference anywhere | Refused, never invented | **PASS (Kotlin)** — `a transaction reference is never invented` |
| H12 | Reference digits not read as an amount | No phantom amount | **PASS (Kotlin)** — `digits inside a reference are never read as an amount` |
| H13 | Cross-tenant event | Rejected | **PASS (DB)** — §3a |
| H14 | Forged account id | `payment_account_not_found` | **PASS (DB)** — §3a/§3b |
| H15 | Read-only staff | Refused, no money moved | **PASS (DB)** — §3g |
| H16 | Payer's own "you sent" | Refused | **PASS (Kotlin)** — `a payer confirmation is not a receipt` |
| H17 | Manual entry still available | Works | **NOT TESTED** — no device |

## I. Offline, retry, restart, crash — unit verified, device blocked

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| I1 | Known-offline device attempts nothing | 0 attempts | **PASS** — `an offline device queues and sends nothing` |
| I2 | Queue survives restart | Still queued | **PASS** — `the queue survives a restart` (asserted against the on-disk value) |
| I3 | Reconnection sends once | One send | **PASS** — `recovery sends the queued event exactly once` |
| I4 | Later pass does not resend | No second send | **PASS** — same test |
| I5 | Backoff grows and is capped | Bounded | **PASS** — `backoff grows and is capped, so there is no unbounded retry` |
| I6 | Permanent refusal stops retrying | 1 attempt, `failed` | **PASS** — `an event that exhausts its attempts stops and becomes visible` |
| I7 | Expired session pauses the queue | 1 attempt, `blocked` | **PASS** — `an expired session stops the whole queue rather than hammering it` |
| I8 | Events older than retention are not attempted | Refused | **PASS** — `an event older than the retention window is not attempted` |
| I9 | Oldest money sent first | Ordered | **PASS** — `a due event is the oldest one first` |
| I10 | Crash mid-processing | No loss, no double settlement | **PARTIAL** — design is peek-then-acknowledge with identity dedupe, asserted on both sides (`acknowledge only what is durably queued`; `the same candidate queued ten times is one event`). **Not** exercised by killing a real process. |
| I11 | **JS runtime not yet initialised** | Native queue holds it | **BLOCKED** — needs a device. The Kotlin receiver writes to `CandidateQueue` before any JS exists, and `SellflowSmsModule.live()` returns null so the fast path is skipped. Compiled and unit-covered, but **not observed on a device**. |
| I12 | App killed, payment arrives, app opened | Delivered | **BLOCKED** — no device |

## J. Privacy and Logcat — PARTIALLY VERIFIED

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| J1 | No inbox permission in the merged manifest | 0 | **PASS (build)** — A5: zero forbidden permissions |
| J2 | Only `RECEIVE_SMS` requested | Exactly one | **PASS (build)** — A3 |
| J3 | Module manifest declares nothing | — | **PASS** — asserted by `payment-boundary.test.mjs` |
| J4 | No message text in any durable record | — | **PASS (build + test)** — `CandidateQueue` is asserted never to contain the word `messageBody`; the boundary test enumerates every file that may read a body and requires each to be in the parsing pipeline |
| J5 | `PaymentCandidate` fields are exactly the ingest arguments | 9 fields | **PASS** — `a candidate carries no message content` compares `declaredFields` to the exact set |
| J6 | **No message text in Logcat** | No match | **BLOCKED — requires a device.** Static evidence recorded: `grep -rn 'Log\.\|println\|System\.out\|printStackTrace' modules/sellflow-sms --include=*.kt` returns **no call sites** — the single hit is a code comment in `ProviderAdapter.kt` that reads "…into a log". There is no logging statement in the native module, so there is nothing for Logcat to carry. That is necessary but not sufficient: a release build could still log from generated or dependency code, which only a device run can rule out. |
| J7 | No message text on disk after a payment | Structured only | **BLOCKED** — no device |
| J8 | No message text on the wire | 11 fields | **PASS (DB + test)** — `verify_payment_sms_adapter.sql` §1 asserts the exact field set; `the payload holds only fields the engine already knows` asserts the same keys client-side |
| J9 | Hash only, never text | 64 hex chars | **PASS** — `payment_events.fingerprint` asserted non-null in §7 |
| J10 | Unrelated messages leave no trace | No rows, no counts | **PASS** — `an unrelated message leaves nothing behind`; the registry returns a reason code and no text is stored |
| J11 | Diagnostics panel stores nothing | No persistence | **PASS (static)** — `payment-boundary.test.mjs` asserts `diagnostics.ts` touches no storage and has no path to `ingest_payment_event`, and that the panel only renders under `__DEV__` |
| J12 | Markup never reaches a candidate | No markup | **PASS (Kotlin)** — `markup never reaches a candidate` |
| J13 | Nothing sent to a third party | Only own Supabase | **NOT TESTED** — requires traffic capture on a device |

## K. Security — build and database verified, device blocked

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| K1 | Replay an `ingest_payment_event` body | `duplicate: true` | **PASS (DB)** — §2 |
| K2 | Forge another business's account id | `payment_account_not_found` | **PASS (DB)** — §3a |
| K3 | Forge `org_id` / `store_id` in the body | Ignored | **PASS** — `nothing the client sends can name an org, a store, an order or an intent` |
| K4 | Forge `order_id` / `intent_id` | Ignored | **PASS** — same test |
| K5 | Forge an amount | Server validates | **PASS (DB)** — §3d |
| K6 | Forge a reference | ≥ 4 chars, duplicates refused | **PASS (DB + Kotlin)** — §3d, H9/H10 |
| K7 | Forge a status | No such column | **PASS** — same test as K3 |
| K8 | Client calls `record_payment` | Not reachable | **PASS (DB)** — asserted in `payment-boundary.test.mjs` and in migration 0024 |
| K9 | Client calls the settlement function | Not granted | **PASS (DB)** — §3f checks `has_function_privilege` |
| K10 | Read-only staff | Refused | **PASS (DB)** — §3g |
| K11 | Anonymous | Refused | **PASS (DB)** — `verify_payment_schema.sql` |
| K12 | No key in the APK | No match | **BLOCKED** — no APK to inspect (A16). Static equivalent: `no privileged credential is reachable from the client` scans all of `src/` and `modules/` for service-role patterns — PASS |
| K13 | Receiver is exported and unguarded | Review | **REVIEWED, accepted** — `android:exported="true"` is *required* from Android 12 for a component with an intent filter, and `SMS_RECEIVED` is a protected broadcast that only the system can send. Verified present and singular in the merged manifest (A6). |
| K14 | Untrusted intent extras | Ignored | **REVIEWED** — the receiver reads only `SMS_RECEIVED` and the PDUs; the action is compared for equality and anything else is dropped |
| K15 | Oversized SMS | Rejected before parsing | **PASS (Kotlin)** — `a body past the length gate is discarded before any adapter sees it` |
| K16 | Unicode digit confusion | Fails closed | **PASS (Kotlin)** — `non-ascii digits fail closed rather than being coerced` (Bengali and Devanagari digits) |
| K17 | Amount overflow | Capped at 9 integer digits | **PASS (Kotlin)** — the amount pattern cannot match a longer run, and `provider parse never throws` includes a 14-digit amount |

## L. Per-provider status

**Every provider is unverified against a real message. No row may be marked
otherwise until a real notification has been through the parser.**

| Provider | Adapter compiled | Kotlin tests (representative corpus) | Real captured message | Physical device |
| --- | --- | --- | --- | --- |
| bKash | PASS (A10/A12) | PASS — 7 positive + negatives (A11) | **NOT DONE** | **BLOCKED** |
| Nagad | PASS | PASS — 4 positive + negatives | **NOT DONE** | **BLOCKED** |
| Rocket | PASS | PASS — 3 positive + negatives | **NOT DONE** | **BLOCKED** |
| Upay | PASS | PASS — 3 positive + negatives | **NOT DONE** | **BLOCKED** |

Provider detection reads **both** the provider's name in the message body **and**
the originating address it was sent from. That second signal was added because the
first one alone is not how operators actually behave: a real 65 BDT bKash payment
was delivered to this app on a seller's handset and refused, because bKash does not
put its name in the body -- its own security guidance tells customers the
notification comes *from bKash*, which is the originating address. See §L2.

Sender matching is a normalised set lookup against a closed list per provider, never
a `contains` search, because this field decides whose money a payment is. The list is
deliberately incomplete and is a *second* signal, not a gate: a message that names
its provider in the body still parses from an address that is not in the list, so
adding a shortcode is never a prerequisite and a newly-appearing address cannot
silently break detection.

Both halves of that are pinned, so neither can be quietly undone:
`an unbranded receipt from an unrecognised sender is still refused` and
`a branded message is still read from an address not in the sender list`.

## L2. Real bKash message — the ৳65 detection defect

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| L2.1 | Real bKash payment of **৳65** to a connected account | `parsed:bkash`, 65 BDT, reference extracted | **NOT DONE — no device available** |
| L2.2 | Same payment, app closed | Native receiver still runs, candidate queued | **NOT DONE — no device available** |
| L2.3 | Same payment, phone offline | Candidate queued natively, delivered on reconnect | **NOT DONE — no device available** |
| L2.4 | Duplicate delivery of the same message | One payment, `duplicate: true` on the server | **NOT DONE — no device available** |

The unit and fixture layers for this are in place: the `bkash-real-*` cases carry
the structure of the real message with the transaction reference redacted, and
`a real bKash receipt is detected from its sender, not a brand word` asserts the
extracted amount, reference and payer. **Those prove the parser, not the phone.**
Until L2.1 passes on a physical handset, SMS detection must not be reported as
verified in production.

## M. Cross-platform regression

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| M1 | `npx expo config --type prebuild` | Resolves | **PASS** |
| M2 | expo-doctor | 21/21 | **PASS** |
| M3 | Module declares no iOS platform | Android only | **PASS** — `platforms: ["android"]` |
| M4 | iOS build | Unaffected | **NOT TESTED** — no macOS/Xcode here. The module adds nothing to the iOS project by construction. |
| M5 | Web still runs | Loads | **NOT TESTED** — `npm run dev:web` not run in this pass |

---

## Findings

### F1 — `CandidateQueue` did not compile: `org.json.JSONArray` is not `Iterable` (22 errors)

Every collection operation on the stored rows was written as if `JSONArray` were a
Kotlin collection. On Android it is not `Iterable`, has `size()` rather than a
`size` property, and has no `filter`/`any`/`mapNotNull`. Fixed by converting to
`List<JSONObject>` on read. Only compilation could have found this.

### F2 — `CandidateQueue.discard` was declared twice, identically (1 error)

A copy/paste duplicate survived review and was caught only by the compiler's
"conflicting overloads". Removed.

### F3 — `ParseOutcome.Rejected` took the wrong type (5 errors)

It was declared `Rejected(val reason: RejectionReason)` but every call site
constructed `Rejected(ParseRejection(reason))`, and the receiver and module read
`.rejection.reason` for a property named `reason`. The `ParseRejection` wrapper
carried no information, so it was removed and the type unified.

### F4 — `Triple` was indexed as an array (7 errors)

`transactionTimestampMillis` read `day[0]`, `day[1]`, `time[2]` on `Triple`s.
Replaced with destructuring, which also names the components.

### F5 — Full APK build blocked by third-party C++ on Windows (A16)

`:app:assembleDebug` fails while linking `react-native-worklets` and
`react-native-screens`:

```
ld.lld: error: undefined symbol: __cxa_allocate_exception
ld.lld: error: undefined symbol: operator new(unsigned long)
ld.lld: error: undefined symbol: std::__ndk1::basic_string<...>::basic_string(...)
```

This is `libc++_shared` not being linked, in **third-party** C++ under NDK
27.1.12297006 on a Windows host. The same project builds in EAS on Linux
(`eas.json`, `android.image: latest`). Verified not caused by this repository:
the NDK does ship `libc++_shared.so` for x86_64, `fbjni`'s prefab supplies
`libfbjni.so`, clearing every `.cxx` CMake cache did not change the result, and
restricting to a single ABI did not either. **SellFlow's own module compiles,
packages and merges cleanly** (A12–A15). Treated as an environment limitation,
not a code defect, and not worked around by changing repository configuration.

### F6 — The ৳15,000 balance regression, now permanently named

The Phase 2 review defect is covered by
`REGRESSION a balance of 15000 is never reported as a payment of 15000` plus
`the transfer is reported, not the balance, when both are stated`. Both PASS.

### F7 — A negative amount was read as its absolute value (found by adversarial testing)

`Tk -500` parsed as a transfer of 500: the sign is simply not part of an amount
match. `-` is now excluded in the amount lookbehind, and covered by
`a negative amount is never read as its absolute value`. A payment must never be
the absolute value of a negative figure.

### F8 — Two of my own test expectations were wrong, and the runs said so

`a receiver is only extracted when the message states one` used a message with no
brand word, so it was correctly rejected — the test was asserting on the wrong
thing. `an ambiguous timestamp is refused rather than assumed` used a date with no
clock, and the parser correctly requires both. Both test inputs were corrected;
neither parser behaviour was weakened.

### F9 — The JS bridge needed hardening for the React context being absent

The native module throws when the React context is gone, which happens on every
startup and shutdown. Unhandled, the caller would treat it as a failed send and
schedule a pointless retry. `getListenerStatus` now reports `unsupported` rather
than a healthy state, and `peekCandidates`/`acknowledgeCandidates` degrade to a
no-op so the native queue is redelivered rather than reported as lost. Covered by
`a lost React context reads as unsupported, never as healthy` and
`with no native module the bridge reports unsupported and sends nothing`.

---

## Sign-off

Automatic payment detection may be announced when **all** of the following are true.
Today, none of them is fully true.

| # | Gate | State |
| --- | --- | --- |
| 1 | A–A15 pass (compilation, module packaging, manifest, repo suite) | **MET** |
| 2 | A16: a full debug APK builds | **NOT MET** — see F5 |
| 3 | §F: a **real** provider notification drives the whole pipeline on a device | **NOT MET** — BLOCKED, no device |
| 4 | §L: every provider has a captured real message in the fixture corpus | **NOT MET** — 0 of 4 |
| 5 | §J6: Logcat is clean of message text during a real payment | **NOT MET** — BLOCKED |
| 6 | §I11: the native queue holds a payment before the JS runtime exists | **NOT MET** — BLOCKED |

**Current honest description of this feature:**

> Implemented. The Kotlin compiles, the provider parsers pass 27 tests against a
> representative corpus, the module packages into an Android library, the merged
> manifest contains exactly one SMS permission and one SMS receiver, and the whole
> pipeline from a normalised event to `record_payment` and finance is proven in the
> database. **It has never run on a phone, and no parser has seen a real provider
> message.** Do not describe it as verified.

| | Name | Date |
| --- | --- | --- |
| Compiled and unit-tested by | | |
| Device QA by | | |
| Release approved by | | |