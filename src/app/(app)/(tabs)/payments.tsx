/**
 * Payments — the seller's receiving methods and recent detected money.
 *
 * This is the screen that carries the product's central claim, so it states it in
 * words rather than implying it: SellFlow works with the numbers the seller already
 * uses, and it is not a bank, a wallet, or a payment processor.
 *
 * Two real queries, both scoped by the organization from the SESSION rather than by
 * anything a route can supply.
 */

import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Radio, Wallet } from 'lucide-react-native';

import { Card, ErrorState, LoadingState, Screen, Skeleton, Text } from '@/components/ui';
import { usePaymentAccounts, usePaymentActivity } from '@/features/payments/queries';
import { providerLabel } from '@/features/payments/queries';
import { formatMoney } from '@/lib/money';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function PaymentsScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();

  const orgId = useSession((state) => state.organization?.id);
  const role = useSession((state) => state.role);

  const accounts = usePaymentAccounts(orgId);
  const activity = usePaymentActivity(orgId);

  const loading = accounts.isLoading || activity.isLoading;
  const failure = accounts.isError ? accounts.error : activity.isError ? activity.error : null;

  if (failure) {
    return (
      <ErrorState
        title="Could not load your payments"
        action="Check your connection and try again."
        onRetry={() => {
          void accounts.refetch();
          void activity.refetch();
        }}
      />
    );
  }

  const connected = accounts.accounts;
  const events = activity.events;

  return (
    <Screen testID="payments-screen" edges={['top']}>
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">Payments</Text>
          <Text variant="caption" tone="muted">
            SellFlow uses the payment numbers you already have. It is not a bank or a wallet.
          </Text>
        </View>

        {/* ---- Receiving methods ---- */}
        <View style={{ gap: spacing.sm }}>
          <Text variant="micro" tone="muted">
            YOUR RECEIVING NUMBERS
          </Text>

          {loading ? (
            <Skeleton width="100%" height={72} borderRadius={radius.card} />
          ) : connected.length === 0 ? (
            <Card>
              <View style={{ gap: spacing.xs, alignItems: 'flex-start' }}>
                <Wallet size={20} color={colors.textMuted} strokeWidth={1.75} />
                <Text variant="bodyStrong">No payment method connected</Text>
                <Text variant="caption" tone="muted">
                  Connect the bKash, Nagad or Rocket number customers already pay you on.
                </Text>
              </View>
            </Card>
          ) : (
            connected.map((account) => (
              <Card key={account.id} elevation="flat">
                <View style={{ gap: spacing.xxs }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Text variant="bodyStrong">{providerLabel(account.provider)}</Text>
                    <Text
                      variant="micro"
                      tone={account.status === 'connected' ? 'success' : 'muted'}
                    >
                      {account.status.toUpperCase()}
                    </Text>
                  </View>
                  <Text variant="numeric">{account.account_number}</Text>
                </View>
              </Card>
            ))
          )}

          {canWrite(role) ? (
            <Text
              variant="caption"
              tone="primary"
              accessibilityRole="button"
              onPress={() => router.push('/payment-account/new')}
            >
              Add a payment method
            </Text>
          ) : null}
        </View>

        {/* ---- Recent detected money ---- */}
        <View style={{ gap: spacing.sm }}>
          <Text variant="micro" tone="muted">
            RECENTLY DETECTED
          </Text>

          {loading ? (
            <Skeleton width="100%" height={96} borderRadius={radius.card} />
          ) : events.length === 0 ? (
            <Card>
              <View style={{ gap: spacing.xs, alignItems: 'flex-start' }}>
                <Radio size={20} color={colors.textMuted} strokeWidth={1.75} />
                <Text variant="bodyStrong">Nothing detected yet</Text>
                <Text variant="caption" tone="muted">
                  When a customer pays you, the notification is matched to the order here. Until
                  then you can record payments by hand from any order.
                </Text>
              </View>
            </Card>
          ) : (
            events.map((event) => (
              <Card key={event.id} elevation="flat">
                <View style={{ gap: spacing.xxs }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Text variant="bodyStrong">
                      {event.provider === null
                        ? 'Payment'
                        : providerLabel(event.provider)}
                    </Text>
                    <Text variant="numeric">{formatMoney(event.amount)}</Text>
                  </View>
                  <Text variant="caption" tone="muted">
                    {event.matched_intent_id === null
                      ? 'Not matched to an order yet'
                      : 'Matched to an order'}
                  </Text>
                </View>
              </Card>
            ))
          )}
        </View>
      </View>
    </Screen>
  );
}