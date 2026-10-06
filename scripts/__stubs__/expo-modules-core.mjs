/**
 * `expo-modules-core`, stood in for under Node.
 *
 * The SMS bridge resolves its native module through `requireOptionalNativeModule`,
 * which is the correct accessor -- `SellflowSmsModule` is an Expo Module and is
 * registered in the Expo registry, so reading React Native's legacy `NativeModules`
 * bridge always returns undefined and the listener can never start. See the note in
 * `modules/sellflow-sms/index.ts`.
 *
 * The real package is a native module with a TypeScript-only dependency graph, which
 * Node's type-stripping loader refuses to read from inside node_modules -- the same
 * reason `expo-crypto` and `expo-secure-store` are stubbed here.
 *
 * What it returns is the honest answer for a machine with no Android receiver: null.
 * `isNativeListenerAvailable` is therefore false and `getListenerStatus()` reports
 * `unsupported`, which is exactly the path the app must take when the listener is
 * genuinely absent. The sms-adapter suite asserts that this produces an honest
 * "not available" rather than a healthy-looking status, so the default here makes the
 * test exercise the branch that matters most.
 */

/** @returns {null} There is no native module in Node. */
export function requireOptionalNativeModule() {
  return null;
}

/** Mirrors the real one: throws, because the caller asked for a module that is not there. */
export function requireNativeModule(name) {
  throw new Error(`Cannot find native module '${name}'`);
}

export default { requireNativeModule, requireOptionalNativeModule };