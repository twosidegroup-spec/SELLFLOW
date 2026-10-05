/**
 * Orders.
 *
 * Real rows from `orders`, scoped to the store in the session. The empty state is
 * designed rather than decorative, because every seller's first visit here is empty
 * and what that first screen says is what they conclude the product is for.
 */

import { useRouter } from 'expo-router';

import { ListScreen } from '@/components/ListScreen';
import { Card, Text } from '@/components/ui';
import { useOrders } from '@/features/orders/queries';
import { formatMoney } from '@/lib/money';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';
import { Receipt } from 'lucide-react-native';

export default function OrdersScreen() {
  const { spacing } = useTheme();
  const router = useRouter();

  const storeId = useSession((state) => state.store?.id);
  const role = useSession((state) => state.role);

  const { orders, isLoading, isError, error, refetch } = useOrders(storeId);

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
      rows={
        orders.length > 0
          ? orders.map((order) => (
              <Card
                key={order.id}
                elevation="flat"
                style={{ borderColor: 'transparent' }}
              >
                <Text
                  variant="bodyStrong"
                  accessibilityRole="button"
                  onPress={() => router.push(`/order/${order.id}`)}
                >
                  {order.customer_name ?? 'Walk-in customer'}
                </Text>
                <Text variant="caption" tone="muted">
                  {order.order_number}
                </Text>
                <Text variant="numeric" style={{ marginTop: spacing.xs }}>
                  {formatMoney(order.total)}
                </Text>
              </Card>
            ))
          : undefined
      }
      emptyTitle="No orders yet"
      emptyDescription="Record your first order and it will appear here. You can paste a customer's message and SellFlow will fill in the details."
      emptyActionLabel="Record an order"
      onEmptyAction={() => router.push('/order/new')}
    />
  );
}