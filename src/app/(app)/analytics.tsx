/**
 * Analytics.
 *
 * Revenue and profit across a selectable window, with the three product
 * rankings kept deliberately separate. The most-sold item, the highest-earning
 * item and the highest-margin item are frequently three different products, and
 * collapsing them into one "best product" number hides the decision a seller is
 * actually trying to make.
 */

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { BarChart3, TrendingUp, Trophy } from 'lucide-react-native';

import { IconButton, ScreenHeader } from '@/components/ScreenHeader';
import {
  Amount,
  AmountRow,
  Card,
  CountRow,
  Divider,
  ErrorState,
  SegmentedControl,
  Skeleton,
  Text,
} from '@/components/ui';
import {
  useAnalytics,
  useProductPerformance,
  type PerformanceEntry,
} from '@/features/dashboard/queries';
import { AppError } from '@/lib/errors';
import { toDateString, formatRelativeDay } from '@/lib/format';
import { money, formatCompactMoney, type CurrencyCode } from '@/lib/money';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

type RangeKey = 'today' | 'week' | 'month' | 'year' | 'custom';

const RANGES: { value: RangeKey; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

function rangeFor(key: RangeKey): { from: string; to: string; label: string } {
  const now = new Date();
  const to = toDateString(now);

  switch (key) {
    case 'today':
      return { from: to, to, label: 'Today' };
    case 'week': {
      const start = new Date(now);
      start.setDate(start.getDate() - 6);
      return { from: toDateString(start), to, label: 'Last 7 days' };
    }
    case 'year': {
      const start = new Date(now.getFullYear(), 0, 1);
      return { from: toDateString(start), to, label: String(now.getFullYear()) };
    }
    default: {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: toDateString(start), to, label: 'This month' };
    }
  }
}

export default function AnalyticsScreen() {
  const { colors, spacing } = useTheme();
  const organization = useSession((state) => state.organization);
  const store = useSession((state) => state.store);
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const [range, setRange] = useState<RangeKey>('month');
  const window_ = useMemo(() => rangeFor(range), [range]);

  const analytics = useAnalytics(store?.id, window_.from, window_.to);
  const performance = useProductPerformance(store?.id, window_.from, window_.to);

  const data = analytics.data;

  const successRate =
    data && data.totals.orders > 0
      ? Math.round((data.delivery.delivered_orders / data.totals.orders) * 100)
      : null;

  const returnRate =
    data && data.totals.orders > 0
      ? Math.round((data.delivery.returned_orders / data.totals.orders) * 100)
      : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Analytics"
        subtitle={window_.label}
        right={
          <IconButton onPress={() => router.back()} label="Close" tone="primary">
            <Text variant="heading" tone="primary">×</Text>
          </IconButton>
        }
      />

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.xxxl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <SegmentedControl
          options={RANGES}
          value={range}
          onChange={setRange}
          style={{ marginBottom: spacing.lg }}
        />

        {analytics.isLoading ? (
          <View style={{ gap: spacing.md }}>
            <Card style={{ gap: spacing.md }}>
              <Skeleton width="50%" height={26} />
              <Skeleton width="70%" height={18} />
            </Card>
            <Card>
              <Skeleton width="100%" height={80} />
            </Card>
          </View>
        ) : analytics.isError || !data ? (
          <ErrorState
            title={AppError.from(analytics.error).title}
            action={AppError.from(analytics.error).action}
            onRetry={() => void analytics.refetch()}
          />
        ) : (
          <View style={{ gap: spacing.lg }}>
            {/* Revenue vs profit, stated separately --------------------- */}
            <Card>
              <View style={styles.header}>
                <TrendingUp size={18} color={colors.textSecondary} strokeWidth={2} />
                <Text variant="heading">Revenue and profit</Text>
              </View>

              <View style={{ marginTop: spacing.md }}>
                <AmountRow
                  label="Revenue"
                  value={money(data.totals.revenue, currency)}
                  currency={currency}
                  size="lg"
                  sublabel="What customers paid"
                />
                <AmountRow
                  label="Gross profit"
                  value={money(data.totals.profit, currency)}
                  currency={currency}
                  size="lg"
                  tone={data.totals.profit >= 0 ? 'success' : 'danger'}
                  sublabel="After product, courier and other costs"
                />
                {data.totals.revenue > 0 ? (
                  <Text variant="micro" tone="muted" style={{ marginTop: spacing.xxs }}>
                    Margin {Math.round((data.totals.profit / data.totals.revenue) * 100)}%
                  </Text>
                ) : null}
              </View>

              <Divider style={{ marginVertical: spacing.md }} />

              <AmountRow
                label="Expenses"
                value={-money(data.expenses.total, currency)}
                currency={currency}
                tone="danger"
              />
              <AmountRow
                label="Net profit"
                value={money(data.net_profit, currency)}
                currency={currency}
                emphasis
                tone={data.net_profit >= 0 ? 'success' : 'danger'}
                sublabel="What is actually yours"
              />
            </Card>

            {/* Cost breakdown ------------------------------------------ */}
            <Card>
              <Text variant="heading">Where the money goes</Text>
              <View style={{ marginTop: spacing.sm }}>
                <AmountRow
                  label="Product cost"
                  value={-money(data.totals.product_cost, currency)}
                  currency={currency}
                />
                {data.totals.courier_cost > 0 ? (
                  <AmountRow
                    label="Courier"
                    value={-money(data.totals.courier_cost, currency)}
                    currency={currency}
                  />
                ) : null}
                {data.totals.other_cost > 0 ? (
                  <AmountRow
                    label="Packaging and other"
                    value={-money(data.totals.other_cost, currency)}
                    currency={currency}
                  />
                ) : null}
                <AmountRow
                  label="Recorded expenses"
                  value={-money(data.expenses.total, currency)}
                  currency={currency}
                />
              </View>
            </Card>

            {/* Metrics ------------------------------------------------- */}
            <Card>
              <Text variant="heading">Metrics</Text>
              <View style={{ marginTop: spacing.sm }}>
                {/* Counts, not money. Routing a count through the money
                    formatter is what rendered "15 orders" as "Tk15.00.00". */}
                <CountRow
                  label="Orders"
                  value={data.totals.orders}
                  sublabel="Excludes cancelled, returned and failed"
                />
                <CountRow label="Units sold" value={data.units_sold} />
                <AmountRow
                  label="Average order value"
                  value={money(data.average_order_value, currency)}
                  currency={currency}
                />
                <AmountRow
                  label="Average selling price"
                  value={money(data.average_selling_price, currency)}
                  currency={currency}
                  sublabel="Per unit, after discounts"
                />
                {successRate !== null ? (
                  <CountRow
                    label="Delivery success rate"
                    value={`${successRate}%`}
                    sublabel={`${data.delivery.delivered_orders} of ${data.totals.orders} delivered`}
                  />
                ) : null}
                {returnRate !== null && data.delivery.returned_orders > 0 ? (
                  <CountRow
                    label="Return rate"
                    value={`${returnRate}%`}
                    tone={returnRate > 10 ? 'danger' : 'secondary'}
                  />
                ) : null}
              </View>
            </Card>

            {/* Delivered vs placed -------------------------------------- */}
            <Card>
              <Text variant="heading">Deliveries</Text>
              <View style={{ marginTop: spacing.sm }}>
                <AmountRow
                  label="Delivered revenue"
                  value={money(data.delivery.delivered_revenue, currency)}
                  currency={currency}
                  sublabel="Money actually earned"
                />
                <CountRow
                  label="Still in progress"
                  value={data.delivery.open_orders}
                  suffix={data.delivery.open_orders === 1 ? 'order' : 'orders'}
                  sublabel="Not yet delivered"
                />
                {data.delivery.failed_deliveries > 0 ? (
                  <CountRow
                    label="Failed deliveries"
                    value={data.delivery.failed_deliveries}
                    tone="danger"
                  />
                ) : null}
                {data.delivery.returned_orders > 0 ? (
                  <CountRow
                    label="Returned"
                    value={data.delivery.returned_orders}
                    tone="danger"
                  />
                ) : null}
              </View>
            </Card>

            {/* Three separate rankings --------------------------------- */}
            <ProductRanking
              title="Most sold by quantity"
              entries={performance.data?.byQuantity ?? []}
              currency={currency}
              metric="units"
            />
            <ProductRanking
              title="Highest revenue"
              entries={performance.data?.byRevenue ?? []}
              currency={currency}
              metric="revenue"
            />
            <ProductRanking
              title="Highest profit"
              entries={performance.data?.byProfit ?? []}
              currency={currency}
              metric="profit"
            />

            <Card>
              <View style={styles.header}>
                <BarChart3 size={18} color={colors.textSecondary} strokeWidth={2} />
                <Text variant="heading">Daily</Text>
              </View>
              <View style={{ marginTop: spacing.sm, gap: spacing.xxs }}>
                {data.daily.slice(-7).map((day) => (
                  <View key={day.day} style={styles.dailyRow}>
                    {/*
                      The SQL builds this as `jsonb_build_object('day', d::date)`,
                      and PostgREST serialises a date column as a full ISO
                      timestamp. Printing that raw put
                      "2026-10-01T00:00:00+00:00" on screen, wrapped across two
                      lines. `formatRelativeDay` reads it as a day, which is the
                      question the row is answering.
                    */}
                    <Text variant="caption" tone="muted" style={{ flex: 1 }} numberOfLines={1}>
                      {formatRelativeDay(day.day)}
                    </Text>
                    <Text variant="caption" tone="secondary">
                      {day.orders} {day.orders === 1 ? 'order' : 'orders'}
                    </Text>
                    <Text variant="subtitle" style={{ minWidth: 88, textAlign: 'right' }}>
                      {formatCompactMoney(money(day.revenue, currency), currency)}
                    </Text>
                  </View>
                ))}
              </View>
            </Card>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * A count with its label, mirroring `AmountRow` but without a currency.
 *
 * Deliberately a separate component rather than an `AmountRow` with a zero
 * currency: the two must never be interchanged by accident, because a count
 * printed with a currency symbol is a lie about what is being measured.
 */
/**
 * Product performance ranking.
 *
 * The "most sold" ranking shows a unit count, because that is the question it
 * answers. Printing it with a currency symbol would misdescribe the figure.
 */
function ProductRanking({
  title,
  entries,
  currency,
  metric,
}: {
  title: string;
  entries: PerformanceEntry[];
  currency: CurrencyCode;
  metric: 'units' | 'revenue' | 'profit';
}) {
  const { colors, spacing } = useTheme();

  return (
    <View>
      <View style={[styles.header, { marginBottom: spacing.sm }]}>
        <Trophy size={17} color={colors.textSecondary} strokeWidth={2} />
        <Text variant="heading">{title}</Text>
      </View>

      <Card flush>
        {entries.length === 0 ? (
          <View style={{ padding: spacing.lg }}>
            <Text variant="caption" tone="muted" center>
              No sales in this period yet.
            </Text>
          </View>
        ) : (
          entries.map((entry, index) => (
            <View key={entry.product_id}>
              <Pressable
                onPress={() => router.push(`/(app)/product/${entry.product_id}`)}
                accessibilityRole="button"
                accessibilityLabel={`${title}: ${entry.name}`}
                style={({ pressed }) => [styles.rankRow, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Text variant="numeric" tone="muted" style={{ width: 22 }}>
                  {index + 1}
                </Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="subtitle" numberOfLines={1}>
                    {entry.name}
                  </Text>
                  <Text variant="micro" tone="muted">
                    {entry.units} sold
                  </Text>
                </View>
                {metric === 'units' ? (
                  <Text variant="numeric">{entry.units}</Text>
                ) : (
                  <Amount
                    value={money(entry[metric], currency)}
                    currency={currency}
                    tone={metric === 'profit' && entry.profit >= 0 ? 'success' : 'primary'}
                  />
                )}
              </Pressable>
              {index < entries.length - 1 ? <Divider /> : null}
            </View>
          ))
        )}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dailyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  rankRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 56,
  },
});
