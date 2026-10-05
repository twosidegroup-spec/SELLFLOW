-- 0025: say out loud when a profit figure is only a floor, not an answer.
--
-- WHY A NEW FUNCTION AND NOT A CHANGE TO get_dashboard
--
-- `get_dashboard` is a ~300 line function that many screens read. Adding a key means
-- rewriting the whole body, and a rewritten body that differs by one key is a broken
-- dashboard discovered by a seller rather than by a test. So this adds a separate,
-- small function that answers exactly one question, and leaves the existing payload
-- untouched. Additive changes are the cheap kind to review and the safe kind to ship.
--
-- THE PROBLEM
--
-- Every profit figure is `line_total - coalesce(unit_cost, 0) * quantity`.
-- `order_items.unit_cost` is NULL when the product had no cost price when the order
-- was created, which is an ordinary state: many sellers simply do not know what a
-- thing cost them, and the product form deliberately lets them leave it blank.
--
-- `coalesce` is right for arithmetic and wrong for honesty. A missing cost is counted
-- as a cost of zero, so the profit shown is too high and the payload contains nothing
-- that says so. The dashboard tried to infer this on the client from
-- `costs.product + costs.courier + costs.other`, which is wrong in both directions:
--
--   * those figures cover a 30-day window, while the profit on screen is for today, so
--     a cost recorded last week made today's unknown-cost profit look trustworthy;
--   * they measure whether ANY cost was entered, not whether the cost of every line
--     sold is known, so one real cost made an otherwise unknown figure look final.
--
-- WHAT THIS RETURNS
--
-- For today, week, month and the 30-day window: whether at least one qualifying order
-- line has no usable cost price. NULL counts as unknown, and so does exactly 0.00 --
-- a cost of precisely nothing for a physical product is far more likely a placeholder
-- than a real figure.
--
-- The client decides how to phrase it. The server never guesses what "honest" means.
--
-- SECURITY
--
-- Identical to get_dashboard: `security definer` with a pinned search_path, and it
-- authorises through `assert_store_access(p_store_id)`, so a caller can only ever
-- read completeness for a store they belong to. There is no path that accepts an org
-- id. No table, column, policy or existing function is modified by this migration.

create or replace function public.get_profit_completeness(p_store_id uuid, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org        uuid;
  v_today_start timestamptz;
  v_tomorrow    timestamptz;
  v_week_start  timestamptz;
  v_month_start timestamptz;
begin
  v_org := public.assert_store_access(p_store_id);

  -- Same day boundaries as get_dashboard: midnight in the SELLER's timezone, not UTC.
  v_today_start := (p_today::date)::timestamp at time zone public.store_timezone(p_store_id);
  v_tomorrow    := v_today_start + interval '1 day';
  v_week_start  := (p_today - 6)::date::timestamp at time zone public.store_timezone(p_store_id);
  v_month_start := date_trunc('month', p_today::timestamp)::timestamp
                   at time zone public.store_timezone(p_store_id);

  /*
   * One helper shape, repeated per window, rather than a table-driven version: the
   * four windows have genuinely different boundaries (two timestamps, one 30-day
   * date range) and unifying them would mean a dynamic predicate for no gain. The
   * cost is four small copies of one exists clause; the benefit is that each one can
   * be read against the window it belongs to.
   *
   * `exists` not `count`, because "is it complete" stops being interesting the moment
   * the answer is known -- and the scan stops at the first unknown cost, which is
   * usually the first row for a seller who never records costs.
   */
  return jsonb_build_object(
    'today', jsonb_build_object(
      'profit_is_partial', exists (
        select 1
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        where o.org_id = v_org and o.store_id = p_store_id
          and o.placed_at >= v_today_start and o.placed_at < v_tomorrow
          and o.status not in ('cancelled', 'returned', 'failed_delivery')
          and (oi.unit_cost is null or oi.unit_cost = 0)
        limit 1
      ),
      'unknown_lines', (
        select count(*)::int
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        where o.org_id = v_org and o.store_id = p_store_id
          and o.placed_at >= v_today_start and o.placed_at < v_tomorrow
          and o.status not in ('cancelled', 'returned', 'failed_delivery')
          and (oi.unit_cost is null or oi.unit_cost = 0)
      )
    ),

    'week', jsonb_build_object(
      'profit_is_partial', exists (
        select 1
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        where o.org_id = v_org and o.store_id = p_store_id
          and o.placed_at >= v_week_start and o.placed_at < v_tomorrow
          and o.status not in ('cancelled', 'returned', 'failed_delivery')
          and (oi.unit_cost is null or oi.unit_cost = 0)
        limit 1
      )
    ),

    'month', jsonb_build_object(
      'profit_is_partial', exists (
        select 1
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        where o.org_id = v_org and o.store_id = p_store_id
          and o.placed_at >= v_month_start and o.placed_at < v_tomorrow
          and o.status not in ('cancelled', 'returned', 'failed_delivery')
          and (oi.unit_cost is null or oi.unit_cost = 0)
        limit 1
      )
    ),

    -- The same 30-day window `get_dashboard` uses for `costs` and `net_profit`, so
    -- the flag lines up with the figure it qualifies.
    'costs', jsonb_build_object(
      'profit_is_partial', exists (
        select 1
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        where o.org_id = v_org and o.store_id = p_store_id
          and (o.placed_at at time zone public.store_timezone(p_store_id))::date
              between p_today - 29 and p_today
          and o.status not in ('cancelled', 'returned', 'failed_delivery')
          and (oi.unit_cost is null or oi.unit_cost = 0)
        limit 1
      )
    ),

    'updated_at', now()
  );
end;
$fn$;

comment on function public.get_profit_completeness(uuid, date) is
  'Whether each dashboard window''s profit figure rests on complete cost data. '
  'true means at least one line has no recorded cost price, so the number is a floor, not a result.';

-- The same grant shape as every other read RPC in this schema: authenticated only,
-- never anon, never public. `assert_store_access` inside does the actual authorisation.
revoke all on function public.get_profit_completeness(uuid, date) from public, anon;
grant execute on function public.get_profit_completeness(uuid, date) to authenticated;

-- service_role is named explicitly for the same reason as in 0024: Supabase's default
-- privileges grant EXECUTE on functions in public to service_role, so leaving it alone
-- is not the same as it being absent. The admin key bypasses RLS and can already read
-- everything; this only makes that explicit rather than incidental.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_profit_completeness(uuid, date) to service_role;
  end if;
end;
$$;