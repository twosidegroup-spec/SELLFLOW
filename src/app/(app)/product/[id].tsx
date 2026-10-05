/**
 * Product detail.
 *
 * Shows the product, its stock in the seller's store, and lets them adjust stock.
 *
 * WHY STOCK ONLY MOVES THROUGH AN ADJUSTMENT
 *
 * There is no free-text "set to N" here. `set_stock` exists for opening stock on a
 * product that has never been counted, and `adjust_stock` exists for a correction.
 * Both write an `inventory_movements` row, which is an append-only ledger -- nothing
 * is ever updated or deleted there. That is what makes "why is my stock wrong"
 * answerable six months later.
 *
 * The movements are shown under the figure so the seller can see the last change and
 * when it happened, rather than having to trust a number.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Package, PackageMinus, PackagePlus } from 'lucide-react-native';

import { Button, Card, Divider, ErrorState, LoadingState, Screen, Text } from '@/components/ui';
import { useAdjustStock } from '@/features/orders/mutations';
import { useArchiveProduct, useDeleteProduct } from '@/features/products/mutations';
import { useMovements, useProduct, useStock } from '@/features/products/queries';
import { formatMoney, zero } from '@/lib/money';
import type { Money } from '@/lib/money';
import { AppError } from '@/lib/errors';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, spacing } = useTheme();

  const storeId = useSession((state) => state.store?.id);
  const role = useSession((state) => state.role);

  const product = useProduct(id);
  const stock = useStock(storeId, id);
  const movements = useMovements(id);

  const adjustStock = useAdjustStock();
  const archiveProduct = useArchiveProduct();
  const deleteProduct = useDeleteProduct();

  const [delta, setDelta] = useState<Money | null>(null);
  const [reason, setReason] = useState('');
  const [banner, setBanner] = useState<string | null>(null);

  if (product.isLoading) return <LoadingState />;

  if (product.isError || !product.data) {
    return (
      <ErrorState
        title="Could not load this product"
        action="It may have been deleted, or it belongs to another business."
        onRetry={() => void product.refetch()}
      />
    );
  }

  const row = product.data;
  const available = stock.data?.quantity ?? null;
  const writable = canWrite(role);

  const applyAdjustment = async (direction: 1 | -1) => {
    if (delta === null || delta <= zero()) return;
    setBanner(null);

    try {
      await adjustStock.mutateAsync({
        storeId: storeId as string,
        productId: row.id,
        variantId: null,
        delta: direction * Math.round(Number(delta)),
        reason: (reason.trim() || 'correction') as never,
      });
      setDelta(null);
      setReason('');
    } catch (error) {
      setBanner(
        error instanceof AppError
          ? error.title
          : 'Could not adjust stock. Nothing was changed.',
      );
    }
  };

  return (
    <Screen
      testID="product-detail"
      width="form"
      edges={['top']}
      footer={
        writable ? (
          <Button
            label="Edit product"
            fullWidth
            onPress={() => router.push(`/product/${row.id}/edit`)}
            testID="product-edit"
          />
        ) : undefined
      }
    >
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">{row.name}</Text>
          {row.sku ? (
            <Text variant="caption" tone="muted">
              {row.sku}
            </Text>
          ) : null}
        </View>

        {banner ? (
          <Card elevation="flat">
            <Text variant="caption" tone="danger">
              {banner}
            </Text>
          </Card>
        ) : null}

        {/* ---- Money ---- */}
        <Card>
          <View style={{ gap: spacing.md }}>
            <Row label="Selling price" value={formatMoney(row.selling_price)} />
            <Divider style={{ marginVertical: spacing.none }} />
            {/*
             * A missing cost is stated, never rendered as ৳0.00. Zero would claim the
             * item is free to make, which is a different and materially wrong claim,
             * and it would flow into the profit figure.
             */}
            <Row
              label="Cost price"
              value={
                row.cost_price === null ? 'Not recorded' : formatMoney(row.cost_price)
              }
              muted={row.cost_price === null}
            />
            {row.cost_price !== null ? (
              <>
                <Divider style={{ marginVertical: spacing.none }} />
                <Row
                  label="Profit per unit"
                  value={formatMoney(row.selling_price - row.cost_price)}
                  tone={row.selling_price - row.cost_price > 0 ? 'success' : 'danger'}
                />
              </>
            ) : null}
          </View>
        </Card>

        {/* ---- Stock ---- */}
        <Card>
          <View style={{ gap: spacing.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
              <Package size={18} color={colors.textMuted} strokeWidth={1.75} />
              <Text variant="micro" tone="muted">
                STOCK IN THIS OUTLET
              </Text>
            </View>

            {row.track_inventory ? (
              <>
                <Text variant="numericLarge">
                  {available === null ? '—' : String(available)}
                </Text>

                {row.low_stock_threshold > 0 && available !== null && available <= row.low_stock_threshold ? (
                  <Text variant="caption" tone="warning">
                    {`Low — you asked to be warned at ${row.low_stock_threshold}.`}
                  </Text>
                ) : null}

                {writable ? (
                  <View style={{ gap: spacing.sm, marginTop: spacing.xs }}>
                    <Text variant="caption" tone="muted">
                      Adjust by
                    </Text>
                    <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                      <Button
                        label="Remove"
                        icon={PackageMinus}
                        variant="secondary"
                        disabled={delta === null || delta <= zero() || adjustStock.isPending}
                        onPress={() => void applyAdjustment(-1)}
                        testID="stock-decrease"
                      />
                      <Button
                        label="Add"
                        icon={PackagePlus}
                        disabled={delta === null || delta <= zero() || adjustStock.isPending}
                        onPress={() => void applyAdjustment(1)}
                        testID="stock-increase"
                      />
                    </View>
                    <Text variant="caption" tone="muted">
                      {delta === null ? 'Enter a number above to enable the buttons.' : `${delta} units`}
                    </Text>
                  </View>
                ) : null}

                {/* The ledger, so the figure is not a black box. */}
                {movements.data && movements.data.length > 0 ? (
                  <View style={{ gap: spacing.xs, marginTop: spacing.sm }}>
                    <Text variant="micro" tone="muted">
                      RECENT CHANGES
                    </Text>
                    {movements.data.slice(0, 5).map((movement) => (
                      <View
                        key={movement.id}
                        style={{ flexDirection: 'row', justifyContent: 'space-between' }}
                      >
                        <Text variant="caption" tone="muted">
                          {movement.reason.replace(/_/g, ' ')}
                        </Text>
                        <Text
                          variant="numericSmall"
                          tone={movement.delta > 0 ? 'success' : 'danger'}
                        >
                          {`${movement.delta > 0 ? '+' : ''}${movement.delta}`}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </>
            ) : (
              <Text variant="body" tone="secondary">
                This product is not stock tracked, so its quantity is not recorded.
              </Text>
            )}
          </View>
        </Card>

        {/* ---- Destructive actions ---- */}
        {writable ? (
          <View style={{ gap: spacing.xs }}>
            <Button
              label={row.is_archived ? 'Unarchive' : 'Archive'}
              variant="secondary"
              fullWidth
              loading={archiveProduct.isPending}
              onPress={() =>
                void archiveProduct
                  .mutateAsync({ productId: row.id, archived: !row.is_archived })
                  .catch(() => setBanner('Could not change the archive state.'))
              }
              testID="product-archive"
            />
            <Text variant="caption" tone="muted" center>
              Archiving hides a product from new orders without deleting its history.
            </Text>

            {/*
             * Delete is offered last and says what will stop it. `delete_product`
             * refuses when the product is linked to money, so a seller who taps this
             * on something they have sold is told why rather than losing data.
             */}
            <Button
              label="Delete permanently"
              variant="ghost"
              fullWidth
              loading={deleteProduct.isPending}
              onPress={() =>
                void deleteProduct
                  .mutateAsync(row.id)
                  .then(() => router.back())
                  .catch((error: unknown) =>
                    setBanner(
                      error instanceof AppError
                        ? error.title
                        : 'Could not delete. This product may be linked to past orders.',
                    ),
                  )
              }
              testID="product-delete"
            />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

function Row({
  label,
  value,
  muted,
  tone = 'default',
}: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: 'default' | 'success' | 'danger';
}) {
  const { spacing } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: spacing.md,
      }}
    >
      <Text variant="body" tone="secondary">
        {label}
      </Text>
      <Text variant="numeric" tone={muted ? 'muted' : tone}>
        {value}
      </Text>
    </View>
  );
}
