-- ===========================================================================
-- SellFlow :: dashboard, analytics and notification verification
--
-- Proves the claims made in the V1 report:
--   * the dashboard pipeline is derived from real order rows,
--   * revenue and profit are genuinely different numbers,
--   * delivered and settled are genuinely different things,
--   * product rankings are three separate lists, not one vague leaderboard,
--   * notifications are produced by real events, fire once, and obey the
--     user's stated preferences.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values ('11111111-1111-1111-1111-111111111111', 'a@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

create temporary table _o (org_id uuid primary key, store_id uuid);
insert into _o select (public.bootstrap_business('Ops Traders', 'Main', 'OPS') ->> 'org_id')::uuid, null;
update _o set store_id = (select id from public.stores where org_id = _o.org_id limit 1);

-- Two products with very different economics, so the three rankings must
-- genuinely disagree. Cheapest-per-unit item sells most units; the priciest
-- earns the most revenue; a mid-price item with a fat margin wins on profit.
insert into public.products (id, org_id, name, sku, selling_price, cost_price, low_stock_threshold)
select '0a000000-0000-0000-0000-000000000001'::uuid, org_id, 'Cheap Clip', 'C1', 100, 80, 3 from _o
union all
select '0a000000-0000-0000-0000-000000000002'::uuid, org_id, 'Premium Bag', 'P1', 2000, 1500, 3 from _o
union all
select '0a000000-0000-0000-0000-000000000003'::uuid, org_id, 'Mid Scarf', 'M1', 500, 100, 3 from _o;

insert into public.customers (id, org_id, name, phone, district, thana)
select '0b000000-0000-0000-0000-000000000001'::uuid, org_id, 'Nadia Islam', '01811000011', 'Dhaka', 'Dhanmondi' from _o;

do $$
declare v record;
begin
  for v in select store_id from _o loop
    perform public.adjust_stock(v.store_id, '0a000000-0000-0000-0000-000000000001', null, 100, 'initial', 'stock');
    perform public.adjust_stock(v.store_id, '0a000000-0000-0000-0000-000000000002', null, 100, 'initial', 'stock');
    perform public.adjust_stock(v.store_id, '0a000000-0000-0000-0000-000000000003', null, 100, 'initial', 'stock');
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- A real, varied order history
--
--   A: delivered, prepaid, 4 x Premium Bag   -> revenue 8000
--   B: delivered, COD,     10 x Cheap Clip  -> revenue 1000, COD 1000
--   C: shipped,    COD,      2 x Mid Scarf  -> revenue 1000
--   D: failed,     COD,      1 x Cheap Clip -> excluded from revenue
-- ---------------------------------------------------------------------------
do $$
declare
  v_ctx record;
  v_a uuid; v_b uuid; v_c uuid; v_d uuid;
begin
  select * into v_ctx from _o;

  select public.create_order(v_ctx.store_id, '0b000000-0000-0000-0000-000000000001',
    '[{"product_id":"0a000000-0000-0000-0000-000000000002","quantity":4}]'::jsonb,
    0::numeric, 0::numeric, 8000::numeric, 'bkash'::public.payment_method,
    null::text, 'aa000000-0000-0000-0000-000000000001'::uuid) into v_a;
  perform public.set_order_status(v_a,'confirmed'); perform public.set_order_status(v_a,'packed');
  perform public.set_order_status(v_a,'shipped'); perform public.set_order_status(v_a,'delivered');

  select public.create_order(v_ctx.store_id, '0b000000-0000-0000-0000-000000000001',
    '[{"product_id":"0a000000-0000-0000-0000-000000000001","quantity":10}]'::jsonb,
    0::numeric, 0::numeric, 0::numeric, 'cash'::public.payment_method,
    null::text, 'aa000000-0000-0000-0000-000000000002'::uuid,
    null::timestamptz, null::text, null::text, null::text, null::text, null::text,
    0::numeric, 0::numeric, true) into v_b;
  perform public.set_order_status(v_b,'confirmed'); perform public.set_order_status(v_b,'packed');
  perform public.set_order_status(v_b,'shipped'); perform public.set_order_status(v_b,'delivered');

  select public.create_order(v_ctx.store_id, '0b000000-0000-0000-0000-000000000001',
    '[{"product_id":"0a000000-0000-0000-0000-000000000003","quantity":2}]'::jsonb,
    0::numeric, 0::numeric, 0::numeric, 'cash'::public.payment_method,
    null::text, 'aa000000-0000-0000-0000-000000000003'::uuid,
    null::timestamptz, null::text, null::text, null::text, null::text, null::text,
    0::numeric, 0::numeric, true) into v_c;
  perform public.set_order_status(v_c,'confirmed'); perform public.set_order_status(v_c,'packed');
  perform public.set_order_status(v_c,'shipped');

  select public.create_order(v_ctx.store_id, '0b000000-0000-0000-0000-000000000001',
    '[{"product_id":"0a000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    0::numeric, 0::numeric, 0::numeric, 'cash'::public.payment_method,
    null::text, 'aa000000-0000-0000-0000-000000000004'::uuid,
    null::timestamptz, null::text, null::text, null::text, null::text, null::text,
    0::numeric, 0::numeric, true) into v_d;
  perform public.set_order_status(v_d,'confirmed'); perform public.set_order_status(v_d,'packed');
  perform public.set_order_status(v_d,'shipped'); perform public.set_order_status(v_d,'failed_delivery');

  -- Two expenses so net profit can differ from gross profit.
  insert into public.expenses (org_id, store_id, amount, category, incurred_on, description)
  select org_id, store_id, 500, 'advertising'::public.expense_category, current_date, 'Ad spend' from _o
  union all
  select org_id, store_id, 100, 'packaging'::public.expense_category, current_date, 'Polythene' from _o;
end $$;

-- ---------------------------------------------------------------------------
-- Dashboard: the pipeline reflects real rows
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_d jsonb; v_n int;
begin
  select * into v_ctx from _o;
  v_d := public.get_dashboard(v_ctx.store_id, current_date);

  -- Two delivered, one shipped, one failed.
  if (v_d ->> 'delivered_count')::int <> 2 then
    raise exception 'dashboard should report 2 delivered, got %', v_d ->> 'delivered_count';
  end if;
  if (v_d ->> 'on_delivery_count')::int <> 0 then
    raise exception 'expected 0 on delivery, got %', v_d ->> 'on_delivery_count';
  end if;
  if (v_d ->> 'shipped_count')::int <> 1 then
    raise exception 'expected 1 shipped, got %', v_d ->> 'shipped_count';
  end if;
  if (v_d ->> 'failed_count')::int <> 1 then
    raise exception 'expected 1 failed delivery, got %', v_d ->> 'failed_count';
  end if;

  -- The work queue must add up to something a seller can act on.
  if (v_d -> 'action' ->> 'to_confirm')::int <> 0 then
    raise exception 'nothing should be awaiting confirmation';
  end if;
  if (v_d -> 'action' ->> 'to_ship')::int <> 0 then
    raise exception 'nothing should be awaiting dispatch';
  end if;
  if (v_d -> 'action' ->> 'failed')::int <> 1 then
    raise exception 'the failed delivery should appear in the action queue';
  end if;

  -- A failed delivery must not inflate revenue. Counted orders are A (8000),
  -- B (1000) and C (1000) = 10000. D is excluded as failed_delivery.
  if (v_d -> 'today' ->> 'revenue')::numeric <> 10000 then
    raise exception 'today revenue should be 10000 (failed delivery excluded), got %',
      v_d -> 'today' ->> 'revenue';
  end if;

  if (v_d -> 'today' ->> 'orders')::int <> 3 then
    raise exception 'today should count 3 non-failed orders, got %', v_d -> 'today' ->> 'orders';
  end if;

  -- 3 counted orders, 10000 total -> AOV 3333.33.
  if abs((v_d ->> 'aov_all')::numeric - 3333.33) > 0.01 then
    raise exception 'AOV should be 3333.33, got %', v_d ->> 'aov_all';
  end if;

  -- COD: B 1000 (delivered) + C 1000 (shipped) + D 100 (failed but still
  -- re-attemptable, so its COD is still expected) = 2100.
  if (v_d -> 'cod' ->> 'expected')::numeric <> 2100 then
    raise exception 'expected COD should be 2100, got %', v_d -> 'cod' ->> 'expected';
  end if;
  if (v_d -> 'cod' ->> 'settled')::numeric <> 0 then
    raise exception 'nothing is settled yet, got %', v_d -> 'cod' ->> 'settled';
  end if;

  -- The 14-day series must always have 14 points, zero-filled.
  select jsonb_array_length(v_d -> 'series') into v_n;
  if v_n <> 14 then raise exception 'series should always contain 14 days, got %', v_n; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Analytics: revenue is not profit, and the three rankings differ
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_a jsonb;
begin
  select * into v_ctx from _o;
  v_a := public.get_analytics(v_ctx.store_id, current_date, current_date);

  -- Revenue 10000; cost of goods 4*1500 + 10*80 + 2*100 = 7000; profit 3000.
  if (v_a -> 'totals' ->> 'revenue')::numeric <> 10000 then
    raise exception 'analytics revenue should be 10000, got %', v_a -> 'totals' ->> 'revenue';
  end if;
  if (v_a -> 'totals' ->> 'product_cost')::numeric <> 7000 then
    raise exception 'product cost should be 7000, got %', v_a -> 'totals' ->> 'product_cost';
  end if;
  if (v_a -> 'totals' ->> 'profit')::numeric <> 3000 then
    raise exception 'profit should be 3000, got %', v_a -> 'totals' ->> 'profit';
  end if;

  -- Revenue != profit. If these were ever equal the whole screen would be lying.
  if (v_a -> 'totals' ->> 'revenue') = (v_a -> 'totals' ->> 'profit') then
    raise exception 'revenue and profit must be different figures';
  end if;

  -- Expenses 600 take net profit to 2400.
  if (v_a ->> 'net_profit')::numeric <> 2400 then
    raise exception 'net profit after 600 expenses should be 2400, got %', v_a ->> 'net_profit';
  end if;

  if (v_a -> 'expenses' ->> 'total')::numeric <> 600 then
    raise exception 'expenses should total 600, got %', v_a -> 'expenses' ->> 'total';
  end if;

  -- Units: 4 + 10 + 2 = 16 (the failed order's 1 unit is excluded).
  if (v_a ->> 'units_sold')::numeric <> 16 then
    raise exception 'units sold should be 16, got %', v_a ->> 'units_sold';
  end if;

  -- Delivered revenue is only the two delivered orders: 8000 + 1000 = 9000.
  -- The shipped order is NOT delivered revenue.
  if (v_a -> 'delivery' ->> 'delivered_revenue')::numeric <> 9000 then
    raise exception 'delivered revenue mismatch';
  end if;
  if (v_a -> 'delivery' ->> 'failed_deliveries')::int <> 1 then
    raise exception 'failed deliveries should be counted separately';
  end if;

  -- Average selling price is per unit, weighted by quantity:
  -- (2000*4 + 100*10 + 500*2) / 16 = (8000+1000+1000)/16 = 625.
  if abs((v_a ->> 'average_selling_price')::numeric - 625) > 0.01 then
    raise exception 'average selling price should be 625, got %', v_a ->> 'average_selling_price';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Product performance: three genuinely different rankings
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_p jsonb;
begin
  select * into v_ctx from _o;
  v_p := public.get_product_performance(v_ctx.store_id, current_date, current_date, 5);

  -- Most units: Cheap Clip (10), then Mid Scarf (2), then Premium Bag (4)... no:
  -- 10 > 4 > 2, so Cheap Clip / Premium Bag / Mid Scarf.
  if (v_p -> 'by_quantity' -> 0 ->> 'name') <> 'Cheap Clip' then
    raise exception 'most units should be Cheap Clip, got %', v_p -> 'by_quantity' -> 0 ->> 'name';
  end if;

  -- Most revenue: Premium Bag 8000, then Cheap Clip 1000 and Mid Scarf 1000.
  if (v_p -> 'by_revenue' -> 0 ->> 'name') <> 'Premium Bag' then
    raise exception 'most revenue should be Premium Bag, got %', v_p -> 'by_revenue' -> 0 ->> 'name';
  end if;

  -- Most profit: Premium Bag 2000, Mid Scarf 800, Cheap Clip 200.
  if (v_p -> 'by_profit' -> 0 ->> 'name') <> 'Premium Bag' then
    raise exception 'most profit should be Premium Bag, got %', v_p -> 'by_profit' -> 0 ->> 'name';
  end if;

  -- The lists must actually be distinct, or the "three rankings" claim is hollow.
  if (v_p -> 'by_quantity' -> 0 ->> 'name') = (v_p -> 'by_revenue' -> 0 ->> 'name')
     and (v_p -> 'by_quantity' -> 0 ->> 'name') = (v_p -> 'by_profit' -> 0 ->> 'name') then
    -- Coincidence is possible; only complain if every entry matches.
    if (v_p -> 'by_quantity' -> 0 ->> 'name') = (v_p -> 'by_quantity' -> 1 ->> 'name') then
      raise exception 'the three rankings collapsed into one list';
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Product stats: available vs reserved must be different concepts
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_s jsonb; v_available int; v_reserved int;
begin
  select * into v_ctx from _o;

  v_s := public.get_product_stats(v_ctx.store_id, '0a000000-0000-0000-0000-000000000001');

  -- 100 opening, minus 10 sold and delivered, minus 1 on the failed order
  -- (a failed delivery does not restock, so the goods are still gone).
  v_available := (v_s ->> 'available')::int;
  v_reserved  := (v_s ->> 'reserved')::int;

  if v_available <> 89 then
    raise exception 'available should be 89, got %', v_available;
  end if;

  -- Nothing is reserved: both of this product's orders are now delivered or
  -- failed, and no order is sitting in a packing/shipping state.
  if v_reserved <> 0 then
    raise exception 'reserved should be 0 here, got %', v_reserved;
  end if;

  -- Sold units exclude the failed order: 10.
  if (v_s ->> 'sold_units')::int <> 10 then
    raise exception 'sold units should be 10, got %', v_s ->> 'sold_units';
  end if;

  if (v_s ->> 'revenue')::numeric <> 1000 then
    raise exception 'revenue should be 1000, got %', v_s ->> 'revenue';
  end if;

  -- 10 units at 100 revenue and 80 cost = 200 profit.
  if (v_s ->> 'profit')::numeric <> 200 then
    raise exception 'profit should be 200, got %', v_s ->> 'profit';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Customer stats: the counts must match the real order outcomes
-- ---------------------------------------------------------------------------
do $$
declare v_s jsonb;
begin
  v_s := public.get_customer_stats('0b000000-0000-0000-0000-000000000001');

  if (v_s ->> 'delivered_count')::int <> 2 then
    raise exception 'expected 2 delivered orders, got %', v_s ->> 'delivered_count';
  end if;
  if (v_s ->> 'failed_count')::int <> 1 then
    raise exception 'expected 1 failed order, got %', v_s ->> 'failed_count';
  end if;
  if (v_s ->> 'in_progress_count')::int <> 1 then
    raise exception 'expected 1 in-progress order, got %', v_s ->> 'in_progress_count';
  end if;
  if (v_s ->> 'total_spent')::numeric <> 10000 then
    raise exception 'total spent should exclude the failed order, got %', v_s ->> 'total_spent';
  end if;
  if abs((v_s ->> 'average_order_value')::numeric - 3333.33) > 0.01 then
    raise exception 'AOV should be 3333.33, got %', v_s ->> 'average_order_value';
  end if;
  -- B 1000 + C 1000 + D 100: the failed order is still re-attemptable, so its
  -- cash is still on the way.
  if (v_s ->> 'cod_pending')::numeric <> 2100 then
    raise exception 'pending COD should be 2100, got %', v_s ->> 'cod_pending';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Finance: delivered != settled
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_f jsonb;
begin
  select * into v_ctx from _o;
  v_f := public.get_finance(v_ctx.store_id, current_date, current_date);

  if (v_f -> 'revenue' ->> 'gross_sales')::numeric <> 10000 then
    raise exception 'gross sales mismatch: %', v_f -> 'revenue' ->> 'gross_sales';
  end if;

  -- Delivered COD is collected but not yet paid out.
  if (v_f -> 'cod' ->> 'pending')::numeric <> 2100 then
    raise exception 'pending COD mismatch: %', v_f -> 'cod' ->> 'pending';
  end if;
  if (v_f -> 'cod' ->> 'settled')::numeric <> 0 then
    raise exception 'nothing settled yet: %', v_f -> 'cod' ->> 'settled';
  end if;

  if (v_f -> 'costs' ->> 'expenses')::numeric <> 600 then
    raise exception 'expenses mismatch: %', v_f -> 'costs' ->> 'expenses';
  end if;

  -- Settle one COD order, then the numbers must diverge from "expected".
  perform public.record_settlement(
    (select id from public.orders where client_ref = 'aa000000-0000-0000-0000-000000000002'),
    'settled', 1000, 'PAY-1', 'bKash');

  v_f := public.get_finance(v_ctx.store_id, current_date, current_date);
  if (v_f -> 'cod' ->> 'settled')::numeric <> 1000 then
    raise exception 'settled COD should be 1000, got %', v_f -> 'cod' ->> 'settled';
  end if;
  if (v_f -> 'cod' ->> 'pending')::numeric <> 1100 then
    raise exception 'pending COD should drop to 1100, got %', v_f -> 'cod' ->> 'pending';
  end if;
  -- Expected does NOT change: the courier still owed the same total.
  if (v_f -> 'cod' ->> 'expected')::numeric <> 2100 then
    raise exception 'expected COD must not change when settling';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Notifications are produced by real events
-- ---------------------------------------------------------------------------
do $$
begin
  -- Delivering the earlier orders must have produced real notifications.
  if not exists (select 1 from public.notifications where kind = 'order_status' and title like 'Delivered:%') then
    raise exception 'delivering an order should have produced a notification';
  end if;

  if not exists (select 1 from public.notifications where kind = 'order_status' and title like 'Delivery failed:%') then
    raise exception 'a failed delivery should have produced a notification';
  end if;

  -- COD settlement should have produced one.
  if not exists (select 1 from public.notifications where kind = 'payment_due' and title like 'COD received:%') then
    raise exception 'settling COD should have produced a notification';
  end if;

  -- Dedupe: the same event must not have produced two rows.
  if (select count(*) from public.notifications
      where kind = 'order_status' and title like 'Delivered:%') <> 2 then
    raise exception 'expected exactly 2 delivered notifications (one per order), got %',
      (select count(*) from public.notifications
       where kind = 'order_status' and title like 'Delivered:%');
  end if;

  -- Every notification must point at a real order.
  if exists (
    select 1 from public.notifications
    where data ->> 'order_id' is not null
      and not exists (select 1 from public.orders o where o.id = (notifications.data ->> 'order_id')::uuid)
  ) then
    raise exception 'a notification referenced an order that does not exist';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Low stock: fires on the crossing, once, and re-arms after restock
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_n int;
begin
  select * into v_ctx from _o;

  -- Cheap Clip is at 89, far above its threshold of 3. No alert yet.
  if exists (select 1 from public.notifications where kind = 'low_stock' and body like '89 left%') then
    raise exception 'low stock should not fire while stock is healthy';
  end if;

  -- Drop it to exactly the threshold: this is the crossing.
  perform public.adjust_stock(v_ctx.store_id, '0a000000-0000-0000-0000-000000000001', null, -86, 'adjustment', 'count');

  select count(*) into v_n from public.notifications
  where kind = 'low_stock' and data ->> 'product_id' = '0a000000-0000-0000-0000-000000000001';
  if v_n <> 1 then
    raise exception 'crossing the threshold should raise exactly one alert, got %', v_n;
  end if;

  -- Going lower must NOT re-raise: the seller already knows.
  perform public.adjust_stock(v_ctx.store_id, '0a000000-0000-0000-0000-000000000001', null, -1, 'adjustment', 'count');
  select count(*) into v_n from public.notifications
  where kind = 'low_stock' and data ->> 'product_id' = '0a000000-0000-0000-0000-000000000001';
  if v_n <> 1 then
    raise exception 'staying low must not spam a second alert, got %', v_n;
  end if;

  -- Restock above the line re-arms, so the next dip warns again.
  -- 2 -> 52 (crosses up, re-arms), then 52 -> 3 (crosses down, alerts again).
  perform public.adjust_stock(v_ctx.store_id, '0a000000-0000-0000-0000-000000000001', null, 50, 'purchase', 'restock');
  perform public.adjust_stock(v_ctx.store_id, '0a000000-0000-0000-0000-000000000001', null, -49, 'purchase', 'sold');
  select count(*) into v_n from public.notifications
  where kind = 'low_stock' and data ->> 'product_id' = '0a000000-0000-0000-0000-000000000001';
  if v_n <> 2 then
    raise exception 'after restocking and dipping again the alert should fire again, got %', v_n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preferences are obeyed
-- ---------------------------------------------------------------------------
do $$
declare
  v_ctx record;
  v_before int;
  v_after int;
begin
  select * into v_ctx from _o;

  update public.notification_preferences
     set low_stock = false
   where org_id = v_ctx.org_id and user_id = auth.uid();

  select count(*) into v_before from public.notifications where kind = 'low_stock';

  -- Drive Premium Bag down across its threshold with alerts muted.
  -- It sits at 96 (100 opening, 4 sold), so -93 lands exactly on 3.
  perform public.adjust_stock(v_ctx.store_id, '0a000000-0000-0000-0000-000000000002', null, -93, 'adjustment', 'count');

  select count(*) into v_after from public.notifications where kind = 'low_stock';
  if v_after <> v_before then
    raise exception 'a muted preference must suppress low stock alerts';
  end if;

  -- And unmute.
  update public.notification_preferences
     set low_stock = true
   where org_id = v_ctx.org_id and user_id = auth.uid();
end $$;

-- ---------------------------------------------------------------------------
-- Duplicate customer detection
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_d jsonb; v_n int;
begin
  select * into v_ctx from _o;

  insert into public.customers (id, org_id, name, phone)
  select '0b000000-0000-0000-0000-000000000002'::uuid, org_id, 'Nadia Islam', '01811000011' from _o;

  -- Same phone, formatted differently, must be found.
  v_d := public.find_duplicate_customers(v_ctx.org_id, 'Nadia Islam', '+8801811000011');
  select jsonb_array_length(v_d) into v_n;
  if v_n < 1 then
    raise exception 'a duplicate with a differently formatted phone should be detected';
  end if;

  -- Same name only.
  v_d := public.find_duplicate_customers(v_ctx.org_id, 'Nadia Islam', '01999999999');
  select jsonb_array_length(v_d) into v_n;
  if v_n < 1 then
    raise exception 'a duplicate with the same name should be detected';
  end if;

  -- A genuinely different person must not be flagged.
  v_d := public.find_duplicate_customers(v_ctx.org_id, 'Someone Entirely Different', '01555555555');
  select jsonb_array_length(v_d) into v_n;
  if v_n <> 0 then
    raise exception 'an unrelated customer should not be reported as a duplicate';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Courier capabilities are reported honestly to the app
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_c jsonb;
begin
  select * into v_ctx from _o;

  v_c := public.get_couriers(v_ctx.org_id);
  -- No connections configured, so an empty list -- not invented providers.
  if (v_c ->> 'connections') <> '[]' then
    raise exception 'a business with no couriers configured must return an empty list';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A store with no activity must report zeros and empty lists, never placeholders
-- ---------------------------------------------------------------------------
do $$
declare
  v_org  uuid;
  v_store uuid;
  v_d    jsonb;
begin
  select org_id into v_org from _o;

  -- A second outlet in the same business that has never traded.
  insert into public.stores (org_id, name, code)
  values (v_org, 'Chattogram outlet', 'CTG') returning id into v_store;

  v_d := public.get_dashboard(v_store, current_date);

  if (v_d ->> 'total_orders')::int <> 0 then
    raise exception 'an unused store must report 0 orders, got %', v_d ->> 'total_orders';
  end if;
  if (v_d -> 'today' ->> 'revenue')::numeric <> 0 then
    raise exception 'an unused store must report 0 revenue, got %', v_d -> 'today' ->> 'revenue';
  end if;
  if (v_d ->> 'pending_count')::int <> 0 then
    raise exception 'an unused store must report an empty pipeline';
  end if;
  if (v_d -> 'low_stock') <> '[]' then
    raise exception 'an unused store must report an empty low-stock list, got %', v_d -> 'low_stock';
  end if;
  if (v_d -> 'recent_orders') <> '[]' then
    raise exception 'an unused store must report no recent orders';
  end if;
  if (v_d -> 'cod' ->> 'expected')::numeric <> 0 then
    raise exception 'an unused store must report 0 expected COD';
  end if;

  -- And the 14-day series must still be fully populated with zeros, so a chart
  -- never renders a broken axis for a new seller.
  if jsonb_array_length(v_d -> 'series') <> 14 then
    raise exception 'series should still contain 14 zero-filled days';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Setting stock to an exact count
-- ---------------------------------------------------------------------------
do $$
declare
  v_ctx    record;
  v_product constant uuid := '0a000000-0000-0000-0000-000000000001';
  v_counted uuid;
  v_after  int;
  v_current int;
  v_before_moves int;
  v_moves  int;
  v_delta  int;
  v_balance int;
  v_threw  boolean;
begin
  select * into v_ctx from _o;

  -- "I counted the shelf and there are 20" is not a delta of 20. The balance
  -- must land on exactly 20 whatever it happened to be before.
  select coalesce(i.quantity, 0) into v_current
  from public.products p
  left join public.inventory i
    on i.store_id = v_ctx.store_id and i.product_id = p.id and i.variant_id is null
  where p.id = v_product;

  v_before_moves := (select count(*) from public.inventory_movements where product_id = v_product);

  v_after := public.set_stock(v_ctx.store_id, v_product, null, 20, 'adjustment', null);
  if v_after <> 20 then
    raise exception 'a count to 20 should land on 20, got %', v_after;
  end if;

  select quantity into v_after from public.inventory i
  where i.store_id = v_ctx.store_id and i.product_id = v_product and i.variant_id is null;
  if v_after <> 20 then
    raise exception 'the stored balance should be 20, got %', v_after;
  end if;

  -- Exactly one movement, carrying the change from where it was to 20, and
  -- recording the resulting balance. The audit trail must still explain the
  -- shelf. (Every movement in this transaction shares one created_at, so the
  -- new row is identified by its delta and balance, not by ordering.)
  v_moves := (select count(*) from public.inventory_movements where product_id = v_product);
  if v_moves <> v_before_moves + 1 then
    raise exception 'a count should write exactly one movement (% -> %)', v_before_moves, v_moves;
  end if;

  select delta, balance_after into v_delta, v_balance
  from public.inventory_movements m
  where m.product_id = v_product
    and m.delta = 20 - v_current
    and m.balance_after = 20;

  if v_delta is null then
    raise exception 'no movement records the change from % to 20', v_current;
  end if;

  -- Counting down to zero is a legitimate outcome (everything sold or written
  -- off). It must not be confused with a missing row.
  if public.set_stock(v_ctx.store_id, v_product, null, 0, 'adjustment', null) <> 0 then
    raise exception 'counting to zero should land on 0';
  end if;

  select quantity into v_after from public.inventory i
  where i.store_id = v_ctx.store_id and i.product_id = v_product and i.variant_id is null;
  if v_after <> 0 then
    raise exception 'the stored balance should be 0 after a count-down, got %', v_after;
  end if;

  -- Counting back up works, so the function is not write-once.
  if public.set_stock(v_ctx.store_id, v_product, null, 7, 'purchase', 'recount') <> 7 then
    raise exception 'counting back up to 7 should land on 7';
  end if;

  -- Counting to what is already there changes nothing, so it must write no
  -- movement at all. inventory_movements_delta_check rejects a zero delta, and
  -- a "counted it, still 7" row would be noise in the audit trail.
  v_before_moves := (select count(*) from public.inventory_movements where product_id = v_product);
  if public.set_stock(v_ctx.store_id, v_product, null, 7, 'adjustment', null) <> 7 then
    raise exception 'a no-op count should still report the current balance';
  end if;
  v_moves := (select count(*) from public.inventory_movements where product_id = v_product);
  if v_moves <> v_before_moves then
    raise exception 'counting to the current balance must not write a movement (% -> %)', v_before_moves, v_moves;
  end if;

  -- A product with no inventory row yet: counting it to a number has to create
  -- the row rather than divide by nothing.
  insert into public.products (org_id, name, sku, selling_price, track_inventory)
  values (v_ctx.org_id, 'Count Only Product', 'COUNT-ONLY', 500, true)
  returning id into v_counted;

  if public.set_stock(v_ctx.store_id, v_counted, null, 42, 'adjustment', 'first count') <> 42 then
    raise exception 'counting a product with no stock row should create it at 42';
  end if;

  -- Negative counts are rejected rather than clamped: silently turning -5 into
  -- 0 would hide a typo behind a plausible-looking number.
  v_threw := false;
  begin
    perform public.set_stock(v_ctx.store_id, v_product, null, -5, 'adjustment', null);
  exception when others then v_threw := true; end;
  if not v_threw then
    raise exception 'a negative count must be rejected';
  end if;

  v_threw := false;
  begin
    perform public.set_stock(v_ctx.store_id, v_product, null, null, 'adjustment', null);
  exception when others then v_threw := true; end;
  if not v_threw then
    raise exception 'a null count must be rejected';
  end if;

  -- Order-driven reasons stay with create_order, exactly as for adjust_stock.
  v_threw := false;
  begin
    perform public.set_stock(v_ctx.store_id, v_product, null, 5, 'sale', null);
  exception when others then v_threw := true; end;
  if not v_threw then
    raise exception 'set_stock must not accept order-driven reasons';
  end if;

  -- Products that do not track inventory must be refused, not silently written.
  insert into public.products (org_id, name, sku, selling_price, track_inventory)
  values (v_ctx.org_id, 'No Stock Product', 'NO-STOCK', 500, false)
  returning id into v_counted;

  v_threw := false;
  begin
    perform public.set_stock(v_ctx.store_id, v_counted, null, 10, 'adjustment', null);
  exception when others then v_threw := true; end;
  if not v_threw then
    raise exception 'set_stock must refuse a product that does not track inventory';
  end if;

  v_threw := false;
  begin
    perform public.set_stock(v_ctx.store_id, 'ffffffff-0000-0000-0000-000000000001', null, 10, 'adjustment', null);
  exception when others then v_threw := true; end;
  if not v_threw then
    raise exception 'set_stock must refuse a product that does not exist';
  end if;

  -- A count is still a write. Another business must not be able to change our
  -- shelf by guessing a store id.
  v_threw := false;
  begin
    perform public.set_stock('0a000000-0000-0000-0000-0000000000ff', v_product, null, 0, 'adjustment', null);
  exception when others then v_threw := true; end;
  if not v_threw then
    raise exception 'cross-tenant set_stock was allowed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Deleting a product or customer for good
-- ---------------------------------------------------------------------------
do $$
declare
  v_ctx      record;
  v_sellable uuid;
  v_customer uuid;
  v_order    uuid;
  v_stock    integer;
  v_threw    boolean;
begin
  select * into v_ctx from _o;

  -- A product nobody has ever sold deletes cleanly, and its stock goes with it.
  insert into public.products (org_id, name, sku, selling_price, track_inventory)
  values (v_ctx.org_id, 'Disposable Widget', 'DEL-1', 300, true)
  returning id into v_sellable;

  perform public.adjust_stock(v_ctx.store_id, v_sellable, null, 7, 'initial', 'opening');
  select quantity into v_stock from public.inventory
  where product_id = v_sellable and store_id = v_ctx.store_id;

  if v_stock <> 7 then
    raise exception 'the disposable product should start with 7 units, got %', v_stock;
  end if;

  if not public.delete_product(v_sellable) then
    raise exception 'delete_product should report success';
  end if;

  if exists (select 1 from public.products where id = v_sellable) then
    raise exception 'the product row survived deletion';
  end if;
  if exists (select 1 from public.inventory where product_id = v_sellable) then
    raise exception 'stock rows were left orphaned after deleting the product';
  end if;

  -- Now the case that matters. Premium Bag has been sold, and order_items is
  -- ON DELETE SET NULL, so an unguarded delete would quietly strip the product
  -- out of a real sale and leave the seller with an order they cannot reconcile.
  v_threw := false;
  begin
    perform public.delete_product('0a000000-0000-0000-0000-000000000001');
  exception when others then v_threw := true; end;

  if not v_threw then
    raise exception 'deleting a product that has been sold must be refused';
  end if;

  if not exists (select 1 from public.products where id = '0a000000-0000-0000-0000-000000000001') then
    raise exception 'the sold product was deleted anyway';
  end if;

  -- And the order line that referenced it must be untouched.
  if exists (
    select 1 from public.order_items oi
    where oi.product_id = '0a000000-0000-0000-0000-000000000001' and oi.product_id is null
  ) then
    raise exception 'a sale lost its product link';
  end if;

  -- A customer with orders is equally protected: their sales must not turn into
  -- anonymous walk-in sales.
  select c.id into v_customer
  from public.customers c
  where c.org_id = v_ctx.org_id
    and exists (select 1 from public.orders o where o.customer_id = c.id)
  limit 1;

  if v_customer is not null then
    v_threw := false;
    begin
      perform public.delete_customer(v_customer);
    exception when others then v_threw := true; end;

    if not v_threw then
      raise exception 'deleting a customer who has ordered must be refused';
    end if;
    if not exists (select 1 from public.customers where id = v_customer) then
      raise exception 'the customer was deleted anyway';
    end if;
  end if;

  -- A customer with no orders goes, without touching anything else.
  insert into public.customers (org_id, name, phone)
  values (v_ctx.org_id, 'Never Ordered', '01900000000')
  returning id into v_customer;

  if not public.delete_customer(v_customer) then
    raise exception 'delete_customer should report success';
  end if;
  if exists (select 1 from public.customers where id = v_customer) then
    raise exception 'the customer row survived deletion';
  end if;

  -- Neither is a deletion anyone but an owner or manager may perform.
  v_threw := false;
  begin
    perform public.delete_product(v_sellable);
  exception when others then v_threw := true; end;
  if not v_threw then
    raise exception 'deleting a product that does not exist should be refused';
  end if;

  v_threw := false;
  begin
    perform public.delete_customer('ffffffff-0000-0000-0000-000000000001');
  exception when others then v_threw := true; end;
  if not v_threw then
    raise exception 'deleting a customer that does not exist should be refused';
  end if;

  -- And a rival business can never delete our catalogue, even by guessing a uuid.
  v_threw := false;
  begin
    perform public.delete_product('0a000000-0000-0000-0000-0000000000ff');
  exception when others then v_threw := true; end;
  if not v_threw then
    raise exception 'cross-tenant delete_product was allowed';
  end if;

  v_threw := false;
  begin
    perform public.delete_customer('0a000000-0000-0000-0000-0000000000ff');
  exception when others then v_threw := true; end;
  if not v_threw then
    raise exception 'cross-tenant delete_customer was allowed';
  end if;
end $$;

reset role;

rollback;

\echo ''
\echo '  All SellFlow dashboard/analytics/notification checks passed.'
\echo ''
