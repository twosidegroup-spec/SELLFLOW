/**
 * Main app stack.
 *
 * Guards the authenticated area and hosts the tab navigator plus the pushed
 * detail screens. Transitions are short native-stack slides: fast enough to feel
 * instant, and interruptible by an immediate back gesture.
 */

import { useEffect } from 'react';
import { Redirect, Stack } from 'expo-router';

import { ErrorState, LoadingState } from '@/components/ui';
import { useSession } from '@/store/session';

export default function AppLayout() {
  const status = useSession((state) => state.status);
  const storeId = useSession((state) => state.store?.id);
  const refreshWorkspace = useSession((state) => state.refreshWorkspace);
  const workspaceError = useSession((state) => state.workspaceError);

  // Record a successful sync as soon as the app becomes usable.
  useEffect(() => {
    if (storeId) void import('@/lib/connectivity').then((m) => m.useConnectivity.getState().markSynced());
  }, [storeId]);

  if (status === 'loading') return <LoadingState />;
  if (status === 'signed-out') return <Redirect href="/sign-in" />;
  if (status === 'needs-onboarding') return <Redirect href="/onboarding" />;

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

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
        animationDuration: 220,
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="analytics" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="finance" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="order/new" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="order/[id]" />
      <Stack.Screen name="product/new" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="product/[id]" />
      <Stack.Screen name="customer/new" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="customer/[id]" />
      <Stack.Screen name="expense/index" />
      <Stack.Screen name="expense/new" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="notifications" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="settings/business" />
      <Stack.Screen name="settings/account" />
      <Stack.Screen name="settings/appearance" />
      <Stack.Screen name="settings/notifications" />
      <Stack.Screen name="settings/data" />
      <Stack.Screen name="settings/support" />
    </Stack>
  );
}
