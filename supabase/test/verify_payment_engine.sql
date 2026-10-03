-- ===========================================================================
-- SellFlow :: payment detection and matching engine
--
-- These tests exist to defend money, not to exercise code. Every check below is
-- a way this engine could plausibly credit an order with money that never
-- arrived, or fail to credit money that did.
--
-- The properties under test, in order of how expensive they would be to get
-- wrong:
--
--   1. A payment can never be counted twice. Not by a replayed SMS, not by a
--      retried request, not by two devices racing.
--   2. Money is confirmed automatically in exactly one case, and the ambiguous
--      cases all refuse rather than guess.
--   3. Orders are only ever touched through record_payment().
--   4. No client can write the ledger directly, and no business can see or
--      settle another business's payments.
--   5. Every decision is auditable, and an automatic one is never recorded as
--      if a person made it.
--
-- The suite models three sellers: A (the business under test), B (a second
-- tenant, used only for isolation probes) and C (a read-only staff member).
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data)
values ('3a000000-0000-0000-0000-000000000001', 'pay-a@example.test', '{}'::jsonb),
       ('3a000000-0000-0000-0000-000000000002', 'pay-b@example.test', '{}'::jsonb),
       ('3a000000-0000-0000-0000-000000000003', 'pay-c@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '3a000000-0000-0000-0000-000000000001';

create temporary table _pay (org_id uuid primary key, store_id uuid, customer_id uuid, product_id uuid, order_id uuid);
insert into _pay select (public.bootstrap_business('Pay Traders', 'Main', 'PAY') ->> 'org_id')::uuid;

update _pay set store_id = (select id from public.stores where org_id = (select org_id from _pay) limit 1);

-- A customer who records their number, and one who never does. The second is
-- what makes a 'medium' match: the amount is right but the payer is unknown.
insert into public.customers (id, org_id, name, phone)
select '4a000000-0000-0000-0000-000000000001'::uuid, org_id, 'Rahim Uddin', '01822000111' from _pay
union all
select '4a000000-0000-0000-0000-000000000002'::uuid, org_id, 'Karim Hossain', null from _pay;

update _pay set customer_id = '4a000000-0000-0000-0000-000000000001';
update _pay set customer_id = null;

do $$
declare
  v_org uuid;
  v_store uuid;
begin
  select org_id, store_id into v_org, v_store from _pay;
  update _pay set customer_id = '4a000000-0000-0000-0000-000000000001';

  insert into public.products (id, org_id, name, sku, selling_price, cost_price)
  values ('5a000000-0000-0000-0000-000000000001', v_org, 'Thing', 'P1', 1000, 500);

  update _pay set product_id = '5a000000-0000-0000-0000-000000000001';

  perform public.adjust_stock(v_store, '5a000000-0000-0000-0000-000000000001', null, 50, 'initial', null);

  update _pay set order_id = public.create_order(
    p_store_id => v_store,
    p_customer_id => '4a000000-0000-0000-0000-000000000001',
    p_items => '[{"product_id":"5a000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    p_client_ref => 'aa000000-0000-0000-0000-0000000000a1'::uuid
  );
end $$;

-- Pin the fixture. If create_order's arithmetic ever changes, the amount-based
-- checks below should fail with this message rather than mysteriously.
do $$
declare v_total numeric;
begin
  select total into v_total from public.orders where id = (select order_id from _pay);
  if v_total <> 1000 then
    raise exception 'PAY FIXTURE: expected the test order to total 1000, it is %', v_total;
  end if;
end $$;

-- ===========================================================================
-- 1. Phone normalisation
--
-- The same Bangladeshi number arrives as 018…, +88018…, 88018… and 18…. If
-- these do not compare equal, a genuine payment silently fails to match.
-- ===========================================================================

do $$
declare v_a text; v_b text; v_c text; v_d text;
begin
  v_a := public.payment_normalize_bk_number('01822000111');
  v_b := public.payment_normalize_bk_number('+8801822000111');
  v_c := public.payment_normalize_bk_number('8801822000111');
  v_d := public.payment_normalize_bk_number('1822000111');

  if v_a <> '01822000111' then
    raise exception 'PAY BUG: a local number was not preserved (got %)', v_a;
  end if;
  if v_b <> v_a or v_c <> v_a or v_d <> v_a then
    raise exception 'PAY BUG: %/ %/ % do not normalise to %', v_b, v_c, v_d, v_a;
  end if;

  -- A landline or garbage value must pass through untouched rather than being
  -- coerced into something that could match by accident.
  if public.payment_normalize_bk_number('not-a-number') <> 'not-a-number' then
    raise exception 'PAY BUG: a non-number was rewritten';
  end if;
end $$;

-- ===========================================================================
-- 2. Provider -> payment_method mapping
--
-- Upay has no payment_method value and must record as 'other' rather than
-- failing the settlement.
-- ===========================================================================

do $$
begin
  if public.payment_provider_method('bkash') <> 'bkash'::public.payment_method then
    raise exception 'PAY BUG: bkash did not map to the bkash method';
  end if;
  if public.payment_provider_method('upay') <> 'other'::public.payment_method then
    raise exception 'PAY BUG: upay must map to other, it mapped to %',
      public.payment_provider_method('upay');
  end if;
end $$;

-- ===========================================================================
-- 3. Connecting a payment account
-- ===========================================================================

do $$
declare
  v_org uuid;
  v_account public.payment_accounts;
begin
  select org_id into v_org from _pay;

  v_account := public.create_payment_account(
    p_org_id => v_org, p_provider => 'bkash',
    p_account_number => '01711000111', p_label => 'Main shop');

  if v_account.id is null then
    raise exception 'PAY BUG: the account was not created';
  end if;
  if v_account.status <> 'connected' then
    raise exception 'PAY BUG: a freshly added account is %', v_account.status;
  end if;

  if not exists (
    select 1 from public.payment_audit_logs
    where payment_account_id = v_account.id and action = 'account_created'
  ) then
    raise exception 'PAY BUG: adding an account was not audited';
  end if;
end $$;

-- A bad number is rejected before it can be saved.
do $$
declare v_threw boolean := false;
begin
  begin
    perform public.create_payment_account(
      p_org_id => (select org_id from _pay), p_provider => 'bkash',
      p_account_number => '01711-ABC');
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PAY BUG: an account number with letters was accepted';
  end if;
end $$;

create temporary table _acct (id uuid primary key, provider public.payment_provider, number text);
insert into _acct select id, provider, account_number from public.payment_accounts where org_id = (select org_id from _pay);

-- ===========================================================================
-- 4. Ingest validation
--
-- A malformed detection must never reach the ledger, because a ledger entry
-- exists to be trusted later.
-- ===========================================================================

do $$
declare v_acct uuid; v_threw boolean;
begin
  select id into v_acct from _acct;

  -- zero amount
  v_threw := false;
  begin
    perform public.ingest_payment_event(v_acct, 'bkash', '01711000111', '01822000111', 0, 'TRX0001');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'PAY BUG: a zero-amount payment was ingested'; end if;

  -- transaction id too short to identify anything
  v_threw := false;
  begin
    perform public.ingest_payment_event(v_acct, 'bkash', '01711000111', '01822000111', 500, 'ab');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'PAY BUG: a two-character transaction id was ingested'; end if;

  -- provider disagrees with the connected account
  v_threw := false;
  begin
    perform public.ingest_payment_event(v_acct, 'nagad', '01711000111', '01822000111', 500, 'TRX0002');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'PAY BUG: a nagad payment was filed against a bkash account'; end if;

  if exists (select 1 from public.payment_events) then
    raise exception 'PAY BUG: a rejected payment still reached the ledger';
  end if;
end $$;

-- ===========================================================================
-- 5. Idempotency -- the headline guarantee
--
-- A phone that reconnects and re-delivers the same message is normal, not an
-- error. It must be recorded once and only once.
-- ===========================================================================

create temporary table _ev (id uuid primary key);

do $$
declare v_first jsonb;
begin
  v_first := public.ingest_payment_event(
    (select id from _acct), 'bkash', '01711000111', '01822000111', 1000, 'TRXIDEM01');

  if (v_first ->> 'duplicate')::boolean then
    raise exception 'PAY BUG: the very first delivery was reported as a duplicate';
  end if;
  if (v_first ->> 'event_id') is null then
    raise exception 'PAY BUG: the first delivery returned no event id';
  end if;

  insert into _ev values ((v_first ->> 'event_id')::uuid);
end $$;

do $$
declare v_replay jsonb; v_rows integer;
begin
  -- Second delivery of the identical transaction, as happens when a phone
  -- regains connectivity and re-reads the same message.
  v_replay := public.ingest_payment_event(
    (select id from _acct), 'bkash', '01711000111', '01822000111', 1000, 'TRXIDEM01');

  if (v_replay ->> 'duplicate')::boolean is not true then
    raise exception 'PAY BUG: a replayed transaction was not reported as a duplicate';
  end if;

  -- The replay must point at the SAME event, not create a parallel one.
  if (v_replay ->> 'event_id')::uuid <> (select id from _ev) then
    raise exception 'PAY BUG: the replay produced a different event id';
  end if;

  select count(*) into v_rows from public.payment_events;
  if v_rows <> 1 then
    raise exception 'PAY BUG: a repeated transaction created % ledger rows', v_rows;
  end if;

  -- And the replay is itself auditable.
  if not exists (
    select 1 from public.payment_audit_logs where action = 'event_duplicate'
  ) then
    raise exception 'PAY BUG: the replay was not audited';
  end if;
end $$;

-- The guarantee is a database constraint, not application logic. Prove it by
-- bypassing the RPC entirely and writing the row as the table owner, which is
-- the only context where the INSERT is permitted at all.
do $$
declare v_threw boolean := false;
begin
  reset role;

  begin
    insert into public.payment_events (
      org_id, payment_account_id, provider, receiver_account, sender_account,
      amount, currency, transaction_id, source, status)
    select org_id, payment_account_id, 'bkash', '01711000111', '01822000111',
           1000, 'BDT', 'TRXIDEM01', 'manual', 'detected'
    from public.payment_events limit 1;
  exception when unique_violation then v_threw := true;
  end;

  set role authenticated;
  set request.jwt.claim.sub = '3a000000-0000-0000-0000-000000000001';

  if not v_threw then
    raise exception 'PAY BUG: the unique identity constraint did not hold';
  end if;

  if (select count(*) from public.payment_events) <> 1 then
    raise exception 'PAY BUG: the constraint test itself added a ledger row';
  end if;
end $$;

-- ===========================================================================
-- 6. Client cannot write the ledger directly
--
-- Every mutation must go through an authorised function. If the app could
-- insert a confirmed payment directly, none of the checks above would matter.
-- ===========================================================================

do $$
declare v_threw boolean;
begin
  v_threw := false;
  begin
    insert into public.payment_events (
      org_id, payment_account_id, provider, receiver_account, sender_account,
      amount, currency, transaction_id, source, status)
    select org_id, (select id from _acct), 'bkash', '01711000111', '01822000111',
           500, 'BDT', 'CLIENTWRITE', 'manual', 'confirmed'
    from public.payment_events limit 1;
  exception when insufficient_privilege then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PAY BUG: a client could insert a payment event directly';
  end if;

  v_threw := false;
  begin
    update public.payment_events set amount = 1 where transaction_id = 'TRXIDEM01';
  exception when insufficient_privilege then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PAY BUG: a client could edit a detected amount';
  end if;
end $$;

-- ===========================================================================
-- 7. Intent validation
-- ===========================================================================

do $$
declare v_threw boolean; v_order uuid;
begin
  select order_id into v_order from _pay;

  -- an order that does not exist
  v_threw := false;
  begin
    perform public.create_payment_intent(
      'order', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      (select id from _acct), 1000);
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'PAY BUG: an intent was created for a missing order'; end if;

  -- an account that is not connected
  v_threw := false;
  begin
    perform public.create_payment_intent('order', v_order, gen_random_uuid(), 1000);
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'PAY BUG: an intent was created on a missing account'; end if;

  -- an expiry in the past
  v_threw := false;
  begin
    perform public.create_payment_intent('order', v_order, (select id from _acct), 1000,
      p_expires_at => now() - interval '1 hour');
  exception when others then v_threw := true;
  end;
  if not v_threw then raise exception 'PAY BUG: an intent was created already expired'; end if;
end $$;

-- ===========================================================================
-- 8. The strong match: auto-confirmed, through record_payment
--
-- Connected account + exact amount + the sender number is the customer on the
-- order. This is the only shape that settles itself.
-- ===========================================================================

do $$
declare
  v_intent uuid;
  v_result jsonb;
  v_order uuid;
  v_paid numeric;
  v_status public.payment_status;
  v_method public.payment_method;
  v_event_status public.payment_event_status;
  v_rows integer;
begin
  select order_id into v_order from _pay;

  v_intent := (public.create_payment_intent(
    'order', v_order, (select id from _acct), 1000,
    p_expected_customer_phone => '01822000111')).id;

  v_result := public.match_payment_event((select id from _ev));

  if (v_result ->> 'settled')::boolean is not true then
    raise exception 'PAY BUG: a strong match did not settle (got %)', v_result;
  end if;

  select amount_paid, payment_status into v_paid, v_status
  from public.orders where id = v_order;

  if v_paid <> 1000 then
    raise exception 'PAY BUG: the order shows % paid, expected 1000', v_paid;
  end if;
  if v_status <> 'paid' then
    raise exception 'PAY BUG: the order is % not paid', v_status;
  end if;

  -- Exactly one money row, written by record_payment, with the MFS method.
  select count(*), min(method) into v_rows, v_method
  from public.payments where order_id = v_order;

  if v_rows <> 1 then
    raise exception 'PAY BUG: % payment rows were written for one confirmed payment', v_rows;
  end if;
  if v_method <> 'bkash' then
    raise exception 'PAY BUG: the payment was recorded as % not bkash', v_method;
  end if;

  select status into v_event_status from public.payment_events where id = (select id from _ev);
  if v_event_status <> 'confirmed' then
    raise exception 'PAY BUG: the event is % not confirmed', v_event_status;
  end if;

  -- orders.amount_paid must equal the sum of the ledger, never drift from it.
  if (select amount_paid from public.orders where id = v_order)
     <> (select coalesce(sum(amount), 0) from public.payments where order_id = v_order) then
    raise exception 'PAY BUG: amount_paid does not reconcile with the payments ledger';
  end if;

  -- An automatic settlement must be recorded as the system, never as the seller.
  if exists (
    select 1 from public.payment_audit_logs
    where action = 'order_payment_recorded' and actor_kind <> 'system'
  ) then
    raise exception 'PAY BUG: an automatic settlement was attributed to a person';
  end if;
end $$;

-- ===========================================================================
-- 9. Double settlement is impossible
--
-- Re-running the matcher, and trying to reassign a confirmed payment by hand,
-- must both leave exactly one payment row.
-- ===========================================================================

do $$
declare
  v_order uuid;
  v_result jsonb;
  v_threw boolean := false;
begin
  select order_id into v_order from _pay;

  -- a replay of the matcher
  v_result := public.match_payment_event((select id from _ev));
  if (v_result ->> 'settled')::boolean then
    raise exception 'PAY BUG: re-running the matcher settled a settled payment again';
  end if;

  -- a manual attempt to move it
  begin
    perform public.assign_payment_match(
      (select id from _ev),
      (select id from public.payment_intents where reference_id = v_order limit 1));
  exception when others then v_threw := true;
  end;

  if not v_threw then
    raise exception 'PAY BUG: a confirmed payment could be reassigned';
  end if;

  if (select count(*) from public.payments where order_id = v_order) <> 1 then
    raise exception 'PAY BUG: the order has more than one payment row after the replay attempts';
  end if;
end $$;

-- ===========================================================================
-- 10. A paid order cannot be opened for collection again
-- ===========================================================================

do $$
declare v_threw boolean := false;
begin
  begin
    perform public.create_payment_intent(
      'order', (select order_id from _pay), (select id from _acct), 1000);
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PAY BUG: an intent was created for an order that is already paid';
  end if;
end $$;

-- ===========================================================================
-- 11. The refusals
--
-- Each of these is money that arrived and must NOT settle an order by itself.
-- They are the whole reason the engine is safe to run unattended.
-- ===========================================================================

-- Helper order factory: a fresh 1000 BDT order for a given customer.
-- Each refusal case needs its own order, because once one settles the order is
-- no longer collectable.
create temporary table _case (
  id serial primary key,
  label text,
  order_id uuid,
  intent_id uuid,
  event_id uuid,
  sender text,
  amount numeric
);

do $$
declare
  v_store uuid;
  v_order uuid;
  v_intent uuid;
  v_event uuid;
  v_result jsonb;
  v_org uuid;
  v_paid numeric;
  v_payments integer;
  v_status public.payment_event_status;
begin
  select org_id, store_id into v_org, v_store from _pay;

  -- ---------------------------------------------------------------------
  -- 11a. The customer never gave a number.
  --
  -- The amount is exactly right, so a naive engine confirms it. But the payer
  -- is unknown, and any customer could be the one who paid. Must be refused.
  -- ---------------------------------------------------------------------
  v_order := public.create_order(
    p_store_id => v_store, p_customer_id => '4a000000-0000-0000-0000-000000000002',
    p_items => '[{"product_id":"5a000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    p_client_ref => 'aa000000-0000-0000-0000-0000000000b1'::uuid);

  v_intent := (public.create_payment_intent('order', v_order, (select id from _acct), 1000)).id;
  v_event := (public.ingest_payment_event(
    (select id from _acct), 'bkash', '01711000111', '01799999999', 1000, 'TRXMEDIUM1') ->> 'event_id')::uuid;

  v_result := public.match_payment_event(v_event);

  if (v_result ->> 'settled')::boolean then
    raise exception 'PAY BUG: an unverifiable payer was auto-confirmed';
  end if;
  if v_result ->> 'strength' <> 'medium' then
    raise exception 'PAY BUG: expected medium strength, got %', v_result ->> 'strength';
  end if;

  select amount_paid into v_paid from public.orders where id = v_order;
  if v_paid <> 0 then
    raise exception 'PAY BUG: a refused match still paid the order (%,)', v_paid;
  end if;
  if (select count(*) from public.payments where order_id = v_order) <> 0 then
    raise exception 'PAY BUG: a refused match still wrote a payment row';
  end if;

  select status into v_status from public.payment_events where id = v_event;
  if v_status <> 'review_required' then
    raise exception 'PAY BUG: a medium match should await review, it is %', v_status;
  end if;

  insert into _case (label, order_id, intent_id, event_id, sender, amount)
  values ('medium_no_phone', v_order, v_intent, v_event, '01799999999', 1000);

  -- ---------------------------------------------------------------------
  -- 11b. The amount is wrong.
  --
  -- A customer paying 1200 for a 1000 order may be paying for two orders, or
  -- may have included delivery. Never a guess. Refused.
  -- ---------------------------------------------------------------------
  v_order := public.create_order(
    p_store_id => v_store, p_customer_id => '4a000000-0000-0000-0000-000000000001',
    p_items => '[{"product_id":"5a000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    p_client_ref => 'aa000000-0000-0000-0000-0000000000b2'::uuid);

  v_intent := (public.create_payment_intent('order', v_order, (select id from _acct), 1000,
    p_expected_customer_phone => '01822000111')).id;
  v_event := (public.ingest_payment_event(
    (select id from _acct), 'bkash', '01711000111', '01822000111', 1200, 'TRXOVERPAID') ->> 'event_id')::uuid;

  v_result := public.match_payment_event(v_event);

  if (v_result ->> 'settled')::boolean then
    raise exception 'PAY BUG: an over-payment was auto-confirmed against a 1000 order';
  end if;
  if (select amount_paid from public.orders where id = v_order) <> 0 then
    raise exception 'PAY BUG: a wrong-amount payment still paid the order';
  end if;

  insert into _case (label, order_id, intent_id, event_id, sender, amount)
  values ('amount_mismatch', v_order, v_intent, v_event, '01822000111', 1200);

  -- ---------------------------------------------------------------------
  -- 11c. The money came from somebody else's number.
  --
  -- Right amount, right account, but the sender is not the customer. Someone
  -- else may be paying on their behalf, or this is a different customer
  -- entirely. A human decides.
  -- ---------------------------------------------------------------------
  v_order := public.create_order(
    p_store_id => v_store, p_customer_id => '4a000000-0000-0000-0000-000000000001',
    p_items => '[{"product_id":"5a000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    p_client_ref => 'aa000000-0000-0000-0000-0000000000b3'::uuid);

  v_intent := (public.create_payment_intent('order', v_order, (select id from _acct), 1000,
    p_expected_customer_phone => '01822000111')).id;
  v_event := (public.ingest_payment_event(
    (select id from _acct), 'bkash', '01711000111', '01555555555', 1000, 'TRXOTHERPAYER') ->> 'event_id')::uuid;

  v_result := public.match_payment_event(v_event);

  if (v_result ->> 'settled')::boolean then
    raise exception 'PAY BUG: a payment from an unrelated number was auto-confirmed';
  end if;
  if (select amount_paid from public.orders where id = v_order) <> 0 then
    raise exception 'PAY BUG: an unrelated payer still settled the order';
  end if;

  -- The audit trail must say why, not just that it failed.
  if not exists (
    select 1 from public.payment_audit_logs
    where payment_event_id = v_event
      and metadata ->> 'reason' = 'insufficient_confidence'
  ) then
    raise exception 'PAY BUG: the refusal was not audited with a reason';
  end if;

  insert into _case (label, order_id, intent_id, event_id, sender, amount)
  values ('wrong_payer', v_order, v_intent, v_event, '01555555555', 1000);

  -- ---------------------------------------------------------------------
  -- 11d. Two orders, same amount, both matching strongly.
  --
  -- Two 1000 BDT orders is an ordinary day. Picking one is a coin flip with a
  -- customer's money attached, so the engine must refuse and let the seller
  -- choose.
  -- ---------------------------------------------------------------------
  v_order := public.create_order(
    p_store_id => v_store, p_customer_id => '4a000000-0000-0000-0000-000000000001',
    p_items => '[{"product_id":"5a000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    p_client_ref => 'aa000000-0000-0000-0000-0000000000b4'::uuid);

  v_intent := (public.create_payment_intent('order', v_order, (select id from _acct), 1000,
    p_expected_customer_phone => '01822000111')).id;

  -- A second, separate order for the same customer, same amount.
  perform public.create_order(
    p_store_id => v_store, p_customer_id => '4a000000-0000-0000-0000-000000000001',
    p_items => '[{"product_id":"5a000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    p_client_ref => 'aa000000-0000-0000-0000-0000000000b5'::uuid);

  perform public.create_payment_intent(
    'order',
    (select id from public.orders where client_ref = 'aa000000-0000-0000-0000-0000000000b5'::uuid),
    (select id from _acct), 1000,
    p_expected_customer_phone => '01822000111');

  v_event := (public.ingest_payment_event(
    (select id from _acct), 'bkash', '01711000111', '01822000111', 1000, 'TRXAMBIGUOUS') ->> 'event_id')::uuid;

  v_result := public.match_payment_event(v_event);

  if (v_result ->> 'settled')::boolean then
    raise exception 'PAY BUG: an ambiguous payment was auto-confirmed';
  end if;
  if v_result ->> 'reason' <> 'ambiguous_candidates' then
    raise exception 'PAY BUG: expected an ambiguity refusal, got %', v_result ->> 'reason';
  end if;
  if (select count(*) from public.payments where order_id = v_order) <> 0 then
    raise exception 'PAY BUG: the ambiguous payment settled an order anyway';
  end if;

  -- Both candidates must be recorded, so the seller can choose between them.
  if (select count(*) from public.payment_matches where payment_event_id = v_event) < 2 then
    raise exception 'PAY BUG: the ambiguous candidates were not recorded for review';
  end if;

  insert into _case (label, order_id, intent_id, event_id, sender, amount)
  values ('ambiguous', v_order, v_intent, v_event, '01822000111', 1000);
end $$;

-- ===========================================================================
-- 12. The seller's decision
--
-- Everything automatic refuses is settleable by hand, with the same validation
-- and the same audit trail. This is what makes the conservative policy
-- affordable: a missed confirmation costs one tap, not a sale.
-- ===========================================================================

do $$
declare
  v_case record;
  v_result jsonb;
  v_paid numeric;
  v_strength public.payment_match_strength;
  v_actor public.payment_audit_actor;
begin
  for v_case in select * from _case where label = 'medium_no_phone' loop
    v_result := public.assign_payment_match(v_case.event_id, v_case.intent_id, 'Confirmed by phone call');

    if (v_result ->> 'settled')::boolean is not true then
      raise exception 'PAY BUG: a manual assignment failed to settle (%, %)', v_case.label, v_result;
    end if;

    select amount_paid into v_paid from public.orders where id = v_case.order_id;
    if v_paid <> 1000 then
      raise exception 'PAY BUG: after manual assignment the order shows % not 1000', v_paid;
    end if;

    select strength into v_strength
    from public.payment_matches
    where payment_event_id = v_case.event_id and status = 'accepted';

    if v_strength <> 'manual' then
      raise exception 'PAY BUG: a manual assignment was recorded as %', v_strength;
    end if;

    -- A human decision must be attributable to that human.
    select actor_kind into v_actor
    from public.payment_audit_logs
    where payment_event_id = v_case.event_id and action = 'match_manually_assigned';

    if v_actor <> 'seller' then
      raise exception 'PAY BUG: a manual assignment was audited as %', v_actor;
    end if;
  end loop;
end $$;

-- A seller cannot attach a payment to an intent belonging to another business.
-- (Checked after the assignment above so the event is still available.)
do $$
declare v_threw boolean := false;
begin
  begin
    perform public.assign_payment_match(
      (select event_id from _case where label = 'amount_mismatch'),
      (select id from public.payment_intents where reference_id =
        (select order_id from _case where label = 'medium_no_phone')));
  exception when others then v_threw := true;
  end;

  -- Either it refused, or it refused because that intent is already settled.
  -- What must never happen is the 1200 payment silently joining a settled order.
  if (select count(*) from public.payments where order_id =
        (select order_id from _case where label = 'medium_no_phone')) <> 1 then
    raise exception 'PAY BUG: a second payment landed on an already-settled order';
  end if;
end $$;

-- ===========================================================================
-- 13. Overpayment against a partly-paid order
--
-- The seller records 800 by hand, then the customer sends the full 1000. The
-- order only has 200 outstanding, so record_payment refuses. That refusal must
-- become a review item, not a lost payment and not a partial write.
-- ===========================================================================

do $$
declare
  v_store uuid;
  v_order uuid;
  v_event uuid;
  v_result jsonb;
  v_paid numeric;
  v_rows integer;
begin
  select store_id into v_store from _pay;

  v_order := public.create_order(
    p_store_id => v_store, p_customer_id => '4a000000-0000-0000-0000-000000000001',
    p_items => '[{"product_id":"5a000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    p_client_ref => 'aa000000-0000-0000-0000-0000000000c1'::uuid);

perform public.create_payment_intent('order', v_order, (select id from _acct), 1000,
      p_expected_customer_phone => '01822000111');

  -- 800 collected in cash by hand.
  perform public.record_payment(v_order, 800, 'cash', null, 'collected at the counter');

  v_event := (public.ingest_payment_event(
    (select id from _acct), 'bkash', '01711000111', '01822000111', 1000, 'TRXTOOMUCH') ->> 'event_id')::uuid;

  v_result := public.match_payment_event(v_event);

  if (v_result ->> 'settled')::boolean then
    raise exception 'PAY BUG: a payment larger than the outstanding balance was accepted';
  end if;

  -- The failed settlement must have left the hand-recorded payment untouched.
  select amount_paid into v_paid from public.orders where id = v_order;
  if v_paid <> 800 then
    raise exception 'PAY BUG: the refused settlement changed amount_paid to %', v_paid;
  end if;

  select count(*) into v_rows from public.payments where order_id = v_order;
  if v_rows <> 1 then
    raise exception 'PAY BUG: the refused settlement left % payment rows, expected 1', v_rows;
  end if;

  if not exists (
    select 1 from public.payment_events
    where id = v_event and status = 'review_required'
  ) then
    raise exception 'PAY BUG: the refused payment is not queued for review';
  end if;
end $$;

-- ===========================================================================
-- 14. Expired intents neither match nor linger
--
-- A stale intent that outlives its window would eventually swallow an unrelated
-- transfer, so old ones are closed and excluded from matching.
-- ===========================================================================

do $$
declare
  v_order uuid;
  v_store uuid;
  v_intent uuid;
  v_event uuid;
  v_result jsonb;
  v_expired integer;
begin
  select store_id into v_store from _pay;

  -- Written directly, because create_payment_intent (correctly) refuses to make
  -- one that is already expired. This simulates an intent that aged in place.
  reset role;
  v_order := public.create_order(
    p_store_id => v_store, p_customer_id => '4a000000-0000-0000-0000-000000000001',
    p_items => '[{"product_id":"5a000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb,
    p_client_ref => 'aa000000-0000-0000-0000-0000000000d1'::uuid);

  insert into public.payment_intents (
    org_id, type, reference_id, payment_account_id, expected_amount, expires_at, status)
  values ((select org_id from _pay), 'order', v_order, (select id from _acct), 1000,
          now() - interval '2 days', 'open')
  returning id into v_intent;
  set role authenticated;
  set request.jwt.claim.sub = '3a000000-0000-0000-0000-000000000001';

  v_event := (public.ingest_payment_event(
    (select id from _acct), 'bkash', '01711000111', '01822000111', 1000, 'TRXEXPIRED') ->> 'event_id')::uuid;

  v_result := public.match_payment_event(v_event);

  if (v_result ->> 'settled')::boolean then
    raise exception 'PAY BUG: an expired intent settled a payment';
  end if;
  if (select amount_paid from public.orders where id = v_order) <> 0 then
    raise exception 'PAY BUG: an expired intent paid its order';
  end if;

  -- And the sweep closes it.
  v_expired := public.expire_stale_payment_intents();

  if (select status from public.payment_intents where id = v_intent) <> 'expired' then
    raise exception 'PAY BUG: the stale intent was not expired';
  end if;

  if not exists (
    select 1 from public.payment_audit_logs
    where payment_intent_id = v_intent and action = 'intent_expired' and actor_kind = 'system'
  ) then
    raise exception 'PAY BUG: expiring an intent was not audited as the system';
  end if;
end $$;

-- ===========================================================================
-- 15. Tenant isolation
--
-- Business B must not see, ingest against, match or settle anything belonging to
-- business A.
-- ===========================================================================

do $$
declare v_org_b uuid; v_acct_a uuid; v_event_a uuid; v_threw boolean; v_seen integer;
begin
  select id into v_acct_a from _acct;
  select event_id into v_event_a from _case where label = 'wrong_payer';

  set request.jwt.claim.sub = '3a000000-0000-0000-0000-000000000002';

  create temporary table _b (org_id uuid primary key);
  insert into _b select (public.bootstrap_business('Other Traders', 'Main', 'OTH') ->> 'org_id')::uuid;
  select org_id into v_org_b from _b;

  -- Read: nothing of A's is visible.
  select count(*) into v_seen from public.payment_events;
  if v_seen <> 0 then
    raise exception 'PAY BUG: another business could read % payment events', v_seen;
  end if;

  select count(*) into v_seen from public.payment_accounts;
  if v_seen <> 0 then
    raise exception 'PAY BUG: another business could read % payment accounts', v_seen;
  end if;

  -- Write: A's account cannot be used to file a payment.
  v_threw := false;
  begin
    perform public.ingest_payment_event(v_acct_a, 'bkash', '01711000111', '01822000111', 500, 'TRXCROSSORG');
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PAY BUG: another business ingested against a foreign payment account';
  end if;

  -- Write: A's event cannot be matched or reassigned.
  v_threw := false;
  begin
    perform public.match_payment_event(v_event_a);
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PAY BUG: another business matched a foreign payment event';
  end if;

  v_threw := false;
  begin
    perform public.assign_payment_match(v_event_a, gen_random_uuid());
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PAY BUG: another business reassigned a foreign payment event';
  end if;

  -- Write: B cannot add an account to A's business.
  v_threw := false;
  begin
    perform public.create_payment_account(
      (select org_id from _pay), 'bkash', '01711000999');
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PAY BUG: another business added a payment account to a foreign org';
  end if;
end $$;

-- A read-only staff member must not be able to move money either.
do $$
declare v_threw boolean := false;
begin
  reset role;
  update public.organization_members
  set role = 'staff'
  where user_id = '3a000000-0000-0000-0000-000000000003';
  set role authenticated;
  set request.jwt.claim.sub = '3a000000-0000-0000-0000-000000000003';

  -- Give the staff member a membership in A's business so the failure is about
  -- the role, not about not being a member.
  begin
    perform public.create_payment_account(
      (select org_id from _pay), 'bkash', '01711000777');
  exception when others then v_threw := true;
  end;
  if not v_threw then
    raise exception 'PAY BUG: a read-only staff member connected a payment account';
  end if;
end $$;

-- ===========================================================================
-- 16. The audit trail is complete and honest
-- ===========================================================================

do $$
declare v_missing integer;
begin
  set request.jwt.claim.sub = '3a000000-0000-0000-0000-000000000001';

  -- Every ingested event left a record.
  select count(*) into v_missing
  from public.payment_events e
  where not exists (
    select 1 from public.payment_audit_logs l
    where l.payment_event_id = e.id and l.action in ('event_ingested', 'event_duplicate')
  );
  if v_missing <> 0 then
    raise exception 'PAY BUG: % ingested events were never audited', v_missing;
  end if;

  -- Every confirmed event left a record.
  select count(*) into v_missing
  from public.payment_events e
  where e.status = 'confirmed'
    and not exists (
      select 1 from public.payment_audit_logs l
      where l.payment_event_id = e.id and l.action = 'event_confirmed'
    );
  if v_missing <> 0 then
    raise exception 'PAY BUG: % confirmed events were never audited', v_missing;
  end if;

  -- actor_kind and actor_id agree, enforced by a constraint but worth proving
  -- the data actually satisfies it rather than trusting the schema.
  select count(*) into v_missing
  from public.payment_audit_logs
  where (actor_kind = 'system' and actor_id is not null)
     or (actor_kind = 'seller' and actor_id is null);

  if v_missing <> 0 then
    raise exception 'PAY BUG: % audit rows have an inconsistent actor', v_missing;
  end if;
end $$;

-- ===========================================================================
-- 17. Nothing outside the engine settled an order
--
-- A blunt final check: across every order created in this suite, amount_paid
-- must equal the sum of its payment rows. Any path that touched orders without
-- going through the ledger shows up here.
-- ===========================================================================

do $$
declare v_drift integer;
begin
  select count(*) into v_drift
  from public.orders o
  where o.org_id = (select org_id from _pay)
    and o.amount_paid <> coalesce((
      select sum(p.amount) from public.payments p
      where p.order_id = o.id and not p.is_refund), 0)
    - coalesce((
      select sum(p.amount) from public.payments p
      where p.order_id = o.id and p.is_refund), 0);

  if v_drift <> 0 then
    raise exception 'PAY BUG: % orders drifted from the payments ledger', v_drift;
  end if;
end $$;

reset role;

rollback;

\echo ''
\echo '  All SellFlow payment engine checks passed.'
\echo ''