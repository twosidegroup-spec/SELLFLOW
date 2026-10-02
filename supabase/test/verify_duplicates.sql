-- ===========================================================================
-- SellFlow :: duplicate customer matching
--
-- find_duplicate_customers exists and is granted, but until now nothing in the
-- app called it -- the customer form inserted directly, so a repeat phone
-- number silently created a second record. It is now wired into the form. This
-- suite pins the MATCHING RULES so the UI's behaviour cannot drift.
--
-- The rules being defended, and why each matters to a real seller:
--
--   exact phone            -> almost certainly the same person; must be found
--   same name, other phone -> probably a DIFFERENT person; must not be merged
--   same name + address    -> still not proof; people share addresses
--   no signal              -> no candidates, create freely
--
-- Nothing here ever merges or deletes. The function is advisory; the seller
-- makes the decision, and that is asserted by checking the function performs no
-- writes at all.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data)
values ('11111111-1111-1111-1111-111111111111', 'dup@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

create temporary table _d (org_id uuid primary key);
insert into _d select (public.bootstrap_business('Dup Traders', 'Main', 'DUP') ->> 'org_id')::uuid;

insert into public.customers (id, org_id, name, phone, address, district, thana)
select '20000000-0000-0000-0000-000000000001'::uuid, org_id, 'Rahim Uddin', '01711000111', 'House 1, Road 1', 'Dhaka', 'Uttara' from _d
union all
-- Same name, DIFFERENT phone, same address. A family member, or two people at
-- one address. Either way it is not proof of identity.
select '20000000-0000-0000-0000-000000000002'::uuid, org_id, 'Rahim Uddin', '01822000222', 'House 1, Road 1', 'Dhaka', 'Uttara' from _d
union all
-- Same name, no phone at all.
select '20000000-0000-0000-0000-000000000003'::uuid, org_id, 'Rahim Uddin', null, null, null, null from _d
union all
-- Entirely different person.
select '20000000-0000-0000-0000-000000000004'::uuid, org_id, 'Karim Hossain', '01933000333', 'House 9, Road 9', 'Dhaka', 'Mirpur' from _d;

-- Give the first Rahim some history, so ordering by order count is testable.
do $$
declare v_store uuid; v_customer uuid; v_order uuid;
begin
  select id into v_store from public.stores where org_id = (select org_id from _d) limit 1;
  select id into v_customer from public.customers
   where id = '20000000-0000-0000-0000-000000000001';

  insert into public.products (id, org_id, name, sku, selling_price, cost_price)
  select '21000000-0000-0000-0000-000000000001'::uuid, org_id, 'Thing', 'T1', 100, 50 from _d;

  perform public.adjust_stock(v_store, '21000000-0000-0000-0000-000000000001', null, 50, 'initial', null);

  v_order := public.create_order(
    p_store_id => v_store, p_customer_id => v_customer,
    p_items => '[{"product_id":"21000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    p_client_ref => 'dd000000-0000-0000-0000-0000000000d1'::uuid
  );

  perform public.set_order_status(v_order, 'confirmed');
end $$;

-- ===========================================================================
-- 1. Exact phone match finds the record
-- ===========================================================================
do $$
declare
  v_org uuid;
  v_rows jsonb;
begin
  select org_id into v_org from _d;

  -- Written with different formatting on purpose: a seller types
  -- 017-11000111, the record holds 01711000111. They are the same person.
  v_rows := public.find_duplicate_customers(v_org, 'Anyone', '+880 1711-000111', 5);

  if jsonb_array_length(v_rows) = 0 then
    raise exception 'DUP: an exact phone match was not found';
  end if;

  if v_rows -> 0 ->> 'id' <> '20000000-0000-0000-0000-000000000001' then
    raise exception 'DUP: phone match resolved to the wrong customer (% / %)',
      v_rows -> 0 ->> 'name', v_rows -> 0 ->> 'phone';
  end if;

  if (v_rows -> 0 ->> 'order_count')::int <> 1 then
    raise exception 'DUP: the candidate did not report its order history';
  end if;
end $$;

-- ===========================================================================
-- 2. Same name, different phone is surfaced but NOT ranked as a phone match
--
-- The function must return these so the seller can judge, but the UI shows
-- them under a weaker heading. The ranking puts the phone match first, which is
-- what the UI relies on to lead with the strongest signal.
-- ===========================================================================
do $$
declare
  v_org uuid;
  v_rows jsonb;
  v_ids text[];
begin
  select org_id into v_org from _d;
  v_rows := public.find_duplicate_customers(v_org, 'Rahim Uddin', '01711000111', 5);

  -- All three Rahims are name matches, so all three are candidates.
  if jsonb_array_length(v_rows) < 3 then
    raise exception 'DUP: expected at least 3 name matches, got %', jsonb_array_length(v_rows);
  end if;

  -- The phone match must lead, because it is the strongest signal.
  if v_rows -> 0 ->> 'id' <> '20000000-0000-0000-0000-000000000001' then
    raise exception 'DUP: the exact phone match was not ranked first';
  end if;

  -- The other two Rahims must be present but behind it.
  select array_agg(elem ->> 'id') into v_ids from jsonb_array_elements(v_rows) elem;
  if not ('20000000-0000-0000-0000-000000000002' = any(v_ids)) then
    raise exception 'DUP: the same-name/different-phone customer was filtered out';
  end if;
  if not ('20000000-0000-0000-0000-000000000003' = any(v_ids)) then
    raise exception 'DUP: the same-name/no-phone customer was filtered out';
  end if;

  -- A different person must never appear.
  if '20000000-0000-0000-0000-000000000004' = any(v_ids) then
    raise exception 'DUP: an unrelated customer was returned as a possible duplicate';
  end if;
end $$;

-- ===========================================================================
-- 3. Same name and address but a different phone is still only a CANDIDATE
--
-- Asserted as a non-action: the function returns the record so the seller can
-- see it, and nothing more. There is no merge path, so the assertion is that the
-- three separate Rahim records still exist untouched afterwards.
-- ===========================================================================
do $$
declare v_org uuid; v_rows jsonb; v_n int;
begin
  select org_id into v_org from _d;
  v_rows := public.find_duplicate_customers(v_org, 'Rahim Uddin', '01822000222', 5);

  if jsonb_array_length(v_rows) = 0 then
    raise exception 'DUP: a same-name/same-address customer was not surfaced';
  end if;

  -- Critical: the check must not have merged or rewritten anything.
  select count(*) into v_n from public.customers where name = 'Rahim Uddin';
  if v_n <> 3 then
    raise exception
      'DUP BUG: the duplicate check changed the data. % Rahim records exist, expected 3.',
      v_n;
  end if;
end $$;

-- ===========================================================================
-- 4. No signal means no candidates -- creating freely is allowed
-- ===========================================================================
do $$
declare v_org uuid; v_rows jsonb;
begin
  select org_id into v_org from _d;

  -- A name and phone that match nobody.
  v_rows := public.find_duplicate_customers(v_org, 'Zzzzz Unique', '01500000000', 5);
  if jsonb_array_length(v_rows) <> 0 then
    raise exception 'DUP: % spurious candidate(s) returned for a genuinely new customer',
      jsonb_array_length(v_rows);
  end if;

  -- Empty input must not blow up or match everyone.
  v_rows := public.find_duplicate_customers(v_org, '', '', 5);
  if jsonb_array_length(v_rows) <> 0 then
    raise exception 'DUP: empty input returned % candidates', jsonb_array_length(v_rows);
  end if;
end $$;

-- ===========================================================================
-- 5. The check is READ ONLY
--
-- It runs as SECURITY DEFINER, which is exactly why this matters: a definer
-- function can write regardless of the caller's permissions. A duplicate
-- *check* that mutated data would be indefensible. The function is declared
-- STABLE, so a write would not even be permitted; this asserts the guarantee
-- holds end to end.
-- ===========================================================================
do $$
declare
  v_volatile text;
  v_rows jsonb;
  v_org uuid;
  v_before text;
  v_after text;
begin
  -- STABLE is the correct declaration: the result depends on table contents but
  -- cannot change within a statement. IMMUTABLE would be a lie, VOLATILE would
  -- promise nothing.
  select p.provolatile into v_volatile
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'find_duplicate_customers';

  if v_volatile <> 's' then
    raise exception
      'DUP BUG: find_duplicate_customers is volatility %, expected stable (s)',
      v_volatile;
  end if;

  -- STABLE alone does not forbid writes, so the read-only guarantee is proven
  -- behaviourally: a full snapshot of the table must be byte-identical after the
  -- function has been called.
  select org_id into v_org from _d;

  select string_agg(c::text, '|' order by c.id) into v_before from public.customers c;

  v_rows := public.find_duplicate_customers(v_org, 'Rahim Uddin', '01711000111', 5);
  perform 1 from jsonb_array_elements(v_rows);

  select string_agg(c::text, '|' order by c.id) into v_after from public.customers c;

  if v_before is distinct from v_after then
    raise exception 'DUP BUG: the duplicate check modified the customers table';
  end if;

  -- The order attached to the candidate must still be attached to them, i.e.
  -- the check must not have re-pointed or dropped history.
  if not exists (
    select 1 from public.customers c
    where c.id = '20000000-0000-0000-0000-000000000001'
      and (select count(*) from public.orders o where o.customer_id = c.id) = 1
  ) then
    raise exception 'DUP BUG: the duplicate check disturbed a customer''s order history';
  end if;
end $$;

-- ===========================================================================
-- 6. It is tenant scoped
--
-- Another seller asking about the same name and phone must be told nothing.
-- ===========================================================================
insert into auth.users (id, email, raw_user_meta_data)
values ('22222222-2222-2222-2222-222222222222', 'dup-b@example.test', '{}'::jsonb);

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare
  v_org uuid;
  v_rows jsonb;
  v_threw boolean := false;
begin
  select (public.bootstrap_business('Other Traders', 'Main', 'OTH') ->> 'org_id')::uuid into v_org;

  -- Within their own business the query is fine.
  v_rows := public.find_duplicate_customers(v_org, 'Rahim Uddin', '01711000111', 5);
  if jsonb_array_length(v_rows) <> 0 then
    raise exception 'DUP: seller B found % of seller A''s customers', jsonb_array_length(v_rows);
  end if;

  -- Naming seller A's org must be refused outright.
  begin
    perform public.find_duplicate_customers(
      (select org_id from public.organizations where name = 'Dup Traders'),
      'Rahim Uddin', '01711000111', 5
    );
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'DUP BUG: seller B was able to search another organization';
  end if;
end $$;

reset role;

rollback;

\echo ''
\echo '  All SellFlow duplicate-customer checks passed.'
\echo ''
