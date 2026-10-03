-- SellFlow :: 0023 -- payment matching engine and settlement
--
-- Turns a detected payment event into money on an order, or into a clear
-- "needs a human" state. It never guesses.
--
-- The pipeline for one event:
--
--   ingest_payment_event()      (0022)  -> payment_events row, status detected
--   match_payment_event()       (this)  -> score every plausible intent
--   settle_event_to_intent()    (this)  -> record_payment() for an order
--
-- AUTO-SETTLEMENT POLICY -- read this before changing a threshold.
--
-- Money is confirmed automatically in exactly one case: a single candidate
-- matches on account, provider and exact amount, within the intent's window,
-- and the sender number is known and equal to the customer's number on the
-- order. That is `strong`.
--
-- Everything else waits for the seller:
--
--   medium  account + exact amount, but the sender could not be verified.
--           Two customers can both owe 500 BDT. Confirming on amount alone is a
--           coin flip with a customer's money attached, so it is refused.
--   weak    amount differs, or the sender number is known and different.
--   ambiguous
--           More than one candidate at the top strength. Ties are common (two
--           500 BDT orders) and silently picking one is how the wrong customer
--           gets credited. Refused.
--
-- This is deliberately conservative. A missed auto-confirm costs the seller one
-- tap; a wrong auto-confirm credits a real order with money that was never
-- received, and `record_payment` has no way to notice.
--
-- Transport independence: nothing below reads or branches on an SMS. The event
-- arrived from sms, api or manual and is scored identically, so an official MFS
-- API later is a new `source`, not new code.

-- ---------------------------------------------------------------------------
-- Provider -> payment_method
--
-- payment_method records how the seller says they took the money; payment_provider
-- records which MFS reported it. Upay has no payment_method value, so it records
-- as 'other'. Adding a provider value to payment_method is a migration, because
-- payment_method is an enum; the two enums are separate precisely so a new MFS
-- does not force that migration on every deployment.
-- ---------------------------------------------------------------------------

create or replace function public.payment_provider_method(p_provider public.payment_provider)
returns public.payment_method
language sql
immutable
as $$
  select case p_provider
    when 'bkash' then 'bkash'::public.payment_method
    when 'nagad' then 'nagad'::public.payment_method
    when 'rocket' then 'rocket'::public.payment_method
    else 'other'::public.payment_method
  end
$$;

comment on function public.payment_provider_method(public.payment_provider) is
  'Maps an MFS provider onto the payment_method recorded against the order. '
  'Upay has no payment_method value and records as other.';

-- ---------------------------------------------------------------------------
-- settle_event_to_intent
--
-- The only code path in SellFlow that turns a detected payment into a settled
-- one. Both the automatic matcher and the seller's manual choice call it, so an
-- automatic settlement and a tapped one follow identical validation and produce
-- identical audit records.
--
-- Not granted to any role: it is internal to the two entry points below.
-- ---------------------------------------------------------------------------

create or replace function public.settle_event_to_intent(
  p_event public.payment_events,
  p_intent public.payment_intents,
  p_match_id uuid,
  p_actor public.payment_audit_actor
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_method public.payment_method;
  v_amount_paid numeric;
  v_payment_id uuid;
  v_note text;
begin
  v_method := public.payment_provider_method(p_event.provider);
  v_note := 'Matched ' || p_event.provider::text || ' payment '
            || p_event.transaction_id || ' (event ' || p_event.id::text || ')';

  /*
   * An ORDER intent settles through record_payment and nothing else. That
   * function recalculates orders.amount_paid and payment_status, enforces the
   * overpayment and closed-order rules, and is already idempotent on
   * p_idempotency_key.
   *
   * The key is the event id. That makes double settlement structurally
   * impossible rather than merely unlikely: a replayed event, a retried match,
   * or two devices racing all present the same key, and the unique index on
   * (order_id, client_ref) admits only one payment row for it.
   */
  if p_intent.type = 'order' then
    begin
      v_amount_paid := public.record_payment(
        p_order_id        => p_intent.reference_id,
        p_amount          => p_event.amount,
        p_method          => v_method,
        p_paid_at         => coalesce(p_event.transaction_timestamp, p_event.detected_at),
        p_note            => v_note,
        p_idempotency_key => p_event.id
      );
    exception
      when others then
        /*
         * record_payment refused. The most common cause is not a bug: the seller
         * already recorded part of this payment by hand, so the remaining
         * outstanding is smaller than the amount that just arrived. Reporting
         * that as a hard error would leave the event stuck in 'detected'
         * forever, so it becomes a review item with the real reason attached.
         *
         * The BEGIN block is a subtransaction, so the failed call leaves nothing
         * behind -- no partial payment, no half-updated order.
         */
        update public.payment_events
        set status = 'review_required',
            mismatch_reason = 'record_payment_refused: ' || coalesce(sqlerrm, 'unknown'),
            review_note = 'The order would not accept this payment automatically. Check the amount outstanding and confirm by hand.',
            matched_intent_id = p_intent.id
        where id = p_event.id;

        perform public.log_payment_audit(
          p_event.org_id, p_actor, 'event_mismatched',
          p_payment_event_id => p_event.id,
          p_payment_intent_id => p_intent.id,
          p_payment_account_id => p_event.payment_account_id,
          p_payment_match_id => p_match_id,
          p_target_type => 'order',
          p_target_id => p_intent.reference_id,
          p_metadata => jsonb_build_object(
            'reason', 'record_payment_refused',
            'detail', coalesce(sqlerrm, 'unknown'),
            'amount', p_event.amount
          )
        );

        return jsonb_build_object(
          'settled', false,
          'status', 'review_required',
          'reason', 'record_payment_refused',
          'detail', coalesce(sqlerrm, 'unknown')
        );
    end;

    -- record_payment returns the new amount_paid; the row itself is found by the
    -- idempotency key that was just used to write it.
    select p.id into v_payment_id
    from public.payments p
    where p.order_id = p_intent.reference_id
      and p.client_ref = p_event.id
    limit 1;

    update public.payment_events
    set status = 'confirmed',
        matched_intent_id = p_intent.id,
        payment_id = v_payment_id,
        mismatch_reason = null
    where id = p_event.id;

  else
    /*
     * A subscription, invoice or other intent. There is no subscription table in
     * SellFlow yet, so nothing here pretends to have activated anything: the
     * intent is marked settled and the audit trail records the event. Phase 3
     * adds the subscription table and this branch grows the real settlement.
     */
    update public.payment_events
    set status = 'confirmed',
        matched_intent_id = p_intent.id,
        mismatch_reason = null
    where id = p_event.id;
  end if;

  update public.payment_intents
  set status = 'matched',
      settled_amount = p_event.amount,
      settled_at = now(),
      settled_payment_event_id = p_event.id
  where id = p_intent.id;

  if p_match_id is not null then
    update public.payment_matches
    set status = 'accepted'
    where id = p_match_id;
  end if;

  perform public.log_payment_audit(
    p_event.org_id, p_actor, 'event_confirmed',
    p_payment_event_id => p_event.id,
    p_payment_intent_id => p_intent.id,
    p_payment_account_id => p_event.payment_account_id,
    p_payment_match_id => p_match_id,
    p_target_type => p_intent.type::text,
    p_target_id => p_intent.reference_id,
    p_metadata => jsonb_build_object(
      'amount', p_event.amount,
      'provider', p_event.provider,
      'method', v_method::text,
      'transaction_id', p_event.transaction_id,
      'payment_id', v_payment_id,
      'amount_paid_total', v_amount_paid
    )
  );

  if p_intent.type = 'order' then
    perform public.log_payment_audit(
      p_event.org_id, p_actor, 'order_payment_recorded',
      p_payment_event_id => p_event.id,
      p_payment_intent_id => p_intent.id,
      p_payment_account_id => p_event.payment_account_id,
      p_target_type => 'order',
      p_target_id => p_intent.reference_id,
      p_metadata => jsonb_build_object('amount', p_event.amount, 'payment_id', v_payment_id)
    );
  end if;

  return jsonb_build_object(
    'settled', true,
    'status', 'confirmed',
    'event_id', p_event.id,
    'intent_id', p_intent.id,
    'payment_id', v_payment_id,
    'amount', p_event.amount,
    'amount_paid_total', v_amount_paid
  );
end;
$$;

revoke all on function public.settle_event_to_intent(public.payment_events, public.payment_intents, uuid, public.payment_audit_actor) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Score one intent against one event
--
-- Returns the strength plus the individual signals, so both the audit trail and
-- the tests can see *why* something was or was not confirmed instead of trusting
-- a single opaque score.
-- ---------------------------------------------------------------------------

create or replace function public.score_payment_match(
  p_event public.payment_events,
  p_intent public.payment_intents
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_account_number text;
  v_event_receiver text;
  v_sender text;
  v_intent_phone text;
  v_order_phone text;
  v_phone_known boolean := false;
  v_phone_ok boolean := false;
  v_account_ok boolean;
  v_amount_ok boolean;
  v_in_window boolean;
  v_delta numeric(14,2);
  v_strength public.payment_match_strength;
  v_reason text;
begin
  select btrim(pa.account_number) into v_account_number
  from public.payment_accounts pa
  where pa.id = p_event.payment_account_id;

  v_event_receiver := public.payment_normalize_bk_number(p_event.receiver_account);
  v_sender := p_event.sender_account_normalized;

  -- The receiver must be the connected account. If the number that received the
  -- money is not the account this event was filed against, the seller filed it
  -- against the wrong account and nothing else can be trusted.
  v_account_ok := v_event_receiver = public.payment_normalize_bk_number(v_account_number);

  v_amount_ok := p_intent.expected_amount = p_event.amount;
  v_delta := p_event.amount - p_intent.expected_amount;
  v_in_window := now() <= p_intent.expires_at;

  -- Sender identity: the intent's own note first, then the order's customer
  -- record. The order is the better source because the seller may never have
  -- written a number on the intent at all.
  v_intent_phone := nullif(btrim(p_intent.expected_customer_phone), '');
  if v_intent_phone is not null then
    v_order_phone := v_intent_phone;
  elsif p_intent.type = 'order' and p_intent.reference_id is not null then
    select nullif(btrim(c.phone), '') into v_order_phone
    from public.orders o
    join public.customers c on c.id = o.customer_id
    where o.id = p_intent.reference_id;
  end if;

  if v_order_phone is not null and v_sender is not null then
    v_phone_known := true;
    v_phone_ok := public.payment_normalize_bk_number(v_order_phone) = v_sender;
  end if;

  if not v_account_ok then
    v_strength := 'weak';
    v_reason := 'account_mismatch';
  elsif not v_in_window then
    v_strength := 'weak';
    v_reason := 'intent_expired';
  elsif not v_amount_ok then
    v_strength := 'weak';
    v_reason := case when v_delta > 0 then 'amount_over' else 'amount_under' end;
  elsif v_phone_known and not v_phone_ok then
    -- The money came from a number that is not the customer's. This is either a
    -- genuine mismatch or someone else paying on their behalf, and a human
    -- decides which.
    v_strength := 'weak';
    v_reason := 'customer_phone_mismatch';
  elsif v_phone_ok then
    v_strength := 'strong';
    v_reason := 'account_amount_and_customer';
  else
    v_strength := 'medium';
    v_reason := 'account_and_amount';
  end if;

  return jsonb_build_object(
    'strength', v_strength,
    'reason_code', v_reason,
    'amount_delta', v_delta,
    'account_matched', v_account_ok,
    -- The event was filed against this account and its provider was validated at
    -- ingest, so provider agreement is a property of the pair.
    'provider_matched', true,
    'amount_matched', v_amount_ok,
    'customer_phone_matched', case when v_phone_known then v_phone_ok else null end,
    'within_window', v_in_window
  );
end;
$$;

revoke all on function public.score_payment_match(public.payment_events, public.payment_intents) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- match_payment_event
--
-- Scores the plausible intents for a detected event, records every candidate as
-- a row in payment_matches (including the ones it turns down, so the decision is
-- explainable later), and auto-settles only an unambiguous strong match.
-- ---------------------------------------------------------------------------

create or replace function public.match_payment_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.payment_events;
  v_best public.payment_intents;
  v_best_intent_id uuid;
  v_best_match_id uuid;
  v_top_strength public.payment_match_strength;
  v_top_rank integer := 0;
  v_top_count integer := 0;
  v_rank integer;
  -- Typed as the table's rowtype, not `record`. Passing an untyped record to
  -- score_payment_match(payment_intents) fails at runtime with
  -- "cannot cast type record to payment_intents", and it fails on the very first
  -- candidate -- so the whole matcher would have been dead on arrival.
  v_candidate public.payment_intents%rowtype;
  v_score jsonb;
  v_match_id uuid;
  v_settled jsonb;
  v_any_candidate boolean := false;
  v_saw_weak boolean := false;
begin
  select * into v_event
  from public.payment_events
  where id = p_event_id
  for update;

  if v_event.id is null then
    raise exception using message = 'payment_event_not_found',
      hint = 'That payment is no longer available.';
  end if;

  perform public.assert_org_write(v_event.org_id);

  -- Already settled, or already decided by a human. Re-running is a no-op, so a
  -- retry from the app cannot re-enter the pipeline.
  --
  -- It reports settled=false even when the payment IS settled, because the
  -- alternative is a replayed request returning the same answer as a fresh
  -- confirmation -- and a caller that trusts that flag would announce a
  -- payment the seller already recorded. The state is in `status`; whether
  -- this call did anything is in `already_processed`.
  if v_event.status in ('confirmed', 'review_required') then
    return jsonb_build_object(
      'event_id', v_event.id,
      'status', v_event.status,
      'settled', false,
      'already_processed', true,
      'message', 'This payment has already been processed.'
    );
  end if;

  /*
   * Candidates: same business, same connected account, still payable, not past
   * its window. Ordered by how close the amount is so the best candidates are
   * always scored, then bounded -- an account with a thousand stale open intents
   * must not turn one incoming payment into a thousand scored comparisons.
   */
  for v_candidate in
    select i.*
    from public.payment_intents i
    where i.org_id = v_event.org_id
      and i.payment_account_id = v_event.payment_account_id
      and i.status in ('open', 'partially_paid')
      and i.expires_at > now()
    order by abs(i.expected_amount - v_event.amount), i.expires_at
    limit 20
  loop
    v_any_candidate := true;
    v_score := public.score_payment_match(v_event, v_candidate);

    insert into public.payment_matches (
      org_id, payment_event_id, payment_intent_id, strength, status,
      reason_code, reason_detail, amount_delta,
      account_matched, provider_matched, amount_matched, customer_phone_matched, within_window
    )
    values (
      v_event.org_id, v_event.id, v_candidate.id,
      (v_score->>'strength')::public.payment_match_strength, 'candidate',
      v_score->>'reason_code',
      case (v_score->>'strength')::public.payment_match_strength
        when 'strong' then 'Connected account, exact amount, and the sender number matches the customer on the order.'
        when 'medium' then 'Connected account and exact amount, but the sender number could not be verified.'
        else 'No automatic confirmation: ' || (v_score->>'reason_code')
      end,
      (v_score->>'amount_delta')::numeric(14,2),
      (v_score->>'account_matched')::boolean,
      (v_score->>'provider_matched')::boolean,
      (v_score->>'amount_matched')::boolean,
      (v_score->>'customer_phone_matched')::boolean,
      (v_score->>'within_window')::boolean
    )
    returning id into v_match_id;

    if (v_score->>'strength') = 'weak' then
      v_saw_weak := true;
    end if;

    -- Track the best strength seen, and how many intents reached it.
    --
    -- Confidence is ranked with an explicit integer, NOT by comparing the enum.
    -- payment_match_strength is declared ('strong','medium','weak'), which makes
    -- 'strong' the SMALLEST value, so an enum comparison ranks confidence
    -- backwards and a later weak candidate silently displaces a strong one.
    -- An explicit rank cannot be inverted by reordering the enum.
    v_rank := case (v_score->>'strength')
      when 'strong' then 3
      when 'medium' then 2
      else 1
    end;

    if v_top_rank = 0 or v_rank > v_top_rank then
      v_top_rank := v_rank;
      v_top_strength := (v_score->>'strength')::public.payment_match_strength;
      v_top_count := 1;
      v_best_intent_id := v_candidate.id;
      v_best_match_id := v_match_id;
    elsif v_rank = v_top_rank then
      v_top_count := v_top_count + 1;
    end if;
  end loop;

  /*
   * No plausible intent at all. The money is real but nothing is waiting for it:
   * most often an advance, a delivery fee, or a sale not entered yet. Recorded
   * as unmatched so the seller can attach it by hand.
   */
  if not v_any_candidate then
    update public.payment_events
    set status = 'unmatched',
        mismatch_reason = 'no_candidate_intent'
    where id = v_event.id;

    perform public.log_payment_audit(
      v_event.org_id, 'system', 'event_unmatched',
      p_payment_event_id => v_event.id,
      p_payment_account_id => v_event.payment_account_id,
      p_metadata => jsonb_build_object(
        'reason', 'no_candidate_intent',
        'amount', v_event.amount,
        'provider', v_event.provider
      )
    );

    return jsonb_build_object(
      'event_id', v_event.id,
      'status', 'unmatched',
      'settled', false,
      'reason', 'no_candidate_intent',
      'message', 'No waiting request matches this amount. Review it and attach it to an order.'
    );
  end if;

  /*
   * Only a single unambiguous strong match is settled automatically.
   */
  if v_top_strength = 'strong' then

    /*
     * A tie at the top strength. Two 500 BDT orders on one account is an
     * ordinary Tuesday; guessing which customer paid is not an option, so every
     * candidate stays a candidate and the seller chooses.
     *
     * This check lives inside the strong branch on purpose. A tie among medium
     * or weak candidates is not an ambiguity -- nothing was going to settle
     * anyway -- and reporting those as "ambiguous" would send the seller
     * looking for a choice that does not exist.
     */
    if v_top_count > 1 then
      update public.payment_events
      set status = 'review_required',
          mismatch_reason = 'ambiguous_candidates'
      where id = v_event.id;

      perform public.log_payment_audit(
        v_event.org_id, 'system', 'event_mismatched',
        p_payment_event_id => v_event.id,
        p_payment_account_id => v_event.payment_account_id,
        p_metadata => jsonb_build_object(
          'reason', 'ambiguous_candidates',
          'strength', v_top_strength::text,
          'candidate_count', v_top_count
        )
      );

      return jsonb_build_object(
        'event_id', v_event.id,
        'status', 'review_required',
        'settled', false,
        'reason', 'ambiguous_candidates',
        'candidate_count', v_top_count,
        'message', 'Several waiting requests match this payment. Choose which order it settles.'
      );
    end if;

    -- Re-read the intent as a typed row rather than carrying the loop's record
    -- through: settle_event_to_intent takes payment_intents, and passing an
    -- untyped record whose shape merely happens to match is the kind of thing
    -- that breaks the moment the loop's SELECT list changes.
    select * into v_best
    from public.payment_intents
    where id = v_best_intent_id;

    v_settled := public.settle_event_to_intent(v_event, v_best, v_best_match_id, 'system');

    if coalesce((v_settled->>'settled')::boolean, false) then
      return v_settled || jsonb_build_object(
        'strength', 'strong',
        'auto_confirmed', true
      );
    end if;

    return v_settled || jsonb_build_object('strength', 'strong', 'auto_confirmed', false);
  end if;

  -- medium or weak: leave every candidate as a candidate and ask the seller.
  update public.payment_events
  set status = 'review_required',
      mismatch_reason = (select m.reason_code from public.payment_matches m
                          where m.payment_event_id = v_event.id
                          order by m.strength desc, m.created_at
                          limit 1),
      matched_intent_id = null
  where id = v_event.id;

  perform public.log_payment_audit(
    v_event.org_id, 'system', 'event_mismatched',
    p_payment_event_id => v_event.id,
    p_payment_account_id => v_event.payment_account_id,
    p_metadata => jsonb_build_object(
      'reason', 'insufficient_confidence',
      'strength', v_top_strength::text,
      'saw_weak', v_saw_weak
    )
  );

  return jsonb_build_object(
    'event_id', v_event.id,
    'status', 'review_required',
    'settled', false,
    'strength', v_top_strength::text,
    'reason', 'insufficient_confidence',
    'message', case v_top_strength
      when 'medium' then 'The amount matches but the sender could not be verified. Confirm the order by hand.'
      else 'This payment does not line up with a waiting request. Review it.'
    end
  );
end;
$$;

revoke all on function public.match_payment_event(uuid) from public, anon;
grant execute on function public.match_payment_event(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- assign_payment_match -- the seller's decision
--
-- The manual counterpart to automatic matching. Everything automatic refuses is
-- settleable here, by a person, with the same validation and the same audit
-- trail. This is what makes the conservative auto-policy acceptable: a missed
-- match costs one tap.
-- ---------------------------------------------------------------------------

create or replace function public.assign_payment_match(
  p_event_id uuid,
  p_intent_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.payment_events;
  v_intent public.payment_intents;
  v_score jsonb;
  v_match_id uuid;
  v_result jsonb;
begin
  select * into v_event
  from public.payment_events
  where id = p_event_id
  for update;

  if v_event.id is null then
    raise exception using message = 'payment_event_not_found',
      hint = 'That payment is no longer available.';
  end if;

  perform public.assert_org_write(v_event.org_id);

  if v_event.status = 'confirmed' then
    raise exception using message = 'payment_already_confirmed',
      hint = 'This payment already settled an order. Refund it instead of reassigning it.';
  end if;

  select * into v_intent
  from public.payment_intents
  where id = p_intent_id
  for update;

  if v_intent.id is null then
    raise exception using message = 'intent_not_found',
      hint = 'That request no longer exists.';
  end if;

  -- Both sides must belong to the same business. Assigning across tenants would
  -- let a payment land on somebody else's order.
  if v_intent.org_id <> v_event.org_id then
    raise exception using message = 'intent_org_mismatch',
      hint = 'That request belongs to a different business.';
  end if;

  if v_intent.status = 'matched' then
    raise exception using message = 'intent_already_settled',
      hint = 'Another payment already settled this request.';
  end if;

  if v_intent.payment_account_id <> v_event.payment_account_id then
    raise exception using message = 'intent_account_mismatch',
      hint = 'That request was created for a different payment account.';
  end if;

  if v_intent.expires_at <= now() then
    raise exception using message = 'intent_expired',
      hint = 'That request expired. Create a new one for this payment.';
  end if;

  -- Recorded at full manual strength regardless of how weak the automatic
  -- signals were: a person looked at both rows and decided. The underlying
  -- signals are still stored, so the difference between "the engine was sure"
  -- and "the seller was sure" survives in the data.
  v_score := public.score_payment_match(v_event, v_intent);

  insert into public.payment_matches (
    org_id, payment_event_id, payment_intent_id, strength, status,
    reason_code, reason_detail, amount_delta,
    account_matched, provider_matched, amount_matched, customer_phone_matched, within_window
  )
  values (
    v_event.org_id, v_event.id, v_intent.id,
    'manual', 'candidate',
    'seller_assigned',
    coalesce(nullif(btrim(p_note), ''), 'Assigned by the seller.'),
    (v_score->>'amount_delta')::numeric(14,2),
    (v_score->>'account_matched')::boolean,
    (v_score->>'provider_matched')::boolean,
    (v_score->>'amount_matched')::boolean,
    (v_score->>'customer_phone_matched')::boolean,
    (v_score->>'within_window')::boolean
  )
  returning id into v_match_id;

  perform public.log_payment_audit(
    v_event.org_id, 'seller', 'match_manually_assigned',
    p_payment_event_id => v_event.id,
    p_payment_intent_id => v_intent.id,
    p_payment_account_id => v_event.payment_account_id,
    p_payment_match_id => v_match_id,
    p_target_type => v_intent.type::text,
    p_target_id => v_intent.reference_id,
    p_metadata => jsonb_build_object(
      'amount', v_event.amount,
      'expected_amount', v_intent.expected_amount,
      'note', p_note
    )
  );

  v_result := public.settle_event_to_intent(v_event, v_intent, v_match_id, 'seller');

  return v_result || jsonb_build_object('strength', 'manual', 'auto_confirmed', false);
end;
$$;

revoke all on function public.assign_payment_match(uuid, uuid, text) from public, anon;
grant execute on function public.assign_payment_match(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- expire_stale_payment_intents
--
-- An intent that outlives its window would eventually match a payment days late,
-- which is how a stale request silently swallows an unrelated transfer. Marking
-- them expired keeps the candidate set honest and small.
--
-- Scoped to the caller's own businesses so this is safe to call from the app.
-- ---------------------------------------------------------------------------

create or replace function public.expire_stale_payment_intents()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.payment_intents i
    set status = 'expired'
    where i.status in ('open', 'partially_paid')
      and i.expires_at <= now()
      and public.is_org_member(i.org_id)
    returning i.id, i.org_id, i.reference_id, i.type, i.payment_account_id
  )
  insert into public.payment_audit_logs (
    org_id, actor_kind, actor_id, action, payment_intent_id,
    payment_account_id, target_type, target_id, metadata
  )
  select e.org_id, 'system', null, 'intent_expired', e.id,
         e.payment_account_id, e.type::text, e.reference_id,
         jsonb_build_object('reason', 'window_elapsed')
  from expired e;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_stale_payment_intents() from public, anon;
grant execute on function public.expire_stale_payment_intents() to authenticated;