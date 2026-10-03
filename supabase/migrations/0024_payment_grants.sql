-- SellFlow :: 0024 -- explicit least-privilege grants for the payment engine
--
-- Found by running the schema contract against the LINKED HOSTED project, after
-- the contract passed cleanly on local Postgres. The asymmetry matters:
--
--   Supabase projects carry project-level DEFAULT PRIVILEGES on the public
--   schema that grant `arwdDxtm` -- INSERT, SELECT, UPDATE, DELETE, TRUNCATE,
--   REFERENCES, TRIGGER, MAINTAIN -- to BOTH `anon` and `authenticated` for
--   every table created in public.
--
--   Local verification runs on vanilla Postgres, which has no such defaults, so
--   the tables ended up with SELECT-only grants there and the whole grant
--   section of the contract passed. On hosted, inspection showed:
--
--     ACL payment_events : postgres=arwdDxtm/postgres
--                          anon=arwdDxtm/postgres
--                          authenticated=arwdDxtm/postgres
--                          service_role=arwdDxtm/postgres
--
--   The application was NOT exploitable through this: RLS has no INSERT, UPDATE
--   or DELETE policy on these tables, so RLS default-denied every write, and the
--   only SELECT policy is is_org_member(org_id), which is false for anon.
--
--   But that makes the entire write protection of a money ledger rest on "no
--   policy happens to exist". Anyone who later adds a policy for an unrelated
--   reason, or a project created with different defaults, silently inherits
--   table-level CRUD for the payment ledger and the only thing standing between
--   a bug and a forged payment is the absence of a policy.
--
-- This migration makes the trust boundary explicit rather than inherited. It
-- grants exactly what the client needs -- SELECT, nothing else -- and asserts
-- the result, so a future change that widens access fails the contract suite
-- instead of passing quietly on one database and failing on another.
--
-- Nothing here changes behaviour for the app: the privileges revoked were never
-- usable, because RLS already denied them.

-- ---------------------------------------------------------------------------
-- 1. Tables: read-only for the client, invisible to anon
-- ---------------------------------------------------------------------------

revoke all on
  public.payment_accounts,
  public.payment_intents,
  public.payment_events,
  public.payment_matches,
  public.payment_audit_logs
  from anon, authenticated;

grant select on
  public.payment_accounts,
  public.payment_intents,
  public.payment_events,
  public.payment_matches,
  public.payment_audit_logs
  to authenticated;

comment on table public.payment_events is
  'Append-only ledger of detected payments. Rows are never updated except to '
  'advance status; corrections happen through refunds or manual review, not by '
  'rewriting a detected amount. INSERT/UPDATE/DELETE are revoked from anon and '
  'authenticated on purpose: every write goes through an authorised function.';

-- ---------------------------------------------------------------------------
-- 2. Pure helpers: authenticated only
--
-- payment_normalize_bk_number is pure and harmless, but PUBLIC execute is an
-- accident of omission rather than a decision. The client needs it (to show a
-- seller the canonical form of a number they typed), so grant it deliberately.
-- ---------------------------------------------------------------------------

revoke all on function public.payment_normalize_bk_number(text) from public, anon;
revoke all on function public.payment_provider_method(public.payment_provider) from public, anon;
grant execute on function
  public.payment_normalize_bk_number(text),
  public.payment_provider_method(public.payment_provider)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Money functions are reachable only from a signed-in seller session
--
-- These were never granted to service_role in 0022/0023, but Supabase's default
-- privileges grant EXECUTE on every function in public to service_role as well,
-- so "not granted" was not the same as "not reachable". service_role is named
-- explicitly here.
--
-- What this does and does not buy, stated plainly: with the service key a caller
-- can still write the payment tables directly through PostgREST, because
-- service_role has BYPASSRLS. That is inherent to Supabase's admin role and
-- cannot be revoked away. What is revoked is the FUNCTIONS -- so no relay,
-- edge function or script can settle a payment by name without a session. The
-- remaining protection for the service key is that the app never ships it: it
-- lives only in Edge Function secrets. See docs/payment-engine.md.
-- ---------------------------------------------------------------------------

revoke all on function
  public.create_payment_account(uuid, public.payment_provider, text, text, text),
  public.set_payment_account_status(uuid, public.payment_account_status, boolean),
  public.create_payment_intent(public.payment_intent_type, uuid, uuid, numeric, text, text, timestamptz, uuid),
  public.cancel_payment_intent(uuid, text),
  public.reject_payment_match(uuid, text),
  public.ingest_payment_event(uuid, public.payment_provider, text, text, numeric, text, timestamptz, public.payment_event_source, text, uuid, text),
  public.match_payment_event(uuid),
  public.assign_payment_match(uuid, uuid, text),
  public.expire_stale_payment_intents(),
  public.settle_event_to_intent(public.payment_events, public.payment_intents, uuid, public.payment_audit_actor),
  public.score_payment_match(public.payment_events, public.payment_intents),
  public.log_payment_audit(uuid, public.payment_audit_actor, public.payment_audit_action, uuid, uuid, uuid, uuid, text, uuid, jsonb)
  from public, anon, authenticated;

-- service_role exists only on a real Supabase project. Grant defensively, as
-- 0012 does for the vault readers.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function
      public.create_payment_account(uuid, public.payment_provider, text, text, text),
      public.set_payment_account_status(uuid, public.payment_account_status, boolean),
      public.create_payment_intent(public.payment_intent_type, uuid, uuid, numeric, text, text, timestamptz, uuid),
      public.cancel_payment_intent(uuid, text),
      public.reject_payment_match(uuid, text),
      public.ingest_payment_event(uuid, public.payment_provider, text, text, numeric, text, timestamptz, public.payment_event_source, text, uuid, text),
      public.match_payment_event(uuid),
      public.assign_payment_match(uuid, uuid, text),
      public.expire_stale_payment_intents(),
      public.settle_event_to_intent(public.payment_events, public.payment_intents, uuid, public.payment_audit_actor),
      public.score_payment_match(public.payment_events, public.payment_intents),
      public.log_payment_audit(uuid, public.payment_audit_actor, public.payment_audit_action, uuid, uuid, uuid, uuid, text, uuid, jsonb)
      from service_role;
  end if;
end $$;

grant execute on function
  public.create_payment_account(uuid, public.payment_provider, text, text, text),
  public.set_payment_account_status(uuid, public.payment_account_status, boolean),
  public.create_payment_intent(public.payment_intent_type, uuid, uuid, numeric, text, text, timestamptz, uuid),
  public.cancel_payment_intent(uuid, text),
  public.reject_payment_match(uuid, text),
  public.ingest_payment_event(uuid, public.payment_provider, text, text, numeric, text, timestamptz, public.payment_event_source, text, uuid, text),
  public.match_payment_event(uuid),
  public.assign_payment_match(uuid, uuid, text),
  public.expire_stale_payment_intents()
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Assert the boundary rather than assume it
--
-- A migration that silently fails to apply its revokes would still be recorded
-- as applied. These checks fail loudly, in the same transaction, if the
-- privileges are not what this migration claims.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  select string_agg(format('%s (%s)', rel, role_name), ', ')
  into v_bad
  from (
    select t.rel as rel, r.role_name as role_name
    from (values
      ('payment_accounts'), ('payment_intents'), ('payment_events'),
      ('payment_matches'), ('payment_audit_logs')
    ) as t(rel)
    cross join (values ('anon'), ('authenticated')) as r(role_name)
    where has_table_privilege(r.role_name, 'public.' || t.rel, 'INSERT')
       or has_table_privilege(r.role_name, 'public.' || t.rel, 'UPDATE')
       or has_table_privilege(r.role_name, 'public.' || t.rel, 'DELETE')
       or has_table_privilege(r.role_name, 'public.' || t.rel, 'TRUNCATE')
  ) offenders;

  if v_bad is not null then
    raise exception
      'GRANT GAP: a client role still holds write privilege on the payment ledger: %', v_bad;
  end if;

  if has_table_privilege('anon', 'public.payment_events', 'SELECT') then
    raise exception 'GRANT GAP: anon can still read the payment ledger';
  end if;

  if not has_table_privilege('authenticated', 'public.payment_events', 'SELECT') then
    raise exception 'GRANT GAP: authenticated lost read access to the payment ledger';
  end if;

  -- service_role is created by Supabase and does not exist on the local
  -- verification database, so this assertion is conditional. Same guard the
  -- vault migration uses in 0012.
  if exists (select 1 from pg_roles where rolname = 'service_role')
     and has_function_privilege('service_role',
       'public.settle_event_to_intent(public.payment_events,public.payment_intents,uuid,public.payment_audit_actor)',
       'EXECUTE') then
    raise exception 'GRANT GAP: service_role can settle a payment without a session';
  end if;
end $$;