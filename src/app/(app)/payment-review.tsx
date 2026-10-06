/**
 * Payment review queue.
 *
 * Payments that arrived and did NOT settle an order. This is the safety valve for the
 * whole automation story: the engine refuses anything it is not certain about, and this
 * is where the seller decides.
 *
 * WHAT THIS SCREEN WILL NEVER DO
 *
 * It cannot attach a payment by amount alone, by name alone, or by a weak similarity.
 * Those are the cases the engine sends here precisely because it could not be sure. The
 * only two actions are:
 *
 *   Confirm   attach to a candidate the ENGINE proposed, after showing its evidence
 *   Dismiss   record that this payment is not for a waiting order
 *
 * A candidate the engine rejected is shown as well as one it accepted. "Why was my
 * order ruled out?" is a question a seller will ask, and an invisible rejected candidate
 * makes the system look arbitrary rather than careful.
 *
 * Nothing here is applied optimistically. Both actions go through the database, and the
 * row disappears only when the query says so. If a confirm fails, the payment stays in
 * the queue -- a payment that vanished from the screen but did not reach the order would
 * be the worst possible outcome here.
 */

import { useState } from 'react';
import { Pressable, View } from 'react-native';

import {
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  Text,
} from '@/components/ui';
import {
  PaymentEventStatusBadge,
  PaymentMatchBadge,
  PaymentMatchEvidence,
} from '@/components/payments/PaymentBadges';
import {
  providerLabel,
  reasonCopy,
  usePaymentReview,
  type ReviewCandidate,
  type ReviewEvent,
} from '@/features/payments/queries';
import { useAssignPaymentMatch, useRejectPaymentMatch } from '@/features/payments/mutations';
import { formatMajorUnits } from '@/lib/money';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';
import { Inbox } from 'lucide-react-native';

export default function PaymentReviewScreen() {
  const { spacing } = useTheme();

  const orgId = useSession((state) => state.organization?.id);
  const role = useSession((state) => state.role);

  const review = usePaymentReview(orgId);
  const assign = useAssignPaymentMatch(orgId);
  const reject = useRejectPaymentMatch(orgId);

  const [busyEvent, setBusyEvent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const writable = canWrite(role);

  const confirm = async (event: ReviewEvent, candidate: ReviewCandidate) => {
    setError(null);
    setBusyEvent(event.id);
    try {
      await assign.mutateAsync({
        eventId: event.id,
        intentId: candidate.payment_intent_id,
      });
    } catch {
      /*
       * Deliberately not optimistic. If this fails the payment stays in the queue, and
       * saying so is correct: the seller must not be told a payment was applied when it
       * was not.
       */
      setError('Could not attach that payment. It is still waiting for you here.');
    } finally {
      setBusyEvent(null);
    }
  };

  const dismiss = async (event: ReviewEvent) => {
    setError(null);
    setBusyEvent(event.id);
    try {
      await reject.mutateAsync({ eventId: event.id });
    } catch {
      setError('Could not dismiss that payment. It is still waiting for you here.');
    } finally {
      setBusyEvent(null);
    }
  };

  if (review.isLoading) return <LoadingState label="Loading payments" />;

  if (review.isError) {
    return (
      <ErrorState
        title="Could not load the review queue"
        action="Check your connection and try again."
        onRetry={() => void review.refetch()}
      />
    );
  }

  const events = review.events ?? [];

  return (
    <Screen testID="payment-review" width="form" edges={['top']}>
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">Payments to check</Text>
          <Text variant="caption" tone="muted">
            Money that arrived but SellFlow would not attach to an order on its own.
          </Text>
        </View>

        {error ? (
          <Text variant="caption" tone="danger" testID="payment-review-error">
            {error}
          </Text>
        ) : null}

        {events.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="Nothing to check"
            description="Payments that arrive and clearly match an order settle on their own. Anything uncertain lands here instead."
          />
        ) : (
          <View style={{ gap: spacing.md }}>
            {events.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                writable={writable}
                busy={busyEvent === event.id}
                onConfirm={(candidate) => void confirm(event, candidate)}
                onDismiss={() => void dismiss(event)}
              />
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}

function EventCard({
  event,
  writable,
  busy,
  onConfirm,
  onDismiss,
}: {
  event: ReviewEvent;
  writable: boolean;
  busy: boolean;
  onConfirm: (candidate: ReviewCandidate) => void;
  onDismiss: () => void;
}) {
  const { spacing } = useTheme();

  const candidates = event.payment_matches ?? [];
  const proposed = candidates.filter((candidate) => candidate.status === 'candidate');
  const rejected = candidates.filter((candidate) => candidate.status === 'rejected');

  return (
    <Card testID={`review-event-${event.id}`}>
      <View style={{ gap: spacing.md }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacing.xs,
          }}
        >
          <Text variant="numericLarge">{formatMajorUnits(event.amount)}</Text>
          <PaymentEventStatusBadge status={event.status} />
        </View>

        <View style={{ gap: spacing.xxs }}>
          <Text variant="caption" tone="muted">
            {`Received by ${providerLabel(event.provider)} account ${event.receiver_account}`}
          </Text>
          {event.sender_account ? (
            <Text variant="caption" tone="muted">
              {`From ${event.sender_account}`}
            </Text>
          ) : (
            <Text variant="caption" tone="muted">
              The sender number was not in the message.
            </Text>
          )}
          <Text variant="caption" tone="muted">
            {new Date(event.detected_at).toLocaleString()}
          </Text>
          {/*
           * The transaction id is the seller's way to prove it to the provider, and it
           * is the one field they would otherwise have no way to recover.
           */}
          {event.transaction_id ? (
            <Text variant="caption" tone="secondary" testID={`review-txn-${event.id}`}>
              {`Transaction ${event.transaction_id}`}
            </Text>
          ) : null}
        </View>

        {/*
         * Why the engine stopped. A machine reason shown raw reads like a crash; the
         * copy turns it into something the seller can act on. An unrecognised code falls
         * through to the raw value rather than being hidden.
         */}
        {event.mismatch_reason ? (
          <Text variant="caption" tone="warning">
            {reasonCopy(event.mismatch_reason)}
          </Text>
        ) : null}

        {proposed.length === 0 ? (
          <View style={{ gap: spacing.xs }}>
            <Divider />
            <Text variant="caption" tone="muted">
              No waiting order matched this payment.
            </Text>
          </View>
        ) : (
          <View style={{ gap: spacing.sm }}>
            <Divider />
            <Text variant="micro" tone="muted">
              {proposed.length === 1 ? 'ONE POSSIBLE ORDER' : `${proposed.length} POSSIBLE ORDERS`}
            </Text>
            {proposed.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                writable={writable}
                busy={busy}
                onConfirm={() => onConfirm(candidate)}
              />
            ))}
          </View>
        )}

        {/*
         * Rejected candidates are shown so the seller can see what the engine ruled out,
         * and why. Hiding them is what would make the system feel arbitrary.
         */}
        {rejected.length > 0 ? (
          <View style={{ gap: spacing.xs }}>
            <Text variant="micro" tone="muted">
              RULED OUT
            </Text>
            {rejected.map((candidate) => (
              <View key={candidate.id} style={{ gap: spacing.xxs }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.xs,
                  }}
                >
                  <Text variant="caption" tone="muted">
                    {candidate.orders?.order_number ?? 'Another order'}
                  </Text>
                  <PaymentMatchBadge strength={candidate.strength} />
                </View>
                <Text variant="caption" tone="muted">
                  {reasonCopy(candidate.reason_code)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {writable ? (
          <View style={{ gap: spacing.xs }}>
            <Divider />
            <Button
              label="Not for any order — dismiss"
              variant="ghost"
              fullWidth
              disabled={busy}
              onPress={onDismiss}
              testID={`review-dismiss-${event.id}`}
            />
            <Text variant="caption" tone="muted">
              Dismissing records that you checked. It does not delete the payment.
            </Text>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function CandidateRow({
  candidate,
  writable,
  busy,
  onConfirm,
}: {
  candidate: ReviewCandidate;
  writable: boolean;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { radius, spacing } = useTheme();

  return (
    <Pressable
      onPress={writable ? onConfirm : undefined}
      disabled={!writable || busy}
      accessibilityRole="button"
      accessibilityLabel={`Attach to order ${candidate.orders?.order_number ?? 'unknown'}`}
      testID={`review-candidate-${candidate.id}`}
    >
      <View
        style={{
          gap: spacing.xs,
          borderRadius: radius.sm,
          borderWidth: 1,
          borderColor: 'transparent',
          padding: spacing.xs,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
          <Text variant="bodyStrong">
            {candidate.orders?.order_number ?? 'Order unavailable'}
          </Text>
          <PaymentMatchBadge strength={candidate.strength} />
        </View>

        {candidate.orders ? null : (
          <Text variant="caption" tone="muted">
            The order this pointed at no longer exists.
          </Text>
        )}

        {/*
         * The engine's reasoning, per signal. "Account ✓ Amount ✓ Sender ✕" tells the
         * seller what to weigh; a single verdict does not.
         */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
          <PaymentMatchEvidence match={candidate} />
        </View>

        <Text variant="caption" tone="muted">
          {reasonCopy(candidate.reason_code)}
        </Text>

        {writable ? (
          <Text variant="caption" tone="primary">
            {busy ? 'Attaching…' : 'Attach to this order'}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}