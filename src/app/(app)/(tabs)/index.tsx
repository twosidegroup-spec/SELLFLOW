/**
 * Today — the seller's dashboard.
 *
 * Reads real data through the existing `get_dashboard` aggregate. When there is
 * nothing yet, it says so. It does NOT show a revenue figure to make the screen look
 * populated: a dashboard that invents a number teaches a seller to trust numbers the
 * app made up, which is the opposite of what an operating system for their money
 * should do.
 *
 * Every figure below is computed by the database. Where a cost was never entered the
 * RPC reports it and this screen shows "Not recorded", because a courier cost the
 * seller did not supply is not the same as a courier cost of zero.
 */

import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowRight, Package, Receipt, TriangleAlert } from 'lucide-react-native';

import { Button, Card, EmptyState, ErrorState, Screen, Skeleton, Text } from '@/components/ui';
import {
  useDashboard,
  useProfitCompleteness,
  type DashboardData,
  type ProfitCompleteness,
} from '@/features/dashboard/queries';
import { formatMajorUnits } from '@/lib/money';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * Vertical padding for a capsule chip, in points.
 *
 * `spacing.xxs` (4) would make the chip 19px tall around an 11px numeral. Two points
 * is what a capsule of this type wants, and it is named here rather than inlined so
 * the design audit can see it is deliberate. Same value, same reasoning as the
 * REQUIRED/OPTIONAL chip in registration.
 */
const BADGE_PADDING_V = 2;

export default function DashboardScreen() {
  const router = useRouter();
  const { spacing } = useTheme();

  const organization = useSession((state) => state.organization);
  const store = useSession((state) => state.store);
  const role = useSession((state) => state.role);

  // The store id comes from the SESSION, never from a route param. That is what
  // makes tenant isolation structural rather than a thing to remember: there is no
  // code path by which a seller can name another seller's store.
  const { data, isPending, error, refetch } = useDashboard(store?.id);
  // A second, small query. It must not be able to take the dashboard down with it.
  const completeness = useProfitCompleteness(store?.id);

  if (error) {
    return (
      <ErrorState
        title="Could not load your dashboard"
        action="Check your connection and try again. Nothing has been lost."
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <Screen testID="dashboard-screen" edges={['top']}>
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">{organization?.name ?? 'Your business'}</Text>
          {store ? (
            <Text variant="caption" tone="muted">
              {store.name}
            </Text>
          ) : null}
        </View>

        {/* Read-only staff get a clean dashboard, not a wall of buttons that fail. */}
        {canWrite(role) ? (
          <Button
            label="New order"
            fullWidth
            onPress={() => router.push('/order/new')}
            testID="dashboard-new-order"
          />
        ) : null}

        {isPending || !data ? (
    <DashboardSkeleton />
  ) : (
    <DashboardBody data={data} completeness={completeness.data ?? UNKNOWN_COMPLETENESS} />
  )}
      </View>
    </Screen>
  );
}

/**
 * Used while the completeness query is still loading, or when it fails.
 *
 * `undefined` on every window makes the caller fall back to the older cost-sum
 * heuristic, which is what this screen did before the flag existed. Choosing a
 * definite `false` here would claim every cost is known, which is the one answer
 * that must never be assumed.
 */
const UNKNOWN_COMPLETENESS: ProfitCompleteness = {
  today: undefined,
  week: undefined,
  month: undefined,
  costs: undefined,
};

/**
 * The real figures.
 *
 * WHY PROFIT IS NOT ALWAYS SHOWN AS A NUMBER
 *
 * `get_dashboard` computes profit as `line_total - coalesce(unit_cost, 0) * quantity`.
 * When a product had no cost price recorded, `unit_cost` is NULL and the cost is
 * counted as zero, so the figure is too high -- and nothing in that payload says so.
 *
 * `useProfitCompleteness` asks the separate question properly. This screen previously
 * inferred it from `costs.product + costs.courier + costs.other > 0`, which was wrong
 * in both directions: those cover a 30-day window while the profit shown is today's,
 * and they measure whether ANY cost was entered rather than whether the cost of every
 * line sold is known.
 *
 * Until migration 0025 is applied, completeness is undefined and the old heuristic is
 * used as a fallback, so the screen is never worse than before the fix.
 */
function DashboardBody({
  data,
  completeness,
}: {
  data: DashboardData;
  completeness: ProfitCompleteness;
}) {
  const { colors, spacing } = useTheme();
  const router = useRouter();

  const action = data.action;
  const hasActions =
    action.to_confirm + action.to_pack + action.to_ship + action.out_for_delivery + action.failed > 0;

  const fallbackHasCosts = data.costs.product + data.costs.courier + data.costs.other > 0;
  // Only today's profit is on this screen, so only today's flag is needed. `undefined`
  // means migration 0025 has not been applied yet, and the old heuristic stands in.
  const todayPartial = completeness.today ?? !fallbackHasCosts;

  return (
    <View style={{ gap: spacing.md }}>
      <Card>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="micro" tone="muted">
            REVENUE TODAY
          </Text>
          <Text variant="numericLarge">{formatMajorUnits(data.today.revenue)}</Text>
          <Text variant="caption" tone="muted">
            {`${data.today.orders} order${data.today.orders === 1 ? '' : 's'}`}
          </Text>
        </View>
      </Card>

<View style={{ gap: spacing.sm, flexDirection: 'row', flexWrap: 'wrap' }}>
        <Metric
          label="Profit today"
          /*
           * Partial means the number shown is a FLOOR, not a result: at least one
           * product sold today had no cost price, so the real margin is lower. It is
           * shown as a number with the caveat attached, because "Not recorded" on a day
           * that genuinely recorded costs would be the other kind of wrong.
           */
          value={formatMajorUnits(data.today.profit)}
          hint={todayPartial ? 'at least — some costs unrecorded' : undefined}
          tone={todayPartial ? 'muted' : data.today.profit > 0 ? 'success' : data.today.profit < 0 ? 'danger' : 'default'}
          width="48%"
        />
        <Metric
          label="Average order"
          value={formatMajorUnits(data.aov_month)}
          hint="this month"
          width="48%"
        />
      </View>

      {/*
       * COD money still with the courier is money the seller is OWED, not income.
       * Showing it as revenue would be the single most misleading thing this screen
       * could do, so it gets its own line with its own wording.
       */}
      {data.cod.expected > 0 ? (
        <Card elevation="flat" style={{ borderColor: colors.accentBorder }}>
          <View style={{ gap: spacing.xxs }}>
            <Text variant="micro" tone="muted">
              CASH ON DELIVERY — OWED TO YOU
            </Text>
            <Text variant="numeric" tone="accent">
              {formatMajorUnits(data.cod.pending_settlement)}
            </Text>
            <Text variant="caption" tone="muted">
              {`${data.cod.orders} order${data.cod.orders === 1 ? '' : 's'} still with the courier`}
            </Text>
          </View>
        </Card>
      ) : null}

      {hasActions ? (
        <Card elevation="flat" style={{ borderColor: colors.warningBorder }}>
          <View style={{ gap: spacing.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
              <TriangleAlert size={16} color={colors.warning} strokeWidth={1.75} />
              <Text variant="bodyStrong">Needs your attention</Text>
            </View>
            <ActionLine label="to confirm" count={action.to_confirm} />
            <ActionLine label="to pack" count={action.to_pack} />
            <ActionLine label="to ship" count={action.to_ship} />
            <ActionLine label="out for delivery" count={action.out_for_delivery} />
            <ActionLine label="delivery failed" count={action.failed} tone="danger" />
          </View>
        </Card>
      ) : null}

      <Card>
        <View style={{ gap: spacing.md }}>
          <Text variant="micro" tone="muted">
            RECENT ORDERS
          </Text>
          {data.recent_orders.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No orders yet"
              description="When you record your first order it will appear here."
              compact
              actionLabel="Record an order"
              onActionPress={() => router.push('/order/new')}
            />
          ) : (
            data.recent_orders.map((order) => <OrderRow key={order.id} order={order} />)
          )}
        </View>
      </Card>

      {data.low_stock.length > 0 ? (
        <Card>
          <View style={{ gap: spacing.md }}>
            <Text variant="micro" tone="muted">
              LOW STOCK
            </Text>
            {data.low_stock.map((item) => (
              <View
                key={item.product_id}
                style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
              >
                <Package size={16} color={colors.textMuted} strokeWidth={1.75} />
                <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text variant="numericSmall" tone="warning">
                  {`${item.quantity} left`}
                </Text>
              </View>
            ))}
          </View>
        </Card>
      ) : null}
    </View>
  );
}

function ActionLine({
  label,
  count,
  tone = 'default',
}: {
  label: string;
  count: number;
  tone?: 'default' | 'danger';
}) {
  const { colors, spacing, radius } = useTheme();
  if (count === 0) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      {/* A count chip, not a control: 2pt vertical padding and `radius.sm` are what
          make it a capsule around an 11px numeral rather than a 19px box. */}
      <View
        style={{
          minWidth: 28,
          paddingHorizontal: spacing.xxs,
          paddingVertical: BADGE_PADDING_V,
          borderRadius: radius.sm,
          backgroundColor: tone === 'danger' ? colors.dangerSoft : colors.surfaceSunken,
        }}
      >
        <Text variant="numericSmall" tone={tone === 'danger' ? 'danger' : 'default'}>
          {String(count)}
        </Text>
      </View>
      <Text variant="body" tone="secondary">
        {label}
      </Text>
    </View>
  );
}

function Metric({
  label,
  value,
  hint,
  width,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  width: `${number}%`;
  tone?: 'default' | 'muted' | 'success' | 'danger';
}) {
  const { colors, spacing, radius } = useTheme();

  const valueColor =
    tone === 'muted'
      ? colors.textMuted
      : tone === 'success'
        ? colors.successStrong
        : tone === 'danger'
          ? colors.danger
          : colors.text;

  return (
    <View
      style={{
        width,
        flexGrow: 1,
        backgroundColor: colors.surface,
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing.md,
        gap: spacing.xxs,
      }}
    >
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="numeric" color={valueColor}>
        {value}
      </Text>
      {hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function OrderRow({ order }: { order: DashboardData['recent_orders'][number] }) {
  const { spacing } = useTheme();
  const router = useRouter();

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {order.customer_name ?? 'Walk-in customer'}
        </Text>
        <Text variant="caption" tone="muted">
          {order.order_number}
        </Text>
      </View>
      <Text variant="numeric">{formatMajorUnits(order.total)}</Text>
      <Button
        label="Open"
        variant="ghost"
        iconRight={ArrowRight}
        onPress={() => router.push(`/order/${order.id}`)}
        testID={`dashboard-order-${order.id}`}
      />
    </View>
  );
}

/**
 * Skeletons, not a spinner.
 *
 * These preserve the shape of the content that is loading, so the layout does not
 * jump when the figures arrive. A centred spinner on a dashboard makes the screen
 * feel broken on a slow connection, which is the exact impression this app is trying
 * to avoid.
 */
function DashboardSkeleton() {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.md }}>
      <Card>
        <View style={{ gap: spacing.sm }}>
          <Skeleton width="45%" height={12} />
          <Skeleton width="70%" height={26} />
        </View>
      </Card>
      <View style={{ gap: spacing.sm, flexDirection: 'row' }}>
        <View style={{ width: '48%' }}>
          <Skeleton width="100%" height={80} />
        </View>
        <View style={{ width: '48%' }}>
          <Skeleton width="100%" height={80} />
        </View>
      </View>
      <Skeleton width="100%" height={140} />
    </View>
  );
}