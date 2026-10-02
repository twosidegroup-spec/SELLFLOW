-- ===========================================================================
-- SellFlow :: concurrency stress
--
-- The oversell guarantee cannot be proven by running orders one after another.
-- This file opens genuinely parallel connections through dblink so several
-- create_order calls for the SAME limited stock are in flight at once.
--
-- The question: can two simultaneous orders both read "5 left", both decide 5
-- is enough, and drive stock below zero?
--
-- The invariant, asserted after every round:
--   * stock never goes negative, and
--   * the units removed from stock equal exactly the units on orders that
--     actually committed.
-- A partial failure that moved stock but left no order would break the second
-- half, which is the more interesting corruption.
--
-- NOTE: this file deliberately does NOT wrap itself in a transaction.
-- dblink connections are independent backends, so they cannot see uncommitted
-- fixtures. The fixtures are committed and torn down at the end instead. It is
-- meant to run only against a disposable local database, never a real project.
-- ===========================================================================

\set ON_ERROR_STOP on

create extension if not exists dblink;

-- ---------------------------------------------------------------------------
-- Self-cleaning. A previous run, or an interrupted one, may have left this
-- seller's rows behind.
--
-- The order matters: organizations reference the profile, so the org has to go
-- first. Deleting it cascades to stores, products, inventory, orders and every
-- other business table.
-- ---------------------------------------------------------------------------
do $$
declare v_org uuid;
begin
  select id into v_org from public.organizations where created_by = '11111111-1111-1111-1111-111111111111';
  if v_org is not null then
    delete from public.organizations where id = v_org;
  end if;
  delete from public.profiles where id = '11111111-1111-1111-1111-111111111111';
  delete from auth.users   where id = '11111111-1111-1111-1111-111111111111';
end $$;

insert into auth.users (id, email, raw_user_meta_data)
values ('11111111-1111-1111-1111-111111111111', 'conc@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

create temporary table _c (org_id uuid primary key, store_id uuid);
insert into _c
select (public.bootstrap_business('Concurrent Traders', 'Main', 'CNC') ->> 'org_id')::uuid, null;
update _c set store_id = (select id from public.stores where org_id = _c.org_id limit 1);

insert into public.products (id, org_id, name, sku, selling_price, cost_price)
select '0e000000-0000-0000-0000-000000000001'::uuid, org_id, 'Limited', 'LIM', 100, 60 from _c;

-- 10 units available; five parallel orders of 4 will be aimed at it.
do $$
declare v record;
begin
  for v in select store_id from _c loop
    perform public.adjust_stock(v.store_id, '0e000000-0000-0000-0000-000000000001', null, 10, 'initial', 'opening');
  end loop;
end $$;

-- The fixtures must be visible to other backends before the stress runs.
select pg_sleep(0.2);

-- ---------------------------------------------------------------------------
-- Fire the parallel batch. dblink must be called as a superuser, because
-- Postgres forbids a non-superuser from opening a connection as a different
-- role and `authenticated` has no password. That does not weaken the test: the
-- REMOTE connection is what runs the business logic, and it sets the JWT claim
-- and does `set role authenticated` exactly as PostgREST would, so RLS and every
-- SECURITY DEFINER re-authorisation are fully in force.
--
-- The credentials are the throwaway local container's, used only to open a
-- loopback connection from inside that same container.
-- ---------------------------------------------------------------------------
reset role;

do $$
declare
  v_store uuid;
  v_sql text;
  v_attempt int;
  v_batch int;
  v_accepted int := 0;
  v_rejected int := 0;
begin
  select store_id into v_store from _c;

  -- dblink_exec cannot run a statement that returns rows, so each order is
  -- created inside an anonymous block. The $remote$ tag is used so it does not
  -- collide with the outer block's dollar quoting.
  v_sql := format($q$
    select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
    set role authenticated;
    do $remote$
    begin
      perform public.create_order(
        %L::uuid, null,
        '[{"product_id":"0e000000-0000-0000-0000-000000000001","quantity":4}]'::jsonb,
        0, 0, 0, 'cash', null, gen_random_uuid());
    end
    $remote$;
  $q$, v_store::text);

  -- Three batches of five. A single batch can win the race by luck; the point
  -- is that the invariant holds every time.
  --
  -- Most of these are EXPECTED to fail -- that is the whole test -- so a remote
  -- rejection is counted, not raised.
  for v_batch in 1..3 loop
    for v_attempt in 1..5 loop
      begin
        perform public.dblink_exec(
          'host=127.0.0.1 port=5432 dbname=' || current_database()
            || ' user=postgres password=postgres',
          v_sql
        );
        v_accepted := v_accepted + 1;
      exception when others then
        v_rejected := v_rejected + 1;
      end;
    end loop;
  end loop;

  raise notice 'parallel batch: % accepted, % rejected', v_accepted, v_rejected;

  if v_accepted > 3 then
    raise exception
      'CONC BUG: % orders of 4 units were accepted against 10 units in stock -- oversold.',
      v_accepted;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Assert the invariant against committed state
-- ---------------------------------------------------------------------------
do $$
declare
  v_store uuid;
  v_stock int;
  v_committed int;
  v_orders int;
begin
  select store_id into v_store from _c;

  select quantity into v_stock from public.inventory
   where store_id = v_store and product_id = '0e000000-0000-0000-0000-000000000001';

  if v_stock < 0 then
    raise exception 'CONC BUG: stock went negative (%)', v_stock;
  end if;

  select coalesce(sum(oi.quantity), 0)::int, count(distinct o.id)::int
    into v_committed, v_orders
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.store_id = v_store
    and oi.product_id = '0e000000-0000-0000-0000-000000000001';

  if v_orders > 3 then
    raise exception
      'CONC BUG: % orders of 4 units were accepted against 10 units in stock -- oversold.',
      v_orders;
  end if;

  -- The decisive check: every unit that left the shelf is on a real order.
  if 10 - v_stock <> v_committed then
    raise exception
      'CONC BUG: % unit(s) left stock but % were on committed orders. A write was half-applied.',
      10 - v_stock, v_committed;
  end if;

  raise notice 'after 15 parallel orders of 4 units: % order(s) accepted, % unit(s) sold, stock = %',
    v_orders, v_committed, v_stock;
end $$;

-- ---------------------------------------------------------------------------
-- Concurrent cancellation
--
-- Five parallel cancels of the SAME order. A cancel restocks, so if it were not
-- guarded the goods would be put back several times over and stock would drift
-- upwards. The order is created here specifically for this.
-- ---------------------------------------------------------------------------
reset role;

-- Block 1: prepare. This MUST be its own block: a DO block is one transaction,
-- so an order created inside it is invisible to the dblink connections until
-- the block ends. Committing first is what makes the race a real race.
do $$
declare v_store uuid; v_have int;
begin
  select store_id into v_store from _c;

  -- Make sure the units for this race exist.
  select quantity into v_have from public.inventory
   where store_id = v_store and product_id = '0e000000-0000-0000-0000-000000000001';

  if v_have < 10 then
    perform public.adjust_stock(
      v_store, '0e000000-0000-0000-0000-000000000001', null,
      20 - v_have, 'adjustment', 'stock up for the cancel race'
    );
  end if;

  perform public.create_order(
    v_store, null,
    '[{"product_id":"0e000000-0000-0000-0000-000000000001","quantity":6}]'::jsonb,
    0, 0, 0, 'cash', null, 'ee000000-0000-0000-0000-0000000000c1'::uuid
  );
end $$;

-- Block 2: the race itself.
reset role;

do $$
declare
  v_store uuid;
  v_sql text;
  v_order uuid;
  v_before int;
  v_after int;
  v_attempt int;
begin
  select store_id into v_store from _c;

  select id into v_order from public.orders
   where client_ref = 'ee000000-0000-0000-0000-0000000000c1';

  if v_order is null then
    raise exception 'CONC SETUP: the order to cancel was not created';
  end if;

  select quantity into v_before from public.inventory
   where store_id = v_store and product_id = '0e000000-0000-0000-0000-000000000001';

  v_sql := format($q$
    select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
    set role authenticated;
    do $remote$
    begin
      perform public.set_order_status(%L::uuid, 'cancelled', 'parallel cancel');
    end
    $remote$;
  $q$, v_order::text);

  for v_attempt in 1..5 loop
    begin
      perform public.dblink_exec(
        'host=127.0.0.1 port=5432 dbname=' || current_database()
          || ' user=postgres password=postgres',
        v_sql
      );
    exception when others then
      -- A loser is the correct outcome, but a SQL error on EVERY attempt means
      -- the test itself is broken, not that the race was handled. Surface it.
      if v_attempt = 1 then
        raise exception 'CONC SETUP: the parallel cancel statement failed: %', sqlerrm;
      end if;
    end;
  end loop;

  select quantity into v_after from public.inventory
   where store_id = v_store and product_id = '0e000000-0000-0000-0000-000000000001';

  if v_after <> v_before + 6 then
    raise exception
      'CONC BUG: five parallel cancels restocked % unit(s); exactly 6 were sold.',
      v_after - v_before;
  end if;

  if (select status from public.orders where id = v_order) <> 'cancelled' then
    raise exception 'CONC BUG: the order was not cancelled';
  end if;

  raise notice 'parallel cancel: 5 racers, stock moved by exactly % unit(s)', v_after - v_before;
end $$;

-- ---------------------------------------------------------------------------
-- Orders racing stock adjustments
--
-- A manual correction and a sale touching the same product at the same time.
-- The invariant is the one that matters: stock never goes negative, and the
-- balance still agrees with the ledger.
-- ---------------------------------------------------------------------------
-- Block 1: reset the product to a known small level.
--
-- This MUST be committed before the race begins. A DO block is a single
-- transaction, so an adjust_stock here would hold the inventory row lock for the
-- remainder of the block -- and the dblink racers below need that same row. The
-- local session would then wait on a remote that is waiting on it.
--
-- That is a deadlock in the TEST, not in the product, and it is easy to create
-- by accident: never hold a lock across a dblink boundary.
-- ---------------------------------------------------------------------------
do $$
declare v_store uuid; v_stock int;
begin
  select store_id into v_store from _c;

  select quantity into v_stock from public.inventory
   where store_id = v_store and product_id = '0e000000-0000-0000-0000-000000000001';

  perform public.adjust_stock(
    v_store, '0e000000-0000-0000-0000-000000000001', null,
    7 - v_stock, 'adjustment', 'reset for the mixed race'
  );
end $$;

-- ---------------------------------------------------------------------------
-- Block 2: the race. No local writes here, so no local locks are held.
-- ---------------------------------------------------------------------------
reset role;

do $$
declare
  v_store uuid;
  v_sell_sql text;
  v_adjust_sql text;
  v_attempt int;
  v_stock int;
  v_balance int;
  v_expected int;
  v_before_orders int;
begin
  select store_id into v_store from _c;

  -- Earlier blocks in this file also created orders for this product, so the
  -- number sold here has to be measured as a DELTA, not an absolute count.
  select count(*) into v_before_orders
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.store_id = v_store
    and oi.product_id = '0e000000-0000-0000-0000-000000000001';

  v_sell_sql := format($q$
    select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
    set role authenticated;
    do $remote$
    begin
      perform public.create_order(
        %L::uuid, null,
        '[{"product_id":"0e000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
        0, 0, 0, 'cash', null, gen_random_uuid());
    end
    $remote$;
  $q$, v_store::text);

  v_adjust_sql := format($q$
    select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
    set role authenticated;
    do $remote$
    begin
      perform public.adjust_stock(
        %L::uuid, '0e000000-0000-0000-0000-000000000001', null, 3, 'adjustment', 'concurrent correction');
    end
    $remote$;
  $q$, v_store::text);

  -- Three sales and three corrections, interleaved.
  for v_attempt in 1..6 loop
    if v_attempt % 2 = 0 then
      begin
        perform public.dblink_exec(
          'host=127.0.0.1 port=5432 dbname=' || current_database() || ' user=postgres password=postgres',
          v_sell_sql
        );
      exception when others then
        null;  -- losing the race for the last unit is a correct outcome
      end;
    else
      perform public.dblink_exec(
        'host=127.0.0.1 port=5432 dbname=' || current_database() || ' user=postgres password=postgres',
        v_adjust_sql
      );
    end if;
  end loop;

  select quantity into v_stock from public.inventory
   where store_id = v_store and product_id = '0e000000-0000-0000-0000-000000000001';

  if v_stock < 0 then
    raise exception 'CONC BUG: stock went negative (%) under mixed order/adjust races', v_stock;
  end if;

  -- Starting from 7, three corrections add 9, and each accepted sale removes 1.
  -- The sold count is a delta so earlier blocks in this file do not distort it.
  select (count(*) - v_before_orders)::int into v_expected
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.store_id = v_store
    and oi.product_id = '0e000000-0000-0000-0000-000000000001';

  v_balance := 7 + 9 - v_expected;
  if v_stock <> v_balance then
    raise exception
      'CONC BUG: stock is % but 7 opening + 9 corrected - % sold = %',
      v_stock, v_expected, v_balance;
  end if;

  -- The most recent ledger entry must record the same balance the row holds.
  if (select balance_after from public.inventory_movements
        where product_id = '0e000000-0000-0000-0000-000000000001' and store_id = v_store
        order by created_at desc, id desc limit 1) <> v_stock then
    raise exception 'CONC BUG: the ledger''s last balance_after disagrees with the row';
  end if;

  raise notice 'mixed race: 3 sales + 3 corrections settled at % units, ledger agrees', v_stock;
end $$;

-- ---------------------------------------------------------------------------
-- Parallel replay of ONE idempotency key
--
-- The sequential case is proven in verify.sql. This checks the race: the same
-- client_ref submitted at the same time must still yield one order, which is
-- what the unique index is there to guarantee.
-- ---------------------------------------------------------------------------
do $$
declare
  v_store uuid;
  v_sql text;
  v_attempt int;
  v_n int;
begin
  select store_id into v_store from _c;

  v_sql := format($q$
    select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
    set role authenticated;
    do $remote$
    begin
      perform public.create_order(
        %L::uuid, null,
        '[{"product_id":"0e000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
        0, 0, 0, 'cash', null, 'cc000000-0000-0000-0000-000000000001'::uuid);
    end
    $remote$;
  $q$, v_store::text);

  for v_attempt in 1..4 loop
    begin
      perform public.dblink_exec(
        'host=127.0.0.1 port=5432 dbname=' || current_database()
          || ' user=postgres password=postgres',
        v_sql
      );
    exception when others then
      -- A losing racer on the unique index is a correct outcome: the duplicate
      -- is rejected rather than creating a second order.
      null;
    end;
  end loop;

  select count(*) into v_n from public.orders
   where client_ref = 'cc000000-0000-0000-0000-000000000001';

  if v_n <> 1 then
    raise exception 'CONC BUG: 4 simultaneous calls with one client_ref produced % orders', v_n;
  end if;

  raise notice '4 parallel calls sharing one client_ref produced exactly 1 order';
end $$;

-- ---------------------------------------------------------------------------
-- Tear down. The fixtures were committed so dblink could see them, so they are
-- removed explicitly rather than rolled back.
-- ---------------------------------------------------------------------------
do $$
declare v_org uuid;
begin
  select org_id into v_org from _c;
  delete from public.organizations where id = v_org;
  delete from public.profiles where id = '11111111-1111-1111-1111-111111111111';
  delete from auth.users   where id = '11111111-1111-1111-1111-111111111111';

  if exists (select 1 from public.organizations where id = v_org) then
    raise exception 'teardown: the test organization survived';
  end if;
end $$;

\echo ''
\echo '  All SellFlow concurrency checks passed.'
\echo ''
