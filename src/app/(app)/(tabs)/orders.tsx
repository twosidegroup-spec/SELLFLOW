/**
 * Orders list.
 *
 * Paginated, searchable and filterable, with the status filter synced to the
 * URL so a deep link from the dashboard ("3 orders to ship") lands on the right
 * tab already filtered.
 *
 * The filter chip row is the primary control -- sellers think in terms of
 * "pending", "to ship", "unpaid" far more than "by date range".
 */

import { useCallback, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, ReceiptText, Search } from 'lucide-react-native';

import { IconButton, ScreenHeader } from '@/components/ScreenHeader';
import {
  Amount,
  Badge,
  EmptyState,
  ErrorState,
  FilterChip,
  ListRowSkeleton,
  OrderStatusBadge,
  PaymentStatusBadge,
  SearchBar,
  Text,
} from '@/components/ui';
import { useOrders, type OrderFilter, type OrderListItem } from '@/features/orders/queries';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';
import { AppError } from '@/lib/errors';
import { formatRelativeDay } from '@/lib/format';
import { money, type CurrencyCode } from '@/lib/money';

const FILTERS: { value: OrderFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'processing', label: 'Processing' },
  { value: 'packaging', label: 'Packaging' },
  { value: 'packed', label: 'Packed' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'on_delivery', label: 'On delivery' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'failed_delivery', label: 'Failed' },
  { value: 'unpaid', label: 'Unpaid' },
];

export default function OrdersScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const store = useSession((state) => state.store);
  const organization = useSession((state) => state.organization);
  const role = useSession((state) => state.role);
  const canWrite = role === 'owner' || role === 'manager';
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const params = useLocalSearchParams<{ filter?: string }>();
  const orders = useOrders(store?.id);
  const { setFilter, filter, refetch } = orders;

  // Deep link from the dashboard, e.g. /orders?filter=pending
  const initialFilter = useMemo<OrderFilter>(() => {
    const value = params.filter;
    return FILTERS.some((option) => option.value === value) ? (value as OrderFilter) : 'all';
  }, [params.filter]);

  useFocusEffect(
    useCallback(() => {
      if (initialFilter !== 'all' && filter === 'all') setFilter(initialFilter);
      void refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialFilter]),
  );

  const isEmpty = !orders.isLoading && orders.orders.length === 0;
  const isFilteredEmpty = isEmpty && (filter !== 'all' || orders.search.length > 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Orders"
        subtitle={store?.name}
        showBack={false}
        right={
          canWrite ? (
            <IconButton
              onPress={() => router.push('/(app)/order/new')}
              label="Create order"
              tone="primary"
            >
              <Plus size={20} color={colors.primary} strokeWidth={2.25} />
            </IconButton>
          ) : undefined
        }
      />

      <FlatList
        data={orders.orders}
        keyExtractor={(item) => item.id}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingBottom: insets.bottom + 96,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onRefresh={() => void orders.refetch()}
        refreshing={orders.isFetching && !orders.isLoading}
        onEndReached={orders.loadMore}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <View style={{ gap: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.md }}>
            <SearchBar
              value={orders.search}
              onChangeText={orders.setSearch}
              placeholder="Search order number"
            />
            <FilterRow value={filter} onChange={setFilter} />
          </View>
        }
        renderItem={({ item }) => <OrderCard order={item} currency={currency} />}
        ListEmptyComponent={
          orders.isLoading ? (
            <View style={{ paddingTop: spacing.sm }}>
              <ListRowSkeleton />
              <ListRowSkeleton />
              <ListRowSkeleton />
              <ListRowSkeleton />
            </View>
          ) : orders.isError ? (
            <ErrorState
              title={AppError.from(orders.error).title}
              action={AppError.from(orders.error).action}
              onRetry={() => void orders.refetch()}
            />
          ) : isFilteredEmpty ? (
            <EmptyState
              icon={Search}
              title="No matching orders"
              description="Try a different search term or clear the filter."
              compact
              actionLabel="Clear filters"
              onActionPress={() => {
                orders.setSearch('');
                setFilter('all');
              }}
            />
          ) : (
            <EmptyState
              icon={ReceiptText}
              title="No orders yet"
              description="When you record a sale it will appear here, with its status, payment and profit."
              actionLabel={canWrite ? 'Create your first order' : undefined}
              onActionPress={canWrite ? () => router.push('/(app)/order/new') : undefined}
            />
          )
        }
      />
    </View>
  );
}

/**
 * The status filter row.
 *
 * Uses the shared `FilterChip` rather than wrapping a `Badge`. A badge is a
 * status tag and has no hit area of its own; as a filter control it rendered
 * 24px tall while the identical Active/Archived chips on Products and Customers
 * were 36px, so the same gesture looked different on two tabs.
 */
function FilterRow({
  value,
  onChange,
}: {
  value: OrderFilter;
  onChange: (value: OrderFilter) => void;
}) {
  return (
    <FlatList
      horizontal
      data={FILTERS}
      keyExtractor={(item) => item.value}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8 }}
      renderItem={({ item }) => (
        <FilterChip
          label={item.label}
          selected={item.value === value}
          onPress={() => onChange(item.value)}
        />
      )}
    />
  );
}

function OrderCard({ order, currency }: { order: OrderListItem; currency: CurrencyCode }) {
  const { colors, spacing, radius, elevation } = useTheme();

  return (
    <Pressable
      onPress={() => router.push(`/(app)/order/${order.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`Order ${order.order_number}, ${order.customer_name ?? 'walk-in customer'}`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderRadius: radius.card,
          padding: spacing.md,
          marginBottom: spacing.xs,
          opacity: pressed ? 0.75 : 1,
        },
        elevation.card,
      ]}
    >
      <View style={styles.cardTop}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="subtitle">{order.order_number}</Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {order.customer_name ?? 'Walk-in customer'}
          </Text>
        </View>

        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <Amount value={money(order.total, currency)} currency={currency} />
          <Text variant="micro" tone="muted">
            {formatRelativeDay(order.placed_at)}
          </Text>
        </View>
      </View>

      <View style={[styles.cardBottom, { marginTop: spacing.sm }]}>
        <OrderStatusBadge status={order.status} />
        {order.is_cod ? <Badge label="COD" tone="warning" /> : null}
        {order.payment_status !== 'paid' ? (
          <PaymentStatusBadge status={order.payment_status} />
        ) : null}
        {order.tracking_id ? (
          <Text variant="micro" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
            {order.courier_name ?? 'Courier'} {order.tracking_id}
          </Text>
        ) : order.profit < 0 ? (
          <Text variant="micro" tone="danger" numberOfLines={1} style={{ flex: 1 }}>
            Sold below cost
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  cardBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
});
