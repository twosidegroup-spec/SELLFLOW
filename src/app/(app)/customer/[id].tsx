/**
 * Customer detail.
 *
 * Profile, lifetime value, outstanding balance and full order history. Spend
 * figures come from `get_customer_stats`, computed server-side so they can never
 * drift out of sync with the orders they are derived from.
 */

import { useCallback } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Archive, MapPin, Pencil, Phone, ReceiptText, ShoppingBag, Trash2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { ScreenHeader } from '@/components/ScreenHeader';
import {
  AmountRow,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  ListRow,
  ListRowSkeleton,
  Screen,
  SectionHeader,
  Text,
  confirm,
} from '@/components/ui';
import {
  useCustomer,
  useCustomerStats,
  useDeleteCustomer,
  useUpdateCustomer,
} from '@/features/customers/queries';
import { useCustomerOrders } from '@/features/orders/queries';
import { AppError } from '@/lib/errors';
import { formatRelativeDay } from '@/lib/format';
import { EXACT, formatMoney, money, type CurrencyCode } from '@/lib/money';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function CustomerDetailScreen() {
  const { colors, spacing } = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const customerId = params.id;

  const organization = useSession((state) => state.organization);
  const role = useSession((state) => state.role);
  const canWrite = role === 'owner' || role === 'manager';
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const customer = useCustomer(customerId);
  const stats = useCustomerStats(customerId);
  const orders = useCustomerOrders(customerId);
  const updateCustomer = useUpdateCustomer();
  const deleteCustomer = useDeleteCustomer();

  useFocusEffect(
    useCallback(() => {
      void customer.refetch();
      void stats.refetch();
      void orders.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [customerId]),
  );

  if (customer.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Customer" />
        <Screen>
          <ListRowSkeleton />
          <ListRowSkeleton />
        </Screen>
      </View>
    );
  }

  if (customer.isError || !customer.data) {
    const error = AppError.from(customer.error);
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Customer" />
        <Screen>
          <ErrorState title={error.title} action={error.action} onRetry={() => void customer.refetch()} />
        </Screen>
      </View>
    );
  }

  const data = customer.data;
  const s = stats.data;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title={data.name}
        subtitle={data.phone ?? undefined}
        right={
          canWrite ? (
            <Button
              label="Edit"
              variant="secondary"
              size="sm"
              icon={Pencil}
              onPress={() => router.push({ pathname: '/(app)/customer/new', params: { id: customerId } })}
            />
          ) : undefined
        }
      />

      <Screen>
        <View style={{ gap: spacing.xl, paddingTop: spacing.sm }}>
          {/* Value -------------------------------------------------------- */}
          <Card>
            <AmountRow
              label="Total spent"
              value={money(s?.total_spent ?? 0, currency)}
              currency={currency}
              size="lg"
            />
            {s && s.outstanding > 0 ? (
              <AmountRow
                label="Outstanding"
                value={money(s.outstanding, currency)}
                currency={currency}
                tone="danger"
                emphasis
              />
            ) : null}

            <Divider style={{ marginVertical: spacing.sm }} />

            {/*
          `alignItems` so the two stats sit on one baseline, and a `gap` so the
          right-hand value cannot touch the left label when the name is long.
        */}
        <View
          style={[
            styles.statRow,
            { justifyContent: 'space-between', gap: spacing.md },
          ]}
        >
              <View style={{ flex: 1 }}>
                <Text variant="micro" tone="muted">Orders</Text>
                <Text variant="numeric">{s?.order_count ?? 0}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="micro" tone="muted">Last order</Text>
                <Text variant="numeric" numberOfLines={1}>
                  {s?.last_order_at ? formatRelativeDay(s.last_order_at) : 'Never'}
                </Text>
              </View>
            </View>
          </Card>

          {/* Contact ------------------------------------------------------ */}
          {data.phone || data.address || data.notes || data.email ? (
            <View>
              <SectionHeader title="Details" />
              <Card flush>
                {data.phone ? (
                  <View style={{ paddingHorizontal: 4 }}>
                    <ListRow
                      title={data.phone}
                      leading={<Phone size={18} color={colors.textMuted} strokeWidth={2} />}
                      onPress={() => void Linking.openURL(`tel:${data.phone}`)}
                    />
                    <Divider />
                  </View>
                ) : null}

                {data.address ? (
                  <View style={{ paddingHorizontal: 4 }}>
                    <ListRow
                      title={data.address}
                      leading={<MapPin size={18} color={colors.textMuted} strokeWidth={2} />}
                      chevron={false}
                    />
                    <Divider />
                  </View>
                ) : null}

                {data.email ? (
                  <View style={{ paddingHorizontal: 4 }}>
                    <ListRow
                      title={data.email}
                      leading={<ShoppingBag size={18} color={colors.textMuted} strokeWidth={2} />}
                      onPress={() => void Linking.openURL(`mailto:${data.email}`)}
                      chevron={false}
                      last
                    />
                  </View>
                ) : null}
              </Card>

              {data.notes ? (
                <Card style={{ marginTop: spacing.sm }}>
                  <Text variant="caption" tone="secondary">{data.notes}</Text>
                </Card>
              ) : null}
            </View>
          ) : null}

          {/* Orders ------------------------------------------------------- */}
          <View>
            <SectionHeader title="Order history" />
            <Card flush>
              {orders.data && orders.data.length > 0 ? (
                orders.data.map((order, index) => (
                  <View key={order.id}>
                    <View style={{ paddingHorizontal: 4 }}>
                      <ListRow
                        title={order.order_number}
                        subtitle={`${formatRelativeDay(order.placed_at)} · ${order.payment_status}`}
                        trailing={formatMoney(money(order.total, currency), currency, EXACT)}
                        trailingTone={order.payment_status === 'paid' ? 'primary' : 'danger'}
                        onPress={() => router.push(`/(app)/order/${order.id}`)}
                        last={index === orders.data.length - 1}
                      />
                    </View>
                    {index < orders.data.length - 1 ? <Divider /> : null}
                  </View>
                ))
              ) : (
                <View style={{ padding: spacing.lg }}>
                  <EmptyState
                    icon={ReceiptText}
                    title="No orders yet"
                    description="Orders you create for this customer will be listed here."
                    compact
                    actionLabel={canWrite ? 'Create an order' : undefined}
                    onActionPress={canWrite ? () => router.push('/(app)/order/new') : undefined}
                  />
                </View>
              )}
            </Card>
          </View>

          {/* Manage ------------------------------------------------------- */}
          {canWrite ? (
            <View>
              <SectionHeader title="Manage" />
              <Card style={{ gap: spacing.sm }}>
                <Text variant="caption" tone="muted">
                  Archiving hides this customer from pickers and lists. Their order history stays intact.
                </Text>
                <Button
                  label={data.is_archived ? 'Restore customer' : 'Archive customer'}
                  icon={Archive}
                  variant="secondary"
                  block
                  onPress={async () => {
                    const confirmed = await confirm({
                      title: data.is_archived ? 'Restore this customer?' : 'Archive this customer?',
                      confirmLabel: data.is_archived ? 'Restore' : 'Archive',
                      destructive: !data.is_archived,
                    });
                    if (!confirmed) return;

                    try {
                      await updateCustomer.mutateAsync({
                        customerId,
                        input: { is_archived: !data.is_archived },
                      });
                      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      if (!data.is_archived) router.back();
                    } catch {
                      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                    }
                  }}
                />

                <Text variant="micro" tone="muted">
                  Deleting is for customers who have never ordered. Someone with orders is
                  kept, because removing them would turn their sales into walk-in sales.
                </Text>

                <Button
                  label="Delete customer"
                  icon={Trash2}
                  variant="danger"
                  block
                  onPress={async () => {
                    const confirmed = await confirm({
                      title: 'Delete this customer?',
                      message:
                        'This cannot be undone. If they have ordered you will be asked to ' +
                        'archive them instead, so your sales history stays correct.',
                      confirmLabel: 'Delete',
                      destructive: true,
                    });
                    if (!confirmed) return;

                    try {
                      await deleteCustomer.mutateAsync(customerId);
                      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      router.back();
                    } catch (error) {
                      // A refusal here is a normal answer, not a failure: the
                      // server counts their orders and says what to do instead.
                      const refusal = AppError.from(error);
                      await confirm({
                        title: refusal.title,
                        message: refusal.action,
                        confirmLabel: 'OK',
                      });
                      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                    }
                  }}
                />
              </Card>
            </View>
          ) : null}
        </View>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  statRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
});