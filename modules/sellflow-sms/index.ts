/**
 * The bridge to the native listener.
 *
 * Everything here is a thin pass-through. No parsing, no matching, no
 * normalisation and no persistence happens in this file: the native layer has
 * already reduced the message to a `PaymentCandidate` before it is ever seen by
 * JavaScript. That is the property the privacy contract depends on, and it is
 * why `messageBody` does not appear in `types.ts` at all.
 *
 * The native module is Android-only. On iOS and on web this resolves to a null
 * module and every call becomes an honest "unsupported" rather than a crash, so
 * the shared screens stay usable and simply report that automatic detection is
 * not available on this platform.
 */

import { Platform, type EventSubscription } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

import type {
  DiagnosticsParseResult,
  NativeProvider,
  PaymentCandidate,
  SmsListenerStatus,
} from './types';

interface SellflowSmsNativeModule {
  /** Current permission / receiver / queue state. */
  getListenerStatusAsync(): Promise<SmsListenerStatus>;

  /** How many candidates the receiver has queued. */
  getQueuedCandidateCountAsync(): Promise<number>;

  /**
   * Every queued candidate, oldest first, WITHOUT removing them.
   *
   * Reading is not consuming. The caller persists the batch into its own durable
   * queue and then acknowledges, so a process death in between causes a
   * redelivery rather than a lost payment.
   */
  peekCandidatesAsync(): Promise<PaymentCandidate[]>;

  /** Removes candidates the caller has already persisted. */
  acknowledgeCandidatesAsync(fingerprints: string[]): Promise<number>;

  /**
   * Drops a candidate the server has definitively refused or aged out.
   *
   * Never called for a transient failure: those are retried, because dropping a
   * candidate to a dropped connection loses a real payment.
   */
  discardCandidateAsync(fingerprint: string): Promise<boolean>;

  /** Which providers this build can parse, and at which parser version. */
  getSupportedProvidersAsync(): Promise<Array<[NativeProvider, number]>>;

  /**
   * Originating addresses each provider is recognised by, normalised.
   *
   * Read-only, and worth confirming against a real handset because these
   * addresses are not publicly documented.
   */
  getRecognisedSendersAsync(): Promise<Record<NativeProvider, string[]>>;

  /** Clears the listener counters. Never clears the candidate queue. */
  resetListenerDiagnosticsAsync(): Promise<boolean>;

  /**
   * Parses a pasted message without persisting or transmitting it.
   *
   * Used only by the development diagnostics panel, so a real captured provider
   * message can confirm or extend a parser. The String lives as one call argument
   * on the native side and is gone when the call returns. There is deliberately no
   * path from here to the ingestion queue.
   *
   * `sender` matters: detection reads the originating address as well as the body,
   * so a paste without one only exercises half the rules.
   */
  parseMessageForDiagnosticsAsync(
    body: string,
    sender?: string,
  ): Promise<DiagnosticsParseResult>;

  /** Raised when the receiver queues something, with JS already running. */
  addListener(
    eventName: 'onPaymentCandidateDetected',
    listener: (event: { fingerprint: string }) => void,
  ): EventSubscription;
}

/*
 * THE NATIVE MODULE LOOKUP. This was wrong, and it silently disabled the whole
 * feature.
 *
 * `SellflowSmsModule` is declared `class SellflowSmsModule : Module()`, which is the
 * EXPO MODULES API. Those register in the Expo module registry, not in React Native's
 * legacy `NativeModules` bridge. Reading `NativeModules.SellflowSms` therefore returned
 * undefined on every build, `isNativeListenerAvailable` was false, and
 * `getListenerStatus()` reported `unsupported`.
 *
 * Verified on BlueStacks API 25: with RECEIVE_SMS granted via adb, the app showed
 * "Not available on this device" and "Listener registered: No" -- correct and honest,
 * and completely non-functional. The receiver never started.
 *
 * `requireOptionalNativeModule` is the right accessor. It is also the one that keeps
 * working if the module is ever moved back to the bridge, because it falls back to the
 * bridge proxy internally.
 *
 * The status module never lied about this, which is why the bug was survivable rather
 * than dangerous -- but a listener that can never start is still a listener that does
 * not work, and "permission granted" would have hidden it if the status screen had been
 * written the lazy way.
 */
const native = requireOptionalNativeModule<SellflowSmsNativeModule>('SellflowSms');

/** True when this build actually contains the native Android listener. */
export const isNativeListenerAvailable = Platform.OS === 'android' && native !== null;

const UNSUPPORTED_STATUS: SmsListenerStatus = {
  permission: 'unsupported',
  receiverActive: false,
  appVersion: 'n/a',
  androidRelease: 'n/a',
  queuedCandidates: 0,
  oldestQueuedAt: 0,
  rejections: {},
  broadcastsReceived: 0,
  messagesExamined: 0,
  unreadableMessages: 0,
  lastMessageAt: 0,
  lastOutcome: 'none',
  droppedCandidates: 0,
};

function requireNative(): SellflowSmsNativeModule {
  if (!native) {
    throw new Error(
      'The SellFlow SMS listener is not in this build. Automatic payment detection needs a development build or an APK, not Expo Go.',
    );
  }
  return native;
}

export async function getListenerStatus(): Promise<SmsListenerStatus> {
  if (!isNativeListenerAvailable) return { ...UNSUPPORTED_STATUS };
  try {
    return await requireNative().getListenerStatusAsync();
  } catch {
    // The native side throws when the React context is gone, which happens
    // whenever JS is starting up or shutting down. Reporting "unsupported" is
    // the honest answer -- we cannot tell whether the permission is granted, and
    // the status screen must never show a healthy state it cannot prove.
    return { ...UNSUPPORTED_STATUS };
  }
}

/** Queued candidates, oldest first, left in place until acknowledged. */
export async function peekCandidates(): Promise<PaymentCandidate[]> {
  if (!isNativeListenerAvailable) return [];
  try {
    return await requireNative().peekCandidatesAsync();
  } catch {
    // The React context is gone. Nothing is lost: the candidates are in the native
    // queue and are read again on the next pass. Swallowing this is deliberate --
    // a throw here would be caught and reported as a failed send, which is a lie.
    return [];
  }
}

export async function acknowledgeCandidates(
  fingerprints: string[],
): Promise<number> {
  if (!isNativeListenerAvailable || fingerprints.length === 0) return 0;
  try {
    return await requireNative().acknowledgeCandidatesAsync(fingerprints);
  } catch {
    // The candidates stay queued and are redelivered. Redelivery is safe: the
    // JavaScript queue recognises them by identity and the server refuses a
    // duplicate regardless.
    return 0;
  }
}

export async function discardCandidate(fingerprint: string): Promise<boolean> {
  if (!isNativeListenerAvailable) return false;
  return requireNative().discardCandidateAsync(fingerprint);
}

/**
 * Parses a pasted message with the real native parsers and returns only the
 * outcome. Nothing is kept.
 *
 * [sender] is passed straight through because provider detection reads the
 * originating address as well as the message body. Omitting it exercises only the
 * body half of the rules, which is the half that already worked.
 */
export async function parseMessageForDiagnostics(
  body: string,
  sender?: string,
): Promise<DiagnosticsParseResult | null> {
  if (!isNativeListenerAvailable) return null;
  // Sent as an explicit empty string rather than left undefined: the native side
  // declares the argument as `String?` because an Expo module lambda cannot carry
  // a default value, and an empty address normalises to "matches no provider",
  // which is exactly what "the caller did not say" should mean.
  return requireNative().parseMessageForDiagnosticsAsync(body, sender ?? '');
}

/**
 * Which providers this build can parse, and at which parser version.
 *
 * Surfaced so a developer reading a `parsed:bkash` outcome can confirm which
 * parser version produced it.
 */
export async function getSupportedProviders(): Promise<
  Array<{ provider: NativeProvider; parserVersion: number }>
> {
  if (!isNativeListenerAvailable) return [];
  try {
    const rows = await requireNative().getSupportedProvidersAsync();
    return rows.map(([provider, parserVersion]) => ({ provider, parserVersion }));
  } catch {
    // Diagnostics must never be the thing that breaks a screen.
    return [];
  }
}

/**
 * Originating addresses each provider is recognised by.
 *
 * These are not publicly documented, so this is how a developer checks the list
 * against what a real handset actually received. The provider's own published
 * identities only; never a personal address.
 */
export async function getRecognisedSenders(): Promise<
  Record<string, string[]>
> {
  if (!isNativeListenerAvailable) return {};
  try {
    return await requireNative().getRecognisedSendersAsync();
  } catch {
    return {};
  }
}

/**
 * Zeroes the listener counters so the next real SMS can be watched from a known
 * starting point.
 *
 * Development diagnostics only. The native side deliberately leaves the candidate
 * queue alone: those rows are real payments that have not reached the server yet.
 */
export async function resetListenerDiagnostics(): Promise<boolean> {
  if (!isNativeListenerAvailable) return false;
  try {
    return await requireNative().resetListenerDiagnosticsAsync();
  } catch {
    return false;
  }
}

/**
 * A nudge that the native queue grew.
 *
 * Carries a fingerprint and nothing else. JS responds by peeking at the durable
 * queue rather than trusting an event payload, so a redelivery or a lost broadcast
 * changes nothing.
 */
export function onQueueChanged(listener: () => void): () => void {
  if (!isNativeListenerAvailable) return () => {};
  const subscription = requireNative().addListener(
    'onPaymentCandidateDetected',
    () => listener(),
  );
  return () => subscription.remove();
}