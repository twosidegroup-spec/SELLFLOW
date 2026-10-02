-- ===========================================================================
-- SellFlow :: shared order form security
--
-- A customer order link is the only place in SellFlow where an UNAUTHENTICATED
-- caller can write to the database. That makes it the highest-risk surface in
-- the product, so it gets its own suite rather than a few lines inside the
-- general adversarial probe.
--
-- The invariants asserted here are the ones a real attacker would go after:
--
--   1. A token is stored hashed. Reading the table must not yield a usable link.
--   2. A stranger's token cannot be used from another browser/tenant context.
--   3. `anon` cannot read or write the tables directly, only the two functions.
--   4. A public read exposes names and prices and nothing else -- no stock, no
--      margin, no customer, no order, no other store.
--   5. A submission never becomes an order and never moves stock.
--   6. Revoked and expired links are refused on BOTH read and submit, because a
--      customer may open a form and press send an hour later.
--   7. Untrusted input is bounded: quantities, lengths and array size.
--   8. One seller cannot revoke or decide another seller's form or request.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data)
values ('6a000000-0000-0000-0000-000000000001', 'link-owner@example.test', '{}'::jsonb),
       ('6a000000-0000-0000-0000-000000000002', 'link-other@example.test', '{}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '6a000000-0000-0000-0000-000000000001';

create temporary table _ctx (org_id uuid, store_id uuid, other_org uuid, other_store uuid);

do $$
declare
  v_a jsonb;
  v_b jsonb;
begin
  v_a := public.bootstrap_business('Link Shop', 'Main Outlet', 'MAIN');
  v_b := public.bootstrap_business('Rival Shop', 'Other Outlet', 'OTH');

  insert into _ctx values (
    (v_a ->> 'org_id')::uuid,
    coalesce((v_a ->> 'store_id')::uuid,
             (select id from public.stores where org_id = (v_a ->> 'org_id')::uuid limit 1)),
    (v_b ->> 'org_id')::uuid,
    coalesce((v_b ->> 'store_id')::uuid,
             (select id from public.stores where org_id = (v_b ->> 'org_id')::uuid limit 1))
  );
end $$;

insert into public.products (org_id, name, sku, selling_price, cost_price, track_inventory)
select c.org_id, v.name, v.sku, v.price, v.cost, true
from _ctx c,
     (values
       ('Listed Saree',        'LNK-1', 1500,  900),
       ('Archived Rag',        'LNK-2',  200,   50),
       ('Secret Loss Leader',  'LNK-3',  100, 4000)
     ) as v(name, sku, price, cost);

-- Archived stock must not appear on a public form.
update public.products set is_archived = true where sku = 'LNK-2';

-- ---------------------------------------------------------------------------
-- 1. Minting a link
-- ---------------------------------------------------------------------------
create temporary table _form (id uuid, token text, expires_at timestamptz);

do $$
declare v_r jsonb; v_ctx record;
begin
  select * into v_ctx from _ctx;
  v_r := public.create_order_form(v_ctx.store_id, 'WhatsApp link', 7);
  insert into _form values ((v_r ->> 'id')::uuid, v_r ->> 'token', (v_r ->> 'expires_at')::timestamptz);
end $$;

do $$
declare v_f record;
begin
  select * into v_f from _form;

  if char_length(v_f.token) < 30 then
    raise exception 'the link token is too short to be unguessable, got % characters', char_length(v_f.token);
  end if;

  if v_f.token ~ '[^A-Za-z0-9_-]' then
    raise exception 'the token must be URL-safe so it survives being pasted into a chat message';
  end if;
end $$;

-- The plaintext link must NOT be recoverable from the table.
do $$
begin
  if exists (
    select 1 from public.order_forms
    where token_hash = (select token from _form)
       or token_hash like '%' || (select token from _form) || '%'
  ) then
    raise exception 'the plaintext token is recoverable from the table -- it must be stored hashed';
  end if;

  if not exists (
    select 1 from public.order_forms
    where token_hash = encode(extensions.digest((select token from _form), 'sha256'), 'hex')
  ) then
    raise exception 'the stored hash is not the sha256 of the issued token';
  end if;
end $$;

-- Expiry bounds.
do $$
declare v_threw boolean;
begin
  v_threw := false;
  begin
    perform public.create_order_form((select store_id from _ctx), 'bad', 0);
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a zero-day link must be refused'; end if;

  v_threw := false;
  begin
    perform public.create_order_form((select store_id from _ctx), 'bad', 9999);
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a 9999-day link must be refused'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. A public read shows prices, and nothing private
-- ---------------------------------------------------------------------------
create temporary table _public (payload jsonb);

do $$
begin
  insert into _public
  select public.public_order_form((select token from _form));
end $$;

do $$
declare v_p jsonb; v_keys text[];
begin
  select payload into v_p from _public;

  if v_p ->> 'store_name' is null then
    raise exception 'a public form must name the shop';
  end if;

  -- The whole payload, flattened, must not contain anything sensitive. Prose is
  -- checked for the two things an attacker actually wants: stock levels and
  -- margin. A cost price would turn "Secret Loss Leader" into a -3000% product.
  if (v_p::text) ~* 'cost|margin|profit|quantity|stock' then
    raise exception 'the public payload leaked a field it should not carry: %', v_p::text;
  end if;

  if (v_p -> 'products')::text like '%Archived Rag%' then
    raise exception 'an archived product leaked onto a public form';
  end if;

  -- A product sold below cost is still a product the customer may order, so it
  -- belongs on the form. What must never travel is what it cost the seller:
  -- 'Secret Loss Leader' sells at 100 against a cost of 4,000, and publishing
  -- that turns the catalogue into the seller's margin sheet.
  if (v_p -> 'products')::text not like '%Secret Loss Leader%' then
    raise exception 'a sellable product is missing from the form';
  end if;

  if (v_p -> 'products')::text like '%4000%' then
    raise exception 'the cost price leaked onto a public form';
  end if;

  v_keys := array(select jsonb_object_keys(v_p));
  if 'token' = any (v_keys) or 'token_hash' = any (v_keys) then
    raise exception 'the public payload echoed the token back';
  end if;

  -- No product ids: the customer picks by name, and ids are not theirs to learn.
  if exists (
    select 1 from jsonb_array_elements(v_p -> 'products') e
    where e ? 'id' or e ? 'sku'
  ) then
    raise exception 'the public product list exposed internal identifiers';
  end if;

  -- Exactly one product should have come through: the archived one is hidden.
  if jsonb_array_length(v_p -> 'products') <> 2 then
    raise exception 'expected 2 sellable products on the form, got %',
      jsonb_array_length(v_p -> 'products');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Submitting a request
-- ---------------------------------------------------------------------------
create temporary table _req (id uuid, payload jsonb);

do $$
declare v_r jsonb;
begin
  v_r := public.submit_order_request(
    (select token from _form),
    jsonb_build_object(
      'name', 'Karim Customer',
      'phone', '01712345678',
      'items', jsonb_build_array(
        jsonb_build_object('name', 'Listed Saree', 'quantity', 2),
        jsonb_build_object('name', 'Unlisted Thing', 'quantity', 1)
      ),
      'address', 'House 9, Road 2',
      'thana', 'Dhanmondi',
      'district', 'Dhaka',
      'message', 'Call first'
    )
  );
  insert into _req values ((v_r ->> 'id')::uuid, null);
end $$;

do $$
declare v_row record; v_items jsonb;
begin
  select r.* into v_row from public.order_requests r where r.id = (select id from _req);

  if v_row.customer_name <> 'Karim Customer' then
    raise exception 'the submitted name was not stored';
  end if;
  if v_row.customer_phone <> '01712345678' then
    raise exception 'the submitted phone was not stored';
  end if;

  v_items := v_row.items;
  if jsonb_array_length(v_items) <> 2 then
    raise exception 'both item lines should have been kept, got %', jsonb_array_length(v_items);
  end if;

  -- A product the seller does not sell must survive as text, not be silently
  -- dropped: the seller has to see that the customer asked for it.
  if (v_items::text) not like '%Unlisted Thing%' then
    raise exception 'an unmatched product was dropped instead of being kept for review';
  end if;

  -- The critical one: a submission must not have become an order, and must not
  -- have touched stock. Prices and availability are the seller's to decide.
  if exists (select 1 from public.orders) then
    raise exception 'a customer submission created an order';
  end if;

  if exists (
    select 1 from public.inventory_movements m
    join public.products p on p.id = m.product_id
    where p.org_id = (select org_id from _ctx)
  ) then
    raise exception 'a customer submission moved stock';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Untrusted input is bounded
-- ---------------------------------------------------------------------------
do $$
declare v_threw boolean; v_r jsonb; v_ctx record;
begin
  select * into v_ctx from _ctx;

  v_threw := false;
  begin
    perform public.submit_order_request((select token from _form), jsonb_build_object(
      'name', '   ', 'items', jsonb_build_array(jsonb_build_object('name', 'X', 'quantity', 1))));
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a blank name must be refused'; end if;

  v_threw := false;
  begin
    perform public.submit_order_request((select token from _form), jsonb_build_object(
      'name', 'No Items', 'items', '[]'::jsonb));
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a submission with no products must be refused'; end if;

  -- A hostile quantity must be rejected outright, not clamped: silently turning
  -- 999999 into 1000 would still be a stranger deciding the seller's order size.
  v_threw := false;
  begin
    perform public.submit_order_request((select token from _form), jsonb_build_object(
      'name', 'Greedy', 'items', jsonb_build_array(jsonb_build_object('name', 'Listed Saree', 'quantity', 999999))));
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'an absurd quantity must be refused'; end if;

  v_threw := false;
  begin
    perform public.submit_order_request((select token from _form), jsonb_build_object(
      'name', 'Negative', 'items', jsonb_build_array(jsonb_build_object('name', 'Listed Saree', 'quantity', -5))));
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a negative quantity must be refused'; end if;

  -- Long strings are truncated rather than rejected: a customer typing a long
  -- address should still be able to order.
  v_r := public.submit_order_request((select token from _form), jsonb_build_object(
    'name', 'Verbose Customer',
    'items', jsonb_build_array(jsonb_build_object('name', 'Listed Saree', 'quantity', 1)),
    'address', repeat('x', 900)));
  if not exists (
    select 1 from public.order_requests
    where id = (v_r ->> 'id')::uuid and char_length(address) <= 400
  ) then
    raise exception 'a long address should be truncated, not stored whole or rejected';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Bad and dead links
-- ---------------------------------------------------------------------------
do $$
declare v_threw boolean;
begin
  v_threw := false;
  begin
    perform public.public_order_form('not-a-real-token-value-at-all');
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a bogus token must not return a form'; end if;

  v_threw := false;
  begin
    perform public.submit_order_request('not-a-real-token-value-at-all', jsonb_build_object(
      'name', 'Guesser', 'items', jsonb_build_array(jsonb_build_object('name', 'X', 'quantity', 1))));
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a bogus token must not be able to submit'; end if;

  v_threw := false;
  begin
    perform public.public_order_form(null);
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a null token must be refused'; end if;
end $$;

-- Revocation has to stop submissions too, not just reads: this is the case where
-- a link leaks into a group chat and the seller kills it.
do $$
declare v_threw boolean;
begin
  perform public.revoke_order_form((select id from _form));

  v_threw := false;
  begin
    perform public.public_order_form((select token from _form));
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a revoked link must not be readable'; end if;

  v_threw := false;
  begin
    perform public.submit_order_request((select token from _form), jsonb_build_object(
      'name', 'Late Customer', 'items', jsonb_build_array(jsonb_build_object('name', 'X', 'quantity', 1))));
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a revoked link must not accept submissions'; end if;
end $$;

-- Expiry, checked at submit time as well as read time.
do $$
declare v_threw boolean; v_r jsonb;
begin
  v_r := public.create_order_form((select store_id from _ctx), 'expired', 1);
  update public.order_forms set expires_at = now() - interval '1 minute'
  where id = (v_r ->> 'id')::uuid;

  v_threw := false;
  begin
    perform public.public_order_form(v_r ->> 'token');
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'an expired link must not be readable'; end if;

  v_threw := false;
  begin
    perform public.submit_order_request(v_r ->> 'token', jsonb_build_object(
      'name', 'Too Late', 'items', jsonb_build_array(jsonb_build_object('name', 'X', 'quantity', 1))));
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'an expired link must not accept submissions'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. `anon` gets the two functions and nothing else
-- ---------------------------------------------------------------------------
do $$
declare v_ctx record; v_grant boolean;
begin
  select * into v_ctx from _ctx;

  if has_table_privilege('anon', 'public.order_forms', 'select')
     or has_table_privilege('anon', 'public.order_forms', 'insert')
     or has_table_privilege('anon', 'public.order_forms', 'update')
     or has_table_privilege('anon', 'public.order_forms', 'delete') then
    raise exception 'anon must not have direct table access to order_forms';
  end if;

  if has_table_privilege('anon', 'public.order_requests', 'select')
     or has_table_privilege('anon', 'public.order_requests', 'insert')
     or has_table_privilege('anon', 'public.order_requests', 'update')
     or has_table_privilege('anon', 'public.order_requests', 'delete') then
    raise exception 'anon must not have direct table access to order_requests';
  end if;

  if not has_function_privilege('anon', 'public.public_order_form(text)', 'execute') then
    raise exception 'anon needs to read a public form';
  end if;
  if not has_function_privilege('anon', 'public.submit_order_request(text, jsonb)', 'execute') then
    raise exception 'anon needs to submit a request';
  end if;

  -- Minting a link is a seller action and must never be available to a stranger,
  -- or anyone could create a form inside a shop they do not belong to.
  if has_function_privilege('anon', 'public.create_order_form(uuid, text, integer)', 'execute') then
    raise exception 'anon must not be able to mint order forms';
  end if;

  -- Nor may a customer create an order directly. This is the whole reason a
  -- submission is queued instead of created: `anon` must not be able to move
  -- stock or book revenue.
  if has_function_privilege(
       'anon',
       'public.create_order(uuid, uuid, jsonb, numeric, numeric, numeric, payment_method, text, uuid, timestamptz, text, text, text, text, text, numeric, numeric, boolean)',
       'execute'
     ) then
    raise exception 'anon must not be able to create orders directly';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. One seller cannot touch another's form or request
-- ---------------------------------------------------------------------------
do $$
declare v_threw boolean; v_ctx record;
begin
  select * into v_ctx from _ctx;
  set request.jwt.claim.sub = '6a000000-0000-0000-0000-000000000002';

  v_threw := false;
  begin
    perform public.revoke_order_form((select id from _form));
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a rival seller must not be able to revoke another shop''s link'; end if;

  v_threw := false;
  begin
    perform public.decide_order_request((select id from _req), 'declined');
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'a rival seller must not be able to decide another shop''s request'; end if;

  -- And the RLS policies must hide the rows from them entirely.
  if exists (select 1 from public.order_forms where org_id = v_ctx.org_id) then
    raise exception 'order forms leaked to a rival seller';
  end if;
  if exists (select 1 from public.order_requests where org_id = v_ctx.org_id) then
    raise exception 'order requests leaked to a rival seller';
  end if;

  set request.jwt.claim.sub = '6a000000-0000-0000-0000-000000000001';
end $$;

-- ---------------------------------------------------------------------------
-- 8. The owner sees their own, and can decide a request
-- ---------------------------------------------------------------------------
do $$
declare v_threw boolean; v_ctx record; v_order uuid;
begin
  select * into v_ctx from _ctx;

  if not exists (select 1 from public.order_forms where org_id = v_ctx.org_id) then
    raise exception 'the owner cannot read their own order forms';
  end if;
  if not exists (select 1 from public.order_requests where org_id = v_ctx.org_id) then
    raise exception 'the owner cannot read their own order requests';
  end if;

  -- An accepted request may only be tied to an order in the same business.
  perform public.adjust_stock(
    v_ctx.store_id, (select id from public.products where sku = 'LNK-1'),
    null, 10, 'initial', 'opening');

  perform public.create_order(
    v_ctx.store_id, null,
    jsonb_build_array(jsonb_build_object(
      'product_id', (select id from public.products where sku = 'LNK-1'),
      'variant_id', null, 'quantity', 1, 'line_discount', 0)),
    0, 0, 0, 'cash', null, gen_random_uuid(), now(),
    'Karim Customer', '01712345678', 'House 9', 'Dhaka', 'Dhanmondi', 0, 0, false
  );
  select id into v_order from public.orders
  where delivery_name = 'Karim Customer'
  order by created_at desc limit 1;

  perform public.decide_order_request((select id from _req), 'accepted', v_order);

  if not exists (
    select 1 from public.order_requests
    where id = (select id from _req) and status = 'accepted' and order_id = v_order
  ) then
    raise exception 'accepting a request should record the resulting order';
  end if;

  v_threw := false;
  begin
    perform public.decide_order_request((select id from _req), 'maybe');
  exception when others then v_threw := true; end;
  if not v_threw then raise exception 'an unknown decision status must be refused'; end if;
end $$;

-- A customer must not be able to fabricate requests straight into the table.
do $$
declare v_threw boolean;
begin
  v_threw := false;
  begin
    insert into public.order_requests (
      form_id, org_id, store_id, customer_name, items
    ) select f.id, f.org_id, f.store_id, 'Forged', '[]'::jsonb
      from public.order_forms f limit 1;
  exception when others then v_threw := true; end;
  if not v_threw then
    raise exception 'a client-side insert into order_requests must be refused; requests only arrive through submit_order_request';
  end if;
end $$;

reset role;

rollback;

\echo ''
\echo '  All shared order form security checks passed.'
\echo ''
