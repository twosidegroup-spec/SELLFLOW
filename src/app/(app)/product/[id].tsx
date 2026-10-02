/**
 * Product detail.
 *
 * Shows current stock, price and margin, the full stock ledger, and the recent
 * orders this product appeared in. Every stock figure on this screen traces back
 * to a row in `inventory_movements` -- requirement 16.
 */

import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  ArrowDownRight,
  ArrowUpRight,
  Archive,
  Pencil,
  Plus,
  ReceiptText,
  Trash2,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { ScreenHeader } from '@/components/ScreenHeader';
import {
  AmountRow,
  Badge,
  BottomSheet,
  Button,
  Card,
  CountRow,
  DetailRow,
  Divider,
  EmptyState,
  ErrorState,
  Input,
  ListRowSkeleton,
  Screen,
  SectionHeader,
  SegmentedControl,
  SelectField,
  Text,
  confirm,
} from '@/components/ui';
import { useAdjustStock, useSetStock } from '@/features/orders/mutations';
import { useArchiveProduct, useDeleteProduct } from '@/features/products/mutations';
import { useMovements, useProduct, useStock } from '@/features/products/queries';
import { useProductStats } from '@/features/dashboard/queries';
import type { InventoryReason } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { formatRelativeDay } from '@/lib/format';
import { money, parseWholeNumber, type CurrencyCode } from '@/lib/money';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

const REASONS: { value: InventoryReason; label: string; delta: boolean }[] = [
  { value: 'initial', label: 'Opening stock', delta: true },
  { value: 'purchase', label: 'Bought more', delta: true },
  { value: 'adjustment', label: 'Stock count correction', delta: true },
  { value: 'damage', label: 'Damaged or lost', delta: false },
];

/**
 * Two different questions a seller can ask about stock.
 *
 * `change` is relative: "12 arrived", "2 were damaged". The number typed is the
 * movement.
 *
 * `count` is absolute: "I counted the shelf and there are 20". The number typed
 * is the shelf, and the movement is whatever gets it there. Collapsing these
 * into one control is how "in stock 2000" happens when someone means 20.
 */
type StockMode = 'change' | 'count';

interface StockChange {
  mode: StockMode;
  reason: InventoryReason;
  quantity: number;
}

export default function ProductDetailScreen() {
  const { colors, spacing } = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const productId = params.id;

  const store = useSession((state) => state.store);
  const organization = useSession((state) => state.organization);
  const role = useSession((state) => state.role);
  const canWrite = role === 'owner' || role === 'manager';
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const product = useProduct(productId);
  const stock = useStock(store?.id, productId);
  const movements = useMovements(productId);
  const stats = useProductStats(store?.id, productId);
  const adjustStock = useAdjustStock();
  const setStock = useSetStock();
  const archiveProduct = useArchiveProduct();
  const deleteProduct = useDeleteProduct();

  const [adjustOpen, setAdjustOpen] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void product.refetch();
      void stock.refetch();
      void movements.refetch();
      void stats.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [productId]),
  );

  if (product.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Product" />
        <Screen>
          <ListRowSkeleton />
        </Screen>
      </View>
    );
  }

  if (product.isError || !product.data) {
    const error = AppError.from(product.error);
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Product" />
        <Screen>
          <ErrorState title={error.title} action={error.action} onRetry={() => void product.refetch()} />
        </Screen>
      </View>
    );
  }

  const data = product.data;
  const quantity = stock.data?.quantity ?? 0;
  const price = money(data.selling_price, currency);
  const cost = data.cost_price === null ? null : money(data.cost_price, currency);
  const margin = cost === null ? null : price - cost;

  const isLow =
    data.track_inventory && data.low_stock_threshold > 0 && quantity <= data.low_stock_threshold;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title={data.name}
        subtitle={data.sku ?? undefined}
        right={
          canWrite ? (
            <Button
              label="Edit"
              variant="secondary"
              size="sm"
              icon={Pencil}
              onPress={() => router.push({ pathname: '/(app)/product/new', params: { id: productId } })}
            />
          ) : undefined
        }
      />

      <Screen>
        <View style={{ gap: spacing.xl, paddingTop: spacing.sm }}>
          {/* Summary ----------------------------------------------------- */}
          <Card>
            <View style={styles.summaryTop}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text variant="micro" tone="muted">In stock</Text>
                <Text variant="numericLarge" tone={quantity <= 0 ? 'danger' : 'primary'}>
                  {data.track_inventory ? quantity : '--'}
                </Text>
                {isLow ? <Badge label="Low stock" tone="warning" /> : null}
                {!data.track_inventory ? <Badge label="Stock not tracked" tone="neutral" /> : null}
              </View>

              {canWrite && data.track_inventory ? (
                <Button
                  label="Adjust"
                  icon={Plus}
                  variant="secondary"
                  size="sm"
                  onPress={() => setAdjustOpen(true)}
                />
              ) : null}
            </View>

            <View style={{ marginTop: spacing.md }}>
              <AmountRow label="Selling price" value={price} currency={currency} />
              <AmountRow
                label="Cost price"
                value={cost ?? 0}
                currency={currency}
                tone="secondary"
              />
              {margin !== null ? (
                <AmountRow
                  label="Profit per unit"
                  value={margin}
                  currency={currency}
                  emphasis
                  tone={margin >= 0 ? 'success' : 'danger'}
                />
              ) : null}
              <CountRow
                label="Low-stock alert at"
                value={data.low_stock_threshold}
                suffix="units"
                sublabel={
                  data.low_stock_threshold === 0
                    ? 'Disabled — no low-stock warning'
                    : 'Warns you at this level'
                }
              />
            </View>
          </Card>

          {/* Trade performance -------------------------------------------
              Available / reserved / sold are different questions and conflating
              them is how a seller oversells. `available` is what is on the shelf,
              `reserved` is what is already spoken for on an order that has not
              shipped yet. All figures come from get_product_stats, which counts
              real order lines. */}
          <View>
            <SectionHeader title="Trade" />
            <Card>
              <View style={styles.tradeRow}>
                <TradeMetric
                  label="Can sell"
                  value={stats.data?.sellable ?? quantity}
                  caption="Free to promise"
                  tone={((stats.data?.sellable ?? quantity) <= 0) ? 'danger' : 'primary'}
                />
                <TradeMetric
                  label="Reserved"
                  value={stats.data?.reserved ?? 0}
                  caption="Committed, not shipped"
                />
                <TradeMetric
                  label="Sold"
                  value={stats.data?.sold_units ?? 0}
                  caption="Units, all time"
                />
              </View>

              <Divider style={{ marginVertical: spacing.md }} />

              <AmountRow
                label="Revenue"
                value={money(stats.data?.revenue ?? 0, currency)}
                currency={currency}
              />
              <AmountRow
                label="Profit"
                value={money(stats.data?.profit ?? 0, currency)}
                currency={currency}
                emphasis
                tone={(stats.data?.profit ?? 0) >= 0 ? 'success' : 'danger'}
              />
              <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs }}>
                Excludes cancelled, returned and failed deliveries.
              </Text>
            </Card>
          </View>

          {/* Ledger ------------------------------------------------------ */}
          <View>
            <SectionHeader title="Stock history" />
            <Card flush>
              {movements.data && movements.data.length > 0 ? (
                movements.data.map((movement, index) => {
                  const positive = movement.delta > 0;
                  return (
                    <View key={movement.id}>
                      <View style={styles.movementRow}>
                        <View
                          style={[
                            styles.movementIcon,
                            {
                              backgroundColor: positive ? colors.successSoft : colors.dangerSoft,
                            },
                          ]}
                        >
                          {positive ? (
                            <ArrowUpRight size={16} color={colors.success} strokeWidth={2} />
                          ) : (
                            <ArrowDownRight size={16} color={colors.danger} strokeWidth={2} />
                          )}
                        </View>

                        <View style={{ flex: 1, gap: 2 }}>
                          <Text variant="subtitle">{reasonLabel(movement.reason)}</Text>
                          <Text variant="micro" tone="muted" numberOfLines={1}>
                            {formatRelativeDay(movement.created_at)}
                            {movement.balance_after !== undefined
                              ? ` · balance ${movement.balance_after}`
                              : ''}
                          </Text>
                        </View>

                        <Text variant="numeric" tone={positive ? 'success' : 'danger'}>
                          {positive ? '+' : ''}
                          {movement.delta}
                        </Text>
                      </View>
                      {index < movements.data.length - 1 ? <Divider /> : null}
                    </View>
                  );
                })
              ) : (
                <View style={{ padding: spacing.lg }}>
                  <EmptyState
                    icon={ReceiptText}
                    title="No stock movements yet"
                    description="Every sale, purchase and adjustment will be listed here."
                    compact
                  />
                </View>
              )}
            </Card>
          </View>

          {/* Danger zone ------------------------------------------------- */}
          {canWrite ? (
            <View>
              <SectionHeader title="Manage" />
              <Card style={{ gap: spacing.sm }}>
                <Button
                  label={data.is_archived ? 'Restore product' : 'Archive product'}
                  icon={Archive}
                  variant="secondary"
                  block
                  onPress={async () => {
                    const confirmed = await confirm({
                      title: data.is_archived ? 'Restore this product?' : 'Archive this product?',
                      message: data.is_archived
                        ? 'It will reappear in pickers and lists.'
                        : 'It will be hidden from pickers and lists. Past orders keep it.',
                      confirmLabel: data.is_archived ? 'Restore' : 'Archive',
                      destructive: !data.is_archived,
                    });
                    if (!confirmed) return;

                    try {
                      await archiveProduct.mutateAsync({
                        productId,
                        archived: !data.is_archived,
                      });
                      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      if (!data.is_archived) router.back();
                    } catch {
                      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                    }
                  }}
                />

                <Text variant="micro" tone="muted">
                  Archiving keeps this product and its sales history. Deleting is for products
                  you never sold.
                </Text>

                <Button
                  label="Delete product"
                  icon={Trash2}
                  variant="danger"
                  block
                  onPress={async () => {
                    const confirmed = await confirm({
                      title: 'Delete this product?',
                      message:
                        'This cannot be undone. If it has been sold you will be asked to ' +
                        'archive it instead, so your sales history stays correct.',
                      confirmLabel: 'Delete',
                      destructive: true,
                    });
                    if (!confirmed) return;

                    try {
                      await deleteProduct.mutateAsync(productId);
                      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      router.back();
                    } catch (error) {
                      // The refusal is a normal outcome, not a crash: the server
                      // counts the sales and explains what to do instead.
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

      <AdjustStockSheet
        visible={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        currency={currency}
        current={quantity}
        saving={adjustStock.isPending || setStock.isPending}
        error={adjustStock.isError ? AppError.from(adjustStock.error) : setStock.isError ? AppError.from(setStock.error) : null}
        onSubmit={async ({ mode, reason, quantity }) => {
          if (!store) return;
          try {
            if (mode === 'count') {
              // The seller counted the shelf. The target is resolved server-side
              // against a locked row so a sale landing mid-count cannot skew it.
              await setStock.mutateAsync({
                storeId: store.id,
                productId,
                variantId: null,
                count: quantity,
                reason: reason === 'adjustment' ? 'adjustment' : reason,
                note: reasonLabel(reason),
              });
            } else {
              const definition = REASONS.find((entry) => entry.value === reason);
              await adjustStock.mutateAsync({
                storeId: store.id,
                productId,
                variantId: null,
                delta: definition?.delta ? quantity : -quantity,
                reason,
                note: reasonLabel(reason),
              });
            }
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setAdjustOpen(false);
          } catch {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          }
        }}
      />
    </View>
  );
}

/** Compact non-monetary figure in the Trade row (counts, not money). */
function TradeMetric({
  label,
  value,
  caption,
  tone = 'primary',
}: {
  label: string;
  value: number;
  caption: string;
  tone?: 'primary' | 'danger';
}) {
  const { spacing } = useTheme();

  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text variant="micro" tone="muted" numberOfLines={1}>{label}</Text>
      <Text variant="numeric" tone={tone}>{value}</Text>
      <Text variant="micro" tone="muted" style={{ marginTop: spacing.xxs }} numberOfLines={2}>
        {caption}
      </Text>
    </View>
  );
}

function AdjustStockSheet({
  visible,
  onClose,
  onSubmit,
  current,
  currency,
  saving,
  error,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (change: StockChange) => Promise<void>;
  current: number;
  currency: CurrencyCode;
  saving: boolean;
  error: AppError | null;
}) {
  const { spacing, colors } = useTheme();
  const [mode, setMode] = useState<StockMode>('change');
  const [reason, setReason] = useState<InventoryReason>('adjustment');
  const [quantityText, setQuantityText] = useState('');
  const [reasonOpen, setReasonOpen] = useState(false);

  // A unit COUNT, not money. Reading this through toMinor() multiplied it by the
  // currency decimals, so a correction of 20 units was applied as 2,000.
  const quantity = parseWholeNumber(quantityText);
  const definition = REASONS.find((entry) => entry.value === reason);

  // In count mode the number typed is the shelf, not a change. Counting to 0 is
  // meaningful (everything written off), so it is allowed here even though a
  // change of 0 never is.
  const isCount = mode === 'count';
  const delta = isCount
    ? quantity - current
    : definition?.delta
      ? quantity
      : -quantity;
  const result = current + delta;

  const invalid = isCount
    ? quantity < 0
    : quantity <= 0 || (definition?.delta === false && current < quantity);

  // Counting to what is already there would be rejected by the zero-delta check,
  // so the button says so instead of letting the save fail.
  const unchanged = isCount && quantity === current;

  const help = isCount
    ? unchanged
      ? `The count matches the current stock, so there is nothing to record.`
      : `Records a ${delta > 0 ? 'gain' : 'reduction'} of ${Math.abs(delta)} ${
          Math.abs(delta) === 1 ? 'unit' : 'units'
        } and sets stock to ${result}.`
    : definition?.delta === false && quantity > current
      ? 'You only have ' + current + '.'
      : null;

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Adjust stock">
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md }}>
        <SegmentedControl
          options={[
            { value: 'change', label: 'Add or remove' },
            { value: 'count', label: 'Set exact count' },
          ]}
          value={mode}
          onChange={(next) => {
            setMode(next);
            setQuantityText('');
          }}
        />

        {isCount ? (
          <Text variant="micro" tone="muted">
            Use this after counting the shelf. Type the number you counted, not the number
            you are adding.
          </Text>
        ) : null}

        {!isCount ? (
          <SelectField
            label="Reason"
            value={definition?.label}
            onPress={() => setReasonOpen(true)}
          />
        ) : null}

        <Input
          label={isCount ? 'Counted quantity' : 'Quantity'}
          numeric
          value={quantityText}
          onChangeText={setQuantityText}
          placeholder="0"
          autoFocus
          hint={`Current stock: ${current}`}
        />

        <View
          style={[
            {
              backgroundColor: colors.surfaceSunken,
              padding: spacing.sm,
              borderRadius: 10,
            },
          ]}
        >
          <DetailRow label="New stock level" value={String(result)} emphasis />
        </View>

        {help ? (
          <Text variant="micro" tone={invalid ? 'danger' : 'muted'}>
            {help}
          </Text>
        ) : null}

        {invalid && !help ? (
          <Text variant="micro" tone="danger">
            {current === 0
              ? 'You cannot remove stock that is not there.'
              : 'Enter a quantity of 1 or more.'}
          </Text>
        ) : null}

        {error ? (
          <Text variant="micro" tone="danger">
            {error.title}. {error.action}
          </Text>
        ) : null}

        <Button
          label={isCount ? 'Set stock' : 'Save adjustment'}
          onPress={() => void onSubmit({ mode, reason, quantity })}
          loading={saving}
          disabled={invalid || unchanged}
          block
          size="lg"
        />
      </View>

      <BottomSheet visible={reasonOpen} onClose={() => setReasonOpen(false)} title="Reason">
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
          {REASONS.map((entry, index) => (
            <View key={entry.value}>
              <ListRowLike
                title={entry.label}
                selected={entry.value === reason}
                onPress={() => {
                  setReason(entry.value);
                  setReasonOpen(false);
                }}
              />
              {index < REASONS.length - 1 ? <Divider /> : null}
            </View>
          ))}
        </View>
      </BottomSheet>
    </BottomSheet>
  );
}

/** Compact row used inside the reason sheet, where ListRow would be too heavy. */
function ListRowLike({
  title,
  selected,
  onPress,
}: {
  title: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors, spacing } = useTheme();
  return (
    <Text
      variant="body"
      onPress={onPress}
      suppressHighlighting
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={{
        paddingVertical: spacing.md,
        color: selected ? colors.primary : colors.text,
      }}
    >
      {title}
    </Text>
  );
}

function reasonLabel(reason: InventoryReason): string {
  switch (reason) {
    case 'sale':
      return 'Sold';
    case 'sale_return':
      return 'Returned to stock';
    case 'initial':
      return 'Opening stock';
    case 'purchase':
      return 'Stock purchase';
    case 'damage':
      return 'Damaged or lost';
    default:
      return 'Stock adjustment';
  }
}

const styles = {
  summaryTop: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    justifyContent: 'space-between' as const,
    gap: 12,
  },
  tradeRow: {
    flexDirection: 'row' as const,
    gap: 12,
  },
  movementRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  movementIcon: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
};
