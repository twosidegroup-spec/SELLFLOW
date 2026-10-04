/**
 * Payments hub.
 *
 * One place for everything the detection engine knows: which accounts are
 * connected, and what arrived but was not settled on its own.
 *
 * This is a pushed route rather than a sixth tab. The tab bar is five fixed
 * destinations by design, and payment detection is a business tool rather than
 * something a seller needs permanently in front of them.
 *
 * Nothing on this screen decides anything. The engine settles unambiguous strong
 * matches by itself; this screen reports what it did and routes the rest to a
 * person.
 */

import { useCallback } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowRight,
  CircleSlash,
  Inbox,
  Plus,
  RadioTower,
  ScanLine,
  Smartphone,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { IconButton, ScreenHeader } from '@/components/ScreenHeader';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  ListRow,
  ListRowSkeleton,
  RowIcon,
  SectionHeader,
  SellflowRefreshControl,
  Text,
  confirm,
  useRefresh,
} from '@/components/ui';
import {
  providerIcon,
  providerLabel,
  usePaymentAccounts,
  usePaymentReview,
} from '@/features/payments/queries';
import { useSetPaymentAccountStatus } from '@/features/payments/mutations';
import { useSmsDetectionStatus } from '@/features/payments/sms/hooks';
import { detectionCopy } from '@/features/payments/sms/status';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';
import { AppError } from '@/lib/errors';
import { maskPhone } from '@/lib/format';

export default function PaymentsScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  const organization = useSession((state) => state.organization);
  const role = useSession((state) => state.role);
  const canWrite = role === 'owner' || role === 'manager';

  const orgId = organization?.id;
  const accounts = usePaymentAccounts(orgId);
  const review = usePaymentReview(orgId);
  // Destructured so the refresh callback depends on the functions themselves.
  const { refetch: refetchAccounts } = accounts;
  const { refetch: refetchReview } = review;
  const setStatus = useSetPaymentAccountStatus(orgId);
  const detection = useSmsDetectionStatus(orgId);

  // Only the tone is derived here; the wording lives with the status itself so the
  // hub and the detection screen can never say different things.
  const detectionTone =
    detection.status === 'waiting' || detection.status === 'confirmed'
      ? 'success'
      : detection.status === 'unsupported_platform'
        ? 'neutral'
        : 'warning';

  useFocusEffect(
    useCallback(() => {
      void accounts.refetch();
      void review.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [orgId]),
  );

    const isLoading = accounts.isLoading && review.isLoading;
    const isError = accounts.isError && review.isError;

    /*
     * Pull-to-refresh, driven by the request rather than by a query flag.
     *
     * This screen used to combine the two queries with
     * `refreshing={(accounts.isFetching || review.isFetching) && !isLoading}`,
     * where `isLoading` was itself an `&&`. The moment the first of the two
     * resolved, `isLoading` was false while `isFetching` was true, so the
     * indicator animated unprompted on every cold mount -- and again on every
     * navigation, because the focus effect above refetches. `useRefresh` ties the
     * spinner to the seller's own gesture and clears it in a `finally`.
     */
    const refresh = useRefresh(
      useCallback(async () => {
        await Promise.all([refetchAccounts(), refetchReview()]);
      }, [refetchAccounts, refetchReview]),
    );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Payments"
        subtitle={organization?.name}
        right={
          canWrite ? (
            <IconButton
              onPress={() => router.push('/(app)/payment-account/new')}
              label="Connect a receiving account"
              tone="primary"
            >
              <Plus size={20} color={colors.primary} strokeWidth={2.25} />
            </IconButton>
          ) : undefined
        }
      />

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.sm,
            paddingBottom: insets.bottom + spacing.xxl,
            gap: spacing.lg,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          refreshControl={<SellflowRefreshControl {...refresh} />}
        >
        {isError ? (
          <ErrorState
            title={AppError.from(accounts.error ?? review.error).title}
            action={AppError.from(accounts.error ?? review.error).action}
            onRetry={() => {
              void accounts.refetch();
              void review.refetch();
            }}
          />
        ) : null}

        {/* ------------------------------------------------------ Needs review
          Placed first because it is the only thing here that is unfinished work.
          The empty state still renders, so a seller's eye learns where to look
          instead of wondering whether the row is missing. */}
        <View>
          <SectionHeader
            title="Needs review"
            actionLabel={review.count > 0 ? 'Open' : undefined}
            onActionPress={() => router.push('/(app)/payment-review')}
          />
          <Card>
            <View style={[styles.reviewRow, { gap: spacing.md }]}>
              <RowIcon tone={review.count > 0 ? 'warning' : 'success'}>
                {review.count > 0 ? (
                  <TriangleAlert size={18} color={colors.warningStrong} />
                ) : (
                  <Inbox size={18} color={colors.successStrong} />
                )}
              </RowIcon>

              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="subtitle">
                  {review.count > 0
                    ? `${review.count} payment${review.count === 1 ? '' : 's'} to check`
                    : 'Nothing to check'}
                </Text>
                <Text variant="caption" tone="muted">
                  {review.count > 0
                    ? 'Money arrived but was not matched to an order on its own.'
                    : 'Payments that need your confirmation will appear here.'}
                </Text>
              </View>

              {review.count > 0 ? (
                <Button
                  label="Review"
                  size="sm"
                  variant="secondary"
                  onPress={() => router.push('/(app)/payment-review')}
                />
              ) : null}
            </View>
          </Card>
        </View>

        {/* ------------------------------------------------ Automatic detection
          Above the accounts, because a seller who connects an account is the one
          most likely to want to know whether anything is watching it yet. */}
        <View>
          <SectionHeader
            title="Payment automation"
            actionLabel="Set up"
            onActionPress={() => router.push('/(app)/payment-sms')}
          />
          <Card>
            <View style={[styles.detectionRow, { gap: spacing.md }]}>
              <RowIcon tone={detectionTone}>
                {detectionTone === 'success' ? (
                  <RadioTower size={18} color={colors.successStrong} />
                ) : detectionTone === 'warning' ? (
                  <TriangleAlert size={18} color={colors.warningStrong} />
                ) : (
                  <RadioTower size={18} color={colors.textMuted} />
                )}
              </RowIcon>

              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="subtitle">{detectionCopy(detection.status).title}</Text>
                <Text variant="caption" tone="muted">
                  {detectionCopy(detection.status).body}
                </Text>
              </View>

              <Button
                label="Open"
                size="sm"
                variant="secondary"
                onPress={() => router.push('/(app)/payment-sms')}
              />
            </View>
          </Card>
        </View>

        {/* ------------------------------------------------------ Accounts */}
        <View>
          <SectionHeader
            title="Connected accounts"
            actionLabel={canWrite && accounts.accounts.length > 0 ? 'Add' : undefined}
            onActionPress={() => router.push('/(app)/payment-account/new')}
          />

          {isLoading ? (
            <View style={{ gap: spacing.xs }}>
              <ListRowSkeleton />
              <ListRowSkeleton />
            </View>
          ) : accounts.accounts.length === 0 ? (
            <Card>
              <EmptyState
                icon={Smartphone}
                title="No receiving account connected"
                description="Connect the bKash, Nagad, Rocket or Upay receiving number your customers pay into. Then an order can wait for the money."
                compact
                {...(canWrite
                  ? {
                      actionLabel: 'Connect a receiving account',
                      onActionPress: () => router.push('/(app)/payment-account/new'),
                    }
                  : {})}
              />
            </Card>
          ) : (
            <Card style={{ paddingVertical: 0 }}>
              {/*
                Management, not onboarding. Registration already created these, so
                this screen is where they are viewed and switched -- tapping one
                stops payments being matched against it without deleting it.
              */}
              {canWrite && accounts.accounts.length > 0 ? (
                <View style={{ paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: 0 }}>
                  <Text variant="micro" tone="muted">
                    Tap an account to switch it off or on.
                  </Text>
                </View>
              ) : null}
              {accounts.accounts.map((account, index) => {
                const Icon = providerIcon(account.provider);
                const active = account.is_active && account.status === 'connected';
                const pending = setStatus.isPending && setStatus.variables?.accountId === account.id;

                return (
                  <ListRow
                    key={account.id}
                    title={account.label ?? providerLabel(account.provider)}
                    subtitle={`${providerLabel(account.provider)} · ${maskPhone(account.account_number)}`}
                    leading={
                      <RowIcon tone={active ? 'info' : 'neutral'}>
                        <Icon
                          size={18}
                          color={active ? colors.primary : colors.textMuted}
                        />
                      </RowIcon>
                    }
                    chevron={false}
                    trailing={pending ? 'Saving…' : active ? 'Active' : account.is_active ? account.status : 'Off'}
                    trailingTone={active ? 'success' : 'muted'}
                    last={index === accounts.accounts.length - 1}
                    /*
                     * Tapping a connected account switches it off; tapping a
                     * disabled one brings it back. This is the
                     * `set_payment_account_status` RPC, which re-checks that the
                     * caller may write to the organisation -- so the button is a
                     * convenience, not the authorisation.
                     *
                     * It was previously exported and never called, which meant a
                     * seller who connected the wrong number had no way to stop
                     * payments being matched against it except deleting the row.
                     */
                    onPress={
                      canWrite
                        ? async () => {
                            const confirmed = await confirm(
                              active
                                ? {
                                    title: `Stop using this ${providerLabel(account.provider)} number?`,
                                    message:
                                      'Payments arriving here will no longer be matched to your orders. The account stays connected, so you can switch it back on at any time.',
                                    confirmLabel: 'Switch off',
                                  }
                                : {
                                    title: `Use this ${providerLabel(account.provider)} number again?`,
                                    message:
                                      'Payments arriving at this number will be matched to your orders again.',
                                    confirmLabel: 'Switch on',
                                  },
                            );
                            if (!confirmed) return;
                            try {
                              await setStatus.mutateAsync({
                                accountId: account.id,
                                status: 'connected',
                                isActive: !active,
                              });
                              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                            } catch {
                              // The error is on the mutation's own state; the
                              // trailing label reverts when the list refetches.
                              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                            }
                          }
                        : undefined
                    }
                  />
                );
              })}
            </Card>
          )}
        </View>

        {/* ------------------------------------------------------ Explanation */}
        <View>
          <SectionHeader title="How detection works" />
          <Card>
            <View style={{ gap: spacing.md }}>
              <HowRow
                icon={ScanLine}
                title="A payment can confirm itself"
                body="Only when the connected account, the exact amount and the customer's own number all agree — and exactly one order is waiting for it."
              />
              <HowRow
                icon={CircleSlash}
                title="Anything less waits for you"
                body="A matching amount is not proof of who paid, and two orders for the same amount are not a decision. Both go to the review queue instead of guessing."
              />
              <HowRow
                icon={ArrowRight}
                title="An order has to be waiting"
                body="Open an order and ask SellFlow to wait for the exact amount. That is what a detected payment is matched against."
              />
            </View>
          </Card>
        </View>
      </ScrollView>
    </View>
  );
}

function HowRow({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  const { colors, spacing } = useTheme();

  return (
    <View style={[styles.howRow, { gap: spacing.md }]}>
      <Icon size={18} color={colors.primary} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="caption">{title}</Text>
        <Text variant="micro" tone="muted">
          {body}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  reviewRow: { flexDirection: 'row', alignItems: 'center' },
  detectionRow: { flexDirection: 'row', alignItems: 'center' },
  howRow: { flexDirection: 'row', alignItems: 'flex-start' },
});