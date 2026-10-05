/**
 * Order mutations.
 *
 * All of these call SECURITY DEFINER functions that re-authorise server-side and
 * commit atomically. The client never writes to `orders`, `order_items`,
 * `inventory` or `payments` directly -- RLS denies it anyway, but relying on
 * that for correctness would be fragile.
 *
 * Cache invalidation is deliberate rather than a blanket `invalidateQueries`:
 * each mutation names exactly which views it could have changed, which is what
 * stops the dashboard from refetching when someone edits a product name.
 */

import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  InventoryReason,
  OrderStatus,
  PaymentMethod,
} from '@/lib/database.types';
import { AppError, isOfflineError } from '@/lib/errors';
import { keys } from '@/lib/queryClient';
import { getSupabase, isConfigured } from '@/lib/supabase';
import {
  createClientRef,
  createMutationId,
  useConnectivity,
} from '@/lib/connectivity';
import type { DraftLine } from './calculations';

export interface CreateOrderInput {
  storeId: string;
  customerId: string | null;
  lines: DraftLine[];
  discount: number;
  deliveryCharge: number;
  amountPaid: number;
  paymentMethod: PaymentMethod;
  notes: string | null;
  /** Reused across retries so a duplicate order is impossible. A v4 uuid. */
  clientRef: string;
  /**
   * Cash on delivery. The server derives `cod_amount` as total - paid, and only treats
   * this as COD when something is genuinely still to collect.
   */
  isCod: boolean;
  /** Snapshot of where the parcel goes. Null for a pickup. */
  deliveryAddress: string | null;
  deliveryThana: string | null;
  deliveryDistrict: string | null;
  deliveryPhone: string | null;
}

/**
 * Payload shape expected by the `create_order` RPC.
 *
 * A type alias with an explicit index signature: the RPC parameter is typed as
 * `Json`, and TypeScript only accepts an object literal for `Json` if it can
 * prove an index signature exists.
 */
type CreateOrderItem = {
  [key: string]: string | number | null;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  line_discount: number;
};

export function useCreateOrder() {
  const queryClient = useQueryClient();
  const enqueue = useConnectivity((state) => state.enqueue);
  const setSyncState = useConnectivity((state) => state.setSyncState);

  return useMutation({
    mutationFn: async (input: CreateOrderInput): Promise<string> => {
      if (!isConfigured) {
        throw new AppError('SellFlow is not configured', 'Add your Supabase keys to the .env file.');
      }

      setSyncState('syncing');

      const items: CreateOrderItem[] = input.lines.map((line) => ({
        product_id: line.productId,
        variant_id: line.variantId,
        quantity: line.quantity,
        line_discount: line.lineDiscount,
      }));

      const { data, error } = await getSupabase().rpc('create_order', {
        p_store_id: input.storeId,
        p_customer_id: input.customerId,
        p_items: items,
        p_discount: input.discount,
        p_delivery_charge: input.deliveryCharge,
        p_amount_paid: input.amountPaid,
        p_payment_method: input.paymentMethod,
        p_notes: input.notes,
        p_client_ref: input.clientRef,
        /*
         * `create_order` has accepted these since 0008 and the client simply never
         * sent them, which made two things impossible to record at all.
         *
         * COD: `is_cod` is the flag, and the server derives `cod_amount` as
         * total - paid from it. Without sending it, every order was recorded as
         * prepaid or due-on-account, and the courier collection the seller is waiting
         * on did not exist anywhere in the data.
         *
         * Delivery address: a courier order with no address cannot be dispatched. The
         * columns exist and are stored on the order, so they are a snapshot of where
         * the parcel went -- not a live link to the customer, which may be edited
         * later.
         */
        p_is_cod: input.isCod,
        p_delivery_address: input.deliveryAddress,
        p_delivery_thana: input.deliveryThana,
        p_delivery_district: input.deliveryDistrict,
        p_delivery_phone: input.deliveryPhone,
      });

      if (error) {
        // Queue for retry, but only for genuine connectivity problems.
        // A rejected request will be rejected again, so replaying it is
        // pointless. Creating an order IS replay-safe: the same client_ref is
        // carried into the queued payload, so the server returns the original
        // order instead of creating a second one.
        if (isOfflineError(error)) {
          await enqueue({
            id: createMutationId(),
            kind: 'create_order',
            summary: `Order with ${input.lines.length} item${input.lines.length === 1 ? '' : 's'}`,
            createdAt: new Date().toISOString(),
            attempts: 1,
            payload: {
              storeId: input.storeId,
              customerId: input.customerId,
              items: items.map((item) => ({
                product_id: item.product_id,
                variant_id: item.variant_id,
                quantity: item.quantity,
                line_discount: item.line_discount,
              })),
              discount: input.discount,
              deliveryCharge: input.deliveryCharge,
              amountPaid: input.amountPaid,
              paymentMethod: input.paymentMethod,
              notes: input.notes,
              clientRef: input.clientRef,
            },
          });
          setSyncState('offline');
        }
        throw AppError.from(error);
      }

      return data as string;
    },
    onSuccess: async (_orderId, input) => {
      setSyncState('idle');
      // An order changes stock, customer totals, the orders list and the
      // dashboard. Invalidate exactly those.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard', input.storeId] }),
        queryClient.invalidateQueries({ queryKey: keys.orders(input.storeId) }),
        queryClient.invalidateQueries({ queryKey: ['orders-list', input.storeId] }),
        queryClient.invalidateQueries({ queryKey: ['recent-orders', input.storeId] }),
        queryClient.invalidateQueries({ queryKey: ['product-picker'] }),
        queryClient.invalidateQueries({ queryKey: keys.customers() }),
      ]);
    },
  });
}

export function useSetOrderStatus(orderId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ status, note }: { status: OrderStatus; note?: string }) => {
      const { data, error } = await getSupabase().rpc('set_order_status', {
        p_order_id: orderId,
        p_to_status: status,
        p_note: note ?? null,
      });

      if (error) throw AppError.from(error);
      return data as OrderStatus;
    },
    onSuccess: async (status) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.order('', orderId) }),
        queryClient.invalidateQueries({ queryKey: keys.orderHistory(orderId) }),
        queryClient.invalidateQueries({ queryKey: keys.allowedStatuses(orderId) }),
        // Cancelling or returning restocks, so inventory views are stale too.
        queryClient.invalidateQueries({ queryKey: ['orders-list'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: keys.products('') }),
        queryClient.invalidateQueries({ queryKey: ['product-picker'] }),
      ]);

      // Stock only moves on cancel/return; skip the extra refetch otherwise.
      if (status === 'cancelled' || status === 'returned') {
        await queryClient.invalidateQueries({ queryKey: ['product-stock'] });
      }
    },
  });
}

export function useRecordPayment(orderId: string) {
  const queryClient = useQueryClient();

  // One key per payment attempt, held in a ref so it survives re-renders and is
  // invisible to the caller -- every existing call site keeps working unchanged.
  //
  // A retry of the SAME attempt (double tap, network retry, refetch) reuses this
  // key, so the server recognises it and does not take the money twice. Only a
  // confirmed success replaces it, because that is the point at which a new
  // payment genuinely begins.
  const keyRef = useRef(createClientRef());

  return useMutation({
    mutationFn: async ({
      amount,
      method,
      note,
    }: {
      amount: number;
      method: PaymentMethod;
      note?: string;
    }) => {
      const { data, error } = await getSupabase().rpc('record_payment', {
        p_order_id: orderId,
        p_amount: amount,
        p_method: method,
        p_note: note ?? null,
        p_idempotency_key: keyRef.current,
      });

      if (error) throw AppError.from(error);
      return data as number;
    },
    onSuccess: async () => {
      // Money moved. The next payment is a different payment and needs its own
      // key.
      keyRef.current = createClientRef();

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.order('', orderId) }),
        queryClient.invalidateQueries({ queryKey: keys.payments(orderId) }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['orders-list'] }),
        queryClient.invalidateQueries({ queryKey: ['finance'] }),
      ]);
    },
  });
}

export function useRecordRefund(orderId: string) {
  const queryClient = useQueryClient();
  const keyRef = useRef(createClientRef());

  return useMutation({
    mutationFn: async ({
      amount,
      method,
      note,
    }: {
      amount: number;
      method: PaymentMethod;
      note?: string;
    }) => {
      const { data, error } = await getSupabase().rpc('record_refund', {
        p_order_id: orderId,
        p_amount: amount,
        p_method: method,
        p_note: note ?? null,
        p_idempotency_key: keyRef.current,
      });

      if (error) throw AppError.from(error);
      return data as number;
    },
    onSuccess: async () => {
      keyRef.current = createClientRef();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.order('', orderId) }),
        queryClient.invalidateQueries({ queryKey: keys.payments(orderId) }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['finance'] }),
      ]);
    },
  });
}

export function useAdjustStock() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      storeId,
      productId,
      variantId,
      delta,
      reason,
      note,
    }: {
      storeId: string;
      productId: string;
      variantId: string | null;
      delta: number;
      reason: InventoryReason;
      note?: string;
    }) => {
      const { data, error } = await getSupabase().rpc('adjust_stock', {
        p_store_id: storeId,
        p_product_id: productId,
        p_variant_id: variantId,
        p_delta: delta,
        p_reason: reason,
        p_note: note ?? null,
      });

      if (error) {
        // Deliberately NOT queued. A stock adjustment is a signed delta, and
        // `apply_stock_delta` has no idempotency key -- replaying it would add
        // the same units twice and leave a permanently wrong balance with a
        // plausible-looking ledger entry. Failing with a clear message costs
        // the seller one retry; corrupting stock costs them the whole catalogue.
        if (isOfflineError(error)) {
          useConnectivity.getState().setSyncState('offline');
          throw new AppError(
            'No connection, stock not changed',
            'Your stock was not adjusted. Reconnect and try again.',
            { cause: error },
          );
        }
        throw AppError.from(error);
      }

      return data as number;
    },
    onSuccess: async (_balance, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.productStock(variables.storeId, variables.productId),
        }),
        queryClient.invalidateQueries({ queryKey: keys.movements(variables.productId) }),
        queryClient.invalidateQueries({ queryKey: keys.products(variables.storeId) }),
        queryClient.invalidateQueries({ queryKey: ['product-picker'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', variables.storeId] }),
      ]);
    },
  });
}

/**
 * Set stock to an absolute counted quantity.
 *
 * Separate from `useAdjustStock` on purpose. A delta answers "how much
 * changed", which is what a purchase or a correction needs. A stock count
 * answers "how much is there now", and deriving the delta on the client from
 * a cached balance would be a time-of-check-to-time-of-use bug: an order
 * selling the last unit between the read and the write lands the shelf on the
 * wrong number and writes a movement that does not explain what is actually
 * there. The target is resolved by `set_stock` against a locked row instead.
 *
 * Unlike `adjust_stock` this is safe to run twice — counting to 20 twice ends
 * at 20, and the second call writes no movement at all — but it is still not
 * queued, so that stays true only if the server is reachable to confirm it.
 */
export function useSetStock() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      storeId,
      productId,
      variantId,
      count,
      reason,
      note,
    }: {
      storeId: string;
      productId: string;
      variantId: string | null;
      count: number;
      reason: InventoryReason;
      note?: string;
    }) => {
      const { data, error } = await getSupabase().rpc('set_stock', {
        p_store_id: storeId,
        p_product_id: productId,
        p_variant_id: variantId,
        p_target: count,
        p_reason: reason,
        p_note: note ?? null,
      });

      if (error) {
        if (isOfflineError(error)) {
          useConnectivity.getState().setSyncState('offline');
          throw new AppError(
            'No connection, stock not changed',
            'Your stock count was not saved. Reconnect and try again.',
            { cause: error },
          );
        }
        throw AppError.from(error);
      }

      return data as number;
    },
    onSuccess: async (_balance, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.productStock(variables.storeId, variables.productId),
        }),
        queryClient.invalidateQueries({ queryKey: keys.movements(variables.productId) }),
        queryClient.invalidateQueries({ queryKey: keys.products(variables.storeId) }),
        queryClient.invalidateQueries({ queryKey: ['product-picker'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', variables.storeId] }),
      ]);
    },
  });
}

/** Helper for the order builder: a fresh ref per draft, reused across retries. */
export function newOrderRef(): string {
  return createClientRef();
}
