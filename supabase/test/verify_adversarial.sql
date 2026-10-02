-- ===========================================================================
-- SellFlow :: adversarial probe
--
-- Not a regression suite. This file exists to TRY to break SellFlow: it
-- probes the failure paths that the happy-path tests do not reach, so that a
-- real defect surfaces here rather than in a seller's shop.
--
-- Every check asserts an invariant that must hold even when the seller does
-- something wrong, taps twice, or two phones act at the same moment.
--
-- Run with:  Get-Content verify_adversarial.sql -Raw |
--            docker exec -i <container> psql -U postgres -d sellflow -v ON_ERROR_STOP=1 -f -
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: one seller, one store, two customers, three products
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values ('11111111-1111-1111-1111-111111111111', 'probe-a@example.test', '{}'::jsonb),
       ('22222222-2222-2222-2222-222222222222', 'probe-b@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

create temporary table _p (org_id uuid primary key, store_id uuid);
insert into _p
select (public.bootstrap_business('Probe Traders', 'Main', 'PRB') ->> 'org_id')::uuid, null;
update _p set store_id = (select id from public.stores where org_id = _p.org_id limit 1);

insert into public.products (id, org_id, name, sku, selling_price, cost_price, low_stock_threshold)
select '0c000000-0000-0000-0000-000000000001'::uuid, org_id, 'Widget', 'W1', 500, 300, 2 from _p
union all
select '0c000000-0000-0000-0000-000000000002'::uuid, org_id, 'Gadget', 'G1', 1500, 900, 2 from _p
union all
select '0c000000-0000-0000-0000-000000000003'::uuid, org_id, 'Gizmo', 'Z1', 250, 100, 2 from _p;

insert into public.customers (id, org_id, name, phone, district, thana)
select '0d000000-0000-0000-0000-000000000001'::uuid, org_id, 'Buyer One', '01700000001', 'Dhaka', 'Dhanmondi' from _p
union all
select '0d000000-0000-0000-0000-000000000002'::uuid, org_id, 'Buyer Two', '01700000002', 'Dhaka', 'Mirpur' from _p;

do $$
declare v record;
begin
  for v in select store_id from _p loop
    perform public.adjust_stock(v.store_id, '0c000000-0000-0000-0000-000000000001', null, 500, 'initial', 'opening');
    perform public.adjust_stock(v.store_id, '0c000000-0000-0000-0000-000000000002', null, 500, 'initial', 'opening');
    perform public.adjust_stock(v.store_id, '0c000000-0000-0000-0000-000000000003', null, 500, 'initial', 'opening');
  end loop;
end $$;

-- ===========================================================================
-- PROBE 1 -- Repeated payment must not double-record money
--
-- Two distinct failure shapes, and only the first is covered by the
-- overpayment guard:
--
--   a) Pay the full amount twice. The second call is rejected as overpayment,
--      because outstanding has already reached zero. This worked before
--      0012.
--
--   b) Pay a PARTIAL amount and have the request retried -- a lost response
--      looks exactly like a slow one. Both attempts are individually valid,
--      so the overpayment guard accepts both and the customer is charged
--      twice. This was the real defect; 0012_payment_idempotency.sql fixes it
--      with a caller-supplied key.
-- ===========================================================================
do $$
declare
  v_store uuid; v_order uuid; v_total numeric; v_threw boolean;
begin
  select store_id into v_store from _p;

  select public.create_order(
    v_store, '0d000000-0000-0000-0000-000000000001',
    '[{"product_id":"0c000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    0, 0, 0, 'cash', null, 'ee000000-0000-0000-0000-000000000001'::uuid
  ) into v_order;

  select total into v_total from public.orders where id = v_order;

  -- (a) Full payment, then an identical retry.
  perform public.record_payment(v_order, v_total, 'cash', null, 'in full',
    'ef000000-0000-0000-0000-000000000001'::uuid);
  perform public.record_payment(v_order, v_total, 'cash', null, 'in full',
    'ef000000-0000-0000-0000-000000000001'::uuid);

  if (select amount_paid from public.orders where id = v_order) <> 500 then
    raise exception 'PROBE1a BUG: a retried full payment changed amount_paid';
  end if;
  if (select count(*) from public.payments where order_id = v_order) <> 1 then
    raise exception 'PROBE1a BUG: a retried full payment recorded % rows',
      (select count(*) from public.payments where order_id = v_order);
  end if;
end $$;

do $$
declare v_store uuid; v_order uuid; v_paid numeric; v_rows int;
begin
  select store_id into v_store from _p;

  select public.create_order(
    v_store, '0d000000-0000-0000-0000-000000000001',
    '[{"product_id":"0c000000-0000-0000-0000-000000000002","quantity":1}]'::jsonb,
    0, 0, 0, 'cash', null, 'ee000000-0000-0000-0000-00000000000a'::uuid
  ) into v_order;

  -- (b) THE REGRESSION THAT MATTERS: one partial payment of 100, delivered
  -- three times because the app retried. Only one may be recorded.
  perform public.record_payment(v_order, 100, 'cash', null, 'partial',
    'ef000000-0000-0000-0000-00000000000b'::uuid);
  perform public.record_payment(v_order, 100, 'cash', null, 'partial',
    'ef000000-0000-0000-0000-00000000000b'::uuid);
  perform public.record_payment(v_order, 100, 'cash', null, 'partial',
    'ef000000-0000-0000-0000-00000000000b'::uuid);

  select amount_paid into v_paid from public.orders where id = v_order;
  select count(*) into v_rows from public.payments where order_id = v_order;

  if v_paid <> 100 then
    raise exception 'PROBE1b BUG: one 100 payment retried three times left amount_paid = %', v_paid;
  end if;
  if v_rows <> 1 then
    raise exception 'PROBE1b BUG: one 100 payment retried three times created % payment rows', v_rows;
  end if;

  -- A genuinely different payment must still work. Idempotency must not turn
  -- into "refuse all payments".
  --
  -- Gadget is 1500, so 100 + 400 = 500 is a PARTIAL payment, not a settled
  -- one. Asserting 'partial' also proves the status is derived from the
  -- running total rather than from the number of calls.
  perform public.record_payment(v_order, 400, 'cash', null, 'rest',
    'ef000000-0000-0000-0000-00000000000c'::uuid);

  select amount_paid into v_paid from public.orders where id = v_order;
  if v_paid <> 500 then
    raise exception 'PROBE1b BUG: a distinct second payment did not apply. amount_paid = %', v_paid;
  end if;
  if (select payment_status from public.orders where id = v_order) <> 'partial' then
    raise exception 'PROBE1b BUG: 500 paid against a 1500 order should be partial, not %',
      (select payment_status::text from public.orders where id = v_order);
  end if;

  -- Settling the remainder must mark it paid, exactly once.
  perform public.record_payment(v_order, 1000, 'cash', null, 'settle',
    'ef000000-0000-0000-0000-00000000000e'::uuid);
  if (select payment_status from public.orders where id = v_order) <> 'paid' then
    raise exception 'PROBE1b BUG: settling the balance did not mark the order paid';
  end if;
  if (select amount_paid from public.orders where id = v_order) <> 1500 then
    raise exception 'PROBE1b BUG: amount_paid should be 1500 after settling';
  end if;
end $$;

-- A refund has the same defect and the same fix.
do $$
declare v_store uuid; v_order uuid; v_rows int;
begin
  select store_id into v_store from _p;

  select public.create_order(
    v_store, '0d000000-0000-0000-0000-000000000002',
    '[{"product_id":"0c000000-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
    0, 0, 250, 'bkash', null, 'ee000000-0000-0000-0000-00000000000d'::uuid
  ) into v_order;

  perform public.record_refund(v_order, 100, 'cash', 'partial refund',
    'ef000000-0000-0000-0000-00000000000d'::uuid);
  perform public.record_refund(v_order, 100, 'cash', 'partial refund',
    'ef000000-0000-0000-0000-00000000000d'::uuid);

  select count(*) into v_rows
  from public.payments where order_id = v_order and is_refund;

  if v_rows <> 1 then
    raise exception 'PROBE1c BUG: a retried refund recorded % rows', v_rows;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- PROBE 1d -- the full idempotency matrix
--
-- Five cases a real client can produce. Each one has a different correct
-- outcome, and getting any of them wrong either loses money or takes it twice.
-- ---------------------------------------------------------------------------
do $$
declare
  v_store uuid; v_order uuid;
  v_paid numeric; v_rows int; v_threw boolean;
  v_key uuid := 'ef000000-0000-0000-0000-000000000100'::uuid;
begin
  select store_id into v_store from _p;
  select public.create_order(
    v_store, null, '[{"product_id":"0c000000-0000-0000-0000-000000000002","quantity":1}]'::jsonb,
    0, 0, 0, 'cash', null, 'ee000000-0000-0000-0000-000000000100'::uuid
  ) into v_order;

  -- (i) same key, same request, delivered twice -> one payment
  perform public.record_payment(v_order, 300, 'cash', null, 'first', v_key);
  perform public.record_payment(v_order, 300, 'cash', null, 'first', v_key);
  perform public.record_payment(v_order, 300, 'cash', null, 'first', v_key);

  select amount_paid into v_paid from public.orders where id = v_order;
  select count(*) into v_rows from public.payments where order_id = v_order;
  if v_paid <> 300 or v_rows <> 1 then
    raise exception 'PROBE1d(i): three identical calls left paid=% over % rows', v_paid, v_rows;
  end if;

  -- (ii) same key, DIFFERENT amount -> refused, original untouched
  v_threw := false;
  begin
    perform public.record_payment(v_order, 999, 'cash', null, 'tampered', v_key);
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PROBE1d(ii): reusing a key with a different amount was accepted';
  end if;

  select amount_paid into v_paid from public.orders where id = v_order;
  select count(*) into v_rows from public.payments where order_id = v_order;
  if v_paid <> 300 or v_rows <> 1 then
    raise exception
      'PROBE1d(ii) BUG: the rejected call still moved money. paid=% over % rows', v_paid, v_rows;
  end if;

  -- (iii) same key, different METHOD -> also refused
  v_threw := false;
  begin
    perform public.record_payment(v_order, 300, 'bkash', null, 'other method', v_key);
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PROBE1d(iii): reusing a key with a different method was accepted';
  end if;

  -- (iv) a genuinely different key for a real second payment -> accepted
  perform public.record_payment(v_order, 200, 'cash', null, 'balance',
    'ef000000-0000-0000-0000-000000000101'::uuid);

  select amount_paid into v_paid from public.orders where id = v_order;
  if v_paid <> 500 then
    raise exception 'PROBE1d(iv): a distinct second payment did not apply. paid=%', v_paid;
  end if;
  if (select payment_status from public.orders where id = v_order) <> 'partial' then
    raise exception 'PROBE1d(iv): 500 of 1500 should be partial';
  end if;

  -- (v) replaying the FIRST key again after other payments moved the total
  --     must still be a no-op, and must not roll amount_paid backwards
  perform public.record_payment(v_order, 300, 'cash', null, 'first', v_key);
  select amount_paid into v_paid from public.orders where id = v_order;
  if v_paid <> 500 then
    raise exception 'PROBE1d(v): replaying an old key changed the total to %', v_paid;
  end if;

  -- (vi) settling the remainder exactly once
  perform public.record_payment(v_order, 1000, 'cash', null, 'settle',
    'ef000000-0000-0000-0000-000000000102'::uuid);
  perform public.record_payment(v_order, 1000, 'cash', null, 'settle',
    'ef000000-0000-0000-0000-000000000102'::uuid);

  if (select payment_status from public.orders where id = v_order) <> 'paid' then
    raise exception 'PROBE1d(vi): settling the balance did not mark the order paid';
  end if;
  if (select amount_paid from public.orders where id = v_order) <> 1500 then
    raise exception
      'PROBE1d(vi): amount_paid is %, expected exactly 1500',
      (select amount_paid from public.orders where id = v_order);
  end if;

  -- (vii) a refund cannot exceed what was actually paid
  v_threw := false;
  begin
    perform public.record_refund(v_order, 9999, 'cash', 'too much',
      'ef000000-0000-0000-0000-000000000103'::uuid);
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PROBE1d(vii): a refund larger than the payment was accepted';
  end if;
end $$;

-- ===========================================================================
-- PROBE 2 -- Repeated status taps must not duplicate timeline entries
--
-- The probe: walk an order to delivered, then re-apply every status along the
-- way. The timeline must contain one entry per real move, not one per tap.
-- ===========================================================================
do $$
declare
  v_store uuid; v_order uuid; v_hist int;
begin
  select store_id into v_store from _p;

  select public.create_order(
    v_store, '0d000000-0000-0000-0000-000000000001',
    '[{"product_id":"0c000000-0000-0000-0000-000000000002","quantity":1}]'::jsonb,
    0, 0, 0, 'cash', null, 'ee000000-0000-0000-0000-000000000002'::uuid
  ) into v_order;

  perform public.set_order_status(v_order, 'confirmed');
  perform public.set_order_status(v_order, 'confirmed');   -- double tap
  perform public.set_order_status(v_order, 'processing');
  perform public.set_order_status(v_order, 'processing');  -- double tap
  perform public.set_order_status(v_order, 'packaging');
  perform public.set_order_status(v_order, 'packed');
  perform public.set_order_status(v_order, 'shipped');
  perform public.set_order_status(v_order, 'on_delivery');
  perform public.set_order_status(v_order, 'delivered');
  perform public.set_order_status(v_order, 'delivered');  -- double tap

  select count(*) into v_hist from public.order_status_history where order_id = v_order;

  -- NULL->pending, confirmed, processing, packaging, packed, shipped,
  -- on_delivery, delivered = 8 real transitions. Double taps add nothing.
  if v_hist <> 8 then
    raise exception 'PROBE2 BUG: expected 8 timeline entries, got % (double taps duplicated history)', v_hist;
  end if;
end $$;

-- ===========================================================================
-- PROBE 3 -- Illegal transitions are rejected, including skipping stages
-- ===========================================================================
do $$
declare
  v_store uuid; v_order uuid; v_threw boolean; v_tested int := 0;
  v_before int; v_after int;
begin
  select store_id into v_store from _p;

  -- Skipping the lifecycle entirely.
  select public.create_order(
    v_store, '0d000000-0000-0000-0000-000000000001',
    '[{"product_id":"0c000000-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
    0, 0, 0, 'cash', null, 'ee000000-0000-0000-0000-000000000003'::uuid
  ) into v_order;

  v_threw := false;
  begin
    perform public.set_order_status(v_order, 'delivered');
  exception when others then v_threw := true;
  end;
  v_tested := v_tested + 1;
  if not v_threw then raise exception 'PROBE3: pending -> delivered was allowed'; end if;

  -- Jumping backwards.
  perform public.set_order_status(v_order, 'confirmed');
  v_threw := false;
  begin
    perform public.set_order_status(v_order, 'pending');
  exception when others then v_threw := true;
  end;
  v_tested := v_tested + 1;
  if not v_threw then raise exception 'PROBE3: confirmed -> pending was allowed'; end if;

  -- Cancelled is terminal: nothing may follow it.
  --
  -- Stock is compared against a snapshot taken immediately before the order,
  -- not against an absolute number: earlier probes legitimately move stock, so
  -- a hardcoded expectation would be a brittle test rather than a true one.
  select quantity into v_before from public.inventory
   where store_id = v_store and product_id = '0c000000-0000-0000-0000-000000000003';

  select public.create_order(
    v_store, null,
    '[{"product_id":"0c000000-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
    0, 0, 0, 'cash', null, 'ee000000-0000-0000-0000-000000000004'::uuid
  ) into v_order;

  select quantity into v_after from public.inventory
   where store_id = v_store and product_id = '0c000000-0000-0000-0000-000000000003';
  if v_after <> v_before - 1 then
    raise exception 'PROBE3: placing an order should have removed 1 unit (% -> %)', v_before, v_after;
  end if;

  perform public.set_order_status(v_order, 'cancelled');

  v_threw := false;
  begin
    perform public.set_order_status(v_order, 'confirmed');
  exception when others then v_threw := true;
  end;
  v_tested := v_tested + 1;
  if not v_threw then raise exception 'PROBE3: a cancelled order was revived'; end if;

  select quantity into v_after from public.inventory
   where store_id = v_store and product_id = '0c000000-0000-0000-0000-000000000003';
  if v_after <> v_before then
    raise exception 'PROBE3: cancelling did not restore stock (% -> %, expected %)',
      v_before, v_after, v_before;
  end if;

  -- Cancelling twice must not restock twice.
  perform public.set_order_status(v_order, 'cancelled');
  select quantity into v_after from public.inventory
   where store_id = v_store and product_id = '0c000000-0000-0000-0000-000000000003';
  if v_after <> v_before then
    raise exception 'PROBE3 BUG: re-cancelling restocked again (% -> %)', v_before, v_after;
  end if;

  raise notice 'PROBE3: % illegal transitions correctly rejected; stock % -> % -> %',
    v_tested, v_before, v_before - 1, v_after;
end $$;

-- ===========================================================================
-- PROBE 4 -- Oversell is impossible
-- ===========================================================================
do $$
declare v_store uuid; v_threw boolean;
begin
  select store_id into v_store from _p;
  v_threw := false;
  begin
    perform public.create_order(
      v_store, null,
      '[{"product_id":"0c000000-0000-0000-0000-000000000001","quantity":99999}]'::jsonb,
      0, 0, 0, 'cash', null, null
    );
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'PROBE4: an order exceeding stock was accepted'; end if;
end $$;

-- ===========================================================================
-- PROBE 5 -- Money arithmetic stays exact
--
-- A 3-item order with a per-line discount, an order discount and a delivery
-- fee is the classic place for a float to drift. Everything is exact here, and
-- the components must reconstruct the total.
-- ===========================================================================
do $$
declare
  v_store uuid; v_order uuid; v_items numeric; v_disc numeric; v_del numeric;
  v_total numeric; v_cost numeric; v_profit numeric;
begin
  select store_id into v_store from _p;

  select public.create_order(
    v_store, '0d000000-0000-0000-0000-000000000002',
    '[{"product_id":"0c000000-0000-0000-0000-000000000001","quantity":3,"line_discount":0.10},
      {"product_id":"0c000000-0000-0000-0000-000000000002","quantity":1},
      {"product_id":"0c000000-0000-0000-0000-000000000003","quantity":7}]'::jsonb,
    25.55, 60.05, 0, 'cash', null, 'ee000000-0000-0000-0000-000000000005'::uuid
  ) into v_order;

  select items_total, discount, delivery_charge, total, cost_total, profit
    into v_items, v_disc, v_del, v_total, v_cost, v_profit
  from public.orders where id = v_order;

  -- 3 x 500.00 = 1500.00 less a 0.10 line discount -> 1499.90
  -- 1 x 1500.00                       -> 1500.00
  -- 7 x 250.00 = 1750.00               -> 1750.00
  --                                    items_total 4749.90
  -- - 25.55 discount + 60.05 delivery -> total      4784.40
  -- cost 3x300 + 1x900 + 7x100 = 2500.00
  -- profit 4784.40 - 2500.00 = 2284.40
  --
  -- The .90 and .40 are the point: a float would have produced 4749.8999...
  if v_items <> 4749.90 then
    raise exception 'PROBE5: items_total is %, expected 4749.90', v_items;
  end if;

  if v_total <> 4784.40 then
    raise exception 'PROBE5: total is %, expected 4784.40', v_total;
  end if;

  if v_cost <> 2500.00 then
    raise exception 'PROBE5: cost_total is %, expected 2500.00', v_cost;
  end if;

  if v_profit <> 2284.40 then
    raise exception 'PROBE5: profit is %, expected 2284.40', v_profit;
  end if;

  if v_total <> round(v_items - v_disc + v_del, 2) then
    raise exception 'PROBE5: total % does not reconstruct from its components', v_total;
  end if;

  -- A discount larger than the order must be refused, not silently clamped.
  declare v_threw boolean;
  begin
    v_threw := false;
    begin
      perform public.create_order(
        v_store, null,
        '[{"product_id":"0c000000-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
        9999, 0, 0, 'cash', null, null
      );
    exception when others then v_threw := true;
    end;
    if not v_threw then
      raise exception 'PROBE5: an order discount larger than the total was accepted';
    end if;
  end;
end $$;

-- ===========================================================================
-- PROBE 6 -- Idempotent order creation
-- ===========================================================================
do $$
declare
  v_store uuid; v_a uuid; v_b uuid; v_n int;
begin
  select store_id into v_store from _p;

  select public.create_order(
    v_store, null, '[{"product_id":"0c000000-0000-0000-0000-000000000003","quantity":1}]'::jsonb,
    0, 0, 0, 'cash', null, 'ee000000-0000-0000-0000-000000000006'::uuid
  ) into v_a;

  -- Same client_ref, different payload: must return the ORIGINAL order.
  select public.create_order(
    v_store, null, '[]'::jsonb,
    0, 0, 0, 'cash', null, 'ee000000-0000-0000-0000-000000000006'::uuid
  ) into v_b;

  if v_a <> v_b then
    raise exception 'PROBE6: the same client_ref created a second order';
  end if;

  select count(*) into v_n from public.orders
  where client_ref = 'ee000000-0000-0000-0000-000000000006';
  if v_n <> 1 then
    raise exception 'PROBE6: expected 1 order for the client_ref, found %', v_n;
  end if;
end $$;

-- ===========================================================================
-- PROBE 7 -- Every SECURITY DEFINER function re-authorises the caller
--
-- Seller B attempts every business RPC against seller A's ids.
--
-- The ids are captured into a temp table while acting AS seller A, then used
-- verbatim as seller B. This matters: RLS correctly hides those rows from B, so
-- a test that re-queried them as B would find nothing and prove nothing. The
-- realistic threat is an attacker who already knows or guesses a UUID, and this
-- reproduces exactly that -- a correct UUID is not a capability.
--
-- Every function here is SECURITY DEFINER, which is precisely why it must
-- re-authorise: RLS does not apply to it.
-- =========================================================================---

-- Capture the target ids as seller A, before dropping to seller B.
create temporary table _a (
  store_id  uuid primary key,
  org_id    uuid not null,
  order_id  uuid not null
);
insert into _a
select s.id, s.org_id, o.id
from public.stores s
join public.orders o on o.store_id = s.id
where s.name = 'Main'
  and s.org_id in (select o2.id from public.organizations o2 where o2.name = 'Probe Traders')
limit 1;

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare
  v_threw boolean;
  v_cases int := 0;
  v_a_store uuid;
  v_a_order uuid;
  v_a_org   uuid;
begin
  select store_id, org_id, order_id into v_a_store, v_a_org, v_a_order from _a;

  if v_a_store is null then
    raise exception 'PROBE7 setup: no target order was captured';
  end if;

  v_threw := false;
  begin perform public.get_dashboard(v_a_store, current_date); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: get_dashboard leaked another tenant store'; end if;

  v_threw := false;
  begin perform public.get_analytics(v_a_store, current_date - 30, current_date); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: get_analytics leaked another tenant store'; end if;

  v_threw := false;
  begin perform public.get_finance(v_a_store, current_date - 30, current_date); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: get_finance leaked another tenant store'; end if;

  v_threw := false;
  begin perform public.get_sales_report(v_a_store, current_date - 30, current_date); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: get_sales_report leaked another tenant store'; end if;

  v_threw := false;
  begin perform public.get_product_stats(v_a_store, '0c000000-0000-0000-0000-000000000001'); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: get_product_stats leaked another tenant store'; end if;

  v_threw := false;
  begin perform public.get_product_performance(v_a_store, current_date - 30, current_date); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: get_product_performance leaked another tenant store'; end if;

  v_threw := false;
  begin perform public.get_customer_stats('0d000000-0000-0000-0000-000000000001'); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: get_customer_stats leaked another tenant customer'; end if;

  v_threw := false;
  begin perform public.get_couriers(v_a_org); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: get_couriers leaked another tenant org'; end if;

  v_threw := false;
  begin perform public.allowed_order_statuses(v_a_order); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: allowed_order_statuses leaked another tenant order'; end if;

  -- Mutations must be refused too, not just reads.
  v_threw := false;
  begin perform public.create_order(v_a_store, null, '[{"product_id":"0c000000-0000-0000-0000-000000000003","quantity":1}]'::jsonb, 0,0,0,'cash',null,null); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: cross-tenant create_order was allowed'; end if;

  v_threw := false;
  begin perform public.adjust_stock(v_a_store, '0c000000-0000-0000-0000-000000000001', null, 1, 'adjustment', 'nope'); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: cross-tenant adjust_stock was allowed'; end if;

  v_threw := false;
  begin perform public.set_order_status(v_a_order, 'confirmed'); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: cross-tenant set_order_status was allowed'; end if;

  v_threw := false;
  begin perform public.record_payment(v_a_order, 10, 'cash'); exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: cross-tenant record_payment was allowed'; end if;

  v_threw := false;
  begin
    perform public.register_shipment(v_a_order, 'manual', gen_random_uuid(), null, null, 'X1', null, null);
  exception when others then v_threw := true; end;
  v_cases := v_cases + 1;
  if not v_threw then raise exception 'PROBE7: cross-tenant register_shipment was allowed'; end if;

  raise notice 'PROBE7: % cross-tenant calls correctly refused', v_cases;
end $$;

-- Row-level reads must be empty as well, table by table. The list is
-- deliberately exhaustive: a table added without a policy would otherwise be
-- invisible here.
do $$
declare t text; v_n bigint;
begin
-- `profiles` is the one deliberate exception: a seller must be able to read
-- their own profile. So it is asserted as exactly one row, and that row must be
-- their own -- not "zero rows".
execute 'select count(*) from public.profiles' into v_n;
if v_n <> 1 then
  raise exception 'PROBE7: seller B sees % profile rows, expected only their own', v_n;
end if;

if (select id from public.profiles limit 1) <> '22222222-2222-2222-2222-222222222222' then
  raise exception 'PROBE7 BUG: the visible profile is not seller B''s own';
end if;

-- Every other table must be completely empty.
foreach t in array array[
  'orders', 'order_items', 'order_status_history', 'customers', 'products',
  'product_variants', 'inventory', 'inventory_movements', 'expenses',
  'payments', 'settlements', 'shipments', 'shipment_events',
  'notifications', 'stores', 'organizations', 'organization_members',
  'courier_connections'
]
loop
  execute format('select count(*) from public.%I', t) into v_n;
  if v_n <> 0 then
    raise exception 'PROBE7: seller B can read % row(s) from %', v_n, t;
  end if;
end loop;
end $$;

-- ---------------------------------------------------------------------------
-- PROBE 8 -- writes through the table API, with seller B's own org id
--
-- The obvious cross-tenant test is a wrong id. The subtler attack is using a
-- CORRECT org id -- the attacker's own -- but pointing it at another seller's
-- store, product or order. Policies that only check org membership, and not that
-- the row belongs to the store the caller named, would pass the test above and
-- still be exploitable.
-- ---------------------------------------------------------------------------
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare
  v_org uuid;
  v_touched int;
  v_threw boolean;
  v_own_store uuid;
begin
  -- Seller B creates its OWN organization, so every id it sends is legitimate
  -- except the one thing it is reaching for: seller A's rows.
  --
  -- Nothing here asserts that creating a product in one's OWN org is refused --
  -- that is legitimate and must keep working. What matters is that reaching for
  -- another seller's rows, with any org id, is refused.
  select (public.bootstrap_business('Attacker Goods', 'Main', 'ATK') ->> 'org_id')::uuid into v_org;

  -- Now the real attempt: update a product that seller A owns. Seller B's
  -- membership must not grant access to a row outside their organization.
  --
  -- RLS does not raise on a filtered UPDATE, it silently matches nothing. So
  -- "0 rows affected" is the PROTECTED outcome and ">0" is the breach -- the
  -- opposite of what a naive read of the test would suggest.
  v_touched := 0;
  update public.products
     set name = 'Hijacked'
   where id = '0c000000-0000-0000-0000-000000000001';
  get diagnostics v_touched = row_count;

  if v_touched <> 0 then
    raise exception
      'PROBE8 BUG: seller B''s UPDATE reached % row(s) of another seller''s product',
      v_touched;
  end if;

  if (select name from public.products where id = '0c000000-0000-0000-0000-000000000001')
       <> 'Widget' then
    raise exception 'PROBE8 BUG: another seller''s product was actually modified';
  end if;

  -- Delete must be equally refused.
  v_touched := 0;
  delete from public.customers where id = '0d000000-0000-0000-0000-000000000001';
  get diagnostics v_touched = row_count;

  if v_touched <> 0 then
    raise exception
      'PROBE8 BUG: seller B''s DELETE reached % customer row(s) of another seller', v_touched;
  end if;

  if not exists (select 1 from public.customers
                  where id = '0d000000-0000-0000-0000-000000000001') then
    -- This will be true from seller B's seat purely because RLS hides the row.
    -- The real check runs as the owner, below.
    raise notice 'PROBE8: row invisible to seller B, as expected';
  end if;

  -- An expense must not be written into another seller's ledger.
  --
  -- This is the case that found migration 0014: the policy checked org_id but
  -- not store_id, so a seller could pair their OWN org with a FOREIGN store.
  v_threw := false;
  begin
    insert into public.expenses (org_id, store_id, amount, category)
    values (v_org, (select store_id from _a), 100, 'sourcing');
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception
      'PROBE8 BUG: a seller paired their own org with another seller''s store and the write succeeded';
  end if;

  -- The same pairing must be refused on UPDATE too, or a legitimate row could
  -- be repointed at a foreign store after the fact.
  --
  -- First create a genuinely valid expense in the attacker's OWN store, which
  -- must be allowed -- restricting honest writes would be as wrong as allowing
  -- the attack.
  v_own_store := (select id from public.stores where org_id = v_org limit 1);

  insert into public.expenses (org_id, store_id, amount, category, description)
  values (v_org, v_own_store, 100, 'sourcing', 'genuine expense');

  -- Now try to move it onto seller A's store.
  --
  -- Two shapes of refusal are both correct here, and which one happens depends
  -- on the policy: a row the caller cannot see is filtered silently (0 rows), a
  -- row they CAN see but whose new values fail WITH CHECK raises. Only a
  -- successful update is a breach.
  v_touched := 0;
  begin
    update public.expenses
       set store_id = (select store_id from _a)
     where org_id = v_org and amount = 100;
    get diagnostics v_touched = row_count;
  exception when others then
    v_touched := 0;  -- refused outright, which is the outcome we want
  end;

  if v_touched <> 0 then
    raise exception
      'PROBE8 BUG: an expense row was repointed at another seller''s store (% row(s) changed)', v_touched;
  end if;

  if (select store_id from public.expenses
        where org_id = v_org and amount = 100 limit 1) <> v_own_store then
    raise exception 'PROBE8 BUG: the expense now points at a foreign store';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- PROBE 8b -- confirm, with the owner's eyes, that nothing was actually changed
--
-- The checks above have to be made from seller B's seat, where RLS hides
-- seller A's rows entirely -- which makes "the row is gone" indistinguishable
-- from "the row is invisible". Only a privileged reader can tell the
-- difference, so the post-conditions are verified here.
-- ---------------------------------------------------------------------------
reset role;

do $$
declare v_n int;
begin
  if not exists (select 1 from public.customers
                  where id = '0d000000-0000-0000-0000-000000000001') then
    raise exception 'PROBE8 BUG: seller A''s customer was actually deleted';
  end if;

  if (select name from public.products where id = '0c000000-0000-0000-0000-000000000001')
       <> 'Widget' then
    raise exception 'PROBE8 BUG: seller A''s product was actually renamed';
  end if;

  if (select selling_price from public.products where id = '0c000000-0000-0000-0000-000000000001') <> 500 then
    raise exception 'PROBE8 BUG: seller A''s product price was actually changed';
  end if;

  -- The attacker's organisation exists (they were allowed to create it) but
  -- must hold none of seller A's business data.
  select count(*) into v_n
  from public.expenses e
  where e.store_id = (select store_id from _a);

  if v_n <> 0 then
    raise exception 'PROBE8 BUG: % expense(s) were written into seller A''s ledger', v_n;
  end if;

  -- Seller A's own order count must be untouched.
  select count(*) into v_n from public.orders where store_id = (select store_id from _a);
  if v_n = 0 then
    raise exception 'PROBE8 BUG: seller A''s orders disappeared';
  end if;
end $$;

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

reset role;

rollback;

\echo ''
\echo '  All SellFlow adversarial probes passed.'
\echo ''
