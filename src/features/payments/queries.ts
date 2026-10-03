/**
 * Payment detection: reads.
 *
 * Everything the payment screens display is a plain SELECT. Every write goes
 * through an RPC in ./mutations -- the payment tables have `Insert: never` in
 * database.types.ts precisely so a direct write cannot be written by accident.
 *
 * Two read shapes matter for the UI:
 *
 *   - The review queue needs each event together with the candidates the engine
 *     considered, INCLUDING the ones it rejected. A seller asking "why did this
 *     not settle my order?" can only be answered from those rows, so the queue
 *     reads payment_matches rather than just the event's status.
 *   - An event is joined to its intent's order so the queue can name the order
 *     rather than showing a bare amount.
 */

import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react-native';
import {
  Banknote,
  CircleDollarSign,
  Smartphone,
  Wallet,
} from 'lucide-react-native';

import { getSupabase } from '@/lib/supabase';
import { keys } from '@/lib/queryClient';
import type {
  PaymentAccountRow,
  PaymentAuditLogRow,
  PaymentEventRow,
  PaymentEventStatus,
  PaymentIntentRow,
  PaymentMatchRow,
  PaymentProvider,
} from '@/lib/database.types';

/**
 * Provider registry.
 *
 * Labels and icons live here rather than in the screens so that "bKash" is
 * spelled the same way on every surface. The `numberHint` is what the account
 * form asks for, which is a plain mobile number for all four today.
 */
export const PROVIDERS: {
  value: PaymentProvider;
  label: string;
  short: string;
  icon: LucideIcon;
  numberHint: string;
}[] = [
  {
    value: 'bkash',
    label: 'bKash',
    short: 'bKash',
    icon: Smartphone,
    numberHint: 'The bKash number customers send to',
  },
  {
    value: 'nagad',
    label: 'Nagad',
    short: 'Nagad',
    icon: Wallet,
    numberHint: 'The Nagad number customers send to',
  },
  {
    value: 'rocket',
    label: 'Rocket',
    short: 'Rocket',
    icon: CircleDollarSign,
    numberHint: 'The Rocket number customers send to',
  },
  {
    value: 'upay',
    label: 'Upay',
    short: 'Upay',
    icon: Banknote,
    numberHint: 'The Upay number customers send to',
  },
];

export function providerLabel(provider: PaymentProvider): string {
  return PROVIDERS.find((option) => option.value === provider)?.label ?? provider;
}

export function providerIcon(provider: PaymentProvider): LucideIcon {
  return PROVIDERS.find((option) => option.value === provider)?.icon ?? Wallet;
}

/**
 * Why the engine refused, in language a seller can act on.
 *
 * The engine returns codes; this turns them into a sentence. Unknown codes fall
 * through to the raw value rather than being hidden, because a code we have
 * never seen is a signal worth seeing.
 */
const REASON_COPY: Record<string, string> = {
  no_candidate_intent: 'No waiting order matches this amount.',
  ambiguous_candidates: 'Several waiting orders match. Choose which one it pays.',
  insufficient_confidence: 'Not enough to confirm this on its own.',
  account_mismatch: 'The money went to a different account than the one connected.',
  intent_expired: 'The waiting order had already expired.',
  amount_over: 'More than the order was expecting.',
  amount_under: 'Less than the order was expecting.',
  customer_phone_mismatch: 'Sent from a number that is not the customer on the order.',
  account_and_amount: 'Account and amount match, but the sender could not be verified.',
  account_amount_and_customer: 'Account, amount and customer all match.',
  seller_assigned: 'You matched this payment yourself.',
  record_payment_refused: 'The order would not accept this payment automatically.',
};

export function reasonCopy(code: string | null): string {
  if (!code) return '';
  return REASON_COPY[code] ?? code.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export function usePaymentAccounts(orgId: string | undefined) {
  const query = useQuery({
    queryKey: keys.paymentAccounts(orgId ?? ''),
    enabled: Boolean(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('payment_accounts')
        .select('*')
        .eq('org_id', orgId as string)
        .order('is_active', { ascending: false })
        .order('provider');

      if (error) throw error;
      return (data ?? []) as PaymentAccountRow[];
    },
  });

  const accounts = query.data ?? [];

  return {
    accounts,
    /** Accounts a payment can actually be matched against. */
    active: accounts.filter((account) => account.is_active && account.status === 'connected'),
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

// ---------------------------------------------------------------------------
// Intents for one order
// ---------------------------------------------------------------------------

export interface OrderIntent extends PaymentIntentRow {
  /** Embedded payment_accounts row, when the join resolved. */
  accounts: { id: string; provider: PaymentProvider; label: string | null } | null;
}

/**
 * The intents opened against one order.
 *
 * Used by the order detail screen to show what is being waited for, and by the
 * intent form to refuse creating a second intent for an order that already has
 * an open one.
 */
export function useOrderIntents(orderId: string | undefined) {
  const query = useQuery({
    queryKey: keys.orderIntents(orderId ?? ''),
    enabled: Boolean(orderId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('payment_intents')
        .select('*, payment_accounts!left(id, provider, label)')
        .eq('reference_id', orderId as string)
        .order('created_at', { ascending: false });

      if (error) throw error;

      return ((data ?? []) as unknown[]).map((row) => {
        const raw = row as PaymentIntentRow & { payment_accounts?: unknown };
        return { ...(raw as PaymentIntentRow), accounts: embeddedAccount(raw.payment_accounts) };
      }) satisfies OrderIntent[];
    },
  });

  const intents = query.data ?? [];

  return {
    intents,
    open: intents.filter((intent) => intent.status === 'open' || intent.status === 'partially_paid'),
    settled: intents.filter((intent) => intent.status === 'matched'),
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * PostgREST returns a to-one embed as an object, an array, or null depending on
 * whether the relationship was detected as many-to-one. Both shapes are accepted
 * so the UI cannot disagree with itself about what it rendered.
 */
function embeddedAccount(
  value: unknown,
): { id: string; provider: PaymentProvider; label: string | null } | null {
  if (!value) return null;
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) return null;
  const row = first as { id?: string; provider?: PaymentProvider; label?: string | null };
  if (!row.id || !row.provider) return null;
  return { id: row.id, provider: row.provider, label: row.label ?? null };
}

// ---------------------------------------------------------------------------
// The review queue
// ---------------------------------------------------------------------------

export interface ReviewCandidate extends PaymentMatchRow {
  /** The order this candidate points at, when it is an order intent. */
  orders: { id: string; order_number: string } | null;
}

export interface ReviewEvent extends PaymentEventRow {
  payment_matches: ReviewCandidate[];
  /** The order this event was accepted against, if any. */
  orders: { id: string; order_number: string } | null;
  payment_accounts: { id: string; provider: PaymentProvider; label: string | null } | null;
}

/**
 * Payments that arrived but have not settled an order.
 *
 * `review_required` is the interesting one: the engine saw a plausible payment
 * and refused to settle it. `unmatched` means nothing was waiting for the money
 * at all -- an advance, or a sale not entered yet.
 *
 * Read-mostly by design. Confirming or dismissing is a mutation.
 */
export function usePaymentReview(orgId: string | undefined) {
  const query = useQuery({
    queryKey: keys.paymentReview(orgId ?? ''),
    enabled: Boolean(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('payment_events')
        .select(
          '*, payment_matches(*, orders!left(id, order_number)), orders!left(id, order_number), payment_accounts!left(id, provider, label)',
        )
        .eq('org_id', orgId as string)
        .in('status', ['review_required', 'unmatched', 'mismatch'])
        .order('detected_at', { ascending: false })
        .limit(60);

      if (error) throw error;

      return ((data ?? []) as unknown[]).map((row) => {
        const raw = row as PaymentEventRow & {
          payment_matches?: unknown;
          orders?: unknown;
          payment_accounts?: unknown;
        };
        return {
          ...(raw as PaymentEventRow),
          payment_matches: embeddedMatches(raw.payment_matches),
          orders: embeddedOrder(raw.orders),
          payment_accounts: embeddedAccount(raw.payment_accounts),
        } satisfies ReviewEvent;
      });
    },
  });

  const events = query.data ?? [];

  return {
    events,
    count: events.length,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

function embeddedMatches(value: unknown): ReviewCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const raw = entry as PaymentMatchRow & { orders?: unknown };
    return { ...(raw as PaymentMatchRow), orders: embeddedOrder(raw.orders) };
  });
}

function embeddedOrder(
  value: unknown,
): { id: string; order_number: string } | null {
  if (!value) return null;
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) return null;
  const row = first as { id?: string; order_number?: string };
  if (!row.id || !row.order_number) return null;
  return { id: row.id, order_number: row.order_number };
}

// ---------------------------------------------------------------------------
// Recent activity
//
// A short confirmed-events feed, so a seller can see what the engine settled on
// its own. Separate from the review queue on purpose: the queue is work, this is
// reassurance.
// ---------------------------------------------------------------------------

export interface ActivityEvent extends PaymentEventRow {
  orders: { id: string; order_number: string } | null;
}

export function usePaymentActivity(orgId: string | undefined) {
  const query = useQuery({
    queryKey: keys.paymentActivity(orgId ?? ''),
    enabled: Boolean(orgId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('payment_events')
        .select('*, orders!left(id, order_number)')
        .eq('org_id', orgId as string)
        .eq('status', 'confirmed')
        .order('detected_at', { ascending: false })
        .limit(20);

      if (error) throw error;

      return ((data ?? []) as unknown[]).map((row) => {
        const raw = row as PaymentEventRow & { orders?: unknown };
        return {
          ...(raw as PaymentEventRow),
          orders: embeddedOrder(raw.orders),
        } satisfies ActivityEvent;
      });
    },
  });

  return {
    events: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

// ---------------------------------------------------------------------------
// Order + customer context for the intent form
// ---------------------------------------------------------------------------

export interface OrderPaymentContext {
  order: {
    id: string;
    order_number: string;
    total: number;
    amount_paid: number;
    payment_status: string;
    status: string;
  } | null;
  customer: { name: string | null; phone: string | null } | null;
}

/**
 * Everything the "wait for this payment" form needs: what is outstanding, and
 * the customer's number if they gave one.
 *
 * The customer phone is what upgrades a match from medium to strong, so the
 * form offers it rather than leaving the seller to wonder why a payment sat in
 * review.
 */
export function useOrderPaymentContext(orderId: string | undefined) {
  const query = useQuery({
    queryKey: ['order-payment-context', orderId ?? ''],
    enabled: Boolean(orderId),
    queryFn: async (): Promise<OrderPaymentContext> => {
      const { data, error } = await getSupabase()
        .from('orders')
        .select('id, order_number, total, amount_paid, payment_status, status, customers!left(name, phone)')
        .eq('id', orderId as string)
        .maybeSingle();

      if (error) throw error;
      if (!data) return { order: null, customer: null };

      const row = data as unknown as {
        id: string;
        order_number: string;
        total: number;
        amount_paid: number;
        payment_status: string;
        status: string;
        customers?: unknown;
      };

      const customer = (() => {
        const value = row.customers;
        const first = Array.isArray(value) ? value[0] : value;
        if (!first) return null;
        const c = first as { name?: string | null; phone?: string | null };
        return { name: c.name ?? null, phone: c.phone ?? null };
      })();

      return {
        order: {
          id: row.id,
          order_number: row.order_number,
          total: row.total,
          amount_paid: row.amount_paid,
          payment_status: row.payment_status,
          status: row.status,
        },
        customer,
      };
    },
  });

  return {
    ...query,
    order: query.data?.order ?? null,
    customer: query.data?.customer ?? null,
    /** Whole taka still owed. 0 when nothing is outstanding. */
    outstanding:
      query.data?.order != null
        ? Math.max(0, query.data.order.total - query.data.order.amount_paid)
        : 0,
  };
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/**
 * The audit history for one event.
 *
 * Read-only and shown in the review screen so a seller can see that a
 * confirmation was automatic (actor_kind = system) rather than something they
 * approved. Surfacing this is deliberate: an unexplained automatic settlement is
 * exactly the thing that erodes trust in a matching engine.
 */
export function usePaymentAudit(eventId: string | undefined) {
  const query = useQuery({
    queryKey: ['payment-audit', eventId ?? ''],
    enabled: Boolean(eventId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('payment_audit_logs')
        .select('*')
        .eq('payment_event_id', eventId as string)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return (data ?? []) as PaymentAuditLogRow[];
    },
  });

  return {
    entries: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}

/** Human sentence for an audit action code. */
export function auditCopy(action: string): string {
  const copy: Record<string, string> = {
    account_created: 'Account connected',
    account_disconnected: 'Account disconnected',
    account_status_changed: 'Account updated',
    event_ingested: 'Payment detected',
    event_duplicate: 'Same payment seen again (not counted twice)',
    event_matched: 'Matched to an order',
    event_confirmed: 'Order marked paid',
    event_mismatched: 'Could not confirm automatically',
    event_unmatched: 'No waiting order found',
    intent_created: 'Waiting for this payment',
    intent_cancelled: 'Stopped waiting',
    intent_expired: 'Stopped waiting (expired)',
    match_manually_assigned: 'Matched by you',
    match_rejected: 'Dismissed by you',
    order_payment_recorded: 'Payment recorded on the order',
    subscription_activated: 'Subscription activated',
  };
  return copy[action] ?? action.replace(/_/g, ' ');
}

/** Short label for an event status, used on badges and rows. */
export function eventStatusLabel(status: PaymentEventStatus): string {
  const copy: Record<PaymentEventStatus, string> = {
    detected: 'Detected',
    matched: 'Matched',
    confirmed: 'Confirmed',
    unmatched: 'No order found',
    mismatch: 'Does not match',
    duplicate: 'Duplicate',
    rejected: 'Rejected',
    review_required: 'Needs review',
  };
  return copy[status];
}