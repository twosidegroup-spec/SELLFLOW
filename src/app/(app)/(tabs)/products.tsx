/**
 * Stock — the seller's catalogue.
 *
 * Real rows from `products`. Read-only staff see the catalogue without the "Add
 * product" button, which would otherwise be a control that always fails.
 */

import { useRouter } from 'expo-router';
import { Package } from 'lucide-react-native';

import { ListScreen } from '@/components/ListScreen';
import { Card, Text } from '@/components/ui';
import { useProducts } from '@/features/products/queries';
import { formatMoney } from '@/lib/money';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function ProductsScreen() {
  const { spacing } = useTheme();
  const router = useRouter();

  const storeId = useSession((state) => state.store?.id);
  const role = useSession((state) => state.role);

  const { products, isLoading, isError, error, refetch } = useProducts(storeId);

  return (
    <ListScreen
      testID="products-screen"
      title="Stock"
      icon={Package}
      isPending={isLoading}
      error={isError ? error : null}
      onRetry={() => void refetch()}
      onRefresh={() => void refetch()}
      actionLabel={canWrite(role) ? 'Add product' : undefined}
      onAction={canWrite(role) ? () => router.push('/product/new') : undefined}
      rows={
        products.length > 0
          ? products.map((product) => (
              <Card key={product.id} elevation="flat" style={{ borderColor: 'transparent' }}>
                <Text
                  variant="bodyStrong"
                  accessibilityRole="button"
                  onPress={() => router.push(`/product/${product.id}`)}
                >
                  {product.name}
                </Text>
                {product.sku ? (
                  <Text variant="caption" tone="muted">
                    {product.sku}
                  </Text>
                ) : null}
                <Text variant="numeric" style={{ marginTop: spacing.xs }}>
                  {formatMoney(product.selling_price)}
                </Text>
                {/*
                 * A missing cost price is shown as such, never as zero. Zero would
                 * read as "this product is free to make", which is a different and
                 * materially wrong claim.
                 */}
                {product.cost_price === null || product.cost_price === undefined ? (
                  <Text variant="caption" tone="muted">
                    Cost not recorded
                  </Text>
                ) : null}
              </Card>
            ))
          : undefined
      }
      emptyTitle="No products yet"
      emptyDescription="Add what you sell so orders can pull stock from it automatically."
      emptyActionLabel="Add a product"
      onEmptyAction={() => router.push('/product/new')}
    />
  );
}