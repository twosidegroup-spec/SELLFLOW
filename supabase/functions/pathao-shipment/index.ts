/**
 * SellFlow :: Pathao shipment creation (Supabase Edge Function)
 *
 * Runs server-side for two reasons that are not negotiable:
 *   1. Pathao's client_id / client_secret must never enter the mobile bundle.
 *      Shipping them in a React Native app would let anyone extract them from
 *      the binary and create parcels in the seller's account.
 *   2. The call must be idempotent. A seller tapping "Send to courier" twice, or
 *      retrying after a dropped connection, must produce exactly ONE
 *      consignment.
 *
 * Order of operations is deliberate:
 *
 *   register_shipment()  -> claims the order and reserves the idempotency key
 *   call Pathao          -> only if no live shipment already exists
 *   confirm_shipment()   -> ONLY when Pathao returns a real consignment_id
 *   fail_shipment()      -> otherwise, recording why
 *
 * The shipment row therefore never claims "created" on the strength of a
 * request we merely made.
 *
 * ---------------------------------------------------------------------------
 * API contract
 * ---------------------------------------------------------------------------
 * Verified against Pathao's own published WooCommerce plugin
 * (github.com/pathao-eng/courier-woocommerce-plugin) plus live probing. Pathao
 * publishes no public OpenAPI document; their developer docs are login-gated.
 * Endpoints actually used here:
 *
 *   POST {base}/aladdin/api/v1/external/login     {client_id, client_secret}
 *        -> { access_token, refresh_token, expires_in }
 *   POST {base}/aladdin/api/v1/orders             -> 201
 *        { data: { consignment_id, delivery_fee } }
 *   GET  {base}/aladdin/api/v1/orders/{id}
 *   GET  {base}/aladdin/api/v1/stores
 *   GET  {base}/aladdin/api/v1/countries/1/city-list
 *   GET  {base}/aladdin/api/v1/cities/{city}/zone-list
 *   GET  {base}/aladdin/api/v1/zones/{zone}/area-list
 *
 * Base URLs (verified live; note the "api-hermes" ordering, which several
 * third-party repos get wrong):
 *   sandbox  https://courier-api-sandbox.pathao.com
 *   live     https://api-hermes.pathao.com
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const PATHAO_BASE =
  Deno.env.get('PATHAO_API_BASE') ?? 'https://api-hermes.pathao.com';
const API = `${PATHAO_BASE}/aladdin/api/v1`;

// Documented enumerations. Anything else is rejected rather than guessed at,
// because Pathao accepts unknown integers silently and misroutes the parcel.
const DELIVERY_TYPE_NORMAL = 48;
const ITEM_TYPE_PARCEL = 2;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface CreateShipmentBody {
  orderId: string;
  connectionId?: string;
  /** Reused across retries. Generated once per dispatch attempt by the app. */
  idempotencyKey: string;
  /** Pathao city id, resolved in-app from the cached location list. */
  cityId?: number;
  zoneId?: number;
  areaId?: number;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** A failure the app can render as "what happened + what to do next". */
class CourierError extends Error {
  constructor(
    message: string,
    readonly detail: string,
    readonly providerCode?: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Pathao transport
// ---------------------------------------------------------------------------

interface PathaoToken {
  access_token: string;
  expires_in?: number;
}

/** Cached per function instance so a burst of shipments needs one login. */
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COURIER_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${API}/external/login`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CourierTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new CourierError(
      'Pathao rejected the store credentials',
      (body as { message?: string })?.message ?? `HTTP ${res.status}`,
      String((body as { code?: number })?.code ?? res.status),
    );
  }

  const token = (body as PathaoToken).access_token;
  if (!token) {
    throw new CourierError(
      'Pathao did not return an access token',
      'The credential response had no access_token field.',
    );
  }

  // Pathao's token lifetime is reported but not contractual; refresh early.
  const lifetimeSec = (body as PathaoToken).expires_in ?? 3600;
  tokenCache = {
    token,
    expiresAt: Date.now() + Math.min(lifetimeSec - 120, lifetimeSec * 0.8) * 1000,
  };

  return token;
}

/**
 * Every call to Pathao is bounded.
 *
 * Without a timeout a hung courier endpoint would hold this function open until
 * the platform killed it, and the seller would see a generic failure with no
 * way to know whether the parcel had been created. A timeout turns that into a
 * definite, reportable outcome, and the shipment correctly stays in the
 * `requested` state -- uncertain, never falsely confirmed.
 */
const COURIER_TIMEOUT_MS = 15_000;

class CourierTimeoutError extends Error {
  constructor() {
    super('courier_timeout');
    this.name = 'CourierTimeoutError';
  }
}

async function pathaoFetch<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COURIER_TIMEOUT_MS);

  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CourierTimeoutError();
    }
    throw error;
  } finally {
    // Always cleared, including on the timeout path, so a late timer can never
    // keep the function alive.
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Credentials
//
// Read from Supabase Vault with the service role. The anon/authenticated key
// used by the mobile app can never reach this table.
// ---------------------------------------------------------------------------

async function loadCredentials(
  admin: ReturnType<typeof createClient>,
  orgId: string,
  connectionId?: string,
): Promise<{ clientId: string; clientSecret: string; storeId: number }> {
  let query = admin
    .from('courier_connections')
    .select('*')
    .eq('org_id', orgId)
    .eq('provider', 'pathao')
    .eq('is_active', true);

  if (connectionId) query = query.eq('id', connectionId);

  const { data: connections, error } = await query;
  if (error) throw new CourierError('Could not read the courier settings', error.message);
  if (!connections || connections.length === 0) {
    throw new CourierError(
      'No Pathao account is connected',
      'Add your Pathao account in Settings before sending a shipment.',
    );
  }

  const connection = connections[0] as {
    vault_secret_id: string | null;
    external_store_id: string | null;
  };

  if (!connection.vault_secret_id) {
    throw new CourierError(
      'Pathao credentials are not stored',
      'Reconnect your Pathao account in Settings. The app never stores courier passwords.',
    );
  }

  // Pathao requires a numeric store_id; without one the API rejects the parcel.
  const storeId = Number(connection.external_store_id);
  if (!Number.isFinite(storeId) || storeId <= 0) {
    throw new CourierError(
      'No Pathao store is selected',
      'Choose which Pathao store to ship from in Settings.',
    );
  }

  const { data: secret, error: secretError } = await admin.rpc('read_vault_secret', {
    p_secret_id: connection.vault_secret_id,
  });

  if (secretError) {
    throw new CourierError(
      'Could not read the stored Pathao credentials',
      secretError.message,
    );
  }

  const parsed = typeof secret === 'string' ? JSON.parse(secret) : secret;
  if (!parsed?.client_id || !parsed?.client_secret) {
    throw new CourierError(
      'The stored Pathao credentials are incomplete',
      'Reconnect your Pathao account in Settings.',
    );
  }

  return {
    clientId: parsed.client_id,
    clientSecret: parsed.client_secret,
    storeId,
  };
}

// ---------------------------------------------------------------------------
// Shipment payload
// ---------------------------------------------------------------------------

function buildPayload(args: {
  storeId: number;
  merchantOrderId: string;
  order: Record<string, unknown>;
  itemSummary: string;
  itemCount: number;
  totalWeightKg: number;
  codAmount: number;
  cityId?: number;
  zoneId?: number;
  areaId?: number;
}) {
  const order = args.order as Record<string, never>;
  const str = (key: string): string => (order[key] as string | null) ?? '';

  return {
    store_id: args.storeId,
    merchant_order_id: args.merchantOrderId,
    recipient_name: str('delivery_name'),
    recipient_phone: str('delivery_phone'),
    recipient_address: str('delivery_address'),
    recipient_city: args.cityId ?? 0,
    recipient_zone: args.zoneId ?? 0,
    recipient_area: args.areaId ?? 0,
    delivery_type: DELIVERY_TYPE_NORMAL,
    item_type: ITEM_TYPE_PARCEL,
    item_quantity: Math.max(1, args.itemCount),
    item_weight: args.totalWeightKg > 0 ? args.totalWeightKg : 0.5,
    item_description: args.itemSummary.slice(0, 100),
    special_instruction: (str('notes') || '').slice(0, 200),
    amount_to_collect: Math.max(0, Math.round(args.codAmount)),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    // ---- 1. Authenticate the caller -----------------------------------
    // The seller acts with their own JWT, so the org is resolved from the
    // session rather than trusted from the request body.
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) {
      return json({ error: 'not_authenticated', message: 'Sign in and try again.' }, 401);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) {
      return json({ error: 'not_authenticated', message: 'Your session has expired. Sign in again.' }, 401);
    }
    const userId = userData.user.id;

    const body = (await req.json()) as CreateShipmentBody;
    if (!body?.orderId || !body?.idempotencyKey) {
      return json({ error: 'bad_request', message: 'An order and an idempotency key are required.' }, 400);
    }

    // ---- 2. Resolve the order, with the caller's own permissions -------
    const { data: order, error: orderError } = await userClient
      .from('orders')
      .select('*')
      .eq('id', body.orderId)
      .maybeSingle();

    if (orderError) {
      return json({ error: 'order_lookup_failed', message: orderError.message }, 400);
    }
    if (!order) {
      return json({ error: 'order_not_found', message: 'That order no longer exists.' }, 404);
    }

    const orderRow = order as Record<string, unknown>;

    // ---- 3. Register BEFORE calling Pathao ---------------------------
    // This is the double-tap guard. If a live shipment already exists for the
    // order, register_shipment returns it and we return immediately without
    // touching the courier.
    const { data: shipment, error: registerError } = await userClient.rpc('register_shipment', {
      p_order_id: body.orderId,
      p_provider: 'pathao',
      p_idempotency_key: body.idempotencyKey,
      p_connection_id: body.connectionId ?? null,
      p_cod_amount: Number(orderRow.cod_amount ?? 0),
      p_tracking_id: null,
      p_tracking_url: null,
      p_external_payload: null,
    });

    if (registerError) {
      const blocker = (registerError as { message?: string }).message ?? '';
      if (blocker.includes('dispatch_blocked')) {
        return json(
          {
            error: 'dispatch_blocked',
            message:
              'This order is not ready to ship yet. Pack it and check the delivery address first.',
          },
          409,
        );
      }
      return json({ error: 'register_failed', message: registerError.message }, 400);
    }

    const ship = shipment as Record<string, unknown>;

    // Already dispatched. Return the existing consignment rather than creating
    // a second one. This is the path a double tap takes.
    if (ship.state !== 'requested') {
      return json({
        status: 'already_dispatched',
        shipmentId: ship.id,
        trackingId: ship.tracking_id,
        trackingUrl: ship.tracking_url,
        state: ship.state,
        message: 'This order was already sent to Pathao.',
      });
    }

    // ---- 4. Load credentials and call Pathao --------------------------
    try {
      const { clientId, clientSecret, storeId } = await loadCredentials(
        admin,
        String(orderRow.org_id),
        body.connectionId,
      );

      const token = await getAccessToken(clientId, clientSecret);

      const { data: items, error: itemsError } = await userClient
        .from('order_items')
        .select('product_name, quantity')
        .eq('order_id', body.orderId);

      if (itemsError) {
        throw new CourierError('Could not read the order items', itemsError.message);
      }

      const rows = (items ?? []) as { product_name: string; quantity: number }[];
      const itemCount = rows.reduce((sum, row) => sum + (row.quantity ?? 0), 0);
      const itemSummary = rows.map((row) => row.product_name).join(', ');

      const payload = buildPayload({
        storeId,
        merchantOrderId: String(orderRow.order_number),
        order: orderRow,
        itemSummary,
        itemCount,
        // No product weights in the catalogue yet, so Pathao's minimum is used
        // rather than inventing one. Replace when weight tracking lands.
        totalWeightKg: 0.5,
        codAmount: Number(orderRow.cod_amount ?? 0),
        cityId: body.cityId,
        zoneId: body.zoneId,
        areaId: body.areaId,
      });

      // Pathao requires the geographic hierarchy. Without it the parcel is
      // silently routed to the wrong district, so refuse rather than guess.
      if (!payload.recipient_city || !payload.recipient_zone || !payload.recipient_area) {
        throw new CourierError(
          'Delivery area is incomplete',
          'Choose the city, thana and area for this customer before shipping.',
        );
      }

      const { status, body: response } = await pathaoFetch<{
        data?: { consignment_id?: string; delivery_fee?: number };
        message?: string;
      }>(token, '/orders', { method: 'POST', body: JSON.stringify(payload) });

      // Pathao signals success with 201 and a consignment id.
      if (status !== 201 || !response?.data?.consignment_id) {
        throw new CourierError(
          'Pathao did not accept the shipment',
          response?.message ?? `Pathao responded with HTTP ${status}.`,
          String(status),
        );
      }

      // ---- 5. Confirmed: only now is it a real shipment ---------------
      const consignmentId = response.data.consignment_id;

      const { data: confirmed, error: confirmError } = await userClient.rpc('confirm_shipment', {
        p_shipment_id: ship.id,
        p_tracking_id: consignmentId,
        p_tracking_url: `https://courier.pathao.com/order/${consignmentId}`,
        p_courier_charge: response.data.delivery_fee ?? null,
        p_external_status: 'order.created',
        p_external_status_label: 'Shipment created',
        p_external_payload: response,
      });

      if (confirmError) {
        // The parcel EXISTS at Pathao but we failed to record it. Surface this
        // loudly: the seller must not re-send and create a duplicate parcel.
        return json(
          {
            error: 'confirm_failed',
            trackingId: consignmentId,
            message:
              'Pathao created the shipment but SellFlow could not record it. ' +
              'Do not send again - contact support with this tracking id.',
          },
          500,
        );
      }

      const confirmedRow = confirmed as Record<string, unknown>;

      // Mark the order shipped now that the parcel genuinely exists.
      await userClient.rpc('set_order_status', {
        p_order_id: body.orderId,
        p_to_status: 'shipped',
        p_note: 'Handed to Pathao',
      });

      return json({
        status: 'created',
        shipmentId: ship.id,
        trackingId: consignmentId,
        trackingUrl: `https://courier.pathao.com/order/${consignmentId}`,
        deliveryFee: response.data.delivery_fee ?? null,
        provider: 'pathao',
        createdBy: userId,
        state: confirmedRow.state,
      });
    } catch (error) {
      // ---- 6. Record the failure so the seller is not left guessing -----
      const courierError =
        error instanceof CourierError
          ? error
          : error instanceof CourierTimeoutError
            ? // The parcel may or may not exist. Say so plainly rather than
              // implying a clean failure, and leave the shipment retryable.
              new CourierError(
                'Pathao did not respond in time',
                'The parcel may or may not have been created. Check the Pathao merchant dashboard before sending it again, or retry in a moment.',
                'timeout',
              )
            : new CourierError('Could not reach Pathao', (error as Error).message);

      await userClient.rpc('fail_shipment', {
        p_shipment_id: ship.id,
        p_reason: courierError.detail,
        p_state: 'failed',
        p_external_status: null,
      });

      return json(
        { error: 'courier_failed', message: courierError.message, detail: courierError.detail },
        502,
      );
    }
  } catch (error) {
    return json(
      { error: 'unexpected', message: (error as Error).message },
      500,
    );
  }
});
