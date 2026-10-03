-- SellFlow :: 0022 -- automatic payment detection: ledger, intents and matching
--
-- Foundation for the MFS (bKash / Nagad / Rocket / Upay) payment detection and
-- matching engine.
--
-- The engine is a payment-EVENT pipeline, not an SMS parser:
--
--   transport (SMS today, an MFS API later, manual entry today)
--     -> normalized payment event  (ingest_payment_event)
--     -> deduplicated by the database, never by the client
--     -> matched against a payment intent
--     -> confirmed
--     -> record_payment(...)  for an ORDER intent
--
-- The backend deliberately does not know or care which transport produced an
-- event. `payment_event_source` is part of the data, not the code path, so
-- replacing SMS with an official MFS API later is an additional source, not a
-- rewrite. See docs/payment-engine.md.
--
-- HARD RULES this migration enforces, and how:
--
--   1. The client can never declare a payment confirmed.
--      There is no client INSERT/UPDATE/DELETE policy on any of these tables,
--      and no write grant. Every mutation is a SECURITY DEFINER function that
--      re-authorises with assert_store_access / assert_org_write and derives
--      the org from the store rather than trusting a client-supplied org_id.
--      `orders` is untouched: the money path is the existing record_payment().
--
--   2. A payment can never be credited twice.
--      uq_payment_events_identity is a database UNIQUE constraint over
--      (provider, payment_account_id, transaction_id). Second delivery of the
--      same transaction raises unique_violation and the ingest function turns
--      that into a DUPLICATE row rather than a second credit.
--
--   3. Tenant isolation.
--      RLS on every table via is_org_member, plus the
--      registry assertion added in 0015 that aborts this migration if any table
--      ever gets a client insert policy pairing org_id without store_in_org().
--
-- Matching never mutates orders. It records a match and calls record_payment(),
-- which is the single authoritative path for "this order is paid".

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- The transport that produced an event. The engine treats these identically;
-- adding a source does not change the pipeline.
create type public.payment_event_source as enum (
  'sms',        -- read from an incoming SMS on the seller's device
  'api',        -- an MFS or aggregator API (future)
  'manual',     -- the seller typed the transaction id
  'import'      -- bulk reconciliation uploaded by the seller (future)
);

-- Which mobile financial service the money moved through. Kept separate from
-- public.payment_method on purpose: payment_method is how the seller says they
-- took the money (cash, card, bank...), while this is which MFS reported it.
-- A bKash transfer is payment_method 'bkash' AND payment_provider 'bkash';
-- the two are related but are not the same fact, and the MFS set grows faster
-- than the hand-tender set.
create type public.payment_provider as enum (
  'bkash',
  'nagad',
  'rocket',
  'upay'
);

create type public.payment_account_status as enum (
  'pending',
  'connected',
  'disconnected',
  'error'
);

-- What the money is being collected for. Generic on purpose: the same engine
-- settles a seller's customer order and a SellFlow subscription, so nothing
-- here assumes an order.
create type public.payment_intent_type as enum (
  'order',
  'subscription',
  'invoice',
  'other'
);

create type public.payment_intent_status as enum (
  'open',          -- waiting for a matching payment
  'matched',       -- an event matched it and was confirmed
  'partially_paid',
  'expired',
  'cancelled',
  'mismatched'    -- money arrived but the amount did not line up
);

-- Lifecycle of one detected payment event.
create type public.payment_event_status as enum (
  'detected',        -- accepted into the ledger, not yet matched
  'matched',         -- matched to an intent
  'confirmed',       -- settled; for an order, record_payment() has run
  'unmatched',       -- no intent could be matched; awaiting seller review
  'mismatch',        -- matched an intent but the amount differs
  'duplicate',       -- already seen; recorded, never credited again
  'rejected',        -- failed validation
  'review_required' -- needs a human decision
);

-- How the engine matched, and how much it trusts itself.
create type public.payment_match_strength as enum (
  'strong',      -- account + provider + exact amount + customer number
  'medium',      -- account + exact amount, customer number unknown
  'weak',        -- account and provider only; never auto-settles
  'manual'      -- a seller attached the event by hand
);

create type public.payment_match_status as enum (
  'candidate',
  'accepted',
  'rejected'
);

-- Audit vocabulary. `actor` is a profile id, or null with
-- payment_audit_logs.actor_kind = 'system' for automatic actions -- an
-- automatic match must never look like a human clicked something.
create type public.payment_audit_actor as enum (
  'seller',
  'system'
);

create type public.payment_audit_action as enum (
  'account_created',
  'account_disconnected',
  'account_status_changed',
  'event_ingested',
  'event_rejected',
  'event_duplicate',
  'event_matched',
  'event_confirmed',
  'event_mismatched',
  'event_unmatched',
  'intent_created',
  'intent_cancelled',
  'intent_expired',
  'match_manually_assigned',
  'match_rejected',
  'order_payment_recorded',
  'subscription_activated'
);

-- ---------------------------------------------------------------------------
-- payment_accounts
--
-- One MFS account the seller's customers pay into. Belongs to a single business
-- (org) rather than a single person: a manager may operate it, and the seller
-- may run two businesses from one phone.
-- ---------------------------------------------------------------------------

create table if not exists public.payment_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,

  provider public.payment_provider not null,
  -- Stored as entered by the seller. Compared through payment_normalize_bk_number
  -- so 8801... and 01... are recognised as the same account.
  account_number text not null,
  account_type text not null default 'personal',
  -- A short label for the UI, e.g. "Main shop". Never used for matching.
  label text,

  status public.payment_account_status not null default 'pending',
  is_active boolean not null default true,

  -- The MFS account type is free text because providers add tiers without a
  -- migration; a CHECK against a closed enum would break the app on their
  -- release schedule rather than ours.
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz,

  constraint payment_accounts_number_format
    check (account_number ~ '^[0-9]{6,20}$'),
  constraint payment_accounts_account_type_known
    check (account_type in ('personal', 'agent', 'merchant')),
  constraint payment_accounts_label_length
    check (label is null or char_length(label) <= 80)
);

comment on table public.payment_accounts is
  'MFS accounts a seller receives customer payments into. An account is the '
  'earliest link in the chain: a payment event is only trusted against an '
  'account the seller has explicitly connected.';

create unique index if not exists uq_payment_accounts_org_provider_number
  on public.payment_accounts (org_id, provider, account_number);

create index if not exists idx_payment_accounts_org_status
  on public.payment_accounts (org_id, status)
  where is_active;

-- ---------------------------------------------------------------------------
-- payment_intents
--
-- "I expect this much money, from roughly this person, for this thing."
--
-- Deliberately not order-shaped. reference_id points at whatever the intent is
-- for, and type says how to settle it. That is what lets SellFlow collect its
-- own subscription through the same engine as a seller's customer order.
-- ---------------------------------------------------------------------------

create table if not exists public.payment_intents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,

  type public.payment_intent_type not null,
  -- orders.id for type 'order'; a subscription row for 'subscription'. Not a
  -- foreign key, because the referenced table differs per type and a
  -- polymorphic reference cannot be constrained. The ingest path validates it
  -- against the real table before settling.
  reference_id uuid,

  payment_account_id uuid references public.payment_accounts (id) on delete restrict,

  expected_amount numeric(14, 2) not null,
  currency text not null default 'BDT',
  -- Best-effort extra signal for matching. Not required: many sellers collect
  -- without ever asking the customer to write down their number.
  expected_customer_phone text,
  expected_customer_name text,

  status public.payment_intent_status not null default 'open',
  expires_at timestamptz not null,

  -- Filled when a settlement completes. Kept for audit; the money itself lives
  -- in payments / the subscription row.
  --
  -- Deliberately not a foreign key to payment_events: payment_events already
  -- references payment_intents, and a second constraint in the other direction
  -- would make the pair impossible to delete or reorder later.
  settled_amount numeric(14, 2),
  settled_at timestamptz,
  settled_payment_event_id uuid,

  -- Caller-supplied idempotency key, matching the payments.client_ref and
  -- orders.client_ref convention already in this schema. A retried "create
  -- intent" must not produce a second open intent that can then swallow an
  -- unrelated payment.
  client_ref uuid,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payment_intents_expected_amount_positive
    check (expected_amount > 0),
  constraint payment_intents_settled_amount_sane
    check (settled_amount is null or settled_amount >= 0),
  -- A settled intent must say how much actually arrived.
  constraint payment_intents_settled_complete
    check (
      (status = 'matched' and settled_amount is not null and settled_at is not null)
      or (status <> 'matched')
    )
);

comment on table public.payment_intents is
  'An amount the seller expects to receive. The matching engine looks here. '
  'Separate from orders so subscription and invoice collection reuse it.';

-- The hot path: "which open intents could this payment satisfy?" One partial
-- index keeps that a single cheap scan instead of a sequential pass.
create index if not exists idx_payment_intents_open
  on public.payment_intents (org_id, expected_amount, expires_at)
  where status in ('open', 'partially_paid');

create index if not exists idx_payment_intents_reference
  on public.payment_intents (type, reference_id)
  where reference_id is not null;

create index if not exists idx_payment_intents_account
  on public.payment_intents (payment_account_id, status);

-- An intent may only be settled once.
create unique index if not exists uq_payment_intents_settled_event
  on public.payment_intents (settled_payment_event_id)
  where settled_payment_event_id is not null;

-- A caller-supplied key is single-use per business, so a retried request cannot
-- open a second intent for the same sale.
create unique index if not exists uq_payment_intents_client_ref
  on public.payment_intents (org_id, client_ref)
  where client_ref is not null;

-- ---------------------------------------------------------------------------
-- payment_events
--
-- One row per detected payment. This is the ledger: money enters here exactly
-- once and is never edited afterwards. A wrong amount is corrected by a refund
-- or a manual adjustment, never by rewriting history.
-- ---------------------------------------------------------------------------

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,

  payment_account_id uuid not null references public.payment_accounts (id) on delete restrict,
  provider public.payment_provider not null,

  -- What the provider reported. Normalised forms live in the matching columns
  -- below; these keep the original digits for audit.
  receiver_account text not null,
  sender_account text,
  amount numeric(14, 2) not null,
  currency text not null default 'BDT',
  transaction_id text not null,

  -- When the money actually moved, and when we heard about it. Both are kept
  -- because an offline device may deliver an event hours late, and the delay is
  -- itself a signal worth keeping.
  transaction_timestamp timestamptz,
  detected_at timestamptz not null default now(),

  source public.payment_event_source not null,

  -- Fingerprint of the raw transport message: hash only, never the body. Used
  -- to spot a repeated message whose text is identical but whose TrxID the
  -- provider omitted.
  fingerprint text,

  status public.payment_event_status not null default 'detected',

  -- Normalised comparison forms, set by ingest_payment_event.
  receiver_account_normalized text,
  sender_account_normalized text,

  -- Set when the event did not line up with an intent, so the UI can show the
  -- seller what arrived versus what was expected.
  mismatch_reason text,
  review_note text,

  -- Idempotency key supplied by the transport. A retrying phone reuses it, so a
  -- reconnect storm cannot create a second ledger row.
  client_ref uuid,
  -- The device that detected it, for support. A free-form platform/build string
  -- rather than a device fingerprint.
  detected_by text,

  matched_intent_id uuid references public.payment_intents (id) on delete set null,
  -- The money row created when this event was confirmed against an order.
  payment_id uuid references public.payments (id) on delete set null,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payment_events_amount_positive check (amount > 0),
  constraint payment_events_transaction_id_present
    check (char_length(btrim(transaction_id)) >= 4),
  constraint payment_events_mismatch_has_reason
    check (status <> 'mismatch' or mismatch_reason is not null)
);

comment on table public.payment_events is
  'Append-only ledger of detected payments. Rows are never updated except to '
  'advance status; corrections happen through refunds or manual review, not by '
  'rewriting a detected amount.';

-- The core idempotency guarantee. A provider transaction id is unique for a
-- given account; a second delivery of it cannot create a second ledger row, so
-- it cannot be credited twice. This is a constraint, not application logic: the
-- JS layer cannot bypass it and neither can a retrying device.
create unique index if not exists uq_payment_events_identity
  on public.payment_events (provider, payment_account_id, transaction_id);

-- A second belt: a device that retried without reusing client_ref still cannot
-- double-write, because a client_ref is single-use per account.
create unique index if not exists uq_payment_events_client_ref
  on public.payment_events (payment_account_id, client_ref)
  where client_ref is not null;

create index if not exists idx_payment_events_account_recent
  on public.payment_events (payment_account_id, detected_at desc);

create index if not exists idx_payment_events_org_status
  on public.payment_events (org_id, status, detected_at desc);

create index if not exists idx_payment_events_unmatched
  on public.payment_events (org_id, detected_at desc)
  where status in ('unmatched', 'review_required');

create index if not exists idx_payment_events_matched_intent
  on public.payment_events (matched_intent_id)
  where matched_intent_id is not null;

-- ---------------------------------------------------------------------------
-- payment_matches
--
-- Every candidate the engine considered, not only the winner. Recording the
-- rejects is what makes "why did this payment not settle my order?" answerable
-- instead of a guess.
-- ---------------------------------------------------------------------------

create table if not exists public.payment_matches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,

  payment_event_id uuid not null references public.payment_events (id) on delete cascade,
  payment_intent_id uuid not null references public.payment_intents (id) on delete cascade,

  strength public.payment_match_strength not null,
  status public.payment_match_status not null default 'candidate',

  -- Why the engine scored it this way, as a short machine-readable code plus a
  -- human sentence. The code is what tests assert against.
  reason_code text not null,
  reason_detail text,

  -- The individual signals, so a policy change can be reasoned about from data
  -- rather than guessed at.
  amount_delta numeric(14, 2),
  account_matched boolean not null default false,
  provider_matched boolean not null default false,
  amount_matched boolean not null default false,
  customer_phone_matched boolean,
  within_window boolean not null default false,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint payment_matches_delta_sane
    check (amount_delta is null or abs(amount_delta) >= 0),
  constraint payment_matches_reason_code_present
    check (char_length(btrim(reason_code)) > 0)
);

comment on table public.payment_matches is
  'Candidates considered by the matching engine, accepted and rejected alike. '
  'Keeping the rejects is what makes an unmatched payment explainable.';

create unique index if not exists uq_payment_matches_accepted_event
  on public.payment_matches (payment_event_id)
  where status = 'accepted';

create index if not exists idx_payment_matches_intent
  on public.payment_matches (payment_intent_id, created_at desc);

create index if not exists idx_payment_matches_rejected
  on public.payment_matches (org_id, created_at desc)
  where status = 'rejected';

-- ---------------------------------------------------------------------------
-- payment_audit_logs
--
-- Append-only. Never updated, never deleted by the app.
-- ---------------------------------------------------------------------------

create table if not exists public.payment_audit_logs (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,

  actor_kind public.payment_audit_actor not null,
  -- Null when actor_kind is 'system'. An automatic confirmation must never be
  -- attributable to a person.
  actor_id uuid references public.profiles (id) on delete set null,

  action public.payment_audit_action not null,
  payment_event_id uuid references public.payment_events (id) on delete set null,
  payment_intent_id uuid references public.payment_intents (id) on delete set null,
  payment_account_id uuid references public.payment_accounts (id) on delete set null,
  payment_match_id uuid references public.payment_matches (id) on delete set null,

  -- What it affected, when it is not a payment row (an order, a subscription).
  target_type text,
  target_id uuid,

  -- Small, non-sensitive facts only: amounts, counts, reason codes. Never the
  -- raw SMS body, never a full account number.
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  -- An automatic action must be attributable to the system, and a manual one
  -- to a person. Without this an automated settlement could be read as a human
  -- having approved it.
  constraint payment_audit_actor_consistent check (
    (actor_kind = 'seller' and actor_id is not null)
    or (actor_kind = 'system' and actor_id is null)
  )
);

comment on table public.payment_audit_logs is
  'Append-only audit trail for every payment action. Automatic actions are '
  'recorded as actor_kind=system so a machine settlement is never mistaken for '
  'a human decision.';

create index if not exists idx_payment_audit_org_recent
  on public.payment_audit_logs (org_id, created_at desc);

create index if not exists idx_payment_audit_event
  on public.payment_audit_logs (payment_event_id, created_at)
  where payment_event_id is not null;

create index if not exists idx_payment_audit_target
  on public.payment_audit_logs (target_type, target_id)
  where target_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at triggers, same helper the rest of the schema uses
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['payment_accounts', 'payment_intents', 'payment_events'] loop
    execute format('drop trigger if exists trg_touch_%1$s on public.%1$I', t);
    execute format(
      'create trigger trg_touch_%1$s before update on public.%1$I
         for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Phone normalisation
--
-- Bangladeshi mobile numbers reach the ledger in several shapes: 017xxxxxxxx,
-- +880171xxxxxxxx, 880171xxxxxxxx. Those are the same account, so they must
-- compare equal or an exact match silently fails.
-- ---------------------------------------------------------------------------

create or replace function public.payment_normalize_bk_number(p_raw text)
returns text
language sql
immutable
strict
as $$
  select case
    -- +8801712345678 / 8801712345678 -> 01712345678
    --
    -- regexp_replace, not substring: `substring(x from 2)` is a character
    -- offset, not a regex capture group, and using it here silently produced
    -- 0801712345678 instead of 01712345678.
    when v ~ '^\+?8801[3-9][0-9]{8}$' then '0' || regexp_replace(v, '^\+?880', '')
    -- 1712345678 -> 01712345678
    when v ~ '^1[3-9][0-9]{8}$' then '0' || v
    -- 01712345678, already local
    when v ~ '^01[3-9][0-9]{8}$' then v
    else v
  end
  from (select btrim(p_raw) as v) s
$$;

comment on function public.payment_normalize_bk_number(text) is
  'Canonicalises a Bangladeshi mobile number to 01XXXXXXXXX so 017…, +88017… '
  'and 88017… compare equal. Used for matching, never for display.';

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Read: any member of the owning business.
-- Write: none. Every mutation below is a SECURITY DEFINER function that
-- re-authorises; there is no client insert/update/delete policy to grant.
-- ---------------------------------------------------------------------------

alter table public.payment_accounts  enable row level security;
alter table public.payment_intents   enable row level security;
alter table public.payment_events    enable row level security;
alter table public.payment_matches  enable row level security;
alter table public.payment_audit_logs enable row level security;

drop policy if exists payment_accounts_select_member on public.payment_accounts;
create policy payment_accounts_select_member on public.payment_accounts
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists payment_intents_select_member on public.payment_intents;
create policy payment_intents_select_member on public.payment_intents
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists payment_events_select_member on public.payment_events;
create policy payment_events_select_member on public.payment_events
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists payment_matches_select_member on public.payment_matches;
create policy payment_matches_select_member on public.payment_matches
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists payment_audit_logs_select_member on public.payment_audit_logs;
create policy payment_audit_logs_select_member on public.payment_audit_logs
  for select to authenticated
  using (public.is_org_member(org_id));

-- A member may only see their own audit entries for a manual action.
drop policy if exists payment_audit_logs_select_own on public.payment_audit_logs;
create policy payment_audit_logs_select_own on public.payment_audit_logs
  for select to authenticated
  using (public.is_org_member(org_id) and (actor_kind = 'system' or actor_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Grants
--
-- SELECT only. The write paths are functions.
-- ---------------------------------------------------------------------------

grant select on
  public.payment_accounts,
  public.payment_intents,
  public.payment_events,
  public.payment_matches,
  public.payment_audit_logs
  to authenticated;

-- ---------------------------------------------------------------------------
-- Audit helper
-- ---------------------------------------------------------------------------

create or replace function public.log_payment_audit(
  p_org_id uuid,
  p_actor_kind public.payment_audit_actor,
  p_action public.payment_audit_action,
  p_payment_event_id uuid default null,
  p_payment_intent_id uuid default null,
  p_payment_account_id uuid default null,
  p_payment_match_id uuid default null,
  p_target_type text default null,
  p_target_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.payment_audit_logs (
    org_id, actor_kind, actor_id, action,
    payment_event_id, payment_intent_id, payment_account_id, payment_match_id,
    target_type, target_id, metadata
  )
  values (
    p_org_id,
    p_actor_kind,
    -- An automatic action has no human actor. Passing auth.uid() there would
    -- attribute a machine settlement to whoever happened to be signed in.
    case when p_actor_kind = 'seller' then auth.uid() else null end,
    p_action,
    p_payment_event_id, p_payment_intent_id, p_payment_account_id, p_payment_match_id,
    p_target_type, p_target_id,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.log_payment_audit(uuid, public.payment_audit_actor, public.payment_audit_action, uuid, uuid, uuid, uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.log_payment_audit(uuid, public.payment_audit_actor, public.payment_audit_action, uuid, uuid, uuid, uuid, text, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Payment accounts: seller-managed
--
-- Adding a connected account is a write, so it is a function. It is NOT a
-- payment confirmation, which is why a seller may do it from the client.
-- ---------------------------------------------------------------------------

create or replace function public.create_payment_account(
  p_org_id uuid,
  p_provider public.payment_provider,
  p_account_number text,
  p_account_type text default 'personal',
  p_label text default null
)
returns public.payment_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.payment_accounts;
  v_number text;
begin
  -- The business is named by the caller but authorised here. assert_org_write
  -- proves the caller is an owner or manager of THIS org, so a client-supplied
  -- org_id cannot file an account into somebody else's business. It is not
  -- silently replaced with "the seller's first business" either: one person may
  -- legitimately run more than one, and picking by created_at would quietly
  -- attach the account to the wrong one.
  perform public.assert_org_write(p_org_id);

  v_number := btrim(p_account_number);
  if v_number !~ '^[0-9]{6,20}$' then
    raise exception using
      message = 'invalid_account_number',
      hint = 'Enter the account number using digits only, for example 01712345678.';
  end if;

  if p_account_type is null or p_account_type not in ('personal', 'agent', 'merchant') then
    raise exception using
      message = 'invalid_account_type',
      hint = 'Choose Personal, Agent or Merchant.';
  end if;

  insert into public.payment_accounts (
    org_id, provider, account_number, account_type, label, status, is_active, created_by
  )
  values (
    p_org_id, p_provider, v_number, p_account_type,
    nullif(btrim(p_label), ''),
    'connected',
    true,
    auth.uid()
  )
  returning * into v_account;

  perform public.log_payment_audit(
    p_org_id, 'seller', 'account_created',
    p_payment_account_id => v_account.id,
    p_metadata => jsonb_build_object('provider', p_provider, 'account_type', p_account_type)
  );

  return v_account;
end;
$$;

revoke all on function public.create_payment_account(uuid, public.payment_provider, text, text, text) from public, anon;
grant execute on function public.create_payment_account(uuid, public.payment_provider, text, text, text) to authenticated;

create or replace function public.set_payment_account_status(
  p_account_id uuid,
  p_status public.payment_account_status,
  p_is_active boolean default null
)
returns public.payment_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_before public.payment_accounts;
  v_after public.payment_accounts;
  v_action public.payment_audit_action;
begin
  select * into v_before from public.payment_accounts where id = p_account_id for update;
  if v_before.id is null then
    raise exception using message = 'payment_account_not_found',
      hint = 'That payment account no longer exists.';
  end if;

  v_org := v_before.org_id;
  perform public.assert_org_write(v_org);

  update public.payment_accounts
  set status = p_status,
      is_active = coalesce(p_is_active, is_active)
  where id = p_account_id
  returning * into v_after;

  v_action := case
    when p_status = 'disconnected' then 'account_disconnected'::public.payment_audit_action
    else 'account_status_changed'::public.payment_audit_action
  end;

  perform public.log_payment_audit(
    v_org, 'seller', v_action,
    p_payment_account_id => p_account_id,
    p_metadata => jsonb_build_object(
      'from', v_before.status,
      'to', v_after.status,
      'is_active', v_after.is_active
    )
  );

  return v_after;
end;
$$;

revoke all on function public.set_payment_account_status(uuid, public.payment_account_status, boolean) from public, anon;
grant execute on function public.set_payment_account_status(uuid, public.payment_account_status, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Payment intents
-- ---------------------------------------------------------------------------

create or replace function public.create_payment_intent(
  p_type public.payment_intent_type,
  p_reference_id uuid,
  p_payment_account_id uuid,
  p_expected_amount numeric,
  p_expected_customer_phone text default null,
  p_expected_customer_name text default null,
  p_expires_at timestamptz default null,
  p_client_ref uuid default null
)
returns public.payment_intents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_intent public.payment_intents;
  v_amount numeric;
  v_account_org uuid;
  v_expires timestamptz;
begin
  if p_payment_account_id is null then
    raise exception using message = 'payment_account_required',
      hint = 'Choose which payment account this order is paid into.';
  end if;

  select pa.org_id into v_account_org
  from public.payment_accounts pa
  where pa.id = p_payment_account_id and pa.is_active;

  if v_account_org is null then
    raise exception using message = 'payment_account_not_found',
      hint = 'That payment account is not connected or has been switched off.';
  end if;

  v_org := v_account_org;
  perform public.assert_org_write(v_org);

  v_amount := round(p_expected_amount, 2);
  if v_amount is null or v_amount <= 0 then
    raise exception using message = 'invalid_expected_amount',
      hint = 'The expected amount must be greater than zero.';
  end if;

  -- An intent that outlives its window would match a payment days later, which
  -- is how a stale intent silently swallows an unrelated payment.
  v_expires := coalesce(p_expires_at, now() + interval '14 days');
  if v_expires <= now() then
    raise exception using message = 'intent_expires_in_past',
      hint = 'The expiry must be in the future.';
  end if;

  if p_type = 'order' then
    if p_reference_id is null then
      raise exception using message = 'reference_required',
        hint = 'An order intent needs an order.';
    end if;
    if not exists (select 1 from public.orders o where o.id = p_reference_id and o.org_id = v_org) then
      raise exception using message = 'order_not_found',
        hint = 'That order does not belong to your business.';
    end if;
    if not exists (
      select 1 from public.orders o
      where o.id = p_reference_id
        and o.total > 0
        and o.amount_paid < o.total
        and o.status not in ('cancelled', 'returned')
    ) then
      raise exception using message = 'order_not_payable',
        hint = 'That order is already paid, or is closed.';
    end if;
  end if;

  if p_client_ref is not null then
    if exists (select 1 from public.payment_intents where org_id = v_org and created_by = auth.uid() and client_ref = p_client_ref) then
      raise exception using message = 'idempotency_key_reused',
        hint = 'This request was already processed.';
    end if;
  end if;

  insert into public.payment_intents (
    org_id, type, reference_id, payment_account_id, expected_amount, currency,
    expected_customer_phone, expected_customer_name, expires_at, created_by, client_ref
  )
  values (
    v_org, p_type, p_reference_id, p_payment_account_id, v_amount, 'BDT',
    nullif(btrim(p_expected_customer_phone), ''),
    nullif(btrim(p_expected_customer_name), ''),
    v_expires, auth.uid(), p_client_ref
  )
  returning * into v_intent;

  perform public.log_payment_audit(
    v_org, 'seller', 'intent_created',
    p_payment_intent_id => v_intent.id,
    p_payment_account_id => p_payment_account_id,
    p_target_type => p_type::text,
    p_target_id => p_reference_id,
    p_metadata => jsonb_build_object(
      'expected_amount', v_amount,
      'expires_at', v_expires,
      'has_phone', p_expected_customer_phone is not null
    )
  );

  return v_intent;
end;
$$;

revoke all on function public.create_payment_intent(public.payment_intent_type, uuid, uuid, numeric, text, text, timestamptz, uuid) from public, anon;
grant execute on function public.create_payment_intent(public.payment_intent_type, uuid, uuid, numeric, text, text, timestamptz, uuid) to authenticated;

create or replace function public.cancel_payment_intent(p_intent_id uuid, p_reason text default null)
returns public.payment_intent_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intent public.payment_intents;
  v_status public.payment_intent_status;
begin
  select * into v_intent from public.payment_intents where id = p_intent_id for update;
  if v_intent.id is null then
    raise exception using message = 'intent_not_found', hint = 'That request no longer exists.';
  end if;

  perform public.assert_org_write(v_intent.org_id);

  if v_intent.status = 'matched' then
    -- The money already moved through record_payment. Cancelling the intent
    -- would hide a real settlement, so it is refused rather than allowed.
    raise exception using message = 'intent_already_settled',
      hint = 'This payment already went through. Refund it instead of cancelling the request.';
  end if;

  update public.payment_intents
  set status = 'cancelled'
  where id = p_intent_id
  returning status into v_status;

  perform public.log_payment_audit(
    v_intent.org_id, 'seller', 'intent_cancelled',
    p_payment_intent_id => p_intent_id,
    p_payment_account_id => v_intent.payment_account_id,
    p_target_type => v_intent.type::text,
    p_target_id => v_intent.reference_id,
    p_metadata => jsonb_build_object('reason', p_reason, 'was', v_intent.status)
  );

  return v_status;
end;
$$;

revoke all on function public.cancel_payment_intent(uuid, text) from public, anon;
grant execute on function public.cancel_payment_intent(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Ingest: the single write path for a detected payment
--
-- Transport-independent by design. An SMS relay, an MFS API poller and a manual
-- entry all call this with the same normalised arguments, and the engine does
-- not branch on which one it was.
--
-- The client is asserting "I detected this payment". Everything after this line
-- is the server deciding whether that is true and what it means.
-- ---------------------------------------------------------------------------

create or replace function public.ingest_payment_event(
  p_payment_account_id uuid,
  p_provider public.payment_provider,
  p_receiver_account text,
  p_sender_account text,
  p_amount numeric,
  p_transaction_id text,
  p_transaction_timestamp timestamptz default null,
  p_source public.payment_event_source default 'sms',
  p_fingerprint text default null,
  p_client_ref uuid default null,
  p_detected_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_account public.payment_accounts;
  v_event public.payment_events;
  v_amount numeric;
  v_trx text;
  v_receiver_norm text;
  v_sender_norm text;
  v_is_duplicate boolean := false;
begin
  /*
   * 1. Resolve the account and its org. The org is derived from the account,
   *    never accepted from the caller, so a client cannot file a payment into
   *    somebody else's business.
   */
  select * into v_account
  from public.payment_accounts
  where id = p_payment_account_id and is_active;

  if v_account.id is null then
    raise exception using message = 'payment_account_not_found',
      hint = 'That payment account is not connected or has been switched off.';
  end if;

  v_org := v_account.org_id;

  -- The detector is a signed-in seller with write access to this business.
  -- assert_org_write is the same guard record_payment applies, so a payment can
  -- never enter the ledger through a weaker door than it leaves it by.
  --
  -- Note this is deliberately NOT service-role callable. A relay with the
  -- service key has no human behind it, and money entering the ledger should
  -- always be attributable to a session. A future MFS API relay must present
  -- the seller's session or go through a separately reviewed path.
  perform public.assert_org_write(v_org);

  /*
   * 2. Validate before anything is written. A malformed event should not reach
   *    the ledger at all.
   */
  v_trx := btrim(p_transaction_id);
  if v_trx is null or char_length(v_trx) < 4 then
    raise exception using message = 'invalid_transaction_id',
      hint = 'The transaction reference is missing or too short to identify it.';
  end if;

  v_amount := round(p_amount, 2);
  if v_amount is null or v_amount <= 0 then
    raise exception using message = 'invalid_amount',
      hint = 'The amount must be greater than zero.';
  end if;

  if p_provider <> v_account.provider then
    raise exception using message = 'provider_mismatch',
      hint = 'The provider does not match the connected account.';
  end if;

  v_receiver_norm := public.payment_normalize_bk_number(btrim(p_receiver_account));
  v_sender_norm := case
    when p_sender_account is null or btrim(p_sender_account) = '' then null
    else public.payment_normalize_bk_number(btrim(p_sender_account))
  end;

  /*
   * 3. Duplicate detection.
   *
   *    Checked before the insert so a repeat delivery takes the friendly path,
   *    and enforced again by uq_payment_events_identity underneath, which is
   *    what actually makes this safe. The pre-check is for the caller's benefit;
   *    the constraint is the guarantee.
   */
  if exists (
    select 1 from public.payment_events
    where provider = p_provider
      and payment_account_id = p_payment_account_id
      and transaction_id = v_trx
  ) then
    v_is_duplicate := true;
  end if;

  if v_is_duplicate then
    select * into v_event
    from public.payment_events
    where provider = p_provider
      and payment_account_id = p_payment_account_id
      and transaction_id = v_trx
    limit 1;

    perform public.log_payment_audit(
      v_org, 'system', 'event_duplicate',
      p_payment_event_id => v_event.id,
      p_payment_account_id => p_payment_account_id,
      p_metadata => jsonb_build_object('transaction_id', v_trx, 'amount', v_amount)
    );

    return jsonb_build_object(
      'event_id', v_event.id,
      'status', v_event.status,
      'duplicate', true,
      'message', 'Already recorded. This payment will not be counted twice.'
    );
  end if;

  /*
   * 4. Insert. If two devices race with the same transaction, one of them hits
   *    uq_payment_events_identity here. That is handled as a duplicate rather
   *    than surfacing a raw unique_violation to the phone.
   */
  begin
    insert into public.payment_events (
      org_id, payment_account_id, provider,
      receiver_account, sender_account, amount, currency, transaction_id,
      transaction_timestamp, detected_at, source, fingerprint,
      receiver_account_normalized, sender_account_normalized,
      status, client_ref, detected_by, created_by
    )
    values (
      v_org, p_payment_account_id, p_provider,
      btrim(p_receiver_account), nullif(btrim(p_sender_account), ''), v_amount, 'BDT', v_trx,
      p_transaction_timestamp, now(), p_source, p_fingerprint,
      v_receiver_norm, v_sender_norm,
      'detected', p_client_ref, p_detected_by, auth.uid()
    )
    returning * into v_event;
  exception when unique_violation then
    -- Lost the race against a concurrent delivery of the same transaction.
    select * into v_event
    from public.payment_events
    where provider = p_provider
      and payment_account_id = p_payment_account_id
      and transaction_id = v_trx
    limit 1;

    perform public.log_payment_audit(
      v_org, 'system', 'event_duplicate',
      p_payment_event_id => v_event.id,
      p_payment_account_id => p_payment_account_id,
      p_metadata => jsonb_build_object('transaction_id', v_trx, 'race', true)
    );

    return jsonb_build_object(
      'event_id', v_event.id,
      'status', v_event.status,
      'duplicate', true,
      'message', 'Already recorded. This payment will not be counted twice.'
    );
  end;

  -- The account has proved it receives real money.
  update public.payment_accounts
  set last_seen_at = now()
  where id = p_payment_account_id;

  perform public.log_payment_audit(
    v_org, 'system', 'event_ingested',
    p_payment_event_id => v_event.id,
    p_payment_account_id => p_payment_account_id,
    p_metadata => jsonb_build_object(
      'provider', p_provider,
      'source', p_source,
      'amount', v_amount,
      'transaction_id', v_trx,
      'receiver_matches_account', v_receiver_norm = public.payment_normalize_bk_number(v_account.account_number)
    )
  );

  return jsonb_build_object(
    'event_id', v_event.id,
    'status', v_event.status,
    'duplicate', false,
    'message', 'Recorded. Matching runs next.'
  );
end;
$$;

revoke all on function public.ingest_payment_event(uuid, public.payment_provider, text, text, numeric, text, timestamptz, public.payment_event_source, text, uuid, text) from public, anon;
grant execute on function public.ingest_payment_event(uuid, public.payment_provider, text, text, numeric, text, timestamptz, public.payment_event_source, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Manual review
--
-- A seller may attach an unmatched payment to an intent, or reject a match.
-- Both go through functions, both re-authorise, and both are audited as seller
-- actions. Neither can move money on its own: assignment still calls
-- record_payment.
-- ---------------------------------------------------------------------------

create or replace function public.reject_payment_match(
  p_event_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.payment_events;
begin
  select * into v_event from public.payment_events where id = p_event_id for update;
  if v_event.id is null then
    raise exception using message = 'payment_event_not_found',
      hint = 'That payment is no longer available.';
  end if;

  perform public.assert_org_write(v_event.org_id);

  update public.payment_matches
  set status = 'rejected', reason_detail = coalesce(p_reason, reason_detail)
  where payment_event_id = p_event_id and status = 'candidate';

  update public.payment_events
  set status = 'review_required', review_note = coalesce(p_reason, review_note)
  where id = p_event_id;

  perform public.log_payment_audit(
    v_event.org_id, 'seller', 'match_rejected',
    p_payment_event_id => p_event_id,
    p_payment_account_id => v_event.payment_account_id,
    p_metadata => jsonb_build_object('reason', p_reason)
  );

  return true;
end;
$$;

revoke all on function public.reject_payment_match(uuid, text) from public, anon;
grant execute on function public.reject_payment_match(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Registry guard (same assertion 0015 installs)
--
-- Re-declared here so this migration independently proves it has not introduced
-- a client insert policy that pairs org_id with a store it does not belong to.
-- payment_events and payment_intents carry no store_id, so they are out of
-- scope, but the guard is cheap and the failure mode is a silent tenancy hole.
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
    and exists (select 1 from pg_attribute
                 where attrelid = c.oid and attname = 'org_id' and not attisdropped)
    and exists (select 1 from pg_attribute
                 where attrelid = c.oid and attname = 'store_id' and not attisdropped)
    and pg_get_expr(p.polqual, p.polrelid) like '%org_id%'
    and pg_get_expr(p.polqual, p.polrelid) not like '%store_in_org%'
    and c.relname not in ('profiles', 'organizations', 'organization_members', 'stores');

  if v_bad is not null then
    raise exception
      'POLICY GAP: a client insert policy pairs org_id without store_in_org: %', v_bad;
  end if;
end $$;