-- ===========================================================================
-- SellFlow :: 0014 -- store_id must belong to org_id
--
-- Found by the adversarial probe (verify_adversarial.sql, PROBE 8).
--
-- `expenses` was the only table where a client could INSERT directly while
-- holding both `org_id` and `store_id`. Its policy checked only that the caller
-- could write to the supplied org:
--
--     with check (public.can_write_org(org_id))
--
-- Nothing tied the store to that organization. A seller could therefore write a
-- row with their OWN org_id and ANOTHER seller's store_id, producing a record
-- that points at a store they do not own.
--
-- Blast radius is small but real: the row lands in the attacker's own ledger,
-- so no victim data is exposed, but it is a cross-tenant reference that shows up
-- in their own expense list and any report that joins on store_id.
--
-- Every other table carrying both columns -- orders, order_items, payments,
-- shipments, settlements, inventory -- has no client INSERT policy at all; they
-- are written exclusively through SECURITY DEFINER functions that resolve the
-- store from the caller's membership rather than trusting an id. That is the
-- reason the exposure was limited to one table, and it stays that way.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Helper
--
-- SECURITY DEFINER, so it does not recurse into the stores policy it consults.
-- ---------------------------------------------------------------------------
create or replace function public.store_in_org(p_store_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_store_id is not null
     and p_org_id is not null
     and exists (
       select 1 from public.stores s
       where s.id = p_store_id and s.org_id = p_org_id
     );
$$;

comment on function public.store_in_org(uuid, uuid) is
  'True when the store belongs to the organization. Used to stop a client pairing its own org_id with another tenant''s store_id.';

revoke all on function public.store_in_org(uuid, uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- Tighten the expense policies
--
-- Both directions matter. INSERT would create the bad row; UPDATE would let the
-- seller move an existing row onto a foreign store afterwards.
-- ---------------------------------------------------------------------------
drop policy if exists expenses_insert_writer on public.expenses;
create policy expenses_insert_writer on public.expenses
  for insert to authenticated
  with check (
    public.can_write_org(org_id)
    and public.store_in_org(store_id, org_id)
  );

drop policy if exists expenses_update_writer on public.expenses;
create policy expenses_update_writer on public.expenses
  for update to authenticated
  using (public.can_write_org(org_id))
  with check (
    public.can_write_org(org_id)
    and public.store_in_org(store_id, org_id)
  );

grant execute on function public.store_in_org(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- A guard, so the same mistake cannot be repeated silently by a later table.
--
-- Looks for any client INSERT policy whose WITH CHECK mentions `org_id` on a
-- table that also has a `store_id`, without calling store_in_org. That is
-- exactly the shape of the bug above, and the shape a future migration could
-- reintroduce.
--
-- Tables written only through SECURITY DEFINER functions have no client INSERT
-- policy, so they cannot match at all -- which is precisely why orders,
-- payments, shipments and settlements are not affected.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ')
  into v_bad
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and p.polcmd in ('INSERT', 'ALL')
    and p.polqual is not null
    -- The table carries both columns.
    and exists (select 1 from pg_attribute
                 where attrelid = c.oid and attname = 'org_id' and not attisdropped)
    and exists (select 1 from pg_attribute
                 where attrelid = c.oid and attname = 'store_id' and not attisdropped)
    -- The policy talks about org_id ...
    and pg_get_expr(p.polqual, p.polrelid) like '%org_id%'
    -- ... but never checks the store belongs to it.
    and pg_get_expr(p.polqual, p.polrelid) not like '%store_in_org%'
    -- Ownership tables the user holds themselves carry no store reference.
    and c.relname not in ('profiles', 'organizations', 'organization_members', 'stores');

  if v_bad is not null then
    raise exception
      'POLICY GAP: a client insert policy pairs org_id without store_in_org: %', v_bad;
  end if;
end $$;
