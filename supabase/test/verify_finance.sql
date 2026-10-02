-- ===========================================================================
-- SellFlow :: financial definition audit
--
-- Not a happy-path suite. This asserts the RELATIONSHIPS between metrics, so
-- an inconsistency anywhere shows up as a failure with the two disagreeing
-- numbers printed.
--
-- The invariants checked are the ones the product depends on:
--
--   1. profit per order == total - product cost - courier - other
--   2. net profit    == sum(order profit) - expenses          (no double count)
--   3. gross sales   == sum(order total)                     (one definition)
--   4. order total   == items - discount + delivery
--   5. product revenue + discount == gross sales              (line vs order)
--   6. available     == on hand - reserved
--   7. AOV           == gross sales / order count
--   8. cancelled / returned / failed never counted as revenue
--   9. COD expected = pending + settled
--  10. stock movements reconcile with the on-hand balance
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data)
values ('11111111-1111-1111-1111-111111111111', 'audit@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

create temporary table _a (org_id uuid primary key, store_id uuid);
insert into _a
select (public.bootstrap_business('Audit Traders', 'Main', 'AUD') ->> 'org_id')::uuid, null;
update _a set store_id = (select id from public.stores where org_id = _a.org_id limit 1);

insert into public.products (id, org_id, name, sku, selling_price, cost_price, low_stock_threshold)
select '21000000-0000-0000-0000-000000000001'::uuid, org_id, 'Clip', 'C1', 100, 60, 5 from _a
union all
select '21000000-0000-0000-0000-000000000002'::uuid, org_id, 'Bag', 'B1', 2000, 1500, 5 from _a;

insert into public.customers (id, org_id, name, phone)
select '22000000-0000-0000-0000-000000000001'::uuid, org_id, 'Buyer', '01700000001' from _a;

do $$
declare v record;
begin
  for v in select store_id from _a loop
    perform public.adjust_stock(v.store_id, '21000000-0000-0000-0000-000000000001', null, 100, 'initial', null);
    perform public.adjust_stock(v.store_id, '21000000-0000-0000-0000-000000000002', null, 50, 'initial', null);
  end loop;
end $$;

-- ===========================================================================
-- A worked example with EVERY cost type present, so nothing is skipped
--   order A: 3 x 100 clips, line discount 0, order discount 20, delivery 50
--             courier cost 30, other (packaging) cost 10
--   order B: 2 x 2000 bags, no adjustments, COD
--   order C: cancelled -- must not appear in any revenue figure
--   order D: failed delivery -- must not appear in revenue either
-- ===========================================================================
do $$
declare v_store uuid; v_a uuid; v_b uuid; v_c uuid; v_d uuid;
begin
  select store_id into v_store from _a;

  v_a := public.create_order(
    v_store,
    '22000000-0000-0000-0000-000000000001',
    '[{"product_id":"21000000-0000-0000-0000-000000000001","quantity":3}]'::jsonb,
    20, 50, 0, 'cash', null,
    'ee000000-0000-0000-0000-000000000001'::uuid, null,
    null, null, null, null, null,
    30, 10, false);

  -- A: items 300, discount 20, delivery 50 -> total 330
  --    cost 3 x 60 = 180, courier 30, other 10 -> profit 110
  perform public.set_order_status(v_a, 'confirmed');
  perform public.set_order_status(v_a, 'processing');
  perform public.set_order_status(v_a, 'packaging');
  perform public.set_order_status(v_a, 'packed');
  perform public.set_order_status(v_a, 'shipped');
  perform public.set_order_status(v_a, 'on_delivery');
  perform public.set_order_status(v_a, 'delivered');

  v_b := public.create_order(
    v_store, null,
    '[{"product_id":"21000000-0000-0000-0000-000000000002","quantity":2}]'::jsonb,
    0, 0, 0, 'cash', null,
    'ee000000-0000-0000-0000-000000000002'::uuid, null,
    null, null, null, null, null,
    0, 0, true);
  perform public.set_order_status(v_b, 'confirmed');

  v_c := public.create_order(
    v_store, null,
    '[{"product_id":"21000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    0, 0, 0, 'cash', null,
    'ee000000-0000-0000-0000-000000000003'::uuid);
  perform public.set_order_status(v_c, 'cancelled');

  v_d := public.create_order(
    v_store, null,
    '[{"product_id":"21000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    0, 0, 0, 'cash', null,
    'ee000000-0000-0000-0000-000000000004'::uuid);
  perform public.set_order_status(v_d, 'failed_delivery');
end $$;

-- ===========================================================================
-- CHECK 1 and 4: the per-order formula
-- ===========================================================================
do $$
declare v record; v_total numeric; v_profit numeric; v_expected numeric;
begin
  for v in
    select o.id, o.items_total, o.discount, o.delivery_charge, o.total,
           o.cost_total, o.courier_cost, o.other_cost, o.profit
    from public.orders o, _a
    where o.store_id = _a.store_id
  loop
    v_total := v.items_total - v.discount + v.delivery_charge;
    v_expected := v_total - v.cost_total - v.courier_cost - v.other_cost;

    if v.total <> v_total then
      raise exception 'CHECK 4: order total is % but items % - discount % + delivery % = %',
        v.total, v.items_total, v.discount, v.delivery_charge, v_total;
    end if;

    if v.profit <> v_expected then
      raise exception 'CHECK 1: order profit is % but % - % - % - % = %',
        v.profit, v_total, v.cost_total, v.courier_cost, v.other_cost, v_expected;
    end if;
  end loop;
end $$;

-- ===========================================================================
-- CHECK 3: gross sales has exactly one definition
-- ===========================================================================
do $$
declare v_store uuid; v_f jsonb; v_sum_total numeric;
begin
  select store_id into v_store from _a;
  v_f := public.get_finance(v_store, current_date, current_date);

  select coalesce(sum(total), 0) into v_sum_total
  from public.orders
  where store_id = v_store
    and status not in ('cancelled', 'returned', 'failed_delivery');

  if (v_f -> 'revenue' ->> 'gross_sales')::numeric <> v_sum_total then
    raise exception 'CHECK 3: gross sales % does not equal the sum of qualifying order totals %',
      v_f -> 'revenue' ->> 'gross_sales', v_sum_total;
  end if;
end $$;

-- ===========================================================================
-- CHECK 2: net profit reconciles, and excluded orders stay out
-- ===========================================================================
do $$
declare v_store uuid; v_f jsonb; v_sum_profit numeric; v_expenses numeric;
begin
  select store_id into v_store from _a;
  v_f := public.get_finance(v_store, current_date, current_date);

  -- Only QUALIFYING orders contribute profit. A cancelled or failed order still
  -- has a `profit` value stored on it from the moment it was created, and that
  -- stored value must not leak into the books.
  select coalesce(sum(profit), 0) into v_sum_profit
  from public.orders
  where store_id = v_store
    and status not in ('cancelled', 'returned', 'failed_delivery');

  select coalesce(sum(amount), 0) into v_expenses
  from public.expenses where store_id = v_store;

  if (v_f ->> 'net_profit')::numeric <> v_sum_profit - v_expenses then
    raise exception 'CHECK 2: net profit % != sum(qualifying order profit) % - expenses %',
      v_f ->> 'net_profit', v_sum_profit, v_expenses;
  end if;

  -- And the stored profit of a cancelled order must genuinely be excluded.
  -- (C and D were cancelled / failed and each still carries a non-zero
  -- `profit` column from creation time.)
  if (v_f ->> 'net_profit')::numeric
     <> (select coalesce(sum(o.profit), 0) from public.orders o, _a
          where o.store_id = _a.store_id
            and o.status not in ('cancelled', 'returned', 'failed_delivery')) - v_expenses then
    raise exception 'CHECK 2: a cancelled or failed order''s profit is reaching net profit';
  end if;
end $$;

-- ===========================================================================
-- CHECK 8: excluded statuses really are excluded
-- ===========================================================================
do $$
declare v_store uuid; v_f jsonb; v_realistic numeric;
begin
  select store_id into v_store from _a;
  v_f := public.get_finance(v_store, current_date, current_date);

  -- A = 330 delivered, B = 4000 confirmed. Cancelled 100 and failed 100 excluded.
  v_realistic := 330 + 4000;
  if (v_f -> 'revenue' ->> 'gross_sales')::numeric <> v_realistic then
    raise exception 'CHECK 8: gross sales is %, expected % (cancelled and failed must be excluded)',
      v_f -> 'revenue' ->> 'gross_sales', v_realistic;
  end if;
end $$;

-- ===========================================================================
-- CHECK 5: product revenue vs order gross
--
-- get_product_stats sums order ITEM lines. get_finance sums order totals, which
-- have the order-level discount removed. If an order discount exists, the two
-- legitimately differ by that discount. This check pins the relationship so
-- any future change to either side is caught.
-- ===========================================================================
do $$
declare
  v_store uuid;
  v_product_total numeric;
  v_gross numeric;
  v_discount numeric;
  v_delivery numeric;
begin
  select store_id into v_store from _a;

  select coalesce(sum(oi.line_total), 0) into v_product_total
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.store_id = v_store
    and o.status not in ('cancelled', 'returned', 'failed_delivery');

  select (public.get_finance(v_store, current_date, current_date) -> 'revenue' ->> 'gross_sales')::numeric
    into v_gross;
  select coalesce(sum(discount), 0) into v_discount
  from public.orders where store_id = v_store
    and status not in ('cancelled', 'returned', 'failed_delivery');

  -- gross = product line revenue - order discount + delivery
  select coalesce(sum(delivery_charge), 0) into v_delivery
  from public.orders
  where store_id = v_store
    and status not in ('cancelled', 'returned', 'failed_delivery');

  if v_gross <> v_product_total - v_discount + v_delivery then
    raise exception
      'CHECK 5: gross % does not reconcile with product lines % - discount % + delivery %',
      v_gross, v_product_total, v_discount, v_delivery;
  end if;

  raise notice 'CHECK 5 ok: product lines % - discount % + delivery % = gross %',
    v_product_total, v_discount, v_delivery, v_gross;
end $$;

-- ===========================================================================
-- CHECK 6: available vs reserved
--
-- Stock is decremented when an order is created, so the inventory row is the
-- physical on-hand count. A confirmed-but-undelivered order has already
-- removed its units from that row, and those units are committed.
--
-- The sellable figure is therefore on-hand MINUS reserved. This check records
-- the two numbers and asserts their relationship, so whichever definition the
-- app settles on is enforced rather than assumed.
-- ===========================================================================
do $$
declare v_store uuid; v_s jsonb; v_onhand int; v_reserved int;
begin
  select store_id into v_store from _a;

  v_s := public.get_product_stats(v_store, '21000000-0000-0000-0000-000000000001');

  select quantity into v_onhand from public.inventory
   where store_id = v_store and product_id = '21000000-0000-0000-0000-000000000001' and variant_id is null;

  v_reserved := (v_s ->> 'reserved')::int;

  -- Clips: 100 opening
  --   order A  -3  delivered
  --   order C  -1  created, then +1 cancelled  -> net 0
  --   order D  -1  created, failed_delivery   -> NOT restocked, stays -1
  --   = 96. The asymmetry between C and D is the point: a cancelled order puts
  --   goods back, a failed delivery does not, because the parcel is still out
  --   there with the rider.
  if v_onhand <> 96 then
    raise exception 'CHECK 6: expected 96 clips on hand, found %', v_onhand;
  end if;

  if v_reserved <> 0 then
    raise exception 'CHECK 6: expected 0 reserved clips, found %', v_reserved;
  end if;

  -- Now the interesting one: the order B stock must be reserved.
  v_s := public.get_product_stats(v_store, '21000000-0000-0000-0000-000000000002');
  if (v_s ->> 'reserved')::int <> 2 then
    raise exception 'CHECK 6: order B holds 2 bags, so reserved should be 2, found %',
      v_s ->> 'reserved';
  end if;

  select quantity into v_onhand from public.inventory
   where store_id = v_store and product_id = '21000000-0000-0000-0000-000000000002' and variant_id is null;
  if v_onhand <> 48 then
    raise exception 'CHECK 6: expected 48 bags on hand, found %', v_onhand;
  end if;

  raise notice 'CHECK 6: bags on hand %, reserved %, so sellable-now is %',
    v_onhand, (v_s ->> 'reserved')::int, v_onhand - (v_s ->> 'reserved')::int;

  -- The product page must expose the sellable figure, not just the physical
  -- count, or a seller can promise stock that is already committed.
  if (v_s ->> 'sellable')::int <> v_onhand - (v_s ->> 'reserved')::int then
    raise exception
      'CHECK 6: sellable is % but on hand % - reserved % = %',
      v_s ->> 'sellable', v_onhand, v_s ->> 'reserved', v_onhand - (v_s ->> 'reserved')::int;
  end if;

  if (v_s ->> 'sellable')::int <> 46 then
    raise exception 'CHECK 6: expected sellable 46, got %', v_s ->> 'sellable';
  end if;

  -- And `available` must stay the physical count, because that is what the
  -- low-stock alert compares against the threshold. Redefining it would change
  -- restock behaviour.
  if (v_s ->> 'available')::int <> 48 then
    raise exception
      'CHECK 6: available must stay the on-hand count (48) for restock alerting, got %',
      v_s ->> 'available';
  end if;

  -- Clips have nothing reserved, so sellable equals on hand there.
  v_s := public.get_product_stats(v_store, '21000000-0000-0000-0000-000000000001');
  if (v_s ->> 'sellable')::int <> (v_s ->> 'available')::int then
    raise exception 'CHECK 6: with nothing reserved, sellable must equal available';
  end if;

  -- A product whose stock is fully committed must report 0 sellable, never a
  -- negative figure a seller could not act on.
  perform public.adjust_stock(v_store, '21000000-0000-0000-0000-000000000002', null, -46, 'adjustment', 'exhaust');
  v_s := public.get_product_stats(v_store, '21000000-0000-0000-0000-000000000002');
  if (v_s ->> 'available')::int <> 2 or (v_s ->> 'sellable')::int <> 0 then
    raise exception
      'CHECK 6: 2 on hand with 2 reserved must give sellable 0, got available % sellable %',
      v_s ->> 'available', v_s ->> 'sellable';
  end if;
end $$;

-- ===========================================================================
-- CHECK 7: AOV
-- ===========================================================================
do $$
declare v_store uuid; v_d jsonb; v_gross numeric; v_orders int; v_expected numeric;
begin
  select store_id into v_store from _a;
  v_d := public.get_dashboard(v_store, current_date);

  select coalesce(sum(total), 0) into v_gross
  from public.orders where store_id = v_store
    and status not in ('cancelled', 'returned', 'failed_delivery');
  select count(*) into v_orders
  from public.orders where store_id = v_store
    and status not in ('cancelled', 'returned', 'failed_delivery');

  v_expected := round(v_gross / v_orders, 2);

  if (v_d ->> 'aov_month')::numeric <> v_expected then
    raise exception 'CHECK 7: aov_month is % but gross % / % orders = %',
      v_d ->> 'aov_month', v_gross, v_orders, v_expected;
  end if;
end $$;

-- ===========================================================================
-- CHECK 9: COD arithmetic
-- ===========================================================================
do $$
declare v_store uuid; v_d jsonb;
begin
  select store_id into v_store from _a;
  v_d := public.get_dashboard(v_store, current_date);

  if (v_d -> 'cod' ->> 'expected')::numeric
     <> (v_d -> 'cod' ->> 'pending_settlement')::numeric + (v_d -> 'cod' ->> 'settled')::numeric then
    raise exception 'CHECK 9: COD expected % != pending % + settled %',
      v_d -> 'cod' ->> 'expected', v_d -> 'cod' ->> 'pending_settlement', v_d -> 'cod' ->> 'settled';
  end if;
end $$;

-- ===========================================================================
-- CHECK 10: the stock ledger reconciles with the balance
-- ===========================================================================
do $$
declare v_store uuid; v_row record;
begin
  select store_id into v_store from _a;

  for v_row in
    select i.product_id, i.quantity,
           coalesce(sum(m.delta), 0) as ledger
    from public.inventory i
    left join public.inventory_movements m
      on m.product_id = i.product_id and m.store_id = i.store_id
    where i.store_id = v_store
    group by i.product_id, i.quantity
  loop
    if v_row.quantity <> v_row.ledger then
      raise exception 'CHECK 10: % balance is % but the ledger sums to %',
        v_row.product_id, v_row.quantity, v_row.ledger;
    end if;
  end loop;
end $$;

reset role;

rollback;

\echo ''
\echo '  All SellFlow financial definition checks passed.'
\echo ''
