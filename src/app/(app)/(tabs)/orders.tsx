/**
 * Orders.
 *
 * Real rows scoped to the store in the session, with the two things a seller does
 * most here: find a specific order, and see what still needs attention.
 *
 * Search is by ORDER NUMBER only, not by customer name. That is the query layer's
 * behaviour and it is the right one here: order numbers are what a seller reads off
 * a slip or a courier SMS, and searching a customer name to answer "did I get that
 * order out?" returns a wall of orders to sift. Anyone looking for a person's orders
 * goes to that person's page, which has the full history.
 *
 * The empty state is designed rather than decorative, because every seller's first
 * visit here is empty and what that first screen says is what they conclude the
 * product is for.
 */

import { useRouter } from 'expo-router';
import { Receipt } from 'lucide-react-native';

import { ListScreen } from '@/components/ListScreen';
import { Badge, Card, SearchBar, Text } from '@/components/ui';
import { ORDER_STATUS_LABEL, orderStatusTone } from '@/features/orders/presentation';
import { useOrders, type OrderFilter } from '@/features/orders/queries';
import { formatMoney } from '@/lib/money';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';
import { Pressable, View } from 'react-native';

/**
 * The filters a seller actually uses.
 *
 * Deliberately short. `unpaid` is here because "who still owes me" is a daily
 * question; the rest are one tap away from the order itself.
 */
const FILTERS: { value: OrderFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'pending', label: 'Pending' },
  { value: 'shipped', label: 'In transit' },
  { value: 'delivered', label: 'Delivered' },
];

export default function OrdersScreen() {
  const { spacing } = useTheme();
  const router = useRouter();

  const storeId = useSession((state) => state.store?.id);
  const role = useSession((state) => state.role);

  const {
    orders,
    search,
    setSearch,
    filter,
    setFilter,
    isLoading,
    isError,
    error,
    refetch,
    hasMore,
    loadMore,
  } = useOrders(storeId);

  return (
    <ListScreen
      testID="orders-screen"
      title="Orders"
      subtitle={storeId ? undefined : 'Loading your store…'}
      icon={Receipt}
      isPending={isLoading}
      error={isError ? error : null}
      onRetry={() => void refetch()}
      onRefresh={() => void refetch()}
      actionLabel={canWrite(role) ? 'New order' : undefined}
      onAction={canWrite(role) ? () => router.push('/order/new') : undefined}
      emptyTitle={search.trim() ? 'No order matched' : 'No orders yet'}
      emptyDescription={
        search.trim()
          ? `Nothing matches “${search.trim()}”. Try the order number.`
          : 'Record your first order and it will appear here. You can paste a customer’s message and SellFlow will fill in the details.'
      }
      emptyActionLabel={search.trim() ? 'Clear search' : 'Record an order'}
      onEmptyAction={() => (search.trim() ? setSearch('') : router.push('/order/new'))}
      rows={
        <>
          <SearchBar
            value={search}
            onChangeText={setSearch}
            placeholder="Search order number"
            testID="orders-search"
          />

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
            {FILTERS.map((option) => (
              <Badge
                key={option.value}
                label={option.label}
                tone={filter === option.value ? 'primary' : 'neutral'}
                onPress={() => setFilter(option.value)}
                testID={`orders-filter-${option.value}`}
              />
            ))}
          </View>

          {orders.map((order) => (
            <Pressable
              key={order.id}
              onPress={() => router.push(`/order/${order.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`Order ${order.order_number}`}
              testID={`order-row-${order.id}`}
            >
              {({ pressed }) => (
                <Card
                  elevation="flat"
                  style={{
                    borderColor: 'transparent',
                    opacity: pressed ? 0.7 : 1,
                  }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: spacing.xs,
                    }}
                  >
                    <Text variant="bodyStrong">{order.customer_name ?? 'Walk-in customer'}</Text>
                    <Badge
                      label={ORDER_STATUS_LABEL[order.status]}
                      tone={orderStatusTone(order.status)}
                    />
                  </View>

                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: spacing.xxs,
                      gap: spacing.xs,
                    }}
                  >
                    <Text variant="caption" tone="muted">
                      {`#${order.order_number} · ${new Date(order.placed_at).toLocaleDateString()}`}
                    </Text>
                    <Text variant="numeric">{formatMoney(order.total)}</Text>
                  </View>

                  {/*
                   * Due is shown on the row, not buried in the detail. Under the
                   * `unpaid` filter this is the only reason the seller opened the tab.
                   */}
                  {order.total - order.amount_paid > 0 ? (
                    <Text
                      variant="caption"
                      tone="danger"
                      style={{ marginTop: spacing.xxs }}
                      testID={`order-due-${order.id}`}
                    >
                      {`${formatMoney(order.total - order.amount_paid)} due`}
                    </Text>
                  ) : null}
                </Card>
              )}
            </Pressable>
          ))}

          {hasMore ? (
            <Text
              variant="caption"
              tone="primary"
              accessibilityRole="button"
              onPress={loadMore}
              style={{ textAlign: 'center', paddingVertical: spacing.sm }}
              testID="orders-load-more"
            >
              Load more
            </Text>
          ) : null}
        </>
      }
    />
  );
}