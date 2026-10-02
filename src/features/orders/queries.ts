/**
 * Order queries.
 *
 * Every mutation in this file goes through a Postgres function rather than a
 * series of client writes, because an order touches at least six tables and
 * PostgREST cannot wrap those in a transaction. See 0005_business_functions.sql.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type {
  CustomerRow,
  OrderItemRow,
  OrderRow,
  OrderStatus,
  OrderStatusHistoryRow,
  PaymentRow,
} from '@/lib/database.types';
import { keys } from '@/lib/queryClient';
import { getSupabase } from '@/lib/supabase';
import { useDebouncedValue } from '@/components/ui';

const PAGE_SIZE = 25;

export interface OrderListItem extends OrderRow {
  customer_name: string | null;
}

/**
 * Reads the customer name off an embedded `customers` relation.
 *
 * PostgREST returns a TO-ONE embed as an object and a TO-MANY embed as an array.
 * `orders.customer_id` is a foreign key, so the embed is to-one and arrives as
 * `{ name: "..." }`. Indexing it as an array -- `customers?.[0]` -- read
 * `undefined` and every order in the list fell back to "Walk-in customer",
 * including the ones that had a named customer on the order detail screen.
 *
 * Both shapes are accepted so the same helper is safe whatever PostgREST
 * decides to return, and so the list and the detail screen cannot disagree.
 */
function embeddedCustomerName(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0]?.name ?? null;
  return (value as { name?: string | null }).name ?? null;
}

export type OrderFilter = 'all' | OrderStatus | 'unpaid';
/**
 * Paginated order list with search and status filter.
 *
 * `unpaid` is a client-side filter over a bounded window rather than a separate
 * query: it is what sellers check daily, and the window is small. Anything that
 * needs to be exhaustive (reporting) uses `get_sales_report` instead.
 */
export function useOrders(storeId: string | undefined) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<OrderFilter>('all');
  const debounced = useDebouncedValue(search.trim(), 300);

  const query = useInfiniteQuery({
    queryKey: ['orders-list', storeId ?? '', debounced, filter],
    enabled: Boolean(storeId),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const supabase = getSupabase();

      let request = supabase
        .from('orders')
        .select('*, customers!left(name)')
        .eq('store_id', storeId as string)
        .order('placed_at', { ascending: false })
        .range(pageParam, pageParam + PAGE_SIZE - 1);

      if (filter !== 'all' && filter !== 'unpaid') {
        request = request.eq('status', filter);
      } else if (filter === 'unpaid') {
        request = request.in('payment_status', ['unpaid', 'partial']);
      }

      if (debounced.length > 0) {
        request = request.ilike('order_number', `%${debounced}%`);
      }

      const { data, error } = await request;
      if (error) throw error;

      return ((data ?? []) as unknown[]).map((row) => {
        const raw = row as OrderRow & { customers?: unknown };
        return {
          ...(raw as OrderRow),
          customer_name: embeddedCustomerName(raw.customers),
        } satisfies OrderListItem;
      });
    },
    getNextPageParam: (lastPage) => (lastPage.length < PAGE_SIZE ? undefined : lastPage.length),
  });

  return {
    orders: query.data?.pages.flat() ?? [],
    search,
    setSearch,
    filter,
    setFilter,
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

export function useOrder(orderId: string | undefined) {
  return useQuery({
    queryKey: keys.order('', orderId ?? ''),
    enabled: Boolean(orderId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('orders')
        .select('*, customers!left(*)')
        .eq('id', orderId as string)
        .single();

      if (error) throw error;

      const raw = data as unknown as OrderRow & {
        customers?: CustomerRow | CustomerRow[] | null;
      };
      const customer = Array.isArray(raw.customers) ? raw.customers[0] : raw.customers;

      return { ...(raw as OrderRow), customer: customer ?? null };
    },
  });
}

export function useOrderItems(orderId: string | undefined) {
  return useQuery({
    queryKey: keys.orderItems(orderId ?? ''),
    enabled: Boolean(orderId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('order_items')
        .select('*')
        .eq('order_id', orderId as string)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return (data ?? []) as OrderItemRow[];
    },
  });
}

/** Status timeline, oldest first. */
export function useOrderHistory(orderId: string | undefined) {
  return useQuery({
    queryKey: keys.orderHistory(orderId ?? ''),
    enabled: Boolean(orderId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('order_status_history')
        .select('*')
        .eq('order_id', orderId as string)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return (data ?? []) as OrderStatusHistoryRow[];
    },
  });
}

export function usePayments(orderId: string | undefined) {
  return useQuery({
    queryKey: keys.payments(orderId ?? ''),
    enabled: Boolean(orderId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('payments')
        .select('*')
        .eq('order_id', orderId as string)
        .order('paid_at', { ascending: false });

      if (error) throw error;
      return (data ?? []) as PaymentRow[];
    },
  });
}

/**
 * Statuses the database will accept for this order.
 *
 * Asking the server rather than hardcoding the matrix in the client means the
 * app and the database can never disagree about what is legal -- the UI simply
 * hides choices that `set_order_status` would reject.
 */
export function useAllowedStatuses(orderId: string | undefined) {
  return useQuery({
    queryKey: keys.allowedStatuses(orderId ?? ''),
    enabled: Boolean(orderId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('allowed_order_statuses', {
        p_order_id: orderId as string,
      });

      if (error) throw error;
      return (data ?? []) as OrderStatus[];
    },
  });
}

/** Orders belonging to one customer, for the customer detail screen. */
export function useCustomerOrders(customerId: string | undefined) {
  return useQuery({
    queryKey: keys.customerOrders(customerId ?? ''),
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('orders')
        .select('*')
        .eq('customer_id', customerId as string)
        .order('placed_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      return (data ?? []) as OrderRow[];
    },
  });
}

/**
 * Order list for the dashboard's "recent orders" section.
 *
 * Deliberately separate from `useOrders`: the dashboard shows the newest few
 * regardless of any active filter, and sharing the key would make filtering on
 * the Orders tab change the dashboard.
 */
export function useRecentOrders(storeId: string | undefined) {
  return useQuery({
    queryKey: ['recent-orders', storeId ?? ''],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('orders')
        .select('*, customers!left(name)')
        .eq('store_id', storeId as string)
        .order('placed_at', { ascending: false })
        .limit(5);

      if (error) throw error;

      return ((data ?? []) as unknown[]).map((row) => {
        const raw = row as OrderRow & { customers?: unknown };
        return {
          ...(raw as OrderRow),
          customer_name: embeddedCustomerName(raw.customers),
        } satisfies OrderListItem;
      });
    },
  });
}
