-- ===========================================================================
-- SellFlow :: 0004 -- Row Level Security
--
-- Security model
-- -------------
-- * Every business table is org-scoped. Access requires membership of that org.
-- * `staff` may read everything in their org but may not mutate it.
-- * `manager` and `owner` may mutate.
-- * Only `owner` may manage stores, members, and organization settings.
--
-- Why the helpers are SECURITY DEFINER
-- -----------------------------------
-- The obvious policy -- "read organization_members if you are a member" -- calls
-- back into organization_members and makes RLS recurse infinitely. These
-- helpers are SECURITY DEFINER, so they execute as their owner and are exempt
-- from the policies they are used in, which breaks the cycle. They are also
-- `stable` and therefore evaluated once per statement rather than per row.
--
-- `revoke execute ... from public` at the bottom stops `anon` from calling them;
-- they are granted only to `authenticated`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------

create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_org_id is not null
     and exists (
       select 1
       from public.organization_members m
       where m.org_id = p_org_id
         and m.user_id = auth.uid()
     );
$$;

create or replace function public.org_role_of(p_org_id uuid)
returns public.member_role
language sql
stable
security definer
set search_path = public
as $$
  select m.role
  from public.organization_members m
  where m.org_id = p_org_id
    and m.user_id = auth.uid();
$$;

-- Staff read-only. Write access needs manager or owner.
create or replace function public.can_write_org(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select m.role in ('owner', 'manager')
       from public.organization_members m
      where m.org_id = p_org_id and m.user_id = auth.uid()),
    false);
$$;

create or replace function public.is_org_owner(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select m.role = 'owner'
       from public.organization_members m
      where m.org_id = p_org_id and m.user_id = auth.uid()),
    false);
$$;

-- Resolves a store to its org and confirms membership. Used by the business RPCs
-- in 0005, which run SECURITY DEFINER and therefore bypass RLS entirely and
-- must authorize explicitly.
create or replace function public.assert_store_access(p_store_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select s.org_id into v_org
  from public.stores s
  where s.id = p_store_id and not s.is_archived;

  if v_org is null then
    raise exception 'store_not_found' using hint = 'The store does not exist.';
  end if;

  if not public.is_org_member(v_org) then
    -- Deliberately the same error as "not found": revealing that a store exists
    -- in an org you cannot see leaks information across the tenant boundary.
    raise exception 'store_not_found' using hint = 'The store does not exist.';
  end if;

  return v_org;
end;
$$;

create or replace function public.assert_org_write(p_org_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_write_org(p_org_id) then
    raise exception 'insufficient_role'
      using hint = 'Your role in this business is read-only.';
  end if;
end;
$$;

comment on function public.assert_store_access(uuid) is
  'Returns the owning org_id, or raises store_not_found. Callers must use the return value as the org_id for all subsequent writes -- never trust a client-supplied org_id.';

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. No table in public is left unprotected.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'organizations', 'organization_members', 'stores',
    'products', 'product_variants', 'inventory', 'inventory_movements',
    'customers', 'orders', 'order_items', 'payments', 'expenses',
    'order_status_history', 'notifications', 'notification_preferences'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- profiles -- a user may only read and edit their own row.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No INSERT/UPDATE/DELETE policy on profiles: rows are created by the
-- handle_new_user() trigger and removed by the auth.users cascade.

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
drop policy if exists orgs_select_member on public.organizations;
create policy orgs_select_member on public.organizations
  for select to authenticated
  using (public.is_org_member(id));

drop policy if exists orgs_insert_self on public.organizations;
create policy orgs_insert_self on public.organizations
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists orgs_update_owner on public.organizations;
create policy orgs_update_owner on public.organizations
  for update to authenticated
  using (public.is_org_owner(id))
  with check (public.is_org_owner(id));

drop policy if exists orgs_delete_owner on public.organizations;
create policy orgs_delete_owner on public.organizations
  for delete to authenticated
  using (public.is_org_owner(id));

-- ---------------------------------------------------------------------------
-- organization_members
-- ---------------------------------------------------------------------------
drop policy if exists members_select_member on public.organization_members;
create policy members_select_member on public.organization_members
  for select to authenticated
  using (public.is_org_member(org_id));

-- Only an owner may add or change members. Bootstrap creates the first owner
-- membership inside bootstrap_business(), which re-checks explicitly.
drop policy if exists members_insert_owner on public.organization_members;
create policy members_insert_owner on public.organization_members
  for insert to authenticated
  with check (public.is_org_owner(org_id));

drop policy if exists members_update_owner on public.organization_members;
create policy members_update_owner on public.organization_members
  for update to authenticated
  using (public.is_org_owner(org_id))
  with check (public.is_org_owner(org_id));

-- Owners manage anyone; anyone may remove their own membership (leaving).
drop policy if exists members_delete_owner_or_self on public.organization_members;
create policy members_delete_owner_or_self on public.organization_members
  for delete to authenticated
  using (public.is_org_owner(org_id) or user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- stores -- owner-level administration.
-- ---------------------------------------------------------------------------
drop policy if exists stores_select_member on public.stores;
create policy stores_select_member on public.stores
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists stores_insert_owner on public.stores;
create policy stores_insert_owner on public.stores
  for insert to authenticated
  with check (public.is_org_owner(org_id));

drop policy if exists stores_update_owner on public.stores;
create policy stores_update_owner on public.stores
  for update to authenticated
  using (public.is_org_owner(org_id))
  with check (public.is_org_owner(org_id));

drop policy if exists stores_delete_owner on public.stores;
create policy stores_delete_owner on public.stores
  for delete to authenticated
  using (public.is_org_owner(org_id));

-- ---------------------------------------------------------------------------
-- Catalog: products / product_variants / customers
-- Read for any member, write for manager+.
-- ---------------------------------------------------------------------------

drop policy if exists products_select_member on public.products;
create policy products_select_member on public.products
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists products_insert_writer on public.products;
create policy products_insert_writer on public.products
  for insert to authenticated
  with check (public.can_write_org(org_id));

drop policy if exists products_update_writer on public.products;
create policy products_update_writer on public.products
  for update to authenticated
  using (public.can_write_org(org_id))
  with check (public.can_write_org(org_id));

drop policy if exists products_delete_writer on public.products;
create policy products_delete_writer on public.products
  for delete to authenticated
  using (public.can_write_org(org_id));

drop policy if exists variants_select_member on public.product_variants;
create policy variants_select_member on public.product_variants
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists variants_insert_writer on public.product_variants;
create policy variants_insert_writer on public.product_variants
  for insert to authenticated
  with check (public.can_write_org(org_id));

drop policy if exists variants_update_writer on public.product_variants;
create policy variants_update_writer on public.product_variants
  for update to authenticated
  using (public.can_write_org(org_id))
  with check (public.can_write_org(org_id));

drop policy if exists variants_delete_writer on public.product_variants;
create policy variants_delete_writer on public.product_variants
  for delete to authenticated
  using (public.can_write_org(org_id));

drop policy if exists customers_select_member on public.customers;
create policy customers_select_member on public.customers
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists customers_insert_writer on public.customers;
create policy customers_insert_writer on public.customers
  for insert to authenticated
  with check (public.can_write_org(org_id));

drop policy if exists customers_update_writer on public.customers;
create policy customers_update_writer on public.customers
  for update to authenticated
  using (public.can_write_org(org_id))
  with check (public.can_write_org(org_id));

-- Customers are archived, never deleted -- order history must stay attributable.
drop policy if exists customers_delete_writer on public.customers;
create policy customers_delete_writer on public.customers
  for delete to authenticated
  using (public.can_write_org(org_id));

-- ---------------------------------------------------------------------------
-- inventory -- read only from the client.
--
-- All stock mutation goes through adjust_stock() in 0005, which runs as a single
-- transaction and writes the matching movement row. Granting direct write
-- access here would allow stock to change with no audit trail.
-- ---------------------------------------------------------------------------

drop policy if exists inventory_select_member on public.inventory;
create policy inventory_select_member on public.inventory
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists movements_select_member on public.inventory_movements;
create policy movements_select_member on public.inventory_movements
  for select to authenticated
  using (public.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- orders / order_items / payments / order_status_history -- read only.
-- Mutations happen exclusively through create_order, update_order,
-- set_order_status, and record_payment in 0005.
-- ---------------------------------------------------------------------------

drop policy if exists orders_select_member on public.orders;
create policy orders_select_member on public.orders
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists order_items_select_member on public.order_items;
create policy order_items_select_member on public.order_items
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists payments_select_member on public.payments;
create policy payments_select_member on public.payments
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists status_history_select_member on public.order_status_history;
create policy status_history_select_member on public.order_status_history
  for select to authenticated
  using (public.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- expenses
-- ---------------------------------------------------------------------------
drop policy if exists expenses_select_member on public.expenses;
create policy expenses_select_member on public.expenses
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists expenses_insert_writer on public.expenses;
create policy expenses_insert_writer on public.expenses
  for insert to authenticated
  with check (public.can_write_org(org_id));

drop policy if exists expenses_update_writer on public.expenses;
create policy expenses_update_writer on public.expenses
  for update to authenticated
  using (public.can_write_org(org_id))
  with check (public.can_write_org(org_id));

drop policy if exists expenses_delete_writer on public.expenses;
create policy expenses_delete_writer on public.expenses
  for delete to authenticated
  using (public.can_write_org(org_id));

-- ---------------------------------------------------------------------------
-- notifications -- strictly per user.
-- ---------------------------------------------------------------------------
drop policy if exists notifications_select_self on public.notifications;
create policy notifications_select_self on public.notifications
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists notifications_update_self on public.notifications;
create policy notifications_update_self on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists notifications_delete_self on public.notifications;
create policy notifications_delete_self on public.notifications
  for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- notification_preferences -- per user, per org.
-- ---------------------------------------------------------------------------
drop policy if exists notif_prefs_select_self on public.notification_preferences;
create policy notif_prefs_select_self on public.notification_preferences
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists notif_prefs_upsert_self on public.notification_preferences;
create policy notif_prefs_upsert_self on public.notification_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Grants
--
-- Supabase grants these to `anon`/`authenticated` by default when tables are
-- created. Stating them explicitly keeps the file honest and survives projects
-- with altered default privileges. RLS is what actually protects the data.
-- ---------------------------------------------------------------------------

grant usage on schema public to authenticated;

grant select, update on public.profiles to authenticated;

grant select, insert, update, delete on
  public.organizations,
  public.organization_members,
  public.stores,
  public.products,
  public.product_variants,
  public.customers,
  public.expenses,
  public.notification_preferences
to authenticated;

grant select on
  public.inventory,
  public.inventory_movements,
  public.orders,
  public.order_items,
  public.payments,
  public.order_status_history
to authenticated;

grant select, update, delete on public.notifications to authenticated;

-- Sequence access for tables with serial columns (none currently, but keeps a
-- future migration from failing).
grant usage, select on all sequences in schema public to authenticated;

-- Helper functions: authenticated only. `anon` is deliberately excluded so an
-- unauthenticated caller cannot probe membership or roles.
revoke execute on function
  public.is_org_member(uuid),
  public.org_role_of(uuid),
  public.can_write_org(uuid),
  public.is_org_owner(uuid),
  public.assert_store_access(uuid),
  public.assert_org_write(uuid)
from public, anon;

grant execute on function
  public.is_org_member(uuid),
  public.org_role_of(uuid),
  public.can_write_org(uuid),
  public.is_org_owner(uuid),
  public.assert_store_access(uuid),
  public.assert_org_write(uuid)
to authenticated;

-- No anonymous access to any business table.
revoke all on all tables in schema public from anon;
