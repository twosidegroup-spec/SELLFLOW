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
import { useDashboard, type DashboardData } from '@/features/dashboard/queries';
import { formatMoney } from '@/lib/money';
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

        {isPending || !data ? <DashboardSkeleton /> : <DashboardBody data={data} />}
      </View>
    </Screen>
  );
}

/**
 * The real figures.
 *
 * `get_dashboard` returns profit as a number because it is derived from costs that
 * were entered; when a seller has never recorded a cost, it is zero and saying zero
 * would be a lie about their business. So the honest reading is shown next to it.
 */
function DashboardBody({ data }: { data: DashboardData }) {
  const { colors, spacing } = useTheme();
  const router = useRouter();

  const action = data.action;
  const hasActions =
    action.to_confirm + action.to_pack + action.to_ship + action.out_for_delivery + action.failed > 0;
  const hasCosts = data.costs.product + data.costs.courier + data.costs.other > 0;

  return (
    <View style={{ gap: spacing.md }}>
      <Card>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="micro" tone="muted">
            REVENUE TODAY
          </Text>
          <Text variant="numericLarge">{formatMoney(data.today.revenue)}</Text>
          <Text variant="caption" tone="muted">
            {`${data.today.orders} order${data.today.orders === 1 ? '' : 's'}`}
          </Text>
        </View>
      </Card>

      <View style={{ gap: spacing.sm, flexDirection: 'row', flexWrap: 'wrap' }}>
        <Metric
          label="Profit today"
          value={hasCosts ? formatMoney(data.today.profit) : 'Not recorded'}
          tone={!hasCosts ? 'muted' : data.today.profit > 0 ? 'success' : data.today.profit < 0 ? 'danger' : 'default'}
          width="48%"
        />
        <Metric
          label="Average order"
          value={formatMoney(data.aov_month)}
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
              {formatMoney(data.cod.pending_settlement)}
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
      <Text variant="numeric">{formatMoney(order.total)}</Text>
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