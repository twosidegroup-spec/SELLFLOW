/**
 * Badges for payment state.
 *
 * Split out of the review screen because the Payments hub shows the same three states
 * and two screens must not word them differently -- a seller who reads "Needs review"
 * on one screen and "Check this" on the other will ask which is true.
 */

import { Badge, Text } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import type {
  PaymentEventStatus,
  PaymentMatchRow,
  PaymentMatchStrength,
} from '@/lib/database.types';

/**
 * What an event's status means for the seller.
 *
 * `detected` and `mismatch` are deliberately toned as information rather than warning.
 * A mismatch is the engine working correctly -- it declined to settle something -- and
 * painting it red would train a seller to dismiss the one state that does need them.
 */
const EVENT_TONE: Record<PaymentEventStatus, BadgeTone> = {
  detected: 'neutral',
  matched: 'primary',
  confirmed: 'success',
  unmatched: 'warning',
  mismatch: 'warning',
  duplicate: 'neutral',
  rejected: 'neutral',
  review_required: 'warning',
};

const EVENT_LABEL: Record<PaymentEventStatus, string> = {
  detected: 'Seen',
  matched: 'Matched',
  confirmed: 'Confirmed',
  unmatched: 'No matching order',
  mismatch: 'Does not match',
  duplicate: 'Already counted',
  rejected: 'Dismissed',
  review_required: 'Needs review',
};

export function PaymentEventStatusBadge({ status }: { status: PaymentEventStatus }) {
  return <Badge label={EVENT_LABEL[status]} tone={EVENT_TONE[status]} />;
}

/**
 * How much the engine trusts a candidate.
 *
 * The strength is shown, not just accepted or rejected, because the seller's judgement
 * depends on it: a strong match that is wrong is a problem with the engine, while a weak
 * one that is right is a problem with the rule, and the two need different responses.
 */
const STRENGTH_TONE: Record<PaymentMatchStrength, BadgeTone> = {
  strong: 'success',
  medium: 'primary',
  weak: 'warning',
  manual: 'neutral',
};

const STRENGTH_LABEL: Record<PaymentMatchStrength, string> = {
  strong: 'Strong',
  medium: 'Possible',
  weak: 'Weak',
  manual: 'You chose',
};

export function PaymentMatchBadge({ strength }: { strength: PaymentMatchStrength }) {
  return <Badge label={STRENGTH_LABEL[strength]} tone={STRENGTH_TONE[strength]} />;
}

/**
 * A candidate's evidence, spelled out.
 *
 * Four independent signals, each true or false (except the customer, which is null when
 * the payer could not be verified at all -- distinct from "verified as wrong"). Showing
 * them individually is the point: a seller can see that account and amount matched but
 * the sender did not, and decide accordingly. A single overall verdict would hide the
 * reasoning and make the decision feel arbitrary.
 */
export function PaymentMatchEvidence({ match }: { match: PaymentMatchRow }) {
  const signals: { label: string; ok: boolean | null }[] = [
    { label: 'Account', ok: match.account_matched },
    { label: 'Provider', ok: match.provider_matched },
    { label: 'Amount', ok: match.amount_matched },
    { label: 'Sent in time', ok: match.within_window },
    { label: 'Sender number', ok: match.customer_phone_matched },
  ];

  return (
    <>
      {signals.map((signal) => (
        <Text key={signal.label} variant="caption" tone="muted">
          {`${signal.ok === null ? '?' : signal.ok ? '✓' : '✕'} ${signal.label}`}
        </Text>
      ))}
    </>
  );
}