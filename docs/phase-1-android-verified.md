# Phase 1 gate: Android verified on BlueStacks API 25

**Status:** PASS. The blank-APK defect is fixed and proven on a real device.

## The device that proves it

BlueStacks `Nougat32`, adb `127.0.0.1:5555`.

| | |
| --- | --- |
| Android | **7.1.1 / API 25** |
| ABI | x86 |
| Display | 1600x900 @ 240dpi |

API 25 is the whole point. `java.time` arrived in API 26, so this is the exact
environment in which the shipped 1.1.1 APK would have thrown
`NoClassDefFoundError: Ljava/time/Duration;` and rendered every data-backed
screen empty with no red box.

## The build

EAS build `02db9972-2419-4912-af69-ab335fe7678e`, profile `preview`,
branch `rebuild/v2-zero-based`.

- SHA-256 `08ABB73DFFB28D1C96904B8BA11C03BEF1EC0FC05C1853C458C4CB2593900399`
- 114,872,823 bytes
- EAS project `abd99efa-4a22-46c5-a1e0-ecfa5f06918d`, keystore `Build Credentials fqFURqO7gl`
- Supabase env resolved from the EAS `preview` environment (verified present
  before building, so the APK cannot ship without a backend)

## Proof it is not the old APK

`expo prebuild --platform android --clean` regenerated the project, and the
generated `android/app/build.gradle` now contains:

```
coreLibraryDesugaringEnabled true
coreLibraryDesugaring "com.android.tools:desugar_jdk_libs:2.1.5"
versionCode 2
versionName "1.1.1"
```

Previously the tree on this machine held `versionCode 1` / `"1.0.0"` and no
desugaring block at all. `node plugins/verify-desugaring.mjs` passes 13/13.

## Runtime evidence from logcat

Cold launch, logcat cleared immediately before:

```
I ExpoModulesCore: ✅ AppContext was initialized
I ReactNativeJS: Running "main"
I ReactNative: [GESTURE HANDLER] Initialize gesture handler for root view ...
I ActivityManager: Displayed com.sellflow.app/.MainActivity: +1s179ms
```

Searched the full logcat for `NoClassDefFound`, `java/time`, `VerifyError`,
`FATAL EXCEPTION` and `AndroidRuntime` crashes: **no application errors**. The only
`NoClassDefFound` line is from `io.github.lukmccall.pika` inside a reused class
loader in the emulator's own process, not from SellFlow.

Cold start: **1.18 seconds** on an API 25 emulator.

## What is on screen

The Welcome screen renders with the V2 design system applied: Inter at the display
and subtitle sizes, the indigo brand tile, the amber-on-nothing rule (no money on
this screen), 4pt-grid spacing, and the light background pinned to `#F8FAFC` --
the same value as the native splash, so there is no colour flash at launch.

## Verification order, and why it mattered

1. EAS cloud build, not local. The local build fails at
   `ld.lld: undefined symbol: __cxa_allocate_exception`, and I confirmed it is not
   ABI-specific by building x86-only, which fails identically.
2. Installed the artefact, did not trust the build result.
3. Launched via `am start`/`monkey`, did not trust the install.
4. Read logcat for the specific failure mode named in the audit.
5. Captured a screenshot, because a running process is not a rendered screen.

## Remaining before Android is fully verified

- Phase 4 onward screens are not built yet; only Welcome and Registration exist.
- Registration is not yet wired to Supabase. It is a designed, validated form, not
  a working signup.
- No iOS build. Requires a macOS host.
- `sellflow-v1.vercel.app` still returns 404; nothing is deployed to it.