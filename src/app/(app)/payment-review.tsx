/**
 * Payment review queue.
 *
 * This screen is the reason the engine is allowed to refuse. Every payment the
 * matcher would not settle on its own arrives here with the reason it refused
 * and the candidates it considered — including the ones it rejected, so "why did
 * this not pay my order?" has an answer instead of a shrug.
 *
 * Three outcomes per payment:
 *
 *   Match      attach it to a waiting order. Goes through the same settlement
 *              path the automatic matcher uses, so a tapped confirmation and an
 *              automatic one are validated and audited identically.
 *   Dismiss    not this order. Audited as a seller action, and the event stops
 *              asking.
 *   Re-check   ask the engine to try again, for when the seller has just opened
 *              an intent that would now match.
 *
 * The app proposes nothing. It sends an event id to the engine and renders what
 * comes back; the only place this screen expresses an opinion is which order the
 * seller taps, which is the decision the engine deliberately refuses to make.
 */

import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BellRing,
  ChevronRight,
  Inbox,
  RefreshCw,
  X,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { ScreenHeader } from '@/components/ScreenHeader';
import {
  Amount,
  Badge,
  BottomSheet,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  ListRowSkeleton,
  PaymentEventStatusBadge,
  PaymentMatchBadge,
  RowIcon,
  SectionHeader,
  SellflowRefreshControl,
  Text,
  confirm,
  useRefresh,
} from '@/components/ui';
import {
  providerLabel,
  reasonCopy,
  usePaymentReview,
  type ReviewEvent,
} from '@/features/payments/queries';
import {
  useAssignPaymentMatch,
  useMatchPaymentEvent,
  useRejectPaymentMatch,
} from '@/features/payments/mutations';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';
import { AppError } from '@/lib/errors';
import { formatDateTime, formatTimeAgo } from '@/lib/format';
import { money, type CurrencyCode } from '@/lib/money';

export default function PaymentReviewScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  const organization = useSession((state) => state.organization);
  const role = useSession((state) => state.role);
  const canWrite = role === 'owner' || role === 'manager';
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const orgId = organization?.id;
  const review = usePaymentReview(orgId);
  // Destructured so the refresh callback depends on the function itself.
  const { refetch } = review;

  /*
   * Tied to the seller's gesture rather than to `isFetching`. This screen also
   * refetches on focus, and deriving the indicator from that made it flash on
   * every visit -- which reads as the app reloading itself unbidden.
   */
  const refresh = useRefresh(
    useCallback(async () => {
      await refetch();
    }, [refetch]),
  );
  const match = useMatchPaymentEvent(orgId);
  const assign = useAssignPaymentMatch(orgId);
  const reject = useRejectPaymentMatch(orgId);

  const [open, setOpen] = useState<ReviewEvent | null>(null);

  useFocusEffect(
    useCallback(() => {
      void review.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [orgId]),
  );

  const busy =
    match.isPending || assign.isPending || reject.isPending;

  /** Keeps the sheet content in step with the refetched list. */
  function syncOpen(eventId: string) {
    const next = review.events.find((event) => event.id === eventId) ?? null;
    setOpen(next);
  }

  async function handleAssign(event: ReviewEvent, intentId: string, orderNumber: string) {
    const ok = await confirm({
      title: `Match to order ${orderNumber}?`,
      message:
        'This records the payment on that order. It is the same step the automatic matcher takes, so it is recorded as your decision.',
      confirmLabel: 'Match payment',
    });
    if (!ok) return;

    try {
      await assign.mutateAsync({ eventId: event.id, intentId });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setOpen(null);
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  async function handleDismiss(event: ReviewEvent) {
    const ok = await confirm({
      title: 'Dismiss this payment?',
      message:
        'It will stop appearing in the queue. The payment stays on record — nothing is deleted, and no order is paid.',
      confirmLabel: 'Dismiss',
      destructive: true,
    });
    if (!ok) return;

    try {
      await reject.mutateAsync({ eventId: event.id });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setOpen(null);
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  async function handleRecheck(event: ReviewEvent) {
    try {
      await match.mutateAsync({ eventId: event.id });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await review.refetch();
      syncOpen(event.id);
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Review payments"
        subtitle={review.count > 0 ? `${review.count} waiting on you` : organization?.name}
      />

      <FlatList
        data={review.events}
        keyExtractor={(item) => item.id}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
          paddingBottom: insets.bottom + spacing.xxl,
          flexGrow: 1,
          gap: spacing.xs,
        }}
        showsVerticalScrollIndicator={false}
            refreshControl={<SellflowRefreshControl {...refresh} />}
        renderItem={({ item }) => (
          <ReviewCard
            event={item}
            currency={currency}
            onPress={() => setOpen(item)}
          />
        )}
        ListEmptyComponent={
          review.isLoading ? (
            <View style={{ paddingTop: spacing.sm, gap: spacing.xs }}>
              <ListRowSkeleton />
              <ListRowSkeleton />
            </View>
          ) : review.isError ? (
            <ErrorState
              title={AppError.from(review.error).title}
              action={AppError.from(review.error).action}
              onRetry={() => void review.refetch()}
            />
          ) : (
            <EmptyState
              icon={Inbox}
              title="Nothing to review"
              description="Payments that arrive but cannot be matched to an order on their own will wait here. Confirmed payments never do."
              actionLabel="Open an order to wait for a payment"
              onActionPress={() => router.push('/(app)/orders')}
            />
          )
        }
      />

      <BottomSheet
        visible={open !== null}
        onClose={() => setOpen(null)}
        title={open ? `${providerLabel(open.provider)} payment` : 'Payment'}
      >
        {open ? (
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md }}>
            {/* -------------------------------------------------- The money */}
            <Card>
              <View style={{ gap: spacing.xs }}>
                <Amount value={money(open.amount, currency)} currency={currency} />
                <Text variant="caption" tone="muted">
                  {open.sender_account
                    ? `From ${open.sender_account}`
                    : 'Sender number not reported'}
                </Text>
                <Text variant="micro" tone="muted">
                  {open.transaction_id} · {formatDateTime(open.detected_at)}
                </Text>
              </View>
            </Card>

            {/* -------------------------------------------------- Why it stopped */}
            <Card>
              <View style={{ gap: spacing.xs }}>
                <PaymentEventStatusBadge status={open.status} />
                <Text variant="caption">
                  {reasonCopy(open.mismatch_reason ?? null) || 'Waiting on your decision.'}
                </Text>
                {open.review_note ? (
                  <Text variant="micro" tone="muted">
                    {open.review_note}
                  </Text>
                ) : null}
              </View>
            </Card>

            {/* -------------------------------------------------- Candidates */}
            {open.payment_matches.length > 0 ? (
              <View>
                <SectionHeader title="Orders it could be" compact />
                <Card style={{ paddingVertical: 0 }}>
                  {open.payment_matches.map((candidate, index) => {
                    const orderNumber = candidate.orders?.order_number ?? 'Order';
                    const settled = candidate.status === 'accepted';
                    const declined = candidate.status === 'rejected';

                    return (
                      <View key={candidate.id}>
                        <Pressable
                          disabled={!canWrite || settled || declined}
                          onPress={() =>
                            void handleAssign(
                              open,
                              candidate.payment_intent_id,
                              orderNumber,
                            )
                          }
                          accessibilityRole="button"
                          accessibilityLabel={`Match this payment to order ${orderNumber}`}
                          style={({ pressed }) => [
                            styles.candidate,
                            { opacity: pressed ? 0.7 : 1 },
                          ]}
                        >
                          <View style={{ flex: 1, gap: 4 }}>
                            <Text variant="subtitle">{orderNumber}</Text>
                            <View style={[styles.chipRow, { gap: spacing.xs }]}>
                              <PaymentMatchBadge strength={candidate.strength} />
                              {candidate.amount_matched ? null : (
                                <Badge
                                  label={
                                    (candidate.amount_delta ?? 0) > 0 ? 'Over' : 'Under'
                                  }
                                  tone="warning"
                                />
                              )}
                              {candidate.customer_phone_matched === false ? (
                                <Badge label="Other sender" tone="warning" />
                              ) : null}
                              {settled ? <Badge label="Matched" tone="success" /> : null}
                              {declined ? <Badge label="Not this one" tone="neutral" /> : null}
                            </View>
                            <Text variant="micro" tone="muted">
                              {candidate.reason_detail ?? reasonCopy(candidate.reason_code)}
                            </Text>
                          </View>

                          {canWrite && !settled && !declined ? (
                            <ChevronRight size={18} color={colors.textMuted} />
                          ) : null}
                        </Pressable>
                        {index < open.payment_matches.length - 1 ? <Divider /> : null}
                      </View>
                    );
                  })}
                </Card>
              </View>
            ) : (
              <Card>
                <View style={[styles.noticeRow, { gap: spacing.sm }]}>
                  <RowIcon tone="info">
                    <BellRing size={18} color={colors.primary} />
                  </RowIcon>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="caption">No order is waiting for this</Text>
                    <Text variant="micro" tone="muted">
                      An advance, a delivery fee, or a sale not entered yet. Open
                      the order and start waiting for this amount, then re-check.
                    </Text>
                  </View>
                </View>
              </Card>
            )}

            {/* -------------------------------------------------- Actions */}
            {canWrite ? (
              <View style={{ gap: spacing.sm }}>
                <Button
                  label="Re-check now"
                  icon={RefreshCw}
                  variant="secondary"
                  onPress={() => void handleRecheck(open)}
                  loading={busy}
                  block
                />
                <Button
                  label="Dismiss this payment"
                  icon={X}
                  variant="ghost"
                  onPress={() => void handleDismiss(open)}
                  loading={busy}
                  block
                />
              </View>
            ) : (
              <Text variant="micro" tone="muted">
                Only the owner or a manager can match a payment.
              </Text>
            )}

            {assign.isError || reject.isError || match.isError ? (
              <Text variant="micro" tone="danger">
                {AppError.from(assign.error ?? reject.error ?? match.error).title}.{' '}
                {AppError.from(assign.error ?? reject.error ?? match.error).action}
              </Text>
            ) : null}
          </View>
        ) : null}
      </BottomSheet>
    </View>
  );
}

function ReviewCard({
  event,
  currency,
  onPress,
}: {
  event: ReviewEvent;
  currency: CurrencyCode;
  onPress: () => void;
}) {
  const { colors, spacing, radius, elevation } = useTheme();
  const candidates = event.payment_matches.length;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${providerLabel(event.provider)} payment of ${event.amount}, ${event.status.replace(/_/g, ' ')}`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderRadius: radius.card,
          padding: spacing.md,
          opacity: pressed ? 0.75 : 1,
        },
        elevation.card,
      ]}
    >
      <View style={[styles.cardTop, { gap: spacing.md }]}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text variant="subtitle">{providerLabel(event.provider)}</Text>
          <Text variant="micro" tone="muted" numberOfLines={1}>
            {event.transaction_id} · {formatTimeAgo(event.detected_at)}
          </Text>
        </View>
        <Amount value={money(event.amount, currency)} currency={currency} />
      </View>

      <View style={[styles.cardBottom, { marginTop: spacing.sm, gap: spacing.xs }]}>
        <PaymentEventStatusBadge status={event.status} />
        {candidates > 0 ? (
          <Badge
            label={candidates === 1 ? '1 candidate' : `${candidates} candidates`}
            tone="neutral"
          />
        ) : null}
        {event.orders ? <Badge label={event.orders.order_number} tone="info" /> : null}
      </View>

      <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs }} numberOfLines={2}>
        {reasonCopy(event.mismatch_reason ?? null) || 'Tap to review.'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start' },
  cardBottom: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  candidate: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16 },
  chipRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  noticeRow: { flexDirection: 'row', alignItems: 'flex-start' },
});