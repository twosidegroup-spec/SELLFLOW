/**
 * Product list.
 *
 * Replaces the placeholder tab screen. Search is debounced and server-side, because
 * a seller with a few thousand products must not be handed every row to filter on
 * the phone.
 *
 * ARCHIVED PRODUCTS ARE A MODE, NOT A FILTER CHIP
 *
 * `is_archived` is excluded by the query, so archived items are invisible by default.
 * They are not gone and they are not silently filtered away -- there is an explicit
 * control to show them, and an archived product says so on its card. A seller who
 * archived something and cannot find it again has lost it in their own catalogue.
 */

import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Archive, Package } from 'lucide-react-native';

import { ListScreen } from '@/components/ListScreen';
import { Badge, Card, SearchBar, Text } from '@/components/ui';
import { formatMajorUnits } from '@/lib/money';
import { useProducts } from '@/features/products/queries';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function ProductsScreen() {
  const router = useRouter();

  const storeId = useSession((state) => state.store?.id);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const {
    products,
    setSearch: setServerSearch,
    includeArchived,
    setIncludeArchived,
    isLoading,
    isError,
    error,
    refetch,
  } = useProducts(storeId);

  /*
   * The search field and the query are the same value, debounced by the query layer.
   * Held locally so the field responds on every keystroke while the request does
   * not: firing a query per character is what makes search feel laggy and wastes the
   * seller's data allowance.
   */
  const onSearch = (next: string) => {
    setSearch(next);
    setServerSearch(next);
  };

  const onToggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    setIncludeArchived(next);
  };

  const subtitle = useMemo(() => {
    if (!search.trim()) return `${products.length} item${products.length === 1 ? '' : 's'}`;
    return `${products.length} match${products.length === 1 ? '' : 'es'} for "${search.trim()}"`;
  }, [products.length, search]);

  return (
    <ListScreen
      testID="products-screen"
      title="Stock"
      subtitle={subtitle}
      icon={Package}
      isPending={isLoading}
      error={isError ? error : null}
      onRetry={() => void refetch()}
      onRefresh={() => void refetch()}
      actionLabel="Add product"
      onAction={() => router.push('/product/new')}
      emptyTitle={search.trim() ? 'Nothing matched' : 'No products yet'}
      emptyDescription={
        search.trim()
          ? `No product matches "${search.trim()}". Check the spelling, or search by SKU instead.`
          : 'Add what you sell so orders can draw stock from it automatically.'
      }
      emptyActionLabel={search.trim() ? 'Clear search' : 'Add a product'}
      onEmptyAction={() => {
        if (search.trim()) onSearch('');
        else router.push('/product/new');
      }}
      rows={
        <>
          <SearchBar
            value={search}
            onChangeText={onSearch}
            placeholder="Search by name or SKU"
            testID="products-search"
          />

          <ArchivedToggle
            active={showArchived || includeArchived}
            onPress={onToggleArchived}
          />

          {products.map((product) => (
            <ProductCard
              key={product.id}
              id={product.id}
              name={product.name}
              sku={product.sku}
              category={product.category}
              sellingPrice={product.selling_price}
              costPrice={product.cost_price}
              available={product.quantity}
              lowStockThreshold={product.low_stock_threshold}
              archived={product.is_archived}
              onPress={() => router.push(`/product/${product.id}`)}
            />
          ))}
        </>
      }
    />
  );
}

function ArchivedToggle({ active, onPress }: { active: boolean; onPress: () => void }) {
  const { spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.xs }}>
      <Badge
        label={active ? 'Showing archived' : 'Archived hidden'}
        icon={Archive}
        tone={active ? 'warning' : 'neutral'}
        onPress={onPress}
        testID="products-toggle-archived"
      />
    </View>
  );
}

function ProductCard({
  id,
  name,
  sku,
  category,
  sellingPrice,
  costPrice,
  available,
  lowStockThreshold,
  archived,
  onPress,
}: {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  sellingPrice: number;
  costPrice: number | null;
  available: number | null;
  lowStockThreshold: number;
  archived: boolean;
  onPress: () => void;
}) {
  const { spacing } = useTheme();

  /*
   * "Not recorded" rather than ৳0.00 for an unknown cost. Zero would read as "free to
   * make", which is a claim the app has no basis for, and it would silently flow
   * into the profit figure on the detail screen.
   */
  const lowStock = available !== null && lowStockThreshold > 0 && available <= lowStockThreshold;

  return (
    <Card elevation="flat" style={{ borderColor: archived ? 'transparent' : undefined }}>
      <View style={{ gap: spacing.xs }}>
        <Text
          variant="bodyStrong"
          accessibilityRole="button"
          onPress={onPress}
          testID={`product-${id}`}
        >
          {name}
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
          {sku ? (
            <Text variant="caption" tone="muted">
              {sku}
            </Text>
          ) : null}
          {category ? (
            <Text variant="caption" tone="muted">
              {category}
            </Text>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Text variant="numeric">{formatMajorUnits(sellingPrice)}</Text>

          {archived ? (
            <Badge label="ARCHIVED" tone="neutral" />
          ) : lowStock ? (
            <Badge label={`${available} LEFT`} tone="warning" />
          ) : available !== null ? (
            <Badge label={`${available} in stock`} tone="neutral" />
          ) : null}

          {costPrice === null ? (
            <Text variant="caption" tone="muted">
              Cost not recorded
            </Text>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
