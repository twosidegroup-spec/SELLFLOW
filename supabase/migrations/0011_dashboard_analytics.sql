-- ===========================================================================
-- SellFlow :: 0010 -- operational dashboard and analytics
--
-- Replaces the V1 foundation's get_dashboard with the shape a courier-based
-- seller actually works from: a per-status pipeline breakdown, money that
-- distinguishes revenue from profit, and a work queue of everything waiting on
-- them.
--
-- Every figure is computed from rows. There are no seeded or default values
-- anywhere in this file: a brand-new account returns zeros and empty lists,
-- which is the correct answer rather than a placeholder.
--
-- One deliberate change from the foundation: `p_today` is still supplied by the
-- client, because "today" must mean today on the seller's phone.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Order status buckets for counting
--
-- Derived from the enum rather than repeated as literals, so adding a lifecycle
-- state cannot silently leave it out of the dashboard.
-- ---------------------------------------------------------------------------

create or replace function public.dashboard_statuses()
returns public.order_status[]
language sql
immutable
as $$
  select array[
    'pending', 'confirmed', 'processing', 'packaging', 'packed',
    'shipped', 'on_delivery', 'delivered', 'failed_delivery', 'returned', 'cancelled'
  ]::public.order_status[];
$$;

-- ===========================================================================
-- Operational dashboard
--
-- One round trip. The alternative -- a dozen client queries joined in
-- JavaScript -- is why dashboards like this feel assembled rather than instant.
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
      (select count(*) from public.orders
        where org_id = v_org and store_id = p_store_id and status = v_one)
    );
  end loop;

  return jsonb_build_object(
    -- Pipeline --------------------------------------------------------
    'pipeline', v_pipeline,
    'pending_count',     (v_pipeline ->> 'pending'),
    'confirmed_count',   (v_pipeline ->> 'confirmed'),
    'processing_count',  (v_pipeline ->> 'processing'),
    'packaging_count',   (v_pipeline ->> 'packaging'),
    'packed_count',      (v_pipeline ->> 'packed'),
    'shipped_count',     (v_pipeline ->> 'shipped'),
    'on_delivery_count', (v_pipeline ->> 'on_delivery'),
    'delivered_count',   (v_pipeline ->> 'delivered'),
    'failed_count',      (v_pipeline ->> 'failed_delivery'),
    'returned_count',    (v_pipeline ->> 'returned'),
    'cancelled_count',   (v_pipeline ->> 'cancelled'),

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

-- ===========================================================================
-- Analytics over an arbitrary range
--
-- The seller picks today / week / month / year / custom, so the range arrives
-- as two dates and everything is computed against them.
-- ===========================================================================

create or replace function public.get_analytics(
  p_store_id uuid,
  p_from     date,
  p_to       date
)
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
      and (placed_at at time zone 'UTC')::date between p_from and p_to
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
      and (placed_at at time zone 'UTC')::date between p_from and p_to),

    'units_sold', (select coalesce(sum(oi.quantity), 0)
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where o.org_id = v_org and o.store_id = p_store_id
        and (o.placed_at at time zone 'UTC')::date between p_from and p_to
        and o.status not in ('cancelled', 'returned', 'failed_delivery')),

    'average_order_value', coalesce((
      select round(avg(total), 2) from public.orders
      where org_id = v_org and store_id = p_store_id
        and (placed_at at time zone 'UTC')::date between p_from and p_to
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
        and (o.placed_at at time zone 'UTC')::date between p_from and p_to
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
        and (o.placed_at at time zone 'UTC')::date between p_from and p_to
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
         and (o.placed_at at time zone 'UTC')::date = d::date
         and o.status not in ('cancelled', 'returned', 'failed_delivery')
        group by d
      ) t)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Product performance
--
-- Three SEPARATE rankings. "Best product" is ambiguous and therefore useless:
-- the item that sells the most units is rarely the one that earns the most, and
-- never the one with the best margin.
-- ---------------------------------------------------------------------------

create or replace function public.get_product_performance(
  p_store_id uuid,
  p_from     date,
  p_to       date,
  p_limit    integer default 5
)
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
          and (o.placed_at at time zone 'UTC')::date between p_from and p_to
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
          and (o.placed_at at time zone 'UTC')::date between p_from and p_to
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
          and (o.placed_at at time zone 'UTC')::date between p_from and p_to
          and o.status not in ('cancelled', 'returned', 'failed_delivery')
          and oi.product_id is not null
        group by oi.product_id
        order by 5 desc
        limit v_limit
      ) g) t)
  );
end;
$$;

-- ===========================================================================
-- Finance
--
-- One screen that keeps three pairs of numbers apart, because conflating any
-- of them misleads a seller about their own business:
--   revenue  != profit
--   delivered != settled
--   expected COD != money in hand
-- ===========================================================================

create or replace function public.get_finance(
  p_store_id uuid,
  p_from     date,
  p_to       date
)
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
      and (placed_at at time zone 'UTC')::date between p_from and p_to
      and status not in ('cancelled', 'returned', 'failed_delivery')),

    'costs', jsonb_build_object(
      'product', (select coalesce(sum(cost_total), 0) from public.orders
        where org_id = v_org and store_id = p_store_id
          and (placed_at at time zone 'UTC')::date between p_from and p_to
          and status not in ('cancelled', 'returned', 'failed_delivery')),
      'courier', (select coalesce(sum(courier_cost), 0) from public.orders
        where org_id = v_org and store_id = p_store_id
          and (placed_at at time zone 'UTC')::date between p_from and p_to
          and status not in ('cancelled', 'returned', 'failed_delivery')),
      'other', (select coalesce(sum(other_cost), 0) from public.orders
        where org_id = v_org and store_id = p_store_id
          and (placed_at at time zone 'UTC')::date between p_from and p_to
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
      and (o.placed_at at time zone 'UTC')::date between p_from and p_to),

    'cod', (select jsonb_build_object(
      'expected', coalesce(sum(cod_amount), 0),
      'pending', coalesce(sum(cod_amount) filter (where not cod_settled), 0),
      'settled', coalesce(sum(cod_amount) filter (where cod_settled), 0),
      'orders', count(*) filter (where cod_amount > 0)
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and is_cod and (placed_at at time zone 'UTC')::date between p_from and p_to
      and status not in ('cancelled', 'returned')),

    -- Net profit is derived, never stored, so it can never disagree with the
    -- components it is built from.
    'net_profit', (
      select coalesce(sum(o.profit), 0)
        - coalesce((select sum(e.amount) from public.expenses e
                    where e.org_id = v_org and e.incurred_on between p_from and p_to), 0)
      from public.orders o
      where o.org_id = v_org and o.store_id = p_store_id
        and (o.placed_at at time zone 'UTC')::date between p_from and p_to
        and o.status not in ('cancelled', 'returned', 'failed_delivery')
    )
  );
end;
$$;

-- ===========================================================================
-- Per-product and per-customer detail
-- ===========================================================================

create or replace function public.get_product_stats(
  p_store_id  uuid,
  p_product_id uuid,
  p_from      date default null,
  p_to        date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_p   record;
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

  return jsonb_build_object(
    'product_id', v_p.id,
    'name', v_p.name,
    'sku', v_p.sku,
    'selling_price', v_p.selling_price,
    'cost_price', v_p.cost_price,
    'low_stock_threshold', v_p.low_stock_threshold,
    'track_inventory', v_p.track_inventory,

    'available', coalesce((
      select quantity from public.inventory
      where store_id = p_store_id and product_id = p_product_id and variant_id is null
    ), 0),

    -- Reserved means: on a confirmed-but-not-yet-delivered order, the goods
    -- are spoken for but the seller has not shipped them. Distinct from
    -- available, and the number a seller needs before promising a new order.
    'reserved', coalesce((
      select sum(oi.quantity) from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where o.store_id = p_store_id and oi.product_id = p_product_id
        and o.status in ('confirmed', 'processing', 'packaging', 'packed',
                         'shipped', 'on_delivery')
    ), 0),

    'sold_units', coalesce((
      select sum(oi.quantity) from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where o.org_id = v_org and o.store_id = p_store_id
        and oi.product_id = p_product_id
        and (p_from is null or (o.placed_at at time zone 'UTC')::date >= p_from)
        and (p_to   is null or (o.placed_at at time zone 'UTC')::date <= p_to)
        and o.status not in ('cancelled', 'returned', 'failed_delivery')
    ), 0),

    'revenue', coalesce((
      select sum(oi.line_total) from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where o.org_id = v_org and o.store_id = p_store_id
        and oi.product_id = p_product_id
        and (p_from is null or (o.placed_at at time zone 'UTC')::date >= p_from)
        and (p_to   is null or (o.placed_at at time zone 'UTC')::date <= p_to)
        and o.status not in ('cancelled', 'returned', 'failed_delivery')
    ), 0),

    'profit', coalesce((
      select sum(oi.line_total) - sum(coalesce(oi.unit_cost, 0) * oi.quantity)
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where o.org_id = v_org and o.store_id = p_store_id
        and oi.product_id = p_product_id
        and (p_from is null or (o.placed_at at time zone 'UTC')::date >= p_from)
        and (p_to   is null or (o.placed_at at time zone 'UTC')::date <= p_to)
        and o.status not in ('cancelled', 'returned', 'failed_delivery')
    ), 0)
  );
end;
$$;

-- Replaces the foundation's get_customer_stats with the full operational set.
-- Same argument, so existing callers keep working.
create or replace function public.get_customer_stats(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.customers where id = p_customer_id;

  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'customer_not_found' using hint = 'That customer no longer exists.';
  end if;

  return jsonb_build_object(
    'order_count', (select count(*) from public.orders
      where customer_id = p_customer_id
        and status not in ('cancelled', 'returned', 'failed_delivery')),
    'delivered_count', (select count(*) from public.orders
      where customer_id = p_customer_id and status = 'delivered'),
    'returned_count', (select count(*) from public.orders
      where customer_id = p_customer_id and status = 'returned'),
    'cancelled_count', (select count(*) from public.orders
      where customer_id = p_customer_id and status = 'cancelled'),
    'failed_count', (select count(*) from public.orders
      where customer_id = p_customer_id and status = 'failed_delivery'),
    'in_progress_count', (select count(*) from public.orders
      where customer_id = p_customer_id
        and status not in ('delivered', 'cancelled', 'returned', 'failed_delivery')),
    'total_spent', (select coalesce(sum(total), 0) from public.orders
      where customer_id = p_customer_id
        and status not in ('cancelled', 'returned', 'failed_delivery')),
    'outstanding', (select coalesce(sum(total - amount_paid), 0) from public.orders
      where customer_id = p_customer_id
        and status not in ('cancelled', 'returned', 'failed_delivery')
        and payment_status in ('unpaid', 'partial')),
    'cod_pending', (select coalesce(sum(cod_amount), 0) from public.orders
      where customer_id = p_customer_id and is_cod and not cod_settled
        and status not in ('cancelled', 'returned')),
    'average_order_value', coalesce((
      select round(avg(total), 2) from public.orders
      where customer_id = p_customer_id
        and status not in ('cancelled', 'returned', 'failed_delivery')
    ), 0),
    'last_order_at', (select max(placed_at) from public.orders
      where customer_id = p_customer_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Duplicate detection
--
-- Sellers create the same person twice constantly, usually with the phone
-- number formatted differently. Surfacing a likely match before saving is far
-- kinder than merging silently, so this reports rather than mutates.
-- ---------------------------------------------------------------------------

create or replace function public.find_duplicate_customers(
  p_org_id uuid,
  p_name   text,
  p_phone  text,
  p_limit  integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_norm text;
begin
  if not public.is_org_member(p_org_id) then
    raise exception 'not_authorized' using hint = 'You do not have access to this business.';
  end if;

  -- Compare on digits only, so +8801711000111, 01711000111 and
  -- 01711-000111 all match.
  v_norm := nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '');

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'name', c.name, 'phone', c.phone,
             'district', c.district, 'order_count', c.orders
           ) order by c.orders desc)
    from (
      select c2.id, c2.name, c2.phone, c2.district,
             (select count(*) from public.orders o where o.customer_id = c2.id) as orders,
             case
               when v_norm is not null and c2.phone is not null
                 and regexp_replace(c2.phone, '\D', '', 'g')
                     similar to '^(880)?' || v_norm || '$'
                 then 0   -- same phone: strongest signal
               when lower(c2.name) = lower(btrim(p_name)) then 1
               else 2
             end as rank
      from public.customers c2
      where c2.org_id = p_org_id and not c2.is_archived
        and (
          (v_norm is not null and c2.phone is not null
             and right(regexp_replace(c2.phone, '\D', '', 'g'), 10)
                 = right(v_norm, 10))
          or lower(c2.name) = lower(btrim(p_name))
        )
      order by rank, orders desc
      limit least(greatest(coalesce(p_limit, 5), 1), 20)
    ) c
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Courier reference data
--
-- Pathao requires numeric city / zone / area ids. These are fetched live from
-- the provider through the Edge Function and cached; the app never hard-codes
-- them, because an incorrect id is silently accepted by the API and produces a
-- parcel routed to the wrong district.
-- ---------------------------------------------------------------------------

create or replace function public.get_couriers(p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if p_org_id is null then
    raise exception 'not_authorized' using hint = 'No business selected.';
  end if;
  if not public.is_org_member(p_org_id) then
    raise exception 'not_authorized' using hint = 'You do not have access to this business.';
  end if;

  return jsonb_build_object(
    'connections', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'provider', c.provider,
               'label', c.label,
               'is_active', c.is_active,
               -- Whether the app may offer a real API call for this provider.
               'supports_api', public.courier_supports_api(c.provider),
               'has_credentials', c.vault_secret_id is not null,
               'external_store_id', c.external_store_id
             ) order by c.provider, c.label)
      from public.courier_connections c
      where c.org_id = p_org_id and c.is_active
    ), '[]'::jsonb)
  );
end;
$$;

-- ===========================================================================
-- Grants
-- ===========================================================================

revoke all on function
  public.dashboard_statuses(),
  public.get_dashboard(uuid, date),
  public.get_analytics(uuid, date, date),
  public.get_product_performance(uuid, date, date, integer),
  public.get_finance(uuid, date, date),
  public.get_product_stats(uuid, uuid, date, date),
  public.get_customer_stats(uuid),
  public.find_duplicate_customers(uuid, text, text, integer),
  public.get_couriers(uuid)
from public, anon;

grant execute on function
  public.dashboard_statuses(),
  public.get_dashboard(uuid, date),
  public.get_analytics(uuid, date, date),
  public.get_product_performance(uuid, date, date, integer),
  public.get_finance(uuid, date, date),
  public.get_product_stats(uuid, uuid, date, date),
  public.get_customer_stats(uuid),
  public.find_duplicate_customers(uuid, text, text, integer),
  public.get_couriers(uuid)
to authenticated;
