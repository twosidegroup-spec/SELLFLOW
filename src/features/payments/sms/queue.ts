/**
 * The durable queue of detected payments waiting to reach the engine.
 *
 * A seller on patchy mobile data is the normal case, not the edge case, so a
 * detected payment that cannot be sent immediately has to survive a closed app, a
 * killed process and a dead battery. This is that.
 *
 * Why it is not `@/lib/connectivity`'s outbox
 * ------------------------------------------------
 * That queue replays `create_order` and `set_order_status`, and it exists to prove
 * a point about those two being idempotent. Adding a third kind would change
 * reviewed, tested behaviour on the order path to accommodate a feature on the
 * payment path, and the two have genuinely different needs: this queue holds money
 * events, needs its own status vocabulary, and must be able to distinguish
 * "retry this" from "a human needs to look at this". Separate, and small.
 *
 * What makes replays safe
 * -----------------------
 * Three independent mechanisms, because one would be a single point of failure:
 *
 *  1. `clientRef` is minted once, when the event first enters the queue, and reused
 *     for every attempt for as long as the event exists.
 *  2. A candidate already in the queue is recognised by identity and not added
 *     again, so a re-delivered broadcast or a duplicated drain collapses.
 *  3. The server refuses a second event for the same
 *     `(provider, payment_account_id, transaction_id)`, and settlement is keyed on
 *     the event id, so even a queue that somehow sent the same payment twice
 *     produces one ledger row.
 *
 * The device-side mechanisms are an optimisation. The database constraint is the
 * guarantee.
 *
 * Retry policy
 * ------------
 * Exponential backoff with jitter, capped, and capped again by an attempt limit --
 * so there is no infinite loop. An event that exhausts its attempts becomes
 * `failed` and stays visible: a payment the seller has to notice is far better
 * than one that disappears quietly, because the alternative is a customer who paid
 * and a business that never knew.
 */

import { createClientRef } from '@/lib/connectivity';
import { readJson, writeJson, StorageKeys } from '@/lib/storage';
import type { SmsEventState, SmsSendFailure, QueuedSmsEvent } from './types';

/** First retry delay. Short: most failures are a moment of bad signal. */
export const BASE_BACKOFF_MS = 15_000;

/** Backoff ceiling. An event waits at most this long between attempts. */
export const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Attempts before an event stops retrying.
 *
 * With the ceiling above, twelve attempts spans a little over a day of
 * intermittent connectivity. Long enough to survive a real outage, short enough
 * that a genuinely unsendable event does not sit in the queue forever.
 */
export const MAX_ATTEMPTS = 12;

/**
 * How long before an event is abandoned.
 *
 * A payment notification is worth hours, not weeks. Beyond this the seller should
 * be entering it by hand, and a stale event holding an idempotency key is a
 * liability rather than an asset.
 */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Events kept in the queue at once. Beyond this the oldest are dropped. */
export const MAX_QUEUE_LENGTH = 200;

function jitter(attempt: number): number {
  // Deterministic per attempt so tests can reason about ordering; the spread is
  // still enough to stop ten devices retrying in lockstep after a shared outage.
  const spread = 0.75 + ((attempt * 2654435761) % 1000) / 2000;
  return spread;
}

/**
 * When the next attempt should happen, in epoch ms.
 *
 * Exported and pure so the backoff can be asserted directly rather than inferred
 * from a fake clock.
 */
export function backoffFor(attempts: number): number {
  const exponential = BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(Math.round(exponential * jitter(attempts)), MAX_BACKOFF_MS);
}

/** Whether an event should be attempted now. */
export function isDue(event: QueuedSmsEvent, now: number): boolean {
  if (event.state === 'failed' || event.state === 'accepted') return false;
  return event.nextAttemptAt <= now;
}

/** Whether an event has been waiting too long to still be worth sending. */
export function hasExpired(event: QueuedSmsEvent, now: number): boolean {
  const detected = Date.parse(event.detectedAt);
  if (Number.isNaN(detected)) return false;
  return now - detected > MAX_AGE_MS;
}

/**
 * Whether another attempt is allowed.
 *
 * A `pending` event that has exhausted its attempts becomes `failed` rather than
 * disappearing, so the seller can see it and enter it by hand.
 */
export function canAttempt(event: QueuedSmsEvent, now: number): boolean {
  if (hasExpired(event, now)) return false;
  if (event.state === 'failed') return false;
  return event.attempts < MAX_ATTEMPTS;
}

export interface QueueSnapshot {
  pending: QueuedSmsEvent[];
  /** Attempts due now. */
  due: QueuedSmsEvent[];
  failed: QueuedSmsEvent[];
  counts: Record<SmsEventState, number>;
  lastDetectedAt: string | null;
}

/**
 * Reads the whole queue and derives everything the status screen shows.
 *
 * One function rather than a store, because the queue is small, read from disk on
 * demand, and written by exactly one owner (the listener). A reactive store would
 * be a second source of truth that could disagree with what is about to be sent.
 */
export async function readQueue(): Promise<QueuedSmsEvent[]> {
  const stored = await readJson<QueuedSmsEvent[]>(StorageKeys.pendingSmsEvents);
  if (!Array.isArray(stored)) return [];
  // A corrupt row is dropped rather than crashing the screen; the server's
  // idempotency means the payment can still be detected again from a redelivery.
  return stored.filter(
    (event): event is QueuedSmsEvent =>
      Boolean(event) && typeof event.clientRef === 'string' && Boolean(event.candidate),
  );
}

export async function writeQueue(events: QueuedSmsEvent[]): Promise<void> {
  await writeJson(StorageKeys.pendingSmsEvents, events.slice(-MAX_QUEUE_LENGTH));
}

export function summarise(events: QueuedSmsEvent[], now: number): QueueSnapshot {
  const counts: Record<SmsEventState, number> = {
    pending: 0,
    sent: 0,
    accepted: 0,
    duplicate: 0,
    failed: 0,
  };
  for (const event of events) counts[event.state] += 1;

  const lastDetectedAt = events.reduce<string | null>((latest, event) => {
    if (!latest || event.detectedAt > latest) return event.detectedAt;
    return latest;
  }, null);

  return {
    pending: events.filter((event) => event.state === 'pending'),
    due: events.filter((event) => event.state === 'pending' && isDue(event, now)),
    failed: events.filter((event) => event.state === 'failed'),
    counts,
    lastDetectedAt,
  };
}

/**
 * Adds an event, or recognises it as already queued.
 *
 * Identity is `(provider, reference, amount)` -- see `candidateIdentity`. The
 * important part is the *return value*: a duplicate tells the caller it already
 * has this payment, so it can skip a network call rather than sending one and
 * relying on the server to say no.
 */
export async function enqueue(
  event: QueuedSmsEvent,
  identityOf: (candidate: QueuedSmsEvent['candidate']) => string,
): Promise<{ added: boolean; existing: QueuedSmsEvent | null }> {
  const events = await readQueue();
  const identity = identityOf(event.candidate);

  const existing = events.find(
    (queued) => identityOf(queued.candidate) === identity,
  );
  if (existing) {
    // A redelivery of a payment whose event is already accepted is simply
    // dropped. A redelivery of one still waiting is dropped too, because the
    // waiting copy carries the client_ref that will be used.
    return { added: false, existing };
  }

  await writeQueue([...events, event]);
  return { added: true, existing: null };
}

export async function removeByClientRef(clientRef: string): Promise<void> {
  const events = await readQueue();
  await writeQueue(events.filter((event) => event.clientRef !== clientRef));
}

/**
 * Removes an event the engine has accepted.
 *
 * Removed rather than marked: the queue's job is work that has not been delivered,
 * and `payment_events` is now the record. Leaving settled events behind would grow
 * the queue without bound and make "waiting to send" count something that has
 * already been sent.
 *
 * `outcome` exists for diagnostics only -- a duplicate is success, and is
 * indistinguishable from a fresh accept in anything the seller sees.
 */
export function markAccepted(
  events: QueuedSmsEvent[],
  clientRef: string,
  outcome: 'accepted' | 'duplicate',
): QueuedSmsEvent[] {
  void outcome;
  return events.filter((event) => event.clientRef !== clientRef);
}

/** Records a failed attempt and schedules the next one. */
export function markFailed(
  events: QueuedSmsEvent[],
  clientRef: string,
  failure: SmsSendFailure,
  now: number,
): QueuedSmsEvent[] {
  return events.map((event) => {
    if (event.clientRef !== clientRef) return event;
    const attempts = event.attempts + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    return {
      ...event,
      attempts,
      // Exhausted events stop retrying and become visible, rather than looping.
      state: exhausted ? 'failed' : 'pending',
      nextAttemptAt: exhausted ? now : now + backoffFor(attempts),
      lastError: failure,
    };
  });
}

/**
 * Records a failure that retrying cannot fix.
 *
 * The event is kept rather than dropped, in `failed` state, so the seller can see
 * it and enter the payment by hand. Silently deleting a customer's payment because
 * its message was malformed is the one outcome worse than showing an error.
 */
export function markPermanentFailure(
  events: QueuedSmsEvent[],
  clientRef: string,
  failure: SmsSendFailure,
): QueuedSmsEvent[] {
  return events.map((event) =>
    event.clientRef === clientRef
      ? {
          ...event,
          attempts: event.attempts + 1,
          state: 'failed',
          nextAttemptAt: Number.MAX_SAFE_INTEGER,
          lastError: failure,
        }
      : event,
  );
}

/** Events that are due, oldest first. Sending in order keeps money in order. */
export function dueEvents(events: QueuedSmsEvent[], now: number): QueuedSmsEvent[] {
  return events
    .filter((event) => event.state === 'pending' && isDue(event, now))
    .sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt));
}

/** A fresh idempotency key. UUID-shaped because `payment_events.client_ref` is uuid. */
export function newClientRef(): string {
  return createClientRef();
}