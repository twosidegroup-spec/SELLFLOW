/**
 * Expense queries.
 *
 * Expenses are recorded directly rather than through an RPC: a single insert
 * with no cross-table consistency requirement. RLS still applies, so a user
 * cannot write an expense into another organization's ledger.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ExpenseCategory, ExpenseRow } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { keys } from '@/lib/queryClient';
import { getSupabase } from '@/lib/supabase';

const PAGE_SIZE = 30;

export const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: 'advertising', label: 'Advertising' },
  { value: 'packaging', label: 'Packaging' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'sourcing', label: 'Product sourcing' },
  { value: 'software', label: 'Software' },
  { value: 'salary', label: 'Salary' },
  { value: 'rent', label: 'Rent' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'miscellaneous', label: 'Miscellaneous' },
];

export function expenseLabel(category: ExpenseCategory): string {
  return EXPENSE_CATEGORIES.find((entry) => entry.value === category)?.label ?? category;
}

export interface ExpenseInput {
  amount: number;
  category: ExpenseCategory;
  incurredOn: string;
  description: string | null;
  note: string | null;
}

export function useExpenses(storeId: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: ['expenses-list', storeId ?? ''],
    enabled: Boolean(storeId),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await getSupabase()
        .from('expenses')
        .select('*')
        .eq('store_id', storeId as string)
        .order('incurred_on', { ascending: false })
        .order('created_at', { ascending: false })
        .range(pageParam, pageParam + PAGE_SIZE - 1);

      if (error) throw AppError.from(error);
      return (data ?? []) as ExpenseRow[];
    },
    getNextPageParam: (lastPage) => (lastPage.length < PAGE_SIZE ? undefined : lastPage.length),
  });

  return {
    expenses: query.data?.pages.flat() ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
  };
}

export function useCreateExpense() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      orgId,
      storeId,
      input,
    }: {
      orgId: string;
      storeId: string;
      input: ExpenseInput;
    }) => {
      const { data, error } = await getSupabase()
        .from('expenses')
        .insert({
          org_id: orgId,
          store_id: storeId,
          amount: input.amount,
          category: input.category,
          incurred_on: input.incurredOn,
          description: input.description,
          note: input.note,
        })
        .select()
        .single();

      if (error) throw AppError.from(error);
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['expenses-list'] }),
        queryClient.invalidateQueries({ queryKey: keys.expenses('') }),
        queryClient.invalidateQueries({ queryKey: ['sales-report'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });
}

export function useDeleteExpense() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (expenseId: string) => {
      const { error } = await getSupabase().from('expenses').delete().eq('id', expenseId);
      if (error) throw AppError.from(error);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['expenses-list'] }),
        queryClient.invalidateQueries({ queryKey: ['sales-report'] }),
      ]);
    },
  });
}

/** Totals per category for the current month. */
export function useExpenseTotals(storeId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: ['expense-totals', storeId ?? '', from, to],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('expenses')
        .select('category, amount')
        .eq('store_id', storeId as string)
        .gte('incurred_on', from)
        .lte('incurred_on', to);

      if (error) throw AppError.from(error);

      const totals = new Map<ExpenseCategory, number>();
      for (const row of data ?? []) {
        totals.set(row.category, (totals.get(row.category) ?? 0) + row.amount);
      }

      const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
      return { byCategory: totals, total };
    },
  });
}
