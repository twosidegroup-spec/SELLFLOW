/**
 * Product catalogue queries.
 *
 * Products are fetched per store because inventory quantity is store-specific:
 * the same product can have 3 units in one outlet and 40 in another.
 */

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { InventoryRow, ProductRow } from '@/lib/database.types';
import { keys } from '@/lib/queryClient';
import { getSupabase } from '@/lib/supabase';
import { useDebouncedValue } from '@/components/ui';

export interface ProductWithStock extends ProductRow {
  quantity: number;
}

const PAGE_SIZE = 25;

/**
 * Selects products with this store's inventory quantity embedded.
 *
 * Two things about PostgREST matter here, and both were wrong before:
 *
 *   1. `store_id` must be IN the column list. The embed is one-to-many (a
 *      product has a row per store), so the row cannot be identified without
 *      it. Selecting `quantity` alone returned `[{"quantity": 0}]`, and the
 *      lookup below compared `undefined` against the active store id, matched
 *      nothing, and defaulted every product to zero -- which the UI then
 *      rendered as "Out of stock" for a catalogue that was fully in stock.
 *
 *   2. There is no per-call filter on an embedded resource in PostgREST v12+.
 *      The old `inventory!left(quantity).eq(store_id.eq.X)` suffix was parsed as
 *      part of the column list and silently ignored. The active store's row is
 *      therefore selected in JS. The payload stays bounded because a product has
 *      at most one inventory row per store, and a seller has a handful of stores.
 */
function productSelect(): string {
  return '*, inventory!left(quantity, store_id)';
}

/** Pulls the current store's quantity out of the embedded inventory rows. */
function withStock(row: unknown, storeId: string): ProductWithStock {
  const raw = row as ProductRow & {
    inventory?: { quantity: number; store_id: string | null }[] | null;
  };
  // `variant_id is null` is the unit-level stock row; a product's variant stock
  // is summed separately where it matters. Prefer it when present.
  const rows = raw.inventory ?? [];
  const stock = rows.find((entry) => entry.store_id === storeId);
  return { ...(raw as ProductRow), quantity: stock?.quantity ?? 0 };
}

/**
 * Paginated product list with server-side search.
 *
 * Pagination rather than loading everything: a catalog of 5,000 products would
 * otherwise be a single enormous response that stalls the first paint. Search
 * runs against the trigram indexes defined in migration 0003, so `ILIKE`
 * stays fast as the catalog grows.
 */
export function useProducts(storeId: string | undefined) {
  const [search, setSearch] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const query = useInfiniteQuery({
    queryKey: [
      ...(storeId ? keys.products(storeId) : ['products', 'none']),
      debouncedSearch,
      includeArchived,
    ],
    enabled: Boolean(storeId),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const supabase = getSupabase();

      let request = supabase
        .from('products')
        .select(productSelect())
        .order('created_at', { ascending: false })
        .range(pageParam, pageParam + PAGE_SIZE - 1);

      if (!includeArchived) request = request.eq('is_archived', false);

      if (debouncedSearch.length > 0) {
        request = request.or(
          `name.ilike.%${debouncedSearch}%,sku.ilike.%${debouncedSearch}%`,
        );
      }

      const { data, error } = await request;
      if (error) throw error;

      return ((data ?? []) as unknown[]).map((row) => withStock(row, storeId as string));
    },
    getNextPageParam: (lastPage) => (lastPage.length < PAGE_SIZE ? undefined : lastPage.length),
  });

  const products = query.data?.pages.flat() ?? [];

  return {
    products,
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

/** Categories present in the catalog, for the filter row. */
export function useCategories() {
  return useQuery({
    queryKey: ['product-categories'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await getSupabase().from('products').select('category').limit(1000);
      if (error) throw error;

      const unique = new Set<string>();
      for (const row of data ?? []) {
        if (row.category) unique.add(row.category);
      }
      return [...unique].sort((a, b) => a.localeCompare(b));
    },
  });
}

export function useProduct(productId: string | undefined) {
  return useQuery({
    queryKey: keys.product(productId ?? ''),
    enabled: Boolean(productId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('products')
        .select('*')
        .eq('id', productId as string)
        .single();
      if (error) throw error;
      return data;
    },
  });
}

/** Current stock for one product in one store. */
export function useStock(storeId: string | undefined, productId: string | undefined) {
  return useQuery({
    queryKey: keys.productStock(storeId ?? '', productId ?? ''),
    enabled: Boolean(storeId && productId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('inventory')
        .select('*')
        .eq('store_id', storeId as string)
        .eq('product_id', productId as string)
        .is('variant_id', null);

      if (error) throw error;
      return (data?.[0] as InventoryRow | undefined) ?? null;
    },
  });
}

/** Stock ledger for one product, newest first. */
export function useMovements(productId: string | undefined) {
  return useQuery({
    queryKey: keys.movements(productId ?? ''),
    enabled: Boolean(productId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('inventory_movements')
        .select('*')
        .eq('product_id', productId as string)
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Selector data for the order builder.
 *
 * Fetches a page of in-stock products at a time rather than the whole catalog,
 * because the picker is a search-first UI and sellers rarely scroll past the
 * first screen of results.
 */
export function useProductPicker(storeId: string | undefined) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim(), 250);

  const query = useQuery({
    queryKey: ['product-picker', storeId ?? '', debounced],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const supabase = getSupabase();

      let request = supabase
        .from('products')
        .select(productSelect())
        .eq('is_archived', false)
        .order('name', { ascending: true })
        .limit(50);

      if (debounced.length > 0) {
        // Matches product name or SKU. The trigram indexes make both branches
        // index-backed rather than sequential scans.
        request = request.or(`name.ilike.%${debounced}%,sku.ilike.%${debounced}%`);
      }

      const { data, error } = await request;
      if (error) throw error;

      return ((data ?? []) as unknown[]).map((row) => withStock(row, storeId as string));
    },
  });

  return {
    products: query.data ?? [],
    search,
    setSearch,
    isLoading: query.isLoading,
    refetch: () => queryClient.invalidateQueries({ queryKey: ['product-picker'] }),
  };
}
