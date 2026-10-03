/**
 * The four pieces of data the native layer is allowed to hold.
 *
 * The `messageBody` is intentionally absent from every one of these. It exists
 * only as the parameter a provider adapter receives, is used inside `parse`, and
 * is never copied onto a candidate, a queue row, an event payload or a log
 * line. That is the whole privacy design: the only thing that can leave this
 * module is a `PaymentCandidate`.
 */

/** A provider as the payment engine names it. Mirrors `payment_provider`. */
export type NativeProvider = 'bkash' | 'nagad' | 'rocket' | 'upay';

/** One inbound SMS, as Android delivered it. Held in memory for the parse only. */
export interface RawSmsMessage {
  /** The sending number, exactly as the platform reported it. */
  sender: string;
  /** The message text. Never persisted, never logged, never emitted to JS. */
  messageBody: string;
  /** When the device received it, epoch milliseconds. */
  receivedAt: number;
  /**
   * SHA-256 hex of `messageBody`. Lets a re-delivered identical message be
   * recognised as the same message without keeping the text.
   */
  fingerprint: string;
}

/**
 * A normalised payment candidate: exactly what `ingest_payment_event` needs,
 * produced on-device, before anything touches the network.
 *
 * Field-for-field this is the argument list of the ingest RPC. The client adds
 * `paymentAccountId` and `clientRef` on the JS side because those are resolved
 * against the seller's own connected accounts, never parsed out of a message.
 */
export interface PaymentCandidate {
  provider: NativeProvider;
  /** Provider TrxID. Never invented; a message without one is not a candidate. */
  transactionId: string;
  /** Transfer amount in whole taka, matching `numeric(14,2)` major units. */
  amount: number;
  /** The number that received the money, as the message stated it. */
  receiverAccount: string;
  /** The payer, or null when the message genuinely does not contain one. */
  senderAccount: string | null;
  /** When the provider says the transfer happened, epoch milliseconds. */
  transactionTimestamp: number;
  /** SHA-256 hex of the raw message. */
  fingerprint: string;
  /** When the device saw it, epoch milliseconds. */
  detectedAt: number;
  /**
   * Bumped whenever a provider's parsing rules change, so an event parsed today
   * can be diagnosed against the rules that produced it. Starts at 1.
   */
  parserVersion: number;
}

/**
 * Why a message produced no candidate.
 *
 * Recorded as counts only, never as text. A seller's diagnostics need to know
 * "the listener saw 412 messages and recognised 3 payments", not what the other
 * 409 said.
 */
export type SmsRejectionReason =
  | 'not_a_payment_message'
  | 'otp_or_security_message'
  | 'unsupported_provider'
  | 'missing_amount'
  | 'malformed_amount'
  | 'missing_transaction_id'
  | 'malformed_transaction_id'
  | 'missing_receiver_account'
  | 'ambiguous_fields';

export interface SmsListenerStatus {
  /** Whether the OS has granted RECEIVE_SMS. */
  permission: 'granted' | 'denied' | 'not_determined' | 'unsupported';
  /** Whether the receiver is registered and able to receive broadcasts. */
  receiverActive: boolean;
  /** SellFlow app version, for the `detected_by` support string. */
  appVersion: string;
  /** Android release, e.g. "14". */
  androidRelease: string;
  /** Candidates waiting to be sent by JS. */
  queuedCandidates: number;
  /** Oldest queued candidate's age in ms, or 0 when the queue is empty. */
  oldestQueuedAt: number;
  /** Non-settling parse outcomes, by reason. No message text is ever kept. */
  rejections: Record<string, number>;
}