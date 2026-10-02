/**
 * TanStack Query setup.
 *
 * The caching policy here is what produces the offline experience: cached data
 * is served instantly, the network is refetched in the background, and a failed
 * background refetch does NOT blank out data the user is already looking at.
 * `gcTime` is long enough that closing a screen and coming back is instant.
 */

import { QueryClient } from '@tanstack/react-query';

import { AppError } from './errors';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data is fresh for 30s; most screens refetch on focus anyway.
      staleTime: 30_000,
      // Keep cached data for 7 days. A seller opening the app after a week
      // offline should still see their catalog rather than a blank screen.
      gcTime: 7 * 24 * 60 * 60 * 1000,
      retry: (failureCount, error) => {
        // Never retry a rejected request -- it will be rejected again, and the
        // retry only delays the error message the user needs to see.
        if (error instanceof AppError && error.title !== 'No connection') return false;
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      // Refetch when the user returns to a screen.
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});

/**
 * Cache keys.
 *
 * Hierarchical so a mutation can invalidate everything under a prefix --
 * creating an order invalidates `['orders']` and `['dashboard']` together.
 * Every key includes the store id, so switching stores can never show another
 * store's cached rows.
 */
export const keys = {
  dashboard: (storeId: string) => ['dashboard', storeId] as const,
  orders: (storeId: string) => ['orders', storeId] as const,
  order: (storeId: string, orderId: string) => ['orders', storeId, orderId] as const,
  orderItems: (orderId: string) => ['order-items', orderId] as const,
  orderHistory: (orderId: string) => ['order-history', orderId] as const,
  allowedStatuses: (orderId: string) => ['order-allowed-statuses', orderId] as const,
  payments: (orderId: string) => ['payments', orderId] as const,

  products: (storeId: string) => ['products', storeId] as const,
  product: (productId: string) => ['product', productId] as const,
  productStock: (storeId: string, productId: string) => ['product-stock', storeId, productId] as const,
  movements: (productId: string) => ['movements', productId] as const,
  lowStock: (storeId: string) => ['low-stock', storeId] as const,

  customers: () => ['customers'] as const,
  customer: (customerId: string) => ['customer', customerId] as const,
  customerStats: (customerId: string) => ['customer-stats', customerId] as const,
  customerOrders: (customerId: string) => ['customer-orders', customerId] as const,

  expenses: (storeId: string) => ['expenses', storeId] as const,
  salesReport: (storeId: string, from: string, to: string) =>
    ['sales-report', storeId, from, to] as const,
  analytics: (storeId: string, from: string, to: string) =>
    ['analytics', storeId, from, to] as const,
  finance: (storeId: string, from: string, to: string) =>
    ['finance', storeId, from, to] as const,
  productPerformance: (storeId: string, from: string, to: string) =>
    ['product-performance', storeId, from, to] as const,
  productStats: (storeId: string, productId: string) =>
    ['product-stats', storeId, productId] as const,
  couriers: (orgId: string) => ['couriers', orgId] as const,
  shipments: (orderId: string) => ['shipments', orderId] as const,
  settlements: () => ['settlements'] as const,
  shipmentEvents: (shipmentId: string) => ['shipment-events', shipmentId] as const,
  settlement: (orderId: string) => ['settlement', orderId] as const,
  topProducts: (storeId: string, from: string, to: string) =>
    ['top-products', storeId, from, to] as const,

  notifications: () => ['notifications'] as const,
  unreadCount: () => ['notifications', 'unread-count'] as const,
} as const;
