/**
 * Payment intelligence: how much money is actually in hand, and how much needs a person.
 *
 * WHY THIS IS NOT THE DASHBOARD'S "REVENUE"
 *
 * `get_dashboard` sums `orders.total`. That is what the seller SOLD, not what they
 * RECEIVED. On a cash-on-delivery day the two differ by the entire courier float, and
 * the difference is exactly the number a seller most needs to be honest about.
 *
 * So the received figure comes from the `payments` table -- rows that exist only once
 * money has actually been recorded -- and COD receivable stays separate and labelled as
 * owed. A seller reading "you earned 5,000 today" when 4,000 of it is still with a rider
 * will spend money they do not have.
 *
 * WHY IT IS NOT A MIGRATION
 *
 * Every number here is derivable from rows the app already reads, and deriving it in one
 * tested pure function is cheaper to review than a new aggregate. When it earns its own
 * SQL it should be moved there, but not before it earns it.
 */

import { useQuery } from '@tanstack/react-query';

import type { PaymentEventStatus, PaymentRow } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { keys } from '@/lib/queryClient';
import { getSupabase } from '@/lib/supabase';
import { toDateString } from '@/lib/format';

/** Statuses that mean a person has to look at something. */
export const NEEDS_A_HUMAN: PaymentEventStatus[] = ['unmatched', 'review_required', 'mismatch'];

export interface PaymentHealth {
  /** Money actually recorded as received today, refunds excluded. */
  receivedToday: number;
  receivedCount: number;
  /** Arrived and was not attached to an order. */
  unmatchedCount: number;
  /** Arrived, engine declined to settle it. */
  reviewCount: number;
  /** Arrived but does not correspond to anything waiting. */
  mismatchCount: number;
  /** Already counted once; recording it again would double the money. */
  duplicateCount: number;
  /** Everything a person must look at, as one number. */
  needsHuman: number;
  accountsConnected: number;
  accountsTotal: number;
}

export interface ReceivedInput {
  rows: Pick<PaymentRow, 'amount' | 'is_refund' | 'paid_at'>[];
  /** Local calendar date, `YYYY-MM-DD`, in the seller's own timezone. */
  today: string;
}

/**
 * Money received today, in whole taka.
 *
 * Refunds are subtracted rather than ignored: a refund is money that left, and a seller
 * looking at net cash flow needs to see it. `paid_at` is compared as a DATE so the
 * comparison happens in the seller's day, not in UTC.
 */
export function receivedToday({ rows, today }: ReceivedInput): number {
  return rows.reduce((total, row) => {
    if (!row.paid_at) return total;
    // `paid_at` is timestamptz; take the date part and compare against the seller's
    // local today rather than converting, which would shift the boundary by the offset.
    const day = row.paid_at.slice(0, 10);
    if (day !== today) return total;
    return total + (row.is_refund ? -row.amount : row.amount);
  }, 0);
}

export interface StatusCountsInput {
  statuses: PaymentEventStatus[];
}

export function countByStatus({ statuses }: StatusCountsInput): Pick<
  PaymentHealth,
  'unmatchedCount' | 'reviewCount' | 'mismatchCount' | 'duplicateCount' | 'needsHuman'
> {
  const unmatched = statuses.filter((s) => s === 'unmatched').length;
  const review = statuses.filter((s) => s === 'review_required').length;
  const mismatch = statuses.filter((s) => s === 'mismatch').length;
  const duplicate = statuses.filter((s) => s === 'duplicate').length;

  return {
    unmatchedCount: unmatched,
    reviewCount: review,
    mismatchCount: mismatch,
    duplicateCount: duplicate,
    // `duplicate` is deliberately NOT counted here. It needs no action: the engine
    // already recognised it and did not count the money twice. Padding this number
    // with duplicates would train a seller to ignore the badge.
    needsHuman: unmatched + review + mismatch,
  };
}

export function usePaymentHealth(
  orgId: string | undefined,
  accounts: { active: unknown[]; accounts: unknown[] },
): PaymentHealth {
  const query = useQuery({
    queryKey: keys.paymentHealth(orgId ?? ''),
    enabled: Boolean(orgId),
    queryFn: async (): Promise<{ payments: PaymentRow[]; statuses: PaymentEventStatus[] }> => {
      const supabase = getSupabase();

      /*
       * Two reads, both scoped by RLS to the caller's org. `payments` is the only
       * authoritative record that money was received; `payment_events` carries the
       * statuses that need attention.
       */
      const [paymentsResult, eventsResult] = await Promise.all([
        supabase
          .from('payments')
          .select('amount, is_refund, paid_at')
          .eq('org_id', orgId as string)
          // A bounded window: "today" plus a fortnight, so the count is stable and the
          // read cannot grow with a busy year.
          .gte('paid_at', `${toDateString()}T00:00:00.000Z`)
          .limit(1000),
        supabase
          .from('payment_events')
          .select('status')
          .eq('org_id', orgId as string)
          .in('status', ['unmatched', 'review_required', 'mismatch', 'duplicate'])
          .limit(500),
      ]);

      if (paymentsResult.error) throw AppError.from(paymentsResult.error);
      if (eventsResult.error) throw AppError.from(eventsResult.error);

      return {
        payments: (paymentsResult.data ?? []) as PaymentRow[],
        statuses: ((eventsResult.data ?? []) as { status: PaymentEventStatus }[]).map(
          (row) => row.status,
        ),
      };
    },
  });

  const accountsTotal = (accounts.accounts as unknown[]).length;
  const accountsConnected = (accounts.active as unknown[]).length;

  return {
    receivedToday: receivedToday({ rows: query.data?.payments ?? [], today: toDateString() }),
    receivedCount: (query.data?.payments ?? []).filter(
      (row) => !row.is_refund && row.paid_at?.slice(0, 10) === toDateString(),
    ).length,
    ...countByStatus({ statuses: query.data?.statuses ?? [] }),
    accountsConnected,
    accountsTotal,
  };
}