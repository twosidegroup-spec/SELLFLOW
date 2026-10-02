-- ===========================================================================
-- SellFlow :: courier, tracking and COD verification
--
-- Focused on the guarantees that are easy to get subtly wrong:
--   * a double tap on "Send to courier" can never create two shipments,
--   * a shipment is never reported as created before the courier confirms,
--   * a failed delivery does not silently return goods to stock,
--   * COD "delivered" and COD "settled" stay distinct,
--   * one tenant cannot see or touch another tenant's shipments.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values
  ('11111111-1111-1111-1111-111111111111', 'seller-a@example.test', '{}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'seller-b@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- Two statements on purpose: a subquery in the target list of the same
-- statement would use the pre-statement snapshot and not see the store that
-- bootstrap_business is about to insert.
create temporary table _c (org_id uuid primary key, store_id uuid);

insert into _c
select (public.bootstrap_business('Courier Traders', 'Main', 'CT') ->> 'org_id')::uuid, null;

update _c set store_id = (select id from public.stores where org_id = _c.org_id limit 1);

do $$
declare v_n int;
begin
  select count(*) into v_n from _c where org_id is not null and store_id is not null;
  if v_n <> 1 then raise exception 'could not resolve org/store'; end if;
end $$;

-- A product with stock and a customer with a full delivery address.
insert into public.products (id, org_id, name, sku, selling_price, cost_price, low_stock_threshold)
select 'd0000000-0000-0000-0000-000000000001', org_id, 'Saree', 'SR-1', 1500, 900, 2
from _c;

select adjust_stock(store_id, 'd0000000-0000-0000-0000-000000000001', null, 25, 'initial', 'opening')
from _c;

insert into public.customers
  (id, org_id, name, phone, address, district, thana)
select 'e0000000-0000-0000-0000-000000000001', org_id,
       'Karim Mia', '01711000099', 'House 7, Road 3, Mirpur', 'Dhaka', 'Mirpur'
from _c;

-- ---------------------------------------------------------------------------
-- Courier capability is declared honestly
-- ---------------------------------------------------------------------------
do $$
begin
  if not public.courier_supports_api('pathao') then
    raise exception 'Pathao API is documented and must be advertised as supported';
  end if;

  -- REDX has no publicly documented merchant API. If this ever changes it must
  -- be a deliberate code change, not an accident.
  if public.courier_supports_api('redx') then
    raise exception 'REDX must not be advertised as API-integrable';
  end if;

  if public.courier_supports_api('manual') then
    raise exception 'Manual entry is not an API integration';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Dispatch is blocked until the order is actually packed
-- ---------------------------------------------------------------------------
do $$
declare
  v_ctx record;
  v_id uuid;
  v_threw boolean;
begin
  select * into v_ctx from _c;

  select public.create_order(
    v_ctx.store_id, 'e0000000-0000-0000-0000-000000000001',
    '[{"product_id":"d0000000-0000-0000-0000-000000000001","quantity":2}]'::jsonb,
    0::numeric, 60::numeric, 0::numeric, 'cash'::public.payment_method,
    null::text, 'f0000000-0000-0000-0000-000000000001'::uuid,
    null::timestamptz,
    null::text, null::text, null::text, null::text, null::text,
    0::numeric, 0::numeric, true
  ) into v_id;

  -- Not packed yet.
  if public.order_dispatch_blocker(v_id) is distinct from 'order_not_packed' then
    raise exception 'an unpacked order should not be dispatchable';
  end if;

  -- A pending order must not be able to create a shipment.
  v_threw := false;
  begin
    perform public.register_shipment(
      v_id, 'pathao',
      null::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid,
      100::numeric, 60::text, null::text, null::jsonb
    );
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'dispatching an unpacked order should be refused'; end if;

  -- Take it to packed.
  perform public.set_order_status(v_id, 'confirmed');
  perform public.set_order_status(v_id, 'packed');

  if public.order_dispatch_blocker(v_id) is not null then
    raise exception 'a packed order with a full address should be dispatchable, blocked by %',
      public.order_dispatch_blocker(v_id);
  end if;

  -- The address snapshot must have been inherited from the customer.
  if not exists (
    select 1 from public.orders
    where id = v_id and delivery_district = 'Dhaka' and delivery_thana = 'Mirpur'
      and delivery_name = 'Karim Mia'
  ) then
    raise exception 'delivery address snapshot was not captured from the customer';
  end if;

  -- COD must equal the unpaid balance, not the order total.
  if not exists (
    select 1 from public.orders
    where id = v_id and is_cod and cod_amount = total and amount_paid = 0
  ) then
    raise exception 'COD amount should equal the full payable total for an unpaid order';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Idempotency: the double-tap guarantee
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_a public.shipments;
  v_b public.shipments;
  v_c public.shipments;
  v_count int;
  v_key_a uuid := 'b0000000-0000-0000-0000-000000000001';
  v_key_b uuid := 'b0000000-0000-0000-0000-000000000002';
begin
  select id into v_id from public.orders
  where client_ref = 'f0000000-0000-0000-0000-000000000001';

  -- First dispatch.
  v_a := public.register_shipment(v_id, 'pathao', v_key_a,
                                   null::uuid, null::numeric, null::text, null::text, null::jsonb);

  -- Two rapid taps with DIFFERENT idempotency keys, which is exactly what
  -- happens when a seller double-taps and the app generates a fresh key.
  v_b := public.register_shipment(v_id, 'pathao', v_key_b,
                                   null::uuid, null::numeric, null::text, null::text, null::jsonb);
  v_c := public.register_shipment(v_id, 'pathao', v_key_b,
                                   null::uuid, null::numeric, null::text, null::text, null::jsonb);

  if v_b.id <> v_a.id then
    raise exception 'a second tap created a second shipment';
  end if;
  if v_c.id <> v_a.id then
    raise exception 'a retry with the same key did not return the original shipment';
  end if;

  select count(*) into v_count from public.shipments where order_id = v_id;
  if v_count <> 1 then
    raise exception 'expected exactly 1 shipment after repeated dispatch, got %', v_count;
  end if;

  -- A shipment must NOT claim to be created before the courier confirms.
  if v_a.state <> 'requested' then
    raise exception 'a shipment must start in requested state, got %', v_a.state;
  end if;

  if v_a.confirmed_at is not null then
    raise exception 'confirmed_at must be null before the courier responds';
  end if;

  if exists (select 1 from public.orders where id = v_id and shipment_status = 'created') then
    raise exception 'the order must not show "created" before the courier confirms';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Confirmation requires a real tracking id
-- ---------------------------------------------------------------------------
do $$
declare
  v_ship public.shipments;
  v_threw boolean;
begin
  select * into v_ship from public.shipments limit 1;

  v_threw := false;
  begin
    perform public.confirm_shipment(v_ship.id, null, null, 60, 'order.created');
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'confirming without a tracking id must be refused';
  end if;

  if not exists (select 1 from public.shipments where id = v_ship.id and state = 'requested') then
    raise exception 'a refused confirmation must leave the shipment in requested state';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Real confirmation updates shipment, order and timeline
-- ---------------------------------------------------------------------------
do $$
declare
  v_ship public.shipments;
  v_conf public.shipments;
begin
  select * into v_ship from public.shipments limit 1;

  v_conf := public.confirm_shipment(
    v_ship.id, 'PT1234567890',
    'https://courier.pathao.com/order/PT1234567890',
    60, 'order.created', 'Order created'
  );

  if v_conf.state <> 'created' then
    raise exception 'a confirmed shipment should be in created state, got %', v_conf.state;
  end if;

  if not exists (
    select 1 from public.orders
    where tracking_id = 'PT1234567890' and shipment_status = 'created'
      and courier_cost = 60 and shipped_at is not null
  ) then
    raise exception 'the order was not updated with the confirmed tracking details';
  end if;

  if not exists (
    select 1 from public.shipment_events
    where shipment_id = v_ship.id and source = 'courier'
  ) then
    raise exception 'the tracking timeline was not recorded';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Replaying the same webhook must not duplicate the timeline
-- ---------------------------------------------------------------------------
do $$
declare
  v_ship uuid;
  v_before int;
  v_after int;
begin
  select id into v_ship from public.shipments limit 1;

  select count(*) into v_before from public.shipment_events where shipment_id = v_ship;

  perform public.apply_shipment_update(v_ship, 'picked', 'Picked up', 'order.picked', 'courier',
                                      '2024-05-01T10:00:00Z');
  perform public.apply_shipment_update(v_ship, 'picked', 'Picked up', 'order.picked', 'courier',
                                      '2024-05-01T10:00:00Z');
  perform public.apply_shipment_update(v_ship, 'picked', 'Picked up', 'order.picked', 'courier',
                                      '2024-05-01T10:00:00Z');

  select count(*) into v_after from public.shipment_events where shipment_id = v_ship;
  if v_after <> v_before + 1 then
    raise exception 'a replayed webhook should be recorded once, expected % got %',
      v_before + 1, v_after;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A late/out-of-order event must not un-deliver a parcel
-- ---------------------------------------------------------------------------
do $$
declare
  v_ship uuid;
begin
  select id into v_ship from public.shipments limit 1;

  perform public.apply_shipment_update(v_ship, 'delivered', 'Delivered', 'order.delivered', 'courier');
  perform public.apply_shipment_update(v_ship, 'picked', 'Picked up', 'order.picked', 'courier');

  if not exists (select 1 from public.shipments where id = v_ship and state = 'delivered') then
    raise exception 'a stale "picked" event must not overwrite a delivered shipment';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- COD: delivered is not settled
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_settled boolean;
  v_threw boolean;
begin
  select id into v_id from public.orders
  where client_ref = 'f0000000-0000-0000-0000-000000000001';

  -- Delivering must move the settlement to 'collected', not 'settled'.
  if not exists (
    select 1 from public.settlements
    where order_id = v_id and state = 'collected' and settled_amount = 0
  ) then
    raise exception 'delivery should mark COD collected, not settled';
  end if;

  select cod_settled into v_settled from public.orders where id = v_id;
  if v_settled then
    raise exception 'cod_settled must stay false until money actually arrives';
  end if;

  -- Settling beyond the expected amount must be refused by the CHECK.
  v_threw := false;
  begin
    perform public.record_settlement(v_id, 'settled', 999999999);
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'settling more than the expected COD must be refused'; end if;

  perform public.record_settlement(v_id, 'settled', null, 'TRX-8891', 'bKash payout');

  if not exists (
    select 1 from public.settlements
    where order_id = v_id and state = 'settled' and settled_at is not null
      and payout_reference = 'TRX-8891'
  ) then
    raise exception 'settlement was not recorded';
  end if;

  if not exists (select 1 from public.orders where id = v_id and cod_settled) then
    raise exception 'the order should mirror the settled settlement';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A failed delivery must NOT restock, and must be re-attemptable
-- ---------------------------------------------------------------------------
do $$
declare
  v_ctx record;
  v_id uuid;
  v_ship public.shipments;
  v_qty_before int;
  v_qty_after int;
begin
  select * into v_ctx from _c;

  select public.create_order(
    v_ctx.store_id, 'e0000000-0000-0000-0000-000000000001',
    '[{"product_id":"d0000000-0000-0000-0000-000000000001","quantity":3}]'::jsonb,
    0::numeric, 0::numeric, 0::numeric, 'cash'::public.payment_method,
    null::text, 'f0000000-0000-0000-0000-000000000003'::uuid,
    null::timestamptz,
    null::text, null::text, null::text, null::text, null::text,
    0::numeric, 0::numeric, true
  ) into v_id;

  perform public.set_order_status(v_id, 'confirmed');
  perform public.set_order_status(v_id, 'packed');

  v_ship := public.register_shipment(v_id, 'manual',
                                     'b0000000-0000-0000-0000-000000000010'::uuid,
                                     null::uuid, null::numeric,
                                     'TRK-777'::text, 'https://example.test/TRK-777'::text,
                                     null::jsonb);

  select quantity into v_qty_before from public.inventory
  where product_id = 'd0000000-0000-0000-0000-000000000001' and store_id = v_ctx.store_id;

  perform public.set_order_status(v_id, 'shipped');
  perform public.set_order_status(v_id, 'on_delivery');
  perform public.set_order_status(v_id, 'failed_delivery', 'Recipient not available');

  select quantity into v_qty_after from public.inventory
  where product_id = 'd0000000-0000-0000-0000-000000000001' and store_id = v_ctx.store_id;

  if v_qty_after <> v_qty_before then
    raise exception 'a failed delivery must not restock (before %, after %)', v_qty_before, v_qty_after;
  end if;

  -- It must be possible to try again rather than being forced to cancel.
  perform public.set_order_status(v_id, 'shipped');
  perform public.set_order_status(v_id, 'on_delivery');
  perform public.set_order_status(v_id, 'delivered');

  if not exists (select 1 from public.orders where id = v_id and status = 'delivered') then
    raise exception 'a re-attempted delivery should be able to succeed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Manual entry works with no API credentials at all
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from public.shipments where provider = 'manual' and state = 'created') then
    raise exception 'a manual shipment should be created immediately, without an API call';
  end if;

  if not exists (select 1 from public.shipment_events where source = 'seller') then
    raise exception 'manual entries should be attributed to the seller in the timeline';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Seller-entered status on a manual parcel
--
-- REDX and manual parcels have no courier webhook, so the seller is the only
-- source of truth. This is the path the app's "Update status" control uses, and
-- it must go through apply_shipment_update rather than writing the shipment
-- directly, so the timeline event, the denormalised order column and the COD
-- side effects all happen exactly as they would for a courier-reported update.
-- ---------------------------------------------------------------------------
do $$
declare
  v_shipment uuid;
  v_order    uuid;
  v_before   int;
begin
  select id, order_id into v_shipment, v_order
  from public.shipments
  where provider = 'manual' and state = 'created'
  limit 1;

  if v_shipment is null then
    raise exception 'expected a manual shipment to update';
  end if;

  select count(*) into v_before from public.shipment_events where shipment_id = v_shipment;

  perform public.apply_shipment_update(
    v_shipment, 'out_for_delivery', 'Out for delivery', null, 'seller', null, null
  );

  -- The shipment moved.
  if not exists (select 1 from public.shipments where id = v_shipment and state = 'out_for_delivery') then
    raise exception 'seller status update did not change the shipment state';
  end if;

  -- It is recorded as a seller event, never as a courier confirmation.
  if not exists (
    select 1 from public.shipment_events
    where shipment_id = v_shipment and state = 'out_for_delivery' and source = 'seller'
  ) then
    raise exception 'seller status update was not recorded as a seller-sourced event';
  end if;

  if exists (
    select 1 from public.shipment_events
    where shipment_id = v_shipment and state = 'out_for_delivery' and source is distinct from 'seller'
  ) then
    raise exception 'a seller update must not be attributed to the courier';
  end if;

  -- The timeline grew by exactly one.
  if (select count(*) from public.shipment_events where shipment_id = v_shipment) <> v_before + 1 then
    raise exception 'seller status update should add exactly one timeline event';
  end if;

  -- The order's denormalised view stayed in step.
  if not exists (
    select 1 from public.orders
    where id = v_order and shipment_status = 'out_for_delivery'
  ) then
    raise exception 'the order shipment_status was not kept in sync';
  end if;

  -- Re-applying the same state is a no-op, so a double tap cannot invent a
  -- second event.
  perform public.apply_shipment_update(
    v_shipment, 'out_for_delivery', 'Out for delivery', null, 'seller', null, null
  );
  if (select count(*) from public.shipment_events where shipment_id = v_shipment) <> v_before + 1 then
    raise exception 're-applying the same seller status should not add an event';
  end if;
end $$;

-- A delivered manual parcel must move COD to collected, exactly as a courier
-- confirmation would. "Delivered" and "settled" stay distinct.
do $$
declare
  v_shipment uuid;
  v_order    uuid;
begin
  select id, order_id into v_shipment, v_order
  from public.shipments
  where provider = 'manual' and state = 'out_for_delivery'
  limit 1;

  if v_shipment is null then
    raise exception 'expected the manual shipment to be out for delivery';
  end if;

  perform public.apply_shipment_update(
    v_shipment, 'delivered', 'Delivered', null, 'seller', null, null
  );

  if not exists (
    select 1 from public.settlements s
    join public.orders o on o.id = s.order_id
    where s.order_id = v_order and o.is_cod and o.cod_amount > 0 and s.state = 'collected'
  ) then
    raise exception 'a seller-recorded delivery should collect COD, not settle it';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Cross-tenant isolation for the new tables
-- ---------------------------------------------------------------------------
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare v_n int;
begin
  select count(*) into v_n from public.shipments;
  if v_n <> 0 then raise exception 'RLS leak: seller B sees % shipments', v_n; end if;

  select count(*) into v_n from public.shipment_events;
  if v_n <> 0 then raise exception 'RLS leak: seller B sees % shipment events', v_n; end if;

  select count(*) into v_n from public.settlements;
  if v_n <> 0 then raise exception 'RLS leak: seller B sees % settlements', v_n; end if;
end $$;

do $$
declare v_threw boolean;
begin
  v_threw := false;
  begin
    perform public.register_shipment(
      (select id from public.shipments limit 1), 'pathao',
      'a0000000-0000-0000-0000-000000000099'::uuid,
      'c0000000-0000-0000-0000-000000000099'::uuid,
      null::numeric, null::text, null::text, null::jsonb
    );
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'seller B was able to dispatch against seller A''s order';
  end if;
end $$;

reset role;

rollback;

\echo ''
\echo '  All SellFlow courier/COD checks passed.'
\echo ''
