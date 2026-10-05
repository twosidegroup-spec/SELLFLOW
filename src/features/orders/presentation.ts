/**
 * How an order status is presented.
 *
 * Shared by the order list, the order detail, and the customer detail, because three
 * screens each inventing their own wording for "on_delivery" is how a seller ends up
 * wondering whether two different screens are describing the same situation.
 *
 * The tone mapping is the important part. Status is not a scale, so it is not one
 * colour: only the genuinely final outcomes get the terminal tones, and everything
 * mid-journey stays neutral. Painting "packaging" amber would train a seller to
 * ignore amber, which costs us the one warning that matters.
 */

import type { BadgeTone } from '@/components/ui';
import type { OrderStatus, PaymentStatus } from '@/lib/database.types';

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  processing: 'Processing',
  packaging: 'Packaging',
  packed: 'Packed',
  shipped: 'Shipped',
  on_delivery: 'On delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  returned: 'Returned',
  failed_delivery: 'Delivery failed',
};

/**
 * Sorted in the order a parcel actually travels, so anything that iterates statuses
 * in a selector produces a sensible list rather than alphabetical noise.
 */
export const ORDER_STATUS_FLOW: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'packaging',
  'packed',
  'shipped',
  'on_delivery',
  'delivered',
];

/** Statuses that end an order's life without money having been delivered. */
export const ORDER_TERMINAL_STATUSES: OrderStatus[] = [
  'delivered',
  'cancelled',
  'returned',
  'failed_delivery',
];

/** Statuses from which no further transition is allowed. */
export const ORDER_CLOSED_STATUSES: OrderStatus[] = [
  'delivered',
  'cancelled',
  'returned',
  'failed_delivery',
];

export function orderStatusTone(status: OrderStatus): BadgeTone {
  switch (status) {
    case 'delivered':
      return 'success';
    case 'cancelled':
    case 'failed_delivery':
      return 'danger';
    case 'returned':
      return 'warning';
    default:
      // Mid-journey. Deliberately unremarkable.
      return 'neutral';
  }
}

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  unpaid: 'Unpaid',
  partial: 'Partly paid',
  paid: 'Paid',
  refunded: 'Refunded',
};

/**
 * Payment tone. `unpaid` is only a problem once the order has moved on, so the callers
 * pass whether that is the case -- see `paymentStatusTone`.
 */
export function paymentStatusTone(status: PaymentStatus, isLive: boolean): BadgeTone {
  if (status === 'refunded') return 'warning';
  if (status === 'paid') return 'success';
  return isLive ? 'warning' : 'neutral';
}