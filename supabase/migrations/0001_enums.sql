-- ===========================================================================
-- SellFlow :: 0001 -- extensions and enums
--
-- Run in order with 0002..0006 in the Supabase SQL editor (or `supabase db push`).
-- Every object is created idempotently so migrations can be re-run safely.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
--
-- Enum labels are stored as text and sent to the client verbatim. Renaming a
-- label later would break clients, so add new labels rather than renaming.
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.member_role as enum ('owner', 'manager', 'staff');
exception when duplicate_object then null;
end $$;

do $$ begin
  -- The controlled order lifecycle. `cancelled` and `returned` are terminal and
  -- always restore stock. `failed_delivery` is a delivery outcome, not a
  -- lifecycle step.
  create type public.order_status as enum (
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
    'returned',
    'failed_delivery'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.payment_status as enum ('unpaid', 'partial', 'paid', 'refunded');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.payment_method as enum (
    'cash', 'bkash', 'nagad', 'rocket', 'card', 'bank', 'other'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  -- `sale` and `sale_return` are always produced by order RPCs. A manual
  -- adjustment from the Products screen uses `adjustment` or `initial`.
  create type public.inventory_reason as enum (
    'initial', 'purchase', 'sale', 'sale_return', 'adjustment', 'damage'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.expense_category as enum (
    'advertising', 'packaging', 'delivery', 'sourcing', 'software',
    'salary', 'rent', 'utilities', 'miscellaneous'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.notification_kind as enum (
    'new_order', 'low_stock', 'payment_due', 'order_status', 'account'
  );
exception when duplicate_object then null;
end $$;
