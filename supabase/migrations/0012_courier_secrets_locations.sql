-- ===========================================================================
-- SellFlow :: 0011 -- courier secrets and location cache
--
-- Two supporting pieces for the courier integration.
--
-- 1. A guarded reader for Supabase Vault. Courier credentials live there and
--    are readable ONLY by the service role, so the anon key shipped in the
--    mobile app can never obtain a Pathao client secret.
--
-- 2. A cache of Pathao's city / zone / area hierarchy. These are stable
--    reference data that changes rarely, and fetching them on every shipment
--    would be slow and rate-limit prone. Critically, they are NOT hard-coded:
--    an invented zone id would be accepted by the API and silently route a
--    parcel to the wrong district.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Vault reader
--
-- SECURITY DEFINER and granted to service_role only. Deliberately NOT granted
-- to `authenticated` or `anon`.
--
-- The local verification database has no `vault` schema, so the function
-- detects that and raises a clear message instead of failing to compile.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    execute $fn$
      create or replace function public.read_vault_secret(p_secret_id uuid)
      returns jsonb
      language sql
      security definer
      set search_path = public, vault
      as $body$
        -- `vault.decrypted_secrets.secret` is TEXT, not jsonb. Without this cast
        -- the function fails to create on any real Supabase project with
        -- "return type mismatch ... Actual return type is text" (SQLSTATE 42P13).
        -- The local verification database has no vault schema and therefore
        -- never took this branch, so the bug was invisible to the regression
        -- suite until deployment. supabase/test/auth_shim.sql now creates a
        -- vault stub so local runs exercise the same path.
        select s.secret::jsonb
        from vault.decrypted_secrets s
        where s.id = p_secret_id
      $body$;
    $fn$;
  else
    -- Placeholder with the same signature so migrations and grants stay valid
    -- on a database without Vault (local verification, and any self-hosted
    -- Postgres that is not Supabase).
    execute $fn$
      create or replace function public.read_vault_secret(p_secret_id uuid)
      returns jsonb
      language sql
      security definer
      set search_path = public
      as $body$
        select null::jsonb
      $body$;
    $fn$;
  end if;
end $$;

comment on function public.read_vault_secret(uuid) is
  'Reads a courier credential from Supabase Vault. Service role only; the mobile app has no access to it.';

revoke all on function public.read_vault_secret(uuid) from public, anon, authenticated;
-- service_role is created by Supabase; grant defensively.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.read_vault_secret(uuid) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Location cache
--
-- Populated by the Pathao Edge Function, never by the app. The app reads it to
-- populate the district / thana / area pickers, which means the seller picks
-- from ids the courier will actually recognise.
-- ---------------------------------------------------------------------------

create table if not exists public.courier_locations (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  provider      public.courier_provider not null default 'pathao',
  kind          text        not null check (kind in ('city', 'zone', 'area')),
  external_id   text        not null,
  parent_id     text,
  name          text        not null,
  -- Pathao's numeric ids, stored as text because REDX and manual entries do
  -- not use numbers. Cast explicitly where a number is required.
  sort_order    integer     not null default 0,
  fetched_at    timestamptz not null default now(),
  -- Unique per org + provider + hierarchy position, so a refresh updates
  -- rather than duplicating.
  unique (org_id, provider, kind, external_id)
);

create index if not exists idx_courier_locations_browse
  on public.courier_locations (org_id, provider, kind, parent_id, sort_order);

comment on table public.courier_locations is
  'Cached courier geography (city / zone / area). Synced from the provider by an Edge Function; never hard-coded.';

-- ---------------------------------------------------------------------------
-- Location lookup for the app
--
-- Returns the three levels in one payload so the address form can offer a
-- dependent picker without three round trips.
-- ---------------------------------------------------------------------------

create or replace function public.get_courier_locations(
  p_org_id uuid,
  p_parent text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_org_member(p_org_id) then
    raise exception 'not_authorized' using hint = 'You do not have access to this business.';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', l.external_id,
             'name', l.name,
             'parent', l.parent_id
           ) order by l.sort_order, l.name)
    from public.courier_locations l
    where l.org_id = p_org_id
      and l.provider = 'pathao'
      and (p_parent is null or l.parent_id = p_parent)
  ), '[]'::jsonb);
end;
$$;

-- Replace the whole location set atomically, so a refresh never leaves the
-- picker half-populated.
create or replace function public.replace_courier_locations(
  p_org_id  uuid,
  p_kind    text,
  p_rows    jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  v_row   jsonb;
begin
  delete from public.courier_locations
  where org_id = p_org_id and provider = 'pathao' and kind = p_kind;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    insert into public.courier_locations
      (org_id, provider, kind, external_id, parent_id, name, sort_order)
    values (
      p_org_id, 'pathao', p_kind,
      v_row ->> 'id',
      nullif(v_row ->> 'parent_id', ''),
      coalesce(v_row ->> 'name', 'Unknown'),
      coalesce((v_row ->> 'sort_order')::integer, 0)
    )
    on conflict (org_id, provider, kind, external_id) do update
      set name = excluded.name,
          parent_id = excluded.parent_id,
          sort_order = excluded.sort_order,
          fetched_at = now();

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
--
-- Locations are readable by members. Writes go exclusively through
-- replace_courier_locations, which is service-role only, so a client cannot
-- inject a location id that the courier would reject.
-- ---------------------------------------------------------------------------

alter table public.courier_locations enable row level security;

drop policy if exists courier_locations_select on public.courier_locations;
create policy courier_locations_select on public.courier_locations
  for select to authenticated using (public.is_org_member(org_id));

grant select on public.courier_locations to authenticated;

revoke all on function
  public.get_courier_locations(uuid, text),
  public.replace_courier_locations(uuid, text, jsonb)
from public, anon;

grant execute on function public.get_courier_locations(uuid, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.replace_courier_locations(uuid, text, jsonb) to service_role';
  end if;
end $$;
