/**
 * Turning a native candidate into an `ingest_payment_event` call.
 *
 * One function, pure, and the only place in the app that knows the shape of that
 * RPC's arguments. Keeping it here means the mapping is unit-testable without a
 * network or a database, which is the only way to notice that a field has been
 * dropped before a real customer's payment is the thing that reveals it.
 *
 * Two rules hold throughout.
 *
 * **Nothing is invented.** Every value is either parsed out of the message by the
 * native adapter, read from the seller's own connected account, or generated as an
 * idempotency key. There is no default amount, no fallback transaction id and no
 * "assume the receiver is the sender".
 *
 * **No decision is made here.** The client says "I detected this payment". It does
 * not say what the payment settles, and it has no way to: the arguments carry no
 * order, no intent and no status. `match_payment_event` is called afterwards and
 * the server decides.
 */

import type { PaymentEventSource, PaymentProvider } from '@/lib/database.types';
import { SMS_EVENT_SOURCE, type QueuedSmsEvent } from './types';
import type { PaymentCandidate } from '@sellflow-sms/types';

/**
 * The arguments for `ingest_payment_event`.
 *
 * Written out rather than pulled from `Database['public']['Functions']`, because
 * this is the shape the app is asserting to and a compile error here should point
 * at this file. The generated signature is asserted separately, in
 * `verify_payment_schema.sql`, and pinned again in `scripts/payment-boundary.test.mjs`.
 */
export interface IngestArgs {
  p_payment_account_id: string;
  p_provider: PaymentProvider;
  p_receiver_account: string;
  p_sender_account: string | null;
  p_amount: number;
  p_transaction_id: string;
  p_transaction_timestamp: string | null;
  p_source: PaymentEventSource;
  p_fingerprint: string;
  p_client_ref: string;
  p_detected_by: string;
}

/**
 * The free-form support string written to `payment_events.detected_by`.
 *
 * The contract documents the shape as `android:14:sms:1.0.0`. The parser version
 * is appended because `payment_events` has no dedicated column for it and the
 * prompt is explicit that an SMS parsed today must stay diagnosable against the
 * rules that produced it. Folding it into the existing free-form field is
 * preferable to adding a migration and a column to a money table for one integer.
 *
 * It is support data: no message text, no account number, nothing derived from a
 * customer's SMS.
 */
export function buildDetectedBy(input: {
  androidRelease: string;
  appVersion: string;
  parserVersion: number;
}): string {
  return `android:${input.androidRelease}:sms:${input.appVersion}:p${input.parserVersion}`;
}

/**
 * The arguments for `ingest_payment_event`.
 *
 * Field names are the RPC's own parameter names, deliberately. A translation
 * layer between the candidate and the RPC is a place where a silent mismatch could
 * send the wrong amount into the ledger, and the names match on both sides so
 * there is nothing to translate.
 */
export function buildIngestArgs(event: QueuedSmsEvent, detectedBy: string): IngestArgs {
  return {
    p_payment_account_id: event.accountId,
    p_provider: event.candidate.provider,
    p_receiver_account: event.receiverAccount,
    p_sender_account: event.candidate.senderAccount ?? null,
    p_amount: event.candidate.amount,
    p_transaction_id: event.candidate.transactionId,
    p_transaction_timestamp: event.candidate.transactionTimestamp
      ? new Date(event.candidate.transactionTimestamp).toISOString()
      : null,
    p_source: SMS_EVENT_SOURCE,
    // The hash, never the text. This is what lets the server recognise a
    // re-delivered identical message without SellFlow ever holding the message.
    p_fingerprint: event.candidate.fingerprint,
    p_client_ref: event.clientRef,
    p_detected_by: detectedBy,
  };
}

/**
 * Builds the durable queue entry for a freshly parsed candidate.
 *
 * `clientRef` is minted here, once. Every retry of this event reuses it, and a
 * redelivered copy of the same payment reuses the one already in the queue -- see
 * `queue.ts`. That single fact is what makes "the same SMS sent ten times" one
 * payment.
 */
export function createQueuedEvent(input: {
  candidate: PaymentCandidate;
  accountId: string;
  receiverAccount: string;
  clientRef: string;
  now?: number;
}): QueuedSmsEvent {
  return {
    clientRef: input.clientRef,
    candidate: input.candidate,
    accountId: input.accountId,
    receiverAccount: input.receiverAccount,
    detectedAt: new Date(input.candidate.detectedAt ?? input.now ?? Date.now()).toISOString(),
    attempts: 0,
    nextAttemptAt: 0,
    state: 'pending',
    lastError: null,
  };
}