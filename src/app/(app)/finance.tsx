/**
 * Finance.
 *
 * One screen that keeps three pairs of numbers apart, because conflating any of
 * them misleads a seller about their own business:
 *
 *   revenue  != profit
 *   delivered != settled
 *   expected COD != money in hand
 *
 * Every figure comes from get_finance, which computes them from rows.
 */

import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Wallet } from 'lucide-react-native';

import { IconButton, ScreenHeader } from '@/components/ScreenHeader';
import {
  Amount,
  AmountRow,
  Card,
  Divider,
  ErrorState,
  SegmentedControl,
  Skeleton,
  SellflowRefreshControl,
  Text,
  useRefresh,
} from '@/components/ui';
import { useFinance } from '@/features/dashboard/queries';
import { AppError } from '@/lib/errors';
import { toDateString } from '@/lib/format';
import { formatCompactMoney, money, type CurrencyCode } from '@/lib/money';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

type RangeKey = 'today' | 'week' | 'month' | 'year';

const RANGES: { value: RangeKey; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

export default function FinanceScreen() {
  const { colors, spacing } = useTheme();
  const organization = useSession((state) => state.organization);
  const store = useSession((state) => state.store);
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const [range, setRange] = useState<RangeKey>('month');
  const window_ = useMemo(() => {
    const now = new Date();
    const to = toDateString(now);
    if (range === 'today') return { from: to, to };
    if (range === 'week') {
      const start = new Date(now);
      start.setDate(start.getDate() - 6);
      return { from: toDateString(start), to };
    }
    if (range === 'year') {
      return { from: toDateString(new Date(now.getFullYear(), 0, 1)), to };
    }
    return { from: toDateString(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  }, [range]);

  const finance = useFinance(store?.id, window_.from, window_.to);
  // Destructured so the refresh callback depends on the function itself.
  const { refetch } = finance;

  /*
   * Like Analytics: a date-window query with no refetch on focus, so revenue and
   * profit were stale on every entry. These are the two figures a seller is most
   * likely to check after taking a payment elsewhere.
   */
  const refresh = useRefresh(
    useCallback(async () => {
      await refetch();
    }, [refetch]),
  );
  const data = finance.data;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Finance"
        subtitle={store?.name}
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
        refreshControl={<SellflowRefreshControl {...refresh} />}
      >
        <SegmentedControl
          options={RANGES}
          value={range}
          onChange={setRange}
          style={{ marginBottom: spacing.lg }}
        />

        {finance.isLoading ? (
          <View style={{ gap: spacing.md }}>
            <Card style={{ gap: spacing.md }}>
              <Skeleton width="50%" height={26} />
              <Skeleton width="70%" height={18} />
            </Card>
            <Card>
              <Skeleton width="100%" height={120} />
            </Card>
          </View>
        ) : finance.isError || !data ? (
          <ErrorState
            title={AppError.from(finance.error).title}
            action={AppError.from(finance.error).action}
            onRetry={() => void finance.refetch()}
          />
        ) : (
          <View style={{ gap: spacing.lg }}>
            {/* The number that matters ------------------------------- */}
            <Card>
              <Text variant="micro" tone="muted">Net profit</Text>
              <Amount
                value={money(data.net_profit, currency)}
                currency={currency}
                size="xl"
                tone={data.net_profit >= 0 ? 'success' : 'danger'}
              />
              <Text variant="micro" tone="muted" style={{ marginTop: spacing.xxs }}>
                Gross profit minus every recorded expense
              </Text>
            </Card>

            {/* Revenue ---------------------------------------------- */}
            {/*
              These figures OVERLAP rather than stack, and the layout has to say
              so structurally rather than relying on a footnote.

              `gross_sales` is the sum of order totals, and an order total is
              items - discount + delivery. So delivery and discount are already
              INSIDE gross sales. Presented as peers of it, the natural reading is
              "add them up", which would double-count delivery.

              Therefore: gross sales is the only emphasised figure, and the two
              components sit under a heading that names them as parts of it.
              Nothing on this card can be summed into anything else.
            */}
            <Card>
              <Text variant="heading">Revenue</Text>
              <AmountRow
                label="Gross sales"
                value={money(data.revenue.gross_sales, currency)}
                currency={currency}
                size="lg"
                emphasis
                sublabel="Everything customers were charged, delivery included"
              />

              <AmountRow
                label="Delivered sales"
                value={money(data.revenue.delivered_sales, currency)}
                currency={currency}
                tone="success"
                sublabel="Orders that actually arrived"
              />

              <Divider style={{ marginVertical: spacing.sm }} />

              <Text variant="micro" tone="muted">
                Already inside gross sales — not added to it
              </Text>

              {data.revenue.delivery_charged > 0 ? (
                <AmountRow
                  label="Delivery charged"
                  value={money(data.revenue.delivery_charged, currency)}
                  currency={currency}
                  tone="secondary"
                />
              ) : null}
              {data.revenue.discount_given > 0 ? (
                <AmountRow
                  label="Discounts given"
                  value={-money(data.revenue.discount_given, currency)}
                  currency={currency}
                  tone="secondary"
                />
              ) : null}

              <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs }}>
                Gross sales and delivered sales differ. An order that has not arrived is not
                money you have earned.
              </Text>
            </Card>

            {/* Costs ------------------------------------------------ */}
            <Card>
              <Text variant="heading">Costs</Text>
              <View style={{ marginTop: spacing.sm }}>
                <AmountRow
                  label="Product cost"
                  value={-money(data.costs.product, currency)}
                  currency={currency}
                />
                <AmountRow
                  label="Courier"
                  value={-money(data.costs.courier, currency)}
                  currency={currency}
                />
                <AmountRow
                  label="Packaging and other"
                  value={-money(data.costs.other, currency)}
                  currency={currency}
                />
                <AmountRow
                  label="Recorded expenses"
                  value={-money(data.costs.expenses, currency)}
                  currency={currency}
                />
                <AmountRow
                  label="Total cost"
                  value={-(
                    money(data.costs.product, currency) +
                    money(data.costs.courier, currency) +
                    money(data.costs.other, currency) +
                    money(data.costs.expenses, currency)
                  )}
                  currency={currency}
                  emphasis
                  tone="danger"
                />
              </View>
            </Card>

            {/* Payments --------------------------------------------- */}
            <Card>
              <Text variant="heading">Payments received</Text>
              <View style={{ marginTop: spacing.sm }}>
                <AmountRow
                  label="Collected directly"
                  value={money(data.payments.paid, currency)}
                  currency={currency}
                  tone="success"
                />
                {data.payments.refunded > 0 ? (
                  <AmountRow
                    label="Refunded"
                    value={-money(data.payments.refunded, currency)}
                    currency={currency}
                    tone="danger"
                  />
                ) : null}
              </View>
            </Card>

            {/* COD --------------------------------------------------- */}
            {data.cod.expected > 0 ? (
              <Card>
                <View style={styles.header}>
                  <Wallet size={18} color={colors.textSecondary} strokeWidth={2} />
                  <Text variant="heading">Cash on delivery</Text>
                </View>

                <View style={{ marginTop: spacing.sm }}>
                  <AmountRow
                    label="Courier was asked to collect"
                    value={money(data.cod.expected, currency)}
                    currency={currency}
                  />
                  <AmountRow
                    label="Still with the courier"
                    value={money(data.cod.pending, currency)}
                    currency={currency}
                    tone="danger"
                  />
                  <AmountRow
                    label="Paid out to you"
                    value={money(data.cod.settled, currency)}
                    currency={currency}
                    tone="success"
                  />
                </View>

                <Divider style={{ marginVertical: spacing.sm }} />

                <Text variant="caption" tone="secondary">
                  {data.cod.orders} {data.cod.orders === 1 ? 'order uses' : 'orders use'} cash on
                  delivery.{' '}
                  {formatCompactMoney(money(data.cod.pending, currency), currency)} of that is still
                  with the courier and {formatCompactMoney(money(data.cod.settled, currency), currency)}{' '}
                  has reached you.
                </Text>
                <Text variant="micro" tone="muted" style={{ marginTop: spacing.xxs }}>
                  Settle each order from its detail screen once the money reaches you.
                </Text>
              </Card>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
