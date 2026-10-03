/**
 * Minimal `react-native` stub.
 *
 * Covers what `src/theme/tokens.ts` and the native-module bridge touch:
 * `Platform.select`, `Platform.OS`, `StyleSheet.create` and `NativeModules`.
 * The real module is Flow-typed and cannot be parsed by Node, so scripts that
 * evaluate the real tokens need this in its place.
 *
 * `NativeModules` is a mutable object so a test can install a fake `SellflowSms`
 * module and drive the real bridge, which is the only way to test the JS half of
 * the adapter against something other than "it returned nothing".
 *
 * This never runs in the app. It is a test/audit shim.
 */

export const Platform = {
  OS: 'android',
  Version: 34,
  constants: { version: '1.0.0' },
  select: (spec) => {
    if (Object.prototype.hasOwnProperty.call(spec, 'android')) return spec.android;
    if (Object.prototype.hasOwnProperty.call(spec, 'native')) return spec.native;
    if (Object.prototype.hasOwnProperty.call(spec, 'default')) return spec.default;
    return undefined;
  },
};

export const StyleSheet = {
  create: (styles) => styles,
  hairlineWidth: 1,
  absoluteFill: {},
};

/** Mutable so a test can stand a fake native module in. */
export const NativeModules = {};

export default { Platform, StyleSheet, NativeModules };
