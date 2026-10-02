-- ===========================================================================
-- SellFlow :: business-day boundary
--
-- The bug this exists to prevent
-- -------------------------------
-- SellFlow recorded every event as a `timestamptz`, so the moment an order
-- happened was always exact. What it did NOT do was decide where a *day* starts.
-- Every report truncated with `(placed_at at time zone 'UTC')::date`, and the
-- dashboard built its window from `p_today::timestamp`, which the *session*
-- timezone interpreted.
--
-- The client sends the seller's LOCAL calendar date. For a seller at UTC+6 those
-- two definitions are six hours apart, so an order taken at 01:00 local was filed
-- under the previous day, and "Today" read zero for the first six hours of every
-- morning.
--
-- Every timestamp below is FIXED. Nothing here reads now(), current_date, or the
-- machine timezone, so the result is identical at 03:00 in London and at 09:00 in
-- Dhaka, on any date, in any year.
--
-- The instant used throughout:
--   2026-03-11 01:00:00+06  ==  2026-03-10 19:00:00Z
-- That is the interesting one. Locally it is the 11th, an hour into the morning.
-- In UTC it is still the evening of the 10th. Any system that buckets in UTC
-- files this order on the wrong day; a system that respects the store's timezone
-- files it on the 11th.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data)
values ('2b000000-0000-0000-0000-000000000001', 'daybound-a@example.test', '{}'::jsonb),
       ('2b000000-0000-0000-0000-000000000002', 'daybound-b@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '2b000000-0000-0000-0000-000000000001';

create temporary table _db_ctx (org_id uuid, store_id uuid, product_id uuid);

do $$
declare v_r jsonb; v_ctx record;
begin
  v_r := public.bootstrap_business('Boundary Shop', 'Main', 'BND');
  insert into _db_ctx values (
    (v_r ->> 'org_id')::uuid,
    coalesce((v_r ->> 'store_id')::uuid,
             (select id from public.stores where org_id = (v_r ->> 'org_id')::uuid limit 1)),
    null
  );
end $$;

update public.stores set timezone = 'Asia/Dhaka'
where id = (select store_id from _db_ctx);

insert into public.products (org_id, name, sku, selling_price, track_inventory)
select org_id, 'Boundary Widget', 'BND-1', 1000, false from _db_ctx;

update _db_ctx set product_id = (
  select id from public.products where sku = 'BND-1' and org_id = _db_ctx.org_id
);

-- The two moments that straddle the local midnight the UTC day does not have.
-- Both are pinned to the 10th/11th and the 31st/1st so month rollover is tested
-- with the same idea rather than by accident.
--
--   local                     ==  utc
--   2026-03-11 01:00:00 +06   ==  2026-03-10 19:00:00Z   (the 11th, locally)
--   2026-03-11 12:00:00 +06   ==  2026-03-11 06:00:00Z   (unambiguous midday)
--   2026-03-12 01:00:00 +06   ==  2026-03-11 19:00:00Z   (the 12th, locally)
--   2026-04-01 01:00:00 +06   ==  2026-03-31 19:00:00Z   (April, locally)
create temporary table _db_orders (label text, at_local text, amount numeric);

do $$
declare v_ctx record;
begin
  select * into v_ctx from _db_ctx;

  -- The product deliberately does NOT track inventory, so these orders move no
  -- stock. This suite is about WHEN something is counted, not about quantities,
  -- and a stock layer here would only add a second thing that can fail.
  perform public.create_order(
    v_ctx.store_id, null,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_ctx.product_id, 'variant_id', null,
      'quantity', 1, 'line_discount', 0)),
    0, 0, 0, 'cash', null, gen_random_uuid(),
    '2026-03-11 01:00:00+06',
    'Early Bird', '01700000001', 'Dhaka', 'Dhaka', 'Dhanmondi', 0, 0, false
  );
  insert into _db_orders values ('early', '2026-03-11 01:00:00+06', 1000);

  perform public.create_order(
    v_ctx.store_id, null,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_ctx.product_id, 'variant_id', null,
      'quantity', 1, 'line_discount', 0)),
    0, 0, 0, 'cash', null, gen_random_uuid(),
    '2026-03-11 12:00:00+06',
    'Midday', '01700000002', 'Dhaka', 'Dhaka', 'Dhanmondi', 0, 0, false
  );
  insert into _db_orders values ('midday', '2026-03-11 12:00:00+06', 1000);

  perform public.create_order(
    v_ctx.store_id, null,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_ctx.product_id, 'variant_id', null,
      'quantity', 1, 'line_discount', 0)),
    0, 0, 0, 'cash', null, gen_random_uuid(),
    '2026-03-12 01:00:00+06',
    'Next Morning', '01700000003', 'Dhaka', 'Dhaka', 'Dhanmondi', 0, 0, false
  );
  insert into _db_orders values ('nextmorning', '2026-03-12 01:00:00+06', 1000);

  -- Straddles the month boundary as well as the day boundary.
  perform public.create_order(
    v_ctx.store_id, null,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_ctx.product_id, 'variant_id', null,
      'quantity', 1, 'line_discount', 0)),
    0, 0, 0, 'cash', null, gen_random_uuid(),
    '2026-04-01 01:00:00+06',
    'April Start', '01700000004', 'Dhaka', 'Dhaka', 'Dhanmondi', 0, 0, false
  );
  insert into _db_orders values ('april', '2026-04-01 01:00:00+06', 1000);
end $$;

-- ---------------------------------------------------------------------------
-- 1. The event timestamp must be the instant that was supplied, unshifted.
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_actual timestamptz;
begin
  select * into v_ctx from _db_ctx;

  -- 01:00 on the 11th at UTC+6 is 19:00 on the 10th in UTC. If a fix ever
  -- "corrected" the stored value to make a report agree, this is where it shows.
  select placed_at into v_actual
  from public.orders where delivery_name = 'Early Bird';

  if v_actual is distinct from '2026-03-10 19:00:00+00'::timestamptz then
    raise exception 'the stored event timestamp moved: expected 2026-03-10 19:00Z, got %', v_actual;
  end if;

  -- And it must still be an absolute instant, not a reinterpreted wall clock.
  if extract(timezone from v_actual) is null then
    raise exception 'placed_at lost its timezone';
  end if;

  select placed_at into v_actual
  from public.orders where delivery_name = 'April Start';

  if v_actual is distinct from '2026-03-31 19:00:00+00'::timestamptz then
    raise exception 'the month-straddling order''s timestamp moved: got %', v_actual;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. "Today" must mean the seller's day.
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_d jsonb; v_rev numeric;
begin
  select * into v_ctx from _db_ctx;

  -- The 11th, locally, contains 'Early Bird' (01:00 local) and 'Midday'.
  v_d := public.get_dashboard(v_ctx.store_id, '2026-03-11'::date);
  v_rev := (v_d -> 'today' ->> 'revenue')::numeric;

  if v_rev <> 2000 then
    raise exception
      'the 11th local should hold 2000.00 (Early Bird + Midday), got %', v_rev;
  end if;

  if (v_d -> 'today' ->> 'orders')::int <> 2 then
    raise exception 'the 11th local should hold 2 orders, got %', v_d -> 'today' ->> 'orders';
  end if;

  -- The 10th, locally, holds nothing. Under a UTC boundary the Early Bird order
  -- would have landed here, which is the whole bug.
  v_d := public.get_dashboard(v_ctx.store_id, '2026-03-10'::date);
  if (v_d -> 'today' ->> 'revenue')::numeric <> 0 then
    raise exception
      'the 10th local should be empty, got % -- an order is being filed a day early',
      v_d -> 'today' ->> 'revenue';
  end if;

  -- The 12th holds only the 01:00 local order.
  v_d := public.get_dashboard(v_ctx.store_id, '2026-03-12'::date);
  if (v_d -> 'today' ->> 'revenue')::numeric <> 1000 then
    raise exception 'the 12th local should hold 1000.00, got %', v_d -> 'today' ->> 'revenue';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Yesterday and today must not swap, and nothing may be counted twice.
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_10 numeric; v_11 numeric; v_12 numeric; v_sum numeric;
begin
  select * into v_ctx from _db_ctx;

  v_10 := (public.get_dashboard(v_ctx.store_id, '2026-03-10'::date) -> 'today' ->> 'revenue')::numeric;
  v_11 := (public.get_dashboard(v_ctx.store_id, '2026-03-11'::date) -> 'today' ->> 'revenue')::numeric;
  v_12 := (public.get_dashboard(v_ctx.store_id, '2026-03-12'::date) -> 'today' ->> 'revenue')::numeric;

  -- Every order appears in exactly one of the three days.
  if v_10 + v_11 + v_12 <> 3000 then
    raise exception
      'the three days together should total 3000.00 with no double counting, got %', v_10 + v_11 + v_12;
  end if;

  -- And the underlying rows total the same, so nothing was invented or lost.
  select sum(total) into v_sum from public.orders
  where delivery_name in ('Early Bird', 'Midday', 'Next Morning');

  if v_10 + v_11 + v_12 <> v_sum then
    raise exception
      'the day figures (% + % + %) do not reconcile with the orders (% )',
      v_10, v_11, v_12, v_sum;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Analytics and Finance must agree with the Dashboard about the same day.
--    They were the functions that bucketed in UTC while the dashboard's window
--    was cast from a date, so they could disagree with each other.
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_a jsonb; v_f jsonb; v_rev numeric;
begin
  select * into v_ctx from _db_ctx;

  v_a := public.get_analytics(v_ctx.store_id, '2026-03-11'::date, '2026-03-11'::date);
  v_rev := (v_a -> 'totals' ->> 'revenue')::numeric;

  if v_rev <> 2000 then
    raise exception
      'analytics for the 11th local should report 2000.00, got %', v_rev;
  end if;

  v_f := public.get_finance(v_ctx.store_id, '2026-03-11'::date, '2026-03-11'::date);
  -- Finance reports gross sales, which is what revenue means everywhere else.
  v_rev := (v_f -> 'revenue' ->> 'gross_sales')::numeric;

  if v_rev <> 2000 then
    raise exception
      'finance for the 11th local should report 2000.00, got %', v_rev;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. The month boundary must move with the seller's day.
--    An order at 01:00 on 1 April local is 19:00 on 31 March UTC. A UTC boundary
--    books it into March, which is the more visible half of the same bug.
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_march numeric; v_april numeric;
begin
  select * into v_ctx from _db_ctx;

  v_march := coalesce(
    (public.get_analytics(v_ctx.store_id, '2026-03-01'::date, '2026-03-31'::date) -> 'totals' ->> 'revenue')::numeric,
    0);
  v_april := coalesce(
    (public.get_analytics(v_ctx.store_id, '2026-04-01'::date, '2026-04-30'::date) -> 'totals' ->> 'revenue')::numeric,
    0);

  if v_march <> 3000 then
    raise exception 'March should hold the three March orders (3000.00), got %', v_march;
  end if;

  if v_april <> 1000 then
    raise exception
      'the order taken at 01:00 on 1 April local belongs in April, but April holds %', v_april;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. The boundary is per store, not a constant compiled into the query.
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_rev numeric;
begin
  select * into v_ctx from _db_ctx;

  -- A UTC store really does cut at UTC midnight, which is the definition the
  -- whole codebase used before. Same data, same function, different answer.
  update public.stores set timezone = 'UTC' where id = v_ctx.store_id;

  select coalesce((public.get_analytics(v_ctx.store_id, '2026-03-10'::date, '2026-03-10'::date) -> 'totals' ->> 'revenue')::numeric, 0)
    into v_rev;

  if v_rev <> 1000 then
    raise exception
      'with the store set to UTC, the 10th should hold the 01:00+06 order (1000.00), got %', v_rev;
  end if;

  -- Put it back, and prove the change is read per call rather than cached at
  -- install time.
  update public.stores set timezone = 'Asia/Dhaka' where id = v_ctx.store_id;

  select coalesce((public.get_analytics(v_ctx.store_id, '2026-03-10'::date, '2026-03-10'::date) -> 'totals' ->> 'revenue')::numeric, 0)
    into v_rev;

  if v_rev <> 0 then
    raise exception
      'after switching back to Asia/Dhaka the 10th should be empty again, got %', v_rev;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. A timezone Postgres does not recognise must not take a report down.
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_rev numeric; v_ok boolean := false;
begin
  select * into v_ctx from _db_ctx;

  update public.stores set timezone = 'Mars/Olympus_Mons' where id = v_ctx.store_id;

  -- store_timezone() falls back to UTC for a name pg_timezone_names does not
  -- know, so the report still runs instead of erroring on `at time zone`.
  begin
    select coalesce((public.get_analytics(v_ctx.store_id, '2026-03-10'::date, '2026-03-10'::date) -> 'totals' ->> 'revenue')::numeric, 0)
      into v_rev;
    v_ok := true;
  exception when others then
    raise exception 'an unknown timezone must degrade to UTC, but it raised: %', sqlerrm;
  end;

  if not v_ok then
    raise exception 'the report did not run at all';
  end if;

  -- Falls back to UTC, so the 10th holds the order again.
  if v_rev <> 1000 then
    raise exception 'the UTC fallback should put 1000.00 on the 10th, got %', v_rev;
  end if;

  update public.stores set timezone = 'Asia/Dhaka' where id = v_ctx.store_id;
end $$;

-- ---------------------------------------------------------------------------
-- 8. The boundary must not leak across tenants.
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_threw boolean;
begin
  select * into v_ctx from _db_ctx;

  set request.jwt.claim.sub = '2b000000-0000-0000-0000-000000000002';

  v_threw := false;
  begin
    perform public.get_analytics(
      v_ctx.store_id, '2026-03-11'::date, '2026-03-11'::date);
  exception when others then v_threw := true; end;

  if not v_threw then
    raise exception 'a rival seller could read another store''s dated report';
  end if;

  set request.jwt.claim.sub = '2b000000-0000-0000-0000-000000000001';
end $$;

reset role;

rollback;

\echo ''
\echo '  All business-day boundary checks passed.'
\echo ''
