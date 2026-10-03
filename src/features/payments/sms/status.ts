/**
 * What the seller is told about automatic detection.
 *
 * One pure function from facts to a status, so the wording can be tested and so
 * the status screen and the Payments hub can never disagree about whether
 * detection is working.
 *
 * Two rules shape the ordering.
 *
 * **Nothing here is inferred from an SMS.** Every input is a fact the app can
 * prove: an OS permission result, a receiver that is or is not registered, the
 * seller's own connected accounts, the local delivery queue, and the engine's own
 * verdict on the last event it recorded. A status is never "we think a payment
 * arrived".
 *
 * **Backend truth wins.** `confirmed` and `needs review` come from
 * `payment_events.status`, which only `match_payment_event` and the settlement path
 * ever set. The app cannot write that column -- the types say `Insert: never` and
 * the database revokes the grant -- so this function reports the engine's answer
 * and never the device's hope.
 */

import type { PaymentEventStatus } from '@/lib/database.types';
import type { QueueSnapshot } from './queue';
import type { SmsListenerStatus, SmsSendFailure } from './types';

export type DetectionStatus =
  /** Not Android, or this build has no native listener. */
  | 'unsupported_platform'
  /** RECEIVE_SMS has not been granted. */
  | 'permission_required'
  /** RECEIVE_SMS was refused, so the listener cannot run. */
  | 'permission_denied'
  /** The receiver is not registered or has been switched off. */
  | 'receiver_unavailable'
  /** Nothing connected to receive money into. */
  | 'no_accounts'
  /** The session is gone, so nothing can be sent. */
  | 'sign_in_required'
  /** Events are waiting on a connection. */
  | 'offline_queued'
  /** An event could not be sent and needs a person. */
  | 'needs_attention'
  /** An event arrived and is being sent. */
  | 'processing'
  /** The engine confirmed a payment against an order. */
  | 'confirmed'
  /** The engine saw a payment it would not settle on its own. */
  | 'needs_review'
  /** Connected, nothing pending, nothing waiting for a decision. */
  | 'waiting';

export interface DetectionFacts {
  nativeStatus: SmsListenerStatus | null;
  connectedAccounts: number;
  snapshot: QueueSnapshot;
  /** The engine's status for the most recent event it recorded. */
  lastEventStatus: PaymentEventStatus | null;
  /** Events the engine refused to settle on its own. */
  needsReview: number;
  /** Most recent delivery failure, if any. */
  lastFailure: SmsSendFailure | null;
}

export function deriveDetectionStatus(facts: DetectionFacts): DetectionStatus {
  const { nativeStatus, snapshot } = facts;

  if (!nativeStatus || nativeStatus.permission === 'unsupported') {
    return 'unsupported_platform';
  }
  if (nativeStatus.permission === 'not_determined') return 'permission_required';
  if (nativeStatus.permission === 'denied') return 'permission_denied';

  // Permission granted but nothing registered: a build where the plugin did not
  // run. Worth its own status, because "permission granted" would otherwise read
  // as "connected" while nothing is ever detected.
  if (!nativeStatus.receiverActive) return 'receiver_unavailable';

  if (facts.connectedAccounts === 0) return 'no_accounts';

  if (snapshot.failed.length > 0) return 'needs_attention';
  if (facts.lastFailure === 'unauthenticated') return 'sign_in_required';
  if (facts.lastFailure === 'offline' && snapshot.pending.length > 0) return 'offline_queued';
  if (snapshot.pending.length > 0) return 'processing';

  // Below here the engine's own verdict is the only thing being reported.
  if (facts.needsReview > 0) return 'needs_review';
  if (facts.lastEventStatus === 'confirmed') return 'confirmed';

  return 'waiting';
}

export interface DetectionCopy {
  title: string;
  body: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}

const COPY: Record<DetectionStatus, DetectionCopy> = {
  unsupported_platform: {
    title: 'Not available on this device',
    body: 'Automatic detection reads payment messages on Android. You can still record every payment by hand.',
    tone: 'neutral',
  },
  permission_required: {
    title: 'Permission needed',
    body: 'SellFlow needs permission to read payment messages before it can detect a payment.',
    tone: 'warning',
  },
  permission_denied: {
    title: 'Permission not granted',
    body: 'Without the message permission SellFlow cannot detect payments. Everything else keeps working, including recording a payment by hand.',
    tone: 'warning',
  },
  receiver_unavailable: {
    title: 'Listener not running',
    body: 'The payment listener is not active on this build. Automatic detection is unavailable until it is.',
    tone: 'danger',
  },
  no_accounts: {
    title: 'No payment account connected',
    body: 'Connect the bKash, Nagad, Rocket or Upay number your customers pay into. Until then there is nothing to detect against.',
    tone: 'warning',
  },
  sign_in_required: {
    title: 'Sign in to send',
    body: 'A payment was detected but could not be sent because the session ended. Sign in and it will be sent.',
    tone: 'warning',
  },
  offline_queued: {
    title: 'Offline — queued',
    body: 'A payment was detected and is waiting to be sent. It will go as soon as you are back online.',
    tone: 'warning',
  },
  needs_attention: {
    title: 'Needs your attention',
    body: 'A detected payment could not be sent automatically. Record it by hand so the order is right.',
    tone: 'danger',
  },
  processing: {
    title: 'Payment detected',
    body: 'Sending it to SellFlow now. Matching runs on our side and the order is only paid once we confirm it.',
    tone: 'info',
  },
  confirmed: {
    title: 'Confirmed',
    body: 'SellFlow matched a detected payment to an order on its own.',
    tone: 'success',
  },
  needs_review: {
    title: 'Needs review',
    body: 'A payment arrived that SellFlow would not settle without you. Check it in the review queue.',
    tone: 'warning',
  },
  waiting: {
    title: 'Waiting for payment',
    body: 'Listening. When a customer pays into a connected account, SellFlow will notice.',
    tone: 'success',
  },
};

export function detectionCopy(status: DetectionStatus): DetectionCopy {
  return COPY[status];
}

/**
 * Whether the listener can do anything useful in this state.
 *
 * Used to decide if the "connect an account" prompt is worth showing. A seller who
 * declined the permission still needs to know manual entry is available, but not
 * to be nagged about an account they may not want.
 */
export function isDetectionActionable(status: DetectionStatus): boolean {
  return status === 'waiting' || status === 'processing' || status === 'confirmed';
}