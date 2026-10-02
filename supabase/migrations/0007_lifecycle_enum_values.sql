-- ===========================================================================
-- SellFlow :: 0006_9 -- order lifecycle enum values
--
-- Split out of 0007 purely so the migration set is DEPLOYABLE. The resulting
-- schema is identical; no label, transition or rule is changed.
--
-- Why this file has to exist
-- --------------------------
-- Postgres error 55P04: "unsafe use of new value ... of enum type". A value added
-- with `ALTER TYPE ... ADD VALUE` cannot be USED anywhere until the transaction
-- that added it commits. `supabase db push` runs each migration in its own
-- transaction, so 0007's `add value 'packaging'` followed by a function body
-- containing the literal 'packaging' fails, leaving every migration from 0007
-- onward unapplied.
--
-- The local Docker suite never caught this: each file was applied by a separate
-- `psql -f` process, so the enum value was already committed by the time 0007
-- referenced it. `supabase db push` is stricter and is the real deployment path.
--
-- The fix is ordering, not logic. The three values are added here and committed;
-- 0007's `add value if not exists` then becomes a no-op.
--
-- ORDERING: the numeric prefix must sort after 0001 (which creates the type) and
-- before 0007_fulfilment_lifecycle.sql. `0006_9` satisfies that under plain
-- lexicographic sort, which is what both `supabase db push` and
-- scripts/run-db-tests.mjs use. The CLI requires a purely numeric prefix, so an
-- `0006b`-style name is rejected outright.
-- ===========================================================================

do $$ begin
  alter type public.order_status add value if not exists 'packaging';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.order_status add value if not exists 'packed';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.order_status add value if not exists 'on_delivery';
exception when duplicate_object then null;
end $$;
