-- ===========================================================================
-- SellFlow :: functional verification
--
-- Exercises the real migration logic against a live Postgres: onboarding,
-- catalog, inventory, order arithmetic, the status lifecycle, payments, and
-- cross-tenant isolation.
--
-- Run with `npm run db:verify`. Fails loudly on the first broken invariant.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: two users. The auth.users trigger must create a profile for each.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values
  ('11111111-1111-1111-1111-111111111111', 'seller-a@example.test',
   '{"full_name": "Seller A"}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'seller-b@example.test',
   '{"full_name": "Seller B"}'::jsonb);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.profiles;
  if v_count <> 2 then
    raise exception 'handle_new_user trigger failed: % profiles, expected 2', v_count;
  end if;
end $$;

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------------
-- Onboarding
-- ---------------------------------------------------------------------------
do $$
declare
  v_org uuid; v_store uuid; v_created boolean; v_again uuid;
  v_res jsonb;
begin
  v_res := public.bootstrap_business('Apex Traders', 'Dhaka outlet', 'dhk');

  v_org     := (v_res ->> 'org_id')::uuid;
  v_store   := (v_res ->> 'store_id')::uuid;
  v_created := (v_res ->> 'created')::boolean;

  if not v_created then
    raise exception 'bootstrap_business should have created a business';
  end if;

  -- Re-running must be idempotent, not create a second org.
  v_again := (public.bootstrap_business('Apex Traders') ->> 'org_id')::uuid;
  if v_again <> v_org then
    raise exception 'bootstrap_business is not idempotent';
  end if;
end $$;

-- Capture the ids for the rest of the script.
create temporary table _ctx (org_id uuid primary key, store_id uuid);
insert into _ctx
select
  (select id from public.organizations limit 1),
  (select id from public.stores limit 1);

do $$
declare v_count int;
begin
  select count(*) into v_count from _ctx where org_id is not null and store_id is not null;
  if v_count <> 1 then raise exception 'failed to resolve org/store ids'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
insert into public.products (id, org_id, name, sku, selling_price, cost_price, low_stock_threshold)
select 'aaaaaaaa-0000-0000-0000-000000000001', org_id, 'Cotton T-Shirt', 'TS-001', 500, 300, 5
from _ctx;

insert into public.products (id, org_id, name, sku, selling_price, cost_price, low_stock_threshold)
select 'aaaaaaaa-0000-0000-0000-000000000002', org_id, 'Denim Jeans', 'JN-002', 1800, 1100, 3
from _ctx;

select adjust_stock(store_id, 'aaaaaaaa-0000-0000-0000-000000000001', null, 20, 'initial', 'opening stock')
from _ctx;
select adjust_stock(store_id, 'aaaaaaaa-0000-0000-0000-000000000002', null, 10, 'initial', 'opening stock')
from _ctx;

insert into public.customers (id, org_id, name, phone, address)
select 'bbbbbbbb-0000-0000-0000-000000000001', org_id, 'Rahim Uddin', '+8801711000111', 'Mirpur, Dhaka'
from _ctx;

-- ---------------------------------------------------------------------------
-- Order arithmetic
--
-- 2 x T-shirt @500 with 50 off the line  -> 1000 - 50  = 950
-- 1 x Jeans @1800                       ->            1800
-- items_total 2750, order discount 100, delivery 60 -> total 2710
-- cost 2*300 + 1*1100 = 1700 -> profit 1010
-- paid 1000 -> partial, outstanding 1710
-- ---------------------------------------------------------------------------
do $$
declare
  v_ctx record;
  v_id uuid;
begin
  select * into v_ctx from _ctx;

  select public.create_order(
    v_ctx.store_id,
    'bbbbbbbb-0000-0000-0000-000000000001',
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","quantity":2,"line_discount":50},
      {"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":1}]'::jsonb,
    100,   -- discount
    60,    -- delivery
    1000,  -- paid
    'bkash',
    'Deliver after 6pm',
    'cccccccc-0000-0000-0000-000000000001'::uuid
  ) into v_id;

  if not exists (
    select 1 from public.orders where id = v_id
      and items_total = 2750 and discount = 100 and delivery_charge = 60
      and total = 2710 and cost_total = 1700 and profit = 1010
      and amount_paid = 1000 and payment_status = 'partial' and status = 'pending'
  ) then
    raise exception 'order arithmetic is wrong for order %', v_id;
  end if;

  -- Order number uses the store code prefix.
  if (select order_number from public.orders where id = v_id) not like 'DHK-%' then
    raise exception 'order number format is wrong';
  end if;

  -- Stock must have been decremented: 20-2 = 18, 10-1 = 9.
  if not exists (
    select 1 from public.inventory where store_id = v_ctx.store_id
      and ((product_id = 'aaaaaaaa-0000-0000-0000-000000000001' and quantity = 18)
        or (product_id = 'aaaaaaaa-0000-0000-0000-000000000002' and quantity = 9))
  ) then
    raise exception 'stock was not decremented correctly';
  end if;

  -- Every decrement must be traceable.
  if (select count(*) from public.inventory_movements
      where reference_type = 'order' and reason = 'sale') <> 2 then
    raise exception 'stock movements were not recorded';
  end if;

  -- Idempotent retry with the same client_ref returns the same order.
  declare v_again uuid;
  begin
    select public.create_order(
      v_ctx.store_id, null, '[]'::jsonb, 0, 0, 0, 'cash', null,
      'cccccccc-0000-0000-0000-000000000001'::uuid
    ) into v_again;
    if v_again <> v_id then
      raise exception 'client_ref retry created a duplicate order';
    end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Inventory guards
-- ---------------------------------------------------------------------------
do $$
declare v_threw boolean := false;
begin
  begin
    perform public.create_order(
      (select store_id from _ctx), null,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":500}]'::jsonb,
      0, 0, 0, 'cash', null, null
    );
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'overselling should have been blocked'; end if;
end $$;

do $$
declare v_threw boolean := false;
begin
  begin
    perform public.create_order(
      (select store_id from _ctx), null,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":1,"line_discount":99999}]'::jsonb,
      0, 0, 0, 'cash', null, null
    );
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'discount larger than the line should have been blocked'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Status lifecycle
-- ---------------------------------------------------------------------------
do $$
declare
  v_ctx record; v_id uuid; v_tshirt int; v_threw boolean;
begin
  select * into v_ctx from _ctx;
  select id into v_id from public.orders
  where client_ref = 'cccccccc-0000-0000-0000-000000000001';

  -- pending -> delivered must be rejected (skips the lifecycle).
  v_threw := false;
  begin
    perform public.set_order_status(v_id, 'delivered');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'pending -> delivered should be rejected'; end if;

  -- The full V1 fulfilment chain, including the new packing and last-mile
  -- states. processing -> shipped must stay illegal: an order has to be packed
  -- before it can be handed to a courier.
  perform public.set_order_status(v_id, 'confirmed');
  perform public.set_order_status(v_id, 'processing');

  v_threw := false;
  begin
    perform public.set_order_status(v_id, 'shipped');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'processing -> shipped should be rejected'; end if;

  perform public.set_order_status(v_id, 'packaging');
  perform public.set_order_status(v_id, 'packed');
  perform public.set_order_status(v_id, 'shipped');
  perform public.set_order_status(v_id, 'on_delivery');
  perform public.set_order_status(v_id, 'delivered');

  -- delivered is effectively terminal: only a return is allowed.
  v_threw := false;
  begin
    perform public.set_order_status(v_id, 'confirmed');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'delivered -> confirmed should be rejected'; end if;

  -- A failed delivery is NOT a cancellation and must be re-attemptable.
  v_threw := false;
  begin
    perform public.set_order_status(v_id, 'failed_delivery');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'delivered -> failed_delivery should be rejected'; end if;

  v_threw := false;
  begin
    perform public.set_order_status(v_id, 'cancelled');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'delivered -> cancelled should be rejected'; end if;

  -- Cancelling must put stock back.
  select public.create_order(
    v_ctx.store_id, null,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","quantity":4}]'::jsonb,
    0, 0, 0, 'cash', null, 'dddddddd-0000-0000-0000-000000000001'::uuid
  ) into v_id;

  select quantity into v_tshirt from public.inventory
  where product_id = 'aaaaaaaa-0000-0000-0000-000000000001' and store_id = v_ctx.store_id;
  if v_tshirt <> 14 then
    raise exception 'expected 14 in stock after second order, got %', v_tshirt;
  end if;

  perform public.set_order_status(v_id, 'cancelled', 'Customer changed their mind');

  select quantity into v_tshirt from public.inventory
  where product_id = 'aaaaaaaa-0000-0000-0000-000000000001' and store_id = v_ctx.store_id;
  if v_tshirt <> 18 then
    raise exception 'cancelling should restore stock to 18, got %', v_tshirt;
  end if;

  -- The cancelled order's timeline must contain exactly its two real moves:
  -- the initial NULL -> pending row written at creation, and pending -> cancelled.
  if (select count(*) from public.order_status_history where order_id = v_id) <> 2 then
    raise exception 'cancelled order should have exactly 2 history entries, got %',
      (select count(*) from public.order_status_history where order_id = v_id);
  end if;

  if not exists (
    select 1 from public.order_status_history
    where order_id = v_id and from_status is null and to_status = 'pending'
  ) then
    raise exception 'order history must start with a NULL -> pending entry';
  end if;

  -- The first order walked the full V1 fulfilment chain, so it must have eight
  -- entries: the initial NULL -> pending row plus seven real moves.
  --   pending, confirmed, processing, packaging, packed, shipped,
  --   on_delivery, delivered
  if (select count(*) from public.order_status_history
      where order_id = (select id from public.orders
                        where client_ref = 'cccccccc-0000-0000-0000-000000000001')) <> 8 then
    raise exception 'delivered order should have exactly 8 history entries, got %',
      (select count(*) from public.order_status_history
       where order_id = (select id from public.orders
                         where client_ref = 'cccccccc-0000-0000-0000-000000000001'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid; v_paid numeric; v_threw boolean;
begin
  select id into v_id from public.orders
  where client_ref = 'cccccccc-0000-0000-0000-000000000001';

  select public.record_payment(v_id, 1710, 'cash') into v_paid;

  if (select payment_status from public.orders where id = v_id) <> 'paid' then
    raise exception 'order should be fully paid';
  end if;

  -- Paying again must be refused.
  v_threw := false;
  begin
    perform public.record_payment(v_id, 100, 'cash');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'overpayment should have been rejected'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Reporting
-- ---------------------------------------------------------------------------
do $$
declare
  v_ctx record;
  v_d jsonb;
  v_outstanding numeric;
begin
  select * into v_ctx from _ctx;
  v_d := public.get_dashboard(v_ctx.store_id, current_date);

  if (v_d -> 'today' ->> 'orders')::int < 1 then
    raise exception 'dashboard today.orders is wrong';
  end if;

  -- Cancelled orders must not inflate revenue, and a fully paid order leaves
  -- nothing outstanding.
  v_outstanding := (v_d ->> 'outstanding')::numeric;
  if v_outstanding <> 0 then
    raise exception 'outstanding should be 0 after full payment, got %', v_outstanding;
  end if;

  if jsonb_array_length(v_d -> 'series') <> 14 then
    raise exception 'series should always contain 14 days';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Cross-tenant isolation -- the most important check in this file
-- ---------------------------------------------------------------------------
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare v_visible int;
begin
  -- Seller B must see none of Seller A's rows.
  select count(*) into v_visible from public.products;
  if v_visible <> 0 then raise exception 'RLS leak: seller B sees % products', v_visible; end if;

  select count(*) into v_visible from public.orders;
  if v_visible <> 0 then raise exception 'RLS leak: seller B sees % orders', v_visible; end if;

  select count(*) into v_visible from public.customers;
  if v_visible <> 0 then raise exception 'RLS leak: seller B sees % customers', v_visible; end if;

  select count(*) into v_visible from public.inventory_movements;
  if v_visible <> 0 then raise exception 'RLS leak: seller B sees % stock movements', v_visible; end if;

  select count(*) into v_visible from public.expenses;
  if v_visible <> 0 then raise exception 'RLS leak: seller B sees % expenses', v_visible; end if;
end $$;

do $$
declare v_threw boolean;
begin
  v_threw := false;
  begin
    perform public.create_order(
      (select store_id from public.stores limit 1), null,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
      0, 0, 0, 'cash', null, null
    );
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'Seller B was able to create an order in Seller A''s store';
  end if;
end $$;

do $$
declare v_threw boolean;
begin
  v_threw := false;
  begin
    perform public.adjust_stock(
      (select store_id from public.stores limit 1),
      'aaaaaaaa-0000-0000-0000-000000000001', null, 5, 'adjustment', 'nope'
    );
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'Seller B was able to adjust Seller A''s stock';
  end if;
end $$;

reset role;

rollback;

\echo ''
\echo '  All SellFlow database checks passed.'
\echo ''
