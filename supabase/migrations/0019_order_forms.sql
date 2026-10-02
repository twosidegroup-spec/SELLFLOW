-- ---------------------------------------------------------------------------
-- Customer order forms shared by link
--
-- A seller sends a customer a link, the customer fills the form on their own
-- phone, and the submission lands in the seller's inbox for review.
--
-- Three decisions shape this migration, and each one exists to stop an
-- anonymous caller from costing the seller money:
--
--  1. A submission does NOT create an order. It cannot: the price and the stock
--     a customer saw may be hours old, and an order decrements stock and moves
--     revenue. So submissions land in `order_requests` and the seller accepts
--     one through the normal order screen, which re-prices from the live
--     catalogue and runs the stock floor.
--
--  2. Tokens are stored hashed. A read-only compromise of this table would
--     otherwise hand out working order links. The plaintext is returned exactly
--     once, when the form is created, and the seller can always mint a
--     replacement.
--
--  3. The public functions are SECURITY DEFINER but return only whitelisted
--     columns. A token reveals a shop name, its product names and prices, and
--     nothing else -- never stock levels, customers, orders, or revenue.
-- ---------------------------------------------------------------------------

create table public.order_forms (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  label       text not null default 'Customer order form',
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  constraint order_forms_label_len check (char_length(label) between 1 and 80)
);

create table public.order_requests (
  id           uuid primary key default gen_random_uuid(),
  form_id      uuid not null references public.order_forms (id) on delete cascade,
  org_id       uuid not null references public.organizations (id) on delete cascade,
  store_id     uuid not null references public.stores (id) on delete cascade,
  customer_name  text not null,
  customer_phone text,
  -- Product lines as the customer wrote them: { name, quantity, size }. No
  -- price and no product id, because neither is the customer's to decide.
  items         jsonb not null,
  address     text,
  thana       text,
  district    text,
  message     text,
  status      text not null default 'new',
  order_id    uuid references public.orders (id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint order_requests_status check (status in ('new', 'accepted', 'declined')),
  constraint order_requests_items_array check (jsonb_typeof(items) = 'array'),
  constraint order_requests_name_len check (char_length(customer_name) between 1 and 120)
);

create index idx_order_forms_store on public.order_forms (store_id, created_at desc);
create index idx_order_requests_store on public.order_requests (store_id, created_at desc);
create index idx_order_requests_form on public.order_requests (form_id, created_at desc);

alter table public.order_forms enable row level security;
alter table public.order_requests enable row level security;

-- Scoped by org, not by store: a seller with two outlets sees both outlets'
-- links from the phone in their pocket.
create policy "members read own org order forms"
  on public.order_forms for select to authenticated
  using (public.is_org_member(org_id));

create policy "managers create order forms"
  on public.order_forms for insert to authenticated
  with check (public.can_write_org(org_id));

create policy "managers update order forms"
  on public.order_forms for update to authenticated
  using (public.can_write_org(org_id));

create policy "members read own org order requests"
  on public.order_requests for select to authenticated
  using (public.is_org_member(org_id));

create policy "managers decide own org order requests"
  on public.order_requests for update to authenticated
  using (public.can_write_org(org_id))
  with check (public.can_write_org(org_id));

-- Requests are written only by submit_order_request (security definer), never
-- by a client insert: an authenticated member must not be able to fabricate a
-- customer's order out of thin air.

-- Grants are spelled out rather than inherited from Supabase's blanket defaults,
-- so the permissions this feature depends on are visible in the migration and
-- cannot change underneath it. RLS above is what actually decides who sees a
-- row; these only decide whether the table is reachable at all.
grant select, insert, update on public.order_forms to authenticated;
grant select, update on public.order_requests to authenticated;

-- No DELETE for either. A form or a customer request is a record of something a
-- person actually sent; removing it should be a deliberate, auditable act
-- rather than something a stray client call can do.

-- ---------------------------------------------------------------------------
-- Seller side
-- ---------------------------------------------------------------------------

-- Returns the plaintext link exactly once. Losing it is not a problem: mint
-- another form. It cannot be recovered, because only its hash is stored.
create or replace function public.create_order_form(
  p_store_id      uuid,
  p_label         text default 'Customer order form',
  p_expires_days  integer default 14
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org     uuid := public.assert_store_access(p_store_id);
  v_token   text;
  v_hash    text;
  v_form_id uuid;
  v_expires timestamptz;
begin
  perform public.assert_org_write(v_org);

  if p_expires_days is null or p_expires_days < 1 or p_expires_days > 365 then
    raise exception 'invalid_expiry'
      using hint = 'A form can live for between 1 and 365 days.';
  end if;

  -- 192 bits of entropy, base64url. Unguessable in practice, and short enough
  -- to survive being pasted into a WhatsApp message.
  v_token := replace(replace(replace(
    encode(extensions.gen_random_bytes(24), 'base64'), '+', '-'), '/', '_'), '=', '');
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  -- Astronomically unlikely to collide, but a unique violation here would
  -- surface as a raw 500 to the seller, so retry a few times before giving up.
  for attempt in 1..3 loop
    begin
      insert into public.order_forms (org_id, store_id, label, token_hash, expires_at, created_by)
      values (
        v_org, p_store_id,
        coalesce(nullif(trim(p_label), ''), 'Customer order form'),
        v_hash,
        now() + make_interval(days => p_expires_days),
        auth.uid()
      )
      returning id, expires_at into v_form_id, v_expires;
      exit;
    exception when unique_violation then
      v_token := replace(replace(replace(
        encode(extensions.gen_random_bytes(24), 'base64'), '+', '-'), '/', '_'), '=', '');
      v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');
    end;
  end loop;

  if v_form_id is null then
    raise exception 'token_collision' using hint = 'Could not create a link. Try again.';
  end if;

  return jsonb_build_object(
    'id', v_form_id,
    'token', v_token,
    'expires_at', v_expires
  );
end;
$$;

create or replace function public.revoke_order_form(p_form_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  -- assert_store_access resolves the caller's org from the row's own store, so
  -- a form belonging to another business raises here rather than being revoked.
  select public.assert_store_access(f.store_id) into v_org
  from public.order_forms f
  where f.id = p_form_id;

  if v_org is null then
    raise exception 'form_not_found' using hint = 'That link no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  update public.order_forms set revoked_at = now()
  where id = p_form_id and revoked_at is null;

  return true;
end;
$$;

-- Accepting a request only records the decision. It never creates the order:
-- the seller confirms that from the order screen, where the live price and the
-- stock floor are applied.
create or replace function public.decide_order_request(
  p_request_id uuid,
  p_status     text,
  p_order_id   uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select public.assert_store_access(r.store_id) into v_org
  from public.order_requests r
  where r.id = p_request_id;

  if v_org is null then
    raise exception 'request_not_found' using hint = 'That request no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  if p_status not in ('accepted', 'declined') then
    raise exception 'invalid_status' using hint = 'Use accepted or declined.';
  end if;

  -- An accepted request must point at an order in the same business, or the
  -- seller could tie a customer's request to somebody else's order.
  if p_order_id is not null and not exists (
    select 1 from public.orders o
    where o.id = p_order_id
      and public.assert_store_access(o.store_id) = v_org
  ) then
    raise exception 'order_not_in_org';
  end if;

  update public.order_requests
     set status = p_status,
         order_id = coalesce(p_order_id, order_id),
         decided_at = now()
   where id = p_request_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public side -- anonymous, reachable by anyone holding a token
-- ---------------------------------------------------------------------------

-- A token is a bearer credential, so every lookup here is by hash and every
-- response is built field by field. No `select *` crosses this boundary.
create or replace function public.public_order_form(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_form  public.order_forms%rowtype;
  v_store text;
  v_biz   text;
begin
  if p_token is null or char_length(p_token) < 20 then
    raise exception 'invalid_link';
  end if;

  select * into v_form from public.order_forms
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');

  if not found then
    raise exception 'invalid_link';
  end if;

  if v_form.revoked_at is not null then
    raise exception 'link_revoked';
  end if;

  if v_form.expires_at <= now() then
    raise exception 'link_expired';
  end if;

  select s.name, o.name into v_store, v_biz
  from public.stores s
  join public.organizations o on o.id = s.org_id
  where s.id = v_form.store_id;

  -- Names and prices only. No ids, no stock, no margin, nothing about other
  -- stores. Archived products are hidden so a form cannot resurrect something
  -- the seller retired.
  return jsonb_build_object(
    'store_name', v_store,
    'business_name', v_biz,
    'label', v_form.label,
    'expires_at', v_form.expires_at,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.name, 'price', p.selling_price) order by p.name)
      from public.products p
      where p.org_id = v_form.org_id
        and not p.is_archived
        and p.selling_price > 0
      limit 500
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.submit_order_request(
  p_token   text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_form    public.order_forms%rowtype;
  v_name    text;
  v_items   jsonb;
  v_phone   text;
  v_request uuid;
  v_item    jsonb;
  v_lines   jsonb := '[]'::jsonb;
  v_qty     integer;
  v_size    text;
begin
  if p_token is null or char_length(p_token) < 20 then
    raise exception 'invalid_link';
  end if;

  select * into v_form from public.order_forms
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');

  if not found then
    raise exception 'invalid_link';
  end if;

  -- Checked again here, not just on read: a link that expired between the
  -- customer opening it and pressing send must not accept a submission.
  if v_form.revoked_at is not null then
    raise exception 'link_revoked';
  end if;

  if v_form.expires_at <= now() then
    raise exception 'link_expired';
  end if;

  v_name := trim(coalesce(p_payload ->> 'name', ''));
  if v_name = '' then
    raise exception 'name_required' using hint = 'Please write your name.';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'name_too_long';
  end if;

  -- Items are rebuilt rather than trusted. A caller can post anything in
  -- `items`, and an unbounded or negative quantity from a stranger must not
  -- reach a table a seller reads.
  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) loop
    v_qty := coalesce((v_item ->> 'quantity')::integer, 1);
    if v_qty is null or v_qty < 1 or v_qty > 1000 then
      raise exception 'invalid_quantity';
    end if;
    v_size := nullif(trim(coalesce(v_item ->> 'size', '')), '');
    v_lines := v_lines || jsonb_build_object(
      'name', left(trim(coalesce(v_item ->> 'name', '')), 160),
      'quantity', v_qty,
      'size', left(coalesce(v_size, ''), 60)
    );
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    raise exception 'items_required' using hint = 'Please list at least one product.';
  end if;

  v_phone := nullif(trim(coalesce(p_payload ->> 'phone', '')), '');
  if v_phone is not null and char_length(v_phone) > 32 then
    v_phone := left(v_phone, 32);
  end if;

  insert into public.order_requests (
    form_id, org_id, store_id,
    customer_name, customer_phone, items,
    address, thana, district, message
  )
  values (
    v_form.id, v_form.org_id, v_form.store_id,
    v_name, v_phone, v_lines,
    left(coalesce(nullif(trim(p_payload ->> 'address'), ''), ''), 400),
    left(coalesce(nullif(trim(p_payload ->> 'thana'), ''), ''), 120),
    left(coalesce(nullif(trim(p_payload ->> 'district'), ''), ''), 120),
    left(coalesce(nullif(trim(p_payload ->> 'message'), ''), ''), 600)
  )
  returning id into v_request;

  return jsonb_build_object('id', v_request);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
--
-- Postgres gives EXECUTE on a new function to PUBLIC by default, and a grant to
-- `authenticated` does NOT take it away. Without the revokes below, `anon` could
-- call create_order_form and mint a working order link inside any shop whose
-- store id it could guess -- the exact hole this suite exists to catch.
--
-- So: revoke from PUBLIC first, then grant the two roles deliberately.
revoke execute on function public.create_order_form(uuid, text, integer) from public, anon;
revoke execute on function public.revoke_order_form(uuid) from public, anon;
revoke execute on function public.decide_order_request(uuid, text, uuid) from public, anon;

grant execute on function public.create_order_form(uuid, text, integer) to authenticated;
grant execute on function public.revoke_order_form(uuid) to authenticated;
grant execute on function public.decide_order_request(uuid, text, uuid) to authenticated;

-- The two anonymous callers need these, and nothing that reads or writes the
-- tables directly.
revoke execute on function public.public_order_form(text) from public;
revoke execute on function public.submit_order_request(text, jsonb) from public;

grant execute on function public.public_order_form(text) to anon, authenticated;
grant execute on function public.submit_order_request(text, jsonb) to anon, authenticated;

revoke all on public.order_forms from anon;
revoke all on public.order_requests from anon;
