/**
 * Outbox replay.
 *
 * The queue in `connectivity.ts` records work that could not reach the server.
 * This module is what actually *does* that work, and it is what makes the
 * promise in the offline banner true: "N changes will sync when you reconnect"
 * is only honest because this file exists.
 *
 * Safety contract:
 *
 *   * Only `ReplayableKind` operations are ever present in the queue, and each
 *     of those is idempotent on the server. Replaying is therefore safe even if
 *     the app is killed mid-flush -- the next attempt either repeats a no-op or
 *     completes the original.
 *   * Mutations are replayed oldest-first and one at a time. Order matters here:
 *     a status change queued after an order exists must not be sent before the
 *     order does.
 *   * A failure that is NOT a connectivity problem stops the flush. There is no
 *     point retrying a mutation the server has rejected on its merits; the
 *     seller is told, and the item stays queued so it is not silently lost.
 *   * A connectivity failure leaves the queue untouched and reports that the
 *     flush was interrupted, so it resumes on the next reconnect.
 */

import { AppError, isOfflineError } from './errors';
import { useConnectivity, type CreateOrderPayload, type SetOrderStatusPayload } from './connectivity';
import { getSupabase, isConfigured } from './supabase';
import type { OrderStatus, PaymentMethod } from './database.types';

export interface FlushResult {
  /** Number of queued mutations the server accepted. */
  replayed: number;
  /** Mutations still waiting, with their reason. */
  remaining: number;
  /** A rejection the seller needs to see, if one occurred. */
  blocked: AppError | null;
  /** True when the flush stopped because the connection dropped again. */
  interrupted: boolean;
}

/**
 * Replays every queued mutation.
 *
 * Safe to call repeatedly: a no-op when the queue is empty, and re-entrant
 * guards prevent two concurrent flushes from double-sending.
 */
let flushing = false;

export async function flushOutbox(): Promise<FlushResult> {
  const empty: FlushResult = { replayed: 0, remaining: 0, blocked: null, interrupted: false };

  if (!isConfigured || flushing) return empty;

  const pending = useConnectivity.getState().pending;
  if (pending.length === 0) return empty;

  if (!useConnectivity.getState().online) {
    return { ...empty, remaining: pending.length, interrupted: true };
  }

  flushing = true;
  useConnectivity.getState().setSyncState('syncing');

  const { dequeue, recordAttempt, markSynced } = useConnectivity.getState();
  let replayed = 0;
  let blocked: AppError | null = null;
  let interrupted = false;

  // Oldest first. A status change queued after an order must not overtake it.
  const queue = [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const mutation of queue) {
    if (!useConnectivity.getState().online) {
      interrupted = true;
      break;
    }

    try {
      await dispatch(mutation.kind, mutation.payload);
      await dequeue(mutation.id);
      replayed += 1;
    } catch (error) {
      if (isOfflineError(error)) {
        // Connection dropped again. Leave the item queued and stop.
        await recordAttempt(mutation.id);
        interrupted = true;
        break;
      }

      // The server rejected it on its merits. Retrying cannot help, and
      // discarding it would lose the seller's work, so it stays queued and the
      // reason is surfaced.
      await recordAttempt(mutation.id);
      blocked = AppError.from(error);
      break;
    }
  }

  flushing = false;

  const remaining = useConnectivity.getState().pending.length;

  if (interrupted) {
    useConnectivity.getState().setSyncState('offline');
  } else if (blocked) {
    useConnectivity.getState().setSyncState('error');
  } else {
    await markSynced();
  }

  return { replayed, remaining, blocked, interrupted };
}

async function dispatch(kind: string, payload: unknown): Promise<void> {
  const supabase = getSupabase();

  if (kind === 'create_order') {
    const data = payload as CreateOrderPayload;
    const { error } = await supabase.rpc('create_order', {
      p_store_id: data.storeId,
      p_customer_id: data.customerId,
      p_items: data.items,
      p_discount: data.discount,
      p_delivery_charge: data.deliveryCharge,
      p_amount_paid: data.amountPaid,
      p_payment_method: data.paymentMethod as PaymentMethod,
      p_notes: data.notes,
      // The same client_ref as the original attempt, which is what makes a
      // replay return the original order rather than creating a second one.
      p_client_ref: data.clientRef,
    });
    if (error) throw error;
    return;
  }

  if (kind === 'set_order_status') {
    const data = payload as SetOrderStatusPayload;
    const { error } = await supabase.rpc('set_order_status', {
      p_order_id: data.orderId,
      p_to_status: data.status as OrderStatus,
      p_note: data.note,
    });
    if (error) throw error;
    return;
  }

  // A kind this build does not understand must never be silently dropped, and
  // must never be guessed at. Refusing loudly is the only safe option.
  throw new AppError(
    'A queued change could not be applied',
    'This version of SellFlow does not know how to retry that action. Discard the queued changes and try again.',
  );
}

/**
 * Flushes when connectivity returns.
 *
 * Subscribes to the connectivity store rather than the network module directly,
 * so it fires on the same signal the UI already reacts to.
 */
export function startOutboxReplay(): () => void {
  let wasOnline = useConnectivity.getState().online;

  return useConnectivity.subscribe((state) => {
    if (state.online && !wasOnline && state.pending.length > 0) {
      void flushOutbox();
    }
    wasOnline = state.online;
  });
}
