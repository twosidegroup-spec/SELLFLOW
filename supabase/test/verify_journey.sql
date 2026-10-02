-- ===========================================================================
-- SellFlow :: the seller's day, end to end
--
-- One seller, one store, one full working day, in the order a seller would
-- actually do it. Every figure asserted is read back through the same
-- aggregate functions the app calls, so this proves the DASHBOARD, ANALYTICS
-- and FINANCE screens show the truth rather than proving the tables are
-- internally tidy.
--
--   product + opening stock
--   customer
--   order  -> confirm -> process -> package -> pack
--   manual shipment with tracking
--   ship -> deliver
--   COD collected, then settled
--   ...and the figures across every screen must reconcile
--
-- Then the failure paths that a real seller hits.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data)
values ('11111111-1111-1111-1111-111111111111', 'day@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

create temporary table _d (org_id uuid primary key, store_id uuid);
insert into _d
select (public.bootstrap_business('Day Traders', 'Main', 'DAY') ->> 'org_id')::uuid, null;
update _d set store_id = (select id from public.stores where org_id = _d.org_id limit 1);

-- ---------------------------------------------------------------------------
-- The catalogue. Three products with deliberately different economics so the
-- three product rankings cannot possibly agree with each other.
--   Cheap  : sells the most units, earns the least
--   Premium: fewest units, most revenue
--   Scarf  : mid volume, fat margin -> wins on profit
-- ---------------------------------------------------------------------------
insert into public.products (id, org_id, name, sku, selling_price, cost_price, low_stock_threshold)
select '11000000-0000-0000-0000-000000000001'::uuid, org_id, 'Cheap Clip', 'C1', 100, 80, 3 from _d
union all
select '11000000-0000-0000-0000-000000000002'::uuid, org_id, 'Premium Bag', 'P1', 2000, 1500, 3 from _d
union all
select '11000000-0000-0000-0000-000000000003'::uuid, org_id, 'Mid Scarf', 'M1', 500, 100, 3 from _d;

insert into public.customers (id, org_id, name, phone, district, thana)
select '12000000-0000-0000-0000-000000000001'::uuid, org_id, 'Nadia Islam', '01811000011', 'Dhaka', 'Dhanmondi' from _d
union all
select '12000000-0000-0000-0000-000000000002'::uuid, org_id, 'Karim Hossain', '01811000022', 'Chattogram', 'Agrabad' from _d;

do $$
declare v record;
begin
  for v in select store_id from _d loop
    perform public.adjust_stock(v.store_id, '11000000-0000-0000-0000-000000000001', null, 100, 'initial', 'opening');
    perform public.adjust_stock(v.store_id, '11000000-0000-0000-0000-000000000002', null, 100, 'initial', 'opening');
    perform public.adjust_stock(v.store_id, '11000000-0000-0000-0000-000000000003', null, 100, 'initial', 'opening');
  end loop;
end $$;

-- ===========================================================================
-- 1. Two orders taken on the same day.
-- ===========================================================================
do $$
declare v_store uuid;
begin
  select store_id into v_store from _d;

  -- Order A: COD, 10 cheap clips + 2 scarves, delivered in full.
  perform public.create_order(
    p_store_id       => v_store,
    p_customer_id    => '12000000-0000-0000-0000-000000000001',
    p_items          => '[{"product_id":"11000000-0000-0000-0000-000000000001","quantity":10},
                         {"product_id":"11000000-0000-0000-0000-000000000003","quantity":2}]'::jsonb,
    p_discount       => 0,
    p_delivery_charge=> 60,
    p_amount_paid    => 0,
    p_is_cod         => true,
    p_notes          => 'Deliver after 6pm',
    p_client_ref     => 'aa000000-0000-0000-0000-000000000001'::uuid,
    p_delivery_name  => 'Nadia Islam',
    p_delivery_phone => '01811000011',
    p_delivery_address => 'House 5, Road 12, Dhanmondi',
    p_delivery_district => 'Dhaka',
    p_delivery_thana => 'Dhanmondi'
  );

  -- Order B: prepaid premium bag, 4 units.
  perform public.create_order(
    p_store_id       => v_store,
    p_customer_id    => '12000000-0000-0000-0000-000000000002',
    p_items          => '[{"product_id":"11000000-0000-0000-0000-000000000002","quantity":4}]'::jsonb,
    p_discount       => 100,
    p_delivery_charge=> 0,
    p_amount_paid    => 0,
    p_payment_method => 'bkash',
    p_client_ref     => 'aa000000-0000-0000-0000-000000000002'::uuid,
    p_delivery_name  => 'Karim Hossain',
    p_delivery_phone => '01811000022',
    p_delivery_address => 'GEC Circle, Agrabad',
    p_delivery_district => 'Chattogram',
    p_delivery_thana => 'Agrabad'
  );
end $$;

-- ===========================================================================
-- 2. Walk order A all the way to delivered
-- ===========================================================================
do $$
declare
  v_order uuid;
  v_ship  public.shipments;
begin
  select id into v_order from public.orders
   where client_ref = 'aa000000-0000-0000-0000-000000000001';

  perform public.set_order_status(v_order, 'confirmed');
  perform public.set_order_status(v_order, 'processing');
  perform public.set_order_status(v_order, 'packaging');
  perform public.set_order_status(v_order, 'packed');

  -- Take the payment the courier collected, in two parts, as often happens.
  perform public.record_payment(v_order, 500, 'cash', null, 'advance',
    'bb000000-0000-0000-0000-000000000001'::uuid);
  perform public.record_payment(v_order, 1560, 'cash', null, 'balance on delivery',
    'bb000000-0000-0000-0000-000000000002'::uuid);

  v_ship := public.register_shipment(
    v_order, 'manual', gen_random_uuid(), null, null,
    'DAY-0001', 'https://track.example/D-0001', null
  );

  perform public.apply_shipment_update(v_ship.id, 'picked', 'Collected', null, 'seller', null, null);
  perform public.apply_shipment_update(v_ship.id, 'in_transit', 'In transit', null, 'seller', null, null);
  perform public.apply_shipment_update(v_ship.id, 'out_for_delivery', 'Out for delivery', null, 'seller', null, null);

  perform public.set_order_status(v_order, 'shipped');
  perform public.set_order_status(v_order, 'on_delivery');
  perform public.set_order_status(v_order, 'delivered');

  perform public.apply_shipment_update(v_ship.id, 'delivered', 'Delivered', null, 'seller', null, null);
end $$;

-- Walk order B to shipped and stop there, so the dashboard has a live backlog.
do $$
declare v_order uuid;
begin
  select id into v_order from public.orders
   where client_ref = 'aa000000-0000-0000-0000-000000000002';

  perform public.record_payment(v_order, 7900, 'bkash', null, 'prepaid in full',
    'bb000000-0000-0000-0000-000000000003'::uuid);

  perform public.set_order_status(v_order, 'confirmed');
  perform public.set_order_status(v_order, 'processing');
  perform public.set_order_status(v_order, 'packaging');
  perform public.set_order_status(v_order, 'packed');
  perform public.set_order_status(v_order, 'shipped');
end $$;

-- ===========================================================================
-- 3. THE DASHBOARD MUST TELL THE TRUTH
-- ===========================================================================
do $$
declare
  v_store uuid;
  v_d jsonb;
  v_f jsonb;
  v_pipeline jsonb;
  v_status public.order_status;
  v_key text;
begin
  select store_id into v_store from _d;
  v_d := public.get_dashboard(v_store, current_date);
  v_f := public.get_finance(v_store, current_date, current_date);

  -- Orders today
  if (v_d -> 'today' ->> 'orders')::int <> 2 then
    raise exception 'DASH: expected 2 orders today, got %', v_d -> 'today' ->> 'orders';
  end if;

  -- Revenue today: order A (10x100 + 2x500 + 60 delivery) = 2060, plus order B 7900.
  if (v_d -> 'today' ->> 'revenue')::numeric <> 9960 then
    raise exception 'DASH: revenue today is %, expected 9960', v_d -> 'today' ->> 'revenue';
  end if;

  -- Delivered sales is the honest measure and must not equal gross sales,
  -- because order B is still in transit.
  if (v_f -> 'revenue' ->> 'gross_sales')::numeric
     - (v_f -> 'revenue' ->> 'delivered_sales')::numeric <= 0 then
    raise exception
      'DASH: delivered sales should be lower than gross while an order is in transit';
  end if;

  if (v_f -> 'revenue' ->> 'delivered_sales')::numeric <> 2060 then
    raise exception
      'DASH: delivered sales is %, expected 2060 (order A only)',
      v_f -> 'revenue' ->> 'delivered_sales';
  end if;

  -- The pipeline breakdown must be present and correctly populated.
  v_pipeline := v_d -> 'pipeline';
  if v_pipeline is null then
    raise exception 'DASH: the dashboard has no pipeline breakdown';
  end if;

  if (v_pipeline ->> 'delivered')::int <> 1 then
    raise exception 'DASH: pipeline says % delivered, expected 1', v_pipeline ->> 'delivered';
  end if;
  if (v_pipeline ->> 'shipped')::int <> 1 then
    raise exception 'DASH: pipeline says % shipped, expected 1', v_pipeline ->> 'shipped';
  end if;

  -- Action queue: order B is out for delivery, so there is real work.
  if (v_d -> 'action' ->> 'out_for_delivery')::int <> 1 then
    raise exception 'DASH: the action queue does not show the parcel out for delivery';
  end if;

  -- Average order value must be revenue over order count, not revenue alone.
  if (v_d ->> 'aov_month')::numeric = 0 then
    raise exception 'DASH: average order value was not computed';
  end if;

  -- -------------------------------------------------------------------------
  -- Pipeline counters must be JSON NUMBERS, not JSON strings.
  --
  -- The flat counters used to be built with `(v_pipeline ->> 'shipped')`, and
  -- `->>` yields TEXT. jsonb_build_object stored that text as a JSON string, and
  -- the client -- which treats any non-number as a missing value -- rendered
  -- eleven zeros on the dashboard while the work queue, built from real
  -- count(*) values in the same payload, showed the truth.
  --
  -- A seller was told every parcel had vanished. The counts were never wrong;
  -- their JSON type was. This asserts the transport contract so it cannot
  -- regress silently.
  -- -------------------------------------------------------------------------
  foreach v_status in array public.dashboard_statuses()
  loop
    -- The flat key is not always the status name plus "_count": the failed
    -- delivery stage is published as failed_count. Derived by name so this
    -- tracks the payload rather than hardcoding eleven strings.
    v_key := case v_status
      when 'failed_delivery' then 'failed_count'
      else v_status::text || '_count'
    end;

    if jsonb_typeof(v_d -> v_key) is distinct from 'number' then
      raise exception
        'DASH: % is JSON type %, expected number. The client reads a non-number as zero.',
        v_key, coalesce(jsonb_typeof(v_d -> v_key), 'missing');
    end if;

    -- And it must agree with the per-status object it was derived from.
    if (v_d ->> v_key)::int is distinct from (v_pipeline ->> v_status::text)::int then
      raise exception
        'DASH: % (%) disagrees with pipeline.% (%) -- expected agreement',
        v_key,
        v_d ->> v_key,
        v_status,
        v_pipeline ->> v_status::text;
    end if;
  end loop;

  -- A real count, not just a well-typed zero.
  if (v_d ->> 'delivered_count')::int <> 1 then
    raise exception
      'DASH: delivered_count is %, expected 1',
      v_d -> 'delivered_count';
  end if;
end $$;

-- ===========================================================================
-- 4. REVENUE IS NOT PROFIT
-- ===========================================================================
do $$
declare
  v_store uuid;
  v_f jsonb;
  v_gross numeric;
  v_cost numeric;
  v_expenses numeric;
  v_net_before numeric;
  v_net_after numeric;
begin
  select store_id into v_store from _d;
  v_f := public.get_finance(v_store, current_date, current_date);

  v_gross    := (v_f -> 'revenue' ->> 'gross_sales')::numeric;
  v_cost     := (v_f -> 'costs' ->> 'product')::numeric;
  v_expenses := (v_f -> 'costs' ->> 'expenses')::numeric;
  v_net_before := (v_f ->> 'net_profit')::numeric;

  -- Every key this test reads must actually exist. Asserting on a NULL compares
  -- to NULL, and `NULL < 0` is NULL, so a wrong key name would let a broken
  -- assertion pass silently. The NOT NULL checks are the guard against that.
  if v_gross is null or v_cost is null or v_net_before is null then
    raise exception 'FINANCE: a required key is missing from get_finance';
  end if;

  if v_gross <> 9960 then
    raise exception 'FINANCE: gross sales is %, expected 9960', v_gross;
  end if;

  -- Cost: 10 x 80 + 2 x 100 + 4 x 1500 = 800 + 200 + 6000 = 7000
  if v_cost <> 7000 then
    raise exception 'FINANCE: product cost is %, expected 7000', v_cost;
  end if;

  -- Net profit = gross - product - courier - other - expenses = 9960 - 7000
  if v_net_before <> 2960 then
    raise exception 'FINANCE: net profit is %, expected 2960 before expenses', v_net_before;
  end if;

  -- The single most important property: revenue and profit are different numbers.
  if v_net_before = v_gross then
    raise exception 'FINANCE BUG: revenue and profit are identical. Cost is being ignored.';
  end if;

  -- Record a real expense and prove net profit moves by exactly that much.
  insert into public.expenses (org_id, store_id, amount, category, description)
  select org_id, store_id, 500, 'packaging', 'Bubble wrap and boxes' from _d;

  v_f := public.get_finance(v_store, current_date, current_date);
  if (v_f -> 'costs' ->> 'expenses')::numeric <> 500 then
    raise exception 'FINANCE: the expense was not counted';
  end if;

  v_net_after := (v_f ->> 'net_profit')::numeric;
  if v_net_after <> v_net_before - 500 then
    raise exception
      'FINANCE: net profit moved from % to %; a 500 expense should have moved it by 500',
      v_net_before, v_net_after;
  end if;

  -- COD collected must be tracked apart from cash actually paid in.
  if (v_f -> 'cod' ->> 'expected')::numeric <> 2060 then
    raise exception 'FINANCE: expected COD is %, expected 2060', v_f -> 'cod' ->> 'expected';
  end if;
  if (v_f -> 'payments' ->> 'paid')::numeric <> 9960 then
    raise exception 'FINANCE: total paid is %, expected 9960', v_f -> 'payments' ->> 'paid';
  end if;

  raise notice 'finance -- gross % | product cost % | net before expenses % | net after % | COD expected %',
    v_gross, v_cost, v_net_before, v_net_after, v_f -> 'cod' ->> 'expected';
end $$;

-- ===========================================================================
-- 5. DELIVERED IS NOT SETTLED
-- ===========================================================================
do $$
declare
  v_order uuid;
  v_ship  public.shipments;
begin
  select id into v_order from public.orders
   where client_ref = 'aa000000-0000-0000-0000-000000000001';

  -- Delivered, so the cash is COLLECTED by the courier but not yet paid out.
  if (select state from public.settlements where order_id = v_order) <> 'collected' then
    raise exception 'COD: a delivered order should show the cash as collected';
  end if;

  if (select cod_settled from public.orders where id = v_order) then
    raise exception 'COD BUG: a delivered order was marked as cash-settled';
  end if;

  select id into v_ship from public.shipments where order_id = v_order limit 1;
  perform public.record_settlement(v_order, 'settled', 2060, 'bKash payout', 'PAYOUT-1');

  if (select cod_settled from public.orders where id = v_order) is not true then
    raise exception 'COD: recording the payout did not mark the order as settled';
  end if;
end $$;

-- ===========================================================================
-- 6. THE THREE PRODUCT RANKINGS MUST NOT COLLAPSE INTO ONE
-- ===========================================================================
do $$
declare
  v_store uuid;
  v_perf jsonb;
  v_top_qty   text;
  v_top_rev   text;
  v_top_profit text;
begin
  select store_id into v_store from _d;
  v_perf := public.get_product_performance(v_store, current_date - 30, current_date + 1);

  -- get_product_performance returns three RANKED LISTS, not three single
  -- winners. A single "best product" figure is exactly the collapse this
  -- requirement forbids.
  if jsonb_typeof(v_perf -> 'by_quantity') <> 'array' then
    raise exception 'RANKING: by_quantity is not a ranked list';
  end if;
  if jsonb_typeof(v_perf -> 'by_revenue') <> 'array' then
    raise exception 'RANKING: by_revenue is not a ranked list';
  end if;
  if jsonb_typeof(v_perf -> 'by_profit') <> 'array' then
    raise exception 'RANKING: by_profit is not a ranked list';
  end if;

  v_top_qty    := v_perf -> 'by_quantity' -> 0 ->> 'name';
  v_top_rev    := v_perf -> 'by_revenue'  -> 0 ->> 'name';
  v_top_profit := v_perf -> 'by_profit'   -> 0 ->> 'name';

  if v_top_qty is null or v_top_rev is null or v_top_profit is null then
    raise exception 'RANKING: one of the three rankings is empty';
  end if;

  -- Cheap Clip: 10 units, 1000 revenue, 200 profit
  -- Premium Bag: 4 units, 7900 revenue, 1900 profit
  -- Mid Scarf:   2 units, 1000 revenue, 800 profit
  if v_top_qty <> 'Cheap Clip' then
    raise exception 'RANKING: most units should be Cheap Clip, got %', v_top_qty;
  end if;
  if v_top_rev <> 'Premium Bag' then
    raise exception 'RANKING: most revenue should be Premium Bag, got %', v_top_rev;
  end if;
  if v_top_profit <> 'Premium Bag' then
    raise exception 'RANKING: most profit should be Premium Bag, got %', v_top_profit;
  end if;

  -- The whole point: the volume leader is NOT the revenue leader.
  if v_top_qty = v_top_rev then
    raise exception 'RANKING BUG: the quantity and revenue rankings collapsed into one metric';
  end if;

  -- Each ranking must actually be sorted by its own metric.
  if (v_perf -> 'by_quantity' -> 0 ->> 'units')::int
     < (v_perf -> 'by_quantity' -> 1 ->> 'units')::int then
    raise exception 'RANKING: by_quantity is not sorted by units';
  end if;
  if (v_perf -> 'by_revenue' -> 0 ->> 'revenue')::numeric
     < (v_perf -> 'by_revenue' -> 1 ->> 'revenue')::numeric then
    raise exception 'RANKING: by_revenue is not sorted by revenue';
  end if;
  if (v_perf -> 'by_profit' -> 0 ->> 'profit')::numeric
     < (v_perf -> 'by_profit' -> 1 ->> 'profit')::numeric then
    raise exception 'RANKING: by_profit is not sorted by profit';
  end if;

  raise notice 'rankings -- units: % | revenue: % | profit: %', v_top_qty, v_top_rev, v_top_profit;
end $$;

-- ===========================================================================
-- 7. PRODUCT STATS: available, reserved, sold
-- ===========================================================================
do $$
declare
  v_store uuid;
  v_s jsonb;
begin
  select store_id into v_store from _d;
  v_s := public.get_product_stats(v_store, '11000000-0000-0000-0000-000000000002');

  -- Premium Bag: 100 opening - 4 sold = 96 on the shelf. Order B is shipped,
  -- so nothing about it is "reserved" -- reserved means confirmed-but-unshipped.
  if (v_s ->> 'available')::int <> 96 then
    raise exception 'PRODUCT: available is %, expected 96', v_s ->> 'available';
  end if;

  if (v_s ->> 'sold_units')::int <> 4 then
    raise exception 'PRODUCT: sold units is %, expected 4', v_s ->> 'sold_units';
  end if;

  -- Product revenue is the sum of ITEM LINES, which is before the order-level
  -- discount. Order B was 8000 of bags less a 100 order discount, so the
  -- product shows 8000 while the order total is 7900.
  --
  -- This is deliberate and internally consistent -- profit uses the same line
  -- totals, so revenue minus profit is still exactly the product cost -- but it
  -- means the product ranking will not sum to gross sales when an order
  -- discount was applied. Pinned here so the behaviour cannot drift unnoticed.
  if (v_s ->> 'revenue')::numeric <> 8000 then
    raise exception 'PRODUCT: revenue is %, expected 8000 (line totals, before order discount)',
      v_s ->> 'revenue';
  end if;

  -- Profit = line revenue - line cost = 8000 - (4 x 1500) = 2000
  if (v_s ->> 'profit')::numeric <> 2000 then
    raise exception 'PRODUCT: profit is %, expected 2000', v_s ->> 'profit';
  end if;

  -- Revenue minus profit must equal the product cost exactly, for every product.
  if (v_s ->> 'revenue')::numeric - (v_s ->> 'profit')::numeric
     <> (v_s ->> 'cost_price')::numeric * (v_s ->> 'sold_units')::int then
    raise exception 'PRODUCT: revenue - profit does not equal the product cost';
  end if;

  raise notice 'premium bag -- available % | reserved % | sold % | revenue % | profit %',
    v_s ->> 'available', v_s ->> 'reserved', v_s ->> 'sold_units', v_s ->> 'revenue', v_s ->> 'profit';
end $$;

-- A newly confirmed order must show up as RESERVED, which is the number a
-- seller needs before promising the last one.
do $$
declare
  v_store uuid; v_s jsonb; v_order uuid;
begin
  select store_id into v_store from _d;

  v_order := public.create_order(
    p_store_id    => v_store,
    p_customer_id => '12000000-0000-0000-0000-000000000001',
    p_items       => '[{"product_id":"11000000-0000-0000-0000-000000000001","quantity":5}]'::jsonb,
    p_client_ref  => 'aa000000-0000-0000-0000-000000000003'::uuid
  );

  perform public.set_order_status(v_order, 'confirmed');

  v_s := public.get_product_stats(v_store, '11000000-0000-0000-0000-000000000001');
  if (v_s ->> 'reserved')::int <> 5 then
    raise exception 'PRODUCT: reserved is %, expected 5 on a confirmed order', v_s ->> 'reserved';
  end if;
  if (v_s ->> 'available')::int <> 85 then
    raise exception 'PRODUCT: available is %, expected 85', v_s ->> 'available';
  end if;
end $$;

-- ===========================================================================
-- 8. CUSTOMER HISTORY
-- ===========================================================================
do $$
declare
  v_s jsonb;
  v_id uuid;
begin
  -- This customer now has two orders: the delivered 2060 one, plus the 500
  -- order created in the product-stats section which is confirmed but unpaid.
  v_s := public.get_customer_stats('12000000-0000-0000-0000-000000000001');

  if (v_s ->> 'order_count')::int <> 2 then
    raise exception 'CUSTOMER: order count is %, expected 2', v_s ->> 'order_count';
  end if;

  if (v_s ->> 'total_spent')::numeric <> 2560 then
    raise exception 'CUSTOMER: total spent is %, expected 2560 (2060 + 500)', v_s ->> 'total_spent';
  end if;

  -- The second order is unpaid, so the customer owes money. This is the figure
  -- a seller rings up before a repeat order.
  if (v_s ->> 'outstanding')::numeric <> 500 then
    raise exception
      'CUSTOMER: outstanding is %, expected 500 on the unpaid order', v_s ->> 'outstanding';
  end if;

  if (v_s ->> 'last_order_at') is null then
    raise exception 'CUSTOMER: last order date was not recorded';
  end if;

  -- The other customer's single delivered order, fully paid.
  v_s := public.get_customer_stats('12000000-0000-0000-0000-000000000002');
  if (v_s ->> 'order_count')::int <> 1 then
    raise exception 'CUSTOMER: second customer order count is %, expected 1', v_s ->> 'order_count';
  end if;
  if (v_s ->> 'outstanding')::numeric <> 0 then
    raise exception 'CUSTOMER: second customer should owe nothing';
  end if;

  select id into v_id from public.orders
   where client_ref = 'aa000000-0000-0000-0000-000000000002';
  if v_id is null then
    raise exception 'CUSTOMER: the second customer has no order history';
  end if;
end $$;

-- ===========================================================================
-- 9. THE FAILURE PATHS A REAL SELLER HITS
-- ===========================================================================
do $$
declare
  v_store uuid; v_threw boolean; v_before int; v_after int; v_order uuid;
  v_a public.shipments; v_b public.shipments;
begin
  select store_id into v_store from _d;

  -- (a) Not enough stock
  v_threw := false;
  begin
    perform public.create_order(
      p_store_id => v_store, p_customer_id => null,
      p_items => '[{"product_id":"11000000-0000-0000-0000-000000000002","quantity":99999}]'::jsonb,
      p_client_ref => 'aa000000-0000-0000-0000-0000000000ff'::uuid
    );
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'FAILURE: overselling was accepted'; end if;

  -- (b) Duplicate tap on create
  v_order := public.create_order(
    p_store_id => v_store, p_customer_id => null,
    p_items => '[{"product_id":"11000000-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
    p_client_ref => 'aa000000-0000-0000-0000-0000000000ab'::uuid,
    p_delivery_name => 'Walk-in Buyer', p_delivery_phone => '01700000000',
    p_delivery_address => 'Somewhere 1', p_delivery_district => 'Dhaka', p_delivery_thana => 'Uttara'
  );

  -- The identical tap again, with a stripped payload, which is what an
  -- interrupted request that already reached the server looks like.
  perform public.create_order(
    p_store_id => v_store, p_customer_id => null, p_items => '[]'::jsonb,
    p_client_ref => 'aa000000-0000-0000-0000-0000000000ab'::uuid
  );

  if (select count(*) from public.orders where client_ref = 'aa000000-0000-0000-0000-0000000000ab') <> 1 then
    raise exception 'FAILURE: a double tap created two orders';
  end if;

  -- (c) Illegal transition
  v_threw := false;
  begin
    perform public.set_order_status(v_order, 'delivered');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'FAILURE: an illegal transition was accepted'; end if;

  -- (d) Duplicate payment. The order total is 500; one 250 payment is recorded
  -- and the retry with the SAME idempotency key must not add a second one.
  perform public.record_payment(v_order, 250, 'cash', null, 'part',
    'bb000000-0000-0000-0000-0000000000ab'::uuid);
  perform public.record_payment(v_order, 250, 'cash', null, 'part',
    'bb000000-0000-0000-0000-0000000000ab'::uuid);

  if (select amount_paid from public.orders where id = v_order) <> 250 then
    raise exception
      'FAILURE: a retried 250 payment left amount_paid at %, expected 250 (recorded once)',
      (select amount_paid from public.orders where id = v_order);
  end if;

  if (select count(*) from public.payments where order_id = v_order) <> 1 then
    raise exception 'FAILURE: a retried payment created more than one payment row';
  end if;

  -- A genuinely different payment still works: idempotency must not become a
  -- blanket refusal to take money.
  perform public.record_payment(v_order, 250, 'cash', null, 'balance',
    'bb000000-0000-0000-0000-0000000000ac'::uuid);
  if (select amount_paid from public.orders where id = v_order) <> 500 then
    raise exception 'FAILURE: a second, distinct payment was not applied';
  end if;

  -- (e) Duplicate shipment. The order is walked to packed first, because
  -- dispatch is blocked until the goods are actually ready to go.
  perform public.set_order_status(v_order, 'confirmed');
  perform public.set_order_status(v_order, 'processing');
  perform public.set_order_status(v_order, 'packaging');
  perform public.set_order_status(v_order, 'packed');

  v_a := public.register_shipment(v_order, 'manual', 'cc000000-0000-0000-0000-000000000001'::uuid,
                                  null, null, 'T-1', null, null);
  v_b := public.register_shipment(v_order, 'manual', 'cc000000-0000-0000-0000-000000000001'::uuid,
                                  null, null, 'T-1', null, null);
  if v_a.id <> v_b.id then
    raise exception 'FAILURE: a double tap created two parcels';
  end if;

  if (select count(*) from public.shipments where order_id = v_order) <> 1 then
    raise exception 'FAILURE: more than one shipment exists for the order';
  end if;

  -- (f) Delivery failure is not a cancellation, and does not restock
  select quantity into v_before from public.inventory
   where store_id = v_store and product_id = '11000000-0000-0000-0000-000000000003';

  perform public.fail_shipment(v_a.id, 'Customer unavailable', 'failed', 'Phone unreachable');
  perform public.set_order_status(v_order, 'shipped');
  perform public.set_order_status(v_order, 'on_delivery');
  perform public.set_order_status(v_order, 'failed_delivery');

  select quantity into v_after from public.inventory
   where store_id = v_store and product_id = '11000000-0000-0000-0000-000000000003';

  if v_before <> v_after then
    raise exception
      'FAILURE BUG: a failed delivery restocked (% -> %). The goods are still with the courier.',
      v_before, v_after;
  end if;

  if (select status from public.orders where id = v_order) <> 'failed_delivery' then
    raise exception 'FAILURE: a failed delivery was recorded as cancelled';
  end if;

  -- (g) A return DOES restock
  perform public.set_order_status(v_order, 'returned');
  select quantity into v_after from public.inventory
   where store_id = v_store and product_id = '11000000-0000-0000-0000-000000000003';

  if v_after <> v_before + 1 then
    raise exception 'FAILURE: returning the order did not restock (% -> %)', v_before, v_after;
  end if;
end $$;

reset role;

rollback;

\echo ''
\echo '  The full seller journey passed, including every failure path.'
\echo ''
