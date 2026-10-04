/**
 * Development-only parser diagnostics.
 *
 * The gap this exists to close: the bKash, Nagad, Rocket and Upay notification
 * texts are not publicly documented, so the parser fixtures in
 * `modules/sellflow-sms/fixtures` are representative rather than captured, and a
 * representative fixture cannot tell you whether the real message parses. The way
 * to close that is to feed a REAL captured message through the real parser -- so
 * this does exactly that and nothing more.
 *
 * What it does with the text:
 *
 *   - Holds it as one function argument and one native call. Nothing else.
 *   - Takes the originating address as a separate argument, because detection
 *     reads the sender as well as the body and a paste that omits it cannot
 *     reproduce what a real handset did.
 *   - Displays only the outcome: the normalised candidate, or the refusal reason.
 *   - Writes nothing. Not AsyncStorage, not a file, not a log, not the queue.
 *   - Sends nothing. It has no route to `ingest_payment_event` even if a caller
 *     wanted one.
 *
 * The returned candidate is a plain object the caller renders. The text is
 * unreachable once `parseMessageForDiagnostics` returns, which is the same
 * guarantee the native receiver gives for a real message.
 *
 * Gated on `__DEV__` at the call site and unreachable in a release build's UI, and
 * inert even there: parsing a string the seller typed has no path to a payment.
 */

import { parseMessageForDiagnostics } from '@sellflow-sms';
import type { NativeProvider, PaymentCandidate } from '@sellflow-sms/types';

/** Why a pasted message produced no candidate. */
export interface DiagnosticsRejection {
  kind: 'rejected';
  reason: string;
  /** Which provider claimed it, when one did. Null when nothing claimed it. */
  detected: NativeProvider | null;
  /** SHA-256 hex, so the same message can be recognised across runs. */
  fingerprint: string;
}

export interface DiagnosticsMatch {
  kind: 'matched';
  candidate: PaymentCandidate;
  detected: NativeProvider | null;
  fingerprint: string;
}

export type DiagnosticsOutcome = DiagnosticsMatch | DiagnosticsRejection | null;

/**
 * A parse result split by stage.
 *
 * `detected` is reported apart from `matched`/`rejected` because those fail for
 * entirely different reasons and a developer holding a real handset needs to know
 * which one occurred: `detected: null` means detection never claimed the message,
 * whereas `detected: 'bkash'` with a rejection means detection worked and
 * extraction did not. Collapsing the two into a single pass/fail is what let the
 * original defect hide behind a green test suite.
 */
export interface DiagnosticsInput {
  /** The pasted message body. Held only for the duration of this call. */
  body: string;
  /**
   * The originating address the device reported, e.g. `bKash`.
   *
   * Not optional in practice. Provider detection reads the sender as well as the
   * body, so a paste with no address cannot reproduce a device that identified
   * bKash from its sender -- which is the real production case.
   */
  sender?: string;
}

const REJECTION_COPY: Record<string, string> = {
  not_a_payment_message:
    'Not recognised as a payment notification from bKash, Nagad, Rocket or Upay.',
  otp_or_security_message:
    'Looks like a one-time passcode or security message. Correctly ignored.',
  unsupported_provider: 'That payment service is not one SellFlow reads.',
  missing_amount: 'No amount could be read from the message.',
  malformed_amount: 'An amount is present but could not be read.',
  missing_transaction_id: 'No transaction reference could be read.',
  malformed_transaction_id: 'A transaction reference is present but not usable.',
  ambiguous_fields:
    'The message states more than one plausible amount, so nothing was guessed.',
};

/** A sentence a developer can act on, falling back to the raw reason code. */
export function rejectionCopy(reason: string): string {
  return REJECTION_COPY[reason] ?? reason.replace(/_/g, ' ');
}

/**
 * Parses a pasted message with the real native parsers.
 *
 * Returns null when the build has no native listener, so the caller can say so
 * rather than pretending the message was rejected.
 *
 * The body is passed as one argument and is unreachable the moment this returns:
 * it is not stored, not written to AsyncStorage, not logged and not uploaded, and
 * this module has no import that could do any of those things.
 */
export async function runDiagnostics({
  body,
  sender,
}: DiagnosticsInput): Promise<DiagnosticsOutcome> {
  if (!body.trim()) return null;

  const result = await parseMessageForDiagnostics(body, sender);
  if (!result) return null;

  if (result.outcome === 'parsed') {
    return {
      kind: 'matched',
      candidate: result.candidate,
      detected: result.detected,
      fingerprint: result.fingerprint,
    };
  }
  return {
    kind: 'rejected',
    reason: result.rejected,
    detected: result.detected,
    fingerprint: result.fingerprint,
  };
}