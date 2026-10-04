/**
 * How a seller says they took the money.
 *
 * This is NOT the same thing as a payment *provider*, and the distinction is worth
 * stating because the two lists overlap and a seller picks from both:
 *
 *   - `payment_provider` records which MFS reported an incoming payment. That is a
 *     property of the message, so it is limited to bKash, Nagad, Rocket and Upay
 *     and is only ever set by the detection pipeline.
 *   - `payment_method` records how the seller says they were paid, on an order they
 *     entered themselves. That includes cash, card and bank transfer, which no
 *     message will ever arrive for.
 *
 * Upay is the clearest case: it is a provider with no `payment_method` value, so an
 * Upay payment records as `other`. See `docs/payment-engine.md`.
 *
 * The list lived twice -- `PAYMENT_METHODS` in the new-order form and `METHODS` in
 * the order detail screen -- as byte-identical seven-entry arrays under two names.
 * Two copies is two places for them to drift, and a seller creating an order and
 * then editing it would eventually see different options.
 */

import type { PaymentMethod } from '@/lib/database.types';

export interface PaymentMethodOption {
  value: PaymentMethod;
  label: string;
}

/** Ordered as a seller would say them: what they hold in hand, then digital. */
export const PAYMENT_METHODS: PaymentMethodOption[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'bkash', label: 'bKash' },
  { value: 'nagad', label: 'Nagad' },
  { value: 'rocket', label: 'Rocket' },
  { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'other', label: 'Other' },
];

/** The label for a stored value, falling back to the raw value rather than blank. */
export function paymentMethodLabel(method: PaymentMethod | null | undefined): string {
  if (!method) return 'Not set';
  return PAYMENT_METHODS.find((option) => option.value === method)?.label ?? method;
}
