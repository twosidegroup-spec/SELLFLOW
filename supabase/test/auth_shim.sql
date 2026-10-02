-- ===========================================================================
-- SellFlow :: auth shim (LOCAL VERIFICATION ONLY)
--
-- Supabase provides the `auth` schema, `auth.users`, and `auth.uid()`. Vanilla
-- Postgres does not, so this shim lets the real migration files be executed
-- against a plain Postgres container to verify that they compile and behave.
--
-- DO NOT RUN THIS IN A REAL SUPABASE PROJECT. It would replace Supabase's own
-- auth schema. It exists purely so `npm run db:verify` can prove the migration
-- SQL is valid before it reaches your dashboard.
-- ===========================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Supabase exposes the authenticated user's id through this function. The shim
-- reads from a session GUC so tests can switch identities with `set request.jwt.claim.sub`.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Supabase grants these by default; replicate so GRANT/REVOKE statements in the
-- migrations do not fail with "role does not exist".
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

grant usage on schema public, auth to anon, authenticated;
grant select, insert, update, delete on auth.users to authenticated;

-- Supabase installs pgcrypto and the trigram extension into an `extensions`
-- schema; the migration in 0003 relies on that schema existing.
create schema if not exists extensions;

-- ...and pgcrypto actually lives *in* that schema on Supabase, so migrations
-- call it as `extensions.digest(...)` / `extensions.gen_random_bytes(...)`
-- rather than unqualified. The schema alone is not enough: without the
-- extension installed here, 0019's token hashing and generation would pass on
-- a real project but fail here, and a test that cannot see the bug is worse
-- than no test.
create extension if not exists pgcrypto with schema extensions;

-- Supabase also grants the app roles USAGE on `extensions`, because migrations
-- call `extensions.digest(...)` and `extensions.gen_random_bytes(...)` from
-- code that runs as `authenticated`.
grant usage on schema extensions to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Vault stub
--
-- Migration 0012 creates `read_vault_secret` differently depending on whether
-- the `vault` schema exists: on a real Supabase project it selects from
-- `vault.decrypted_secrets`, and locally it returns null.
--
-- That conditional meant local runs exercised a DIFFERENT code path than
-- production, which is how a `returns jsonb` function selecting a TEXT column
-- shipped unnoticed and only failed at deploy time with SQLSTATE 42P13.
--
-- Creating the schema here makes local runs take the same branch as production,
-- so this class of bug is caught by the regression suite instead of by a
-- deployment. The stub returns no rows, so nothing secret is ever materialised.
-- ---------------------------------------------------------------------------
create schema if not exists vault;

create table if not exists vault.decrypted_secrets (
  id    uuid primary key default gen_random_uuid(),
  secret text
);

-- No rows, and no grants: the table exists purely so the function compiles on
-- the same code path it uses in production.
revoke all on vault.decrypted_secrets from public, anon, authenticated;
