/**
 * Connectivity and sync state.
 *
 * SellFlow targets sellers on patchy mobile data, so the app must degrade
 * honestly rather than pretend. The rules this module enforces:
 *
 *   1. Reads come from the local cache first and refresh in the background, so
 *      the app opens instantly and works offline.
 *   2. A write is NEVER reported as successful unless the server persisted it.
 *   3. Only *idempotent* writes are queued for retry.
 *
 * Rule 3 is the important one, and it is a deliberate restriction rather than a
 * gap. A queued operation is replayed later, possibly twice, possibly after a
 * restart -- so anything non-idempotent must never enter the queue:
 *
 *   create_order      SAFE. `orders.client_ref` is unique, so a replay returns
 *                     the original order instead of creating a second one.
 *   set_order_status  SAFE. set_order_status() returns early when the order is
 *                     already in the requested status.
 *   adjust_stock      NOT SAFE. A delta applied twice silently corrupts stock.
 *   record_payment    NOT SAFE. A second row would double-charge the customer.
 *
 * The unsafe operations therefore fail loudly with an actionable message rather
 * than being "helpfully" retried. Losing a queued action is recoverable; a
 * corrupted inventory balance or a double charge is not.
 */

import { create } from 'zustand';
import * as Network from 'expo-network';

import type { Json } from './database.types';
import { readJson, writeJson, StorageKeys } from './storage';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

/**
 * Kinds that may be queued. Adding to this list requires proving the operation
 * is safe to run more than once.
 */
export type ReplayableKind = 'create_order' | 'set_order_status';

/** Arguments for `create_order`. Amounts are integer minor units. */
export interface CreateOrderPayload {
  storeId: string;
  customerId: string | null;
  items: { product_id: string; variant_id: string | null; quantity: number; line_discount: number }[];
  discount: number;
  deliveryCharge: number;
  amountPaid: number;
  paymentMethod: string;
  notes: string | null;
  clientRef: string;
}

export interface SetOrderStatusPayload {
  orderId: string;
  status: string;
  note: string | null;
}

export interface PendingMutation {
  id: string;
  kind: ReplayableKind;
  /** Human-readable summary shown in Settings -> Data. */
  summary: string;
  createdAt: string;
  attempts: number;
  /**
   * Everything needed to reissue the call. Without this the queue is only a
   * counter -- it cannot actually replay anything.
   */
  payload: Json;
}

interface ConnectivityState {
  online: boolean;
  syncState: SyncState;
  pending: PendingMutation[];
  lastSyncAt: string | null;
  /**
   * True for a few seconds after coming back online.
   *
   * Needed because "online" alone cannot be acknowledged. The moment a device
   * reconnects there is nothing on screen that changed, so the seller cannot
   * tell whether their queued work went through or whether the app is simply
   * still offline. A brief positive state is the only way to confirm recovery
   * rather than leave the seller guessing.
   */
  justReconnected: boolean;

  setOnline: (online: boolean) => void;
  acknowledgeReconnect: () => void;
  setSyncState: (state: SyncState) => void;
  markSynced: () => Promise<void>;
  enqueue: (mutation: PendingMutation) => Promise<void>;
  dequeue: (id: string) => Promise<void>;
  /** Records a failed attempt without discarding the mutation. */
  recordAttempt: (id: string) => Promise<void>;
  clearQueue: () => Promise<void>;
}

/** How long the "back online" confirmation stays up. */
export const RECONNECT_NOTICE_MS = 4000;

export const useConnectivity = create<ConnectivityState>((set, get) => ({
  // Optimistic default. The listener corrects it within a few hundred ms, and
  // starting optimistic avoids a "you are offline" flash on a good connection.
  online: true,
  syncState: 'idle',
  pending: [],
  lastSyncAt: null,
  justReconnected: false,

  setOnline: (online) => {
    const { syncState, online: wasOnline } = get();
    // Only a genuine offline -> online edge sets the notice. React Native's
    // network listener re-fires with the same value on interface changes, and
    // treating every event as a reconnect would flash "Back online" forever.
    const reconnected = !wasOnline && online;

    set({
      online,
      // Only a genuine offline -> online edge sets the notice. React Native's
      // network listener re-fires with the same value on interface changes, and
      // treating every event as a reconnect would flash "Back online" forever.
      //
      // Losing the connection clears it rather than holding it: a link that
      // drops for a moment and comes back would otherwise celebrate recovery
      // twice, and a flag left set while offline is a success haptic fired at
      // the worst possible moment.
      justReconnected: reconnected,
      // Only downgrade to 'offline'; never mask an in-progress sync.
      syncState: !online
        ? syncState !== 'syncing'
          ? 'offline'
          : syncState
        : // Coming back online must clear 'offline' again. Leaving it set is a
          // lie in the state, and any other reader of syncState -- not just the
          // banner -- would conclude the app was still disconnected.
          syncState === 'offline'
          ? 'idle'
          : syncState,
    });
  },

  acknowledgeReconnect: () => set({ justReconnected: false }),

  setSyncState: (syncState) => set({ syncState }),

  markSynced: async () => {
    const at = new Date().toISOString();
    await writeJson(StorageKeys.lastSyncAt, at);
    set({ lastSyncAt: at, syncState: 'idle' });
  },

  enqueue: async (mutation) => {
    const next = [...get().pending, mutation];
    await writeJson(StorageKeys.pendingMutations, next);
    set({ pending: next });
  },

  dequeue: async (id) => {
    const next = get().pending.filter((mutation) => mutation.id !== id);
    await writeJson(StorageKeys.pendingMutations, next);
    set({ pending: next });
  },

  recordAttempt: async (id) => {
    const next = get().pending.map((mutation) =>
      mutation.id === id ? { ...mutation, attempts: mutation.attempts + 1 } : mutation,
    );
    await writeJson(StorageKeys.pendingMutations, next);
    set({ pending: next });
  },

  clearQueue: async () => {
    await writeJson(StorageKeys.pendingMutations, []);
    set({ pending: [] });
  },
}));

/**
 * Subscribe to device connectivity.
 *
 * Returns an unsubscribe function. Call it from a top-level effect; calling it
 * per screen causes the listener to be registered repeatedly.
 */
export function startConnectivityWatch(): () => void {
  let cancelled = false;

  const apply = (online: boolean) => {
    if (!cancelled) useConnectivity.getState().setOnline(online);
  };

  void Network.getNetworkStateAsync()
    .then((state) => apply(Boolean(state.isConnected && state.isInternetReachable !== false)))
    .catch(() => apply(true));

  const subscription = Network.addNetworkStateListener((state) => {
    apply(Boolean(state.isConnected && state.isInternetReachable !== false));
  });

  return () => {
    cancelled = true;
    subscription.remove();
  };
}

/** Restores the outbox from disk at startup. */
export async function hydrateConnectivity(): Promise<void> {
  const [pending, lastSyncAt] = await Promise.all([
    readJson<PendingMutation[]>(StorageKeys.pendingMutations),
    readJson<string>(StorageKeys.lastSyncAt),
  ]);

  useConnectivity.setState({
    pending: pending ?? [],
    lastSyncAt: lastSyncAt ?? null,
  });
}

/**
 * Client-generated idempotency key.
 *
 * Used as `client_ref` when creating an order. A retry after a dropped
 * connection therefore returns the original order instead of duplicating it.
 * Shaped as a v4 UUID because `orders.client_ref` is a uuid column and
 * Postgres will reject anything else.
 */
export function createClientRef(): string {
  const hex = (length: number): string => {
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
  };

  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

/** Stable key for a locally-queued mutation. Not sent to the server. */
export function createMutationId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}
/*
 * Dev-only handle on the store.
 *
 * Lets the browser-driven checks force a network transition, which is the only
 * practical way to assert the offline and recovery visuals on a desktop where
 * you cannot genuinely drop the connection. Metro replaces `__DEV__` with a
 * literal at build time so this whole block is stripped from a release bundle;
 * the `typeof` guard is what keeps it from throwing under the Node test loader,
 * where the global does not exist at all.
 */
if (typeof __DEV__ !== 'undefined' && __DEV__) {
  (globalThis as unknown as { __sellflowConnectivity?: typeof useConnectivity }).__sellflowConnectivity =
    useConnectivity;
}