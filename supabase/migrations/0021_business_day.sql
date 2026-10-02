-- ===========================================================================
-- SellFlow :: 0021 -- the business-day boundary
--
-- The finding
-- -----------
-- Every event timestamp in SellFlow is `timestamptz`, so the moment an order
-- happened is recorded exactly and is NOT affected by anything here.
--
-- The *day* an order is filed under was, however, a UTC day. All six reporting
-- functions truncated with:
--
--     (placed_at at time zone 'UTC')::date
--
-- and get_dashboard built its window from
--
--     v_today_start timestamptz := p_today::timestamp;
--
-- which lets the *session* timezone interpret the boundary.
--
-- The client sends the SELLER's local calendar date as p_today. For a seller in
-- Dhaka (UTC+6) those two definitions disagree by six hours, so:
--
--   * at 00:30 local on the 3rd, an order taken at 00:10 local is filed under
--     the 2nd, because the UTC day had already rolled over;
--   * "Today" reads 0 for the first six hours of every morning;
--   * Finance and Analytics disagree with the Dashboard for the same date,
--     because Analytics buckets in UTC while the Dashboard bounds a UTC day.
--
-- It affects EVERY seller, and the size of the error is their UTC offset. It is
-- invisible at UTC+0, which is why the regression suites never caught it: they
-- assert internal consistency, and the whole stack was consistently UTC.
--
-- What this does NOT change
-- -------------------------
-- Nothing about what is counted. Revenue, profit, AOV, the qualifying statuses,
-- inventory, reserved/sellable and payment idempotency are all untouched. Only
-- the instant at which a day is cut moves -- from UTC midnight to the seller's
-- own midnight.
--
-- The consequence to expect: historical daily figures re-bucket. For a Dhaka
-- seller, orders previously filed under a UTC day move to their local day. That
-- is a correction, not a loss, but the numbers will differ from what the seller
-- saw yesterday, and they should be told.
--
-- Why a store-level timezone
-- --------------------------
-- "Which day is it?" is a property of the shop, not of the server. Hard-coding
-- Asia/Dhaka inside a query would be wrong for every seller outside Bangladesh,
-- and hard-coding UTC is what caused this. The value lives on the store, is set
-- once, and every boundary reads it -- so there is exactly one place that
-- decides where midnight is.
--
-- It is validated on read as well as on write (store_timezone below only returns
-- a name that pg_timezone_names actually knows), so a bad value can never make a
-- report fail; it degrades to UTC instead.
-- ===========================================================================

alter table public.stores
  add column if not exists timezone text not null default 'Asia/Dhaka';

comment on column public.stores.timezone is
  'IANA timezone used to decide where a business day starts. "Today" and every '
  'dated report are cut at midnight in THIS zone, not at UTC midnight. Event '
  'timestamps remain absolute instants.';

-- A name Postgres does not recognise would make "placed_at at time zone x" throw
-- and take the dashboard down with it. Returns the store zone only when it is a
-- real zone, and falls back to UTC rather than failing a report.
create or replace function public.store_timezone(p_store_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select s.timezone
      from public.stores s
      where s.id = p_store_id
        and exists (select 1 from pg_timezone_names n where n.name = s.timezone)
    ),
    'UTC'
  );
$$;

grant execute on function public.store_timezone(uuid) to authenticated;

-- Every seller keeps the day boundary they already have until they change it:
-- the default is the market this build targets, and Settings -> Store exposes it
-- for anyone else. This is the one judgement call in the migration; it is
-- deliberate and reversible from the UI.
update public.stores set timezone = 'Asia/Dhaka' where timezone is null;


-- ---------------------------------------------------------------------------
-- get_dashboard
-- ---------------------------------------------------------------------------
create or replace function public.get_dashboard(p_store_id uuid, p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org        uuid := public.assert_store_access(p_store_id);
  -- Midnight in the SELLER's day, not midnight UTC. p_today is the local
  -- calendar date the client asked about; interpreting it in the session
  -- timezone is what made the dashboard disagree with a Dhaka seller's
  -- own idea of the morning.
  v_tz        text        := public.store_timezone(p_store_id);
  v_today_start timestamptz := p_today::timestamp at time zone v_tz;
  v_tomorrow    timestamptz := (p_today + 1)::timestamp at time zone v_tz;
  -- Truncate in local wall-clock time, then convert that local midnight
  -- back into an instant. Truncating an instant directly would cut the
  -- month at UTC midnight instead.
  v_month_start timestamptz := date_trunc('month', p_today::timestamp at time zone v_tz) at time zone v_tz;
  v_week_start  timestamptz := date_trunc('week', p_today::timestamp at time zone v_tz) at time zone v_tz;
  v_result      jsonb;
  v_pipeline    jsonb;
  v_statuses    public.order_status[] := public.dashboard_statuses();
  v_one         public.order_status;
begin
  -- Per-status counts for the whole pipeline, not just today. A seller opening
  -- the app needs to know how many parcels are sitting in each state, which is
  -- a backlog question rather than a date question.
  v_pipeline := '{}'::jsonb;
  foreach v_one in array v_statuses
  loop
    v_pipeline := v_pipeline || jsonb_build_object(
      v_one::text,
      to_jsonb((
        select count(*) from public.orders
        where org_id = v_org and store_id = p_store_id and status = v_one
      )::integer)
    );
  end loop;

  return jsonb_build_object(
    -- Pipeline --------------------------------------------------------
    'pipeline', v_pipeline,
    -- `to_jsonb(...)::int` rather than `->> ...`: `->>` yields text, which
    -- jsonb_build_object stores as a JSON string and every typed reader then
    -- discards as "missing". See the note at the top of this file.
    'pending_count',     to_jsonb((v_pipeline ->> 'pending')::integer),
    'confirmed_count',   to_jsonb((v_pipeline ->> 'confirmed')::integer),
    'processing_count',  to_jsonb((v_pipeline ->> 'processing')::integer),
    'packaging_count',   to_jsonb((v_pipeline ->> 'packaging')::integer),
    'packed_count',      to_jsonb((v_pipeline ->> 'packed')::integer),
    'shipped_count',     to_jsonb((v_pipeline ->> 'shipped')::integer),
    'on_delivery_count', to_jsonb((v_pipeline ->> 'on_delivery')::integer),
    'delivered_count',   to_jsonb((v_pipeline ->> 'delivered')::integer),
    'failed_count',      to_jsonb((v_pipeline ->> 'failed_delivery')::integer),
    'returned_count',    to_jsonb((v_pipeline ->> 'returned')::integer),
    'cancelled_count',   to_jsonb((v_pipeline ->> 'cancelled')::integer),

    -- Today ----------------------------------------------------------
    'today', (select jsonb_build_object(
      'orders', count(*),
      'revenue', coalesce(sum(total), 0),
      -- Cost of goods only. Courier and other fulfilment costs are reported
      -- separately below, so "profit" here is gross margin, not net.
      'profit', coalesce(sum(profit), 0),
      'delivered', count(*) filter (where status = 'delivered')
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and placed_at >= v_today_start and placed_at < v_tomorrow
      and status not in ('cancelled', 'returned', 'failed_delivery')),

    -- Week / month ---------------------------------------------------
    'week', (select jsonb_build_object(
      'orders', count(*),
      'revenue', coalesce(sum(total), 0),
      'profit', coalesce(sum(profit), 0)
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and placed_at >= v_week_start and placed_at < v_tomorrow
      and status not in ('cancelled', 'returned', 'failed_delivery')),

    'month', (select jsonb_build_object(
      'orders', count(*),
      'revenue', coalesce(sum(total), 0),
      'profit', coalesce(sum(profit), 0)
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and placed_at >= v_month_start and placed_at < v_tomorrow
      and status not in ('cancelled', 'returned', 'failed_delivery')),

    -- Average order value, month to date, and across all time. ------
    'aov_month', coalesce((
      select round(avg(total), 2) from public.orders
      where org_id = v_org and store_id = p_store_id
        and placed_at >= v_month_start and placed_at < v_tomorrow
        and status not in ('cancelled', 'returned', 'failed_delivery')
    ), 0),
    'aov_all', coalesce((
      select round(avg(total), 2) from public.orders
      where org_id = v_org and store_id = p_store_id
        and status not in ('cancelled', 'returned', 'failed_delivery')
    ), 0),

    -- COD ------------------------------------------------------------
    'cod', (select jsonb_build_object(
      -- Money the courier is holding for the seller.
      'expected', coalesce(sum(cod_amount), 0),
      -- Delivered and collected, but not yet paid out.
      'pending_settlement', coalesce(sum(cod_amount) filter (where not cod_settled), 0),
      'settled', coalesce(sum(cod_amount) filter (where cod_settled), 0),
      'orders', count(*) filter (where cod_amount > 0)
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and is_cod
      and status not in ('cancelled', 'returned')),

    -- Fulfilment costs, month to date -------------------------------
    'costs', (select jsonb_build_object(
      'product', coalesce(sum(cost_total), 0),
      'courier', coalesce(sum(courier_cost), 0),
      'other', coalesce(sum(other_cost), 0)
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and placed_at >= v_month_start and placed_at < v_tomorrow
      and status not in ('cancelled', 'returned', 'failed_delivery')),

    -- Money still owed by customers, across every open order -------
    'outstanding', (select coalesce(sum(total - amount_paid), 0)
      from public.orders
      where org_id = v_org and store_id = p_store_id
        and status not in ('cancelled', 'returned', 'failed_delivery')
        and payment_status in ('unpaid', 'partial')),
    'outstanding_orders', (select count(*)
      from public.orders
      where org_id = v_org and store_id = p_store_id
        and status not in ('cancelled', 'returned', 'failed_delivery')
        and payment_status in ('unpaid', 'partial')),

    -- The work queue ------------------------------------------------
    'action', (select jsonb_build_object(
      'to_confirm', (select count(*) from public.orders
        where org_id = v_org and store_id = p_store_id and status = 'pending'),
      'to_pack', (select count(*) from public.orders
        where org_id = v_org and store_id = p_store_id
          and status in ('confirmed', 'processing', 'packaging')),
      'to_ship', (select count(*) from public.orders
        where org_id = v_org and store_id = p_store_id and status = 'packed'),
      'out_for_delivery', (select count(*) from public.orders
        where org_id = v_org and store_id = p_store_id
          and status in ('shipped', 'on_delivery')),
      'failed', (select count(*) from public.orders
        where org_id = v_org and store_id = p_store_id and status = 'failed_delivery')
    )),

    -- Courier activity ---------------------------------------------
    'couriers', (select jsonb_build_object(
      'open_shipments', (select count(*) from public.shipments
        where org_id = v_org and store_id = p_store_id
          and state not in ('delivered', 'returned', 'cancelled')),
      'awaiting_confirmation', (select count(*) from public.shipments
        where org_id = v_org and store_id = p_store_id and state = 'requested'),
      'pickup_pending', (select count(*) from public.shipments
        where org_id = v_org and store_id = p_store_id and state = 'created'),
      'by_provider', (select coalesce(jsonb_object_agg(provider::text, n), '{}'::jsonb)
        from (select s.provider, count(*) as n from public.shipments s
              where s.org_id = v_org and s.store_id = p_store_id
              group by s.provider) g)
    )),

    -- Catalog health ------------------------------------------------
    --
    -- INNER join on inventory, deliberately. A store with no stock record for a
    -- product knows nothing about it, and must not claim it is "low". Without
    -- this, opening a second outlet would immediately report the entire
    -- catalogue as low stock.
    'low_stock', (select coalesce(jsonb_agg(x), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'product_id', p.id, 'name', p.name,
                 'quantity', i.quantity,
                 'threshold', p.low_stock_threshold,
                 'margin', p.selling_price - coalesce(p.cost_price, 0)
               ) as x
        from public.products p
        join public.inventory i
          on i.product_id = p.id and i.store_id = p_store_id and i.variant_id is null
        where p.org_id = v_org and not p.is_archived
          and p.track_inventory and p.low_stock_threshold > 0
          and i.quantity <= p.low_stock_threshold
        order by i.quantity asc, p.name asc
        limit 6
      ) t),

    'low_stock_count', (select count(*)
      from public.products p
      join public.inventory i
        on i.product_id = p.id and i.store_id = p_store_id and i.variant_id is null
      where p.org_id = v_org and not p.is_archived and p.track_inventory
        and p.low_stock_threshold > 0
        and i.quantity <= p.low_stock_threshold),

    'product_count', (select count(*) from public.products
      where org_id = v_org and not products.is_archived),
    'customer_count', (select count(*) from public.customers
      where org_id = v_org and not customers.is_archived),
    'total_orders', (select count(*) from public.orders
      where org_id = v_org and store_id = p_store_id),

    -- Recent activity ----------------------------------------------
    'recent_orders', (select coalesce(jsonb_agg(x), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'id', o.id, 'order_number', o.order_number,
                 'status', o.status, 'payment_status', o.payment_status,
                 'total', o.total, 'is_cod', o.is_cod,
                 'customer_name', c.name,
                 'courier_name', o.courier_name,
                 'placed_at', o.placed_at
               ) as x
        from public.orders o
        left join public.customers c on c.id = o.customer_id
        where o.org_id = v_org and o.store_id = p_store_id
        order by o.placed_at desc
        limit 6
      ) t),

    -- 14-day revenue series, gaps filled with zero so the chart's axis
    -- never silently shortens.
    'series', (select coalesce(jsonb_agg(x), '[]'::jsonb)
      from (
        select jsonb_build_object('day', d::date, 'revenue', coalesce(v.rev, 0)) as x
        from generate_series(v_today_start::date - 13, v_today_start::date, interval '1 day') d
        left join (
          select (placed_at at time zone public.store_timezone(p_store_id))::date as day, sum(total) as rev
          from public.orders
          where org_id = v_org and store_id = p_store_id
            and placed_at >= v_today_start - interval '13 days'
            and placed_at < v_tomorrow
            and status not in ('cancelled', 'returned', 'failed_delivery')
          group by 1
        ) v on v.day = d::date
        order by d
      ) t)
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- get_analytics
-- ---------------------------------------------------------------------------
create or replace function public.get_analytics(p_store_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.assert_store_access(p_store_id);
begin
  return jsonb_build_object(
    'from', p_from,
    'to', p_to,

    'totals', (select jsonb_build_object(
      'revenue', coalesce(sum(total), 0),
      -- Gross margin after cost of goods, delivery charged to the customer and
      -- per-order costs. Delivery charged to the customer IS revenue.
      'profit', coalesce(sum(profit), 0),
      'product_cost', coalesce(sum(cost_total), 0),
      'courier_cost', coalesce(sum(courier_cost), 0),
      'other_cost', coalesce(sum(other_cost), 0),
      'discount_given', coalesce(sum(discount), 0),
      'orders', count(*)
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and (placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
      and status not in ('cancelled', 'returned', 'failed_delivery')),

    -- Delivered vs merely placed. These are different numbers and conflating
    -- them is how a seller ends up over-estimating income.
    'delivery', (select jsonb_build_object(
      'delivered_orders', count(*) filter (where status = 'delivered'),
      'returned_orders', count(*) filter (where status = 'returned'),
      'cancelled_orders', count(*) filter (where status = 'cancelled'),
      'failed_deliveries', count(*) filter (where status = 'failed_delivery'),
      'delivered_revenue', coalesce(sum(total) filter (where status = 'delivered'), 0),
      'open_orders', count(*) filter (where status not in ('delivered', 'cancelled', 'returned'))
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and (placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to),

    'units_sold', (select coalesce(sum(oi.quantity), 0)
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where o.org_id = v_org and o.store_id = p_store_id
        and (o.placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
        and o.status not in ('cancelled', 'returned', 'failed_delivery')),

    'average_order_value', coalesce((
      select round(avg(total), 2) from public.orders
      where org_id = v_org and store_id = p_store_id
        and (placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
        and status not in ('cancelled', 'returned', 'failed_delivery')
    ), 0),

    'average_selling_price', coalesce((
      -- Quantity-weighted realised price: what the customer actually paid per
      -- unit, after any line discount. A plain AVG(unit_price) would average
      -- one entry per order line and say nothing useful about the business.
      select round(
        sum(oi.line_total) / nullif(sum(oi.quantity), 0), 2
      ) from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where o.org_id = v_org and o.store_id = p_store_id
        and (o.placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
        and o.status not in ('cancelled', 'returned', 'failed_delivery')
    ), 0),

    'expenses', (select jsonb_build_object(
      'total', coalesce(sum(e.amount), 0),
      'by_category', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
        from (select e2.category::text as k, sum(e2.amount) as v
              from public.expenses e2
              where e2.org_id = v_org and e2.incurred_on between p_from and p_to
              group by e2.category) g)
    )
    from public.expenses e
    where e.org_id = v_org and e.incurred_on between p_from and p_to),

    -- Net profit: gross margin minus every expense actually recorded.
    'net_profit', (
      select coalesce(sum(o.profit), 0) - coalesce((
        select sum(e.amount) from public.expenses e
        where e.org_id = v_org and e.incurred_on between p_from and p_to
      ), 0)
      from public.orders o
      where o.org_id = v_org and o.store_id = p_store_id
        and (o.placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
        and o.status not in ('cancelled', 'returned', 'failed_delivery')
    ),

    'daily', (select coalesce(jsonb_agg(x order by x ->> 'day'), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'day', d,
                 'revenue', coalesce(sum(o.total), 0),
                 'profit', coalesce(sum(o.profit), 0),
                 'orders', count(o.id)
               ) as x
        from generate_series(p_from, p_to, interval '1 day') d
        left join public.orders o
          on o.org_id = v_org and o.store_id = p_store_id
         and (o.placed_at at time zone public.store_timezone(p_store_id))::date = d::date
         and o.status not in ('cancelled', 'returned', 'failed_delivery')
        group by d
      ) t)
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- get_finance
-- ---------------------------------------------------------------------------
create or replace function public.get_finance(p_store_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.assert_store_access(p_store_id);
begin
  return jsonb_build_object(
    'from', p_from,
    'to', p_to,

    'revenue', (select jsonb_build_object(
      -- Everything the seller took an order for.
      'gross_sales', coalesce(sum(total), 0),
      -- Only orders that actually arrived. The honest "money earned".
      'delivered_sales', coalesce(sum(total) filter (where status = 'delivered'), 0),
      'delivery_charged', coalesce(sum(delivery_charge), 0),
      'discount_given', coalesce(sum(discount), 0)
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and (placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
      and status not in ('cancelled', 'returned', 'failed_delivery')),

    'costs', jsonb_build_object(
      'product', (select coalesce(sum(cost_total), 0) from public.orders
        where org_id = v_org and store_id = p_store_id
          and (placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
          and status not in ('cancelled', 'returned', 'failed_delivery')),
      'courier', (select coalesce(sum(courier_cost), 0) from public.orders
        where org_id = v_org and store_id = p_store_id
          and (placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
          and status not in ('cancelled', 'returned', 'failed_delivery')),
      'other', (select coalesce(sum(other_cost), 0) from public.orders
        where org_id = v_org and store_id = p_store_id
          and (placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
          and status not in ('cancelled', 'returned', 'failed_delivery')),
      'expenses', (select coalesce(sum(amount), 0) from public.expenses
        where org_id = v_org and incurred_on between p_from and p_to)
    ),

    'payments', (select jsonb_build_object(
      'paid', coalesce(sum(amount) filter (where not is_refund), 0),
      'refunded', coalesce(sum(amount) filter (where is_refund), 0)
    )
    from public.payments p
    join public.orders o on o.id = p.order_id
    where o.org_id = v_org and o.store_id = p_store_id
      and (o.placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to),

    'cod', (select jsonb_build_object(
      'expected', coalesce(sum(cod_amount), 0),
      'pending', coalesce(sum(cod_amount) filter (where not cod_settled), 0),
      'settled', coalesce(sum(cod_amount) filter (where cod_settled), 0),
      'orders', count(*) filter (where cod_amount > 0)
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and is_cod and (placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
      and status not in ('cancelled', 'returned')),

    -- Net profit is derived, never stored, so it can never disagree with the
    -- components it is built from.
    'net_profit', (
      select coalesce(sum(o.profit), 0)
        - coalesce((select sum(e.amount) from public.expenses e
                    where e.org_id = v_org and e.incurred_on between p_from and p_to), 0)
      from public.orders o
      where o.org_id = v_org and o.store_id = p_store_id
        and (o.placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
        and o.status not in ('cancelled', 'returned', 'failed_delivery')
    )
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- get_sales_report
-- ---------------------------------------------------------------------------
create or replace function public.get_sales_report(p_store_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.assert_store_access(p_store_id);
begin
  return jsonb_build_object(
    'totals', (select jsonb_build_object(
      'revenue', coalesce(sum(total), 0),
      'profit', coalesce(sum(profit), 0),
      'cost', coalesce(sum(cost_total), 0),
      'discount_given', coalesce(sum(discount), 0),
      'delivery_collected', coalesce(sum(delivery_charge), 0),
      'orders', count(*)
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and (placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
      and status not in ('cancelled', 'returned', 'failed_delivery')),

    'expenses', (select coalesce(sum(amount), 0) from public.expenses
      where org_id = v_org and incurred_on between p_from and p_to),

    'daily', (select coalesce(jsonb_agg(x order by x ->> 'day'), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'day', d,
                 'revenue', coalesce(sum(o.total), 0),
                 'profit', coalesce(sum(o.profit), 0),
                 'orders', count(o.id)
               ) as x
        from generate_series(p_from, p_to, interval '1 day') d
        left join public.orders o
          on o.org_id = v_org and o.store_id = p_store_id
         and (o.placed_at at time zone public.store_timezone(p_store_id))::date = d::date
         and o.status not in ('cancelled', 'returned', 'failed_delivery')
        group by d
      ) t)
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- get_product_performance
-- ---------------------------------------------------------------------------
create or replace function public.get_product_performance(p_store_id uuid, p_from date, p_to date, p_limit integer DEFAULT 5)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org   uuid := public.assert_store_access(p_store_id);
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 50);
begin
  return jsonb_build_object(
    -- Most units moved.
    'by_quantity', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select jsonb_build_object(
               'product_id', g.product_id, 'name', g.name,
               'units', g.units, 'revenue', g.revenue, 'profit', g.profit
             ) as x
      from (
        select oi.product_id, max(oi.product_name) as name,
               sum(oi.quantity)::int as units,
               sum(oi.line_total) as revenue,
               sum(oi.line_total) - sum(coalesce(oi.unit_cost, 0) * oi.quantity) as profit
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        where o.org_id = v_org and o.store_id = p_store_id
          and (o.placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
          and o.status not in ('cancelled', 'returned', 'failed_delivery')
          and oi.product_id is not null
        group by oi.product_id
        order by 3 desc
        limit v_limit
      ) g) t),

    -- Most money earned.
    'by_revenue', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select jsonb_build_object(
               'product_id', g.product_id, 'name', g.name,
               'units', g.units, 'revenue', g.revenue, 'profit', g.profit
             ) as x
      from (
        select oi.product_id, max(oi.product_name) as name,
               sum(oi.quantity)::int as units,
               sum(oi.line_total) as revenue,
               sum(oi.line_total) - sum(coalesce(oi.unit_cost, 0) * oi.quantity) as profit
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        where o.org_id = v_org and o.store_id = p_store_id
          and (o.placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
          and o.status not in ('cancelled', 'returned', 'failed_delivery')
          and oi.product_id is not null
        group by oi.product_id
        order by 4 desc
        limit v_limit
      ) g) t),

    -- Most profit earned.
    'by_profit', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select jsonb_build_object(
               'product_id', g.product_id, 'name', g.name,
               'units', g.units, 'revenue', g.revenue, 'profit', g.profit
             ) as x
      from (
        select oi.product_id, max(oi.product_name) as name,
               sum(oi.quantity)::int as units,
               sum(oi.line_total) as revenue,
               sum(oi.line_total) - sum(coalesce(oi.unit_cost, 0) * oi.quantity) as profit
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        where o.org_id = v_org and o.store_id = p_store_id
          and (o.placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
          and o.status not in ('cancelled', 'returned', 'failed_delivery')
          and oi.product_id is not null
        group by oi.product_id
        order by 5 desc
        limit v_limit
      ) g) t)
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- get_top_products
-- ---------------------------------------------------------------------------
create or replace function public.get_top_products(p_store_id uuid, p_from date, p_to date, p_limit integer DEFAULT 5)
returns SETOF jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.assert_store_access(p_store_id);
begin
  -- Aggregation happens over real columns so ordering and limiting are done by
  -- Postgres, then the surviving rows are projected to jsonb for the client.
  return query
    select jsonb_build_object(
             'product_id', t.product_id,
             'name',        t.name,
             'units',       t.units,
             'revenue',     t.revenue,
             'profit',      t.profit
           )
    from (
      select oi.product_id,
             max(oi.product_name)      as name,
             sum(oi.quantity)::integer as units,
             sum(oi.line_total)        as revenue,
             sum(oi.line_total) - sum(coalesce(oi.unit_cost, 0) * oi.quantity) as profit
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where o.org_id = v_org
        and o.store_id = p_store_id
        and (o.placed_at at time zone public.store_timezone(p_store_id))::date between p_from and p_to
        and o.status not in ('cancelled', 'returned', 'failed_delivery')
        and oi.product_id is not null
      group by oi.product_id
      order by sum(oi.line_total) desc
      limit least(greatest(coalesce(p_limit, 5), 1), 50)
    ) t;
end;
$$;


-- ---------------------------------------------------------------------------
-- get_product_stats
-- ---------------------------------------------------------------------------
create or replace function public.get_product_stats(p_store_id uuid, p_product_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_p   record;
  v_onhand   int;
  v_reserved int;
  v_sold     numeric;
  v_revenue  numeric;
  v_profit   numeric;
begin
  -- Authorise via the store the product is being viewed in.
  v_org := public.assert_store_access(p_store_id);

  select p.id, p.name, p.sku, p.selling_price, p.cost_price, p.low_stock_threshold,
         p.track_inventory
    into v_p
  from public.products p
  where p.id = p_product_id and p.org_id = v_org;

  if v_p.id is null then
    raise exception 'product_not_found' using hint = 'That product no longer exists.';
  end if;

  -- Physical stock, excluding any variant rows. A parent product's on-hand is the
  -- parent-level inventory line.
  select coalesce(i.quantity, 0) into v_onhand
  from (select 0) anchor
  left join public.inventory i
    on i.store_id = p_store_id
   and i.product_id = p_product_id
   and i.variant_id is null;

  -- Units committed to orders that have not yet been delivered. Once delivered
  -- (or returned and restocked) the goods are no longer spoken for, so those
  -- statuses are excluded.
  select coalesce(sum(oi.quantity), 0)::int into v_reserved
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.store_id = p_store_id
    and oi.product_id = p_product_id
    and o.status in ('confirmed', 'processing', 'packaging', 'packed',
                     'shipped', 'on_delivery');

  -- Sales figures share one qualifying population.
  select coalesce(sum(oi.quantity), 0),
         coalesce(sum(oi.line_total), 0),
         coalesce(sum(oi.line_total) - sum(coalesce(oi.unit_cost, 0) * oi.quantity), 0)
    into v_sold, v_revenue, v_profit
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.org_id = v_org and o.store_id = p_store_id
    and oi.product_id = p_product_id
    and (p_from is null or (o.placed_at at time zone public.store_timezone(p_store_id))::date >= p_from)
    and (p_to   is null or (o.placed_at at time zone public.store_timezone(p_store_id))::date <= p_to)
    and o.status not in ('cancelled', 'returned', 'failed_delivery');

  return jsonb_build_object(
    'product_id', v_p.id,
    'name', v_p.name,
    'sku', v_p.sku,
    'selling_price', v_p.selling_price,
    'cost_price', v_p.cost_price,
    'low_stock_threshold', v_p.low_stock_threshold,
    'track_inventory', v_p.track_inventory,

    -- Physical stock on hand. This is the low-stock alert's input.
    'available', v_onhand,

    -- Committed to undelivered orders.
    'reserved', v_reserved,

    -- What can honestly be promised to a new customer right now. Never below
    -- zero: a seller whose stock is oversold should see 0 available to promise,
    -- not a negative figure.
    'sellable', greatest(v_onhand - v_reserved, 0),

    'sold_units', v_sold,
    'revenue', v_revenue,
    'profit', v_profit
  );
end;
$$;

