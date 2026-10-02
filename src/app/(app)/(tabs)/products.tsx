/**
 * Products list.
 *
 * Infinite-scrolling catalogue with server-side search. Each row shows price,
 * cost, margin and stock, because that is what a seller actually needs when
 * scanning their catalogue -- not a thumbnail grid with no numbers.
 */

import { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Boxes, PackageSearch, Plus, Search, Trash2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useDeleteProduct } from '@/features/products/mutations';
import { AppError } from '@/lib/errors';

import { IconButton, ScreenHeader } from '@/components/ScreenHeader';
import {
  Badge,
  EmptyState,
  ErrorState,
  FilterChip,
  ListRowSkeleton,
  Screen,
  SearchBar,
  Text,
  confirm,
} from '@/components/ui';
import { useProducts, type ProductWithStock } from '@/features/products/queries';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';
import { EXACT, formatMoney, money, type CurrencyCode } from '@/lib/money';

export default function ProductsScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const store = useSession((state) => state.store);
  const organization = useSession((state) => state.organization);
  const role = useSession((state) => state.role);
  const canWrite = role === 'owner' || role === 'manager';
  const deleteProduct = useDeleteProduct();

  /**
   * Deleting from the list, with the same refusal the detail screen shows: a
   * product that has been sold cannot be removed, because order_items would
   * quietly drop its link and the seller's history would stop reconciling.
   */
  const removeProduct = async (product: ProductWithStock) => {
    const confirmed = await confirm({
      title: `Delete ${product.name}?`,
      message:
        'This cannot be undone. If it has been sold you will be asked to archive it ' +
        'instead, so your sales history stays correct.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await deleteProduct.mutateAsync(product.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      const refusal = AppError.from(error);
      await confirm({ title: refusal.title, message: refusal.action, confirmLabel: 'OK' });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  };
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const products = useProducts(store?.id);
  const params = useLocalSearchParams<{ filter?: string }>();

  useFocusEffect(
    useCallback(() => {
      if (params.filter === 'low') products.setIncludeArchived(false);
      void products.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params.filter]),
  );

  const isFilteredEmpty =
    !products.isLoading && products.products.length === 0 && products.search.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Products"
        subtitle={store?.name}
        showBack={false}
        right={
          canWrite ? (
            <IconButton onPress={() => router.push('/(app)/product/new')} label="Add product" tone="primary">
              <Plus size={20} color={colors.primary} strokeWidth={2.25} />
            </IconButton>
          ) : undefined
        }
      />

      <Screen
        scroll={false}
        onRefresh={() => void products.refetch()}
        refreshing={products.isFetching && !products.isLoading}
        contentStyle={{ flex: 1, paddingHorizontal: 0, paddingBottom: 0 }}
      >
        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.sm, paddingTop: spacing.sm }}>
          <SearchBar
            value={products.search}
            onChangeText={products.setSearch}
            placeholder="Search name or SKU"
          />
          <View style={{ flexDirection: 'row', gap: spacing.xs }}>
            <FilterChip
              label="Active"
              selected={!products.includeArchived}
              onPress={() => products.setIncludeArchived(false)}
            />
            <FilterChip
              label="Archived"
              selected={products.includeArchived}
              onPress={() => products.setIncludeArchived(true)}
            />
          </View>
        </View>

        <FlatList
          data={products.products}
          keyExtractor={(item) => item.id}
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.md,
            paddingBottom: insets.bottom + 24,
            flexGrow: 1,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onEndReached={products.loadMore}
          onEndReachedThreshold={0.5}
          renderItem={({ item }) => (
            <ProductCard
        product={item}
        currency={currency}
        canWrite={canWrite}
        remove={removeProduct}
      />
          )}
          ListEmptyComponent={
            products.isLoading ? (
              <View style={{ gap: spacing.xs }}>
                {[0, 1, 2, 3, 4].map((key) => (
                  <ListRowSkeleton key={key} />
                ))}
              </View>
            ) : products.isError ? (
              <ErrorState
                title={AppError.from(products.error).title}
                action={AppError.from(products.error).action}
                onRetry={() => void products.refetch()}
              />
            ) : isFilteredEmpty ? (
              <EmptyState
                icon={Search}
                title="No matching products"
                description={`Nothing matches "${products.search}".`}
                compact
                actionLabel="Clear search"
                onActionPress={() => products.setSearch('')}
              />
            ) : products.includeArchived ? (
              <EmptyState
                icon={PackageSearch}
                title="No archived products"
                description="Products you archive will appear here."
              />
            ) : (
              <EmptyState
                icon={Boxes}
                title="No products yet"
                description="Add what you sell. Prices, cost and stock all live here, and orders update stock automatically."
                actionLabel={canWrite ? 'Add your first product' : undefined}
                onActionPress={canWrite ? () => router.push('/(app)/product/new') : undefined}
              />
            )
          }
        />
      </Screen>
    </View>
  );
}

function ProductCard({
  product,
  currency,
  canWrite,
  remove,
}: {
  product: ProductWithStock;
  currency: CurrencyCode;
  canWrite: boolean;
  remove: (product: ProductWithStock) => Promise<void>;
}) {
  const { colors, spacing, radius, elevation } = useTheme();

  const price = money(product.selling_price, currency);
  const cost = product.cost_price === null ? null : money(product.cost_price, currency);
  const margin = cost === null ? null : price - cost;
  const marginPercent = cost === null || price === 0 ? null : Math.round((margin! / price) * 100);

  const isLow = product.track_inventory && product.low_stock_threshold > 0 && product.quantity <= product.low_stock_threshold;
  const outOfStock = product.track_inventory && product.quantity <= 0;

  return (
    <Pressable
      onPress={() => router.push(`/(app)/product/${product.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${formatMoney(price, currency, EXACT)}`}
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
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text variant="subtitle" numberOfLines={1}>
            {product.name}
          </Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {[product.sku, product.category].filter(Boolean).join(' · ') || 'No SKU'}
          </Text>
        </View>

        <View style={{ alignItems: 'flex-end', gap: 3 }}>
          <Text variant="numeric">{formatMoney(price, currency, EXACT)}</Text>
          {cost !== null ? (
            <Text variant="micro" tone="muted">
              Cost {formatMoney(cost, currency, EXACT)}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={[styles.footer, { marginTop: spacing.sm }]}>
        {outOfStock ? (
          <Badge label="Out of stock" tone="danger" />
        ) : isLow ? (
          <Badge label={`${product.quantity} left`} tone="warning" />
        ) : product.track_inventory ? (
          <Badge label={`${product.quantity} in stock`} tone="neutral" />
        ) : (
          <Badge label="Stock not tracked" tone="neutral" />
        )}

        {margin !== null ? (
          <Text
            variant="micro"
            tone={margin >= 0 ? 'success' : 'danger'}
          >
            {margin >= 0 ? '+' : ''}
            {formatMoney(margin, currency, EXACT)}
            {marginPercent !== null ? ` (${marginPercent}%)` : ''} margin
          </Text>
        ) : (
          <Text variant="micro" tone="muted">No cost set</Text>
        )}

        {product.is_archived ? <Badge label="Archived" tone="neutral" /> : null}

        {canWrite ? (
          <IconButton
            onPress={() => void remove(product)}
            label={`Delete ${product.name}`}
            tone="danger"
          >
            <Trash2 size={16} color={colors.textMuted} />
          </IconButton>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
});
