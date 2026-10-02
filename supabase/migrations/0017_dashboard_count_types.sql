-- ===========================================================================
-- SellFlow :: 0017 -- dashboard pipeline counts as JSON numbers
--
-- The defect this fixes
-- --------------------
-- get_dashboard built its flat per-status counters with
--
--     'pending_count', (v_pipeline ->> 'pending')
--
-- `->>` extracts the value as TEXT. jsonb_build_object then stores that text as
-- a JSON *string*, so the client received {"pending_count": "2"} rather than
-- {"pending_count": 2}.
--
-- Every consumer that types its figures (`num()` in dashboard/queries.ts)
-- treats a non-number as a missing value and returns 0. The Pipeline section of
-- the dashboard therefore rendered eleven zeros while the work queue -- built
-- from real `count(*)` values in the same payload -- showed the true numbers.
-- A seller was told every parcel had vanished.
--
-- The numbers were never wrong. Their JSON *type* was.
--
-- The fix casts back to integer, and wraps in to_jsonb so jsonb_build_object
-- stores a JSON number. `pipeline` itself was already correct and is left
-- exactly as it was; the flat counters now match it by construction.
--
-- No figure changes. This is a transport-type correction only.
-- ===========================================================================

create or replace function public.get_dashboard(p_store_id uuid, p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org        uuid := public.assert_store_access(p_store_id);
  v_today_start timestamptz := p_today::timestamp;
  v_tomorrow    timestamptz := (p_today + 1)::timestamp;
  v_month_start timestamptz := date_trunc('month', p_today::timestamp);
  v_week_start  timestamptz := date_trunc('week', p_today::timestamp);
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
          select (placed_at at time zone 'UTC')::date as day, sum(total) as rev
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

comment on function public.get_dashboard(uuid, date) is
  'Operational dashboard. Pipeline counters are JSON numbers, not JSON strings; see migration 0017.';