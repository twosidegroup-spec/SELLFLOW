/**
 * SellFlow :: Pathao status webhook (Supabase Edge Function)
 *
 * Pathao POSTs consignment status changes to the URL registered in the merchant
 * panel. This turns those pushes into SellFlow's own order and shipment state.
 *
 * ---------------------------------------------------------------------------
 * Verified contract
 * ---------------------------------------------------------------------------
 * From Pathao's own WooCommerce plugin README and handler:
 *
 *   - Verification header: `X-Pathao-Signature: <webhook_secret>`
 *   - Handshake:      event = "webhook_integration"  -> reply 202 AND echo
 *                     `X-Pathao-Merchant-Webhook-Integration-Secret`
 *   - Payload:        { event, merchant_order_id, order_status, delivery_fee,
 *                       consignment_id }
 *   - Success:        HTTP 202
 *
 * IMPORTANT HONEST LIMITATION: Pathao's webhook is authenticated by a STATIC
 * shared secret in a header, not an HMAC signature. That means the payload
 * itself is not integrity-protected. This function therefore:
 *   * rejects anything without a matching secret,
 *   * only ever acts on shipments that already exist in this database, and
 *   * never accepts a status transition it does not recognise.
 * An attacker who obtained the secret could still post a status change for a
 * real consignment. IP allow-listing is the mitigation and is left to the
 * operator, because Pathao does not publish its source ranges.
 *
 * Delivery is at-least-once, so every update is idempotent: replaying the same
 * event changes nothing.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const WEBHOOK_SECRET = Deno.env.get('PATHAO_WEBHOOK_SECRET');

// The value Pathao's handshake handler echoes back verbatim. Documented in
// their plugin; not a credential and not derived per-tenant.
const HANDSHAKE_ECHO =
  'X-Pathao-Merchant-Webhook-Integration-Secret';
const HANDSHAKE_VALUE = 'f3992ecc-59da-4cbe-a049-a13da2018d51';

interface PathaoWebhookEvent {
  event?: string;
  merchant_order_id?: string;
  order_status?: string;
  delivery_fee?: number;
  consignment_id?: string;
  store_id?: number;
}

/**
 * Pathao's event vocabulary, mapped onto SellFlow's shipment states.
 *
 * Only the states SellFlow actually models are listed. Unknown events are
 * ignored rather than guessed at, so a new Pathao event cannot corrupt a
 * shipment's state.
 */
const STATUS_MAP: Record<string, { state: string; label: string }> = {
  'order.created': { state: 'created', label: 'Shipment created' },
  'order.pickup-requested': { state: 'created', label: 'Pickup requested' },
  'order.assigned-for-pickup': { state: 'created', label: 'Assigned for pickup' },
  'order.picked': { state: 'picked', label: 'Picked up from seller' },
  'order.at-the-sorting-hub': { state: 'at_hub', label: 'At sorting hub' },
  'order.in-transit': { state: 'in_transit', label: 'In transit' },
  'order.received-at-last-mile-hub': { state: 'at_hub', label: 'At last-mile hub' },
  'order.assigned-for-delivery': { state: 'out_for_delivery', label: 'Out for delivery' },
  'order.delivered': { state: 'delivered', label: 'Delivered' },
  'order.delivery-failed': { state: 'failed', label: 'Delivery attempt failed' },
  'order.returned': { state: 'returned', label: 'Returning to seller' },
  'order.partial-delivery': { state: 'in_transit', label: 'Partially delivered' },
  'order.on-hold': { state: 'at_hub', label: 'On hold' },
  'order.pickup-failed': { state: 'failed', label: 'Pickup failed' },
  'order.pickup-cancelled': { state: 'cancelled', label: 'Pickup cancelled' },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  if (!WEBHOOK_SECRET) {
    // Fail closed. An unconfigured webhook is an open door.
    console.error('PATHAO_WEBHOOK_SECRET is not set; refusing all webhooks.');
    return json({ error: 'not_configured' }, 500);
  }

  // ---- 1. Verify the shared secret -----------------------------------
  const signature = req.headers.get('X-Pathao-Signature');
  if (!signature || signature !== WEBHOOK_SECRET) {
    return json({ error: 'invalid_signature' }, 401);
  }

  let event: PathaoWebhookEvent;
  try {
    event = (await req.json()) as PathaoWebhookEvent;
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  // ---- 2. Registration handshake --------------------------------------
  // Pathao verifies we are reachable by sending a probe and expecting this
  // exact header back.
  if (event.event === 'webhook_integration') {
    return new Response(null, {
      status: 202,
      headers: { [HANDSHAKE_ECHO]: HANDSHAKE_VALUE },
    });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // ---- 3. Resolve the shipment ----------------------------------------
  // Prefer the consignment id Pathao sent, because it is authoritative. Fall
  // back to our own order number, which is what we submitted as
  // merchant_order_id.
  let shipment = null;

  if (event.consignment_id) {
    const { data } = await admin
      .from('shipments')
      .select('*')
      .eq('tracking_id', event.consignment_id)
      .maybeSingle();
    shipment = data;
  }

  if (!shipment && event.merchant_order_id) {
    const { data: order } = await admin
      .from('orders')
      .select('id')
      .eq('order_number', event.merchant_order_id)
      .maybeSingle();

    if (order) {
      const { data } = await admin
        .from('shipments')
        .select('*')
        .eq('order_id', order.id)
        .order('attempt_no', { ascending: false })
        .limit(1)
        .maybeSingle();
      shipment = data;
    }
  }

  if (!shipment) {
    // Nothing to update. This is normal for an event about a parcel that was
    // created outside SellFlow, so acknowledge rather than error.
    return json({ status: 'ignored', reason: 'no matching shipment' }, 202);
  }

  // ---- 4. Map the event -----------------------------------------------
  // Pathao may send either `order_status` (preferred) or `event`.
  const rawStatus = event.order_status ?? event.event ?? '';
  const mapped = STATUS_MAP[rawStatus];

  if (!mapped) {
    // Record nothing, change nothing. An unknown vocabulary entry must not
    // corrupt a shipment.
    console.warn(`Unrecognised Pathao status: ${rawStatus}`);
    return json({ status: 'ignored', reason: 'unknown status', courierStatus: rawStatus }, 202);
  }

  // ---- 5. Apply it idempotently ---------------------------------------
  const { error } = await admin.rpc('apply_shipment_update', {
    p_shipment_id: shipment.id,
    p_state: mapped.state,
    p_label: mapped.label,
    p_external_status: rawStatus,
    p_source: 'courier',
    p_occurred_at: new Date().toISOString(),
    p_delivered_at: null,
  });

  if (error) {
    console.error('apply_shipment_update failed:', error.message);
    // 500 so Pathao retries: a dropped status update is a real problem.
    return json({ error: 'apply_failed', detail: error.message }, 500);
  }

  // ---- 6. Mirror terminal states onto the order -------------------------
  const orderId = (shipment as { order_id: string }).order_id;

  if (mapped.state === 'delivered') {
    await admin.rpc('set_order_status', {
      p_order_id: orderId,
      p_to_status: 'delivered',
      p_note: `Delivered by courier (${rawStatus})`,
    });
  } else if (mapped.state === 'failed') {
    // A failed delivery is NOT a cancellation: the parcel is still with the
    // courier and the goods stay out of stock until it is resolved.
    await admin.rpc('set_order_status', {
      p_order_id: orderId,
      p_to_status: 'failed_delivery',
      p_note: `Delivery failed (${rawStatus})`,
    });
  } else if (mapped.state === 'returned') {
    await admin.rpc('set_order_status', {
      p_order_id: orderId,
      p_to_status: 'returned',
      p_note: `Returned to seller (${rawStatus})`,
    });
  } else if (mapped.state === 'out_for_delivery' || mapped.state === 'in_transit') {
    const { data: order } = await admin
      .from('orders')
      .select('status')
      .eq('id', orderId)
      .maybeSingle();

    const current = (order as { status?: string } | null)?.status;

    // Only advance forward. A webhook arriving out of order must not drag a
    // parcel back to an earlier state.
    if (current === 'packed') {
      await admin.rpc('set_order_status', {
        p_order_id: orderId,
        p_to_status: 'shipped',
        p_note: 'In transit with courier',
      });
    } else if (current === 'shipped' && mapped.state === 'out_for_delivery') {
      await admin.rpc('set_order_status', {
        p_order_id: orderId,
        p_to_status: 'on_delivery',
        p_note: 'Out for delivery',
      });
    }
  }

  return json({ status: 'applied', consignment: rawStatus, shipment: shipment.id }, 202);
});
