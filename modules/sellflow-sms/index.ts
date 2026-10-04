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

import {
  NativeModules,
  Platform,
  type EventSubscription,
} from 'react-native';

import type {
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

  /**
   * Parses a pasted message without persisting or transmitting it.
   *
   * Used only by the development diagnostics panel, so a real captured provider
   * message can confirm or extend a parser. The String lives as one call argument
   * on the native side and is gone when the call returns. There is deliberately no
   * path from here to the ingestion queue.
   */
  parseMessageForDiagnosticsAsync(
    body: string,
  ): Promise<
    | { candidate: PaymentCandidate; fingerprint: string }
    | { rejected: string; fingerprint: string }
  >;

  /** Raised when the receiver queues something, with JS already running. */
  addListener(
    eventName: 'onPaymentCandidateDetected',
    listener: (event: { fingerprint: string }) => void,
  ): EventSubscription;
}

const native = (NativeModules as Record<string, unknown>).SellflowSms as
  | SellflowSmsNativeModule
  | undefined
  | null;

/** True when this build actually contains the native Android listener. */
export const isNativeListenerAvailable = Platform.OS === 'android' && Boolean(native);

const UNSUPPORTED_STATUS: SmsListenerStatus = {
  permission: 'unsupported',
  receiverActive: false,
  appVersion: 'n/a',
  androidRelease: 'n/a',
  queuedCandidates: 0,
  oldestQueuedAt: 0,
  rejections: {},
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
 */
export async function parseMessageForDiagnostics(
  body: string,
): Promise<
  | { candidate: PaymentCandidate; fingerprint: string }
  | { rejected: string; fingerprint: string }
  | null
> {
  if (!isNativeListenerAvailable) return null;
  return requireNative().parseMessageForDiagnosticsAsync(body);
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