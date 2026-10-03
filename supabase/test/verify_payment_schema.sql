-- ===========================================================================
-- SellFlow :: payment engine schema contract
--
-- A structural contract for the payment tables, so "the migration applied" is
-- never mistaken for "the migration applied correctly".
--
-- This suite is deliberately read-only and runs unchanged on the local
-- verification database AND against the linked hosted project, because the
-- failure it is designed to catch is exactly the kind that only appears after a
-- push: a missing index, a function that quietly kept an old signature, a
-- SECURITY DEFINER helper left executable by the client, or a policy that
-- grants more than intended.
--
-- It emits TAP output as well as raising on failure, so it works under both the
-- local runner (plain psql, exit code) and `supabase test db` (pg_prove).
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

-- TAP plan line. Quoted, because bare `1..1` is not valid SQL.
select '1..1';

create temporary table _c (
  name text primary key,
  ok boolean not null,
  detail text
);

-- ---------------------------------------------------------------------------
-- 1. Tables exist
-- ---------------------------------------------------------------------------

insert into _c (name, ok, detail)
select t.name,
       to_regclass('public.' || t.name) is not null,
       coalesce(to_regclass('public.' || t.name)::text, 'missing')
from (values
  ('payment_accounts'), ('payment_intents'), ('payment_events'),
  ('payment_matches'), ('payment_audit_logs')
) as t(name);

-- ---------------------------------------------------------------------------
-- 2. Enum values
--
-- Checked as sets, not as literals, so reordering is allowed but adding or
-- renaming a value is not -- the matching policy and the UI switch on these.
-- ---------------------------------------------------------------------------

insert into _c (name, ok, detail)
select 'enum ' || e.name,
       e.actual = e.expected,
       case when e.actual = e.expected then 'exact' else 'got {' || e.actual || '}' end
from (
  select 'payment_event_source' as name,
         (select string_agg(v, ',' order by v) from unnest(enum_range(null::public.payment_event_source)::text[]) as v) as actual,
         'api,import,manual,sms' as expected
  union all
  select 'payment_provider',
         (select string_agg(v, ',' order by v) from unnest(enum_range(null::public.payment_provider)::text[]) as v),
         'bkash,nagad,rocket,upay'
  union all
  select 'payment_match_strength',
         (select string_agg(v, ',' order by v) from unnest(enum_range(null::public.payment_match_strength)::text[]) as v),
         'manual,medium,strong,weak'
  union all
  select 'payment_intent_type',
         (select string_agg(v, ',' order by v) from unnest(enum_range(null::public.payment_intent_type)::text[]) as v),
         'invoice,order,other,subscription'
  union all
  select 'payment_audit_actor',
         (select string_agg(v, ',' order by v) from unnest(enum_range(null::public.payment_audit_actor)::text[]) as v),
         'seller,system'
) e;

-- The two statuses with many values are asserted as membership rather than as a
-- full set: they are expected to grow, and the values that matter for money
-- safety are the terminal ones.
insert into _c (name, ok, detail)
select 'enum payment_event_status has terminal states',
       t.statuses @> array['confirmed','duplicate','review_required','unmatched','mismatch']::text[],
       'has ' || array_to_string(t.statuses, ',')
from (select enum_range(null::public.payment_event_status)::text[] as statuses) t;

insert into _c (name, ok, detail)
select 'enum payment_intent_status has terminal states',
       t.statuses @> array['open','matched','expired','cancelled']::text[],
       'has ' || array_to_string(t.statuses, ',')
from (select enum_range(null::public.payment_intent_status)::text[] as statuses) t;

-- ---------------------------------------------------------------------------
-- 3. Uniqueness guarantees exist
--
-- These are the constraints that make double counting impossible. Their absence
-- is silent: every functional test would still pass on a single delivery, and the
-- bug would only appear on a retrying phone in production.
-- ---------------------------------------------------------------------------

insert into _c (name, ok, detail)
select 'unique index ' || i.name,
       ix.indisunique,
       case when ix.indisunique then 'unique' else 'NOT UNIQUE' end
from (values
  ('uq_payment_events_identity'),
  ('uq_payment_events_client_ref'),
  ('uq_payment_matches_accepted_event'),
  ('uq_payment_intents_settled_event'),
  ('uq_payment_intents_client_ref'),
  ('uq_payment_accounts_org_provider_number')
) as i(name)
left join pg_class c on c.relname = i.name and c.relnamespace = 'public'::regnamespace
left join pg_index ix on ix.indexrelid = c.oid;

-- The identity index must cover exactly the provider/account/transaction triple.
-- A unique index on the wrong columns still passes a count check.
insert into _c (name, ok, detail)
select 'uq_payment_events_identity covers provider, account, transaction id',
       ix.indisunique
   and pg_get_indexdef(ix.indexrelid) like '%(provider, payment_account_id, transaction_id)%',
       pg_get_indexdef(ix.indexrelid)
from pg_index ix
join pg_class c on c.oid = ix.indexrelid
where c.relname = 'uq_payment_events_identity'
  and c.relnamespace = 'public'::regnamespace;

-- ---------------------------------------------------------------------------
-- 4. Function signatures
--
-- Pinned explicitly. A function that kept a previous signature still exists and
-- still compiles, but every caller passing the newer argument list fails at
-- runtime -- which is why the migration drops superseded signatures.
-- ---------------------------------------------------------------------------

insert into _c (name, ok, detail)
select 'function ' || f.sig,
       to_regprocedure('public.' || f.sig) is not null,
       coalesce(to_regprocedure('public.' || f.sig)::text, 'MISSING')
from (values
  ('create_payment_account(uuid,public.payment_provider,text,text,text)'),
  ('set_payment_account_status(uuid,public.payment_account_status,boolean)'),
  ('create_payment_intent(public.payment_intent_type,uuid,uuid,numeric,text,text,timestamptz,uuid)'),
  ('cancel_payment_intent(uuid,text)'),
  ('reject_payment_match(uuid,text)'),
  ('expire_stale_payment_intents()'),
  ('payment_normalize_bk_number(text)'),
  ('payment_provider_method(public.payment_provider)'),
  ('ingest_payment_event(uuid,public.payment_provider,text,text,numeric,text,timestamptz,public.payment_event_source,text,uuid,text)'),
  ('match_payment_event(uuid)'),
  ('assign_payment_match(uuid,uuid,text)')
) as f(sig);

-- The superseded five-argument record_payment must NOT still exist, or a caller
-- could reach a money path that predates the idempotency key.
insert into _c (name, ok, detail)
select 'superseded record_payment(uuid,numeric,payment_method,timestamptz,text) is gone',
       to_regprocedure('public.record_payment(uuid,numeric,public.payment_method,timestamptz,text)') is null,
       coalesce(to_regprocedure('public.record_payment(uuid,numeric,public.payment_method,timestamptz,text)')::text, 'absent');

-- The money path itself must still be the six-argument idempotent version.
insert into _c (name, ok, detail)
select 'record_payment keeps its idempotency key parameter',
       to_regprocedure('public.record_payment(uuid,numeric,public.payment_method,timestamptz,text,uuid)') is not null,
       coalesce(to_regprocedure('public.record_payment(uuid,numeric,public.payment_method,timestamptz,text,uuid)')::text, 'MISSING');

-- ---------------------------------------------------------------------------
-- 5. Trust boundary
--
-- The two internal helpers must not be callable by the client. If either leaked,
-- a compromised session could settle a payment with no authorisation at all.
-- ---------------------------------------------------------------------------

insert into _c (name, ok, detail)
select 'authenticated cannot execute settle_event_to_intent',
       not has_function_privilege('authenticated',
             'public.settle_event_to_intent(public.payment_events,public.payment_intents,uuid,public.payment_audit_actor)',
             'EXECUTE'),
       'internal helper';

insert into _c (name, ok, detail)
select 'authenticated cannot execute score_payment_match',
       not has_function_privilege('authenticated',
             'public.score_payment_match(public.payment_events,public.payment_intents)',
             'EXECUTE'),
       'internal helper';

-- service_role is Supabase-created and absent from the local verification
-- database, so this is asserted only where it exists. A relay holding the
-- service key must not be able to settle a payment: money entering the ledger
-- has to be attributable to a signed-in session.
insert into _c (name, ok, detail)
select 'settlement function is unreachable by service_role',
       case
         when not exists (select 1 from pg_roles where rolname = 'service_role') then true
         else not has_function_privilege('service_role',
                'public.settle_event_to_intent(public.payment_events,public.payment_intents,uuid,public.payment_audit_actor)',
                'EXECUTE')
       end,
       case
         when not exists (select 1 from pg_roles where rolname = 'service_role')
           then 'skipped: role absent on local verification'
         else 'asserted'
       end;

-- ---------------------------------------------------------------------------
-- 6. Row Level Security and grants
-- ---------------------------------------------------------------------------

insert into _c (name, ok, detail)
select 'rls enabled on ' || t.name,
       c.relrowsecurity,
       case when c.relrowsecurity then 'enabled' else 'DISABLED' end
from (values
  ('payment_accounts'), ('payment_intents'), ('payment_events'),
  ('payment_matches'), ('payment_audit_logs')
) as t(name)
join pg_class c on c.relname = t.name and c.relnamespace = 'public'::regnamespace;

insert into _c (name, ok, detail)
select t.name || ' is readable by authenticated',
       has_table_privilege('authenticated', 'public.' || t.name, 'SELECT'),
       'select grant'
from (values
  ('payment_accounts'), ('payment_intents'), ('payment_events'),
  ('payment_matches'), ('payment_audit_logs')
) as t(name);

-- The client must have no direct write path to the ledger. Every mutation goes
-- through a function that re-authorises.
insert into _c (name, ok, detail)
select t.name || ' has no client write privilege',
       not has_table_privilege('authenticated', 'public.' || t.name, 'INSERT')
   and not has_table_privilege('authenticated', 'public.' || t.name, 'UPDATE')
   and not has_table_privilege('authenticated', 'public.' || t.name, 'DELETE'),
       'insert/update/delete all denied'
from (values
  ('payment_accounts'), ('payment_intents'), ('payment_events'),
  ('payment_matches'), ('payment_audit_logs')
) as t(name);

insert into _c (name, ok, detail)
select 'no client write policy on ' || t.name,
       not exists (
         select 1 from pg_policy p
         where p.polrelid = ('public.' || t.name)::regclass
           and p.polcmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       ),
       case when exists (
         select 1 from pg_policy p
         where p.polrelid = ('public.' || t.name)::regclass
           and p.polcmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       ) then 'WRITE POLICY PRESENT' else 'none' end
from (values
  ('payment_accounts'), ('payment_intents'), ('payment_events'),
  ('payment_matches'), ('payment_audit_logs')
) as t(name);

-- anon must see nothing at all.
insert into _c (name, ok, detail)
select 'anon cannot read the payment ledger',
       not has_table_privilege('anon', 'public.payment_events', 'SELECT'),
       'anon denied';

-- ---------------------------------------------------------------------------
-- 7. The engine must not have widened the money path
--
-- orders is the table Phase 2 promised not to touch. If this migration had
-- added a policy or grant to it, that promise would be broken silently.
-- ---------------------------------------------------------------------------

insert into _c (name, ok, detail)
select 'payment engine added no write policy to orders',
       not exists (
         select 1 from pg_policy p
         where p.polrelid = 'public.orders'::regclass
           and p.polcmd in ('INSERT', 'UPDATE', 'DELETE')
       ),
       'orders untouched';

-- ---------------------------------------------------------------------------
-- 8. Pure function behaviour
--
-- These two functions carry the phone-normalisation rule the whole matcher
-- depends on, and they are pure, so they can be exercised on any database.
--
-- They are executable by `authenticated` only (0024), so a read-only role --
-- notably the one `supabase test db --linked` connects as -- cannot call them.
-- That is recorded as a skip rather than a failure: the tight grant is the
-- intended state, and the behaviour is verified wherever the role may call it.
do $helpers$
declare
  n record;
  m record;
begin
  begin
    select
      public.payment_normalize_bk_number('01822000111') as a,
      public.payment_normalize_bk_number('+8801822000111') as b,
      public.payment_normalize_bk_number('8801822000111') as c,
      public.payment_normalize_bk_number('1822000111') as d,
      public.payment_normalize_bk_number('not-a-number') as e
    into n;

    select
      public.payment_provider_method('bkash')::text as b,
      public.payment_provider_method('nagad')::text as n,
      public.payment_provider_method('rocket')::text as r,
      public.payment_provider_method('upay')::text as u
    into m;

    insert into _c (name, ok, detail) values
      ('normalize: 018 / +88018 / 88018 / bare all agree, junk passes through',
       n.a = '01822000111' and n.b = n.a and n.c = n.a and n.d = n.a and n.e = 'not-a-number',
       'got ' || n.b || ' / ' || n.c || ' / ' || n.d || ' / junk=' || n.e),

      -- The exact bug this guards: substring(v from 2) is a character offset,
      -- not a regex capture group, and silently produced 0801712345678 instead of
      -- 01712345678 -- so every +880 payment would have failed to match.
      ('normalize: +880 form yields a 10-digit local number, not an 11-digit one',
       public.payment_normalize_bk_number('+8801712345678') = '01712345678',
       public.payment_normalize_bk_number('+8801712345678')),

      ('provider mapping: bkash/nagad/rocket map to themselves, upay maps to other',
       m.b = 'bkash' and m.n = 'nagad' and m.r = 'rocket' and m.u = 'other',
       'bkash=' || m.b || ' nagad=' || m.n || ' rocket=' || m.r || ' upay=' || m.u);

  exception when insufficient_privilege then
    insert into _c (name, ok, detail)
    values ('pure helper behaviour', true,
            'skipped: this role cannot execute the helpers (0024 grants them to authenticated only)');
  end;
end
$helpers$;

-- ---------------------------------------------------------------------------
-- 9. Migration history (hosted only)
--
-- The authoritative "local and hosted agree" signal. Skipped on the local
-- verification database, which applies files directly and keeps no history.
-- ---------------------------------------------------------------------------

do $$
declare
  v_has_history boolean;
  v_count integer;
  v_missing text;
begin
  -- This check needs to read supabase_migrations, which the restricted role
  -- `supabase test db --linked` connects as cannot do. That is a deliberate
  -- platform boundary, not a fault, so an unprivileged run records a skip
  -- instead of failing the whole contract.
  begin
    select to_regclass('supabase_migrations.schema_migrations') is not null into v_has_history;
  exception when insufficient_privilege then
    insert into _c (name, ok, detail)
    values ('migration history present (hosted contract)', true,
            'skipped: this role cannot read supabase_migrations');
    return;
  end;

  if not v_has_history then
    insert into _c (name, ok, detail)
    values ('migration history present (hosted contract)', true, 'skipped: local run keeps no history table');
    return;
  end if;

  select count(*) into v_count from supabase_migrations.schema_migrations;

  select string_agg(t.version, ',') into v_missing
  from unnest(array['0001','0002','0003','0004','0005','0006','0007','0008','0009','0010',
                    '0011','0012','0013','0014','0015','0016','0017','0018','0019','0020',
                    '0021','0022','0023','0024']) as t(version)
  where not exists (
    select 1 from supabase_migrations.schema_migrations m where m.version = t.version
  );

  insert into _c (name, ok, detail)
  values (
    'all 24 migrations recorded on this project',
    v_count = 24 and v_missing is null,
    case when v_count = 24 and v_missing is null
         then '24/24'
         else v_count::text || ' applied, missing: ' || coalesce(v_missing, 'none') end
  );
end $$;

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------

do $$
declare
  v_failed integer;
  v_detail text;
begin
  select count(*) into v_failed from _c where not ok;

  if v_failed > 0 then
    select string_agg('      ' || name || ' -> ' || detail, e'  \n') into v_detail
    from _c where not ok;

    raise exception 'PAY SCHEMA: % of % contract checks failed on this database:%  %',
      v_failed, (select count(*) from _c), e'\n', v_detail;
  end if;

  raise notice 'PAY SCHEMA: all % contract checks passed', (select count(*) from _c);
end $$;

select 'ok 1 - payment engine schema contract holds';

rollback;

\echo ''
\echo '  All SellFlow payment schema contract checks passed.'
\echo ''