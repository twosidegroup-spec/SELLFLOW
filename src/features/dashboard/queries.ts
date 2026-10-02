/**
 * Operational dashboard.
 *
 * One server-side aggregate (get_dashboard v2) rather than a dozen client
 * queries joined in JavaScript. Every number here is computed from rows; a
 * brand-new business gets zeros and empty lists, which is the honest answer.
 *
 * The types mirror the SQL contract deliberately -- if the database changes
 * shape, this file should change with it, and `as` assertions are confined to
 * the small number of places where PostgREST types jsonb as `Json`.
 */

import { useQuery } from '@tanstack/react-query';

import type {
  CourierProvider,
  OrderStatus,
  PaymentStatus,
  ShipmentState,
} from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { keys } from '@/lib/queryClient';
import { getSupabase } from '@/lib/supabase';
import { toDateString } from '@/lib/format';

export interface PeriodSummary {
  orders: number;
  revenue: number;
  profit: number;
}

export interface DashboardData {
  // Pipeline: counts across ALL open history, not just today. A backlog
  // question, not a date question.
  pipeline: Record<string, number>;
  pending_count: number;
  confirmed_count: number;
  processing_count: number;
  packaging_count: number;
  packed_count: number;
  shipped_count: number;
  on_delivery_count: number;
  delivered_count: number;
  failed_count: number;
  returned_count: number;
  cancelled_count: number;

  today: PeriodSummary & { delivered: number };
  week: PeriodSummary;
  month: PeriodSummary;

  aov_month: number;
  aov_all: number;

  cod: { expected: number; pending_settlement: number; settled: number; orders: number };
  costs: { product: number; courier: number; other: number };
  outstanding: number;
  outstanding_orders: number;

  action: {
    to_confirm: number;
    to_pack: number;
    to_ship: number;
    out_for_delivery: number;
    failed: number;
  };

  couriers: {
    open_shipments: number;
    awaiting_confirmation: number;
    pickup_pending: number;
    by_provider: Record<string, number>;
  };

  low_stock: {
    product_id: string;
    name: string;
    quantity: number;
    threshold: number;
    margin: number;
  }[];
  low_stock_count: number;
  product_count: number;
  customer_count: number;
  total_orders: number;

  recent_orders: {
    id: string;
    order_number: string;
    status: OrderStatus;
    payment_status: PaymentStatus;
    total: number;
    is_cod: boolean;
    customer_name: string | null;
    courier_name: string | null;
    placed_at: string;
  }[];

  series: { day: string; revenue: number }[];
}

/** A missing figure means zero, never NaN and never a placeholder. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = num(entry);
  }
  return out;
}

export function useDashboard(storeId: string | undefined) {
  return useQuery({
    queryKey: keys.dashboard(storeId ?? ''),
    enabled: Boolean(storeId),
    queryFn: async (): Promise<DashboardData> => {
      const { data, error } = await getSupabase().rpc('get_dashboard', {
        p_store_id: storeId as string,
        // The device's date, so "today" means today where the seller is.
        p_today: toDateString(),
      });

      if (error) throw AppError.from(error);

      const raw = (data ?? {}) as Record<string, unknown>;
      const period = (key: string) => {
        const source = (raw[key] ?? {}) as Record<string, unknown>;
        return { orders: num(source.orders), revenue: num(source.revenue), profit: num(source.profit) };
      };

      return {
        pipeline: record(raw.pipeline),
        pending_count: num(raw.pending_count),
        confirmed_count: num(raw.confirmed_count),
        processing_count: num(raw.processing_count),
        packaging_count: num(raw.packaging_count),
        packed_count: num(raw.packed_count),
        shipped_count: num(raw.shipped_count),
        on_delivery_count: num(raw.on_delivery_count),
        delivered_count: num(raw.delivered_count),
        failed_count: num(raw.failed_count),
        returned_count: num(raw.returned_count),
        cancelled_count: num(raw.cancelled_count),

        today: { ...period('today'), delivered: num((raw.today as never as Record<string, unknown>)?.delivered) },
        week: period('week'),
        month: period('month'),

        aov_month: num(raw.aov_month),
        aov_all: num(raw.aov_all),

        cod: {
          expected: num((raw.cod as never as Record<string, unknown>)?.expected),
          pending_settlement: num((raw.cod as never as Record<string, unknown>)?.pending_settlement),
          settled: num((raw.cod as never as Record<string, unknown>)?.settled),
          orders: num((raw.cod as never as Record<string, unknown>)?.orders),
        },
        costs: {
          product: num((raw.costs as never as Record<string, unknown>)?.product),
          courier: num((raw.costs as never as Record<string, unknown>)?.courier),
          other: num((raw.costs as never as Record<string, unknown>)?.other),
        },
        outstanding: num(raw.outstanding),
        outstanding_orders: num(raw.outstanding_orders),

        action: {
          to_confirm: num((raw.action as never as Record<string, unknown>)?.to_confirm),
          to_pack: num((raw.action as never as Record<string, unknown>)?.to_pack),
          to_ship: num((raw.action as never as Record<string, unknown>)?.to_ship),
          out_for_delivery: num((raw.action as never as Record<string, unknown>)?.out_for_delivery),
          failed: num((raw.action as never as Record<string, unknown>)?.failed),
        },

        couriers: {
          open_shipments: num((raw.couriers as never as Record<string, unknown>)?.open_shipments),
          awaiting_confirmation: num(
            (raw.couriers as never as Record<string, unknown>)?.awaiting_confirmation,
          ),
          pickup_pending: num((raw.couriers as never as Record<string, unknown>)?.pickup_pending),
          by_provider: record((raw.couriers as never as Record<string, unknown>)?.by_provider),
        },

        low_stock: Array.isArray(raw.low_stock) ? (raw.low_stock as DashboardData['low_stock']) : [],
        low_stock_count: num(raw.low_stock_count),
        product_count: num(raw.product_count),
        customer_count: num(raw.customer_count),
        total_orders: num(raw.total_orders),

        recent_orders: Array.isArray(raw.recent_orders)
          ? (raw.recent_orders as DashboardData['recent_orders'])
          : [],
        series: Array.isArray(raw.series) ? (raw.series as DashboardData['series']) : [],
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface AnalyticsData {
  from: string;
  to: string;
  totals: {
    revenue: number;
    profit: number;
    product_cost: number;
    courier_cost: number;
    other_cost: number;
    discount_given: number;
    orders: number;
  };
  delivery: {
    delivered_orders: number;
    returned_orders: number;
    cancelled_orders: number;
    failed_deliveries: number;
    delivered_revenue: number;
    open_orders: number;
  };
  units_sold: number;
  average_order_value: number;
  average_selling_price: number;
  net_profit: number;
  expenses: { total: number; by_category: Record<string, number> };
  daily: { day: string; revenue: number; profit: number; orders: number }[];
}

export function useAnalytics(storeId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: keys.analytics(storeId ?? '', from, to),
    enabled: Boolean(storeId),
    queryFn: async (): Promise<AnalyticsData> => {
      const { data, error } = await getSupabase().rpc('get_analytics', {
        p_store_id: storeId as string,
        p_from: from,
        p_to: to,
      });

      if (error) throw AppError.from(error);

      const raw = (data ?? {}) as Record<string, unknown>;
      const totals = (raw.totals ?? {}) as Record<string, unknown>;
      const delivery = (raw.delivery ?? {}) as Record<string, unknown>;
      const expenses = (raw.expenses ?? {}) as Record<string, unknown>;

      return {
        from: String(raw.from ?? from),
        to: String(raw.to ?? to),
        totals: {
          revenue: num(totals.revenue),
          profit: num(totals.profit),
          product_cost: num(totals.product_cost),
          courier_cost: num(totals.courier_cost),
          other_cost: num(totals.other_cost),
          discount_given: num(totals.discount_given),
          orders: num(totals.orders),
        },
        delivery: {
          delivered_orders: num(delivery.delivered_orders),
          returned_orders: num(delivery.returned_orders),
          cancelled_orders: num(delivery.cancelled_orders),
          failed_deliveries: num(delivery.failed_deliveries),
          delivered_revenue: num(delivery.delivered_revenue),
          open_orders: num(delivery.open_orders),
        },
        units_sold: num(raw.units_sold),
        average_order_value: num(raw.average_order_value),
        average_selling_price: num(raw.average_selling_price),
        net_profit: num(raw.net_profit),
        expenses: { total: num(expenses.total), by_category: record(expenses.by_category) },
        daily: Array.isArray(raw.daily) ? (raw.daily as AnalyticsData['daily']) : [],
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export interface FinanceData {
  from: string;
  to: string;
  revenue: {
    gross_sales: number;
    delivered_sales: number;
    delivery_charged: number;
    discount_given: number;
  };
  costs: { product: number; courier: number; other: number; expenses: number };
  payments: { paid: number; refunded: number };
  cod: { expected: number; pending: number; settled: number; orders: number };
  net_profit: number;
}

export function useFinance(storeId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: ['finance', storeId ?? '', from, to],
    enabled: Boolean(storeId),
    queryFn: async (): Promise<FinanceData> => {
      const { data, error } = await getSupabase().rpc('get_finance', {
        p_store_id: storeId as string,
        p_from: from,
        p_to: to,
      });

      if (error) throw AppError.from(error);

      const raw = (data ?? {}) as Record<string, unknown>;
      const revenue = (raw.revenue ?? {}) as Record<string, unknown>;
      const costs = (raw.costs ?? {}) as Record<string, unknown>;
      const payments = (raw.payments ?? {}) as Record<string, unknown>;
      const cod = (raw.cod ?? {}) as Record<string, unknown>;

      return {
        from: String(raw.from ?? from),
        to: String(raw.to ?? to),
        revenue: {
          gross_sales: num(revenue.gross_sales),
          delivered_sales: num(revenue.delivered_sales),
          delivery_charged: num(revenue.delivery_charged),
          discount_given: num(revenue.discount_given),
        },
        costs: {
          product: num(costs.product),
          courier: num(costs.courier),
          other: num(costs.other),
          expenses: num(costs.expenses),
        },
        payments: { paid: num(payments.paid), refunded: num(payments.refunded) },
        cod: {
          expected: num(cod.expected),
          pending: num(cod.pending),
          settled: num(cod.settled),
          orders: num(cod.orders),
        },
        net_profit: num(raw.net_profit),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Sales report
//
// Kept alongside get_analytics because the Expenses screen needs the daily
// series against a specific expense total, which is a slightly different
// question from the analytics overview.
// ---------------------------------------------------------------------------

export interface SalesReport {
  totals: {
    revenue: number;
    profit: number;
    cost: number;
    discount_given: number;
    delivery_collected: number;
    orders: number;
  };
  expenses: number;
  daily: { day: string; revenue: number; profit: number; orders: number }[];
}

export function useSalesReport(storeId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: keys.salesReport(storeId ?? '', from, to),
    enabled: Boolean(storeId),
    queryFn: async (): Promise<SalesReport> => {
      const { data, error } = await getSupabase().rpc('get_sales_report', {
        p_store_id: storeId as string,
        p_from: from,
        p_to: to,
      });

      if (error) throw AppError.from(error);

      const raw = (data ?? {}) as Record<string, unknown>;
      const totals = (raw.totals ?? {}) as Record<string, unknown>;

      return {
        totals: {
          revenue: num(totals.revenue),
          profit: num(totals.profit),
          cost: num(totals.cost),
          discount_given: num(totals.discount_given),
          delivery_collected: num(totals.delivery_collected),
          orders: num(totals.orders),
        },
        expenses: num(raw.expenses),
        daily: Array.isArray(raw.daily) ? (raw.daily as SalesReport['daily']) : [],
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Product performance: three separate rankings, never one vague leaderboard
// ---------------------------------------------------------------------------

export interface PerformanceEntry {
  product_id: string;
  name: string;
  units: number;
  revenue: number;
  profit: number;
}

export function useProductPerformance(
  storeId: string | undefined,
  from: string,
  to: string,
) {
  return useQuery({
    queryKey: ['product-performance', storeId ?? '', from, to],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('get_product_performance', {
        p_store_id: storeId as string,
        p_from: from,
        p_to: to,
        p_limit: 5,
      });

      if (error) throw AppError.from(error);

      const raw = (data ?? {}) as Record<string, unknown>;
      const list = (key: string): PerformanceEntry[] =>
        Array.isArray(raw[key]) ? (raw[key] as PerformanceEntry[]) : [];

      return {
        byQuantity: list('by_quantity'),
        byRevenue: list('by_revenue'),
        byProfit: list('by_profit'),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Product detail statistics
// ---------------------------------------------------------------------------

export interface ProductStats {
  /** Physical stock on hand. Drives the low-stock alert. */
  available: number;
  /** Committed to orders that have not been delivered. */
  reserved: number;
  /** available - reserved. What can honestly be promised to a new customer. */
  sellable: number;
  sold_units: number;
  revenue: number;
  profit: number;
}

export function useProductStats(
  storeId: string | undefined,
  productId: string | undefined,
) {
  return useQuery({
    queryKey: ['product-stats', storeId ?? '', productId ?? ''],
    enabled: Boolean(storeId && productId),
    queryFn: async (): Promise<ProductStats> => {
      const { data, error } = await getSupabase().rpc('get_product_stats', {
        p_store_id: storeId as string,
        p_product_id: productId as string,
        p_from: null,
        p_to: null,
      });

      if (error) throw AppError.from(error);

      const raw = (data ?? {}) as Record<string, unknown>;
      return {
        available: num(raw.available),
        reserved: num(raw.reserved),
        sellable: num(raw.sellable ?? raw.available),
        sold_units: num(raw.sold_units),
        revenue: num(raw.revenue),
        profit: num(raw.profit),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Courier connections
// ---------------------------------------------------------------------------

export interface CourierConnection {
  id: string;
  provider: CourierProvider;
  label: string;
  is_active: boolean;
  /** False for REDX and manual: the app must not offer an API path it cannot honour. */
  supports_api: boolean;
  has_credentials: boolean;
  external_store_id: string | null;
}

export function useCouriers(orgId: string | undefined) {
  return useQuery({
    queryKey: ['couriers', orgId ?? ''],
    enabled: Boolean(orgId),
    queryFn: async (): Promise<CourierConnection[]> => {
      const { data, error } = await getSupabase().rpc('get_couriers', {
        p_org_id: orgId as string,
      });

      if (error) throw AppError.from(error);
      const raw = (data ?? {}) as Record<string, unknown>;
      return Array.isArray(raw.connections) ? (raw.connections as CourierConnection[]) : [];
    },
  });
}

export type { CourierProvider, ShipmentState };
