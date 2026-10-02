-- ===========================================================================
-- SellFlow :: 0016 -- sellable stock
--
-- Found by the financial definition audit (verify_finance.sql, CHECK 6).
--
-- The finding
-- -----------
-- Stock is decremented when an order is created, so `inventory.quantity` is the
-- physical on-hand count. A confirmed-but-undelivered order has already had its
-- units removed from that row, and those units are committed to that customer.
--
-- With 48 bags on hand and 2 held by an order in progress, the product page
-- reported "available 48". A seller reading that could promise 48 more, oversell
-- by 2, and only discover it when the second parcel could not be fulfilled.
--
--   available  = on hand                     (what is physically on the shelf)
--   reserved   = committed to undelivered orders
--   sellable   = available - reserved        (what can honestly be promised now)
--
-- Why `available` is NOT redefined
-- ------------------------------
-- `available` is what the low-stock alert compares against the threshold, and
-- that comparison is correct against PHYSICAL stock: a seller needs restocking
-- when the shelf empties, not when the goods leave the shelf. Redefining
-- `available` would have silently changed restock behaviour, which is exactly the
-- kind of semantic drift this migration is meant to avoid. `sellable` is added
-- alongside instead, so both numbers are available and neither meaning is lost.
-- ===========================================================================

create or replace function public.get_product_stats(
  p_store_id  uuid,
  p_product_id uuid,
  p_from      date default null,
  p_to        date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_p   record;
  v_onhand   int;
  v_reserved int;
  v_sold     numeric;
  v_revenue  numeric;
  v_profit   numeric;
begin
  -- Authorise via the store the product is being viewed in.
  v_org := public.assert_store_access(p_store_id);

  select p.id, p.name, p.sku, p.selling_price, p.cost_price, p.low_stock_threshold,
         p.track_inventory
    into v_p
  from public.products p
  where p.id = p_product_id and p.org_id = v_org;

  if v_p.id is null then
    raise exception 'product_not_found' using hint = 'That product no longer exists.';
  end if;

  -- Physical stock, excluding any variant rows. A parent product's on-hand is the
  -- parent-level inventory line.
  select coalesce(i.quantity, 0) into v_onhand
  from (select 0) anchor
  left join public.inventory i
    on i.store_id = p_store_id
   and i.product_id = p_product_id
   and i.variant_id is null;

  -- Units committed to orders that have not yet been delivered. Once delivered
  -- (or returned and restocked) the goods are no longer spoken for, so those
  -- statuses are excluded.
  select coalesce(sum(oi.quantity), 0)::int into v_reserved
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.store_id = p_store_id
    and oi.product_id = p_product_id
    and o.status in ('confirmed', 'processing', 'packaging', 'packed',
                     'shipped', 'on_delivery');

  -- Sales figures share one qualifying population.
  select coalesce(sum(oi.quantity), 0),
         coalesce(sum(oi.line_total), 0),
         coalesce(sum(oi.line_total) - sum(coalesce(oi.unit_cost, 0) * oi.quantity), 0)
    into v_sold, v_revenue, v_profit
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.org_id = v_org and o.store_id = p_store_id
    and oi.product_id = p_product_id
    and (p_from is null or (o.placed_at at time zone 'UTC')::date >= p_from)
    and (p_to   is null or (o.placed_at at time zone 'UTC')::date <= p_to)
    and o.status not in ('cancelled', 'returned', 'failed_delivery');

  return jsonb_build_object(
    'product_id', v_p.id,
    'name', v_p.name,
    'sku', v_p.sku,
    'selling_price', v_p.selling_price,
    'cost_price', v_p.cost_price,
    'low_stock_threshold', v_p.low_stock_threshold,
    'track_inventory', v_p.track_inventory,

    -- Physical stock on hand. This is the low-stock alert's input.
    'available', v_onhand,

    -- Committed to undelivered orders.
    'reserved', v_reserved,

    -- What can honestly be promised to a new customer right now. Never below
    -- zero: a seller whose stock is oversold should see 0 available to promise,
    -- not a negative figure.
    'sellable', greatest(v_onhand - v_reserved, 0),

    'sold_units', v_sold,
    'revenue', v_revenue,
    'profit', v_profit
  );
end;
$$;

comment on function public.get_product_stats(uuid, uuid, date, date) is
  'Per-product inventory and sales. available = on hand, reserved = committed to undelivered orders, sellable = available - reserved. get_dashboard and the notification producers compare available against the threshold, because a restock is needed when the shelf is empty, not when the goods leave it.';

grant execute on function public.get_product_stats(uuid, uuid, date, date) to authenticated;
