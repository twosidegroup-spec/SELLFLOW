/**
 * The native listener's types, as the app sees them.
 *
 * Re-exported rather than redeclared so the bridge and the feature layer cannot
 * drift. `PaymentCandidate` is defined in `modules/sellflow-sms/types.ts` because
 * that is the module boundary: the native side produces it, this side only sends
 * it.
 */

import type { PaymentEventSource, PaymentProvider } from '@/lib/database.types';
import type { PaymentCandidate } from '@sellflow-sms/types';

export type {
  NativeProvider,
  PaymentCandidate,
  RawSmsMessage,
  SmsListenerStatus,
  SmsRejectionReason,
} from '@sellflow-sms/types';

/** One event waiting to be handed to `ingest_payment_event`. */
export interface QueuedSmsEvent {
  /**
   * The idempotency key.
   *
   * Minted once, the first time a candidate enters the queue, and reused for every
   * retry for the life of the event. This is the single most important field here:
   * minting a fresh one per attempt is how one SMS becomes three payments.
   */
  clientRef: string;

  /** Exactly what the native parser produced. Not modified. */
  candidate: PaymentCandidate;

  /**
   * The connected payment account the event is filed against.
   *
   * Resolved from the seller's own accounts on this device, never parsed out of a
   * message. The server re-derives and re-authorises it regardless.
   */
  accountId: string;

  /**
   * What to send as `p_receiver_account`.
   *
   * The number the message stated, when it stated one. Otherwise the connected
   * account's own number, because the message named the payer and not the payee.
   * Either way it is a number SellFlow already knows, not something invented from
   * message text.
   */
  receiverAccount: string;

  /** When the device saw the message, ISO 8601. */
  detectedAt: string;

  /** How many send attempts have been made. */
  attempts: number;

  /** Epoch ms before which no attempt should be made. */
  nextAttemptAt: number;

  state: SmsEventState;

  /**
   * A machine-readable failure code, never a message body and never a server
   * message that could contain one.
   */
  lastError: SmsSendFailure | null;
}

export type SmsEventState =
  | 'pending'
  | 'sent'
  | 'accepted'
  | 'duplicate'
  | 'failed';

export type SmsSendFailure =
  | 'offline'
  | 'network'
  | 'server_unavailable'
  | 'unauthenticated'
  | 'not_a_seller'
  | 'account_not_connected'
  | 'provider_mismatch'
  | 'invalid_amount'
  | 'invalid_transaction_id'
  | 'unknown';

/**
 * Why an event could not be filed against a connected account.
 *
 * Both cases mean the same thing to a seller -- "that was not our money" -- and
 * neither is worth retrying forever, so both end up diagnosable rather than
 * looping.
 */
export type AccountRejection = 'account_not_connected' | 'ambiguous_account';

/** The subset of a payment account this layer needs. Keeps it storage-agnostic. */
export interface ConnectedAccount {
  id: string;
  provider: PaymentProvider;
  accountNumber: string;
}

/** The only source value an SMS adapter may send. */
export const SMS_EVENT_SOURCE: PaymentEventSource = 'sms';