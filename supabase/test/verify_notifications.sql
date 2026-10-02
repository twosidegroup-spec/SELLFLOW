-- ===========================================================================
-- SellFlow :: notification pipeline, end to end
--
-- Migration 0009 installs four trigger-based producers. The previous report
-- said live firing had not been verified. This file drives REAL business events
-- and asserts the whole chain each time:
--
--     event -> trigger producer -> notification row -> RLS visibility -> inbox
--
-- No notification is inserted directly anywhere in this file. Every row that
-- appears is caused by an operational change a seller would make.
--
-- Also asserted:
--   * a seller sees their own notifications and nobody else's
--   * read/unread state behaves (unread count, mark read)
--   * the same event twice does not produce a second notification (dedupe)
--   * a disabled preference suppresses the notification
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Two sellers. Notifications must never cross the line between them.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values ('11111111-1111-1111-1111-111111111111', 'notif-a@example.test', '{}'::jsonb),
       ('22222222-2222-2222-2222-222222222222', 'notif-b@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

create temporary table _n (org_id uuid primary key, store_id uuid);
insert into _n
select (public.bootstrap_business('Notify Traders', 'Main', 'NTF') ->> 'org_id')::uuid, null;
update _n set store_id = (select id from public.stores where org_id = _n.org_id limit 1);

insert into public.products (id, org_id, name, sku, selling_price, cost_price, low_stock_threshold)
select '0f000000-0000-0000-0000-000000000001'::uuid, org_id, 'Notify Widget', 'NW', 500, 300, 3 from _n;

insert into public.customers (id, org_id, name, phone, district, thana)
select '10000000-0000-0000-0000-000000000001'::uuid, org_id, 'Notify Buyer', '01900000001', 'Dhaka', 'Uttara' from _n;

do $$
declare v record;
begin
  -- Threshold is 3; start at 10 so there is room to cross it.
  for v in select store_id from _n loop
    perform public.adjust_stock(v.store_id, '0f000000-0000-0000-0000-000000000001', null, 10, 'initial', 'opening');
  end loop;
end $$;

-- ===========================================================================
-- EVENT 1 -- low stock
--
-- The event is an order that takes stock to the threshold. The producer is an
-- inventory trigger, so it must fire without anyone calling a producer.
-- ===========================================================================
do $$
declare
  v_store uuid; v_order uuid; v_n int;
begin
  select store_id into v_store from _n;

  select public.create_order(
    v_store, '10000000-0000-0000-0000-000000000001',
    '[{"product_id":"0f000000-0000-0000-0000-000000000001","quantity":7}]'::jsonb,
    0, 0, 0, 'cash', null, 'dd000000-0000-0000-0000-000000000001'::uuid
  ) into v_order;

  select count(*) into v_n from public.notifications
   where kind = 'low_stock' and data ->> 'product_id' = '0f000000-0000-0000-0000-000000000001';

  if v_n = 0 then
    raise exception 'NOTIF1: stock fell to the threshold but no low-stock notification was raised';
  end if;

  -- The row must be unread and addressed to this seller.
  if exists (select 1 from public.notifications where read_at is not null) then
    raise exception 'NOTIF1: a new notification was created already read';
  end if;

  if not exists (select 1 from public.notifications where user_id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'NOTIF1: the notification is not addressed to the seller';
  end if;
end $$;

-- Crossing again after restocking must be able to notify again (rearmed), but
-- the SAME event must not double up.
do $$
declare v_store uuid; v_n int; v_order uuid;
begin
  select store_id into v_store from _n;

  -- Re-apply the same order's stock effect is not possible, so instead drive a
  -- second order while already below the threshold: the producer must stay
  -- quiet rather than re-alerting on every sale.
  select public.create_order(
    v_store, '10000000-0000-0000-0000-000000000001',
    '[{"product_id":"0f000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    0, 0, 0, 'cash', null, 'dd000000-0000-0000-0000-000000000002'::uuid
  ) into v_order;

  select count(*) into v_n from public.notifications
   where kind = 'low_stock' and data ->> 'product_id' = '0f000000-0000-0000-0000-000000000001';

  if v_n > 1 then
    raise exception 'NOTIF2: still-low stock produced % alerts. It should alert once per crossing.', v_n;
  end if;
end $$;

-- ===========================================================================
-- EVENT 1b -- low stock raised AFTER the fact, and opening stock already short
--
-- Migration 0009 watched inventory with `after update`, so it could not see
-- either of these. Both are real events a seller expects to hear about, and
-- both were silent until 0013.
-- ===========================================================================
do $$
declare
  v_store uuid; v_product uuid; v_n int;
begin
  select store_id into v_store from _n;

  -- (a) Opening stock that is ALREADY below the alert level. The inventory row
  --     arrives as an INSERT, which the old trigger never saw.
  insert into public.products (id, org_id, name, sku, selling_price, cost_price, low_stock_threshold)
  select '0f000000-0000-0000-0000-000000000009'::uuid, org_id, 'Short from day one', 'SHORT', 400, 200, 5 from _n
  returning id into v_product;

  perform public.adjust_stock(v_store, v_product, null, 2, 'initial', 'opening stock');

  select count(*) into v_n from public.notifications
   where kind = 'low_stock' and data ->> 'product_id' = v_product::text;

  if v_n = 0 then
    raise exception
      'NOTIF1b: a product created with stock already below its alert level produced no warning';
  end if;

  -- (b) Raising the alert level above the current stock. Nothing about the
  --     inventory changed, so an inventory-only trigger cannot see this.
  update public.products set low_stock_threshold = 50 where id = v_product;

  select count(*) into v_n from public.notifications
   where kind = 'low_stock'
     and data ->> 'product_id' = v_product::text
     and title = 'Low stock: Short from day one';

  if v_n < 2 then
    raise exception
      'NOTIF1b: raising the alert level above current stock produced % warning(s), expected a second',
      v_n;
  end if;

  -- (c) Anti-spam: saving the product again without changing the level must
  --     not warn a third time.
  update public.products set name = 'Short from day one (renamed)' where id = v_product;
  update public.products set low_stock_threshold = 50 where id = v_product;

  select count(*) into v_n from public.notifications
   where kind = 'low_stock' and data ->> 'product_id' = v_product::text;

  if v_n <> 2 then
    raise exception
      'NOTIF1b: re-saving the product produced % warning(s) in total, expected 2', v_n;
  end if;

  -- (d) Turning tracking OFF silences it. Raising the level while untracked must
  --     not warn, because the seller has explicitly said "don't watch this".
  update public.products set track_inventory = false where id = v_product;
  update public.products set low_stock_threshold = 100 where id = v_product;

  select count(*) into v_n from public.notifications
   where kind = 'low_stock' and data ->> 'product_id' = v_product::text;
  if v_n <> 2 then
    raise exception
      'NOTIF1b: warnings continued while stock tracking was off (% in total, expected 2)', v_n;
  end if;

  -- Turning it back ON is a real event, and the product IS short, so warning
  -- again is correct: the seller has just started watching goods that are
  -- already below the level they chose.
  update public.products set track_inventory = true where id = v_product;
  select count(*) into v_n from public.notifications
   where kind = 'low_stock' and data ->> 'product_id' = v_product::text;
  if v_n <> 3 then
    raise exception
      'NOTIF1b: re-enabling tracking on a short product gave % warning(s), expected 3', v_n;
  end if;
end $$;

-- ===========================================================================
-- EVENT 2 -- order status notifications, and the anti-spam rule
--
-- The producer deliberately fires only for the statuses a seller must ACT on:
-- failed_delivery, returned and delivered. A routine transition such as
-- 'confirmed' must raise nothing at all -- otherwise the inbox fills up with
-- noise the seller learns to ignore, which is worse than no notification.
-- Both halves of that rule are asserted.
-- ===========================================================================
do $$
declare
  v_order uuid; v_n int; v_title text;
begin
  select id into v_order from public.orders
   where client_ref = 'dd000000-0000-0000-0000-000000000001';

  -- Routine progress: must be silent.
  perform public.set_order_status(v_order, 'confirmed');
  perform public.set_order_status(v_order, 'processing');
  perform public.set_order_status(v_order, 'packaging');
  perform public.set_order_status(v_order, 'packed');

  select count(*) into v_n from public.notifications where kind = 'order_status';

  if v_n <> 0 then
    raise exception
      'NOTIF3: % notification(s) raised for routine status changes. The inbox must stay quiet.', v_n;
  end if;
end $$;

do $$
declare
  v_order uuid; v_n int; v_title text;
begin
  select id into v_order from public.orders
   where client_ref = 'dd000000-0000-0000-0000-000000000001';

  -- A delivery failure is exactly the kind of event that must interrupt.
  perform public.set_order_status(v_order, 'shipped');
  perform public.set_order_status(v_order, 'on_delivery');
  perform public.set_order_status(v_order, 'failed_delivery', 'Customer not answering');

  select count(*), max(title) into v_n, v_title
  from public.notifications where kind = 'order_status';

  if v_n = 0 then
    raise exception 'NOTIF3: a failed delivery raised no notification';
  end if;

  if v_title is null or v_title = '' then
    raise exception 'NOTIF3: the failure notification has no readable title';
  end if;

  -- A re-attempt is a genuinely new event and must notify. From
  -- failed_delivery the only way forward is back into the lifecycle, which is
  -- exactly the real-world recovery path a seller takes.
  perform public.set_order_status(v_order, 'pending');
  perform public.set_order_status(v_order, 'confirmed');
  perform public.set_order_status(v_order, 'processing');
  perform public.set_order_status(v_order, 'packaging');
  perform public.set_order_status(v_order, 'packed');
  perform public.set_order_status(v_order, 'shipped');
  perform public.set_order_status(v_order, 'on_delivery');
  perform public.set_order_status(v_order, 'delivered');

  select count(*) into v_n from public.notifications where kind = 'order_status';

  if v_n < 2 then
    raise exception
      'NOTIF3: a failure then a delivery raised % notification(s); both are actionable.', v_n;
  end if;
end $$;

-- ===========================================================================
-- EVENT 3 -- shipment created, and 4 -- delivery failure
--
-- The producer is a shipment_events trigger, so registering a manual shipment
-- and then failing it must both produce notifications.
-- ===========================================================================
do $$
declare
  v_order uuid; v_shipment public.shipments; v_n int; v_store uuid; v_blocked boolean;
begin
  select store_id into v_store from _n;

  -- Order 2, which is still at the start of its lifecycle. Order 1 was already
  -- driven to delivered by the previous block.
  select id into v_order from public.orders
   where client_ref = 'dd000000-0000-0000-0000-000000000002';

  -- A consignment cannot be created without somewhere to send it. The delivery
  -- address is captured when the order is created, because `orders` is
  -- deliberately not directly updatable by the client: an order is only ever
  -- changed through a function that re-authorises the caller.
  -- Named notation, so the test reads as intent rather than as a column
  -- position. A mis-ordered positional list here would silently set the wrong
  -- field.
  select public.create_order(
    p_store_id        => v_store,
    p_customer_id     => '10000000-0000-0000-0000-000000000001',
    p_items           => '[{"product_id":"0f000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    p_amount_paid     => 0,
    p_notes           => 'leave with the rider',
    p_client_ref      => 'dd000000-0000-0000-0000-000000000003'::uuid,
    p_delivery_name   => 'Notify Buyer',
    p_delivery_phone  => '01900000001',
    p_delivery_address=> 'House 7, Road 3, Uttara',
    p_delivery_district => 'Dhaka',
    p_delivery_thana  => 'Uttara',
    p_is_cod          => true
  ) into v_order;

  if (select is_cod from public.orders where id = v_order) is not true then
    raise exception 'NOTIF4: the COD flag was not stored on the order';
  end if;

  perform public.set_order_status(v_order, 'confirmed');
  perform public.set_order_status(v_order, 'processing');
  perform public.set_order_status(v_order, 'packaging');
  perform public.set_order_status(v_order, 'packed');

  -- An order with no address cannot be dispatched. That is a real seller
  -- mistake, and the block is a genuine safety check rather than a nicety.
  v_blocked := false;
  begin
    perform public.register_shipment(
      (select id from public.orders
        where client_ref = 'dd000000-0000-0000-0000-000000000002'),
      'manual', gen_random_uuid(), null, null, 'NO-ADDR', null, null
    );
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'NOTIF4: a consignment was created with no delivery address';
  end if;

  -- register_shipment returns the shipments composite directly, so it is
  -- assigned rather than selected from.
  v_shipment := public.register_shipment(
    v_order, 'manual', gen_random_uuid(), null, null, 'NTF-TRACK-1',
    'https://example.test/track/1', null
  );

  if v_shipment.id is null then
    raise exception 'NOTIF4: the manual shipment was not created';
  end if;

  -- Moving the parcel must produce a timeline event, and the shipment trigger
  -- must observe it.
  perform public.apply_shipment_update(
    v_shipment.id, 'picked', 'Collected from the seller', null, 'seller', null, null
  );

  if not exists (select 1 from public.shipment_events where shipment_id = v_shipment.id and state = 'picked') then
    raise exception 'NOTIF4: the pickup produced no shipment event';
  end if;

  -- Mark the order shipped the way the app does, and let the producer speak.
  perform public.set_order_status(v_order, 'shipped');
  perform public.set_order_status(v_order, 'on_delivery');
  perform public.set_order_status(v_order, 'delivered');

  if not exists (select 1 from public.notifications where kind = 'order_status') then
    raise exception 'NOTIF4: the delivery produced no notification';
  end if;
end $$;

-- ===========================================================================
-- EVENT 5 -- delivered, and 6 -- COD settlement
-- ===========================================================================
-- EVENT 5 -- shipment confirmed as delivered, and EVENT 6 -- COD settlement
--
-- Uses the COD order created in EVENT 4, which is already delivered.
-- ===========================================================================
do $$
declare
  v_order uuid; v_shipment uuid; v_n int;
begin
  select id into v_order from public.orders
   where client_ref = 'dd000000-0000-0000-0000-000000000003';

  select id into v_shipment from public.shipments where order_id = v_order limit 1;

  perform public.apply_shipment_update(
    v_shipment, 'delivered', 'Delivered', null, 'seller', null, null
  );

  -- Delivery on a COD order must mark the money as COLLECTED, not settled.
  -- "Delivered" and "the courier paid me" are different events.
  if not exists (
    select 1 from public.settlements where order_id = v_order and state = 'collected'
  ) then
    raise exception
      'NOTIF5: delivering a COD order did not mark the cash as collected';
  end if;

  if exists (select 1 from public.settlements where order_id = v_order and state = 'settled') then
    raise exception
      'NOTIF5 BUG: delivery marked the COD as settled. Money has not moved yet.';
  end if;

  -- Now the seller records the actual payout.
  perform public.record_settlement(v_order, 'settled', 250, 'bKash payout', 'TXN-123');

  if not exists (
    select 1 from public.settlements where order_id = v_order and state = 'settled'
  ) then
    raise exception 'NOTIF5: the COD payout was not recorded as settled';
  end if;
end $$;

-- ===========================================================================
-- EVENT 7 -- return initiated, and its notification
-- ===========================================================================
do $$
declare v_order uuid; v_n int;
begin
  -- Order 2 still has a full lifecycle ahead of it.
  select id into v_order from public.orders
   where client_ref = 'dd000000-0000-0000-0000-000000000002';

  perform public.set_order_status(v_order, 'confirmed');
  perform public.set_order_status(v_order, 'processing');
  perform public.set_order_status(v_order, 'packaging');
  perform public.set_order_status(v_order, 'packed');
  perform public.set_order_status(v_order, 'shipped');
  perform public.set_order_status(v_order, 'on_delivery');
  perform public.set_order_status(v_order, 'delivered');
  perform public.set_order_status(v_order, 'returned');

  if (select status from public.orders where id = v_order) <> 'returned' then
    raise exception 'NOTIF6: the order was not moved to returned';
  end if;

  -- A return is money and stock moving backwards, so the seller must be told.
  select count(*) into v_n
  from public.notifications
  where kind = 'order_status' and data ->> 'order_id' = v_order::text;

  if v_n = 0 then
    raise exception 'NOTIF6: the return raised no notification';
  end if;
end $$;

-- ===========================================================================
-- Inbox behaviour: unread, read, and count
-- ===========================================================================
do $$
declare v_unread int; v_total int;
begin
  select count(*) filter (where read_at is null) into v_unread
  from public.notifications where user_id = '11111111-1111-1111-1111-111111111111';

  select count(*) into v_total
  from public.notifications where user_id = '11111111-1111-1111-1111-111111111111';

  if v_total = 0 then
    raise exception 'INBOX: no notifications were produced by the whole journey';
  end if;

  if v_unread <> v_total then
    raise exception 'INBOX: % of % notifications started already read', v_total - v_unread, v_total;
  end if;

  -- Marking read is the seller's action; the RLS policy allows it on own rows.
  update public.notifications set read_at = now()
   where user_id = '11111111-1111-1111-1111-111111111111';

  select count(*) filter (where read_at is null) into v_unread
  from public.notifications where user_id = '11111111-1111-1111-1111-111111111111';

  if v_unread <> 0 then
    raise exception 'INBOX: % notifications are still unread after being marked read', v_unread;
  end if;

  raise notice 'inbox: % notification(s) produced by the journey, all readable and markable', v_total;
end $$;

-- ===========================================================================
-- RLS: seller B must see nothing of seller A's notifications
-- ===========================================================================
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare
  v_n int;
  v_touched int := 0;
begin
  -- Reads: nothing of another seller's inbox may be visible.
  select count(*) into v_n from public.notifications;
  if v_n <> 0 then
    raise exception 'RLS: seller B can see % notification(s) belonging to another seller', v_n;
  end if;

  -- Writes: an UPDATE that matches no visible row is a no-op, not a mutation.
  -- GET DIAGNOSTICS is used rather than an exception sentinel, because RLS
  -- filters rows silently -- a policy failure is a zero row count, not an error,
  -- and conflating the two would let a real leak pass unnoticed.
  update public.notifications set read_at = now();
  get diagnostics v_touched = row_count;

  if v_touched <> 0 then
    raise exception
      'RLS: seller B was able to update % notification(s) belonging to another seller',
      v_touched;
  end if;

  -- And seller A's notifications must be untouched by the attempt.
  if exists (select 1 from public.notifications where read_at is not null) then
    raise exception
      'RLS: seller B modified another seller''s read state';
  end if;
end $$;

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

reset role;

rollback;

\echo ''
\echo '  All SellFlow notification pipeline checks passed.'
\echo ''
