/**
 * Expenses list.
 *
 * Expenses are what turn gross profit into net profit. This screen shows the
 * month's total against sales so the seller can see the real picture, then the
 * individual entries underneath.
 */

import { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Receipt, TrendingDown } from 'lucide-react-native';

import { IconButton, ScreenHeader } from '@/components/ScreenHeader';
import {
  AmountRow,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  ListRowSkeleton,
  SectionHeader,
  SellflowRefreshControl,
  Text,
  confirm,
  useRefresh,
} from '@/components/ui';
import { useSalesReport } from '@/features/dashboard/queries';
import { expenseLabel, useDeleteExpense, useExpenses } from '@/features/expenses/queries';
import { AppError } from '@/lib/errors';
import { formatDate, toDateString } from '@/lib/format';
import { EXACT, formatMoney, money, type CurrencyCode } from '@/lib/money';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function ExpensesScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const store = useSession((state) => state.store);
  const organization = useSession((state) => state.organization);
  const role = useSession((state) => state.role);
  const canWrite = role === 'owner' || role === 'manager';
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const expenses = useExpenses(store?.id);
  // Destructured so the refresh callback depends on the function itself.
  const { refetch } = expenses;

  /*
   * Tied to the seller's gesture rather than to `isFetching`, which also rises
   * for the refetch-on-focus below. The indicator should mean "you pulled", not
   * "the screen happened to reload".
   */
  const refresh = useRefresh(
    useCallback(async () => {
      await refetch();
    }, [refetch]),
  );
  const deleteExpense = useDeleteExpense();

  const now = new Date();
  const monthStart = toDateString(new Date(now.getFullYear(), now.getMonth(), 1));
  const today = toDateString(now);
  const report = useSalesReport(store?.id, monthStart, today);

  useFocusEffect(
    useCallback(() => {
      void expenses.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const revenue = money(report.data?.totals.revenue ?? 0, currency);
  const grossProfit = money(report.data?.totals.profit ?? 0, currency);
  const expenseTotal = money(report.data?.expenses ?? 0, currency);
  const net = grossProfit - expenseTotal;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Expenses"
        subtitle="This month"
        right={
          canWrite ? (
            <IconButton onPress={() => router.push('/(app)/expense/new')} label="Add expense" tone="primary">
              <Plus size={20} color={colors.primary} strokeWidth={2.25} />
            </IconButton>
          ) : undefined
        }
      />

      <FlatList
        data={expenses.expenses}
        keyExtractor={(item) => item.id}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingBottom: insets.bottom + 24,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
          refreshControl={<SellflowRefreshControl {...refresh} />}
        onEndReached={expenses.loadMore}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <View style={{ gap: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md }}>
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.sm }}>
                <TrendingDown size={18} color={colors.textSecondary} strokeWidth={2} />
                <Text variant="heading">Month to date</Text>
              </View>

              <AmountRow label="Revenue" value={revenue} currency={currency} />
              <AmountRow label="Gross profit" value={grossProfit} currency={currency} />
              <AmountRow
                label="Expenses"
                value={-expenseTotal}
                currency={currency}
                tone="danger"
              />
              <AmountRow
                label="Net profit"
                value={net}
                currency={currency}
                emphasis
                tone={net >= 0 ? 'success' : 'danger'}
              />
            </Card>

            <SectionHeader title="All expenses" />
          </View>
        }
        renderItem={({ item }) => (
          <ExpenseRow
            id={item.id}
            description={item.description ?? expenseLabel(item.category)}
            category={expenseLabel(item.category)}
            date={item.incurred_on}
            amount={money(item.amount, currency)}
            currency={currency}
            canDelete={canWrite}
            onDelete={async () => {
              const confirmed = await confirm({
                title: 'Delete this expense?',
                message: 'This cannot be undone.',
                confirmLabel: 'Delete',
                destructive: true,
              });
              if (confirmed) await deleteExpense.mutateAsync(item.id);
            }}
          />
        )}
        ListEmptyComponent={
          expenses.isLoading ? (
            <View style={{ gap: spacing.xs }}>
              {[0, 1, 2].map((key) => (
                <ListRowSkeleton key={key} />
              ))}
            </View>
          ) : expenses.isError ? (
            <ErrorState
              title={AppError.from(expenses.error).title}
              action={AppError.from(expenses.error).action}
              onRetry={() => void expenses.refetch()}
            />
          ) : (
            <EmptyState
              icon={Receipt}
              title="No expenses yet"
              description="Record advertising, packaging, delivery and sourcing costs so your real profit is accurate."
              actionLabel={canWrite ? 'Record your first expense' : undefined}
              onActionPress={canWrite ? () => router.push('/(app)/expense/new') : undefined}
            />
          )
        }
      />
    </View>
  );
}

function ExpenseRow({
  id,
  description,
  category,
  date,
  amount,
  currency,
  canDelete,
  onDelete,
}: {
  id: string;
  description: string;
  category: string;
  date: string;
  amount: number;
  currency: CurrencyCode;
  canDelete: boolean;
  onDelete: () => Promise<void>;
}) {
  const { colors, spacing, radius } = useTheme();

  return (
    <Pressable
      onLongPress={canDelete ? () => void onDelete() : undefined}
      accessibilityRole="button"
      accessibilityLabel={`${description}, ${formatMoney(amount, currency, EXACT)}`}
      delayLongPress={400}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderRadius: radius.card,
          padding: spacing.md,
          marginBottom: spacing.xs,
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <Text variant="subtitle" numberOfLines={1}>
          {description}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Badge label={category} />
          <Text variant="micro" tone="muted">{formatDate(date)}</Text>
        </View>
      </View>

<Text variant="numeric" tone="danger">
        −{formatMoney(amount, currency, EXACT)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
