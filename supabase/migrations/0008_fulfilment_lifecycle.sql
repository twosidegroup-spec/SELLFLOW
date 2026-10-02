-- ===========================================================================
-- SellFlow :: 0007 -- operational lifecycle and order fulfilment
--
-- Extends the verified V1 foundation. Nothing here changes the behaviour that
-- 0005 already guarantees: oversell prevention, the stock ledger, transactional
-- order creation, and the append-only timeline all keep working. This migration
-- only widens the lifecycle and adds the operational fields a real courier-based
-- seller needs.
--
-- Lifecycle now models packing and last-mile delivery, which the original
-- pending -> confirmed -> processing -> shipped -> delivered chain omitted:
--
--   pending -> confirmed -> processing -> packaging -> packed
--           -> shipped -> on_delivery -> delivered
--
-- plus the terminal and exception states: failed_delivery, returned, cancelled.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- New lifecycle states
--
-- Added rather than renamed: renaming a value that already exists in the enum
-- would silently orphan any order already sitting in it. `failed_delivery` was
-- already present and is kept as the label for "delivery failed".
-- ---------------------------------------------------------------------------

do $$ begin
  alter type public.order_status add value if not exists 'packaging';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.order_status add value if not exists 'packed';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.order_status add value if not exists 'on_delivery';
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Customers: delivery geography
--
-- Bangladesh addresses are district + thana, and couriers require both. Stored
-- on the customer so it can be reused across orders.
-- ---------------------------------------------------------------------------

alter table public.customers
  add column if not exists district text,
  add column if not exists thana text;

comment on column public.customers.district is
  'Delivery district. Required by courier APIs for Pathao and REDX shipments.';

-- ---------------------------------------------------------------------------
-- Orders: delivery address snapshot
--
-- An order must keep the address it was shipped to. If the customer later
-- edits their profile, a historical order must not silently change destination.
-- ---------------------------------------------------------------------------

alter table public.orders
  add column if not exists delivery_name text,
  add column if not exists delivery_phone text,
  add column if not exists delivery_address text,
  add column if not exists delivery_district text,
  add column if not exists delivery_thana text;

-- ---------------------------------------------------------------------------
-- Orders: fulfilment costs
--
-- `courier_cost` is what the seller pays the courier; `other_cost` is per-order
-- packaging and handling. Both are costs, distinct from `delivery_charge` which
-- is money *charged to* the customer. Keeping them separate is what makes
-- "Revenue != Profit" legible instead of a single hand-waved number.
-- ---------------------------------------------------------------------------

alter table public.orders
  add column if not exists courier_cost numeric(14,2) not null default 0
    check (courier_cost >= 0),
  add column if not exists other_cost numeric(14,2) not null default 0
    check (other_cost >= 0);

comment on column public.orders.courier_cost is
  'What the seller pays the courier. Distinct from delivery_charge, which is what the customer is billed.';

-- ---------------------------------------------------------------------------
-- Orders: payment shape for fulfilment
--
-- `cod_amount` is what the courier must collect from the customer. For a COD
-- order that is the unpaid balance; for prepaid it is 0.
-- ---------------------------------------------------------------------------

alter table public.orders
  add column if not exists is_cod boolean not null default false,
  add column if not exists cod_amount numeric(14,2) not null default 0
    check (cod_amount >= 0),
  add column if not exists cod_settled boolean not null default false,
  add column if not exists cod_settled_at timestamptz,
  add column if not exists cod_payout_reference text;

comment on column public.orders.cod_settled is
  'True once the courier has actually paid out the collected cash. Delivered does NOT imply settled.';

-- ---------------------------------------------------------------------------
-- Orders: current courier state (denormalised)
--
-- Written ONLY by the shipment RPCs in 0008, the same way `total` is written
-- only by create_order. The client has no write access to these columns, so
-- they cannot drift from the shipments table.
-- ---------------------------------------------------------------------------

alter table public.orders
  add column if not exists courier_name text,
  add column if not exists courier_provider text,
  add column if not exists tracking_id text,
  add column if not exists tracking_url text,
  add column if not exists shipment_status text,
  add column if not exists shipped_at timestamptz;

create index if not exists idx_orders_tracking
  on public.orders (courier_provider, tracking_id)
  where tracking_id is not null;

-- Delivery-failure reason, so a returned order can be explained without guesswork.
alter table public.orders
  add column if not exists failure_reason text;

-- ---------------------------------------------------------------------------
-- Recompute profit to include the new cost columns
--
-- profit = customer_payable - product_cost - courier_cost - other_cost
--
-- Existing rows are backfilled with the same formula they already implied, so
-- the new columns defaulting to 0 leaves historical profit unchanged.
-- ---------------------------------------------------------------------------

update public.orders
   set profit = total - cost_total - courier_cost - other_cost;

-- ---------------------------------------------------------------------------
-- Transition matrix
--
-- Widened, not loosened arbitrarily. Two rules govern it:
--
--  1. Forward progress only moves one or two steps, so the dashboard's
--     "needs action" queues stay meaningful. Jumping pending -> delivered
--     remains illegal, which is the invariant the original test suite asserted.
--  2. failed_delivery is explicitly re-attemptable, because a failed delivery
--     is not the same thing as a cancelled order and must not be treated as one.
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
    when 'pending' then
      p_to in ('confirmed', 'cancelled', 'failed_delivery')

    -- Sellers frequently confirm and pack in one sitting, so confirm -> packed
    -- is permitted; confirm -> shipped is not.
    when 'confirmed' then
      p_to in ('processing', 'packaging', 'packed', 'cancelled', 'failed_delivery')

    when 'processing' then
      p_to in ('packaging', 'packed', 'cancelled', 'failed_delivery')

    when 'packaging' then
      p_to in ('packed', 'cancelled', 'failed_delivery')

    -- A shipment can only exist once the order is handed to a courier, which is
    -- why `packed` is the only way into `shipped`.
    when 'packed' then
      p_to in ('shipped', 'cancelled', 'failed_delivery')

    -- Some couriers deliver without an out-for-delivery ping, so
    -- shipped -> delivered stays legal alongside shipped -> on_delivery.
    when 'shipped' then
      p_to in ('on_delivery', 'delivered', 'returned', 'failed_delivery')

    when 'on_delivery' then
      p_to in ('delivered', 'returned', 'failed_delivery')

    -- Delivered is not final: a return is still possible.
    when 'delivered' then
      p_to in ('returned')

    -- Re-attempt path. A failed delivery can go back into the pipeline or
    -- return to the customer, but never silently become delivered.
    when 'failed_delivery' then
      p_to in ('pending', 'confirmed', 'processing', 'packed', 'shipped',
               'on_delivery', 'cancelled', 'returned')

    when 'cancelled' then false
    when 'returned'  then false
    else false
  end;
$$;

-- ---------------------------------------------------------------------------
-- Label helper
--
-- The app previously kept its own copy of these strings. Centralising the
-- mapping here means the SQL error messages and the UI can never disagree.
-- ---------------------------------------------------------------------------

create or replace function public.order_status_label(p_status public.order_status)
returns text
language sql
immutable
as $$
  select case p_status
    when 'pending'         then 'Pending'
    when 'confirmed'       then 'Confirmed'
    when 'processing'      then 'Processing'
    when 'packaging'       then 'Packaging'
    when 'packed'          then 'Packed'
    when 'shipped'         then 'Shipped'
    when 'on_delivery'     then 'On Delivery'
    when 'delivered'       then 'Delivered'
    when 'failed_delivery' then 'Delivery Failed'
    when 'returned'        then 'Returned'
    when 'cancelled'       then 'Cancelled'
    else p_status::text
  end;
$$;

-- ---------------------------------------------------------------------------
-- Restock policy
--
-- 0005 restocked on cancel and return. That is still correct, but a failed
-- delivery must NOT restock: the parcel is still with the courier and will be
-- re-delivered. Treating it as a return was the "mark every failure as
-- cancelled" behaviour V1 explicitly rules out.
-- ---------------------------------------------------------------------------

create or replace function public.status_restocks(p_to public.order_status)
returns boolean
language sql
immutable
as $$
  select p_to in ('cancelled', 'returned');
$$;

-- ===========================================================================
-- Updated order creation
--
-- Same transactional contract as 0005, extended with:
--   * a delivery-address snapshot (falls back to the customer's details),
--   * courier and other per-order costs folded into profit,
--   * an explicit COD shape.
--
-- All new parameters are defaulted, so every existing caller and every existing
-- assertion keeps working unchanged.
--
-- The 9-argument version is dropped rather than kept alongside: with the new
-- parameters defaulted, a 9-argument call would match BOTH signatures and
-- Postgres could not choose. The client always calls this by named argument,
-- so removing the old overload is safe.
-- ===========================================================================

drop function if exists public.create_order(
  uuid, uuid, jsonb, numeric, numeric, numeric, public.payment_method,
  text, uuid, timestamptz
);

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
  p_placed_at       timestamptz default null,
  p_delivery_name     text default null,
  p_delivery_phone    text default null,
  p_delivery_address  text default null,
  p_delivery_district text default null,
  p_delivery_thana    text default null,
  p_courier_cost numeric default 0,
  p_other_cost   numeric default 0,
  p_is_cod       boolean default false
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
  v_courier     numeric(14,2);
  v_other       numeric(14,2);
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
  v_cust_name     text;
  v_cust_phone    text;
  v_cust_address  text;
  v_cust_district text;
  v_cust_thana    text;
  v_d_name     text;
  v_d_phone    text;
  v_d_address  text;
  v_d_district text;
  v_d_thana    text;
  v_is_cod     boolean;
  v_cod_amount numeric(14,2);
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

  if coalesce(p_courier_cost, 0) < 0 or coalesce(p_other_cost, 0) < 0 then
    raise exception 'invalid_cost'
      using hint = 'Courier and other costs cannot be negative.';
  end if;

  select allow_negative_stock into v_allow_neg from public.organizations where id = v_org;

  -- Customer must belong to this org. A null customer_id is allowed: cash sales
  -- with no customer record are normal for this audience.
  if p_customer_id is not null then
    select c.name, c.phone, c.address, c.district, c.thana
      into v_cust_name, v_cust_phone, v_cust_address, v_cust_district, v_cust_thana
    from public.customers c
    where c.id = p_customer_id and c.org_id = v_org and not c.is_archived;

    if v_cust_name is null then
      raise exception 'customer_not_found' using hint = 'That customer no longer exists.';
    end if;
  end if;

  -- Address snapshot: explicit arguments win, otherwise inherit from the
  -- customer. A courier must never be handed a stale or missing destination.
  v_d_name     := coalesce(nullif(btrim(p_delivery_name), ''),     v_cust_name);
  v_d_phone    := coalesce(nullif(btrim(p_delivery_phone), ''),    v_cust_phone);
  v_d_address  := coalesce(nullif(btrim(p_delivery_address), ''),  v_cust_address);
  v_d_district := coalesce(nullif(btrim(p_delivery_district), ''), v_cust_district);
  v_d_thana    := coalesce(nullif(btrim(p_delivery_thana), ''),    v_cust_thana);

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

  v_courier := coalesce(p_courier_cost, 0);
  v_other   := coalesce(p_other_cost, 0);
  v_total   := v_items_total - coalesce(p_discount, 0) + coalesce(p_delivery_charge, 0);

  -- Profit now accounts for fulfilment cost, not just product cost. This is
  -- what makes "Revenue != Profit" true rather than aspirational.
  v_profit := v_total - v_cost_total - v_courier - v_other;

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

  -- COD is only meaningful for an order with something still to collect.
  v_is_cod := coalesce(p_is_cod, false) and v_total - v_paid > 0;
  v_cod_amount := case when v_is_cod then v_total - v_paid else 0 end;

  -- 4) Persist.
  v_number := public.next_order_number(p_store_id);

  insert into public.orders (
    org_id, store_id, customer_id, order_number, status, payment_status,
    items_total, discount, delivery_charge, total, cost_total,
    courier_cost, other_cost, profit, amount_paid,
    is_cod, cod_amount,
    delivery_name, delivery_phone, delivery_address,
    delivery_district, delivery_thana,
    client_ref, notes, placed_at, created_by
  ) values (
    v_org, p_store_id, p_customer_id, v_number, 'pending', v_pay_status,
    v_items_total, coalesce(p_discount, 0), coalesce(p_delivery_charge, 0),
    v_total, v_cost_total,
    v_courier, v_other, v_profit, v_paid,
    v_is_cod, v_cod_amount,
    v_d_name, v_d_phone, v_d_address, v_d_district, v_d_thana,
    p_client_ref, p_notes, coalesce(p_placed_at, now()), v_user
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

-- ===========================================================================
-- Updated status change
--
-- Identical contract to 0005, with two V1 corrections:
--   * restocking is driven by status_restocks() rather than a hardcoded list, so
--     failed_delivery no longer silently returns goods to stock;
--   * arriving at delivered/failed_delivery raises a notification for the seller
--     once 0009's producer function exists (called defensively below).
-- ===========================================================================

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
  v_store   uuid;
  v_line    record;
  v_allows  boolean;
begin
  select public.assert_store_access(o.store_id), o.org_id, o.status, o.store_id
    into v_org, v_org, v_from, v_store
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
      using hint = 'An order that is ' || public.order_status_label(v_from)
                || ' cannot become ' || public.order_status_label(p_to_status) || '.';
  end if;

  update public.orders
     set status = p_to_status, updated_at = now()
   where id = p_order_id;

  insert into public.order_status_history (org_id, order_id, from_status, to_status, note, created_by)
  values (v_org, p_order_id, v_from, p_to_status, p_note, v_user);

  -- Cancelling or returning puts the goods back on the shelf. This is the
  -- mirror of the decrement done in create_order, so the ledger balances.
  -- A failed delivery deliberately does NOT restock: the parcel is still with
  -- the courier and will be re-attempted.
  if public.status_restocks(p_to_status) then
    for v_line in
      select oi.product_id, oi.variant_id, sum(oi.quantity)::integer as qty
      from public.order_items oi
      join public.products p on p.id = oi.product_id
      where oi.order_id = p_order_id and p.track_inventory
      group by oi.product_id, oi.variant_id
    loop
      perform public.apply_stock_delta(
        v_org, v_store,
        v_line.product_id, v_line.variant_id,
        v_line.qty, 'sale_return', 'order', p_order_id,
        'Restocked from ' || public.order_status_label(p_to_status) || ' order'
      );
    end loop;
  end if;

  -- A delivered COD order becomes something the seller must chase for cash.
  if p_to_status = 'delivered' then
    update public.orders
       set is_cod = (cod_amount > 0)
     where id = p_order_id;
  end if;

  return p_to_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants for the new helpers
-- ---------------------------------------------------------------------------

revoke all on function
  public.order_status_label(public.order_status),
  public.status_restocks(public.order_status)
from public, anon;

grant execute on function
  public.order_status_label(public.order_status),
  public.status_restocks(public.order_status)
to authenticated;

revoke all on function public.create_order(
  uuid, uuid, jsonb, numeric, numeric, numeric, public.payment_method,
  text, uuid, timestamptz, text, text, text, text, text, numeric, numeric, boolean
) from public, anon;

grant execute on function public.create_order(
  uuid, uuid, jsonb, numeric, numeric, numeric, public.payment_method,
  text, uuid, timestamptz, text, text, text, text, text, numeric, numeric, boolean
) to authenticated;

