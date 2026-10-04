/**
 * Main app stack.
 *
 * Guards the authenticated area and hosts the tab navigator plus the pushed
 * detail screens. Transitions are short native-stack slides: fast enough to feel
 * instant, and interruptible by an immediate back gesture.
 *
 * Also the passcode gate. It lives here rather than in a tab because this
 * layout unmounts nothing behind it: when the seller is locked, no screen in
 * the stack has rendered, so no dashboard data is on screen to be photographed
 * over their shoulder.
 */

import { useEffect, useRef } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { Redirect, Stack } from 'expo-router';

import { ErrorState, LoadingState } from '@/components/ui';
import { WebShell } from '@/components/web/WebShell';
import { useSmsListener } from '@/features/payments/sms/hooks';
import { useLock } from '@/store/lock';
import { useSession } from '@/store/session';

/*
 * Page transitions are a native affordance and are switched off on web.
 *
 * A slide is meaningful on a phone, where the screen you came from is still
 * physically beside the one you are going to. In a browser it is not: the previous
 * page is gone and is reachable through Back, so animating the new one in only
 * delays it and implies a stack the web build does not have. `none` is also what
 * makes deep links and refreshes land instantly instead of after 220ms of nothing.
 */
const isWeb = Platform.OS === 'web';
const pushAnimation = isWeb ? 'none' : 'slide_from_right';
const modalAnimation = isWeb ? 'none' : 'slide_from_bottom';

export default function AppLayout() {
  const status = useSession((state) => state.status);
  const storeId = useSession((state) => state.store?.id);
  const userId = useSession((state) => state.user?.id);
  const organizationId = useSession((state) => state.organization?.id);
  const refreshWorkspace = useSession((state) => state.refreshWorkspace);
  const workspaceError = useSession((state) => state.workspaceError);

  /*
   * The native payment listener lives here, not on the detection screen.
   *
   * Detection has to work while the seller is looking at an order, not only while
   * they happen to be looking at Payments, so it is mounted for the whole
   * authenticated session. It is stopped the moment the session is not `ready`,
   * so a signed-out device never holds a queue of events it cannot send.
   */
  useSmsListener(organizationId, status === 'ready');

  const hasPasscode = useLock((state) => state.hasPasscode);
  const isLocked = useLock((state) => state.isLocked);
  const isLockReady = useLock((state) => state.isReady);
  const hydrateLock = useLock((state) => state.hydrate);
  const lockNow = useLock((state) => state.lockNow);

  // Record a successful sync as soon as the app becomes usable.
  useEffect(() => {
    if (storeId) void import('@/lib/connectivity').then((m) => m.useConnectivity.getState().markSynced());
  }, [storeId]);

  // Read the stored passcode whenever the signed-in user changes.
  useEffect(() => {
    void hydrateLock(userId);
  }, [hydrateLock, userId]);

  /*
   * Lock again when the app has been away long enough to have been handed to
   * somebody else. A short grace period means switching apps to check a number
   * does not demand the passcode on every return.
   *
   * The timer is stamped on the transition to background rather than on resume,
   * so a phone that stayed unlocked in the background for an hour locks on the
   * way out, not on the way back in.
   */
  const backgroundedAt = useRef<number | null>(null);
  const GRACE_MS = 60_000;

  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        if (backgroundedAt.current === null) backgroundedAt.current = Date.now();
        return;
      }
      if (next === 'active') {
        const left = backgroundedAt.current;
        backgroundedAt.current = null;
        if (left !== null && Date.now() - left > GRACE_MS) lockNow();
      }
    };

    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, [lockNow]);

  if (status === 'loading') return <LoadingState />;
  if (status === 'signed-out') return <Redirect href="/sign-in" />;
  if (status === 'needs-onboarding') return <Redirect href="/register" />;

  // A failed workspace read is a connection problem, not an authentication
  // one, and must not send the seller back to a sign-in form they do not need.
  if (status === 'workspace-unavailable') {
    return (
      <ErrorState
        title={workspaceError?.title ?? 'Could not reach your business'}
        action={workspaceError?.action ?? 'Check your connection and try again.'}
        onRetry={() => void refreshWorkspace()}
      />
    );
  }

  /*
   * Held on a loading state rather than the lock screen until SecureStore has
   * answered. Rendering the keypad before we know whether a passcode exists
   * would flash a keypad at a seller who never set one.
   */
  if (!isLockReady) return <LoadingState />;
  if (hasPasscode && isLocked) return <Redirect href="/passcode" />;

  /*
   * The desktop shell wraps the whole stack, not just the tabs.
   *
   * Anchoring it to the tab layout looked right and was wrong: every screen pushed
   * above the tabs -- Finance, Analytics, Expenses, Notifications, all of Settings,
   * and the payment screens -- rendered full-bleed with no sidebar and no way to
   * move except the browser back button. On a desktop that is a dead end.
   *
   * `WebShell` returns its children untouched below the breakpoint, so the phone
   * and tablet layouts are unchanged by any of this.
   */
  return (
    <WebShell>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: pushAnimation,
          animationDuration: 220,
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="analytics" options={{ animation: modalAnimation }} />
        <Stack.Screen name="finance" options={{ animation: modalAnimation }} />
        <Stack.Screen name="order/new" options={{ animation: modalAnimation }} />
        <Stack.Screen name="order/[id]" />
        <Stack.Screen name="product/new" options={{ animation: modalAnimation }} />
        <Stack.Screen name="product/[id]" />
        <Stack.Screen name="customer/new" options={{ animation: modalAnimation }} />
        <Stack.Screen name="customer/[id]" />
        <Stack.Screen name="expense/index" />
        <Stack.Screen name="expense/new" options={{ animation: modalAnimation }} />
        {/* Payment detection engine. The hub and the queue are screens you read;
            the two forms slide from the bottom like every other form here. */}
        <Stack.Screen name="payments" />
        <Stack.Screen name="payment-review" />
        <Stack.Screen name="payment-sms" />
        <Stack.Screen name="payment-account/new" options={{ animation: modalAnimation }} />
        <Stack.Screen name="payment-intent/new" options={{ animation: modalAnimation }} />
        <Stack.Screen name="notifications" options={{ animation: modalAnimation }} />
        <Stack.Screen name="settings/business" />
        <Stack.Screen name="settings/account" />
        <Stack.Screen name="settings/appearance" />
        <Stack.Screen name="settings/notifications" />
        <Stack.Screen name="settings/data" />
        <Stack.Screen name="settings/support" />
      </Stack>
    </WebShell>
  );
}
