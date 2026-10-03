/**
 * The runtime that turns native candidates into confirmed or refused payments.
 *
 * This is the whole client-side pipeline, and it is deliberately the only place it
 * exists:
 *
 *   native candidate
 *     -> resolve against the seller's own connected accounts
 *     -> durable queue with one idempotency key per event
 *     -> ingest_payment_event      (the engine's only write path)
 *     -> match_payment_event       (the engine decides; this never does)
 *
 * What it does NOT do is the important half of the list: it does not compare
 * amounts, does not look at orders, does not decide anything is paid, and has no
 * code path that could. `ingest_payment_event` and `match_payment_event` are called
 * with ids and normalised fields, and whatever they answer is what the seller is
 * told.
 *
 * Every dependency is injected so the whole thing -- including the offline, retry
 * and replay paths -- runs under `node --test` against the real module, with only
 * the network and the native bridge faked. See `scripts/sms-adapter.test.mjs`.
 */

import { classifySendError, type SendDecision } from './failures';
import { buildDetectedBy, buildIngestArgs, createQueuedEvent } from './ingest';
import { candidateIdentity, resolveAccount } from './accounts';
import {
  canAttempt,
  dueEvents,
  enqueue,
  markAccepted,
  markFailed,
  markPermanentFailure,
  newClientRef,
  readQueue,
  writeQueue,
} from './queue';
import type { ConnectedAccount, QueuedSmsEvent } from './types';
import type { PaymentCandidate } from '@sellflow-sms/types';

/** The shape of what the engine returns. Mirrors features/payments/mutations. */
export interface EngineResult {
  event_id?: string;
  status?: string;
  duplicate?: boolean;
  settled?: boolean;
  already_processed?: boolean;
  reason?: string;
  message?: string;
}

export interface SmsListenerDeps {
  /** The org's active, connected payment accounts. */
  accounts: () => ConnectedAccount[];
  /** Whether the device believes it has a working connection. */
  online: () => boolean;
  /** Android release, for the support string. */
  androidRelease: () => string;
  /** SellFlow app version, for the support string. */
  appVersion: () => string;
  /** The engine's single write path. Never a table write. */
  ingest: (args: ReturnType<typeof buildIngestArgs>) => Promise<EngineResult>;
  /** The engine's decision. Called with an id and nothing else. */
  match: (eventId: string) => Promise<EngineResult>;
  /** Injected clock, so backoff is testable without waiting. */
  now?: () => number;
}

export interface SmsListenerResult {
  /** Candidates accepted into the queue from this pass. */
  queued: number;
  /** Candidates recognised as already queued and not duplicated. */
  duplicates: number;
  /** Candidates that matched no connected account and were dropped locally. */
  unmatched: number;
  /** Events the engine accepted, duplicate-or-not. */
  settled: number;
  /** Events that failed and will be retried. */
  retried: number;
  /** Events that failed permanently and now need a human. */
  failed: number;
  /** True when the queue paused because the session is gone. */
  blocked: boolean;
}

/**
 * True when a match result means the engine has nothing left to do for this event.
 *
 * `match_payment_event` is safe to call repeatedly -- it returns early for an event
 * that is already confirmed or already waiting for review -- so this is belt and
 * braces rather than the thing preventing a double settlement. The thing preventing
 * a double settlement is `record_payment`'s idempotency key, which is the event id.
 */
function isTerminal(result: EngineResult): boolean {
  if (result.already_processed) return true;
  const status = result.status ?? '';
  return status === 'confirmed' || status === 'review_required' || status === 'duplicate';
}

export function createSmsListener(deps: SmsListenerDeps) {
  const clock = deps.now ?? (() => Date.now());

  /** Support string for `detected_by`. Includes the parser version. */
  function detectedByFor(parserVersion: number): string {
    return buildDetectedBy({
      androidRelease: deps.androidRelease(),
      appVersion: deps.appVersion(),
      parserVersion,
    });
  }

  /**
   * Moves candidates from the native queue into the durable queue.
   *
   * The native queue is only acknowledged once each candidate is safely in the JS
   * queue, so a process death in between causes a redelivery rather than a loss.
   * Redelivery is harmless: `enqueue` recognises an existing identity, and the
   * server refuses a duplicate regardless.
   */
  async function ingestNativeCandidates(
    candidates: PaymentCandidate[],
  ): Promise<{ queued: number; duplicates: number; unmatched: number }> {
    let queued = 0;
    let duplicates = 0;
    let unmatched = 0;

    for (const candidate of candidates) {
      const resolution = resolveAccount(candidate, deps.accounts());

      if (!resolution.ok) {
        // Not connected, or not ours. Nothing is queued, so nothing is ever sent
        // to the server for it, and the seller's phone is not theirs to read.
        unmatched += 1;
        continue;
      }

      const result = await enqueue(
        createQueuedEvent({
          candidate,
          accountId: resolution.accountId,
          receiverAccount: candidate.receiverAccount ?? resolution.accountNumber,
          // Minted once here and reused for every retry of this event.
          clientRef: newClientRef(),
        }),
        candidateIdentity,
      );

      if (result.added) queued += 1;
      else duplicates += 1;
    }

    return { queued, duplicates, unmatched };
  }

  /**
   * Sends every event that is due.
   *
   * Stops the moment the session is gone rather than looping through the rest of
   * the queue into the same wall. That is the difference between "paused, sign in
   * and it catches up" and hammering a 401 fifty times on app resume.
   */
  async function flush(): Promise<SmsListenerResult> {
    const result: SmsListenerResult = {
      queued: 0,
      duplicates: 0,
      unmatched: 0,
      settled: 0,
      retried: 0,
      failed: 0,
      blocked: false,
    };

    const now = clock();

    /*
     * A device that knows it is offline does not attempt anything.
     *
     * Without this, every queued payment burns an attempt and takes on an error
     * state while the phone sits in a lift -- and a queue of ten payments would
     * exhaust its attempt budget without ever having reached the network. The
     * event stays exactly as it was, and the next pass after connectivity returns
     * sends it.
     */
    if (!deps.online()) return result;

    let events = await readQueue();

    for (const event of dueEvents(events, now)) {
      if (!canAttempt(event, now)) continue;

      try {
        const ingested = await deps.ingest(
          buildIngestArgs(event, detectedByFor(event.candidate.parserVersion)),
        );

        const eventId = ingested.event_id;
        if (!eventId) {
          // No id means nothing was written, so this must be retried rather than
          // acknowledged. Treating it as success would drop a real payment.
          events = markFailed(events, event.clientRef, 'unknown', clock());
          result.retried += 1;
          continue;
        }

        if (!isTerminal(ingested)) {
          // Ask the engine to match. It decides; the answer is only reported.
          await deps.match(eventId);
        }

        events = markAccepted(
          events,
          event.clientRef,
          ingested.duplicate ? 'duplicate' : 'accepted',
        );
        result.settled += 1;
      } catch (error) {
        const { decision, failure } = classifySendError(error, deps.online());
        const now2 = clock();

        if (decision === 'unauthenticated') {
          // Stop the whole queue. Everything after this would fail identically.
          events = markFailed(events, event.clientRef, failure, now2);
          result.retried += 1;
          result.blocked = true;
          break;
        }

        if (decision === 'permanent') {
          events = markPermanentFailure(events, event.clientRef, failure);
          result.failed += 1;
          continue;
        }

        events = markFailed(events, event.clientRef, failure, now2);
        result.retried += 1;

        // A single network failure means the next one will fail too. Stop here so
        // a dead connection costs one attempt, not one attempt per queued event.
        if (!deps.online()) break;
      }
    }

    await writeQueue(events);
    return result;
  }

  /**
   * Requeues an event the seller asked to retry by hand.
   *
   * Keeps the same `clientRef`. That is the point: retrying is the same event, and
   * giving it a new key would create a second chance to double-count it.
   */
  async function retry(clientRef: string): Promise<void> {
    const now = clock();
    const events = (await readQueue()).map((event) =>
      event.clientRef === clientRef
        ? {
            ...event,
            state: 'pending' as const,
            attempts: 0,
            nextAttemptAt: now,
            lastError: null,
          }
        : event,
    );
    await writeQueue(events);
  }

  /** Drops a failed event from the queue. The seller's explicit choice. */
  async function dismiss(clientRef: string): Promise<void> {
    await writeQueue((await readQueue()).filter((event) => event.clientRef !== clientRef));
  }

  return { ingestNativeCandidates, flush, retry, dismiss };
}

export type SmsListener = ReturnType<typeof createSmsListener>;
export type { SmsListenerDeps as SmsListenerConfig, SendDecision };
export type { QueuedSmsEvent };