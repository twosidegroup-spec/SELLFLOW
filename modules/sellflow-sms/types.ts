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

  // ------------------------------------------------------------------ counters
  //
  // These exist because the two failure modes below are indistinguishable from
  // outside the app, and only one of them is a bug in this feature:
  //
  //   broadcastsReceived === 0  -> the platform never delivered an SMS to
  //                                SellFlow. Manifest, permission, or a vendor
  //                                battery restriction. Nothing to do with parsing.
  //   broadcastsReceived > 0    -> Android delivered it. If `lastOutcome` starts
  //                                with `rejected:`, this module read the message
  //                                and declined it, and the reason says why.
  //
  // Counts and one closed-vocabulary token. No text, no sender address.

  /** Times the receiver was invoked for an SMS broadcast. */
  broadcastsReceived: number;
  /** Messages successfully read out of those broadcasts. */
  messagesExamined: number;
  /** Broadcasts or messages Android delivered but would not hand over in full. */
  unreadableMessages: number;
  /** Epoch millis of the last broadcast or examined message, or 0. */
  lastMessageAt: number;
  /**
   * What the last examined message became.
   *
   * `parsed:<provider>` (e.g. `parsed:bkash`), `rejected:<reason>`, `unreadable`,
   * or `none`. Built only from enum ids, so it cannot carry message content.
   */
  lastOutcome: string;
  /** Candidates dropped because the native queue was full. */
  droppedCandidates: number;
}

/**
 * The outcome of parsing a message a developer pasted, split by stage.
 *
 * `detected` is separate from `outcome` on purpose: a message can be correctly
 * attributed to bKash and still be refused for a missing amount, and a developer
 * debugging a real handset needs to know which of those two happened.
 */
export type DiagnosticsParseResult =
  | {
      detected: NativeProvider | null;
      outcome: 'parsed';
      candidate: PaymentCandidate;
      fingerprint: string;
    }
  | {
      detected: NativeProvider | null;
      outcome: 'rejected';
      rejected: SmsRejectionReason;
      fingerprint: string;
    };