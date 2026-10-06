/**
 * Pure presentation data for payments: provider names, engine reasons, event statuses.
 *
 * WHY THIS IS NOT IN queries.ts
 *
 * `queries.ts` imports icon components, and `lucide-react-native` does not load under
 * plain Node. That made every one of these functions untestable outside a React runtime
 * -- so `providerLabel`, `reasonCopy` and `eventStatusLabel` could not be covered by the
 * unit suite at all, while carrying real logic that decides what a seller is told when
 * the engine refuses a payment.
 *
 * Label maps and copy are data, not queries. Splitting them out means this file has no
 * runtime dependency at all, so it can be tested directly, and it means a change to
 * engine-reason wording cannot accidentally break the module that fetches data.
 *
 * Icons stay with the UI: they are a rendering concern, and keeping them out is what
 * lets this module be pure.
 */

import type { PaymentEventStatus, PaymentProvider } from '@/lib/database.types';

export interface ProviderMeta {
  value: PaymentProvider;
  label: string;
  short: string;
  /** What the account form should ask for. A plain mobile number for all four today. */
  numberHint: string;
}

/**
 * The methods a seller can connect.
 *
 * All four are personal or agent numbers. No merchant account is required anywhere in
 * this app, and that is the product, not a limitation to apologise for.
 */
export const PROVIDERS: ProviderMeta[] = [
  { value: 'bkash', label: 'bKash', short: 'bKash', numberHint: 'The bKash number customers send to' },
  { value: 'nagad', label: 'Nagad', short: 'Nagad', numberHint: 'The Nagad number customers send to' },
  { value: 'rocket', label: 'Rocket', short: 'Rocket', numberHint: 'The Rocket number customers send to' },
  { value: 'upay', label: 'Upay', short: 'Upay', numberHint: 'The Upay number customers send to' },
];

export function providerLabel(provider: PaymentProvider): string {
  return PROVIDERS.find((option) => option.value === provider)?.label ?? provider;
}

/**
 * Why the engine refused, in language a seller can act on.
 *
 * The engine returns codes; this turns them into a sentence. An unknown code falls
 * through to its readable form rather than being hidden, because a reason this build
 * has never seen is a signal worth seeing.
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

/**
 * What an event's status means, as a seller would say it.
 *
 * Moved verbatim from queries.ts. The wording is not restated here, because these are
 * sentences a seller reads when money is being refused to settle, and paraphrasing them
 * for the sake of a code move would change what the app says about their money.
 */
const EVENT_STATUS_LABEL: Record<PaymentEventStatus, string> = {
  detected: 'Detected',
  matched: 'Matched',
  confirmed: 'Confirmed',
  unmatched: 'No order found',
  mismatch: 'Does not match',
  duplicate: 'Duplicate',
  rejected: 'Rejected',
  review_required: 'Needs review',
};

export function eventStatusLabel(status: PaymentEventStatus): string {
  return EVENT_STATUS_LABEL[status];
}

/** What the audit trail did, in the past tense a seller reads it in. */
const AUDIT_COPY: Record<string, string> = {
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

export function auditCopy(action: string): string {
  return AUDIT_COPY[action] ?? action.replace(/_/g, ' ');
}