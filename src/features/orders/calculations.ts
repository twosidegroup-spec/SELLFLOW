/**
 * Order calculations.
 *
 * The live order summary shown while the seller is building an order. This is a
 * *preview*: the authoritative figures are computed by `create_order` in
 * Postgres (0005_business_functions.sql) and what gets persisted.
 *
 * Both sides follow the same rules, which is why the two are written the same
 * shape:
 *
 *   items_total    = Σ (unit_price × quantity − line_discount)
 *   total          = items_total − order_discount + delivery_charge
 *   cost_total     = Σ (unit_cost × quantity)
 *   profit         = total − cost_total
 *
 * Every value is integer minor units. `distribute` assigns the order-level
 * discount across lines by value, so the lines always reconcile back to the
 * order total without losing or inventing a single poisha.
 */

import { add, distribute, multiply, subtract, sum, type Money } from '@/lib/money';

export interface DraftLine {
  /** Client-side key. Stable across re-renders so lists do not reshuffle. */
  lineId: string;
  productId: string;
  variantId: string | null;
  name: string;
  variantName?: string | null;
  sku?: string | null;
  unitPrice: Money;
  unitCost: Money;
  quantity: number;
  lineDiscount: Money;
  /** Stock available in the active store, used to warn before submitting. */
  available: number;
  trackInventory: boolean;
}

export interface OrderTotals {
  itemsTotal: Money;
  discount: Money;
  deliveryCharge: Money;
  total: Money;
  costTotal: Money;
  profit: Money;
  /** True when any product has no recorded cost, so profit is a partial figure. */
  profitIsPartial: boolean;
  unitCount: number;
  lineCount: number;
}

/** Value of a single line after its own discount. */
export function lineTotal(line: DraftLine): Money {
  return subtract(multiply(line.unitPrice, line.quantity), line.lineDiscount);
}

/**
 * Totals for the draft.
 *
 * `orderDiscount` is capped at the item total: a discount larger than the order
 * is worth would produce a negative total, which the database rejects. Clamping
 * here too keeps the preview identical to what will actually be saved.
 */
export function calculateTotals(
  lines: DraftLine[],
  orderDiscount: Money,
  deliveryCharge: Money,
): OrderTotals {
  const lineTotals = lines.map(lineTotal);
  const rawItemsTotal = sum(lineTotals);

  const discount = Math.min(Math.max(orderDiscount, 0), Math.max(rawItemsTotal, 0));
  const delivery = Math.max(deliveryCharge, 0);

  const total = subtract(add(rawItemsTotal, delivery), discount);
  const costTotal = sum(lines.map((line) => multiply(line.unitCost, line.quantity)));

  return {
    itemsTotal: rawItemsTotal,
    discount,
    deliveryCharge: delivery,
    total,
    costTotal,
    profit: subtract(total, costTotal),
    // A product with no recorded cost makes the profit figure optimistic, so the
    // UI must not present it as final.
    profitIsPartial: lines.some((line) => line.unitCost === 0),
    unitCount: lines.reduce((total_, line) => total_ + line.quantity, 0),
    lineCount: lines.length,
  };
}

/**
 * Distributes the order-level discount across lines, proportional to value.
 *
 * Mirrors the `order_items.line_discount` semantics so the totals screen can
 * show a per-line effective price that still adds up.
 */
export function allocateDiscount(lines: DraftLine[], orderDiscount: Money): Money[] {
  const weights = lines.map((line) => lineTotal(line));
  const clamped = Math.min(Math.max(orderDiscount, 0), Math.max(sum(weights), 0));
  return distribute(clamped, weights);
}

/** Per-line share of the discount, keyed by line id. */
export function discountByLine(lines: DraftLine[], orderDiscount: Money): Map<string, Money> {
  const shares = allocateDiscount(lines, orderDiscount);
  const result = new Map<string, Money>();
  lines.forEach((line, index) => {
    result.set(line.lineId, shares[index] ?? 0);
  });
  return result;
}

/** What the customer still owes on an existing order. */
export function outstanding(total: Money, paid: Money): Money {
  return Math.max(0, subtract(total, paid));
}

/**
 * Whether the draft can be submitted.
 *
 * Requires at least one line with a positive quantity and a non-negative total.
 * A fully-discounted order is allowed -- giving something away is a legitimate
 * decision, and the database records it as a zero-total order.
 */
export function validateDraft(lines: DraftLine[]): { valid: boolean; reason?: string } {
  if (lines.length === 0) {
    return { valid: false, reason: 'Add at least one product.' };
  }
  if (lines.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1)) {
    return { valid: false, reason: 'Every product needs a quantity of at least 1.' };
  }
  if (lines.some((line) => line.unitPrice < 0)) {
    return { valid: false, reason: 'Prices cannot be negative.' };
  }
  if (lines.some((line) => line.lineDiscount > lineTotal(line) + line.lineDiscount)) {
    return { valid: false, reason: 'A line discount is larger than the line value.' };
  }
  return { valid: true };
}

/**
 * Lines that would take stock below zero.
 *
 * Reported as a warning, not a block: the business may have `allow_negative_stock`
 * enabled, and the server is the authority. Blocking here would contradict it.
 */
export function stockWarnings(lines: DraftLine[]): DraftLine[] {
  return lines.filter(
    (line) => line.trackInventory && line.available >= 0 && line.quantity > line.available,
  );
}

/** Merges a quantity increase for a product already in the draft. */
export function addLineToDraft(lines: DraftLine[], line: DraftLine): DraftLine[] {
  const existingIndex = lines.findIndex(
    (candidate) =>
      candidate.productId === line.productId && candidate.variantId === line.variantId,
  );

  if (existingIndex === -1) return [...lines, line];

  return lines.map((candidate, index) =>
    index === existingIndex
      ? { ...candidate, quantity: candidate.quantity + line.quantity }
      : candidate,
  );
}
