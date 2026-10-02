-- ===========================================================================
-- SellFlow :: 0002 -- tables
--
-- Money is `numeric(14,2)`. Postgres stores it exactly (no binary float), so
-- totals are never wrong in the database. The client additionally does all
-- arithmetic in integer minor units -- see src/lib/money.ts.
--
-- Every tenant-scoped table carries `org_id` denormalised alongside its parent
-- FK. That makes RLS predicates a single indexed equality instead of a join,
-- and lets the indexes in 0003 cover the common "this store, this range" query.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- profiles -- mirrors auth.users. Populated by the trigger in 0003.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  phone       text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is
  'One row per authenticated user. Not tenant-scoped; a user may belong to many organizations.';

-- ---------------------------------------------------------------------------
-- organizations -- the tenant boundary. RLS is enforced against org_id.
-- ---------------------------------------------------------------------------
create table if not exists public.organizations (
  id                    uuid primary key default gen_random_uuid(),
  name                  text        not null check (length(btrim(name)) between 1 and 120),
  -- Only 'BDT' is selectable in the UI today. The column is text rather than an
  -- enum so adding a currency is a data change, not a schema migration.
  currency              text        not null default 'BDT' check (currency ~ '^[A-Z]{3}$'),
  -- When false, creating an order that exceeds available stock raises instead of
  -- allowing negative inventory. Surfaced as a toggle in Settings -> Business.
  allow_negative_stock  boolean     not null default false,
  default_delivery_fee  numeric(14,2) not null default 0 check (default_delivery_fee >= 0),
  created_by            uuid        not null references public.profiles (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.organizations is
  'Top-level tenant. Every other business table hangs off org_id.';

-- ---------------------------------------------------------------------------
-- organization_members -- grants a user access to an org with a role.
-- ---------------------------------------------------------------------------
create table if not exists public.organization_members (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        public.member_role not null default 'staff',
  created_at  timestamptz not null default now(),
  -- One membership per user per org. This also makes upsert-based invite flows safe.
  unique (org_id, user_id)
);

-- ---------------------------------------------------------------------------
-- stores -- physical locations. A seller may run one store or many.
-- ---------------------------------------------------------------------------
create table if not exists public.stores (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  name        text        not null check (length(btrim(name)) between 1 and 120),
  code        text        check (code is null or code ~ '^[A-Z0-9_-]{1,16}$'),
  address     text,
  phone       text,
  is_default  boolean     not null default false,
  is_archived boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, name)
);

comment on column public.stores.code is
  'Short human-typed reference used in the order-number prefix (e.g. DHK).';

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations (id) on delete cascade,
  name                 text        not null check (length(btrim(name)) between 1 and 160),
  sku                  text,
  category             text,
  -- Price the customer pays. Selling below cost is allowed; SellFlow shows a
  -- warning rather than blocking it, because clearance sales are legitimate.
  selling_price        numeric(14,2) not null default 0 check (selling_price >= 0),
  -- What the seller paid. Used for profit. Nullable: sellers often do not track
  -- cost at all, and profit is then simply reported as unknown rather than 0.
  cost_price           numeric(14,2) check (cost_price is null or cost_price >= 0),
  low_stock_threshold  integer     not null default 0 check (low_stock_threshold >= 0),
  track_inventory      boolean     not null default true,
  image_url            text,
  notes                text,
  is_archived          boolean     not null default false,
  created_by           uuid references public.profiles (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- SKU must be unique per org so search-by-code is unambiguous. Nulls are
  -- allowed to repeat, which keeps products without a SKU cheap to create.
  unique (org_id, sku)
);

-- ---------------------------------------------------------------------------
-- product_variants -- optional size/colour/etc. rows under a product.
-- ---------------------------------------------------------------------------
create table if not exists public.product_variants (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  product_id     uuid not null references public.products (id) on delete cascade,
  name           text        not null check (length(btrim(name)) between 1 and 80),
  sku            text,
  -- Null means "inherit the parent product's price/cost" and is resolved when an
  -- order item is snapshotted.
  selling_price  numeric(14,2) check (selling_price is null or selling_price >= 0),
  cost_price     numeric(14,2) check (cost_price is null or cost_price >= 0),
  is_archived    boolean     not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (product_id, name)
);

-- ---------------------------------------------------------------------------
-- inventory -- current stock per store + product (+ variant).
--
-- One row per stock-keeping unit. The partial unique index in 0003 uses
-- NULLS NOT DISTINCT so NULL variant_id collides with itself -- otherwise a
-- product with no variant would get a fresh inventory row on every order.
-- ---------------------------------------------------------------------------
create table if not exists public.inventory (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  product_id  uuid not null references public.products (id) on delete cascade,
  variant_id  uuid references public.product_variants (id) on delete cascade,
  quantity    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Enforced in 0004 as a trigger so the organization rule is honoured too.
  constraint inventory_quantity_non_negative check (quantity >= 0)
);

-- ---------------------------------------------------------------------------
-- inventory_movements -- append-only audit log. Never updated, never deleted.
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_movements (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete cascade,
  store_id        uuid not null references public.stores (id) on delete cascade,
  product_id      uuid not null references public.products (id) on delete cascade,
  variant_id      uuid references public.product_variants (id) on delete cascade,
  -- Signed change. Negative leaves stock, positive returns it.
  delta           integer not null check (delta <> 0),
  reason          public.inventory_reason not null,
  -- Set when the movement was caused by an order, so the Products screen can
  -- link straight back to it.
  reference_type  text check (reference_type is null or reference_type in ('order', 'manual')),
  reference_id    uuid,
  note            text,
  balance_after   integer not null,
  created_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now()
);

comment on table public.inventory_movements is
  'Immutable ledger. balance_after records the resulting quantity for that unit, so the full stock history of a product can be replayed.';

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  name        text        not null check (length(btrim(name)) between 1 and 160),
  phone       text,
  email       text,
  address     text,
  notes       text,
  -- Soft archive. Customers are never hard-deleted because order history must
  -- remain attributable.
  is_archived boolean     not null default false,
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- orders
--
-- Money columns are denormalised from order_items. They are written only by the
-- create_order / update_order RPCs in 0005, never directly by the client, which
-- is what keeps subtotal, total and profit mutually consistent.
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  store_id         uuid not null references public.stores (id) on delete restrict,
  customer_id      uuid references public.customers (id) on delete set null,
  -- Human-facing sequential number scoped to the store, e.g. DHK-000042.
  order_number     text        not null,
  status           public.order_status   not null default 'pending',
  payment_status   public.payment_status not null default 'unpaid',
  -- Sum of item lines after per-line discounts, before the order discount.
  items_total      numeric(14,2) not null default 0,
  discount         numeric(14,2) not null default 0 check (discount >= 0),
  delivery_charge  numeric(14,2) not null default 0 check (delivery_charge >= 0),
  total            numeric(14,2) not null default 0,
  -- Sum of cost_price * qty at the moment the order was created. Frozen so a
  -- later price edit never rewrites historical profit.
  cost_total       numeric(14,2) not null default 0,
  profit           numeric(14,2) not null default 0,
  amount_paid      numeric(14,2) not null default 0 check (amount_paid >= 0),
  -- Client-generated UUID. Lets the app retry an interrupted create without
  -- creating a duplicate order.
  client_ref       uuid,
  notes            text,
  placed_at        timestamptz not null default now(),
  created_by       uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (store_id, order_number),
  unique (store_id, client_ref)
);

comment on column public.orders.profit is
  'total - cost_total. Delivery charge is counted as revenue. Expenses are NOT deducted here; net profit is aggregated separately so an order''s own profit stays auditable.';

-- ---------------------------------------------------------------------------
-- order_items -- product name and prices are snapshotted, not joined live.
-- ---------------------------------------------------------------------------
create table if not exists public.order_items (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  order_id     uuid not null references public.orders (id) on delete cascade,
  product_id   uuid references public.products (id) on delete set null,
  variant_id   uuid references public.product_variants (id) on delete set null,
  -- Snapshots. Renaming or re-pricing a product must not rewrite past orders.
  product_name text        not null,
  variant_name text,
  sku          text,
  unit_price   numeric(14,2) not null check (unit_price >= 0),
  unit_cost    numeric(14,2) check (unit_cost is null or unit_cost >= 0),
  quantity     integer     not null check (quantity > 0),
  line_discount numeric(14,2) not null default 0 check (line_discount >= 0),
  line_total   numeric(14,2) not null,
  created_at   timestamptz not null default now(),
  -- The order-level discount is distributed across lines proportionally by this
  -- ratio, so line_total + allocated discount always reconstructs the order total.
  constraint order_items_discount_within_line check (line_discount <= unit_price * quantity)
);

-- ---------------------------------------------------------------------------
-- payments -- every money-in event. amount_paid on the order is the running sum.
-- Refunds are stored as a separate flag rather than a negative amount, so
-- "total received" and "total refunded" stay independently reportable.
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  store_id     uuid not null references public.stores (id) on delete restrict,
  order_id     uuid not null references public.orders (id) on delete cascade,
  amount       numeric(14,2) not null check (amount > 0),
  method       public.payment_method not null default 'cash',
  is_refund    boolean     not null default false,
  paid_at      timestamptz not null default now(),
  note         text,
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- expenses
-- ---------------------------------------------------------------------------
create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  store_id     uuid references public.stores (id) on delete set null,
  amount       numeric(14,2) not null check (amount > 0),
  category     public.expense_category not null default 'miscellaneous',
  -- A date, not a timestamp: an expense is incurred on a calendar day.
  incurred_on  date        not null default current_date,
  description  text,
  note         text,
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- order_status_history
-- ---------------------------------------------------------------------------
create table if not exists public.order_status_history (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  order_id    uuid not null references public.orders (id) on delete cascade,
  from_status public.order_status,
  to_status   public.order_status not null,
  note        text,
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now()
);

comment on table public.order_status_history is
  'Append-only. The NULL -> pending row is written at creation so the timeline always has a start.';

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       public.notification_kind not null,
  title      text not null,
  body       text,
  -- Routing payload, e.g. {"order_id": "..."} so a tap deep-links correctly.
  data       jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- notification_preferences -- per user, per org.
-- ---------------------------------------------------------------------------
create table if not exists public.notification_preferences (
  org_id           uuid not null references public.organizations (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  new_order        boolean not null default true,
  low_stock        boolean not null default true,
  payment_due      boolean not null default true,
  order_status     boolean not null default true,
  account          boolean not null default true,
  updated_at       timestamptz not null default now(),
  primary key (org_id, user_id)
);
