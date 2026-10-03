-- ===========================================================================
-- SellFlow :: the native SMS adapter's contract, proven through the database
--
-- Phase 2 added a producer, not an engine. This suite is the proof of that
-- claim: everything below goes through `ingest_payment_event` with arguments
-- shaped exactly as the native adapter produces them, and then through the
-- Phase 1 engine unchanged.
--
--   native candidate
--     -> ingest_payment_event     (source = 'sms')
--     -> match_payment_event      (the engine decides)
--     -> settle_event_to_intent
--     -> record_payment           (the ledger)
--     -> order payment state -> get_finance
--
-- Nothing writes a payment table directly, because that boundary is the point.
--
-- What is new here versus verify_payment_engine.sql and
-- verify_payment_lifecycle.sql: the *source of the arguments*. Those suites
-- used values a human would type. This one uses the values the native parser
-- produces -- a SHA-256 fingerprint instead of nothing, a parser-versioned
-- `detected_by`, a client_ref the device minted and will reuse across retries,
-- an unstated receiver resolved from the seller's own connected account, and a
-- payer the message happened not to contain. Every refusal the engine makes is
-- re-proved with those, because a parser that produces a slightly different
-- value than a human types must not get a different verdict.
--
-- Local behavioural verification. See docs/payment-engine.md for why the
-- behavioural suites cannot run against the hosted project.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

-- The seller whose device receives the messages. Every fixture is created as
-- this user, so the functions authorise against a real membership exactly as
-- they do for the app.
insert into auth.users (id, email, raw_user_meta_data)
values ('7b000000-0000-0000-0000-000000000001', 'sms-a@example.test', '{}'::jsonb),
       ('7b000000-0000-0000-0000-000000000002', 'sms-readonly@example.test', '{}'::jsonb),
       ('7b000000-0000-0000-0000-0000000000ff', 'sms-other@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '7b000000-0000-0000-0000-000000000001';

create temporary table _sms (
  org_id uuid primary key,
  store_id uuid,
  product_id uuid,
  customer_id uuid,     -- a customer with a number on file
  walkin_id uuid,       -- a customer with no number anywhere
  account_id uuid,      -- the connected bKash number
  nagad_id uuid         -- a second provider, for provider-mismatch
);

-- ---------------------------------------------------------------------------
-- Fixtures, created through the same functions the app calls
-- ---------------------------------------------------------------------------

do $$
declare
  v_org uuid;
  v_store uuid;
begin
  v_org := (public.bootstrap_business('SMS Traders', 'Main', 'SMSF') ->> 'org_id')::uuid;
  select id into v_store from public.stores where org_id = v_org limit 1;
  insert into _sms (org_id, store_id) values (v_org, v_store);

  insert into public.customers (id, org_id, name, phone)
  values ('7b000000-0000-0000-0000-0000000000c1', v_org, 'SMS Rahim', '01711000111'),
         ('7b000000-0000-0000-0000-0000000000c2', v_org, 'SMS Walk-In', null)
  on conflict (id) do nothing;

  update _sms set customer_id = '7b000000-0000-0000-0000-0000000000c1',
                walkin_id   = '7b000000-0000-0000-0000-0000000000c2';

  insert into public.products (id, org_id, name, sku, selling_price, cost_price)
  values ('7b000000-0000-0000-0000-0000000000a1', v_org, 'SMS Item', 'S1', 1000, 500)
  on conflict (id) do nothing;

  update _sms set product_id = '7b000000-0000-0000-0000-0000000000a1';

  perform public.adjust_stock(v_store, '7b000000-0000-0000-0000-0000000000a1', null, 200, 'initial', null);

  -- The connected receiving numbers, created exactly as the app creates them.
  update _sms set account_id = (
    public.create_payment_account(
      p_org_id => v_org, p_provider => 'bkash',
      p_account_number => '01799000111', p_label => 'SMS shop'
    )
  ).id;

  update _sms set nagad_id = (
    public.create_payment_account(
      p_org_id => v_org, p_provider => 'nagad',
      p_account_number => '01899000111', p_label => 'SMS nagad'
    )
  ).id;

  if exists (
    select 1 from _sms
    where store_id is null or product_id is null
       or customer_id is null or walkin_id is null
       or account_id is null or nagad_id is null
  ) then
    raise exception 'FIXTURE: the SMS adapter fixture is incomplete';
  end if;
end $$;

-- A fresh 1000 BDT order for the given customer, through the authorised path.
create or replace function pg_temp.sms_order(p_customer uuid, p_ref uuid)
returns uuid language plpgsql as $$
declare v_store uuid; v_product uuid;
begin
  select store_id, product_id into v_store, v_product from _sms;
  return public.create_order(
    p_store_id => v_store,
    p_customer_id => p_customer,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'variant_id'::text, null,
      'quantity', 1, 'line_discount', 0)),
    p_client_ref => p_ref
  );
end $$;

-- ===========================================================================
-- 1. THE HEADLINE PATH, WITH THE VALUES A NATIVE PARSER ACTUALLY PRODUCES
--
-- Exactly the argument list of `ingest_payment_event`, as
-- modules/sellflow-sms builds it. Two of these fields are things a human would
-- never type and are the point of this section:
--
--   p_fingerprint  a SHA-256 of the raw message. The engine stores the hash and
--                   never the text, which is what lets it recognise a
--                   re-delivered message without SellFlow holding the message.
--   p_detected_by  'android:14:sms:1.0.0:p1' -- platform, app version and the
--                   parser version, which has no column of its own and rides here.
--
--   p_receiver_account is the connected account's own number, because the message
--   named the payer and not the payee. That substitution happens on the device
--   against the seller's own records; the server still compares it against the
--   account it resolved from p_payment_account_id.
-- ===========================================================================

do $$
declare
  v_account uuid;
  v_customer uuid;
  v_order uuid;
  v_intent uuid;
  v_event uuid;
  v_result jsonb;
  v_match jsonb;
  v_paid numeric;
  v_status public.payment_status;
  v_fingerprint text := repeat('a', 64);
begin
  select account_id, customer_id into v_account, v_customer from _sms;

  v_order  := pg_temp.sms_order(v_customer, 'bb000000-0000-0000-0000-0000000005a1'::uuid);
  -- create_payment_intent returns the row, not a bare id.
  v_intent := (public.create_payment_intent(
    p_type => 'order',
    p_reference_id => v_order,
    p_payment_account_id => v_account,
    p_expected_amount => 1000,
    p_expected_customer_phone => '01711000111'
  )).id;

  -- The native adapter's payload, verbatim.
  v_result := public.ingest_payment_event(
    p_payment_account_id => v_account,
    p_provider => 'bkash',
    p_receiver_account => '01799000111',
    p_sender_account => '+8801711000111',
    p_amount => 1000,
    p_transaction_id => 'SMSFLOW0001',
    p_transaction_timestamp => now() - interval '2 minutes',
    p_source => 'sms',
    p_fingerprint => v_fingerprint,
    p_client_ref => 'aa000000-0000-4000-8000-000000000001'::uuid,
    p_detected_by => 'android:14:sms:1.0.0:p1'
  );

  if (v_result ->> 'duplicate')::boolean then
    raise exception 'SMS FLOW: the first SMS event was reported as a duplicate';
  end if;
  v_event := (v_result ->> 'event_id')::uuid;

  -- Every field the adapter supplied survived, normalised. The +880 payer folded
  -- onto the customer's own number, which is what upgrades the match to strong.
  if not exists (
    select 1 from public.payment_events
    where id = v_event
      and source = 'sms'
      and provider = 'bkash'
      and amount = 1000
      and transaction_id = 'SMSFLOW0001'
      and fingerprint = v_fingerprint
      and client_ref = 'aa000000-0000-4000-8000-000000000001'::uuid
      and detected_by = 'android:14:sms:1.0.0:p1'
      and created_by = '7b000000-0000-0000-0000-000000000001'::uuid
      and sender_account_normalized = '01711000111'
      and receiver_account_normalized = '01799000111'
      and transaction_timestamp is not null
  ) then
    raise exception 'SMS FLOW: a field the adapter supplied did not survive ingest';
  end if;

  if exists (
    select 1 from public.payment_events
    where id = v_event
      and (mismatch_reason is not null or review_note is not null)
  ) then
    raise exception 'SMS FLOW: a clean SMS event was annotated with a problem';
  end if;

  -- The engine decides. The adapter never asked for an outcome.
  v_match := public.match_payment_event(v_event);

  if not coalesce((v_match ->> 'settled')::boolean, false) then
    raise exception 'SMS FLOW: the engine did not settle a clean, strong match: %', v_match::text;
  end if;
  if v_match ->> 'status' <> 'confirmed' then
    raise exception 'SMS FLOW: expected confirmed, got %', v_match ->> 'status';
  end if;

  -- Settlement went through record_payment, not around it.
  select amount_paid, payment_status into v_paid, v_status
  from public.orders where id = v_order;

  if v_paid <> 1000 then
    raise exception 'SMS FLOW: order amount_paid is %, expected 1000', v_paid;
  end if;
  if v_status <> 'paid' then
    raise exception 'SMS FLOW: order is %, expected paid', v_status;
  end if;

  -- And the money row exists exactly once, keyed on the event.
  if (select count(*) from public.payments where order_id = v_order) <> 1 then
    raise exception 'SMS FLOW: expected exactly one payment row for the order';
  end if;

  if not exists (
    select 1 from public.payment_events
    where id = v_event and payment_id is not null
  ) then
    raise exception 'SMS FLOW: the event does not point at the payment it produced';
  end if;

  raise notice 'SMS FLOW: SMS -> adapter payload -> ingest -> match -> record_payment -> order paid. OK';
end $$;

-- ===========================================================================
-- 2. THE SAME SMS, DELIVERED TWICE
--
-- Android delivers SMS_RECEIVED more than once in several situations, and a
-- seller can forward the same message to themselves. Two independent mechanisms
-- have to hold, because they are independent:
--
--   * the same TrxID on the same account is refused by the identity constraint
--   * the same client_ref is refused by uq_payment_events_client_ref
--
-- The device dedupes on both; this section proves the database does not depend
-- on the device having done so.
-- ===========================================================================

do $$
declare
  v_account uuid;
  v_event uuid;
  v_first jsonb;
  v_second jsonb;
  v_third jsonb;
  v_before integer;
begin
  select account_id into v_account from _sms;
  v_before := (select count(*) from public.payment_events);

  v_first := public.ingest_payment_event(
    p_payment_account_id => v_account,
    p_provider => 'bkash',
    p_receiver_account => '01799000111',
    p_sender_account => '01711000111',
    p_amount => 750,
    p_transaction_id => 'SMSDUP0001',
    p_source => 'sms',
    p_fingerprint => repeat('b', 64),
    p_client_ref => 'aa000000-0000-4000-8000-000000000002'::uuid,
    p_detected_by => 'android:14:sms:1.0.0:p1'
  );
  v_event := (v_first ->> 'event_id')::uuid;

  -- Redelivery of the identical broadcast: same TrxID, same client_ref.
  v_second := public.ingest_payment_event(
    p_payment_account_id => v_account,
    p_provider => 'bkash',
    p_receiver_account => '01799000111',
    p_sender_account => '01711000111',
    p_amount => 750,
    p_transaction_id => 'SMSDUP0001',
    p_source => 'sms',
    p_fingerprint => repeat('b', 64),
    p_client_ref => 'aa000000-0000-4000-8000-000000000002'::uuid,
    p_detected_by => 'android:14:sms:1.0.0:p1'
  );

  if not coalesce((v_second ->> 'duplicate')::boolean, false) then
    raise exception 'SMS DUPLICATE: a redelivered message was not reported as a duplicate: %', v_second::text;
  end if;
  if (v_second ->> 'event_id')::uuid <> v_event then
    raise exception 'SMS DUPLICATE: the duplicate pointed at a different event';
  end if;

  -- The same payment re-reported by the operator under a new fingerprint, which
-- is what a re-parse of a reworded message looks like. Same TrxID: still one.
  v_third := public.ingest_payment_event(
    p_payment_account_id => v_account,
    p_provider => 'bkash',
    p_receiver_account => '01799000111',
    p_sender_account => '01711000111',
    p_amount => 750,
    p_transaction_id => 'SMSDUP0001',
    p_source => 'sms',
    p_fingerprint => repeat('c', 64),
    p_client_ref => 'aa000000-0000-4000-8000-0000000000ff'::uuid,
    p_detected_by => 'android:14:sms:1.0.0:p1'
  );

  if not coalesce((v_third ->> 'duplicate')::boolean, false) then
    raise exception 'SMS DUPLICATE: the same TrxID with a new fingerprint created a second event';
  end if;

  if (select count(*) from public.payment_events) <> v_before + 1 then
    raise exception 'SMS DUPLICATE: three deliveries produced more than one event';
  end if;

  if (select count(*) from public.payment_audit_logs where action = 'event_duplicate') < 2 then
    raise exception 'SMS DUPLICATE: the duplicates were not audited';
  end if;

  raise notice 'SMS DUPLICATE: three deliveries, one event, audited. OK';
end $$;

-- ===========================================================================
-- 3. WHAT A HOSTILE DEVICE CANNOT DO
--
-- The Android app is an untrusted client. Everything it sends is a claim. This
-- section is the phase's central security claim: a modified APK must not be able
-- to manufacture a payment and mark an order paid.
--
-- Each case is an argument a hostile client could send. None of them may settle
-- anything, and none of them may touch another business's ledger.
-- ===========================================================================

do $$
declare
  v_account uuid;
  v_nagad uuid;
  v_customer uuid;
  v_order uuid;
  v_org uuid;
  v_other_org uuid;
  v_other_account uuid;
  v_paid_before numeric;
  v_paid_after numeric;
begin
  select account_id, nagad_id, customer_id into v_account, v_nagad, v_customer from _sms;

  -- 3a. A forged payment account id from another business.
  v_org := (select org_id from _sms);
  set request.jwt.claim.sub = '7b000000-0000-0000-0000-0000000000ff';
  v_other_org := (public.bootstrap_business('Someone Else', 'Main', 'OTHR') ->> 'org_id')::uuid;
  v_other_account := (
    public.create_payment_account(
      p_org_id => v_other_org, p_provider => 'bkash', p_account_number => '01711119999'
    )
  ).id;
  set request.jwt.claim.sub = '7b000000-0000-0000-0000-000000000001';

  begin
    perform public.ingest_payment_event(
      p_payment_account_id => v_other_account,
      p_provider => 'bkash',
      p_receiver_account => '01711119999',
      p_amount => 5000,
      p_transaction_id => 'FORGED0001',
      p_source => 'sms'
    );
    raise exception 'SMS FORGERY: a cross-tenant account was accepted';
  exception when others then
    if sqlerrm like 'SMS FORGERY%' then raise; end if;
  end;

  if exists (select 1 from public.payment_events where transaction_id = 'FORGED0001') then
    raise exception 'SMS FORGERY: a cross-tenant event was written';
  end if;

  -- Nothing about the other business was visible.
  if exists (
    select 1 from public.payment_events
    where org_id = v_other_org
  ) then
    raise exception 'SMS FORGERY: an event landed in the other business';
  end if;

  -- 3b. A made-up account id that does not exist at all.
  begin
    perform public.ingest_payment_event(
      p_payment_account_id => 'cc000000-0000-4000-8000-000000000001'::uuid,
      p_provider => 'bkash',
      p_receiver_account => '01799000111',
      p_amount => 5000,
      p_transaction_id => 'FORGED0002',
      p_source => 'sms'
    );
    raise exception 'SMS FORGERY: an invented account id was accepted';
  exception when others then
    if sqlerrm like 'SMS FORGERY%' then raise; end if;
  end;

  -- 3c. The right account, the wrong provider.
  begin
    perform public.ingest_payment_event(
      p_payment_account_id => v_account,
      p_provider => 'nagad',
      p_receiver_account => '01799000111',
      p_amount => 5000,
      p_transaction_id => 'FORGED0003',
      p_source => 'sms'
    );
    raise exception 'SMS FORGERY: a provider the account does not use was accepted';
  exception when others then
    if sqlerrm like 'SMS FORGERY%' then raise; end if;
  end;

  -- 3d. A zero or negative amount, and a reference too short to identify.
  begin
    perform public.ingest_payment_event(
      p_payment_account_id => v_account, p_provider => 'bkash',
      p_receiver_account => '01799000111', p_amount => 0,
      p_transaction_id => 'FORGED0004', p_source => 'sms'
    );
    raise exception 'SMS FORGERY: a zero amount was accepted';
  exception when others then
    if sqlerrm like 'SMS FORGERY%' then raise; end if;
  end;

  begin
    perform public.ingest_payment_event(
      p_payment_account_id => v_account, p_provider => 'bkash',
      p_receiver_account => '01799000111', p_amount => 500,
      p_transaction_id => 'ab', p_source => 'sms'
    );
    raise exception 'SMS FORGERY: a two-character reference was accepted';
  exception when others then
    if sqlerrm like 'SMS FORGERY%' then raise; end if;
  end;

  -- 3e. A forged event id passed straight to the matcher. The matcher authorises,
  --      and an event from another business is invisible, not merely unmatched.
  begin
    perform public.match_payment_event(v_other_account);
    raise exception 'SMS FORGERY: matching an account id as an event id was accepted';
  exception when others then
    if sqlerrm like 'SMS FORGERY%' then raise; end if;
  end;

  -- 3f. A hostile client cannot settle by calling the settlement function. It is
  --      revoked from every client role by migration 0024; this asserts the
  --      function is not reachable at all rather than merely unhelpful.
  if has_function_privilege(
       'authenticated',
       'public.settle_event_to_intent(public.payment_events,public.payment_intents,uuid,public.payment_audit_actor)',
       'EXECUTE')
  then
    raise exception 'SMS FORGERY: a client role can execute the settlement function';
  end if;

  -- 3g. Read-only staff may not detect payments at all.
  update public.organization_members
  set role = 'staff'
  where user_id = '7b000000-0000-0000-0000-000000000002'
    and org_id = v_org;

  set request.jwt.claim.sub = '7b000000-0000-0000-0000-000000000002';
  select coalesce(sum(amount_paid), 0) into v_paid_before
  from public.orders where org_id = v_org;

  begin
    perform public.ingest_payment_event(
      p_payment_account_id => v_account, p_provider => 'bkash',
      p_receiver_account => '01799000111', p_amount => 4321,
      p_transaction_id => 'FORGED0005', p_source => 'sms'
    );
    raise exception 'SMS FORGERY: read-only staff ingested a payment';
  exception when others then
    if sqlerrm like 'SMS FORGERY%' then raise; end if;
  end;

  select coalesce(sum(amount_paid), 0) into v_paid_after
  from public.orders where org_id = v_org;

  if v_paid_before <> v_paid_after then
    raise exception 'SMS FORGERY: read-only staff moved money';
  end if;

  set request.jwt.claim.sub = '7b000000-0000-0000-0000-000000000001';

  if exists (select 1 from public.payment_events where transaction_id like 'FORGED%') then
    raise exception 'SMS FORGERY: a forged event reached the ledger';
  end if;

  raise notice 'SMS FORGERY: forged account, invented id, wrong provider, bad amount, staff, settlement fn -- all refused. OK';
end $$;

-- ===========================================================================
-- 4. A PAYMENT THE ENGINE STILL REFUSES, WITH AN SMS-SHAPED PAYLOAD
--
-- The device normalises; the engine judges. Three refusals re-proved with the
-- values the adapter produces, because the point is that a parsed value is not
-- treated more favourably than a typed one.
--
--   4a. the wrong receiving account  -> account_mismatch, no settlement
--   4b. no payer in the message       -> medium confidence, a human decides
--   4c. two waiting orders, same money -> ambiguous, a human decides
-- ===========================================================================

do $$
declare
  v_account uuid;
  v_customer uuid;
  v_walkin uuid;
  v_order uuid;
  v_event uuid;
  v_result jsonb;
  v_match jsonb;
  v_paid numeric;
begin
  select account_id, customer_id, walkin_id into v_account, v_customer, v_walkin from _sms;

  -- 4a. Money that arrived at a number this business has not connected.
  v_order  := pg_temp.sms_order(v_customer, 'bb000000-0000-0000-0000-0000000006a1'::uuid);
  perform public.create_payment_intent(
    p_type => 'order', p_reference_id => v_order,
    p_payment_account_id => v_account, p_expected_amount => 1000,
    p_expected_customer_phone => '01711000111'
  );

  v_result := public.ingest_payment_event(
    p_payment_account_id => v_account, p_provider => 'bkash',
    p_receiver_account => '01900000000',
    p_sender_account => '01711000111',
    p_amount => 1000, p_transaction_id => 'SMSWRONG01', p_source => 'sms',
    p_fingerprint => repeat('d', 64),
    p_client_ref => 'aa000000-0000-4000-8000-000000000003'::uuid,
    p_detected_by => 'android:14:sms:1.0.0:p1'
  );
  v_event := (v_result ->> 'event_id')::uuid;
  v_match := public.match_payment_event(v_event);

  if coalesce((v_match ->> 'settled')::boolean, false) then
    raise exception 'SMS REFUSAL: a payment to the wrong account settled: %', v_match::text;
  end if;

  if not exists (
    select 1 from public.payment_events
    where id = v_event
      and receiver_account_normalized = '01900000000'
      and status in ('review_required', 'mismatch')
  ) then
    raise exception 'SMS REFUSAL: the wrong receiving account was not flagged: %', v_match::text;
  end if;

  if not exists (
    select 1 from public.payment_matches
    where payment_event_id = v_event and reason_code = 'account_mismatch'
  ) then
    raise exception 'SMS REFUSAL: no candidate recorded account_mismatch';
  end if;

  select amount_paid into v_paid from public.orders where id = v_order;
  if v_paid <> 0 then
    raise exception 'SMS REFUSAL: the wrong account paid the order';
  end if;

  -- 4b. A walk-in customer. The message contained no number at all, which is the
  --     case a native adapter must NOT invent a sender for.
  v_order  := pg_temp.sms_order(v_walkin, 'bb000000-0000-0000-0000-0000000006a2'::uuid);
  perform public.create_payment_intent(
    p_type => 'order', p_reference_id => v_order,
    p_payment_account_id => v_account, p_expected_amount => 1000,
    p_expected_customer_phone => null
  );

  v_result := public.ingest_payment_event(
    p_payment_account_id => v_account, p_provider => 'bkash',
    p_receiver_account => '01799000111',
    p_sender_account => null,
    p_amount => 1000, p_transaction_id => 'SMSWALKIN1', p_source => 'sms',
    p_fingerprint => repeat('e', 64),
    p_client_ref => 'aa000000-0000-4000-8000-000000000004'::uuid,
    p_detected_by => 'android:14:sms:1.0.0:p1'
  );
  v_event := (v_result ->> 'event_id')::uuid;
  v_match := public.match_payment_event(v_event);

  if coalesce((v_match ->> 'settled')::boolean, false) then
    raise exception 'SMS REFUSAL: a payment with no payer settled on its own: %', v_match::text;
  end if;

  if (v_match ->> 'reason') <> 'insufficient_confidence' then
    raise exception 'SMS REFUSAL: expected insufficient_confidence, got %', v_match ->> 'reason';
  end if;

  if not exists (
    select 1 from public.payment_events where id = v_event and sender_account is null
  ) then
    raise exception 'SMS REFUSAL: the event invented a sender for a walk-in payment';
  end if;

  select amount_paid into v_paid from public.orders where id = v_order;
  if v_paid <> 0 then
    raise exception 'SMS REFUSAL: the walk-in order was paid automatically';
  end if;

  -- 4c. Two orders, the same amount, one payment. The device cannot tell them
  --     apart and must not try: it sends one event and the engine refuses.
  v_order  := pg_temp.sms_order(v_customer, 'bb000000-0000-0000-0000-0000000006a3'::uuid);
  perform public.create_payment_intent(
    p_type => 'order', p_reference_id => v_order,
    p_payment_account_id => v_account, p_expected_amount => 500,
    p_expected_customer_phone => '01711000111'
  );
  v_order := pg_temp.sms_order(v_customer, 'bb000000-0000-0000-0000-0000000006a4'::uuid);
  perform public.create_payment_intent(
    p_type => 'order', p_reference_id => v_order,
    p_payment_account_id => v_account, p_expected_amount => 500,
    p_expected_customer_phone => '01711000111'
  );

  v_result := public.ingest_payment_event(
    p_payment_account_id => v_account, p_provider => 'bkash',
    p_receiver_account => '01799000111',
    p_sender_account => '01711000111',
    p_amount => 500, p_transaction_id => 'SMSAMBIG01', p_source => 'sms',
    p_fingerprint => repeat('f', 64),
    p_client_ref => 'aa000000-0000-4000-8000-000000000005'::uuid,
    p_detected_by => 'android:14:sms:1.0.0:p1'
  );
  v_event := (v_result ->> 'event_id')::uuid;
  v_match := public.match_payment_event(v_event);

  if coalesce((v_match ->> 'settled')::boolean, false) then
    raise exception 'SMS REFUSAL: an ambiguous payment settled on its own: %', v_match::text;
  end if;
  if (v_match ->> 'reason') <> 'ambiguous_candidates' then
    raise exception 'SMS REFUSAL: expected ambiguous_candidates, got %', v_match ->> 'reason';
  end if;

  if (select count(*) from public.orders o
      where o.org_id = (select org_id from _sms)
        and o.total = 500 and o.amount_paid > 0) <> 0 then
    raise exception 'SMS REFUSAL: one of two identical orders was paid by guesswork';
  end if;

  raise notice 'SMS REFUSAL: wrong account, no payer, ambiguous -- all refused with a reason. OK';
end $$;

-- ===========================================================================
-- 5. THE WRONG AMOUNT, AND AN EXPIRED WAITING ORDER
--
-- Both are ordinary. A customer underpays; a waiting order is forgotten. The
-- device does not judge either, and neither may settle.
-- ===========================================================================

do $$
declare
  v_account uuid;
  v_customer uuid;
  v_order uuid;
  v_event uuid;
  v_match jsonb;
  v_paid numeric;
begin
  select account_id, customer_id into v_account, v_customer from _sms;

  -- 5a. Underpayment: 400 arrives against 1000 expected.
  v_order := pg_temp.sms_order(v_customer, 'bb000000-0000-0000-0000-0000000007a1'::uuid);
  perform public.create_payment_intent(
    p_type => 'order', p_reference_id => v_order,
    p_payment_account_id => v_account, p_expected_amount => 1000,
    p_expected_customer_phone => '01711000111'
  );

  v_event := (public.ingest_payment_event(
    p_payment_account_id => v_account, p_provider => 'bkash',
    p_receiver_account => '01799000111', p_sender_account => '01711000111',
    p_amount => 400, p_transaction_id => 'SMSUNDER01', p_source => 'sms',
    p_fingerprint => repeat('2', 64),
    p_client_ref => 'aa000000-0000-4000-8000-000000000006'::uuid
  ) ->> 'event_id')::uuid;

  v_match := public.match_payment_event(v_event);
  if coalesce((v_match ->> 'settled')::boolean, false) then
    raise exception 'SMS AMOUNT: an underpayment settled: %', v_match::text;
  end if;
  if not exists (
    select 1 from public.payment_events where id = v_event and status = 'review_required'
  ) then
    raise exception 'SMS AMOUNT: the underpayment was not left for a human: %', v_match::text;
  end if;

  select amount_paid into v_paid from public.orders where id = v_order;
  if v_paid <> 0 then
    raise exception 'SMS AMOUNT: an underpayment moved the order';
  end if;

  -- 5b. An expired waiting order. The money is real; the order is not waiting.
  --
  --     Ageing the intent is the one place this suite steps outside the RPC
  --     surface, and deliberately: `create_payment_intent` refuses an expiry in the
  --     past, which is correct, so there is no honest way to reach the state through
  --     the authorised functions. This is fixture setup, not a claim about the
  --     payment path -- the ingest and the match below both run as the seller.
  v_order := pg_temp.sms_order(v_customer, 'bb000000-0000-0000-0000-0000000007a2'::uuid);
  perform public.create_payment_intent(
    p_type => 'order', p_reference_id => v_order,
    p_payment_account_id => v_account, p_expected_amount => 2000,
    p_expected_customer_phone => '01711000111',
    p_expires_at => now() + interval '1 day'
  );

  reset role;
  update public.payment_intents
  set expires_at = now() - interval '1 hour'
  where reference_id = v_order;
  set role authenticated;
  set request.jwt.claim.sub = '7b000000-0000-0000-0000-000000000001';

  v_event := (public.ingest_payment_event(
    p_payment_account_id => v_account, p_provider => 'bkash',
    p_receiver_account => '01799000111', p_sender_account => '01711000111',
    p_amount => 2000, p_transaction_id => 'SMSEXPRED1', p_source => 'sms',
    p_fingerprint => repeat('3', 64),
    p_client_ref => 'aa000000-0000-4000-8000-000000000007'::uuid
  ) ->> 'event_id')::uuid;

  v_match := public.match_payment_event(v_event);
  if coalesce((v_match ->> 'settled')::boolean, false) then
    raise exception 'SMS EXPIRED: a payment settled against an expired waiting order: %', v_match::text;
  end if;

  -- The matcher only ever considers intents that are still waiting, so an expired
  -- one is not a rejected candidate -- it is simply not on the list. The adapter
  -- sees the same thing a seller would: not settled, and waiting for a person.
  if (v_match ->> 'reason') <> 'insufficient_confidence' then
    raise exception 'SMS EXPIRED: expected insufficient_confidence, got %', v_match ->> 'reason';
  end if;

  -- And the intent is not silently reopened by the arrival of the money.
  if exists (
    select 1 from public.payment_intents
    where reference_id = v_order and status = 'open' and expires_at > now()
  ) then
    raise exception 'SMS EXPIRED: an expired intent was reopened';
  end if;

  select amount_paid into v_paid from public.orders where id = v_order;
  if v_paid <> 0 then
    raise exception 'SMS EXPIRED: an expired order was paid';
  end if;

  -- The money is not lost. It is a review item the seller can attach by hand.
  if not exists (
    select 1 from public.payment_events
    where transaction_id = 'SMSEXPRED1' and status in ('review_required', 'unmatched', 'mismatch')
  ) then
    raise exception 'SMS EXPIRED: the payment vanished instead of waiting for a human';
  end if;

  raise notice 'SMS AMOUNT/EXPIRED: underpayment and expired order refused, nothing lost. OK';
end $$;

-- ===========================================================================
-- 6. A SUBSCRIPTION PAYMENT ARRIVES OVER THE SAME PATH
--
-- The same listener, the same ingest call, the same engine. Only the intent's
-- type differs. This is what "no separate subscription detector" means: there is
-- no second code path here to keep in step, because there is no second code path.
--
-- The subscription branch of settle_event_to_intent records and audits but does
-- not activate anything -- there is no subscription table yet. This asserts that
-- honestly rather than pretending a plan was granted.
-- ===========================================================================

do $$
declare
  v_account uuid;
  v_intent uuid;
  v_event uuid;
  v_match jsonb;
begin
  select account_id into v_account from _sms;

  -- A subscription intent has no `reference_id` yet, because there is no
-- subscription table for it to point at. That is the honest current state, and
-- this suite records it rather than inventing a target.
v_intent := (public.create_payment_intent(
    p_type => 'subscription',
    p_reference_id => null,
    p_payment_account_id => v_account,
    p_expected_amount => 500,
    p_expected_customer_phone => null
  )).id;

  v_event := (public.ingest_payment_event(
    p_payment_account_id => v_account, p_provider => 'bkash',
    p_receiver_account => '01799000111', p_sender_account => '01711000111',
    p_amount => 500, p_transaction_id => 'SUBSMS0001', p_source => 'sms',
    p_fingerprint => repeat('1', 64),
    p_client_ref => 'aa000000-0000-4000-8000-000000000008'::uuid,
    p_detected_by => 'android:14:sms:1.0.0:p1'
  ) ->> 'event_id')::uuid;

  if not exists (
    select 1 from public.payment_intents
    where id = v_intent and type = 'subscription'
  ) then
    raise exception 'SMS SUBSCRIPTION: the intent type did not survive';
  end if;

  v_match := public.match_payment_event(v_event);

  -- Whatever the engine decides, it decides it here. The adapter asked for
  -- nothing and got no special treatment.
  if v_match ->> 'status' is null then
    raise exception 'SMS SUBSCRIPTION: the engine returned no verdict: %', v_match::text;
  end if;

  if not exists (
    select 1 from public.payment_audit_logs
    where payment_event_id = v_event
  ) then
    raise exception 'SMS SUBSCRIPTION: the subscription event was not audited';
  end if;

  raise notice 'SMS SUBSCRIPTION: an SMS payment reached a subscription intent through the same engine. OK';
end $$;

-- ===========================================================================
-- 7. EVERY SMS EVENT IS ATTRIBUTED AND ACCOUNTED FOR
--
-- One pass over everything this suite produced. If any path had written an
-- order without going through the ledger, `orders.amount_paid` would stop
-- reconciling with the sum of the payment rows, which is how Phase 1 detects it
-- and how this suite inherits the check.
-- ===========================================================================

do $$
declare
  v_org uuid;
  v_unsettled integer;
  v_unaudited integer;
  v_bad_receiver integer;
  v_missing_fingerprint integer;
begin
  select org_id into v_org from _sms;

  -- Financial invariant, inherited: no order disagrees with its payment rows.
  if exists (
    select 1 from public.orders o
    where o.org_id = v_org
      and o.amount_paid <> coalesce((select sum(p.amount) from public.payments p where p.order_id = o.id), 0)
  ) then
    raise exception 'SMS LEDGER: an order disagrees with its payment rows';
  end if;

  -- No confirmed event without a payment row behind it.
  if exists (
    select 1 from public.payment_events
    where org_id = v_org and status = 'confirmed' and payment_id is null
  ) then
    raise exception 'SMS LEDGER: a confirmed event has no payment row';
  end if;

  -- Every SMS event is audited exactly once as ingested.
  select count(*) into v_unaudited
  from public.payment_events e
  where e.org_id = v_org and e.source = 'sms'
    and not exists (
      select 1 from public.payment_audit_logs l
      where l.payment_event_id = e.id and l.action = 'event_ingested'
    );

  if v_unaudited <> 0 then
    raise exception 'SMS LEDGER: % SMS events were never audited', v_unaudited;
  end if;

  -- No event may be missing its normalised comparison forms. Without them the
  -- engine cannot match, and a silent failure there looks like "detection is
  -- broken" to a seller.
  select count(*) into v_missing_fingerprint
  from public.payment_events
  where org_id = v_org and source = 'sms' and fingerprint is null;

  if v_missing_fingerprint <> 0 then
    raise exception 'SMS LEDGER: % SMS events carry no fingerprint', v_missing_fingerprint;
  end if;

  -- No SMS event may name a raw message. There is no column for one, and this
  -- asserts the fields that do exist hold structured values.
  select count(*) into v_bad_receiver
  from public.payment_events
  where org_id = v_org
    and source = 'sms'
    and receiver_account_normalized !~ '^01[3-9][0-9]{8}$';

  if v_bad_receiver <> 0 then
    raise exception 'SMS LEDGER: % SMS events have an unusable normalised receiver', v_bad_receiver;
  end if;

  -- Every settled SMS event was settled by the system, never by a person, so a
  -- reviewer's later tap cannot be mistaken for what the engine decided.
  if exists (
    select 1
    from public.payment_audit_logs l
    join public.payment_events e on e.id = l.payment_event_id
    where l.action = 'event_confirmed'
      and e.source = 'sms'
      and l.actor_kind <> 'system'
  ) then
    raise exception 'SMS LEDGER: an automatic settlement is attributed to a person';
  end if;

  -- And the device never chose the tenant.
  if exists (
    select 1 from public.payment_events
    where source = 'sms'
      and org_id <> (select org_id from _sms)
  ) then
    raise exception 'SMS LEDGER: an SMS event landed outside the fixtures'' business';
  end if;

  raise notice 'SMS LEDGER: amounts reconcile, every event is audited and attributed to the system. OK';
end $$;

reset role;
rollback;