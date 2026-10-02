/**
 * Product mutations.
 *
 * Straightforward single-table writes guarded by RLS. Stock is deliberately
 * NOT changed here: quantity only moves through `adjust_stock` or an order, so
 * every change stays traceable in `inventory_movements`.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { Database, ProductRow } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { keys } from '@/lib/queryClient';
import { getSupabase } from '@/lib/supabase';

export interface ProductInput {
  name: string;
  sku?: string | null;
  category?: string | null;
  sellingPrice: number;
  costPrice?: number | null;
  lowStockThreshold?: number;
  trackInventory?: boolean;
  notes?: string | null;
}

export function useCreateProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ orgId, input }: { orgId: string; input: ProductInput }) => {
      const { data, error } = await getSupabase()
        .from('products')
        .insert({
          org_id: orgId,
          name: input.name.trim(),
          sku: input.sku?.trim() || null,
          category: input.category?.trim() || null,
          selling_price: input.sellingPrice,
          cost_price: input.costPrice ?? null,
          low_stock_threshold: input.lowStockThreshold ?? 0,
          track_inventory: input.trackInventory ?? true,
          notes: input.notes?.trim() || null,
        })
        .select()
        .single();

      if (error) throw AppError.from(error);
      return data as ProductRow;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['product-picker'] }),
        queryClient.invalidateQueries({ queryKey: ['product-categories'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });
}

export function useUpdateProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      productId,
      input,
    }: {
      productId: string;
      input: Partial<ProductInput> & { is_archived?: boolean };
    }) => {
      const update: Database['public']['Tables']['products']['Update'] = {};

      if (input.name !== undefined) update.name = input.name.trim();
      if (input.sku !== undefined) update.sku = input.sku?.trim() || null;
      if (input.category !== undefined) update.category = input.category?.trim() || null;
      if (input.sellingPrice !== undefined) update.selling_price = input.sellingPrice;
      if (input.costPrice !== undefined) update.cost_price = input.costPrice ?? null;
      if (input.lowStockThreshold !== undefined) update.low_stock_threshold = input.lowStockThreshold;
      if (input.trackInventory !== undefined) update.track_inventory = input.trackInventory;
      if (input.notes !== undefined) update.notes = input.notes?.trim() || null;
      if (input.is_archived !== undefined) update.is_archived = input.is_archived;

      const { data, error } = await getSupabase()
        .from('products')
        .update(update)
        .eq('id', productId)
        .select()
        .single();

      if (error) throw AppError.from(error);
      return data as ProductRow;
    },
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.product(variables.productId) }),
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['product-picker'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });
}

/**
 * Archives rather than deletes.
 *
 * A product that appears on a past order must keep existing, or that order's
 * history loses its referent. Archiving removes it from pickers and lists while
 * preserving every order that referenced it.
 */
export function useArchiveProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ productId, archived }: { productId: string; archived: boolean }) => {
      const { error } = await getSupabase()
        .from('products')
        .update({ is_archived: archived })
        .eq('id', productId);

      if (error) throw AppError.from(error);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['product-picker'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });
}

/**
 * Deletes a product for good.
 *
 * Goes through the `delete_product` function rather than a client-side
 * `.delete()`, because the refusal is the whole point: `order_items.product_id`
 * is ON DELETE SET NULL, so a direct delete would quietly remove the product
 * from any sale it appeared on. The function counts the sales first and refuses
 * with an explanation the seller can act on.
 */
export function useDeleteProduct() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (productId: string) => {
      const { error } = await getSupabase().rpc('delete_product', {
        p_product_id: productId,
      });

      if (error) {
        throw AppError.from(error);
      }
      return true;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['product-picker'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['finance'] }),
      ]);
    },
  });
}