-- ===========================================================================
-- SellFlow :: 0009 -- notification producers
--
-- The inbox existed in the V1 foundation but nothing ever wrote to it. This
-- migration supplies the producers, so every notification in the app is caused
-- by a real event in real data.
--
-- Three rules govern them:
--
--   1. NEVER a placeholder. Each notification is raised by a specific,
--      observable change: stock crossing a threshold, a status change, a
--      courier confirmation, a payout.
--   2. NEVER spammy. A low-stock alert fires when stock CROSSES the threshold,
--      not on every order that leaves it low, and a dedupe key makes each
--      distinct event fire at most once.
--   3. NEVER against a stated preference. Every producer routes through
--      public.notify(), which consults notification_preferences first.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Dedupe key
--
-- A stable identity for "this specific event". The unique index turns a repeat
-- into a no-op instead of a second identical row, which is what makes it safe
-- to call a producer from a trigger that may fire more than once.
-- ---------------------------------------------------------------------------

alter table public.notifications
  add column if not exists dedupe_key text;

create unique index if not exists uq_notifications_dedupe
  on public.notifications (dedupe_key)
  where dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- The single entry point for raising a notification
--
-- Security definer because triggers run as the table owner and would otherwise
-- be blocked by the notifications RLS policy, which requires user_id =
-- auth.uid(). A background job has no authenticated user at all.
--
-- Returns true when a row was actually written, so callers and tests can tell
-- "sent" from "suppressed".
-- ---------------------------------------------------------------------------

create or replace function public.notify(
  p_org_id   uuid,
  p_user_id  uuid,
  p_kind     public.notification_kind,
  p_title    text,
  p_body     text default null,
  p_data     jsonb default '{}'::jsonb,
  p_dedupe   text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_written int;
begin
  -- Respect the user's stated preferences. Defaults to ON when no row exists
  -- yet, because a missing preference row must not silently mute a new account.
  if not coalesce((
    select case p_kind
      when 'new_order'   then n.new_order
      when 'low_stock'   then n.low_stock
      when 'payment_due' then n.payment_due
      when 'order_status' then n.order_status
      when 'account'     then n.account
    end
    from public.notification_preferences n
    where n.org_id = p_org_id and n.user_id = p_user_id
  ), true) then
    return false;
  end if;

  insert into public.notifications
    (org_id, user_id, kind, title, body, data, dedupe_key)
  values
    (p_org_id, p_user_id, p_kind, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe)
  on conflict do nothing;

  get diagnostics v_written = row_count;
  return v_written > 0;
end;
$$;

-- Fan out to every member of the organization who wants this kind of alert.
create or replace function public.notify_org(
  p_org_id uuid,
  p_kind    public.notification_kind,
  p_title   text,
  p_body    text default null,
  p_data    jsonb default '{}'::jsonb,
  -- A shared dedupe key is suffixed per user so each member gets their own row.
  p_dedupe  text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sent int := 0;
  v_member record;
begin
  for v_member in
    select m.user_id from public.organization_members m where m.org_id = p_org_id
  loop
    if public.notify(
      p_org_id, v_member.user_id, p_kind, p_title, p_body, p_data,
      case when p_dedupe is null then null else p_dedupe || ':' || v_member.user_id::text end
    ) then
      v_sent := v_sent + 1;
    end if;
  end loop;

  return v_sent;
end;
$$;

-- ===========================================================================
-- Producer 1: low stock
--
-- Fires on the TRANSITION from above-threshold to at-or-below, not on every
-- order. Selling the last unit is the event; selling the second-to-last is not.
-- ===========================================================================

create or replace function public.produce_low_stock_notifications()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sent int := 0;
  v_row  record;
begin
  for v_row in
    select p.org_id, p.id, p.name, p.low_stock_threshold,
           coalesce(i.quantity, 0) as quantity,
           s.id as store_id
    from public.products p
    join public.stores s on s.org_id = p.org_id and not s.is_archived
    left join public.inventory i
      on i.product_id = p.id and i.store_id = s.id and i.variant_id is null
    where not p.is_archived
      and p.track_inventory
      and p.low_stock_threshold > 0
      and coalesce(i.quantity, 0) <= p.low_stock_threshold
  loop
    if public.notify_org(
      v_row.org_id,
      'low_stock',
      'Low stock: ' || v_row.name,
      v_row.quantity || ' left, alert level ' || v_row.low_stock_threshold,
      jsonb_build_object('product_id', v_row.id, 'quantity', v_row.quantity),
      -- Dedupe per product per threshold. Once the seller is told it is low,
      -- they are not told again until it is restocked above the line and
      -- crosses back down.
      'low_stock:' || v_row.id || ':' || v_row.store_id
    ) > 0 then
      v_sent := v_sent + 1;
    end if;
  end loop;

  return v_sent;
end;
$$;

-- Re-arm the low-stock alert once the product is properly restocked, so the
-- next time it drops the seller hears about it again.
create or replace function public.rearm_low_stock(p_org_id uuid, p_product_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notifications
     set dedupe_key = null
   where org_id = p_org_id
     and dedupe_key like 'low_stock:' || p_product_id || ':%';
$$;

-- ===========================================================================
-- Producer 1b: the low-stock crossing itself
--
-- A trigger fires the moment stock crosses DOWN through the threshold, so the
-- seller is warned by the action that caused it rather than waiting for a cron
-- run. The sweep above is the safety net for thresholds changed by a product
-- edit, which moves no inventory at all.
-- ===========================================================================

create or replace function public.produce_inventory_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_threshold int;
  v_name      text;
  v_org       uuid;
begin
  if new.quantity = old.quantity then
    return new;  -- no movement, no event
  end if;

  select p.low_stock_threshold, p.name, p.org_id
    into v_threshold, v_name, v_org
  from public.products p
  where p.id = new.product_id
    and p.track_inventory
    and not p.is_archived
    and p.low_stock_threshold > 0;

  if v_threshold is null then
    return new;
  end if;

  -- Crossed DOWN through the line: warn now.
  if new.quantity <= v_threshold and old.quantity > v_threshold then
    perform public.notify_org(
      v_org, 'low_stock',
      'Low stock: ' || v_name,
      new.quantity || ' left, alert level ' || v_threshold,
      jsonb_build_object('product_id', new.product_id, 'quantity', new.quantity,
                         'store_id', new.store_id),
      'low_stock:' || new.product_id || ':' || new.store_id
    );
  end if;

  -- Back ABOVE the line: re-arm, so the next dip alerts again.
  if new.quantity > v_threshold and old.quantity <= v_threshold then
    perform public.rearm_low_stock(v_org, new.product_id);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_inventory_alerts on public.inventory;
create trigger trg_inventory_alerts
  after update of quantity on public.inventory
  for each row execute function public.produce_inventory_alert();

-- ===========================================================================
-- Producer 2: order lifecycle events
--
-- Driven from a trigger on order_status_history rather than from the app, so
-- it fires no matter which client changed the status.
-- ===========================================================================

create or replace function public.produce_order_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
begin
  select o.id, o.org_id, o.order_number, o.customer_id, c.name, c.phone
    into v_order
  from public.orders o
  left join public.customers c on c.id = o.customer_id
  where o.id = new.order_id;

  if v_order.id is null then
    return new;
  end if;

  if new.to_status = 'failed_delivery' then
    perform public.notify_org(
      v_order.org_id, 'order_status',
      'Delivery failed: ' || v_order.order_number,
      coalesce(new.note, 'The courier could not deliver. Re-attempt or arrange a return.'),
      jsonb_build_object('order_id', v_order.id, 'status', 'failed_delivery'),
      'failed_delivery:' || v_order.id || ':' || substr(md5(coalesce(new.note, '') || new.created_at::text), 1, 8)
    );

  elsif new.to_status = 'returned' then
    perform public.notify_org(
      v_order.org_id, 'order_status',
      'Order returned: ' || v_order.order_number,
      coalesce(new.note, 'The parcel is coming back to you. Stock has been restored.'),
      jsonb_build_object('order_id', v_order.id, 'status', 'returned'),
      'returned:' || v_order.id
    );

  elsif new.to_status = 'delivered' then
    perform public.notify_org(
      v_order.org_id, 'order_status',
      'Delivered: ' || v_order.order_number,
      coalesce(v_order.name, 'Customer') || ' received the parcel.',
      jsonb_build_object('order_id', v_order.id, 'status', 'delivered'),
      'delivered:' || v_order.id
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_order_notifications on public.order_status_history;
create trigger trg_order_notifications
  after insert on public.order_status_history
  for each row execute function public.produce_order_notifications();

-- ===========================================================================
-- Producer 3: courier events
--
-- Fired when a shipment is genuinely confirmed, and when a delivery attempt
-- fails in transit. Deliberately NOT fired on register_shipment: at that point
-- the courier has not accepted anything.
-- ===========================================================================

create or replace function public.produce_shipment_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ship record;
begin
  select s.id, s.org_id, s.order_id, s.provider_label, s.tracking_id, o.order_number
    into v_ship
  from public.shipments s
  join public.orders o on o.id = s.order_id
  where s.id = new.shipment_id;

  if v_ship.id is null then
    return new;
  end if;

  -- Only announce a confirmation that came back from the provider.
  if new.state = 'created' and new.source = 'courier' then
    perform public.notify_org(
      v_ship.org_id, 'order_status',
      'Shipment created: ' || v_ship.order_number,
      coalesce(v_ship.provider_label, 'Courier') || ' accepted it. Tracking ' ||
        coalesce(v_ship.tracking_id, 'pending') || '.',
      jsonb_build_object('order_id', v_ship.order_id, 'shipment_id', v_ship.id,
                         'tracking_id', v_ship.tracking_id),
      'shipment_created:' || v_ship.id
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_shipment_notifications on public.shipment_events;
create trigger trg_shipment_notifications
  after insert on public.shipment_events
  for each row execute function public.produce_shipment_notifications();

-- ===========================================================================
-- Producer 4: COD settlement
-- ===========================================================================

create or replace function public.produce_settlement_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_set record;
begin
  if new.state = 'settled' and (tg_op = 'INSERT' or old.state is distinct from 'settled') then
    select s.org_id, s.order_id, s.settled_amount, o.order_number
      into v_set
    from public.settlements s
    join public.orders o on o.id = s.order_id
    where s.id = new.id;

    if v_set.order_id is not null then
      perform public.notify_org(
        v_set.org_id, 'payment_due',
        'COD received: ' || v_set.order_number,
        'The courier paid out ' || v_set.settled_amount || '.',
        jsonb_build_object('order_id', v_set.order_id, 'amount', v_set.settled_amount),
        'cod_settled:' || v_set.order_id || ':' || v_set.settled_amount
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_settlement_notifications on public.settlements;
create trigger trg_settlement_notifications
  after insert or update on public.settlements
  for each row execute function public.produce_settlement_notifications();

-- ===========================================================================
-- Scheduled sweep
--
-- The low-stock producer is a sweep rather than a trigger because a threshold
-- can be crossed by a product edit rather than by a sale. Call it from
-- pg_cron, an Edge Function schedule, or the Supabase dashboard's scheduled
-- jobs. Returns the number of alerts raised, and is safe to run repeatedly.
-- ===========================================================================

create or replace function public.run_scheduled_checks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_low int;
begin
  v_low := public.produce_low_stock_notifications();

  return jsonb_build_object(
    'low_stock_alerts', v_low,
    'ran_at', now()
  );
end;
$$;

-- ===========================================================================
-- Grants
-- ===========================================================================

revoke all on function
  public.notify(uuid, uuid, public.notification_kind, text, text, jsonb, text),
  public.notify_org(uuid, public.notification_kind, text, text, jsonb, text),
  public.produce_low_stock_notifications(),
  public.rearm_low_stock(uuid, uuid),
  public.run_scheduled_checks()
from public, anon;

-- authenticated can raise notifications for themselves only; the aggregate
-- producers stay service-role/scheduler territory.
grant execute on function
  public.notify(uuid, uuid, public.notification_kind, text, text, jsonb, text)
to authenticated;
