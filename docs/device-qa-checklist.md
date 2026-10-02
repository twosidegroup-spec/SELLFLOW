# SellFlow V1 — Physical Device QA Checklist

Reproducible manual test plan for a human holding a real Android phone (and
optionally an iPhone). **Nothing in this document has been executed yet** — no
device, emulator, or Android SDK is available in the build environment, so every
row below starts as `NOT TESTED`.

Mark each row `PASS` / `FAIL` / `BLOCKED` and record the failure under
**Findings**. Do not mark a row `PASS` from reading the code.

---

## 0. Prerequisites

| Item | Value |
|---|---|
| Android application ID | `com.sellflow.app` |
| iOS bundle identifier | `com.sellflow.app` |
| Deep link scheme | `sellflow://` |
| Minimum Android | API 24 (Android 7.0) |
| Minimum iOS | 16.4 |

Environment required before the app is useful:

- A Supabase project with all 14 migrations applied
  (`npx supabase db push`).
- `.env` holding `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
  The anon key is the only credential the app ever receives.

### Installing a build

```bash
npm install
npx eas login                       # once per tester
npx eas build --profile preview --platform android
# upload the returned .apk, or:
npx eas build --profile preview --platform android --local   # no cloud build
```

`preview` produces an **APK**, which installs by enabling "install unknown apps"
on the handset. No store review is involved. For a build that talks to the
Metro dev server instead, use `--profile development` and run
`npx expo start --dev-client`.

For iOS, the build and the install both require macOS with Xcode, plus a
developer account to sign the app. **Not possible from Windows.**

---

## A. Installation and lifecycle

| # | Check | Result |
|---|---|---|
| A1 | Installs on the device | |
| A2 | App icon and name render correctly | |
| A3 | First launch shows the splash, then sign-in | |
| A4 | Launch with no network shows a clear message, not a blank screen or a crash | |
| A5 | Launch with network reaches the dashboard | |
| A6 | Background then foreground restores the previous screen | |
| A7 | Force-quit and relaunch keeps the user signed in | |
| A8 | Force-quit and relaunch with no `.env` shows "SellFlow is not connected" | |

## B. Authentication and session

| # | Check | Result |
|---|---|---|
| B1 | Sign up with a new email creates a business | |
| B2 | Sign in with a wrong password shows "Incorrect email or password", not a raw error | |
| B3 | Sign out returns to sign-in and clears the session | |
| B4 | Session persists across a restart | |
| B5 | After the token expires, the app prompts to sign in rather than showing a broken dashboard | |
| B6 | "Forgot password" sends a real email | |
| B7 | Onboarding appears exactly once for a new account | |

## C. Navigation

| # | Check | Result |
|---|---|---|
| C1 | All five tabs reachable: Home, Orders, Products, Customers, More | |
| C2 | Analytics and Finance reachable from More | |
| C3 | Notifications reachable from the Home header | |
| C4 | Android **back gesture** pops one screen, then leaves the app from a tab root | |
| C5 | Android **back button** behaves identically to the gesture | |
| C6 | Back from a modal/sheet dismisses the sheet, not the screen beneath | |
| C7 | Content is not hidden under the status bar or gesture bar (safe areas) | |
| C8 | Bottom navigation is fully visible and not overlapped by content | |
| C9 | Screen transitions animate smoothly and are interruptible | |

## D. Keyboard and forms

Repeat for: sign-up, sign-in, onboarding, product form, customer form, new order,
expense form, business settings, account settings.

| # | Check | Result |
|---|---|---|
| D1 | No field is covered by the keyboard | |
| D2 | The submit button stays reachable with the keyboard open | |
| D3 | Scrolling while the keyboard is open reveals the focused field | |
| D4 | Focus advances predictably between fields | |
| D5 | Keyboard dismisses on scroll and on tap outside | |
| D6 | Validation messages stay visible with the keyboard open | |
| D7 | Numeric fields open a numeric keypad; phone fields a phone keypad | |
| D8 | Bangla text renders (no tofu boxes) | |
| D9 | Mixed Bangla/English renders | |

## E. Products

| # | Check | Result |
|---|---|---|
| E1 | Create a product with only a name | |
| E2 | Selling price and cost price accept decimals | |
| E3 | Margin is shown and updates as prices change | |
| E4 | Opening stock is recorded and the movement appears in history | |
| E5 | Available / reserved / sold are three different numbers | |
| E6 | Low-stock threshold produces a warning at or below the level | |
| E7 | Archive hides the product from pickers but keeps past orders intact | |
| E8 | Search finds by both name and SKU | |
| E9 | Currency renders as `Tk` with two decimals and thousands separators | |

## F. Customers

| # | Check | Result |
|---|---|---|
| F1 | Create a customer with only a name | |
| F2 | Create a second customer with the **same phone** → the duplicate panel appears before saving | |
| F3 | Same name, different phone → shown as a candidate, not merged | |
| F4 | Tapping a candidate opens that customer instead of creating a duplicate | |
| F5 | "This is a different person" is required before saving, then saves | |
| F6 | Customer profile shows order history and totals | |
| F7 | A 120-character name does not break the row or the screen | |
| F8 | A long Bangla address is readable or clearly truncated | |

## G. Orders

Create one order and walk it through the whole lifecycle.

| # | Check | Result |
|---|---|---|
| G1 | Create an order with a customer, items, quantity, delivery fee | |
| G2 | Live summary shows the correct payable amount throughout | |
| G3 | Stock is deducted on creation | |
| G4 | `pending → confirmed → processing → packaging → packed → shipped → on delivery → delivered` all succeed | |
| G5 | An illegal jump (e.g. `pending → delivered`) is not offered | |
| G6 | Cancelling restores stock exactly once | |
| G7 | Delivery failure does **not** restock | |
| G8 | Return **does** restock | |
| G9 | Timeline shows one entry per real move, not per tap | |
| G10 | Tapping "Change status" repeatedly does not duplicate timeline entries | |
| G11 | Order of 2000 units is refused when stock is lower | |

## H. Payments

| # | Check | Result |
|---|---|---|
| H1 | Partial payment, then the balance | |
| H2 | Payment larger than the balance is refused | |
| H3 | Rapid double-tap on "Record payment" records once | |
| H4 | Simulate a network failure mid-payment, then retry → records once | |
| H5 | Same key + same amount → one payment | |
| H6 | Same key + **different** amount → explicit "That payment was already recorded", original untouched | |
| H7 | Refund retries record once | |
| H8 | Refund larger than the payment is refused |

## I. Offline

| # | Check | Result |
|---|---|---|
| I1 | Enable airplane mode; the banner appears | |
| I2 | Create an order offline → queued, and **not** reported as saved | |
| I3 | A stock adjustment offline is **refused** with a clear message, not queued | |
| I4 | A payment offline is **refused**, not queued | |
| I5 | Force-quit the app, reopen offline → the queued order is still listed | |
| I6 | Disable airplane mode → the queue drains automatically, oldest first | |
| I7 | Settings → Data shows the replay result and the last sync time | |
| I8 | Disconnect mid-replay, then reconnect → resumes without duplicating | |
| I9 | Dashboard figures are unchanged until the queue actually drains | |

## J. Couriers

### Pathao (requires credentials)

**Stop at the authentication boundary if no credentials are configured.**

| # | Check | Result |
|---|---|---|
| J1 | Credentials authenticate against the Pathao sandbox | |
| J2 | One real shipment is created and a consignment ID is returned | |
| J3 | The consignment ID and tracking link are stored against the order | |
| J4 | The order timeline reflects the courier's status | |
| J5 | A webhook updates the order end to end | |
| J6 | Rapid double-tap on "Send to courier" creates exactly one parcel | |
| J7 | A timeout shows an uncertain state and never claims "Shipment Created" | |
| J8 | A courier rejection is reported in plain language | |

### REDX / manual fallback

| # | Check | Result |
|---|---|---|
| J9 | Manual entry records courier, tracking ID and tracking link | |
| J10 | "Current status" can be set at creation and changed later | |
| J11 | A status change appears in the timeline, attributed to the seller | |
| J12 | Repeating a status does not duplicate the timeline | |
| J13 | Delivery/return states are recorded and restock correctly | |
| J14 | Tracking ID, tracking link and the customer message can be copied | |
| J15 | Dispatch is blocked before packing | |
| J16 | Dispatch is blocked with no delivery address | |

## K. Rapid-tap protection

Tap each of these as fast as the phone allows, 20 times each:

| # | Action | Expected duplicates | Result |
|---|---|---|---|
| K1 | Create order | 0 | |
| K2 | Save customer | 0 | |
| K3 | Save product | 0 | |
| K4 | Record payment | 0 | |
| K5 | Record refund | 0 | |
| K6 | Send to courier | 0 parcels | |
| K7 | Cancel order | 0 extra restocks | |

## L. Appearance

| # | Check | Result |
|---|---|---|
| L1 | Light mode: text and icons are readable everywhere | |
| L2 | Dark mode: no unreadable white-on-light text, no invisible controls | |
| L3 | System theme switching updates the app live | |
| L4 | Buttons show a disabled state while a request is in flight | |
| L5 | Loading skeletons do not jump into content | |
| L6 | Empty states explain what to do next | |
| L7 | Error states say what happened and what to do | |

---

## Findings

Record every `FAIL` here. A row that fails is a release blocker, not a note.

| # | Severity | Summary | Status |
|---|---|---|---|
| | | | |

---

## Sign-off

- [ ] All sections attempted
- [ ] All `FAIL` rows have a fix or an accepted risk
- [ ] Pathao section completed **or** explicitly marked blocked on credentials
- [ ] Findings reviewed by a second person
