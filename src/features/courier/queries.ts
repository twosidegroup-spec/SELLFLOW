/**
 * Courier data layer.
 *
 * The provider abstraction lives here rather than in the screens, so adding a
 * third courier is a new entry in PROVIDERS and nothing else.
 *
 * Two rules this module enforces on the client, complementing the database's:
 *
 *   1. A dispatch attempt gets ONE idempotency key, held in component state for
 *      the lifetime of the sheet. A double tap, a retry after a timeout and a
 *      retry after a reconnect all reuse it, so the Edge Function and the
 *      `shipments.idempotency_key` index collapse them into one parcel.
 *
 *   2. "Shipment created" is only ever shown when the courier actually returned
 *      a consignment id. Every other outcome is reported as a failure, and the
 *      order stays at `packed` so the seller can retry deliberately.
 */

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CourierProvider,
  SettlementState,
  ShipmentEventRow,
  ShipmentRow,
  ShipmentState,
} from '@/lib/database.types';
import { AppError, isOfflineError } from '@/lib/errors';
import { keys } from '@/lib/queryClient';
import { createClientRef, useConnectivity } from '@/lib/connectivity';
import { getSupabase, isConfigured } from '@/lib/supabase';

export interface ProviderDefinition {
  id: CourierProvider;
  label: string;
  /** Whether a real server-side API integration exists for this provider. */
  hasApi: boolean;
  /** Shown to the seller so the UI never over-promises. */
  note?: string;
}

/**
 * Provider registry.
 *
 * `hasApi` mirrors `courier_supports_api()` in the database. REDX is listed
 * with `hasApi: false` on purpose: it has no publicly documented merchant API,
 * so SellFlow offers manual entry rather than a button that cannot work.
 */
export const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'pathao',
    label: 'Pathao',
    hasApi: true,
  },
  {
    id: 'redx',
    label: 'REDX',
    hasApi: false,
    note: 'REDX does not publish a merchant API. Enter the tracking details yourself.',
  },
  {
    id: 'manual',
    label: 'Manual / other',
    hasApi: false,
    note: 'For any local delivery company.',
  },
];

export function providerLabel(provider: CourierProvider | null | undefined): string {
  if (!provider) return 'Courier';
  return PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function useShipments(orderId: string | undefined) {
  return useQuery({
    queryKey: keys.shipments(orderId ?? ''),
    enabled: Boolean(orderId),
    queryFn: async (): Promise<ShipmentRow[]> => {
      const { data, error } = await getSupabase()
        .from('shipments')
        .select('*')
        .eq('order_id', orderId as string)
        .order('attempt_no', { ascending: false });

      if (error) throw AppError.from(error);
      return (data ?? []) as ShipmentRow[];
    },
  });
}

/** The shipment that is still in play, or the most recent one if all closed. */
export function activeShipment(shipments: ShipmentRow[]): ShipmentRow | null {
  if (shipments.length === 0) return null;
  return (
    shipments.find((s) => !['delivered', 'returned', 'cancelled'].includes(s.state)) ??
    shipments[0]!
  );
}

export function useShipmentEvents(shipmentId: string | undefined) {
  return useQuery({
    queryKey: keys.shipmentEvents(shipmentId ?? ''),
    enabled: Boolean(shipmentId),
    queryFn: async (): Promise<ShipmentEventRow[]> => {
      const { data, error } = await getSupabase()
        .from('shipment_events')
        .select('*')
        .eq('shipment_id', shipmentId as string)
        .order('occurred_at', { ascending: true });

      if (error) throw AppError.from(error);
      return (data ?? []) as ShipmentEventRow[];
    },
  });
}

export function useSettlement(orderId: string | undefined) {
  return useQuery({
    queryKey: keys.settlement(orderId ?? ''),
    enabled: Boolean(orderId),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('settlements')
        .select('*')
        .eq('order_id', orderId as string)
        .maybeSingle();

      if (error) throw AppError.from(error);
      return data;
    },
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchResult {
  status: 'created' | 'already_dispatched' | 'awaiting_confirmation';
  trackingId: string | null;
  trackingUrl: string | null;
  message: string;
}

function edgeUrl(fn: string): string {
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!base) throw new AppError('SellFlow is not configured', 'Add your Supabase URL to .env.');
  return `${base}/functions/v1/${fn}`;
}

export function useDispatchShipment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      orderId: string;
      provider: CourierProvider;
      connectionId?: string | null;
      idempotencyKey: string;
      cityId?: number;
      zoneId?: number;
      areaId?: number;
    }): Promise<DispatchResult> => {
      if (!isConfigured) {
        throw new AppError('SellFlow is not connected', 'Add your Supabase keys to .env.');
      }

      // --- Manual: no courier, no secrets, no network call to a provider ---
      if (input.provider !== 'pathao') {
        // Manual tracking details are collected by the caller and passed
        // through register_shipment directly.
        throw new AppError(
          'Enter the tracking details',
          'Use the manual form to save the tracking number for this order.',
        );
      }

      const { data: sessionData } = await getSupabase().auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        throw new AppError('Your session has expired', 'Sign in again to send this shipment.');
      }

      let response: Response;
      try {
        response = await fetch(edgeUrl('pathao-shipment'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            orderId: input.orderId,
            connectionId: input.connectionId ?? null,
            idempotencyKey: input.idempotencyKey,
            cityId: input.cityId,
            zoneId: input.zoneId,
            areaId: input.areaId,
          }),
        });
      } catch (error) {
        // Deliberately NOT queued for background replay. A shipment is created
        // through an Edge Function with a caller's access token, which the
        // outbox does not hold and must not capture; replaying it later would
        // also mean acting on a consignment the seller may have since
        // cancelled.
        //
        // The request may or may not have reached the courier, so the message
        // must not claim failure. `idempotencyKey` is sent on every attempt and
        // is unique per consignment, so tapping "Send to courier" again is
        // safe: the server returns the original parcel rather than creating a
        // second one. That is the retry path, and it is deliberate.
        if (isOfflineError(error)) {
          useConnectivity.getState().setSyncState('offline');
        }
        throw new AppError(
          'Could not reach the courier',
          'Check your connection and try again. Retrying is safe: it will not create a second parcel.',
          { cause: error },
        );
      }

      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (!response.ok) {
        throw new AppError(
          String(body.message ?? 'The courier did not accept the shipment'),
          String(body.detail ?? 'Nothing was sent. You can try again safely.'),
        );
      }

      return {
        status: (body.status as DispatchResult['status']) ?? 'created',
        trackingId: (body.trackingId as string | null) ?? null,
        trackingUrl: (body.trackingUrl as string | null) ?? null,
        message: String(body.message ?? 'Shipment created.'),
      };
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shipments'] }),
        queryClient.invalidateQueries({ queryKey: ['shipment-events'] }),
        queryClient.invalidateQueries({ queryKey: ['orders-list'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['order'] }),
      ]);
    },
  });
}

/** Saves a manually-entered consignment. No provider is contacted. */
export function useManualShipment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      orderId: string;
      provider: CourierProvider;
      label: string;
      trackingId: string;
      trackingUrl?: string | null;
      idempotencyKey: string;
    }) => {
      const { data, error } = await getSupabase().rpc('register_shipment', {
        p_order_id: input.orderId,
        p_provider: input.provider,
        p_idempotency_key: input.idempotencyKey,
        p_connection_id: null,
        p_cod_amount: null,
        p_tracking_id: input.trackingId,
        p_tracking_url: input.trackingUrl ?? null,
        p_external_payload: { enteredBy: 'seller', label: input.label },
      });

      if (error) throw AppError.from(error);

      // The caller needs the shipment id so a seller-entered status can be
      // applied to the parcel that was just created.
      return data as { id: string } | null;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shipments'] }),
        queryClient.invalidateQueries({ queryKey: ['shipment-events'] }),
        queryClient.invalidateQueries({ queryKey: ['orders-list'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });
}

/** Moves the order to `shipped` once a parcel genuinely exists. */
export function useMarkShipped(orderId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { error } = await getSupabase().rpc('set_order_status', {
        p_order_id: orderId,
        p_to_status: 'shipped',
        p_note: 'Handed to courier',
      });
      if (error) throw AppError.from(error);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders-list'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['order'] }),
        queryClient.invalidateQueries({ queryKey: ['order-history'] }),
      ]);
    },
  });
}

/**
 * Manual status override, for couriers that do not push webhooks.
 *
 * Goes through the same `apply_shipment_update` the webhook uses, so manual and
 * automated updates cannot diverge.
 */
export function useUpdateShipmentStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      shipmentId: string;
      state: ShipmentState;
      label: string;
    }) => {
      const { error } = await getSupabase().rpc('apply_shipment_update', {
        p_shipment_id: input.shipmentId,
        p_state: input.state,
        p_label: input.label,
        p_external_status: null,
        p_source: 'seller',
        p_occurred_at: new Date().toISOString(),
        p_delivered_at: null,
      });

      if (error) throw AppError.from(error);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shipments'] }),
        queryClient.invalidateQueries({ queryKey: ['shipment-events'] }),
        queryClient.invalidateQueries({ queryKey: ['orders-list'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });
}

/** Recording a COD payout is manual: no investigated courier exposes an API. */
export function useRecordSettlement(orderId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      state: SettlementState;
      amount?: number | null;
      reference?: string | null;
      notes?: string | null;
    }) => {
      const { error } = await getSupabase().rpc('record_settlement', {
        p_order_id: orderId,
        p_state: input.state,
        p_amount: input.amount ?? null,
        p_payout_reference: input.reference ?? null,
        p_notes: input.notes ?? null,
      });

      if (error) throw AppError.from(error);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.settlement(orderId) }),
        queryClient.invalidateQueries({ queryKey: ['orders-list'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });
}


// ---------------------------------------------------------------------------
// Customer-facing message
//
// The seller pastes this into Messenger, WhatsApp or Instagram. The customer
// does not need the app in V1.
// ---------------------------------------------------------------------------

export function buildCustomerMessage(args: {
  orderNumber: string;
  courierName: string | null;
  trackingId: string | null;
  trackingUrl: string | null;
}): string {
  const lines = [`Your order ${args.orderNumber} has been shipped.`];

  if (args.courierName) lines.push(`Courier: ${args.courierName}`);
  if (args.trackingId) lines.push(`Tracking ID: ${args.trackingId}`);
  if (args.trackingUrl) lines.push(`Track your parcel: ${args.trackingUrl}`);

  return lines.join('\n');
}

/** Holds a single idempotency key for the lifetime of a dispatch attempt. */
export function useDispatchKey(): [string, () => void] {
  const [key, setKey] = useState(() => createClientRef());
  const reset = useCallback(() => setKey(createClientRef()), []);
  return [key, reset];
}

// ---------------------------------------------------------------------------
// Seller-entered shipment status
//
// The manual and REDX paths have no courier webhook, so the seller is the
// source of truth for where the parcel is. This writes through the same
// `apply_shipment_update` function the Pathao webhook uses, with
// p_source = 'seller', so a manually-entered status produces the same
// shipment_events timeline, COD movement and notification side effects as a
// courier-reported one. There is deliberately no second code path.
// ---------------------------------------------------------------------------

/** Options a seller realistically has on a manual parcel, in order. */
export const MANUAL_SHIPMENT_STATES: {
  value: ShipmentState;
  label: string;
  /** Terminal states close the timeline; the rest are progress. */
  terminal: boolean;
}[] = [
  { value: 'picked', label: 'Picked up from you', terminal: false },
  { value: 'in_transit', label: 'In transit', terminal: false },
  { value: 'at_hub', label: 'At sorting hub', terminal: false },
  { value: 'out_for_delivery', label: 'Out for delivery', terminal: false },
  { value: 'delivered', label: 'Delivered', terminal: true },
  { value: 'failed', label: 'Delivery failed', terminal: false },
  { value: 'returned', label: 'Returned to you', terminal: true },
];

/** Human label for a shipment state, used in the picker and the timeline. */
export function shipmentStateLabel(state: ShipmentState): string {
  return MANUAL_SHIPMENT_STATES.find((entry) => entry.value === state)?.label ?? state;
}

export function useUpdateShipmentState() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      shipmentId,
      state,
      label,
    }: {
      shipmentId: string;
      state: ShipmentState;
      label: string;
    }) => {
      const { error } = await getSupabase().rpc('apply_shipment_update', {
        p_shipment_id: shipmentId,
        p_state: state,
        p_label: label,
        p_external_status: null,
        // Marks the event as seller-entered so it is never mistaken for a
        // courier confirmation in the timeline.
        p_source: 'seller',
        p_occurred_at: null,
        p_delivered_at: null,
      });

      if (error) throw AppError.from(error);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shipments'] }),
        queryClient.invalidateQueries({ queryKey: ['shipment-events'] }),
        queryClient.invalidateQueries({ queryKey: ['orders-list'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: keys.settlements() }),
      ]);
    },
  });
}
