/**
 * Customer queries and mutations.
 *
 * Customers live in Supabase, not local state -- requirement 17. The list is
 * paginated and searched server-side so a directory of thousands of customers
 * does not have to be downloaded to show the first twenty.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { CustomerRow, Database } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { keys } from '@/lib/queryClient';
import { getSupabase } from '@/lib/supabase';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

const PAGE_SIZE = 25;

export interface CustomerInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
}

export function useCustomers(orgId: string | undefined) {
  const [search, setSearch] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const debounced = useDebouncedValue(search.trim(), 300);

  const query = useInfiniteQuery({
    queryKey: ['customers-list', orgId ?? '', debounced, includeArchived],
    enabled: Boolean(orgId),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const supabase = getSupabase();

      let request = supabase
        .from('customers')
        .select('*')
        .order('name', { ascending: true })
        .range(pageParam, pageParam + PAGE_SIZE - 1);

      if (!includeArchived) request = request.eq('is_archived', false);

      if (debounced.length > 0) {
        // Name or phone. Sellers find customers by either, often mid-call.
        request = request.or(`name.ilike.%${debounced}%,phone.ilike.%${debounced}%`);
      }

      const { data, error } = await request;
      if (error) throw error;
      return (data ?? []) as CustomerRow[];
    },
    getNextPageParam: (lastPage) => (lastPage.length < PAGE_SIZE ? undefined : lastPage.length),
  });

  return {
    customers: query.data?.pages.flat() ?? [],
    search,
    setSearch,
    includeArchived,
    setIncludeArchived,
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

export function useCustomer(customerId: string | undefined) {
  return useQuery({
    queryKey: keys.customer(customerId ?? ''),
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('customers')
        .select('*')
        .eq('id', customerId as string)
        .single();

      if (error) throw error;
      return data;
    },
  });
}

/** Aggregate spending figures, computed server-side so they cannot drift. */
export interface CustomerStats {
  order_count: number;
  total_spent: number;
  outstanding: number;
  last_order_at: string | null;
  cancelled_count: number;
}

export function useCustomerStats(customerId: string | undefined) {
  return useQuery({
    queryKey: keys.customerStats(customerId ?? ''),
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('get_customer_stats', {
        p_customer_id: customerId as string,
      });

      if (error) throw AppError.from(error);

      const stats = (data ?? {}) as Partial<CustomerStats>;
      return {
        order_count: stats.order_count ?? 0,
        total_spent: stats.total_spent ?? 0,
        outstanding: stats.outstanding ?? 0,
        last_order_at: stats.last_order_at ?? null,
        cancelled_count: stats.cancelled_count ?? 0,
      } satisfies CustomerStats;
    },
  });
}

export function useCreateCustomer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, input }: { orgId: string; input: CustomerInput }) => {
      const { data, error } = await getSupabase()
        .from('customers')
        .insert({
          org_id: orgId,
          name: input.name.trim(),
          phone: input.phone?.trim() || null,
          email: input.email?.trim() || null,
          address: input.address?.trim() || null,
          notes: input.notes?.trim() || null,
        })
        .select()
        .single();

      if (error) throw AppError.from(error);
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['customers-list'] }),
        queryClient.invalidateQueries({ queryKey: keys.customers() }),
        queryClient.invalidateQueries({ queryKey: ['customer-picker'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });
}

export function useUpdateCustomer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      customerId,
      input,
    }: {
      customerId: string;
      input: Partial<CustomerInput> & { is_archived?: boolean };
    }) => {
      const update: Database['public']['Tables']['customers']['Update'] = {};

      if (input.name !== undefined) update.name = input.name.trim();
      if (input.phone !== undefined) update.phone = input.phone?.trim() || null;
      if (input.email !== undefined) update.email = input.email?.trim() || null;
      if (input.address !== undefined) update.address = input.address?.trim() || null;
      if (input.notes !== undefined) update.notes = input.notes?.trim() || null;
      if (input.is_archived !== undefined) update.is_archived = input.is_archived;

      const { data, error } = await getSupabase()
        .from('customers')
        .update(update)
        .eq('id', customerId)
        .select()
        .single();

      if (error) throw AppError.from(error);
      return data;
    },
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.customer(variables.customerId) }),
        queryClient.invalidateQueries({ queryKey: ['customers-list'] }),
        queryClient.invalidateQueries({ queryKey: ['customer-picker'] }),
      ]);
    },
  });
}

/**
 * Picker data for the order builder.
 *
 * A single page of 50: the customer is usually found by typing a name or phone
 * number, and scrolling a long directory inside a sheet is rare.
 */
/**
 * A possible existing customer, as reported by find_duplicate_customers.
 *
 * `match` is 'phone' or 'name'. Phone is the stronger signal, so the UI leads
 * with it; a name-only match is a hint, never an instruction to merge.
 */
export interface DuplicateCandidate {
  id: string;
  name: string;
  phone: string | null;
  district: string | null;
  order_count: number;
  match: 'phone' | 'name';
}

export interface DuplicateCheck {
  matches: DuplicateCandidate[];
  /** True when a phone number matches exactly, which is almost certainly the same person. */
  exactPhone: boolean;
  isLoading: boolean;
  /** False until the seller has been shown the candidates and chosen. */
  resolved: boolean;
  /** The seller has confirmed this is a different person. */
  markResolved: () => void;
}

/**
 * Asks the server who this might already be.
 *
 * Deliberately advisory. It never merges, never blocks and never rewrites what
 * the seller typed -- two people can share a name or even a phone number, and
 * the only person who knows which is which is the seller. The function also
 * runs in the database, so a record created on another device while this screen
 * was open is still caught.
 */
export function useDuplicateCustomerCheck(
  orgId: string | undefined,
  name: string,
  phone: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const [resolved, setResolved] = useState(false);

  // Nothing to compare until there is enough to compare on.
  const hasInput = name.trim().length >= 2 || phone.replace(/\D/g, '').length >= 6;

  const debouncedName = useDebouncedValue(name.trim(), 400);
  const debouncedPhone = useDebouncedValue(phone.trim(), 400);

  const query = useQuery({
    queryKey: ['duplicate-customers', orgId ?? '', debouncedName, debouncedPhone],
    enabled: Boolean(orgId) && enabled && hasInput,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('find_duplicate_customers', {
        p_org_id: orgId as string,
        p_name: debouncedName,
        p_phone: debouncedPhone,
        p_limit: 5,
      });

      if (error) throw AppError.from(error);

      // The RPC returns a fixed, documented shape, so the assertion is safe.
      const rows = (Array.isArray(data) ? (data as unknown[]) : []) as DuplicateCandidate[];
      return rows.map((row) => ({
        ...row,
        // The RPC ranks matches but does not label them; derive the label the
        // same way the SQL ranks them, so "phone" always wins.
        match:
          debouncedPhone.replace(/\D/g, '').length >= 6 &&
          (row.phone ?? '').replace(/\D/g, '').slice(-10) ===
            debouncedPhone.replace(/\D/g, '').slice(-10)
            ? ('phone' as const)
            : ('name' as const),
      }));
    },
  });

  const matches = query.data ?? [];
  const normalised = phone.replace(/\D/g, '');
  const exactPhone = matches.some(
    (match) =>
      match.match === 'phone' &&
      normalised.length >= 6 &&
      (match.phone ?? '').replace(/\D/g, '').slice(-10) === normalised.slice(-10),
  );

  return {
    matches,
    exactPhone,
    isLoading: query.isLoading,
    resolved,
    /** Called once the seller has chosen to continue or to use a match. */
    markResolved: () => setResolved(true),
  } satisfies DuplicateCheck;
}

export function useCustomerPicker(orgId: string | undefined) {
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim(), 250);

  const query = useQuery({
    queryKey: ['customer-picker', orgId ?? '', debounced],
    enabled: Boolean(orgId),
    queryFn: async () => {
      let request = getSupabase()
        .from('customers')
        .select('*')
        .eq('is_archived', false)
        .order('name', { ascending: true })
        .limit(50);

      if (debounced.length > 0) {
        request = request.or(`name.ilike.%${debounced}%,phone.ilike.%${debounced}%`);
      }

      const { data, error } = await request;
      if (error) throw AppError.from(error);
      return (data ?? []) as CustomerRow[];
    },
  });

  return {
    customers: query.data ?? [],
    search,
    setSearch,
    isLoading: query.isLoading,
  };
}

/**
 * Deletes a customer for good.
 *
 * Goes through the `delete_customer` function because `orders.customer_id` is
 * ON DELETE SET NULL: a client-side delete would turn a named customer's sales
 * into anonymous walk-in sales and quietly change their revenue history.
 */
export function useDeleteCustomer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (customerId: string) => {
      const { error } = await getSupabase().rpc('delete_customer', {
        p_customer_id: customerId,
      });
      if (error) throw AppError.from(error);
      return true;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['customers-list'] }),
        queryClient.invalidateQueries({ queryKey: ['customer'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['finance'] }),
      ]);
    },
  });
}