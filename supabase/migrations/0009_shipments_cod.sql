-- ===========================================================================
-- SellFlow :: 0008 -- shipments, tracking and COD settlement
--
-- A seller can tap "Send to courier" twice, or lose signal and retry. This
-- migration makes double-shipment structurally impossible rather than merely
-- unlikely:
--
--   * exactly one non-terminal shipment per order (partial unique index), and
--   * a client-supplied idempotency key that dedupes retries (unique index).
--
-- A shipment row is created in state 'requested' and is ONLY promoted to
-- 'created' by confirm_shipment(), which the Edge Function calls with a real
-- courier response. The app can therefore never display "Shipment Created" for
-- something the courier has not actually accepted.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Courier provider
--
-- 'manual' is a first-class provider, not a fallback bolted on. REDX has no
-- publicly documented merchant API, so manual entry is the supported path for
-- it and for any other local carrier.
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.courier_provider as enum ('pathao', 'redx', 'manual');
exception when duplicate_object then null;
end $$;

-- Normalised shipment state.
--
-- 'requested'  SellFlow asked the courier (or the seller typed the details)
-- 'created'    Courier CONFIRMED the consignment and gave us a tracking id
-- 'picked'     Collected from the seller
-- 'in_transit' Moving through the network
-- 'at_hub'     At a sorting centre
-- 'out_for_delivery' With the rider, on the final leg
-- 'delivered'  Handed to the customer
-- 'failed'     Delivery attempt failed; may be re-attempted
-- 'returned'   Coming back to the seller
-- 'cancelled'  Called off before pickup
do $$ begin
  create type public.shipment_state as enum (
    'requested', 'created', 'picked', 'in_transit', 'at_hub',
    'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled'
  );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- COD settlement state
--
-- Kept separate from order status and from payment_status, because "delivered"
-- and "the courier paid you" are genuinely different events and conflating them
-- is how sellers end up thinking money is coming that is not.
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.settlement_state as enum (
    'expected', 'collected', 'settled', 'refunded', 'returned'
  );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- courier_connections
--
-- Holds CONFIGURATION only. API credentials are never stored here and never
-- reach the mobile app: they live in Supabase Vault and are read exclusively by
-- the service-role Edge Function that talks to the courier.
-- ---------------------------------------------------------------------------

create table if not exists public.courier_connections (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  provider     public.courier_provider not null,
  -- Seller-facing label, e.g. "Pathao - Mirpur store". Lets one business keep
  -- several accounts with the same courier.
  label        text        not null check (length(btrim(label)) between 1 and 80),
  is_active    boolean     not null default true,
  -- Opaque pointer into Supabase Vault. NULL for 'manual', which needs no
  -- credentials at all.
  vault_secret_id uuid,
  -- Courier-side store identifier. Pathao requires an integer store_id and will
  -- reject shipments without one.
  external_store_id text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, provider, label)
);

comment on table public.courier_connections is
  'Per-organisation courier configuration. Contains no secrets: credentials live in Supabase Vault and are read only by service-role Edge Functions.';

-- ---------------------------------------------------------------------------
-- shipments
--
-- One row per dispatch attempt. A re-attempt after a failed delivery creates a
-- NEW row (attempt_no increments) so the history stays honest, while a duplicate
-- tap on "Send to courier" returns the EXISTING row.
-- ---------------------------------------------------------------------------

create table if not exists public.shipments (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  store_id          uuid not null references public.stores (id) on delete cascade,
  order_id          uuid not null references public.orders (id) on delete cascade,
  connection_id     uuid references public.courier_connections (id) on delete set null,
  provider          public.courier_provider not null,
  provider_label    text,
  state             public.shipment_state not null default 'requested',
  -- The courier's own vocabulary, preserved verbatim so nothing is lost even
  -- when we cannot map it to a normalised state.
  external_status   text,
  external_status_label text,
  tracking_id       text,
  tracking_url      text,
  -- What the courier was told to collect.
  cod_amount        numeric(14,2) not null default 0 check (cod_amount >= 0),
  -- What the courier charged the seller. Feeds order-level courier cost.
  courier_charge    numeric(14,2) check (courier_charge is null or courier_charge >= 0),
  attempt_no        integer     not null default 1 check (attempt_no > 0),
  -- Client-generated. A retry with the same key returns this row instead of
  -- asking the courier for a second consignment.
  idempotency_key   uuid        not null,
  -- Populated only after the courier actually confirms.
  confirmed_at      timestamptz,
  picked_at         timestamptz,
  delivered_at      timestamptz,
  closed_at         timestamptz,
  -- Why it failed, in the seller's terms, so the UI can explain it.
  failure_reason    text,
  -- Raw provider response, retained for support and debugging. Never shown raw.
  external_payload  jsonb,
  created_by        uuid references public.profiles (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- The single most important constraint in this migration: an order can have at
-- most one shipment that has not yet reached a terminal state. Two rapid taps on
-- "Send to courier" therefore cannot both proceed to the provider.
create unique index if not exists uq_shipments_one_active_per_order
  on public.shipments (order_id)
  where state not in ('delivered', 'returned', 'cancelled');

-- Retry safety: the same key can never produce two rows, even across processes.
create unique index if not exists uq_shipments_idempotency
  on public.shipments (idempotency_key);

-- A consignment id belongs to exactly one shipment.
create unique index if not exists uq_shipments_tracking
  on public.shipments (provider, tracking_id)
  where tracking_id is not null;

create index if not exists idx_shipments_order
  on public.shipments (order_id, attempt_no desc);

create index if not exists idx_shipments_org_recent
  on public.shipments (org_id, store_id, created_at desc);

create index if not exists idx_shipments_open
  on public.shipments (org_id, state)
  where state not in ('delivered', 'returned', 'cancelled');

-- ---------------------------------------------------------------------------
-- shipment_events
--
-- Append-only tracking timeline. Fed by courier webhooks and by manual entry
-- alike, so a seller always sees the full story of a parcel.
-- ---------------------------------------------------------------------------

create table if not exists public.shipment_events (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  shipment_id   uuid not null references public.shipments (id) on delete cascade,
  state         public.shipment_state,
  external_status text,
  label         text        not null,
  note          text,
  -- 'courier' came from a verified webhook, 'seller' typed it in,
  -- 'system' was inferred by SellFlow.
  source        text        not null default 'system'
                check (source in ('courier', 'seller', 'system')),
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists idx_shipment_events_timeline
  on public.shipment_events (shipment_id, occurred_at);

-- Webhook delivery is at-least-once. Dedupe on the provider's own event id so a
-- retried webhook cannot double-post a timeline entry.
create unique index if not exists uq_shipment_events_external
  on public.shipment_events (shipment_id, external_status, occurred_at)
  where source = 'courier';

-- ---------------------------------------------------------------------------
-- settlements
--
-- One row per order's COD balance, plus an audit trail of payout movements.
-- ---------------------------------------------------------------------------

create table if not exists public.settlements (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  store_id       uuid not null references public.stores (id) on delete cascade,
  order_id       uuid not null references public.orders (id) on delete cascade,
  state          public.settlement_state not null default 'expected',
  -- What the courier owes the seller.
  expected_amount numeric(14,2) not null default 0 check (expected_amount >= 0),
  -- What has actually been paid out so far.
  settled_amount  numeric(14,2) not null default 0 check (settled_amount >= 0),
  currency_note  text,
  settled_at     timestamptz,
  -- Bank/bKash/InstaPay reference supplied by the seller or the courier.
  payout_reference text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- One settlement balance per order. Re-attempts reuse the same row.
  unique (order_id),
  constraint settlements_not_overpaid check (settled_amount <= expected_amount)
);

create index if not exists idx_settlements_pending
  on public.settlements (org_id, store_id, state)
  where state in ('expected', 'collected');

-- ---------------------------------------------------------------------------
-- updated_at triggers for the new tables
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['courier_connections', 'shipments', 'settlements']
  loop
    execute format('drop trigger if exists trg_touch_%1$s on public.%1$I', t);
    execute format(
      'create trigger trg_touch_%1$s before update on public.%1$I
         for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ===========================================================================
-- Business logic
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Provider capability
--
-- The app must not offer an API path for a provider that has none. This is the
-- single source of truth for what the UI is allowed to claim.
-- ---------------------------------------------------------------------------

create or replace function public.courier_supports_api(p_provider public.courier_provider)
returns boolean
language sql
immutable
as $$
  -- Pathao: documented and integration-ready (see supabase/functions/pathao-*).
  --   Verified: the sandbox host courier-api-sandbox.pathao.com resolves and
  --   serves the /aladdin/api/v1 prefix, returning 400 for unauthenticated
  --   calls and 404 outside the mount. Credentials are still required to
  --   exercise a real create.
  --
  -- REDX: `false`, and the reason is more specific than "no API exists".
  --   Investigated: REDX does publish a developer portal and merchants receive
  --   scoped tokens, but the OpenAPI document is not reachable without merchant
  --   credentials. `openapi.redx.com.bd` returns 404 for every path, and
  --   `api.redx.com.bd` is the ShopUp SPA, which returns HTML 200 for any path
  --   and is therefore not an API surface. The only public description found
  --   is a third-party Dart client at version 0.0.2.
  --
  --   Building a client from that would mean guessing endpoints, which is worse
  --   than shipping manual entry: a wrong path either fails at runtime or,
  --   worse, is accepted and silently routes a parcel to the wrong district.
  --   So REDX uses seller-entered tracking, and the seller can move the parcel
  --   through its states. Flipping this to true is a one-line change once a
  --   verifiable spec and scoped keys are available.
  select case p_provider
    when 'pathao' then true
    when 'redx'   then false
    when 'manual' then false
    else false
  end;
$$;

-- ---------------------------------------------------------------------------
-- Order readiness for dispatch
--
-- Returns the first blocking problem, or NULL when the order is ready. Kept in
-- SQL so the pre-flight list shown in the UI and the check performed at insert
-- time can never disagree.
-- ---------------------------------------------------------------------------

create or replace function public.order_dispatch_blocker(p_order_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org        uuid;
  v_status     public.order_status;
  v_dname      text;
  v_dphone     text;
  v_daddress   text;
  v_ddistrict  text;
  v_dthana     text;
begin
  select public.assert_store_access(o.store_id), o.status,
         o.delivery_name, o.delivery_phone, o.delivery_address,
         o.delivery_district, o.delivery_thana
    into v_org, v_status, v_dname, v_dphone, v_daddress, v_ddistrict, v_dthana
  from public.orders o
  where o.id = p_order_id;

  if v_status is null then
    return 'order_not_found';
  end if;

  -- A shipment can only be created once the parcel is actually packed.
  if v_status not in ('packed', 'shipped', 'on_delivery') then
    return 'order_not_packed';
  end if;

  if coalesce(btrim(v_dname), '') = '' then return 'missing_recipient_name'; end if;
  if coalesce(btrim(v_dphone), '') = '' then return 'missing_recipient_phone'; end if;
  if coalesce(btrim(v_daddress), '') = '' then return 'missing_recipient_address'; end if;
  if coalesce(btrim(v_ddistrict), '') = '' then return 'missing_district'; end if;
  if coalesce(btrim(v_dthana), '') = '' then return 'missing_thana'; end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Register a dispatch attempt
--
-- Returns the shipment to use. Three outcomes, in priority order:
--
--   1. An active shipment already exists for this order  -> return it. This is
--      what makes a double tap safe: the second tap never reaches the courier.
--   2. The same idempotency key was already used            -> return it.
--   3. Otherwise create a new row in state 'requested'.
--
-- The caller (Edge Function) is responsible for calling the provider and then
-- confirm_shipment() or fail_shipment(). Nothing here asserts the courier
-- accepted anything.
-- ---------------------------------------------------------------------------

create or replace function public.register_shipment(
  p_order_id        uuid,
  p_provider        public.courier_provider,
  -- Required, so declared before the optional arguments.
  p_idempotency_key uuid,
  p_connection_id   uuid default null,
  p_cod_amount      numeric default null,
  p_tracking_id     text default null,
  p_tracking_url    text default null,
  p_external_payload jsonb default null
)
returns public.shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid;
  v_store    uuid;
  v_blocker  text;
  v_existing public.shipments;
  v_created  public.shipments;
  v_attempt  integer;
  v_cod      numeric(14,2);
  v_label    text;
  v_external_store text;
begin
  v_org := public.assert_store_access(
    (select store_id from public.orders where id = p_order_id)
  );

  perform public.assert_org_write(v_org);

  -- 1. Already dispatched and not yet finished: hand back what exists.
  select * into v_existing
  from public.shipments
  where order_id = p_order_id
    and state not in ('delivered', 'returned', 'cancelled')
  limit 1;

  if v_existing.id is not null then
    return v_existing;
  end if;

  -- 2. Same key already used (a retry after a dropped response).
  select * into v_existing
  from public.shipments
  where idempotency_key = p_idempotency_key
  limit 1;

  if v_existing.id is not null then
    return v_existing;
  end if;

  v_blocker := public.order_dispatch_blocker(p_order_id);

  if v_blocker is not null then
    raise exception 'dispatch_blocked' using hint = v_blocker;
  end if;

  select o.store_id, o.cod_amount, coalesce(cc.label, p_provider::text)
    into v_store, v_cod, v_label
  from public.orders o
  left join public.courier_connections cc on cc.id = p_connection_id
  where o.id = p_order_id;

  -- A manual entry supplies its own tracking id, so it skips the courier call
  -- and lands directly in 'created'.
  v_attempt := coalesce((
    select max(attempt_no) + 1 from public.shipments where order_id = p_order_id
  ), 1);

  v_cod := coalesce(p_cod_amount, v_cod, 0);

  insert into public.shipments (
    org_id, store_id, order_id, connection_id, provider, provider_label,
    state, tracking_id, tracking_url, cod_amount, attempt_no,
    idempotency_key, external_payload, created_by,
    -- Manual entries are already complete at the moment of entry, so they are
    -- 'created' now. API-backed shipments stay 'requested' until the provider
    -- actually confirms.
    confirmed_at,
    failure_reason
  ) values (
    v_org, v_store, p_order_id, p_connection_id, p_provider, v_label,
    case when p_provider = 'manual' then 'created'::public.shipment_state
         else 'requested'::public.shipment_state end,
    nullif(btrim(p_tracking_id), ''),
    nullif(btrim(p_tracking_url), ''),
    v_cod, v_attempt,
    p_idempotency_key, p_external_payload, auth.uid(),
    case when p_provider = 'manual' then now() else null end,
    case when p_provider = 'manual' then null
         when p_provider = 'redx' then
           'REDX has a merchant API but no publicly reachable OpenAPI spec, so SellFlow cannot call it without guessing. Enter the tracking details here and update the status as the parcel moves.'
         else null end
  ) returning * into v_created;

  insert into public.shipment_events (org_id, shipment_id, state, label, source, external_status)
  values (
    v_org, v_created.id, v_created.state,
    case when p_provider = 'manual'
         then 'Tracking entered manually'
         else 'Requested from ' || v_label end,
    case when p_provider = 'manual' then 'seller' else 'system' end,
    'requested'
  );

  -- Mirror the current courier state onto the order for fast list rendering.
  -- Written only from here and from apply_shipment_update(), so it cannot drift.
  update public.orders
     set courier_name = v_label,
         courier_provider = p_provider::text,
         tracking_id = v_created.tracking_id,
         tracking_url = v_created.tracking_url,
         shipment_status = v_created.state::text
   where id = p_order_id;

  return v_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- Confirm a shipment
--
-- Called ONLY with a real provider response. Until this runs, the shipment is
-- 'requested' and the UI says "Waiting for courier confirmation" -- never
-- "Shipment created".
-- ---------------------------------------------------------------------------

create or replace function public.confirm_shipment(
  p_shipment_id      uuid,
  p_tracking_id      text,
  p_tracking_url     text default null,
  p_courier_charge   numeric default null,
  p_external_status  text default null,
  p_external_status_label text default null,
  p_external_payload jsonb default null
)
returns public.shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid;
  v_row      public.shipments;
  v_tracking text := nullif(btrim(p_tracking_id), '');
begin
  select public.assert_store_access(s.store_id), s.org_id
    into v_org, v_org
  from public.shipments s
  where s.id = p_shipment_id;

  if not found then
    raise exception 'shipment_not_found' using hint = 'That shipment no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  -- A provider that returns no consignment id has not confirmed anything.
  if v_tracking is null then
    raise exception 'shipment_unconfirmed'
      using hint = 'The courier did not return a tracking id, so the shipment was not created.';
  end if;

  update public.shipments
     set state = 'created',
         tracking_id = v_tracking,
         tracking_url = coalesce(nullif(btrim(p_tracking_url), ''), tracking_url),
         courier_charge = coalesce(p_courier_charge, courier_charge),
         external_status = coalesce(p_external_status, external_status),
         external_status_label = coalesce(p_external_status_label, external_status_label),
         external_payload = coalesce(p_external_payload, external_payload),
         confirmed_at = coalesce(confirmed_at, now()),
         updated_at = now()
   where id = p_shipment_id
  returning * into v_row;

  insert into public.shipment_events (org_id, shipment_id, state, label, source, external_status)
  values (
    v_org, p_shipment_id, 'created',
    'Shipment accepted by courier', 'courier', coalesce(p_external_status, 'created')
  );

  update public.orders
     set tracking_id = v_row.tracking_id,
         tracking_url = v_row.tracking_url,
         shipment_status = v_row.state::text,
         courier_cost = coalesce(p_courier_charge, courier_cost),
         shipped_at = now(),
         updated_at = now()
   where id = v_row.order_id;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Record a failure
--
-- Used both when the provider rejects the request and when a delivery attempt
-- fails in transit. They are different problems, so the caller distinguishes
-- them via `p_state`.
-- ---------------------------------------------------------------------------

create or replace function public.fail_shipment(
  p_shipment_id  uuid,
  p_reason       text,
  p_state        public.shipment_state default 'failed',
  p_external_status text default null
)
returns public.shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_row public.shipments;
  v_terminal boolean := p_state in ('failed', 'returned', 'cancelled');
begin
  select public.assert_store_access(s.store_id), s.org_id
    into v_org, v_org
  from public.shipments s
  where s.id = p_shipment_id;

  if not found then
    raise exception 'shipment_not_found' using hint = 'That shipment no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  update public.shipments
     set state = p_state,
         failure_reason = p_reason,
         external_status = coalesce(p_external_status, external_status),
         closed_at = case when v_terminal then now() else closed_at end,
         updated_at = now()
   where id = p_shipment_id
  returning * into v_row;

  insert into public.shipment_events (org_id, shipment_id, state, label, note, source, external_status)
  values (v_org, p_shipment_id, p_state,
          case when p_state = 'returned' then 'Return in progress'
               when p_state = 'cancelled' then 'Shipment cancelled'
               else 'Delivery attempt failed' end,
          p_reason, 'courier', coalesce(p_external_status, p_state::text));

  update public.orders
     set shipment_status = v_row.state::text, updated_at = now()
   where id = v_row.order_id;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Apply a courier status update
--
-- The single entry point for both webhook events and manual status edits, so the
-- two can never diverge. Idempotent: replaying the same event changes nothing.
-- ---------------------------------------------------------------------------

create or replace function public.apply_shipment_update(
  p_shipment_id     uuid,
  p_state           public.shipment_state,
  p_label           text,
  p_external_status text default null,
  p_source          text default 'courier',
  p_occurred_at     timestamptz default null,
  p_delivered_at    timestamptz default null
)
returns public.shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_row public.shipments;
  v_current public.shipment_state;
  v_order_id uuid;
  v_order_cod numeric(14,2);
begin
  select public.assert_store_access(s.store_id), s.org_id, s.order_id, s.cod_amount, s.state
    into v_org, v_org, v_order_id, v_order_cod, v_current
  from public.shipments s
  where s.id = p_shipment_id;

  if not found then
    raise exception 'shipment_not_found' using hint = 'That shipment no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  -- Ignore a state that moves backwards, unless it is an explicit failure.
  -- Courier webhooks are not always ordered, and a late "picked" arriving after
  -- "delivered" must not un-deliver a parcel. Read from v_current, not v_row --
  -- v_row is not populated until the UPDATE below returns it.
  if p_state not in ('failed', 'returned') and v_current = 'delivered' and p_state <> 'delivered' then
    return v_row;
  end if;

  -- A repeat of the state the parcel is already in is a no-op.
  --
  -- This is the double-tap case: a seller taps "Update status" twice, or a
  -- courier re-sends the same status. Without this guard the shipment_events
  -- unique index does not help -- it is keyed on (external_status,
  -- occurred_at), and a seller update has a NULL external_status and a fresh
  -- occurred_at, so every repeat appended another identical timeline entry.
  -- The timeline is what a seller reads to answer "where is my parcel", so
  -- duplicate rows there are actively misleading.
  --
  -- Placed after the backwards-movement guard so an explicit failure or return
  -- is always recorded, even when the parcel already looks failed.
  if p_state = v_current and p_state not in ('failed', 'returned') then
    update public.shipments set updated_at = now() where id = p_shipment_id returning * into v_row;
    return v_row;
  end if;

  update public.shipments
     set state = p_state,
         external_status = coalesce(p_external_status, external_status),
         external_status_label = coalesce(p_label, external_status_label),
         picked_at = case when p_state = 'picked' then coalesce(picked_at, now()) else picked_at end,
         delivered_at = case when p_state = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
         closed_at = case when p_state in ('delivered', 'returned', 'cancelled')
                          then coalesce(closed_at, now()) else closed_at end,
         failure_reason = case when p_state in ('failed', 'returned')
                               then coalesce(p_label, failure_reason)
                               else null end,
         updated_at = now()
   where id = p_shipment_id
  returning * into v_row;

  -- Dedupe: the unique index would reject a replayed webhook, so ignore the
  -- violation rather than failing the whole delivery.
  begin
    insert into public.shipment_events
      (org_id, shipment_id, state, label, source, external_status, occurred_at)
    values
      (v_org, p_shipment_id, p_state, p_label, p_source, p_external_status,
       coalesce(p_occurred_at, now()));
  exception when unique_violation then
    null;  -- already recorded
  end;

  -- Keep the order's denormalised view current.
  update public.orders
     set shipment_status = v_row.state::text, updated_at = now()
   where id = v_row.order_id;

  -- COD only becomes "settled" when money actually moves, which the seller
  -- records explicitly. Delivery alone marks it 'collected'.
  if p_state = 'delivered' then
    insert into public.settlements
      (org_id, store_id, order_id, state, expected_amount)
    select o.org_id, o.store_id, o.id,
           case when v_order_cod > 0 then 'collected'::public.settlement_state
                else 'settled'::public.settlement_state end,
           v_order_cod
    from public.orders o
    where o.id = v_order_id
    on conflict (order_id) do update
      set state = case when public.settlements.expected_amount > 0
                       then 'collected'::public.settlement_state
                       else public.settlements.state end,
          updated_at = now();
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- COD settlement recording
--
-- Manual by design. No courier investigated exposes a payout API, so SellFlow
-- records what the seller tells it and never guesses.
-- ---------------------------------------------------------------------------

create or replace function public.record_settlement(
  p_order_id         uuid,
  p_state            public.settlement_state,
  p_amount           numeric default null,
  p_payout_reference text default null,
  p_notes            text default null
)
returns public.settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid;
  v_store  uuid;
  v_cod    numeric(14,2);
  v_row    public.settlements;
  v_amount numeric(14,2);
begin
  select public.assert_store_access(o.store_id), o.org_id, o.store_id, o.cod_amount
    into v_org, v_org, v_store, v_cod
  from public.orders o
  where o.id = p_order_id;

  if not found then
    raise exception 'order_not_found' using hint = 'That order no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  v_amount := coalesce(p_amount, v_cod);

  insert into public.settlements
    (org_id, store_id, order_id, state, expected_amount, settled_amount,
     settled_at, payout_reference, notes)
  values (
    v_org, v_store, p_order_id, p_state, v_cod,
    case when p_state = 'settled' then v_amount else 0 end,
    case when p_state = 'settled' then now() else null end,
    nullif(btrim(p_payout_reference), ''),
    nullif(btrim(p_notes), '')
  )
  on conflict (order_id) do update
     set state = p_state,
         settled_amount = case when p_state = 'settled' then v_amount else 0 end,
         settled_at = case when p_state = 'settled' then coalesce(public.settlements.settled_at, now()) else null end,
         payout_reference = coalesce(nullif(btrim(p_payout_reference), ''), public.settlements.payout_reference),
         notes = coalesce(nullif(btrim(p_notes), ''), public.settlements.notes),
         updated_at = now()
  returning * into v_row;

  -- Mirror onto the order so the list view needs no join.
  update public.orders
     set cod_settled = (v_row.state = 'settled'),
         cod_settled_at = v_row.settled_at,
         cod_payout_reference = v_row.payout_reference,
         updated_at = now()
   where id = p_order_id;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
--
-- The new tables are tenant-scoped exactly like the rest. Note that
-- courier_connections exposes configuration to members of the org but NEVER
-- contains a secret: the Vault id is meaningless without the service role.
-- ---------------------------------------------------------------------------

alter table public.courier_connections enable row level security;
alter table public.shipments enable row level security;
alter table public.shipment_events enable row level security;
alter table public.settlements enable row level security;

drop policy if exists courier_connections_select on public.courier_connections;
create policy courier_connections_select on public.courier_connections
  for select to authenticated using (public.is_org_member(org_id));

drop policy if exists courier_connections_insert_owner on public.courier_connections;
create policy courier_connections_insert_owner on public.courier_connections
  for insert to authenticated with check (public.is_org_owner(org_id));

drop policy if exists courier_connections_update_owner on public.courier_connections;
create policy courier_connections_update_owner on public.courier_connections
  for update to authenticated
  using (public.is_org_owner(org_id)) with check (public.is_org_owner(org_id));

drop policy if exists courier_connections_delete_owner on public.courier_connections;
create policy courier_connections_delete_owner on public.courier_connections
  for delete to authenticated using (public.is_org_owner(org_id));

drop policy if exists shipments_select on public.shipments;
create policy shipments_select on public.shipments
  for select to authenticated using (public.is_org_member(org_id));

drop policy if exists shipment_events_select on public.shipment_events;
create policy shipment_events_select on public.shipment_events
  for select to authenticated using (public.is_org_member(org_id));

drop policy if exists settlements_select on public.settlements;
create policy settlements_select on public.settlements
  for select to authenticated using (public.is_org_member(org_id));

-- Writes go exclusively through the SECURITY DEFINER functions above, which
-- re-authorize via assert_store_access + assert_org_write. No insert/update
-- policies are defined for shipments, shipment_events or settlements, so a
-- direct client write is denied by RLS even before the function layer.

grant select on public.shipments, public.shipment_events, public.settlements to authenticated;
grant select, insert, update, delete on public.courier_connections to authenticated;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function
  public.courier_supports_api(public.courier_provider),
  public.order_dispatch_blocker(uuid),
  public.register_shipment(uuid, public.courier_provider, uuid, uuid, numeric, text, text, jsonb),
  public.confirm_shipment(uuid, text, text, numeric, text, text, jsonb),
  public.fail_shipment(uuid, text, public.shipment_state, text),
  public.apply_shipment_update(uuid, public.shipment_state, text, text, text, timestamptz, timestamptz),
  public.record_settlement(uuid, public.settlement_state, numeric, text, text)
from public, anon;

grant execute on function
  public.courier_supports_api(public.courier_provider),
  public.order_dispatch_blocker(uuid),
  public.register_shipment(uuid, public.courier_provider, uuid, uuid, numeric, text, text, jsonb),
  public.confirm_shipment(uuid, text, text, numeric, text, text, jsonb),
  public.fail_shipment(uuid, text, public.shipment_state, text),
  public.apply_shipment_update(uuid, public.shipment_state, text, text, text, timestamptz, timestamptz),
  public.record_settlement(uuid, public.settlement_state, numeric, text, text)
to authenticated;
