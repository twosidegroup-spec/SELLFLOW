/**
 * Home -- the operational dashboard.
 *
 * Answers, in order: what needs doing, how much money came in, and what is
 * about to go wrong.
 *
 * Design rules (requirements 11 and 47):
 *  - Work waiting on the seller sits ABOVE the numbers. That is what they opened
 *    the app to deal with.
 *  - Every figure is labelled with what it is and over what window. No bare
 *    numbers anywhere.
 *  - Revenue and profit are never merged, and delivered is never equated with
 *    money in hand.
 *  - A brand-new account sees a real empty dashboard that teaches the product,
 *    not a demo populated with invented orders.
 */

import { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  AlertTriangle,
  Bell,
  Boxes,
  CheckCircle2,
  Clock3,
  PackageCheck,
  Plus,
  ReceiptText,
  Truck,
  UserPlus,
  Wallet,
  XCircle,
} from 'lucide-react-native';

import { IconButton, ScreenHeader } from '@/components/ScreenHeader';
import {
  Amount,
  AmountRow,
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  ListRowSkeleton,
  Metric,
  OrderStatusBadge,
  RatioMetric,
  Screen,
  Skeleton,
  Text,
} from '@/components/ui';
import { useDashboard, type DashboardData } from '@/features/dashboard/queries';
import { AppError } from '@/lib/errors';
import { formatRelativeDay, pluralize } from '@/lib/format';
import { EXACT, formatMoney, money, type CurrencyCode } from '@/lib/money';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function HomeScreen() {
  const { colors, spacing } = useTheme();
  const organization = useSession((state) => state.organization);
  const store = useSession((state) => state.store);
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const dashboard = useDashboard(store?.id);

  // The dashboard is a snapshot the seller acts on, so it must be current on
  // every return rather than when it happened to be fetched.
  useFocusEffect(
    useCallback(() => {
      void dashboard.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const data = dashboard.data;
  const isFirstRun =
    data !== undefined &&
    data.total_orders === 0 &&
    data.product_count === 0 &&
    data.customer_count === 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title={organization?.name ?? 'SellFlow'}
        subtitle={store?.name}
        showBack={false}
        right={
          <IconButton
            onPress={() => router.push('/(app)/notifications')}
            label="Notifications"
            tone="primary"
          >
            <Bell size={20} color={colors.primary} strokeWidth={2} />
          </IconButton>
        }
      />

      <Screen
        scroll
        grow
        onRefresh={() => void dashboard.refetch()}
        refreshing={dashboard.isRefetching && !dashboard.isLoading}
      >

        {dashboard.isLoading ? (
          <DashboardSkeleton />
        ) : dashboard.isError ? (
          <ErrorState
            title={AppError.from(dashboard.error).title}
            action={AppError.from(dashboard.error).action}
            onRetry={() => void dashboard.refetch()}
          />
        ) : isFirstRun ? (
          <FirstRunView />
        ) : data ? (
          <View style={{ gap: spacing.xl }}>
            <TodayCard data={data} currency={currency} />
            <ActionQueue data={data} />
            <PipelineCard data={data} />
            <CodCard data={data} currency={currency} />
            <LowStockCard data={data} currency={currency} />
            <RecentOrdersCard data={data} currency={currency} />
            <MonthCard data={data} currency={currency} />
          </View>
        ) : null}
      </Screen>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 2. What needs doing
//
// Directly under the headline, because a seller who opened the app to check
// sales almost always has a next action. Rows only appear for non-zero counts,
// so an empty queue reads as reassurance rather than as a wall of zeros.
// ---------------------------------------------------------------------------

function ActionQueue({ data }: { data: DashboardData }) {
  const { colors, spacing } = useTheme();

  const items = [
    {
      key: 'to_confirm',
      count: data.action.to_confirm,
      label: 'order',
      verb: 'to confirm',
      icon: ReceiptText,
      tone: 'warning' as const,
      href: '/(app)/orders?filter=pending',
    },
    {
      key: 'to_pack',
      count: data.action.to_pack,
      label: 'order',
      verb: 'to pack',
      icon: PackageCheck,
      tone: 'info' as const,
      href: '/(app)/orders?filter=packaging',
    },
    {
      key: 'to_ship',
      count: data.action.to_ship,
      label: 'order',
      verb: 'ready to ship',
      icon: Truck,
      tone: 'info' as const,
      href: '/(app)/orders?filter=packed',
    },
    {
      key: 'out_for_delivery',
      count: data.action.out_for_delivery,
      label: 'parcel',
      verb: 'out for delivery',
      icon: Truck,
      tone: 'info' as const,
      href: '/(app)/orders?filter=on_delivery',
    },
    {
      key: 'pickup_pending',
      count: data.couriers.pickup_pending,
      label: 'parcel',
      verb: 'waiting for courier pickup',
      icon: Clock3,
      tone: 'info' as const,
      href: '/(app)/orders?filter=packed',
    },
    {
      key: 'low_stock',
      count: data.low_stock_count,
      label: 'product',
      verb: 'at their alert level',
      icon: AlertTriangle,
      tone: 'warning' as const,
      href: '/(app)/products',
    },
    {
      key: 'failed',
      count: data.action.failed,
      label: 'delivery',
      verb: 'failed',
      icon: XCircle,
      tone: 'danger' as const,
      href: '/(app)/orders?filter=failed_delivery',
    },
  ].filter((item) => item.count > 0);

  if (items.length === 0) {
    return (
      <Card>
        <View style={styles.row}>
          <View style={[styles.successIcon, { backgroundColor: colors.successSoft }]}>
            <CheckCircle2 size={20} color={colors.success} strokeWidth={2} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="subtitle">Nothing needs you right now</Text>
            <Text variant="caption" tone="muted">
              No orders waiting, no failed deliveries, nothing running low.
            </Text>
          </View>
        </View>
      </Card>
    );
  }

  /*
   * Severity, not decoration.
   *
   * A failed delivery is something gone wrong and should be acted on today. An
   * order to confirm is the ordinary start of the day. A product near its alert
   * level is background -- it matters, but it does not compete with a parcel
   * that is already on the road. Ranked this way the list answers "what first"
   * before the seller has read a single word, instead of presenting seven equal
   * rows and making them work out the order themselves.
   */
  const rank = { danger: 0, warning: 1, info: 2 } as const;
  const sorted = [...items].sort((a, b) => rank[a.tone] - rank[b.tone]);

  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="subtitle" tone="secondary">
        Needs your attention
      </Text>
      <Card flush>
        {sorted.map((item, index) => {
          const Icon = item.icon;
          const urgent = item.tone === 'danger';
          return (
            <View key={item.key}>
              <Pressable
                onPress={() => router.push(item.href as never)}
                accessibilityRole="button"
                accessibilityLabel={`${item.count} ${item.label} ${item.verb}`}
                style={({ pressed }) => [styles.queueRow, { opacity: pressed ? 0.6 : 1 }]}
              >
                <View
                  style={[
                    styles.queueIcon,
                    {
                      backgroundColor:
                        item.tone === 'danger'
                          ? colors.dangerSoft
                          : item.tone === 'warning'
                            ? colors.warningSoft
                            : colors.primarySoft,
                    },
                  ]}
                >
                  <Icon
                    size={18}
                    strokeWidth={2}
                    color={
                      item.tone === 'danger'
                        ? colors.danger
                        : item.tone === 'warning'
                          ? colors.warning
                          : colors.primary
                    }
                  />
                </View>

                {/* The count is the reason to tap, so it leads the row. */}
                <Text
                  variant="numeric"
                  tone={urgent ? 'danger' : 'primary'}
                  style={styles.queueCount}
                >
                  {item.count}
                </Text>

                <Text
                  variant="body"
                  style={{ flex: 1 }}
                  numberOfLines={2}
                  tone={item.tone === 'info' ? 'secondary' : undefined}
                >
                  {`${item.label}${item.count === 1 ? '' : 's'} ${item.verb}`}
                </Text>
              </Pressable>
              {index < sorted.length - 1 ? <Divider /> : null}
            </View>
          );
        })}
      </Card>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 1. The money. This is the block the whole screen is built around.
//
// Revenue and profit are set large and side by side because they are the two
// numbers a seller opens the app to see, and they are different numbers. Every
// other figure on the dashboard is deliberately smaller: they qualify the
// headline, they do not compete with it.
// ---------------------------------------------------------------------------

function TodayCard({ data, currency }: { data: DashboardData; currency: CurrencyCode }) {
  const { spacing } = useTheme();

  const margin =
    data.today.revenue > 0
      ? Math.round((data.today.profit / data.today.revenue) * 100)
      : null;

  return (
    <Card>
      <View style={styles.cardHeader}>
        <Text variant="heading">Today</Text>
        <Text variant="micro" tone="muted">
          {data.today.orders} {pluralize(data.today.orders, 'order')}
        </Text>
      </View>

      <View style={[styles.heroRow, { marginTop: spacing.md }]}>
        <View style={styles.heroCell}>
          <Text variant="micro" tone="muted">Revenue</Text>
          <Amount
            value={money(data.today.revenue, currency)}
            currency={currency}
            size="md"
            style={styles.heroAmount}
          />
          <Text variant="micro" tone="muted">
            {data.today.delivered > 0 ? `${data.today.delivered} delivered` : 'None delivered yet'}
          </Text>
        </View>

        <View style={styles.heroDivider} />

        <View style={styles.heroCell}>
          <Text variant="micro" tone="muted">Profit</Text>
          <Amount
            value={money(data.today.profit, currency)}
            currency={currency}
            size="md"
            tone={data.today.profit >= 0 ? 'success' : 'danger'}
            style={styles.heroAmount}
          />
          <Text variant="micro" tone="muted">
            {margin === null ? 'No sales today' : `${margin}% margin`}
          </Text>
        </View>
      </View>

      <Divider style={{ marginVertical: spacing.sm }} />

      {/*
        The three money questions a seller asks after the headline: what is
        still owed to me, how much of it the courier is sitting on, and how big a
        typical sale is. One row of three, so this stays a card and does not
        become three more blocks to scroll past.
      */}
      <View style={styles.statRow}>
        <Metric
          label="Owed to you"
          value={money(data.outstanding, currency)}
          currency={currency}
          size="sm"
          tone={data.outstanding > 0 ? 'danger' : 'primary'}
          caption={`${data.outstanding_orders} unpaid`}
          style={styles.statCell}
        />
        <Metric
          label="With the courier"
          value={money(data.cod.pending_settlement, currency)}
          currency={currency}
          size="sm"
          caption="Not paid out"
          style={styles.statCell}
        />
        <Metric
          label="Average order"
          value={money(data.aov_month, currency)}
          currency={currency}
          size="sm"
          caption="This month"
          style={styles.statCell}
        />
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3. The pipeline
//
// This was an eleven-row list in which at most three rows ever held a number,
// so a seller's real state was buried under eight zeros. It is now a compact
// grid: the stages that matter are always visible, and the closed stages
// (delivered, returned, cancelled) collapse into a single summary line because
// nothing needs doing about them.
// ---------------------------------------------------------------------------

/** The per-status counters, in pipeline order. */
type PipelineKey =
  | 'pending_count'
  | 'confirmed_count'
  | 'processing_count'
  | 'packaging_count'
  | 'packed_count'
  | 'shipped_count'
  | 'on_delivery_count'
  | 'delivered_count'
  | 'failed_count'
  | 'returned_count'
  | 'cancelled_count';

const OPEN_PIPELINE: { key: PipelineKey; label: string; filter: string }[] = [
  { key: 'pending_count', label: 'Pending', filter: 'pending' },
  { key: 'confirmed_count', label: 'Confirmed', filter: 'confirmed' },
  { key: 'processing_count', label: 'Processing', filter: 'processing' },
  { key: 'packaging_count', label: 'Packaging', filter: 'packaging' },
  { key: 'packed_count', label: 'Packed', filter: 'packed' },
  { key: 'shipped_count', label: 'Shipped', filter: 'shipped' },
  { key: 'on_delivery_count', label: 'On delivery', filter: 'on_delivery' },
];

const CLOSED_PIPELINE: { key: PipelineKey; label: string; filter: string }[] = [
  { key: 'delivered_count', label: 'Delivered', filter: 'delivered' },
  { key: 'failed_count', label: 'Failed', filter: 'failed_delivery' },
  { key: 'returned_count', label: 'Returned', filter: 'returned' },
  { key: 'cancelled_count', label: 'Cancelled', filter: 'cancelled' },
];

function PipelineCard({ data }: { data: DashboardData }) {
  const { spacing } = useTheme();

  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="subtitle" tone="secondary">Pipeline</Text>

      <Card>
        <View style={[styles.pipelineGrid, { rowGap: spacing.md }]}>
          {OPEN_PIPELINE.map((stage) => (
            <PipelineCell
              key={stage.key}
              label={stage.label}
              count={data[stage.key]}
              filter={stage.filter}
            />
          ))}
        </View>

        <Divider style={{ marginVertical: spacing.sm }} />

        {/*
          The closed stages are context, not work. As four grid cells they were
          a second row competing with the live pipeline, and their labels were
          wide enough to overflow the card; as one wrapping line they stay
          readable and stay out of the way.
        */}
        <View style={styles.closedRow}>
          {CLOSED_PIPELINE.map((stage) => (
            <ClosedCell
              key={stage.key}
              label={stage.label}
              count={data[stage.key]}
              filter={stage.filter}
            />
          ))}
        </View>
      </Card>
    </View>
  );
}

function ClosedCell({
  label,
  count,
  filter,
}: {
  label: string;
  count: number;
  filter: string;
}) {
  return (
    <Pressable
      onPress={() => router.push(`/(app)/orders?filter=${filter}` as never)}
      accessibilityRole="button"
      accessibilityLabel={`${count} ${label}`}
      // An inline label is 18px tall; hitSlop takes the tap area to the 44px
      // floor without padding out the row of closed stages.
      hitSlop={13}
      style={({ pressed }) => [styles.closedCell, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text variant="caption" tone="secondary">
        {count} {label.toLowerCase()}
      </Text>
    </Pressable>
  );
}

function PipelineCell({
  label,
  count,
  filter,
}: {
  label: string;
  count: number;
  filter: string;
}) {
  // Zero stages stay tappable so a seller can open an empty queue deliberately,
  // but they are visually quiet: the point of the grid is that a non-zero
  // count is the only thing on it that draws the eye.
  const active = count > 0;

  return (
    <Pressable
      onPress={() => router.push(`/(app)/orders?filter=${filter}` as never)}
      accessibilityRole="button"
      accessibilityLabel={`${count} ${label}`}
      // A two-line label plus a number is 40px on its own; the floor is 44.
      style={({ pressed }) => [styles.pipelineCell, { minHeight: 44, opacity: pressed ? 0.6 : 1 }]}
    >
      <Text variant="numeric" tone={active ? 'primary' : 'muted'}>{count}</Text>
      <Text variant="micro" tone={active ? 'secondary' : 'muted'} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// 4. COD
// ---------------------------------------------------------------------------

function CodCard({ data, currency }: { data: DashboardData; currency: CurrencyCode }) {
  const { spacing, colors } = useTheme();

  if (data.cod.expected <= 0) return null;

  return (
    <Card>
      <View style={styles.cardHeader}>
        <View style={styles.row}>
          <Wallet size={18} color={colors.textSecondary} strokeWidth={2} />
          <Text variant="subtitle" tone="secondary">Cash on delivery</Text>
        </View>
        <Badge label={`${data.cod.orders} ${pluralize(data.cod.orders, 'order')}`} />
      </View>

      <View style={{ marginTop: spacing.sm }}>
        <AmountRow
          label="Courier is holding"
          value={money(data.cod.expected, currency)}
          currency={currency}
        />
        <AmountRow
          label="Not yet paid to you"
          value={money(data.cod.pending_settlement, currency)}
          currency={currency}
          tone="danger"
        />
        {data.cod.settled > 0 ? (
          <AmountRow
            label="Settled"
            value={money(data.cod.settled, currency)}
            currency={currency}
            tone="success"
          />
        ) : null}
      </View>

      <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs }}>
        Delivered is not the same as paid. Settle each order when the money reaches you.
      </Text>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 5. Recent orders
// ---------------------------------------------------------------------------

function RecentOrdersCard({ data, currency }: { data: DashboardData; currency: CurrencyCode }) {
  const { spacing } = useTheme();

  if (data.recent_orders.length === 0) return null;

  return (
    <View style={{ gap: spacing.xs }}>
      <View style={styles.cardHeader}>
        <Text variant="subtitle" tone="secondary">Recent orders</Text>
        <SectionLink label="See all" onPress={() => router.push('/(app)/orders')} />
      </View>

      <Card flush>
        {data.recent_orders.map((order, index) => (
          <View key={order.id}>
            <Pressable
              onPress={() => router.push(`/(app)/order/${order.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`Order ${order.order_number}`}
              style={({ pressed }) => [styles.orderRow, { opacity: pressed ? 0.6 : 1 }]}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Text variant="subtitle">{order.order_number}</Text>
                {/* No manual truncation: numberOfLines already handles it, and
                    truncating first produced "Ayesha Siddiqua Rahman… · …". */}
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {order.customer_name ?? 'Walk-in customer'}
                  {' · '}
                  {formatRelativeDay(order.placed_at)}
                </Text>
                <View style={styles.badgeRow}>
                  <OrderStatusBadge status={order.status} />
                  {order.is_cod ? <Badge label="COD" tone="warning" /> : null}
                  {order.courier_name ? (
                    <Text variant="micro" tone="muted" numberOfLines={1}>
                      {order.courier_name}
                    </Text>
                  ) : null}
                </View>
              </View>

              <Amount value={money(order.total, currency)} currency={currency} />
            </Pressable>
            {index < data.recent_orders.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </Card>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 6. Low stock
// ---------------------------------------------------------------------------

function LowStockCard({ data, currency }: { data: DashboardData; currency: CurrencyCode }) {
  const { spacing, colors } = useTheme();

  if (data.low_stock.length === 0) return null;

  return (
    <View style={{ gap: spacing.xs }}>
      <View style={styles.cardHeader}>
        <Text variant="subtitle" tone="secondary">Running low</Text>
        <SectionLink label="All products" onPress={() => router.push('/(app)/products')} />
      </View>

      <Card flush>
        {data.low_stock.map((product, index) => (
          <View key={product.product_id}>
            <Pressable
              onPress={() => router.push(`/(app)/product/${product.product_id}`)}
              accessibilityRole="button"
              accessibilityLabel={`${product.name}, ${product.quantity} left`}
              style={({ pressed }) => [styles.orderRow, { opacity: pressed ? 0.6 : 1 }]}
            >
              <View style={[styles.queueIcon, { backgroundColor: colors.warningSoft }]}>
                <AlertTriangle size={16} color={colors.warning} strokeWidth={2} />
              </View>

              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="subtitle" numberOfLines={1}>
                  {product.name}
                </Text>
                <Text variant="micro" tone="muted">
                  Warns at {product.threshold} · margin{' '}
                  {formatMoney(money(product.margin, currency), currency, EXACT)}
                </Text>
              </View>

              <Text variant="numeric" tone={product.quantity <= 0 ? 'danger' : 'warning'}>
                {product.quantity}
              </Text>
            </Pressable>
            {index < data.low_stock.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </Card>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 7. Month to date
//
// Stacked rather than side by side: two `size="lg"` amounts on one row of a
// 390px card clipped their own digits to "Tk45,750.0…", which is the one thing
// a financial summary must never do.
// ---------------------------------------------------------------------------

function MonthCard({ data, currency }: { data: DashboardData; currency: CurrencyCode }) {
  const { spacing } = useTheme();
  const margin =
    data.month.revenue > 0 ? Math.round((data.month.profit / data.month.revenue) * 100) : 0;

  return (
    <Card>
      <Text variant="subtitle" tone="secondary">This month</Text>

      <View style={[styles.statRow, { marginTop: spacing.sm }]}>
          <Metric
            label="Revenue"
            value={money(data.month.revenue, currency)}
            currency={currency}
            size="sm"
            style={styles.statCell}
          />
          <Metric
            label="Profit"
            value={money(data.month.profit, currency)}
            currency={currency}
            size="sm"
            tone={data.month.profit >= 0 ? 'success' : 'danger'}
            style={styles.statCell}
          />
          <RatioMetric
            label="Margin"
            value={data.month.revenue > 0 ? `${margin}%` : '--'}
            caption={data.month.revenue > 0 ? 'After costs' : 'No sales yet'}
            style={styles.statCell}
          />
        </View>

      <Divider style={{ marginVertical: spacing.sm }} />

      <AmountRow
        label={`${data.month.orders} ${pluralize(data.month.orders, 'order')}`}
        value={money(data.aov_month, currency)}
        currency={currency}
        sublabel="Average order value"
      />

      {data.month.revenue > 0 ? (
        <Text variant="micro" tone="muted">
          Product cost {formatMoney(money(data.costs.product, currency), currency, EXACT)}
          {data.costs.courier > 0
            ? ` · courier ${formatMoney(money(data.costs.courier, currency), currency, EXACT)}`
            : ''}
        </Text>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section heading action
//
// A text link that used to be an 18px-tall pressable -- well under the 44px
// minimum touch target. hitSlop restores the target without moving anything
// visually.
// ---------------------------------------------------------------------------

function SectionLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={14}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text variant="caption" tone="primary" suppressHighlighting>
        {label}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function DashboardSkeleton() {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.md, marginTop: spacing.lg }}>
      <Card>
        <Skeleton width="40%" height={16} />
        <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
          <Skeleton width="100%" height={22} />
          <Skeleton width="60%" height={22} />
        </View>
      </Card>
      <Card>
        <ListRowSkeleton />
        <ListRowSkeleton />
        <ListRowSkeleton />
        <ListRowSkeleton />
      </Card>
    </View>
  );
}

function FirstRunView() {
  const { spacing } = useTheme();

  return (
    <View style={{ marginTop: spacing.xxl }}>
      <EmptyState
        icon={Boxes}
        title="Let's set up your first sale"
        description="Add a product, then create an order. SellFlow tracks stock, payments, couriers and profit for you."
      />

      <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
        <Button
          label="Add your first product"
          icon={Plus}
          onPress={() => router.push('/(app)/product/new')}
          block
          size="lg"
        />
        <Button
          label="Create your first customer"
          icon={UserPlus}
          variant="secondary"
          onPress={() => router.push('/(app)/customer/new')}
          block
        />
        <Button
          label="Create an order"
          icon={ReceiptText}
          variant="ghost"
          onPress={() => router.push('/(app)/order/new')}
          block
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 52,
  },
  queueCount: {
    minWidth: 26,
    textAlign: 'right',
  },
  queueIcon: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successIcon: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 56,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },

  // The two headline figures. One row, each with room for a nine-figure amount
  // and a two-line caption, separated by a hairline rather than by two cards.
  heroRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 12,
  },
  heroCell: {
    flex: 1,
    gap: 2,
  },
  heroDivider: {
    width: StyleSheet.hairlineWidth,
  },
  heroAmount: {
    fontSize: 22,
    lineHeight: 28,
  },

  // Three-up supporting figures. Compact numbers only -- anything needing the
  // full type scale goes in its own row above.
  statRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  // Without flex:1 each cell sizes to its own longest line, so a caption like
  // "COD collected, not paid out" pushed the third column off the card.
  statCell: {
    flex: 1,
  },

  pipelineGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  closedRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
  },
  closedCell: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  pipelineCell: {
    width: '33.333%',
    alignItems: 'flex-start',
    gap: 2,
  },
});
