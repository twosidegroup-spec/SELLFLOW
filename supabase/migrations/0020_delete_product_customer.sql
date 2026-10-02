-- ---------------------------------------------------------------------------
-- Deleting a product or a customer for good.
--
-- Sellers create these by mistake: a duplicate entry, a test product, a customer
-- who turned out to be a walk-in. Archive is the safe answer but it still leaves
-- the row in the list, so there has to be a real delete.
--
-- The trap is the foreign keys:
--
--   order_items.product_id -> products   ON DELETE SET NULL
--   orders.customer_id     -> customers  ON DELETE SET NULL
--
-- SET NULL, not RESTRICT. So the database will NOT stop us from deleting a
-- product that has been sold -- it will quietly null the link and leave an order
-- in the seller's history with no idea what was on it. A February sale would
-- stop reconciling, and nothing would look broken.
--
-- So the refusal is explicit and happens before the delete. The rule is
-- deliberately narrow: history that a MONEY figure depends on blocks deletion,
-- history that does not does not.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- delete_product
-- ---------------------------------------------------------------------------
create or replace function public.delete_product(p_product_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org     uuid;
  v_name    text;
  v_tracked text;
  v_sold    integer;
begin
  select public.assert_store_access(s.id), p.name, p.is_archived
    into v_org, v_name, v_tracked
  from public.products p
  join public.stores s on s.org_id = p.org_id
  where p.id = p_product_id
  limit 1;

  if v_org is null then
    raise exception 'product_not_found' using hint = 'That product no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  -- The one thing that must never happen: removing a product from a sale that
  -- already happened.
  select count(*) into v_sold
  from public.order_items oi
  where oi.product_id = p_product_id;

  if v_sold > 0 then
    raise exception 'product_has_sales'
      using hint = v_name || ' is on ' || v_sold ||
        case when v_sold = 1 then ' order. ' else ' orders. ' end ||
        'Archive it instead so your sales history stays correct.';
  end if;

  -- No sales reference it, so inventory and its movements cascade away. That is
  -- the right outcome: a product nobody ever bought has no financial history to
  -- preserve, and leaving orphaned stock rows behind would be worse.
  delete from public.products where id = p_product_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- delete_customer
-- ---------------------------------------------------------------------------
create or replace function public.delete_customer(p_customer_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org   uuid;
  v_name  text;
  v_orders integer;
begin
  select public.assert_store_access(s.id), c.name
    into v_org, v_name
  from public.customers c
  join public.stores s on s.org_id = c.org_id
  where c.id = p_customer_id
  limit 1;

  if v_org is null then
    raise exception 'customer_not_found' using hint = 'That customer no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  -- orders.customer_id is SET NULL, so deleting a customer who has ordered would
  -- silently turn their sales into walk-in sales. That changes revenue reports
  -- and loses who the money came from.
  select count(*) into v_orders
  from public.orders o
  where o.customer_id = p_customer_id;

  if v_orders > 0 then
    raise exception 'customer_has_orders'
      using hint = v_name || ' has ' || v_orders ||
        case when v_orders = 1 then ' order. ' else ' orders. ' end ||
        'Archive them instead so your sales history stays correct.';
  end if;

  delete from public.customers where id = p_customer_id;

  return true;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC on a new function by default. A delete is
-- the most dangerous thing in this file, so it is revoked from PUBLIC and anon
-- explicitly rather than relying on a grant to narrow it.
revoke execute on function public.delete_product(uuid) from public, anon;
revoke execute on function public.delete_customer(uuid) from public, anon;
grant execute on function public.delete_product(uuid) to authenticated;
grant execute on function public.delete_customer(uuid) to authenticated;
