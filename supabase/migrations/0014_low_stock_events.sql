-- ===========================================================================
-- SellFlow :: 0013 -- low stock events the original trigger could not see
--
-- Migration 0009 watches `inventory` with `after update of quantity`. That
-- covers a stock level falling, but it misses two real situations a seller
-- would expect to be told about:
--
--   1. A product is created ALREADY below its alert level. The opening stock
--      arrives as an INSERT into inventory, not an UPDATE, so 0009's trigger
--      never fires and the seller is never warned about goods that are already
--      short.
--
--   2. The seller raises the alert level on a product that is already under the
--      new level. Nothing about inventory changed, so again no alert.
--
-- Both are events, not schedules, so they are fixed with more triggers rather
-- than a cron job. This keeps V1 fully event-driven: no external scheduler, no
-- background process, nothing to keep running.
--
-- `run_scheduled_checks()` is deliberately left unused. It exists for a future
-- "sweep for anything missed" job, and calling it on a timer would add an
-- infrastructure dependency V1 does not need.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Inventory INSERT also counts
--
-- Rewritten to branch on TG_OP. On INSERT there is no `old` row, so the
-- "crossed down through the line" comparison cannot apply; instead the arrival
-- is treated as the crossing if the product is already at or below its level.
-- ---------------------------------------------------------------------------
create or replace function public.produce_inventory_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_threshold int;
  v_name      text;
  v_org       uuid;
  v_old_qty   int;
begin
  -- An UPDATE that did not move the quantity is not an event.
  if tg_op = 'UPDATE' and new.quantity = old.quantity then
    return new;
  end if;

  select p.low_stock_threshold, p.name, p.org_id
    into v_threshold, v_name, v_org
  from public.products p
  where p.id = new.product_id
    and p.track_inventory
    and not p.is_archived
    and p.low_stock_threshold > 0;

  if v_threshold is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Opening stock that is already short is a genuine, actionable surprise.
    if new.quantity <= v_threshold then
      perform public.notify_org(
        v_org, 'low_stock',
        'Low stock: ' || v_name,
        new.quantity || ' left, alert level ' || v_threshold,
        jsonb_build_object('product_id', new.product_id, 'quantity', new.quantity,
                           'store_id', new.store_id),
        'low_stock:' || new.product_id || ':' || new.store_id
      );
    end if;
    return new;
  end if;

  v_old_qty := old.quantity;

  -- Crossed DOWN through the line: warn now.
  if new.quantity <= v_threshold and v_old_qty > v_threshold then
    perform public.notify_org(
      v_org, 'low_stock',
      'Low stock: ' || v_name,
      new.quantity || ' left, alert level ' || v_threshold,
      jsonb_build_object('product_id', new.product_id, 'quantity', new.quantity,
                         'store_id', new.store_id),
      'low_stock:' || new.product_id || ':' || new.store_id
    );

  -- Back ABOVE the line: re-arm, so the next dip alerts again.
  elsif new.quantity > v_threshold and v_old_qty <= v_threshold then
    perform public.rearm_low_stock(v_org, new.product_id);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_inventory_alerts on public.inventory;
create trigger trg_inventory_alerts
  after insert or update of quantity on public.inventory
  for each row execute function public.produce_inventory_alert();

-- ---------------------------------------------------------------------------
-- 2. Raising the alert level above current stock
--
-- A product can be short of a threshold the seller has only just introduced, so
-- this is a real event. The dedupe key includes the threshold value, which
-- means:
--   * editing a product repeatedly does NOT produce a stream of alerts
--   * raising the threshold again to a different level DOES alert again,
--     because that is new information
-- ---------------------------------------------------------------------------
create or replace function public.produce_low_stock_on_threshold_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  -- Only a genuine change in the alert level, or turning tracking on, is an event.
  if new.low_stock_threshold is not distinct from old.low_stock_threshold
     and new.track_inventory is not distinct from old.track_inventory
     and new.is_archived is not distinct from old.is_archived then
    return new;
  end if;

  -- Turning tracking OFF, or archiving, means "stop warning me".
  if not new.track_inventory or new.is_archived or new.low_stock_threshold <= 0 then
    return new;
  end if;

  -- A product is short if ANY store that holds it is already at or below the
  -- new level. A per-store warning would be noise: the seller thinks in
  -- products, not in per-outlet balances.
  for v_row in
    select i.store_id, i.quantity
    from public.inventory i
    where i.product_id = new.id and i.variant_id is null
  loop
    if v_row.quantity <= new.low_stock_threshold then
      perform public.notify_org(
        new.org_id, 'low_stock',
        'Low stock: ' || new.name,
        v_row.quantity || ' left, alert level ' || new.low_stock_threshold,
        jsonb_build_object('product_id', new.id, 'quantity', v_row.quantity,
                           'store_id', v_row.store_id),
        'low_stock_threshold:' || new.id || ':' || new.low_stock_threshold
      );
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_product_threshold_alerts on public.products;
create trigger trg_product_threshold_alerts
  after update of low_stock_threshold, track_inventory, is_archived on public.products
  for each row execute function public.produce_low_stock_on_threshold_change();
