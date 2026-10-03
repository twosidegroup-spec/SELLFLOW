/**
 * Turning a failed send into one of three decisions.
 *
 * Retry, stop retrying, or stop everything. The distinction is the whole reason
 * this is a function with tests rather than a `catch` that logs:
 *
 *   - **Retry** for conditions that clear on their own. A phone in a lift, a
 *     server restart, an expired session the app can refresh. Dropping these loses
 *     a customer's real payment to a dropped connection.
 *   - **Permanent** for conditions that cannot clear by sending the same bytes
 *     again. A malformed transaction reference, an amount the engine refuses, a
 *     provider that does not match the account. Retrying these forever is the
 *     "infinite retry loop" the phase brief rules out, and it buries the one event
 *     that needs a human.
 *   - **Unauthenticated** stops the whole queue rather than just this event. Every
 *     subsequent call would fail identically, so continuing to hammer the server
 *     serves nobody, and a queue that looks busy while signed out is a lie.
 *
 * The classification reads the RAW error, not `AppError.from(...)`. AppError is the
 * seller's-facing copy layer and deliberately discards the server's machine code,
 * which is exactly what this needs; routing through it would collapse six distinct
 * refusals into "Something went wrong".
 *
 * Only codes are stored. A server message could contain text from a provider, and
 * this queue is read by the diagnostics screen.
 */

import type { SmsSendFailure } from './types';

export type SendDecision = 'retry' | 'permanent' | 'unauthenticated';

export interface ClassifiedFailure {
  decision: SendDecision;
  failure: SmsSendFailure;
}

/**
 * Server refusals that will never become true by asking again.
 *
 * These are `ingest_payment_event`'s own validation messages, so the list is short
 * on purpose: it describes the *data*, not the connection. Retrying them is how a
 * queue fills with events nobody can ever send.
 */
const PERMANENT_CODES: Record<string, SmsSendFailure> = {
  invalid_amount: 'invalid_amount',
  invalid_transaction_id: 'invalid_transaction_id',
  provider_mismatch: 'provider_mismatch',
};

/**
 * "Not connected, or not yours."
 *
 * Retried rather than dropped, deliberately: a seller can connect the account
 * after the payment arrived, and the payment is real either way. It exhausts its
 * attempts and then becomes diagnosable instead of disappearing.
 */
const ACCOUNT_CODES: Record<string, SmsSendFailure> = {
  payment_account_not_found: 'account_not_connected',
};

/** Refusals that mean the whole queue should wait for a human. */
const AUTH_CODES: Record<string, SmsSendFailure> = {
  insufficient_privilege: 'not_a_seller',
  new_account_required: 'unauthenticated',
  invalid_authorization: 'unauthenticated',
  jwt_expired: 'unauthenticated',
  user_not_found: 'unauthenticated',
};

/** Transport failures, which supabase-js reports as codes, messages or statuses. */
const NETWORK_CODES: Record<string, SmsSendFailure> = {
  ECONNREFUSED: 'network',
  ECONNRESET: 'network',
  ENOTFOUND: 'network',
  ETIMEDOUT: 'network',
  EAI_AGAIN: 'network',
};

const NETWORK_MESSAGES = [
  'failed to fetch',
  'fetch failed',
  'network request failed',
  'network error',
  'load failed',
  'timeout',
];

function raw(error: unknown): { code: string; message: string; status?: number } {
  const candidate = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
    status?: unknown;
  };
  return {
    code: typeof candidate.code === 'string' ? candidate.code : '',
    message: typeof candidate.message === 'string' ? candidate.message : '',
    status: typeof candidate.status === 'number' ? candidate.status : undefined,
  };
}

export function classifySendError(
  error: unknown,
  online: boolean,
): ClassifiedFailure {
  // Connectivity first. An offline device produces the same generic failure as a
  // dead server, and the caller's next move differs.
  if (!online) return { decision: 'retry', failure: 'offline' };

  const { code, message, status } = raw(error);

  if (AUTH_CODES[code]) {
    return { decision: 'unauthenticated', failure: AUTH_CODES[code]! };
  }
  if (PERMANENT_CODES[code]) {
    return { decision: 'permanent', failure: PERMANENT_CODES[code]! };
  }
  if (ACCOUNT_CODES[code]) {
    return { decision: 'retry', failure: ACCOUNT_CODES[code]! };
  }

  const lowered = message.toLowerCase();
  if (NETWORK_CODES[code] || NETWORK_MESSAGES.some((text) => lowered.includes(text))) {
    return { decision: 'retry', failure: 'network' };
  }

  // supabase-js surfaces an expired or rejected JWT as a status, not a code.
  if (status === 401) return { decision: 'unauthenticated', failure: 'unauthenticated' };
  if (status === 403) return { decision: 'unauthenticated', failure: 'not_a_seller' };
  if (status !== undefined && status >= 500) {
    return { decision: 'retry', failure: 'server_unavailable' };
  }

  // Anything unrecognised is retried, because losing a payment is worse than one
  // extra attempt. The attempt cap in queue.ts is what stops that being an
  // infinite loop.
  return { decision: 'retry', failure: 'unknown' };
}

const FAILURE_COPY: Record<SmsSendFailure, string> = {
  offline: 'No connection. It will be sent when you are back online.',
  network: 'Could not reach SellFlow. It will keep trying.',
  server_unavailable: 'SellFlow could not be reached. It will keep trying.',
  unauthenticated: 'Sign in again to send this payment.',
  not_a_seller: 'This account cannot record payments.',
  account_not_connected: 'The account that received this payment is not connected.',
  provider_mismatch: 'The connected account uses a different payment service.',
  invalid_amount: 'The amount in that message could not be read.',
  invalid_transaction_id: 'The transaction reference in that message could not be read.',
  unknown: 'Could not send this payment. It will keep trying.',
};

export function failureCopy(failure: SmsSendFailure | null): string {
  return failure ? FAILURE_COPY[failure] : '';
}