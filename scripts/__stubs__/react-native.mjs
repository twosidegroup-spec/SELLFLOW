/**
 * Minimal `react-native` stub.
 *
 * Only what src/theme/tokens.ts touches: `Platform.select` for elevation and
 * `Platform.OS`. The real module is Flow-typed and cannot be parsed by Node, so
 * scripts that evaluate the real tokens need this in their place.
 *
 * This never runs in the app. It is a test/audit shim.
 */

export const Platform = {
  OS: 'android',
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

export default { Platform, StyleSheet };
