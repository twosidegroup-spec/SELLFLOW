-- 0026: a manual payment on a COD order must reduce what the courier still owes.
--
-- THE DEFECT, REPRODUCED ON A REAL DEVICE
--
-- Recorded a payment of 1,010 against an unsettled COD order of 1,010 through the app.
-- The result:
--
--   orders.amount_paid    = 1010     payment_status = 'paid'
--   orders.cod_amount     = 1010     cod_settled   = false
--   get_dashboard.cod.pending_settlement = 1010
--
-- So the same thousand taka was reported as MONEY RECEIVED TODAY and, at the same time,
-- as CASH ON DELIVERY -- OWED TO YOU, still with the courier. Each screen was honest in
-- isolation and the two contradicted each other. A seller reading both would be right
-- to distrust the app, and worse, would double-count the float in their head.
--
-- WHY IT HAPPENED
--
-- `record_payment` has only ever written `amount_paid` and `payment_status`. No
-- migration anywhere in this schema reduces `cod_amount` on a payment -- the column is
-- touched by the COD settlement path and by nothing else. So a COD order whose money
-- was received by any route other than a courier payout stayed "collectable" forever.
--
-- The normal COD flow -- record nothing until the courier pays, then settle -- was and
-- remains correct. This only bites when a seller records a payment against an
-- unsettled COD order, which is exactly what they do when a customer hands over cash at
-- the door.
--
-- THE FIX
--
-- A payment received against a COD order reduces what the courier still owes, floored
-- at zero, and settles the order's COD leg when it reaches zero. `record_refund` puts
-- it back, because a refunded COD payment means the money is owed again.
--
-- WHY IN THE DATABASE AND NOT THE CLIENT
--
-- `amount_paid`, `cod_amount` and `cod_settled` have to move together or they do not
-- move at all. A read-modify-write from the app would leave a window in which a
-- dashboard read sees half of it. The order row is already locked by `assert_store_access`
-- inside the same transaction, so doing it here is the only place it is atomic.
--
-- WHAT ELSE CHANGES
--
-- Nothing. Same signature, same return value, same idempotency rules, same rejections.
-- For an order that is not COD, `cod_amount` is 0 and `greatest(0, 0 - n)` leaves it 0,
-- so this is a no-op on every existing non-COD order. Historical rows are not rewritten;
-- only a payment recorded from now on moves the COD leg. An order already carrying a
-- manual payment and an unsettled COD amount needs correcting once, which is a data
-- decision for the operator rather than something a migration should guess at.

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
  -- The COD leg, so it can be reduced in the same statement as amount_paid.
  v_is_cod boolean;
  v_cod_amount numeric(14,2);
begin
  select public.assert_store_access(o.store_id), o.org_id, o.store_id,
         o.total, o.amount_paid, o.status, o.payment_status, o.is_cod, o.cod_amount
    into v_org, v_org, v_store, v_total, v_paid, v_order_status, v_status, v_is_cod, v_cod_amount
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

  /*
   * Money received on a COD order reduces what the courier still owes.
   *
   * `greatest(0, ...)` so a payment that covers more than the COD leg cannot make the
   * collectable negative; and `cod_settled` follows the reduced amount rather than the
   * order total, so an order settled in two instalments is not declared settled while
   * part of it is still with the rider.
   *
   * `is_cod` is preserved rather than recomputed. The server treats this order as COD
   * because a COD leg was opened against it, and closing that early would hide the fact
   * that a courier was ever involved.
   */
  update public.orders
     set amount_paid    = v_paid,
         payment_status = v_status,
         cod_amount     = case when v_is_cod
                              then greatest(0, coalesce(v_cod_amount, 0) - p_amount)
                              else coalesce(v_cod_amount, 0) end,
         cod_settled    = case when v_is_cod
                              then coalesce(v_cod_amount, 0) - p_amount <= 0
                              else cod_settled end,
         updated_at      = now()
   where id = p_order_id;

  return v_paid;
end;
$$;

comment on function public.record_payment(uuid, numeric, public.payment_method, timestamptz, text, uuid) is
  'Records a payment against an order. On a cash-on-delivery order it also reduces cod_amount by the same amount and settles the COD leg once nothing is left to collect, so received money and courier receivable never double-count the same taka.';

-- ---------------------------------------------------------------------------
-- record_refund: put the COD leg back
--
-- A refunded payment on a COD order means the money is owed again. Without this the
-- fix above is only half a fix: refunding a COD payment would leave the courier
-- receivable at zero and quietly understate what is owed.
--
-- The `cod_amount` column has a `check (cod_amount >= 0)`, so `least()` is required
-- rather than allowing a negative collectable.
-- ---------------------------------------------------------------------------

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
  v_org    uuid;
  v_store  uuid;
  v_total  numeric(14,2);
  v_paid   numeric(14,2);
  v_outstanding numeric(14,2);
  v_order_status public.order_status;
  v_status public.payment_status;
  v_is_cod boolean;
  v_cod_amount numeric(14,2);
begin
  select public.assert_store_access(o.store_id), o.org_id, o.store_id,
         o.total, o.amount_paid, o.status, o.payment_status, o.is_cod, o.cod_amount
    into v_org, v_org, v_store, v_total, v_paid, v_order_status, v_status, v_is_cod, v_cod_amount
  from public.orders o
  where o.id = p_order_id;

  if v_total is null then
    raise exception 'order_not_found' using hint = 'That order no longer exists.';
  end if;

  perform public.assert_org_write(v_org);

  if p_idempotency_key is not null
     and exists (
       select 1 from public.payments
       where order_id = p_order_id and client_ref = p_idempotency_key
     ) then
    if exists (
      select 1 from public.payments
      where order_id = p_order_id
        and client_ref = p_idempotency_key
        and (amount is distinct from p_amount or method is distinct from p_method)
    ) then
      raise exception 'idempotency_key_reused'
        using hint = 'This refund key was already used for a different amount.';
    end if;

    return v_paid;
  end if;

  if v_order_status in ('cancelled', 'returned') then
    raise exception 'order_closed'
      using hint = 'This order is ' || v_order_status::text || '.';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_payment' using hint = 'Enter an amount greater than zero.';
  end if;

  v_outstanding := v_paid;

  if p_amount > v_outstanding then
    raise exception 'overpayment'
      using hint = 'Only ' || v_outstanding::text || ' has been paid on this order.';
  end if;

  insert into public.payments (
    org_id, store_id, order_id, amount, method, is_refund, client_ref,
    paid_at, note, created_by
  ) values (
    v_org, v_store, p_order_id, p_amount, p_method, true, p_idempotency_key,
    now(), p_note, auth.uid()
  );

  v_paid := v_paid - p_amount;
  v_status := case when v_paid <= 0 then 'unpaid'::public.payment_status
                   when v_paid < v_total then 'partial'::public.payment_status
                   else 'paid'::public.payment_status end;

  /*
   * A refund on a COD order puts the money back on the courier's account. Capped at
   * the order total, because `cod_amount` cannot exceed what the order was worth and a
   * larger figure would fail the column check rather than being clamped.
   */
  update public.orders
     set amount_paid    = v_paid,
         payment_status = v_status,
         cod_amount     = case when v_is_cod
                              then least(v_total, coalesce(v_cod_amount, 0) + p_amount)
                              else coalesce(v_cod_amount, 0) end,
         cod_settled    = case when v_is_cod then false else cod_settled end,
         updated_at      = now()
   where id = p_order_id;

  return v_paid;
end;
$$;

comment on function public.record_refund(uuid, numeric, public.payment_method, text, uuid) is
  'Records a refund against an order. On a cash-on-delivery order it restores cod_amount, because money returned means the courier is owed it again.';