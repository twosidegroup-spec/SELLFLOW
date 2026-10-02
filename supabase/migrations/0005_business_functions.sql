-- ===========================================================================
-- SellFlow :: 0005 -- business transactions
--
-- Every function here is SECURITY DEFINER, which means it runs with the
-- privileges of its owner and therefore BYPASSES Row Level Security. That is
-- deliberate -- it is how a multi-step write (order + items + inventory +
-- movements + payment + history) becomes one atomic transaction instead of six
-- half-applied requests that PostgREST cannot wrap in a transaction.
--
-- The cost of bypassing RLS is that authorization cannot be inherited. Every
-- function MUST therefore:
--   1. resolve the target org via assert_store_access() / assert_org_write(),
--      which derive org_id server-side and never trust a client-supplied one;
--   2. use that resolved org_id for every row it writes.
--
-- Errors are raised with a stable `message` that the client maps to friendly
-- copy (see src/lib/errors.ts). `hint` carries the detail.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Onboarding: create the business, the owner membership, and the first store
-- in one transaction, so a user can never end up with an org they cannot write
-- to.
--
-- Idempotent per user: calling it again returns the existing business rather
-- than creating a second one, which makes the onboarding screen safe to retry
-- after a dropped connection.
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_business(
  p_business_name text,
  p_store_name    text default null,
  p_store_code    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_org_id uuid;
  v_store  uuid;
  v_business text := btrim(p_business_name);
  v_store_name text := coalesce(nullif(btrim(p_store_name), ''), 'Main store');
begin
  if v_user is null then
    raise exception 'not_authenticated' using hint = 'Sign in again.';
  end if;

  if v_business is null or length(v_business) < 1 then
    raise exception 'invalid_business_name' using hint = 'Enter a business name.';
  end if;

  if length(v_business) > 120 then
    raise exception 'invalid_business_name' using hint = 'Business name is too long.';
  end if;

  -- Already has a business? Return it so onboarding can be replayed safely.
  select m.org_id into v_org_id
  from public.organization_members m
  where m.user_id = v_user
  order by m.created_at
  limit 1;

  if v_org_id is not null then
    select id into v_store from public.stores
    where org_id = v_org_id and not is_archived
    order by is_default desc, created_at
    limit 1;

    return jsonb_build_object('org_id', v_org_id, 'store_id', v_store, 'created', false);
  end if;

  insert into public.organizations (name, created_by)
  values (v_business, v_user)
  returning id into v_org_id;

  insert into public.organization_members (org_id, user_id, role)
  values (v_org_id, v_user, 'owner')
  on conflict (org_id, user_id) do update set role = 'owner';

  insert into public.stores (org_id, name, code, is_default)
  values (
    v_org_id,
    left(v_store_name, 120),
    nullif(upper(btrim(p_store_code)), ''),
    true
  )
  returning id into v_store;

  insert into public.notification_preferences (org_id, user_id)
  values (v_org_id, v_user)
  on conflict (org_id, user_id) do nothing;

  return jsonb_build_object('org_id', v_org_id, 'store_id', v_store, 'created', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Order numbers
--
-- `max(...) + 1` alone races: two simultaneous creates would compute the same
-- number and one would fail the unique constraint. A transaction-scoped
-- advisory lock on the store id serialises just this function's allocation
-- without blocking unrelated work on the same rows.
-- ---------------------------------------------------------------------------
create or replace function public.next_order_number(p_store_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text;
  v_next   bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_store_id::text, 0));

  select coalesce(nullif(code, ''), 'ORD') into v_prefix
  from public.stores where id = p_store_id;

  select coalesce(max(nullif(split_part(order_number, '-', 2), '')::bigint), 0) + 1
    into v_next
  from public.orders
  where store_id = p_store_id
    and order_number ~ ('^' || v_prefix || '-[0-9]+$');

  return v_prefix || '-' || lpad(v_next::text, 6, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- Stock movement -- the single place inventory quantity changes.
--
-- Writes the new balance to `inventory` AND appends to `inventory_movements`
-- in the same transaction, so there is never a quantity change without an
-- audit row explaining it.
-- ---------------------------------------------------------------------------
create or replace function public.apply_stock_delta(
  p_org_id     uuid,
  p_store_id   uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_delta      integer,
  p_reason     public.inventory_reason,
  p_reference_type text,
  p_reference_id   uuid,
  p_note       text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_after integer;
begin
  if p_delta = 0 then
    raise exception 'invalid_quantity' using hint = 'Quantity change cannot be zero.';
  end if;

  -- Lock the unit so two concurrent orders cannot both read the same balance.
  -- UPDATE ... RETURNING also creates the row when it does not yet exist.
  update public.inventory
     set quantity  = quantity + p_delta,
         updated_at = now()
   where store_id = p_store_id
     and product_id = p_product_id
     and variant_id is not distinct from p_variant_id
  returning quantity into v_after;

  if v_after is null then
    insert into public.inventory (org_id, store_id, product_id, variant_id, quantity)
    values (p_org_id, p_store_id, p_product_id, p_variant_id, p_delta)
    returning quantity into v_after;
  end if;

  insert into public.inventory_movements (
    org_id, store_id, product_id, variant_id, delta, reason,
    reference_type, reference_id, note, balance_after, created_by
  )
  values (
    p_org_id, p_store_id, p_product_id, p_variant_id, p_delta, p_reason,
    p_reference_type, p_reference_id, p_note, v_after, auth.uid()
  );

  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- Manual stock adjustment (Products -> Adjust stock).
-- ---------------------------------------------------------------------------
create or replace function public.adjust_stock(
  p_store_id   uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_delta      integer,
  p_reason     public.inventory_reason,
  p_note       text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid := public.assert_store_access(p_store_id);
  v_tracks   boolean;
  v_name     text;
begin
  perform public.assert_org_write(v_org);

  if p_reason not in ('initial', 'purchase', 'adjustment', 'damage') then
    raise exception 'invalid_reason'
      using hint = 'Use adjust_stock for manual changes; order stock is handled automatically.';
  end if;

  select p.track_inventory, p.name into v_tracks, v_name
  from public.products p
  where p.id = p_product_id and p.org_id = v_org;

  if v_tracks is null then
    raise exception 'product_not_found' using hint = 'That product no longer exists.';
  end if;

  if not v_tracks then
    raise exception 'inventory_not_tracked'
      using hint = v_name || ' does not track inventory. Turn tracking on first.';
  end if;

  return public.apply_stock_delta(
    v_org, p_store_id, p_product_id, p_variant_id,
    p_delta, p_reason, 'manual', null, p_note
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Create order.
--
-- One transaction covering the whole of requirement 41:
--   validate customer -> validate products -> validate stock -> price
--   -> order -> items -> inventory -> movements -> payment -> history.
--
-- p_items is a jsonb array:
--   [{"product_id": uuid, "variant_id": uuid|null, "quantity": 2,
--     "unit_price": 500, "line_discount": 50}]
--
-- unit_price / line_discount are optional; omitting them uses the product's
-- current selling_price and zero discount. Passing unit_price is how a seller
-- applies a one-off negotiated price.
-- ---------------------------------------------------------------------------
create or replace function public.create_order(
  p_store_id        uuid,
  p_customer_id     uuid,
  p_items           jsonb,
  p_discount        numeric default 0,
  p_delivery_charge numeric default 0,
  p_amount_paid     numeric default 0,
  p_payment_method  public.payment_method default 'cash',
  p_notes           text default null,
  p_client_ref      uuid default null,
  p_placed_at       timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org        uuid := public.assert_store_access(p_store_id);
  v_user       uuid := auth.uid();
  v_order_id   uuid;
  v_number     text;
  v_item       jsonb;
  -- Separate from v_item: this loop iterates composite rows, not jsonb values.
  -- Assigning a record into a jsonb variable makes PL/pgSQL attempt a cast to
  -- json, which fails.
  v_line       record;
  v_product_id uuid;
  v_variant_id uuid;
  v_qty        integer;
  v_unit_price numeric(14,2);
  v_unit_cost  numeric(14,2);
  v_line_disc  numeric(14,2) not null default 0;
  v_line_total numeric(14,2);
  v_items_total numeric(14,2) := 0;
  v_cost_total  numeric(14,2) := 0;
  v_total       numeric(14,2);
  v_profit      numeric(14,2);
  v_available   integer;
  v_tracks      boolean;
  v_allow_neg   boolean;
  v_pname      text;
  v_vname      text;
  v_sku        text;
  v_paid       numeric(14,2) := 0;
  v_pay_status public.payment_status;
  v_count      integer;
begin
  perform public.assert_org_write(v_org);

  -- Retry safety first, before any payload validation. A client resubmitting an
  -- interrupted create may well send an empty or trimmed item array; the whole
  -- point of client_ref is that the already-created order is returned unchanged.
  if p_client_ref is not null then
    select id into v_order_id from public.orders
    where store_id = p_store_id and client_ref = p_client_ref;

    if v_order_id is not null then
      return v_order_id;
    end if;
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_order' using hint = 'Add at least one product to the order.';
  end if;

  select allow_negative_stock into v_allow_neg from public.organizations where id = v_org;

  -- Customer must belong to this org. A null customer_id is allowed: cash sales
  -- with no customer record are normal for this audience.
  if p_customer_id is not null and not exists (
    select 1 from public.customers
    where id = p_customer_id and org_id = v_org and not is_archived
  ) then
    raise exception 'customer_not_found' using hint = 'That customer no longer exists.';
  end if;

  -- 1) Validate and resolve every line BEFORE writing anything, so a bad line
  --    cannot leave a half-created order behind.
  --
  -- `on commit drop` only cleans up at COMMIT, so a second call inside the same
  -- transaction would collide. Dropping explicitly first makes the function
  -- re-entrant within a transaction.
  drop table if exists pg_temp._draft_lines;

  create temporary table _draft_lines (
    idx           serial primary key,
    product_id    uuid not null,
    variant_id    uuid,
    variant_name  text,
    sku           text,
    product_name  text not null,
    unit_price    numeric(14,2) not null,
    unit_cost     numeric(14,2),
    quantity      integer not null,
    line_discount numeric(14,2) not null default 0,
    line_total    numeric(14,2) not null
  ) on commit drop;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_qty        := coalesce((v_item ->> 'quantity')::integer, 1);
    v_line_disc  := coalesce((v_item ->> 'line_discount')::numeric, 0);

    if v_qty is null or v_qty < 1 then
      raise exception 'invalid_quantity' using hint = 'Quantity must be at least 1.';
    end if;

    if v_line_disc < 0 then
      raise exception 'invalid_discount' using hint = 'Discount cannot be negative.';
    end if;

    select p.id, p.name, p.sku, p.track_inventory,
           coalesce(vv.selling_price, p.selling_price),
           vv.cost_price, p.cost_price, vv.name
      into v_product_id, v_pname, v_sku, v_tracks,
           v_unit_price, v_unit_cost, v_unit_cost, v_vname
      from public.products p
      left join public.product_variants vv
        on vv.id = v_variant_id and vv.product_id = p.id
     where p.id = v_product_id
       and p.org_id = v_org
       and not p.is_archived;

    if v_pname is null then
      raise exception 'product_not_found'
        using hint = 'One of the selected products no longer exists.';
    end if;

    if v_variant_id is not null and v_vname is null then
      raise exception 'variant_not_found'
        using hint = 'A selected variant no longer exists for ' || v_pname || '.';
    end if;

    -- An explicit unit_price overrides the catalog price (negotiated deals).
    if v_item ? 'unit_price' and jsonb_typeof(v_item -> 'unit_price') <> 'null' then
      v_unit_price := (v_item ->> 'unit_price')::numeric;
    end if;

    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'invalid_price' using hint = v_pname || ': price must be zero or more.';
    end if;

    if v_line_disc > v_unit_price * v_qty then
      raise exception 'invalid_discount'
        using hint = 'Discount on ' || v_pname || ' is larger than the line value.';
    end if;

    v_line_total := v_unit_price * v_qty - v_line_disc;

    -- 2) Stock validation, for tracked products only.
    if v_tracks then
      select quantity into v_available
      from public.inventory
      where store_id = p_store_id
        and product_id = v_product_id
        and variant_id is not distinct from v_variant_id;

      v_available := coalesce(v_available, 0);

      if v_available < v_qty and not v_allow_neg then
        raise exception 'insufficient_stock'
          using hint = v_pname || ' has ' || v_available || ' in stock but ' || v_qty || ' requested.';
      end if;
    end if;

    insert into _draft_lines (
      product_id, variant_id, variant_name, sku, product_name,
      unit_price, unit_cost, quantity, line_discount, line_total
    ) values (
      v_product_id, v_variant_id, v_vname, v_sku, v_pname,
      v_unit_price, v_unit_cost, v_qty, v_line_disc, v_line_total
    );
  end loop;

  select count(*) into v_count from _draft_lines;
  if v_count = 0 then
    raise exception 'empty_order' using hint = 'Add at least one product to the order.';
  end if;

  select coalesce(sum(line_total), 0), coalesce(sum(coalesce(unit_cost, 0) * quantity), 0)
    into v_items_total, v_cost_total
  from _draft_lines;

  -- 3) Order-level arithmetic.
  if coalesce(p_discount, 0) < 0 then
    raise exception 'invalid_discount' using hint = 'Discount cannot be negative.';
  end if;

  if coalesce(p_discount, 0) > v_items_total then
    raise exception 'invalid_discount'
      using hint = 'Order discount is larger than the item total.';
  end if;

  if coalesce(p_delivery_charge, 0) < 0 then
    raise exception 'invalid_delivery_charge' using hint = 'Delivery charge cannot be negative.';
  end if;

  v_total  := v_items_total - coalesce(p_discount, 0) + coalesce(p_delivery_charge, 0);
  v_profit := v_total - v_cost_total;

  if coalesce(p_amount_paid, 0) < 0 then
    raise exception 'invalid_payment' using hint = 'Paid amount cannot be negative.';
  end if;

  v_paid := least(coalesce(p_amount_paid, 0), v_total);

  if v_total = 0 or v_paid >= v_total then
    v_pay_status := 'paid';
  elsif v_paid <= 0 then
    v_pay_status := 'unpaid';
  else
    v_pay_status := 'partial';
  end if;

  -- 4) Persist.
  v_number := public.next_order_number(p_store_id);

  insert into public.orders (
    org_id, store_id, customer_id, order_number, status, payment_status,
    items_total, discount, delivery_charge, total, cost_total, profit,
    amount_paid, client_ref, notes, placed_at, created_by
  ) values (
    v_org, p_store_id, p_customer_id, v_number, 'pending', v_pay_status,
    v_items_total, coalesce(p_discount, 0), coalesce(p_delivery_charge, 0),
    v_total, v_cost_total, v_profit,
    v_paid, p_client_ref, p_notes, coalesce(p_placed_at, now()), v_user
  ) returning id into v_order_id;

  insert into public.order_items (
    org_id, order_id, product_id, variant_id, product_name, variant_name,
    sku, unit_price, unit_cost, quantity, line_discount, line_total
  )
  select
    v_org, v_order_id, d.product_id, d.variant_id, d.product_name, d.variant_name,
    d.sku, d.unit_price, d.unit_cost, d.quantity, d.line_discount, d.line_total
  from _draft_lines d
  order by d.idx;

  -- 5) Decrement stock and record the movement for each tracked line.
  for v_line in
    select d.product_id, d.variant_id, d.quantity, d.product_name, d.sku, p.track_inventory as track
    from _draft_lines d
    join public.products p on p.id = d.product_id
    order by d.idx
  loop
    if v_line.track then
      perform public.apply_stock_delta(
        v_org, p_store_id, v_line.product_id, v_line.variant_id,
        -v_line.quantity, 'sale', 'order', v_order_id,
        v_number || ' - ' || v_line.product_name
      );
    end if;
  end loop;

  -- 6) Payment, if any was taken at the point of sale.
  if v_paid > 0 then
    insert into public.payments (
      org_id, store_id, order_id, amount, method, is_refund, paid_at, created_by
    ) values (
      v_org, p_store_id, v_order_id, v_paid, p_payment_method, false, now(), v_user
    );
  end if;

  -- 7) Timeline always starts with a NULL -> pending entry.
  insert into public.order_status_history (org_id, order_id, from_status, to_status, created_by)
  values (v_org, v_order_id, null, 'pending', v_user);

  return v_order_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Allowed status transitions.
--
-- Encoded as a table so the rules are data, not scattered IFs, and the client
-- can ask `allowed_order_statuses(order_id)` to grey out impossible choices
-- instead of letting the user pick something the database will reject.
-- ---------------------------------------------------------------------------
create or replace function public.status_transition_allowed(
  p_from public.order_status,
  p_to   public.order_status
)
returns boolean
language sql
immutable
as $$
  select case p_from
    when 'pending'         then p_to in ('confirmed', 'cancelled', 'failed_delivery')
    when 'confirmed'       then p_to in ('processing', 'shipped', 'cancelled', 'failed_delivery')
    when 'processing'      then p_to in ('shipped', 'delivered', 'cancelled', 'returned', 'failed_delivery')
    when 'shipped'         then p_to in ('delivered', 'returned', 'failed_delivery')
    when 'delivered'       then p_to in ('returned')
    when 'failed_delivery' then p_to in ('pending', 'confirmed', 'cancelled')
    when 'cancelled'       then false
    when 'returned'        then false
    else false
  end;
$$;

create or replace function public.allowed_order_statuses(p_order_id uuid)
returns public.order_status[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_from public.order_status;
  v_all  public.order_status[] := array[
    'pending', 'confirmed', 'processing', 'shipped',
    'delivered', 'cancelled', 'returned', 'failed_delivery'
  ]::public.order_status[];
  v_ok   public.order_status[] := '{}';
  v_next public.order_status;
begin
  select public.assert_store_access(store_id), status into v_org, v_from
  from public.orders where id = p_order_id;

  if v_from is null then
    raise exception 'order_not_found' using hint = 'That order no longer exists.';
  end if;

  foreach v_next in array v_all
  loop
    if public.status_transition_allowed(v_from, v_next) then
      v_ok := array_append(v_ok, v_next);
    end if;
  end loop;

  return v_ok;
end;
$$;

-- ---------------------------------------------------------------------------
-- Change order status.
--
-- Restores stock on cancelled/returned so inventory reflects reality, and
-- refuses invalid transitions with a message the client can explain.
-- ---------------------------------------------------------------------------
create or replace function public.set_order_status(
  p_order_id  uuid,
  p_to_status public.order_status,
  p_note      text default null
)
returns public.order_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org     uuid;
  v_user    uuid := auth.uid();
  v_from    public.order_status;
  v_line    record;
  v_allows  boolean;
  v_restock boolean;
begin
  select public.assert_store_access(o.store_id), o.org_id, o.status
    into v_org, v_org, v_from
  from public.orders o
  where o.id = p_order_id;

  if v_from is null then
    raise exception 'order_not_found' using hint = 'That order no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  if v_from = p_to_status then
    return v_from;  -- idempotent, so a retry is harmless
  end if;

  v_allows := public.status_transition_allowed(v_from, p_to_status);

  if not v_allows then
    raise exception 'invalid_transition'
      using hint = 'An order that is ' || v_from::text || ' cannot become ' || p_to_status::text || '.';
  end if;

  update public.orders
     set status = p_to_status, updated_at = now()
   where id = p_order_id;

  insert into public.order_status_history (org_id, order_id, from_status, to_status, note, created_by)
  values (v_org, p_order_id, v_from, p_to_status, p_note, v_user);

  -- Cancelling or returning puts the goods back on the shelf. This is the
  -- mirror of the decrement done in create_order, so the ledger balances.
  if p_to_status in ('cancelled', 'returned') then
    for v_line in
      select oi.product_id, oi.variant_id, sum(oi.quantity)::integer as qty,
             max(oi.product_name) as pname
      from public.order_items oi
      join public.products p on p.id = oi.product_id
      where oi.order_id = p_order_id and p.track_inventory
      group by oi.product_id, oi.variant_id
    loop
      perform public.apply_stock_delta(
        v_org, (select store_id from public.orders where id = p_order_id),
        v_line.product_id, v_line.variant_id,
        v_line.qty, 'sale_return', 'order', p_order_id,
        'Restocked from ' || p_to_status::text || ' order'
      );
    end loop;
  end if;

  return p_to_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Record a payment against an order. Refuses to take more than is outstanding.
-- ---------------------------------------------------------------------------
create or replace function public.record_payment(
  p_order_id uuid,
  p_amount   numeric,
  p_method   public.payment_method default 'cash',
  p_paid_at  timestamptz default null,
  p_note     text default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid;
  v_store  uuid;
  v_total  numeric(14,2);
  v_paid   numeric(14,2);
  v_outstanding numeric(14,2);
  -- orders.status and orders.payment_status are different enums; they need
  -- separate variables or the assignment raises a cast error.
  v_order_status public.order_status;
  v_status public.payment_status;
begin
  select public.assert_store_access(o.store_id), o.org_id, o.store_id,
         o.total, o.amount_paid, o.status, o.payment_status
    into v_org, v_org, v_store, v_total, v_paid, v_order_status, v_status
  from public.orders o
  where o.id = p_order_id;

  if v_total is null then
    raise exception 'order_not_found' using hint = 'That order no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  if v_order_status in ('cancelled', 'returned') then
    raise exception 'order_closed'
      using hint = 'This order is ' || v_order_status::text || '. Record a refund instead.';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_payment' using hint = 'Enter an amount greater than zero.';
  end if;

  v_outstanding := v_total - v_paid;

  if p_amount > v_outstanding then
    raise exception 'overpayment'
      using hint = 'Only ' || v_outstanding::text || ' is outstanding on this order.';
  end if;

  insert into public.payments (
    org_id, store_id, order_id, amount, method, is_refund, paid_at, note, created_by
  ) values (
    v_org, v_store, p_order_id, p_amount, p_method, false, coalesce(p_paid_at, now()), p_note, auth.uid()
  );

  v_paid := v_paid + p_amount;
  v_status := case when v_paid >= v_total then 'paid'::public.payment_status
                   else 'partial'::public.payment_status end;

  update public.orders set amount_paid = v_paid, payment_status = v_status, updated_at = now()
   where id = p_order_id;

  return v_paid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Refund. Recorded as its own row so gross received and refunded can be
-- reported separately.
-- ---------------------------------------------------------------------------
create or replace function public.record_refund(
  p_order_id uuid,
  p_amount   numeric,
  p_method   public.payment_method default 'cash',
  p_note     text default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org   uuid;
  v_store uuid;
  v_paid  numeric(14,2);
  v_refunded numeric(14,2);
begin
  select public.assert_store_access(o.store_id), o.org_id, o.store_id, o.amount_paid
    into v_org, v_org, v_store, v_paid
  from public.orders o
  where o.id = p_order_id;

  if v_paid is null then
    raise exception 'order_not_found' using hint = 'That order no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_payment' using hint = 'Enter an amount greater than zero.';
  end if;

  select coalesce(sum(amount), 0) into v_refunded
  from public.payments
  where order_id = p_order_id and is_refund;

  if p_amount > v_paid - v_refunded then
    raise exception 'overpayment'
      using hint = 'Only ' || (v_paid - v_refunded)::text || ' can be refunded on this order.';
  end if;

  insert into public.payments (
    org_id, store_id, order_id, amount, method, is_refund, paid_at, note, created_by
  ) values (
    v_org, v_store, p_order_id, p_amount, p_method, true, now(), p_note, auth.uid()
  );

  update public.orders
     set payment_status = 'refunded', updated_at = now()
   where id = p_order_id
     and amount_paid - (select coalesce(sum(amount), 0) from public.payments
                        where order_id = p_order_id and is_refund) <= 0;

  return v_refunded + p_amount;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. These are the only mutation paths the client has.
-- ---------------------------------------------------------------------------
revoke all on function
  public.bootstrap_business(text, text, text),
  public.next_order_number(uuid),
  public.apply_stock_delta(uuid, uuid, uuid, uuid, integer, public.inventory_reason, text, uuid, text),
  public.adjust_stock(uuid, uuid, uuid, integer, public.inventory_reason, text),
  public.create_order(uuid, uuid, jsonb, numeric, numeric, numeric, public.payment_method, text, uuid, timestamptz),
  public.status_transition_allowed(public.order_status, public.order_status),
  public.allowed_order_statuses(uuid),
  public.set_order_status(uuid, public.order_status, text),
  public.record_payment(uuid, numeric, public.payment_method, timestamptz, text),
  public.record_refund(uuid, numeric, public.payment_method, text)
from public, anon;

grant execute on function
  public.bootstrap_business(text, text, text),
  public.adjust_stock(uuid, uuid, uuid, integer, public.inventory_reason, text),
  public.create_order(uuid, uuid, jsonb, numeric, numeric, numeric, public.payment_method, text, uuid, timestamptz),
  public.allowed_order_statuses(uuid),
  public.set_order_status(uuid, public.order_status, text),
  public.record_payment(uuid, numeric, public.payment_method, timestamptz, text),
  public.record_refund(uuid, numeric, public.payment_method, text)
to authenticated;

-- Internal helpers stay callable from other definer functions but are not
-- exposed to the client.
revoke execute on function
  public.next_order_number(uuid),
  public.apply_stock_delta(uuid, uuid, uuid, uuid, integer, public.inventory_reason, text, uuid, text)
from public, anon, authenticated;
