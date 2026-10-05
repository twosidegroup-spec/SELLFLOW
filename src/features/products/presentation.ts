/**
 * How an inventory movement reason is presented.
 *
 * The database stores snake_case (`sale_return`). Showing that raw in a ledger reads
 * like a debugging artefact, and worse, it invites a seller to think there are two
 * different things called "sale return" and "return". One map, one wording.
 */

import type { InventoryReason } from '@/lib/database.types';

export const INVENTORY_REASON_LABEL: Record<InventoryReason, string> = {
  initial: 'First count',
  purchase: 'Bought stock',
  sale: 'Sold',
  sale_return: 'Sale returned',
  adjustment: 'Correction',
  damage: 'Damaged',
};

/**
 * The reasons a seller may pick by hand.
 *
 * `sale` and `sale_return` are excluded on purpose. The app writes those itself when
 * an order is placed or returned, and offering them here would let a seller record a
 * phantom sale with no order behind it -- which would silently desynchronise stock from
 * the order history and make both numbers untrustworthy.
 */
export const MANUAL_STOCK_REASONS: { value: InventoryReason; label: string }[] = [
  { value: 'adjustment', label: 'Correction' },
  { value: 'initial', label: 'First count' },
  { value: 'purchase', label: 'Bought stock' },
  { value: 'damage', label: 'Damaged' },
];