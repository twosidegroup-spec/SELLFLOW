-- ---------------------------------------------------------------------------
-- Set stock to an exact counted quantity.
--
-- `adjust_stock` takes a relative delta, which is the right tool for "we
-- received 12 more" but the wrong one for "I counted the shelf and there are
-- 20". For a stock count the seller knows the target, not the change.
--
-- The obvious implementation is to read the current quantity, compute
-- target - current on the client, and call adjust_stock. That is a
-- time-of-check-to-time-of-use bug: if an order takes the last unit between
-- the read and the write, the computed delta silently lands the balance on
-- the wrong number and the ledger records a movement that does not explain
-- what is actually on the shelf.
--
-- So the target is resolved here, inside the same transaction, against a
-- locked row. The audit trail is preserved: this still writes one
-- inventory_movements row via apply_stock_delta, so every balance remains
-- explainable by a movement, and the stock floor and low-stock alert
-- triggers fire exactly as they do for any other change.
-- ---------------------------------------------------------------------------
create or replace function public.set_stock(
  p_store_id   uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_target     integer,
  p_reason     public.inventory_reason,
  p_note       text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid := public.assert_store_access(p_store_id);
  v_tracks boolean;
  v_name   text;
  v_current integer;
begin
  perform public.assert_org_write(v_org);

  -- Same reasons adjust_stock allows: manual corrections only. Order-driven
  -- stock stays with create_order.
  if p_reason not in ('initial', 'purchase', 'adjustment', 'damage') then
    raise exception 'invalid_reason'
      using hint = 'Use set_stock for manual counts; order stock is handled automatically.';
  end if;

  if p_target is null then
    raise exception 'invalid_quantity' using hint = 'Enter the quantity you counted.';
  end if;

  if p_target < 0 then
    raise exception 'invalid_quantity'
      using hint = 'Stock cannot be negative. Adjust sales instead.';
  end if;

  select p.track_inventory, p.name into v_tracks, v_name
  from public.products p
  where p.id = p_product_id and p.org_id = v_org;

  if v_tracks is null then
    raise exception 'product_not_found' using hint = 'That product no longer exists.';
  end if;

  if not v_tracks then
    raise exception 'inventory_not_tracked'
      using hint = v_name || ' does not track inventory. Turn tracking on first.';
  end if;

  -- Lock the row before reading the balance so a concurrent order cannot
  -- move the stock between the read and the write below.
  select i.quantity into v_current
  from public.inventory i
  where i.store_id = p_store_id
    and i.product_id = p_product_id
    and i.variant_id is not distinct from p_variant_id
  for update;

  v_current := coalesce(v_current, 0);

  -- A no-op count is not an error worth surfacing as a failure, but it must
  -- not write a movement either: inventory_movements_delta_check forbids a
  -- zero delta, and a zero-delta row would be noise in the audit trail.
  if p_target = v_current then
    return v_current;
  end if;

  return public.apply_stock_delta(
    v_org, p_store_id, p_product_id, p_variant_id,
    p_target - v_current, p_reason, 'manual', null,
    coalesce(p_note, 'Stock count: ' || v_current || ' → ' || p_target)
  );
end;
$$;

grant execute on function public.set_stock(uuid, uuid, uuid, integer, public.inventory_reason, text) to authenticated;
