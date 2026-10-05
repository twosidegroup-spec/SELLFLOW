/**
 * The authenticated seller shell.
 *
 * Three responsibilities, in this order:
 *
 *   1. Decide whether a screen may render at all. Signed out, mid-resolution, or
 *      workspace-unavailable each get their own outcome, and none of them renders
 *      the tabs.
 *   2. Enforce the passcode gate. It lives here rather than in the tabs because this
 *      layout mounts nothing behind it: while the seller is locked, no screen in the
 *      stack has ever rendered, so there is no business data on screen to photograph
 *      over their shoulder.
 *   3. Host the navigation.
 *
 * ON `workspace-unavailable`
 *
 * A valid session whose business cannot be read is a CONNECTION problem, not an
 * authentication one. Sending it to sign-in tells a seller with a working password
 * that they signed out, and throws away the screen they were standing on. It gets
 * its own state with a retry.
 */

import { useEffect } from 'react';
import { Redirect, Stack } from 'expo-router';

import { ErrorState, LoadingState } from '@/components/ui';
import { useLock } from '@/store/lock';
import { useSession } from '@/store/session';

export default function AppLayout() {
  const status = useSession((state) => state.status);
  const userId = useSession((state) => state.user?.id);
  const refreshWorkspace = useSession((state) => state.refreshWorkspace);
  const workspaceError = useSession((state) => state.workspaceError);

  const hasPasscode = useLock((state) => state.hasPasscode);
  const isLocked = useLock((state) => state.isLocked);
  const isLockReady = useLock((state) => state.isReady);
  const hydrateLock = useLock((state) => state.hydrate);

  /*
   * Re-read the passcode record whenever the signed-in user changes.
   *
   * Namespaced per user id, so signing in as somebody else on a shared device
   * re-reads that person's record rather than inheriting the previous user's lock.
   */
  useEffect(() => {
    void hydrateLock(userId);
  }, [hydrateLock, userId]);

  if (status === 'loading') return <LoadingState />;
  if (status === 'signed-out') return <Redirect href="/sign-in" />;
  if (status === 'needs-onboarding') return <Redirect href="/register" />;

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
   * Held on a loading state rather than the keypad until the keystore has answered.
   * Rendering the keypad first would flash it at a seller who never set one.
   */
  if (!isLockReady) return <LoadingState />;

  if (hasPasscode && isLocked) return <Redirect href="/passcode" />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // Short native-stack slides: fast enough to feel instant, interruptible by an
        // immediate back gesture.
        animation: 'slide_from_right',
        animationDuration: 220,
      }}
    >
      <Stack.Screen name="(tabs)" />

      {/*
       * Detail and form routes.
       *
       * Pushed modals rather than pushed pages: a seller building an order wants
       * the order list behind them, and a full slide makes the form feel like it is
       * navigating away from the work. Forms are also the only routes that take an
       * `id` parameter, and the one that does (`product/[id]/edit`) verifies below
       * that the id belongs to this seller's tenant before it is used.
       */}
      <Stack.Screen name="order/new" options={{ presentation: 'modal' }} />
      <Stack.Screen name="order/[id]" />
      <Stack.Screen name="product/new" options={{ presentation: 'modal' }} />
      <Stack.Screen name="product/[id]" />
      <Stack.Screen name="product/[id]/edit" options={{ presentation: 'modal' }} />
      <Stack.Screen name="customer/new" options={{ presentation: 'modal' }} />
      <Stack.Screen name="customer/[id]" />
      <Stack.Screen name="customer/[id]/edit" options={{ presentation: 'modal' }} />

      <Stack.Screen name="settings/account" />
      <Stack.Screen name="settings/business" />
      <Stack.Screen name="settings/appearance" />
      <Stack.Screen name="settings/notifications" />
      <Stack.Screen name="settings/support" />
      <Stack.Screen name="settings/data" />
    </Stack>
  );
}