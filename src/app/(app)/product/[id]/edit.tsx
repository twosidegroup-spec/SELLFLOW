/**
 * Edit product route.
 *
 * Loads under the caller's RLS and seeds the form. The route id identifies a row; it
 * does not authorise anything.
 */

import { useLocalSearchParams } from 'expo-router';

import { ProductForm } from '@/components/forms/ProductForm';
import { ErrorState, LoadingState } from '@/components/ui';
import { useProduct } from '@/features/products/queries';

export default function EditProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const product = useProduct(id);

  if (product.isLoading) return <LoadingState label="Loading product" />;

  if (product.isError || !product.data) {
    return (
      <ErrorState
        title="Could not load this product"
        action="It may have been deleted, or you may not have access."
        onRetry={() => void product.refetch()}
      />
    );
  }

  const row = product.data;

  return (
    <ProductForm
      productId={row.id}
      initial={{
        name: row.name,
        sku: row.sku,
        category: row.category,
        // Passed exactly as stored. The form owns the whole-taka to minor-units
        // conversion in both directions, so a route cannot get the boundary backwards.
        sellingPrice: row.selling_price,
        costPrice: row.cost_price,
        lowStockThreshold: row.low_stock_threshold,
        trackInventory: row.track_inventory,
        notes: row.notes,
      }}
    />
  );
}