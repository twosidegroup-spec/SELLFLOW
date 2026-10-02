-- ===========================================================================
-- SellFlow :: 0003 -- indexes and triggers
-- ===========================================================================

-- Trigram matching so `ILIKE '%term%'` uses an index instead of a sequential
-- scan. Without this, product/customer search degrades linearly with the
-- catalog, which is exactly what makes search feel slow on real data.
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'organizations', 'stores', 'products', 'product_variants',
    'inventory', 'customers', 'orders', 'expenses', 'notification_preferences'
  ]
  loop
    execute format('drop trigger if exists trg_touch_%1$s on public.%1$I', t);
    execute format(
      'create trigger trg_touch_%1$s before update on public.%1$I
         for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Auth -> profile bootstrap
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'phone'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- New users get a notification_preferences row per org. Inserted lazily by
-- bootstrap_business() (0005) rather than here, since membership does not
-- exist yet at signup time.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Negative-inventory guard
--
-- The table-level CHECK only catches direct writes. This trigger enforces the
-- per-organization `allow_negative_stock` policy so the business setting is
-- actually respected, and produces a message the client can map to a friendly
-- error rather than leaking raw SQL to the user.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_stock_floor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  allow_negative boolean;
begin
  if new.quantity >= 0 then
    return new;
  end if;

  select o.allow_negative_stock into allow_negative
  from public.organizations o
  where o.id = new.org_id;

  if coalesce(allow_negative, false) then
    return new;
  end if;

  raise exception 'insufficient_stock'
    using hint = 'Raise stock with an inventory adjustment, or enable negative stock in Settings.';
end;
$$;

drop trigger if exists trg_inventory_floor on public.inventory;
create trigger trg_inventory_floor
  before insert or update on public.inventory
  for each row execute function public.enforce_stock_floor();

-- ===========================================================================
-- Indexes
--
-- Every index below backs a query the app actually issues. Leading columns are
-- always the tenant scope (org_id / store_id) so RLS predicates are satisfied
-- by the index itself.
-- ===========================================================================

-- "which orgs am I in?" -- runs on every authenticated cold start.
create index if not exists idx_org_members_user
  on public.organization_members (user_id, org_id);

create index if not exists idx_stores_org
  on public.stores (org_id, is_archived, created_at);

-- Products: list screen (active first, newest first) + search.
create index if not exists idx_products_org_active
  on public.products (org_id, is_archived, created_at desc);

create index if not exists idx_products_name_trgm
  on public.products using gin (name extensions.gin_trgm_ops);

create index if not exists idx_products_sku_trgm
  on public.products using gin (sku extensions.gin_trgm_ops);

create index if not exists idx_products_category
  on public.products (org_id, category) where category is not null;

-- Variants are always read as a child list.
create index if not exists idx_variants_product
  on public.product_variants (product_id) where is_archived = false;

-- Inventory: one row per stock-keeping unit. NULLS NOT DISTINCT (Postgres 15+)
-- makes NULL variant_id collide with itself, so a product with no variant gets
-- exactly one row instead of a new one on every order.
create unique index if not exists uq_inventory_unit
  on public.inventory (store_id, product_id, variant_id) nulls not distinct;

create index if not exists idx_inventory_product
  on public.inventory (product_id);

create index if not exists idx_inventory_org_store
  on public.inventory (org_id, store_id);

-- Movement history screen: newest first, scoped to one product.
create index if not exists idx_movements_product
  on public.inventory_movements (org_id, product_id, created_at desc);

-- Dashboard "recent activity" feed.
create index if not exists idx_movements_recent
  on public.inventory_movements (org_id, store_id, created_at desc);

create index if not exists idx_movements_reference
  on public.inventory_movements (reference_type, reference_id)
  where reference_id is not null;

-- Customers: list + search on name and phone.
create index if not exists idx_customers_org
  on public.customers (org_id, is_archived, created_at desc);

create index if not exists idx_customers_name_trgm
  on public.customers using gin (name extensions.gin_trgm_ops);

create index if not exists idx_customers_phone_trgm
  on public.customers using gin (phone extensions.gin_trgm_ops)
  where phone is not null;

-- Orders. The status + placed_at index serves both the Orders tab default view
-- and every status filter; the store + placed_at index serves "recent orders"
-- and date-range reporting.
create index if not exists idx_orders_store_recent
  on public.orders (store_id, placed_at desc);

create index if not exists idx_orders_org_status
  on public.orders (org_id, status, placed_at desc);

create index if not exists idx_orders_store_status
  on public.orders (store_id, status, placed_at desc);

-- Customer order-history screen.
create index if not exists idx_orders_customer
  on public.orders (customer_id, placed_at desc)
  where customer_id is not null;

-- Order-number lookup when a seller types a code instead of using search.
create index if not exists idx_orders_number_trgm
  on public.orders using gin (order_number extensions.gin_trgm_ops);

-- Revenue / profit reporting over a date window.
create index if not exists idx_orders_placed_at
  on public.orders (placed_at desc);

create index if not exists idx_order_items_order
  on public.order_items (order_id);

create index if not exists idx_order_items_product
  on public.order_items (product_id) where product_id is not null;

-- "Which products actually sell?" -- the Sales tab.
create index if not exists idx_order_items_product_stats
  on public.order_items (product_id, order_id) where product_id is not null;

create index if not exists idx_payments_order
  on public.payments (order_id, paid_at desc);

create index if not exists idx_payments_org_recent
  on public.payments (org_id, store_id, paid_at desc)
  where not is_refund;

create index if not exists idx_expenses_org_date
  on public.expenses (org_id, incurred_on desc, id);

create index if not exists idx_expenses_store_date
  on public.expenses (store_id, incurred_on desc)
  where store_id is not null;

create index if not exists idx_status_history_order
  on public.order_status_history (order_id, created_at);

create index if not exists idx_notifications_inbox
  on public.notifications (user_id, created_at desc);

-- The badge only counts unread rows, so partial index keeps it tiny.
create index if not exists idx_notifications_unread
  on public.notifications (user_id, created_at desc) where read_at is null;
