-- ===========================================================================
-- SellFlow :: 0006 -- reporting
--
-- Read-side aggregation functions. These are SECURITY DEFINER for the same
-- reason as 0005: they join across org-scoped tables and would otherwise be
-- unwieldy to express as client-side joins. Each one calls assert_store_access()
-- first, so the tenant boundary is still enforced.
--
-- "Revenue" always excludes cancelled, returned and failed-delivery orders.
-- Pending orders are counted, because the seller has committed to them; the UI
-- labels the figure accordingly rather than quietly inflating a "profit" number.
--
-- `p_today` is supplied by the client rather than derived with now() at the
-- server, so that "today" means today where the seller's phone is, not where
-- the database happens to run.
-- ===========================================================================

create or replace function public.get_dashboard(p_store_id uuid, p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org       uuid := public.assert_store_access(p_store_id);
  v_today_start timestamptz := p_today::timestamp;
  v_tomorrow    timestamptz := (p_today + 1)::timestamp;
  v_month_start timestamptz := date_trunc('month', p_today::timestamp);
  v_result     jsonb;
begin
  select jsonb_build_object(
    -- Headline figures -------------------------------------------------
    'today', (select jsonb_build_object(
      'revenue',   coalesce(sum(total), 0),
      'profit',    coalesce(sum(profit), 0),
      'cost',      coalesce(sum(cost_total), 0),
      'orders',    count(*),
      'delivered', count(*) filter (where status = 'delivered')
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and placed_at >= v_today_start and placed_at < v_tomorrow
      and status not in ('cancelled', 'returned', 'failed_delivery')),

    'month', (select jsonb_build_object(
      'revenue', coalesce(sum(total), 0),
      'profit',  coalesce(sum(profit), 0),
      'orders',  count(*)
    )
    from public.orders
    where org_id = v_org and store_id = p_store_id
      and placed_at >= v_month_start and placed_at < v_tomorrow
      and status not in ('cancelled', 'returned', 'failed_delivery')),

    -- Money still owed to the seller across every open order ------------
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

    -- Work waiting on the seller ---------------------------------------
    'pending_orders', (select count(*)
      from public.orders
      where org_id = v_org and store_id = p_store_id and status = 'pending'),

    'to_ship', (select count(*)
      from public.orders
      where org_id = v_org and store_id = p_store_id
        and status in ('confirmed', 'processing')),

    'to_deliver', (select count(*)
      from public.orders
      where org_id = v_org and store_id = p_store_id and status = 'shipped'),

    -- Catalog health ----------------------------------------------------
    'low_stock', (select coalesce(jsonb_agg(x), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'product_id', p.id,
                 'name', p.name,
                 'quantity', coalesce(i.quantity, 0),
                 'threshold', p.low_stock_threshold
               ) as x
        from public.products p
        left join public.inventory i
          on i.product_id = p.id
         and i.store_id = p_store_id
         and i.variant_id is null
        where p.org_id = v_org
          and not p.is_archived
          and p.track_inventory
          and p.low_stock_threshold > 0
          and coalesce(i.quantity, 0) <= p.low_stock_threshold
        order by coalesce(i.quantity, 0) asc, p.name asc
        limit 5
      ) t),

    'low_stock_count', (select count(*)
      from public.products p
      left join public.inventory i
        on i.product_id = p.id and i.store_id = p_store_id and i.variant_id is null
      where p.org_id = v_org and not p.is_archived and p.track_inventory
        and p.low_stock_threshold > 0
        and coalesce(i.quantity, 0) <= p.low_stock_threshold),

    'product_count', (select count(*)
      from public.products where org_id = v_org and not products.is_archived),

    'customer_count', (select count(*)
      from public.customers where org_id = v_org and not customers.is_archived),

    'total_orders', (select count(*)
      from public.orders where org_id = v_org and store_id = p_store_id),

    -- Recent activity ---------------------------------------------------
    'recent_orders', (select coalesce(jsonb_agg(x), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'id', o.id,
                 'order_number', o.order_number,
                 'status', o.status,
                 'payment_status', o.payment_status,
                 'total', o.total,
                 'customer_name', c.name,
                 'placed_at', o.placed_at
               ) as x
        from public.orders o
        left join public.customers c on c.id = o.customer_id
        where o.org_id = v_org and o.store_id = p_store_id
        order by o.placed_at desc
        limit 5
      ) t),

    'recent_activity', (select coalesce(jsonb_agg(x), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'id', m.id,
                 'kind', 'inventory',
                 'title', p.name,
                 'detail', m.note,
                 'delta', m.delta,
                 'created_at', m.created_at
               ) as x
        from public.inventory_movements m
        join public.products p on p.id = m.product_id
        where m.org_id = v_org and m.store_id = p_store_id
        order by m.created_at desc
        limit 5
      ) t),

    -- 14-day revenue sparkline. Days with no orders are present with zero
    -- rather than absent, so the chart never silently shortens its axis.
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
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Per-customer rollup used by the customer detail screen. Kept as a function
-- rather than stored columns so it can never drift out of sync with orders.
-- ---------------------------------------------------------------------------
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
    'total_spent', (select coalesce(sum(total), 0) from public.orders
      where customer_id = p_customer_id
        and status not in ('cancelled', 'returned', 'failed_delivery')),
    'outstanding', (select coalesce(sum(total - amount_paid), 0) from public.orders
      where customer_id = p_customer_id
        and status not in ('cancelled', 'returned', 'failed_delivery')
        and payment_status in ('unpaid', 'partial')),
    'last_order_at', (select max(placed_at) from public.orders
      where customer_id = p_customer_id),
    'cancelled_count', (select count(*) from public.orders
      where customer_id = p_customer_id
        and status in ('cancelled', 'returned', 'failed_delivery'))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Sales report for a date range: one row per day plus totals.
-- ---------------------------------------------------------------------------
create or replace function public.get_sales_report(
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
      and (placed_at at time zone 'UTC')::date between p_from and p_to
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
         and (o.placed_at at time zone 'UTC')::date = d::date
         and o.status not in ('cancelled', 'returned', 'failed_delivery')
        group by d
      ) t)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Top products by revenue over a range.
-- ---------------------------------------------------------------------------
create or replace function public.get_top_products(
  p_store_id uuid,
  p_from     date,
  p_to       date,
  p_limit    integer default 5
)
returns setof jsonb
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
        and (o.placed_at at time zone 'UTC')::date between p_from and p_to
        and o.status not in ('cancelled', 'returned', 'failed_delivery')
        and oi.product_id is not null
      group by oi.product_id
      order by sum(oi.line_total) desc
      limit least(greatest(coalesce(p_limit, 5), 1), 50)
    ) t;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function
  public.get_dashboard(uuid, date),
  public.get_customer_stats(uuid),
  public.get_sales_report(uuid, date, date),
  public.get_top_products(uuid, date, date, integer)
from public, anon;

grant execute on function
  public.get_dashboard(uuid, date),
  public.get_customer_stats(uuid),
  public.get_sales_report(uuid, date, date),
  public.get_top_products(uuid, date, date, integer)
to authenticated;
