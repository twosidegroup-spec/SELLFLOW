/**
 * Customer detail: who they are, what they owe, and what they have ordered.
 *
 * The headline is OUTSTANDING, not total spent. A seller's first question when a
 * customer walks in is "do they still owe me anything", and that number has to be
 * visible without scrolling past a lifetime spend total.
 *
 * The customer id comes from the route but is never treated as authority: the reads
 * run under the caller's RLS, so a crafted id from another tenant returns nothing
 * rather than another seller's customer.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { Package, Pencil } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  DetailRow,
  ErrorState,
  LoadingState,
  Screen,
  SectionHeader,
  Text,
} from '@/components/ui';
import { useCustomer, useCustomerStats } from '@/features/customers/queries';
import { ORDER_STATUS_LABEL, orderStatusTone } from '@/features/orders/presentation';
import { useCustomerOrders } from '@/features/orders/queries';
import { formatMoney } from '@/lib/money';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function CustomerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, spacing } = useTheme();

  const role = useSession((state) => state.role);
  const editable = canWrite(role);

  const customer = useCustomer(id);
  const stats = useCustomerStats(id);
  const orders = useCustomerOrders(id);

  if (customer.isLoading) return <LoadingState label="Loading customer" />;

  if (customer.isError || !customer.data) {
    return (
      <ErrorState
        title="Could not load this customer"
        action="Check your connection and try again."
        onRetry={() => void customer.refetch()}
      />
    );
  }

  const row = customer.data;
  const s = stats.data;
  const address = [row.address, row.thana, row.district].filter(Boolean).join(', ');

  return (
    <Screen
      testID="customer-detail"
      width="form"
      edges={['top']}
      header={
        editable ? (
          <Button
            variant="ghost"
            label="Edit"
            icon={Pencil}
            onPress={() => router.push(`/customer/${row.id}/edit`)}
            testID="customer-edit"
          />
        ) : null
      }
    >
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">{row.name}</Text>
          {row.is_archived ? (
            <Badge label="Archived" tone="neutral" testID="customer-archived" />
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Card elevation="flat" style={{ flex: 1 }}>
            <Text variant="caption" tone="muted">
              Outstanding
            </Text>
            <Text
              variant="numeric"
              tone={s && s.outstanding > 0 ? 'danger' : 'default'}
              testID="customer-outstanding"
            >
              {/* Stats load on their own query, so an explicit dash beats a
                  misleading ৳0.00 for the moment it has not arrived. */}
              {s ? formatMoney(s.outstanding) : '—'}
            </Text>
          </Card>
          <Card elevation="flat" style={{ flex: 1 }}>
            <Text variant="caption" tone="muted">
              Orders
            </Text>
            <Text variant="numeric">{s ? s.order_count : '—'}</Text>
          </Card>
          <Card elevation="flat" style={{ flex: 1 }}>
            <Text variant="caption" tone="muted">
              Total spent
            </Text>
            <Text variant="numeric">{s ? formatMoney(s.total_spent) : '—'}</Text>
          </Card>
        </View>

        <Card>
          <View style={{ gap: spacing.md }}>
            <View testID="customer-detail-phone">
              <DetailRow
                label="Phone"
                value={row.phone ?? 'Not recorded'}
                tone={row.phone ? 'default' : 'muted'}
                numeric
              />
            </View>
            {/*
             * Address lines stay separate rather than pre-joined. A courier reads this
             * aloud over the phone, and "House 4, Road 7, Mirpur, Dhaka" parsed
             * differently by two people is a failed delivery.
             */}
            <View testID="customer-detail-address">
              <DetailRow
                label="Address"
                value={address || 'Not recorded'}
                tone={address ? 'default' : 'muted'}
                multiline
              />
            </View>
            {row.notes ? (
              <DetailRow label="Notes" value={row.notes} multiline />
            ) : null}
          </View>
        </Card>

        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Order history" />

          {orders.isLoading ? (
            <LoadingState label="Loading orders" />
          ) : !orders.data || orders.data.length === 0 ? (
            <Card elevation="flat">
              <View style={{ alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm }}>
                <Package size={20} color={colors.textMuted} strokeWidth={1.5} />
                <Text variant="caption" tone="muted" testID="customer-no-orders">
                  No orders yet.
                </Text>
              </View>
            </Card>
          ) : (
            <View style={{ gap: spacing.xs }}>
              {orders.data.map((order) => (
                <Pressable
                  key={order.id}
                  onPress={() => router.push(`/order/${order.id}`)}
                  testID={`customer-order-${order.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Order ${order.order_number}`}
                >
                  {({ pressed }) => (
                    <Card elevation="flat" style={pressed ? { opacity: 0.7 } : undefined}>
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: spacing.xs,
                        }}
                      >
                        <Text variant="bodyStrong">#{order.order_number}</Text>
                        <Badge label={ORDER_STATUS_LABEL[order.status]} tone={orderStatusTone(order.status)} />
                      </View>
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginTop: spacing.xxs,
                        }}
                      >
                        <Text variant="caption" tone="muted">
                          {new Date(order.placed_at).toLocaleDateString()}
                        </Text>
                        <Text variant="caption">{formatMoney(order.total)}</Text>
                      </View>
                    </Card>
                  )}
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </View>
    </Screen>
  );
}