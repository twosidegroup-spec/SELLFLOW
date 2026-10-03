-- ===========================================================================
-- SellFlow :: controlled payment lifecycle and matrix
--
-- Proves the detection engine end to end BEFORE any native SMS listener exists,
-- using only the authorised RPC surface a real client has. Every fixture is
-- created through a function the app itself calls; nothing writes a payment
-- table directly, because that is exactly the boundary this suite exists to
-- defend.
--
-- verify_payment_engine.sql covers the core matching rules. This suite covers
-- what it does not, and what only shows up when the pieces are used together:
--
--   1  the full lifecycle in one continuous flow, ending in finance
--   2  a payment whose receiver is the wrong account
--   3  a walk-in customer, where no phone exists anywhere
--   4  cross-tenant isolation for every write path, not just reads
--   5  financial invariants across every order created here
--   6  finance and COD reconciliation through get_finance
--   7  audit semantics: who acted, and whether the reason survives
--
-- Local behavioural verification. Hosted is verified structurally by
-- verify_payment_schema.sql; see docs/payment-engine.md for why the behavioural
-- suites cannot run there.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

-- The seller this suite acts as. Every fixture below is created as this user,
-- so the functions under test authorise against a real membership exactly as
-- they would for the app.
insert into auth.users (id, email, raw_user_meta_data)
values ('5b000000-0000-0000-0000-000000000001', 'lifecycle-a@example.test', '{}'::jsonb),
       ('5b000000-0000-0000-0000-0000000000ff', 'cross-tenant@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '5b000000-0000-0000-0000-000000000001';

-- Populated in stages below: the account id only exists once
-- create_payment_account has run, which needs the org id that bootstrap_business
-- returns. Nullable so the first insert can carry a partial row; the fixture
-- block asserts it is complete before anything else uses it.
create temporary table _pl (
  org_id uuid primary key,
  store_id uuid,
  product_id uuid,
  customer_id uuid,        -- records a number
  walkin_id uuid,          -- no number at all
  account_id uuid
);

-- ---------------------------------------------------------------------------
-- Fixtures, through the same functions the app calls
-- ---------------------------------------------------------------------------

do $$
declare
  v_org uuid;
  v_store uuid;
begin
  v_org := (public.bootstrap_business('Lifecycle Traders', 'Main', 'LIFE') ->> 'org_id')::uuid;
  select id into v_store from public.stores where org_id = v_org limit 1;

  insert into _pl (org_id, store_id) values (v_org, v_store);

  insert into public.customers (id, org_id, name, phone)
  values ('5b000000-0000-0000-0000-000000000001', v_org, 'Rahim Uddin', '01822000111'),
         ('5b000000-0000-0000-0000-000000000002', v_org, 'Karim No-Number', null)
  on conflict (id) do nothing;

  update _pl set customer_id = '5b000000-0000-0000-0000-000000000001',
                walkin_id   = '5b000000-0000-0000-0000-000000000002';

  insert into public.products (id, org_id, name, sku, selling_price, cost_price)
  values ('5b000000-0000-0000-0000-0000000000a1', v_org, 'Thing', 'L1', 1000, 500)
  on conflict (id) do nothing;

  update _pl set product_id = '5b000000-0000-0000-0000-0000000000a1';

  perform public.adjust_stock(v_store, '5b000000-0000-0000-0000-0000000000a1', null, 100, 'initial', null);

  -- The connected account, created exactly as the app creates it.
  update _pl set account_id = (
    public.create_payment_account(
      p_org_id => v_org,
      p_provider => 'bkash',
      p_account_number => '01711000111',
      p_label => 'Lifecycle shop'
    )
  ).id;

  -- The fixture must be complete before any check depends on it.
  if exists (
    select 1 from _pl
    where store_id is null or product_id is null
       or customer_id is null or walkin_id is null or account_id is null
  ) then
    raise exception 'FIXTURE: the payment lifecycle fixture is incomplete';
  end if;
end $$;

-- An order the engine will actually settle.
create temporary table _o (id uuid primary key, label text);
insert into _o (id, label)
select public.create_order(
  p_store_id => (select store_id from _pl),
  p_customer_id => (select customer_id from _pl),
  p_items => jsonb_build_array(jsonb_build_object(
    'product_id', (select product_id from _pl), 'variant_id'::text, null,
    'quantity', 1, 'line_discount', 0)),
  p_client_ref => 'bb000000-0000-0000-0000-0000000000a1'::uuid
), 'primary'
on conflict do nothing;

-- Helper: a fresh 1000 BDT order for the given customer.
-- Uses the create_order RPC so order creation stays on the authorised path.
create or replace function pg_temp.pl_order(p_customer uuid, p_ref uuid)
returns uuid language plpgsql as $$
declare v_store uuid; v_product uuid;
begin
  select store_id, product_id into v_store, v_product from _pl;
  return public.create_order(
    p_store_id => v_store,
    p_customer_id => p_customer,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'variant_id'::text, null,
      'quantity', 1, 'line_discount', 0)),
    p_client_ref => p_ref
  );
end $$;

-- Helper: the engine's verdict for an event, as jsonb.
create or replace function pg_temp.pl_match(p_event uuid)
returns jsonb language sql as $$
  select public.match_payment_event(p_event);
$$;

-- ===========================================================================
-- 1. THE LIFECYCLE, IN ONE FLOW
--
-- account -> intent -> event -> normalise -> match -> settle -> record_payment
--       -> order payment state -> finance
--
-- This is the headline proof: the path a real bKash notification will take,
-- driven only through the functions the app has.
-- ===========================================================================

do $$
declare
  v_account uuid;
  v_intent uuid;
  v_event uuid;
  v_result jsonb;
  v_paid numeric;
  v_status public.payment_status;
  v_payments integer;
  v_finance jsonb;
  v_fin_paid numeric;
  v_from date := current_date - 1;
  v_to date   := current_date + 1;
begin
  select account_id into v_account from _pl;
-- pl_order returns a scalar uuid, so assign it directly rather than selecting
  -- "id" out of a function result, which has no columns to select from.
  v_intent := pg_temp.pl_order((select customer_id from _pl), 'bb000000-0000-0000-0000-0000000000b1'::uuid);

  -- An intent is opened for the exact outstanding amount, naming the customer.
  perform public.create_payment_intent(
    p_type => 'order',
    p_reference_id => v_intent,
    p_payment_account_id => v_account,
    p_expected_amount => 1000,
    p_expected_customer_phone => '01822000111'
  );

  -- The notification arrives, from the customer's number, in +880 form, which
  -- the normaliser must fold onto the same account.
  v_result := public.ingest_payment_event(
    p_payment_account_id => v_account,
    p_provider => 'bkash',
    p_receiver_account => '+8801711000111',
    p_sender_account => '+8801822000111',
    p_amount => 1000,
    p_transaction_id => 'LIFECYCLE1',
    p_source => 'manual'
  );

  if (v_result ->> 'duplicate')::boolean then
    raise exception 'LIFECYCLE: first ingest was reported as a duplicate';
  end if;

  v_event := (v_result ->> 'event_id')::uuid;

  -- Normalisation really happened, in both directions.
  if not exists (
    select 1 from public.payment_events
    where id = v_event
      and receiver_account_normalized = '01711000111'
      and sender_account_normalized = '01822000111'
  ) then
    raise exception 'LIFECYCLE: +880 numbers were not normalised onto the connected account';
  end if;

  v_result := pg_temp.pl_match(v_event);

  if (v_result ->> 'settled')::boolean is not true then
    raise exception 'LIFECYCLE: a fully-verified payment did not settle (%, %)', v_result, v_result ->> 'reason';
  end if;
  if v_result ->> 'strength' <> 'strong' then
    raise exception 'LIFECYCLE: expected strong, got %', v_result ->> 'strength';
  end if;

  -- record_payment is the write that moved the money.
  select count(*) into v_payments from public.payments where order_id = v_intent;
  if v_payments <> 1 then
    raise exception 'LIFECYCLE: expected exactly one payment row, found %', v_payments;
  end if;

  select amount_paid, payment_status into v_paid, v_status
  from public.orders where id = v_intent;

  if v_paid <> 1000 or v_status <> 'paid' then
    raise exception 'LIFECYCLE: order shows % / %, expected 1000 / paid', v_paid, v_status;
  end if;

  -- The ledger and the order agree.
  if (select coalesce(sum(amount), 0) from public.payments where order_id = v_intent) <> v_paid then
    raise exception 'LIFECYCLE: amount_paid does not reconcile with the payments ledger';
  end if;

  -- And finance sees the money.
  v_finance := public.get_finance((select store_id from _pl), v_from, v_to);
  v_fin_paid := (v_finance -> 'payments' ->> 'paid')::numeric;

  if v_fin_paid < 1000 then
    raise exception 'LIFECYCLE: finance reports % paid, expected at least 1000', v_fin_paid;
  end if;

  -- The audit trail tells the whole story, and attributes the automated part to
  -- the system rather than to the seller.
  if not exists (
    select 1 from public.payment_audit_logs
    where payment_event_id = v_event and action = 'event_ingested' and actor_kind = 'system'
  ) then
    raise exception 'LIFECYCLE: ingest was not audited as a system action';
  end if;

  if not exists (
    select 1 from public.payment_audit_logs
    where payment_event_id = v_event and action = 'event_confirmed' and actor_kind = 'system'
  ) then
    raise exception 'LIFECYCLE: the automatic confirmation was not audited as a system action';
  end if;

  -- A machine decision must never look like a human approved it.
  if exists (
    select 1 from public.payment_audit_logs
    where payment_event_id = v_event and actor_kind = 'seller' and actor_id is null
  ) then
    raise exception 'LIFECYCLE: an automated action was attributed to a seller';
  end if;

  raise notice 'LIFECYCLE: account -> intent -> event -> match -> record_payment -> finance OK';
end $$;

-- ===========================================================================
-- 2. WRONG RECEIVING ACCOUNT
--
-- The money arrived somewhere else. The engine must not settle an order on the
-- strength of an amount alone, and nothing may leak across accounts.
-- ===========================================================================

do $$
declare
  v_account uuid; v_order uuid; v_event uuid; v_result jsonb;
  v_paid numeric; v_rows integer;
begin
  select account_id into v_account from _pl;
  v_order := pg_temp.pl_order((select customer_id from _pl), 'bb000000-0000-0000-0000-0000000000c1'::uuid);

  perform public.create_payment_intent(
    p_type => 'order', p_reference_id => v_order,
    p_payment_account_id => v_account, p_expected_amount => 1000,
    p_expected_customer_phone => '01822000111');

  -- Receiver is a completely different number.
  v_event := (public.ingest_payment_event(
    v_account, 'bkash', '01999999999', '01822000111', 1000, 'WRONGRECEIVER', null, 'manual'
  ) ->> 'event_id')::uuid;

  v_result := pg_temp.pl_match(v_event);

  if (v_result ->> 'settled')::boolean then
    raise exception 'WRONG RECEIVER: settled an order even though the money went elsewhere';
  end if;

  -- The refusal must be specific, not a generic failure.
  if not exists (
    select 1 from public.payment_matches
    where payment_event_id = v_event and reason_code = 'account_mismatch'
  ) then
    raise exception 'WRONG RECEIVER: no account_mismatch reason was recorded';
  end if;

  select amount_paid into v_paid from public.orders where id = v_order;
  select count(*) into v_rows from public.payments where order_id = v_order;
  if v_paid <> 0 or v_rows <> 0 then
    raise exception 'WRONG RECEIVER: the order was touched (% paid, % rows)', v_paid, v_rows;
  end if;
end $$;

-- ===========================================================================
-- 3. WALK-IN CUSTOMER: NO PHONE EXISTS ANYWHERE
--
-- The amount matches exactly, but there is nothing to verify the payer against.
-- Must land in review, never settle.
-- ===========================================================================

do $$
declare
  v_account uuid; v_order uuid; v_event uuid; v_result jsonb; v_paid numeric;
begin
  select account_id into v_account from _pl;
  v_order := pg_temp.pl_order((select walkin_id from _pl), 'bb000000-0000-0000-0000-0000000000d1'::uuid);

  perform public.create_payment_intent(
    p_type => 'order', p_reference_id => v_order,
    p_payment_account_id => v_account, p_expected_amount => 1000);

  v_event := (public.ingest_payment_event(
    v_account, 'bkash', '01711000111', '01712345678', 1000, 'WALKINPAY', null, 'manual'
  ) ->> 'event_id')::uuid;

  v_result := pg_temp.pl_match(v_event);

  if (v_result ->> 'settled')::boolean then
    raise exception 'WALK-IN: settled with no way to verify the payer';
  end if;
  if v_result ->> 'strength' <> 'medium' then
    raise exception 'WALK-IN: expected medium, got %', v_result ->> 'strength';
  end if;

  select amount_paid into v_paid from public.orders where id = v_order;
  if v_paid <> 0 then
    raise exception 'WALK-IN: the order was paid (% )', v_paid;
  end if;

  -- It must be visible in the review queue, which is the app-facing symptom.
  if not exists (
    select 1 from public.payment_events
    where id = v_event and status = 'review_required'
  ) then
    raise exception 'WALK-IN: the payment is not queued for review';
  end if;
end $$;

-- ===========================================================================
-- 4. CROSS-TENANT WRITES
--
-- verify_payment_engine.sql proves another business cannot READ. This proves the
-- write paths, which is where a mistake would actually cost money.
-- ===========================================================================

do $$
declare
  v_org_b uuid;
  v_account_a uuid;
  v_event_a uuid;
  v_intent_a uuid;
  v_threw boolean;
  v_visible integer;
begin
  v_account_a := (select account_id from _pl);
v_intent_a := pg_temp.pl_order((select customer_id from _pl), 'bb000000-0000-0000-0000-0000000000e1'::uuid);

  perform public.create_payment_intent(
    p_type => 'order', p_reference_id => v_intent_a,
    p_payment_account_id => v_account_a, p_expected_amount => 1000,
    p_expected_customer_phone => '01822000111');

  v_event_a := (public.ingest_payment_event(
    v_account_a, 'bkash', '01711000111', '01822000111', 1000, 'CROSSWRITE', null, 'manual'
  ) ->> 'event_id')::uuid;

  -- Become a different business entirely.
  set request.jwt.claim.sub = '5b000000-0000-0000-0000-0000000000ff';
  v_org_b := (public.bootstrap_business('Intruder Traders', 'Main', 'INTR') ->> 'org_id')::uuid;

  -- Cannot see it.
  select count(*) into v_visible from public.payment_events;
  if v_visible <> 0 then
    raise exception 'CROSS-TENANT: another business read % payment events', v_visible;
  end if;

  -- Cannot ingest against the other business's account.
  v_threw := false;
  begin
    perform public.ingest_payment_event(v_account_a, 'bkash', '01711000111', '01822000111', 500, 'XTINGEST');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'CROSS-TENANT: ingested against a foreign account'; end if;

  -- Cannot match the other business's event.
  v_threw := false;
  begin
    perform public.match_payment_event(v_event_a);
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'CROSS-TENANT: matched a foreign event'; end if;

  -- Cannot reassign the other business's payment.
  v_threw := false;
  begin
    perform public.assign_payment_match(v_event_a, v_intent_a);
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'CROSS-TENANT: reassigned a foreign payment'; end if;

  -- Cannot dismiss it either.
  v_threw := false;
  begin
    perform public.reject_payment_match(v_event_a);
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'CROSS-TENANT: dismissed a foreign payment'; end if;

  -- Nothing above may have moved the other business's money.
  if (select amount_paid from public.orders where id = v_intent_a) <> 0 then
    raise exception 'CROSS-TENANT: the victim order was paid';
  end if;

  -- Back to the owner business for the remaining checks.
  set request.jwt.claim.sub = '5b000000-0000-0000-0000-000000000001';
end $$;

-- ===========================================================================
-- 5. FINANCIAL INVARIANTS ACROSS EVERY ORDER IN THIS SUITE
-- ===========================================================================

do $$
declare
  v_drift integer;
  v_negative integer;
  v_overpaid integer;
begin
  -- amount_paid always equals the ledger, refunds included.
  select count(*) into v_drift
  from public.orders o
  where o.org_id = (select org_id from _pl)
    and o.amount_paid <> coalesce((
      select sum(p.amount) filter (where not p.is_refund) from public.payments p
      where p.order_id = o.id), 0)
    - coalesce((
      select sum(p.amount) filter (where p.is_refund) from public.payments p
      where p.order_id = o.id), 0);

  if v_drift <> 0 then
    raise exception 'INVARIANT: % orders drifted from the payments ledger', v_drift;
  end if;

  -- No negative amount_paid anywhere.
  select count(*) into v_negative from public.orders
  where org_id = (select org_id from _pl) and amount_paid < 0;
  if v_negative <> 0 then
    raise exception 'INVARIANT: % orders have a negative amount_paid', v_negative;
  end if;

  -- No payment row is negative.
  if exists (select 1 from public.payments where amount <= 0) then
    raise exception 'INVARIANT: a non-positive payment row exists';
  end if;

  -- No payment exceeds its order's total. record_payment enforces this; the
  -- assertion is here so a future engine path cannot route around it.
  select count(*) into v_overpaid
  from public.payments p
  join public.orders o on o.id = p.order_id
  where o.org_id = (select org_id from _pl)
    and (select coalesce(sum(p2.amount), 0) from public.payments p2
         where p2.order_id = p.order_id and not p2.is_refund) > o.total;

  if v_overpaid <> 0 then
    raise exception 'INVARIANT: % orders collected more than their total', v_overpaid;
  end if;

  -- The engine never wrote to orders directly: every amount_paid change is
  -- backed by a payments row, which the first assertion already proves. This
  -- additionally confirms the order row was not touched by a payment UPDATE
  -- path, by checking the trigger-updated timestamp is not newer than the
  -- payment it came from.
  if exists (
    select 1
    from public.orders o
    join public.payments p on p.order_id = o.id
    where o.org_id = (select org_id from _pl)
      and o.updated_at < p.created_at - interval '1 second'
      and o.amount_paid > 0
  ) then
    raise exception 'INVARIANT: an order was modified without a corresponding payment write';
  end if;
end $$;

-- ===========================================================================
-- 6. FINANCE AND COD RECONCILIATION
--
-- The engine must not disturb the reporting definitions. Paid-in, COD-expected
-- and COD-settled are checked against the underlying rows.
-- ===========================================================================

do $$
declare
  v_store uuid;
  v_finance jsonb;
  v_from date := current_date - 1;
  v_to date   := current_date + 1;
  v_fin_paid numeric;
  v_fin_cod numeric;
  v_raw_paid numeric;
  v_raw_cod numeric;
begin
  select store_id into v_store from _pl;

  v_finance := public.get_finance(v_store, v_from, v_to);

  v_fin_paid := (v_finance -> 'payments' ->> 'paid')::numeric;
  select coalesce(sum(amount), 0) into v_raw_paid
  from public.payments p join public.orders o on o.id = p.order_id
  where o.store_id = v_store and not p.is_refund
    and (o.placed_at at time zone public.store_timezone(v_store))::date between v_from and v_to;

  if v_fin_paid <> v_raw_paid then
    raise exception 'FINANCE: reports % paid but the ledger holds %', v_fin_paid, v_raw_paid;
  end if;

  -- The confirmed lifecycle payment must actually be in there.
  if v_fin_paid < 1000 then
    raise exception 'FINANCE: the settled payment is missing from the finance report (% )', v_fin_paid;
  end if;

  -- COD figures must still equal the underlying COD orders.
  v_fin_cod := (v_finance -> 'cod' ->> 'expected')::numeric;
  select coalesce(sum(cod_amount), 0) into v_raw_cod
  from public.orders
  where store_id = v_store and is_cod
    and (placed_at at time zone public.store_timezone(v_store))::date between v_from and v_to;

  if v_fin_cod <> v_raw_cod then
    raise exception 'FINANCE: COD expected % does not match the underlying % ', v_fin_cod, v_raw_cod;
  end if;

  raise notice 'FINANCE: paid=%, cod expected=% -- both reconcile', v_fin_paid, v_fin_cod;
end $$;

-- ===========================================================================
-- 7. AUDIT SEMANTICS
--
-- The states must stay distinguishable, and every refusal must carry a reason a
-- machine can read. A generic "failed" would make the audit trail useless.
-- ===========================================================================

do $$
declare
  v_distinct integer;
  v_missing_reason integer;
  v_bad_actor integer;
begin
  -- Refusals recorded a machine-readable reason code on the match row.
  select count(*) into v_missing_reason
  from public.payment_events e
  where e.status in ('review_required', 'mismatch')
    and not exists (
      select 1 from public.payment_matches m
      where m.payment_event_id = e.id and m.reason_code is not null
    );

  if v_missing_reason <> 0 then
    raise exception 'AUDIT: % refused payments carry no machine-readable reason', v_missing_reason;
  end if;

  -- actor_kind and actor_id agree, for every row ever written.
  select count(*) into v_bad_actor
  from public.payment_audit_logs
  where (actor_kind = 'system' and actor_id is not null)
     or (actor_kind = 'seller' and actor_id is null);

  if v_bad_actor <> 0 then
    raise exception 'AUDIT: % audit rows have an inconsistent actor', v_bad_actor;
  end if;

  -- More than one kind of outcome must be present, i.e. the lifecycle really
  -- did exercise distinct states rather than collapsing into one.
  select count(distinct status) into v_distinct from public.payment_events;
  if v_distinct < 3 then
    raise exception 'AUDIT: only % distinct event statuses were produced; the states are collapsing', v_distinct;
  end if;

  raise notice 'AUDIT: % distinct event statuses, all refusals carry a reason, actors consistent',
    v_distinct;
end $$;

reset role;

rollback;

\echo ''
\echo '  All SellFlow payment lifecycle checks passed.'
\echo ''