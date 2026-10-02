-- ===========================================================================
-- SellFlow :: 0012 -- payment and refund idempotency
--
-- Defect found by the adversarial probe (supabase/test/verify_adversarial.sql,
-- PROBE 1). Reproduced exactly:
--
--   order total 500, seller records a 100 payment
--   the response is lost (timeout / dropped connection)
--   the app retries the identical request
--   -> amount_paid becomes 200 and two payment rows exist
--
-- The customer is charged twice. The existing `overpayment` guard does not
-- help: it only rejects an amount larger than what is outstanding, so two
-- PARTIAL payments both look legitimate.
--
-- This is the same class of bug that `orders.client_ref` already solves for
-- order creation and `shipments.idempotency_key` already solves for dispatch.
-- Payment and refund were the two financial writes still missing the pattern.
--
-- Additive only. Nothing in 0001-0011 is modified, so every previously
-- verified guarantee is preserved.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Idempotency key on the money movements
--
-- NULL for any row written before this migration, and NULL for a row inserted
-- by server code that has no caller-side key. The partial unique index means
-- those are all allowed; only an actual duplicate key is rejected.
-- ---------------------------------------------------------------------------

alter table public.payments
  add column if not exists client_ref uuid;

comment on column public.payments.client_ref is
  'Caller-supplied idempotency key. A retry with the same key returns the original result instead of recording the money twice. NULL for rows written without a key.';

create unique index if not exists uq_payments_client_ref
  on public.payments (order_id, client_ref)
  where client_ref is not null;

-- ---------------------------------------------------------------------------
-- record_payment
--
-- Replaces the 0005 version with an extra optional argument. Callers that pass
-- named arguments are unaffected; callers passing none are simply as safe as
-- they were before.
--
-- Replay contract, matching register_shipment:
--   * same key, already recorded  -> return the current amount_paid, unchanged
--   * different key, valid amount -> record it, as before
-- ---------------------------------------------------------------------------

drop function if exists public.record_payment(uuid, numeric, public.payment_method, timestamptz, text);

create or replace function public.record_payment(
  p_order_id       uuid,
  p_amount         numeric,
  p_method         public.payment_method default 'cash',
  p_paid_at        timestamptz default null,
  p_note           text default null,
  p_idempotency_key uuid default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid;
  v_store  uuid;
  v_total  numeric(14,2);
  v_paid   numeric(14,2);
  v_outstanding numeric(14,2);
  v_order_status public.order_status;
  v_status public.payment_status;
begin
  select public.assert_store_access(o.store_id), o.org_id, o.store_id,
         o.total, o.amount_paid, o.status, o.payment_status
    into v_org, v_org, v_store, v_total, v_paid, v_order_status, v_status
  from public.orders o
  where o.id = p_order_id;

  if v_total is null then
    raise exception 'order_not_found' using hint = 'That order no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  -- Already recorded. Replaying the SAME request is a success, not an error.
  if p_idempotency_key is not null
     and exists (
       select 1 from public.payments
       where order_id = p_order_id and client_ref = p_idempotency_key
     ) then
    -- A key identifies ONE payment. If the same key arrives carrying a
    -- different amount or method, this is not a retry, it is a caller bug or a
    -- genuine second payment that was given the wrong key.
    --
    -- Returning the old total would be worse than failing: the caller would
    -- believe the new amount was collected when it was not. The original
    -- payment is left completely untouched.
    if exists (
      select 1 from public.payments
      where order_id = p_order_id
        and client_ref = p_idempotency_key
        and (amount is distinct from p_amount or method is distinct from p_method)
    ) then
      raise exception 'idempotency_key_reused'
        using hint = 'This payment key was already used for a different amount. Use a new key for a new payment.';
    end if;

    return v_paid;
  end if;

  if v_order_status in ('cancelled', 'returned') then
    raise exception 'order_closed'
      using hint = 'This order is ' || v_order_status::text || '. Record a refund instead.';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_payment' using hint = 'Enter an amount greater than zero.';
  end if;

  v_outstanding := v_total - v_paid;

  if p_amount > v_outstanding then
    raise exception 'overpayment'
      using hint = 'Only ' || v_outstanding::text || ' is outstanding on this order.';
  end if;

  insert into public.payments (
    org_id, store_id, order_id, amount, method, is_refund, client_ref,
    paid_at, note, created_by
  ) values (
    v_org, v_store, p_order_id, p_amount, p_method, false, p_idempotency_key,
    coalesce(p_paid_at, now()), p_note, auth.uid()
  );

  v_paid := v_paid + p_amount;
  v_status := case when v_paid >= v_total then 'paid'::public.payment_status
                   else 'partial'::public.payment_status end;

  update public.orders set amount_paid = v_paid, payment_status = v_status, updated_at = now()
   where id = p_order_id;

  return v_paid;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_refund
--
-- Money leaving the seller, with the same defect. A retried refund would
-- otherwise mark the order refunded twice and overstate how much went back.
-- ---------------------------------------------------------------------------

drop function if exists public.record_refund(uuid, numeric, public.payment_method, text);

create or replace function public.record_refund(
  p_order_id       uuid,
  p_amount         numeric,
  p_method         public.payment_method default 'cash',
  p_note           text default null,
  p_idempotency_key uuid default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org   uuid;
  v_store uuid;
  v_paid  numeric(14,2);
  v_refunded numeric(14,2);
begin
  select public.assert_store_access(o.store_id), o.org_id, o.store_id, o.amount_paid
    into v_org, v_org, v_store, v_paid
  from public.orders o
  where o.id = p_order_id;

  if v_paid is null then
    raise exception 'order_not_found' using hint = 'That order no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  if p_idempotency_key is not null
     and exists (
       select 1 from public.payments
       where order_id = p_order_id and client_ref = p_idempotency_key
     ) then
    -- Same rule as record_payment: one key means one refund, and a changed
    -- amount is a caller bug rather than a retry.
    if exists (
      select 1 from public.payments
      where order_id = p_order_id
        and client_ref = p_idempotency_key
        and (amount is distinct from p_amount or method is distinct from p_method)
    ) then
      raise exception 'idempotency_key_reused'
        using hint = 'This refund key was already used for a different amount. Use a new key for a new refund.';
    end if;

    return v_refunded;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_payment' using hint = 'Enter an amount greater than zero.';
  end if;

  select coalesce(sum(amount), 0) into v_refunded
  from public.payments
  where order_id = p_order_id and is_refund;

  if p_amount > v_paid - v_refunded then
    raise exception 'overpayment'
      using hint = 'Only ' || (v_paid - v_refunded)::text || ' can be refunded on this order.';
  end if;

  insert into public.payments (
    org_id, store_id, order_id, amount, method, is_refund, client_ref, note, created_by
  ) values (
    v_org, v_store, p_order_id, p_amount, p_method, true, p_idempotency_key, p_note, auth.uid()
  );

  update public.orders
     set payment_status = 'refunded', updated_at = now()
   where id = p_order_id
     and amount_paid - (select coalesce(sum(amount), 0) from public.payments
                        where order_id = p_order_id and is_refund) <= 0;

  return v_refunded + p_amount;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants.
--
-- The superseded five-argument signatures were removed by the DROP FUNCTION
-- statements above, and dropping a function takes its grants with it, so
-- there is nothing left to revoke. Only the new signatures need granting.
-- ---------------------------------------------------------------------------

grant execute on function
  public.record_payment(uuid, numeric, public.payment_method, timestamptz, text, uuid),
  public.record_refund(uuid, numeric, public.payment_method, text, uuid)
to authenticated;
