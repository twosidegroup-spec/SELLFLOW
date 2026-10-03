/**
 * Payment detection: writes.
 *
 * Every function here calls an RPC. There is no `.insert()`, no `.update()` and
 * no `.from('payment_events').upsert()` anywhere in this file, and there cannot
 * be: the payment tables are typed `Insert: never` / `Update: never` in
 * database.types.ts, and migration 0024 revokes those privileges anyway.
 *
 * Two consequences that shape the code:
 *
 *   1. Money confirmation is the database's decision, not the app's. The app
 *      never decides a payment matched; it asks `match_payment_event`, which
 *      settles an unambiguous strong match and refuses everything else. The
 *      response is parsed only to tell the seller what happened.
 *   2. The app never sends org_id for a payment write, because the server
 *      derives it. The one exception is `create_payment_account`, where the
 *      org is named but authorised with assert_org_write -- a seller may run
 *      more than one business, and guessing which would be worse.
 */

import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { AppError } from '@/lib/errors';
import { createClientRef } from '@/lib/connectivity';
import { getSupabase } from '@/lib/supabase';
import { keys } from '@/lib/queryClient';
import type {
  PaymentAccountStatus,
  PaymentEventSource,
  PaymentProvider,
} from '@/lib/database.types';

/**
 * What the engine's RPCs return.
 *
 * The functions return jsonb with a documented shape; this narrows it once here
 * rather than casting `data as any` at each call site. Every field is optional
 * because a defensive read is better than a screen that crashes on a shape the
 * database may extend later.
 */
export interface EngineResponse {
  event_id?: string;
  intent_id?: string;
  payment_id?: string | null;
  status?: string;
  settled?: boolean;
  duplicate?: boolean;
  already_processed?: boolean;
  auto_confirmed?: boolean;
  strength?: string;
  reason?: string;
  detail?: string;
  candidate_count?: number;
  amount?: number;
  message?: string;
}

function asEngineResponse(data: unknown): EngineResponse {
  if (data && typeof data === 'object') return data as EngineResponse;
  return {};
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface CreateAccountInput {
  orgId: string;
  provider: PaymentProvider;
  accountNumber: string;
  accountType?: 'personal' | 'agent' | 'merchant';
  label?: string | null;
}

export function useCreatePaymentAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateAccountInput) => {
      const { data, error } = await getSupabase().rpc('create_payment_account', {
        p_org_id: input.orgId,
        p_provider: input.provider,
        p_account_number: input.accountNumber,
        p_account_type: input.accountType ?? 'personal',
        p_label: input.label ?? null,
      });

      if (error) throw AppError.from(error);
      return data;
    },
    onSuccess: async (_result, input) => {
      await queryClient.invalidateQueries({ queryKey: keys.paymentAccounts(input.orgId) });
    },
  });
}

export function useSetPaymentAccountStatus(orgId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      accountId,
      status,
      isActive,
    }: {
      accountId: string;
      status: PaymentAccountStatus;
      isActive?: boolean | null;
    }) => {
      const { data, error } = await getSupabase().rpc('set_payment_account_status', {
        p_account_id: accountId,
        p_status: status,
        p_is_active: isActive ?? null,
      });

      if (error) throw AppError.from(error);
      return data;
    },
    onSuccess: async () => {
      // Status changes which intents can match, so the review queue and the
      // activity feed may both be showing something stale.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.paymentAccounts(orgId ?? '') }),
        queryClient.invalidateQueries({ queryKey: keys.paymentReview(orgId ?? '') }),
      ]);
    },
  });
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

export interface CreateIntentInput {
  orderId: string;
  accountId: string;
  /** Whole taka, matching the column. See the note in expense/new.tsx. */
  expectedAmount: number;
  customerPhone?: string | null;
  customerName?: string | null;
  /** ISO timestamp. Null uses the server default of 14 days. */
  expiresAt?: string | null;
}

export function useCreatePaymentIntent(orderId: string) {
  const queryClient = useQueryClient();

  // Held in a ref so a retry of the SAME attempt reuses the key and the server
  // recognises it, while a genuinely new intent gets a fresh one. Mirrors
  // useRecordPayment: only a confirmed success replaces the key.
  const keyRef = useRef<string>(createClientRef());

  return useMutation({
    mutationFn: async (input: CreateIntentInput) => {
      const { data, error } = await getSupabase().rpc('create_payment_intent', {
        p_type: 'order',
        p_reference_id: input.orderId,
        p_payment_account_id: input.accountId,
        p_expected_amount: input.expectedAmount,
        p_expected_customer_phone: input.customerPhone ?? null,
        p_expected_customer_name: input.customerName ?? null,
        p_expires_at: input.expiresAt ?? null,
        p_client_ref: keyRef.current,
      });

      if (error) throw AppError.from(error);
      return data;
    },
    onSuccess: async () => {
      keyRef.current = createClientRef();

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.orderIntents(orderId) }),
        // Every org-scoped payment read is now potentially stale.
        queryClient.invalidateQueries({ queryKey: ['payment-intents'] }),
        queryClient.invalidateQueries({ queryKey: ['payment-review'] }),
      ]);
    },
  });
}

export function useCancelPaymentIntent(orgId: string | undefined, orderId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ intentId, reason }: { intentId: string; reason?: string | null }) => {
      const { data, error } = await getSupabase().rpc('cancel_payment_intent', {
        p_intent_id: intentId,
        p_reason: reason ?? null,
      });

      if (error) throw AppError.from(error);
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['payment-intents'] }),
        queryClient.invalidateQueries({ queryKey: keys.paymentReview(orgId ?? '') }),
        ...(orderId ? [queryClient.invalidateQueries({ queryKey: keys.orderIntents(orderId) })] : []),
      ]);
    },
  });
}

// ---------------------------------------------------------------------------
// Detected payments
// ---------------------------------------------------------------------------

export interface IngestInput {
  accountId: string;
  provider: PaymentProvider;
  receiverAccount: string;
  senderAccount?: string | null;
  /** Whole taka, matching the column. */
  amount: number;
  transactionId: string;
  transactionTimestamp?: string | null;
  source: PaymentEventSource;
}

/**
 * Records a payment the seller detected.
 *
 * `source` is 'manual' from the UI today and 'sms' when the native listener
 * arrives. Nothing else changes: the idempotency constraint is on
 * (provider, account, transaction id) either way, so a manually re-entered
 * transaction cannot double-credit an order.
 */
export function useIngestPaymentEvent(orgId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: IngestInput) => {
      const { data, error } = await getSupabase().rpc('ingest_payment_event', {
        p_payment_account_id: input.accountId,
        p_provider: input.provider,
        p_receiver_account: input.receiverAccount,
        p_sender_account: input.senderAccount ?? null,
        p_amount: input.amount,
        p_transaction_id: input.transactionId,
        p_transaction_timestamp: input.transactionTimestamp ?? null,
        p_source: input.source,
      });

      if (error) throw AppError.from(error);
      return asEngineResponse(data);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.paymentReview(orgId ?? '') }),
        queryClient.invalidateQueries({ queryKey: keys.paymentActivity(orgId ?? '') }),
        queryClient.invalidateQueries({ queryKey: ['payment-intents'] }),
      ]);
    },
  });
}

/**
 * Asks the engine to match a detected payment.
 *
 * The client sends an id and nothing else: it does not propose a target, and it
 * does not compute a score. That is the whole point -- matching logic lives in
 * one place and the app cannot disagree with it.
 */
export function useMatchPaymentEvent(orgId: string | undefined, orderId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ eventId }: { eventId: string }) => {
      const { data, error } = await getSupabase().rpc('match_payment_event', {
        p_event_id: eventId,
      });

      if (error) throw AppError.from(error);
      return asEngineResponse(data);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.paymentReview(orgId ?? '') }),
        queryClient.invalidateQueries({ queryKey: keys.paymentActivity(orgId ?? '') }),
        queryClient.invalidateQueries({ queryKey: ['payment-intents'] }),
        // Settling may have moved money on an order.
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['finance'] }),
        ...(orderId ? [queryClient.invalidateQueries({ queryKey: keys.orderIntents(orderId) })] : []),
      ]);
    },
  });
}

/**
 * The seller's decision: attach a payment to a waiting order.
 *
 * This is the escape hatch that makes the engine's conservative policy
 * affordable. It calls the same settlement path the automatic matcher uses, so a
 * tapped confirmation and an automatic one produce identical validation and
 * identical audit records.
 */
export function useAssignPaymentMatch(orgId: string | undefined, orderId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      eventId,
      intentId,
      note,
    }: {
      eventId: string;
      intentId: string;
      note?: string | null;
    }) => {
      const { data, error } = await getSupabase().rpc('assign_payment_match', {
        p_event_id: eventId,
        p_intent_id: intentId,
        p_note: note ?? null,
      });

      if (error) throw AppError.from(error);
      return asEngineResponse(data);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.paymentReview(orgId ?? '') }),
        queryClient.invalidateQueries({ queryKey: keys.paymentActivity(orgId ?? '') }),
        queryClient.invalidateQueries({ queryKey: ['payment-intents'] }),
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['finance'] }),
        ...(orderId ? [queryClient.invalidateQueries({ queryKey: keys.orderIntents(orderId) })] : []),
      ]);
    },
  });
}

/** Dismisses a payment without settling it. Audited as a seller action. */
export function useRejectPaymentMatch(orgId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ eventId, reason }: { eventId: string; reason?: string | null }) => {
      const { data, error } = await getSupabase().rpc('reject_payment_match', {
        p_event_id: eventId,
        p_reason: reason ?? null,
      });

      if (error) throw AppError.from(error);
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.paymentReview(orgId ?? '') });
    },
  });
}

/** Closes intents whose window has passed. Safe to call on focus. */
export function useExpirePaymentIntents(orgId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data, error } = await getSupabase().rpc('expire_stale_payment_intents');
      if (error) throw AppError.from(error);
      return (data as number) ?? 0;
    },
    onSuccess: async (expired) => {
      if (expired <= 0) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['payment-intents'] }),
        queryClient.invalidateQueries({ queryKey: keys.paymentReview(orgId ?? '') }),
      ]);
    },
  });
}