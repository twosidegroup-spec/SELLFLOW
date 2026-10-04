/**
 * Wiring the native listener to the app.
 *
 * Two pieces of glue and nothing else:
 *
 *   * `useSmsDetectionStatus` -- what the seller is shown.
 *   * `useSmsListener` -- runs the pipeline, and only while signed in.
 *
 * The listener is mounted at the top of the authenticated stack rather than on the
 * status screen, because detection has to work while the seller is looking at an
 * order, not only while they are looking at Payments. It stops the moment the
 * session goes, so a signed-out device never holds a queue it cannot send.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';

import {
  acknowledgeCandidates,
  getListenerStatus,
  isNativeListenerAvailable,
  onQueueChanged,
  peekCandidates,
} from '@sellflow-sms';
import type { SmsListenerStatus } from '@sellflow-sms/types';

import { getSupabase } from '@/lib/supabase';
import { useConnectivity } from '@/lib/connectivity';
import { keys } from '@/lib/queryClient';
import {
  usePaymentAccounts,
  usePaymentActivity,
  usePaymentReview,
} from '@/features/payments/queries';
import { createSmsListener, type EngineResult, type SmsListener } from './listener';
import { readQueue, summarise, type QueueSnapshot } from './queue';
import { deriveDetectionStatus, type DetectionStatus } from './status';
import type { ConnectedAccount, SmsSendFailure } from './types';

/**
 * The Android release, for the support string on `payment_events.detected_by`.
 *
 * Deliberately the OS release and the app version only. A device fingerprint would
 * be more useful for support and is exactly the kind of thing this feature must
 * not collect.
 */
function androidRelease(): string {
  return Platform.OS === 'android' ? String(Platform.Version ?? 'unknown') : 'n/a';
}

function appVersion(): string {
  return String(Constants.expoConfig?.version ?? 'unknown');
}

/**
 * Asks the OS for RECEIVE_SMS.
 *
 * React Native's `PermissionsAndroid` already knows the constant, so there is no
 * second permission mechanism in the native module to keep in step, and no custom
 * dialog. The explanation the seller reads before this is called lives in
 * `payment-sms.tsx` -- the platform dialog is not a place to explain a permission.
 */
export async function requestSmsPermission(): Promise<'granted' | 'denied'> {
  if (Platform.OS !== 'android') return 'denied';
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
  );
  return result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
}

export async function readSmsPermission(): Promise<'granted' | 'denied'> {
  if (Platform.OS !== 'android') return 'denied';
  const granted = await PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
  );
  return granted ? 'granted' : 'denied';
}

function toConnectedAccounts(
  accounts: { id: string; provider: ConnectedAccount['provider']; account_number: string }[],
): ConnectedAccount[] {
  return accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    accountNumber: account.account_number,
  }));
}

/**
 * Runs detection while the app is usable.
 *
 * Everything the seller sees is backend truth; this only delivers events. It runs
 * on mount, on foreground, when connectivity returns, and when the receiver queues
 * something -- which is what covers "the app was closed and a payment arrived".
 */
export function useSmsListener(orgId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  const accounts = usePaymentAccounts(orgId);
  const online = useConnectivity((state) => state.online);

  const active = accounts.active;

  /*
   * The listener is built once and must read current values on every pass.
   *
   * Kept in a ref rather than threaded through `useMemo` dependencies on purpose:
   * depending on the account list would tear down and rebuild the listener every
   * time a query refetched, and the backoff timer with it. The ref is written in
   * an effect declared *before* the pass effect below, so it is already current by
   * the time any pass runs.
   */
  const latest = useRef<{
    orgId: string | undefined;
    online: boolean;
    accounts: ConnectedAccount[];
  }>({ orgId, online, accounts: toConnectedAccounts(active) });

  useEffect(() => {
    latest.current = { orgId, online, accounts: toConnectedAccounts(active) };
  }, [orgId, online, active]);

  const invalidate = useCallback(async () => {
    const id = latest.current.orgId ?? '';
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.paymentReview(id) }),
      queryClient.invalidateQueries({ queryKey: keys.paymentActivity(id) }),
      queryClient.invalidateQueries({ queryKey: keys.paymentAccounts(id) }),
      queryClient.invalidateQueries({ queryKey: ['payment-intents'] }),
      // Settlement moves money on an order.
      queryClient.invalidateQueries({ queryKey: ['orders'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['finance'] }),
    ]);
  }, [queryClient]);

  /*
   * Built lazily on first use rather than during render.
   *
   * It closes over the ref above, and creating a closure over a ref during render
   * is exactly what the compiler lint rule exists to catch: the value would be
   * captured at a moment when it is still the previous render's. Creating it inside
   * a callback means it is built when a pass actually runs, and the ref is current
   * by then.
   */
  const listenerRef = useRef<SmsListener | null>(null);

  const getListener = useCallback((): SmsListener => {
    if (!listenerRef.current) {
      listenerRef.current = createSmsListener({
        accounts: () => latest.current.accounts,
        online: () => latest.current.online,
        androidRelease,
        appVersion,
        ingest: async (args): Promise<EngineResult> => {
          const { data, error } = await getSupabase().rpc('ingest_payment_event', args);
          if (error) throw error;
          return (data ?? {}) as EngineResult;
        },
        match: async (eventId): Promise<EngineResult> => {
          const { data, error } = await getSupabase().rpc('match_payment_event', {
            p_event_id: eventId,
          });
          if (error) throw error;
          return (data ?? {}) as EngineResult;
        },
      });
    }
    return listenerRef.current;
  }, []);

  const running = useRef(false);

  const pass = useCallback(async () => {
    // One pass at a time. Two concurrent passes would race on the queue file and,
    // worse, put the same event on the wire twice.
    if (running.current || !latest.current.orgId) return;
    running.current = true;
    try {
      const listener = getListener();
      if (isNativeListenerAvailable) {
        const candidates = await peekCandidates();
        if (candidates.length > 0) {
          const { queued } = await listener.ingestNativeCandidates(candidates);
          // Acknowledge only what is durably in the JS queue. A redelivery is
          // harmless; a loss is not.
          if (queued > 0) {
            await acknowledgeCandidates(candidates.map((c) => c.fingerprint));
            await invalidate();
          }
        }
      }
      await listener.flush();
    } catch {
      // A pass that throws has already recorded its failure against its event, and
      // the next pass is scheduled by connectivity, foregrounding or the receiver.
    } finally {
      running.current = false;
    }
  }, [getListener, invalidate]);

  // Ticks for the backoff of a queued event on a device whose state never changes.
  useEffect(() => {
    if (!enabled || !orgId) return;
    const timer = setInterval(() => void pass(), 30_000);
    return () => clearInterval(timer);
  }, [enabled, orgId, pass]);

  useEffect(() => {
    if (!enabled || !orgId) return;
    void pass();
  }, [enabled, orgId, online, pass]);

  // Coming back to the foreground is when a queued payment usually goes out.
  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void pass();
    });
    return () => subscription.remove();
  }, [enabled, pass]);

  // The receiver queues while the app runs and nudges us here.
  useEffect(() => {
    if (!enabled) return;
    return onQueueChanged(() => void pass());
  }, [enabled, pass]);

  return { pass };
}

export interface SmsDetectionStatus {
  status: DetectionStatus;
  native: SmsListenerStatus | null;
  snapshot: QueueSnapshot;
  /** Most recent delivery failure code, or null. */
  lastFailure: SmsSendFailure | null;
  refresh: () => Promise<void>;
}

/**
 * The seller-facing view of payment automation.
 *
 * Combines three proven sources and nothing else: the native listener's own state,
 * the local delivery queue, and the engine's verdicts. The engine's status column
 * is what makes "Confirmed" honest -- the app cannot write it.
 */
export function useSmsDetectionStatus(orgId: string | undefined): SmsDetectionStatus {
  const accounts = usePaymentAccounts(orgId);
  const review = usePaymentReview(orgId);
  const activity = usePaymentActivity(orgId);

  const [native, setNative] = useState<SmsListenerStatus | null>(null);
  const [snapshot, setSnapshot] = useState<QueueSnapshot>(() => summarise([], Date.now()));
  const [lastFailure, setLastFailure] = useState<SmsSendFailure | null>(null);

  const refresh = useCallback(async () => {
    const [next, events] = await Promise.all([getListenerStatus(), readQueue()]);

    setNative(next);
    setSnapshot(summarise(events, Date.now()));

    // The most recent *event's* failure, not the first in the array: a queue that
    // recovered should stop reporting the problem.
    let newest: { detectedAt: string; code: SmsSendFailure } | null = null;
    for (const event of events) {
      if (!event.lastError) continue;
      if (!newest || event.detectedAt > newest.detectedAt) {
        newest = { detectedAt: event.detectedAt, code: event.lastError };
      }
    }
    setLastFailure(newest?.code ?? null);
  }, []);

  useEffect(() => {
    // Deferred by a tick rather than awaited in the effect body: the read touches
    // the native module and the disk, and doing it inline would mean an extra
    // render pass before the screen has anything to show.
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  const status = deriveDetectionStatus({
    nativeStatus: native,
    connectedAccounts: accounts.active.length,
    snapshot,
    lastEventStatus: activity.events[0]?.status ?? null,
    needsReview: review.count,
    lastFailure,
  });

  return { status, native, snapshot, lastFailure, refresh };
}