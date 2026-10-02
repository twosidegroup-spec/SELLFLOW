/**
 * Auth group layout.
 *
 * Guards against a signed-in user seeing the sign-in form. Onboarding is
 * intentionally NOT reachable from here -- it is reached from `index`, which is
 * the single place that decides what "signed in but no business" means.
 */

import { useEffect } from 'react';
import { Redirect, Stack } from 'expo-router';

import { useSession } from '@/store/session';

export default function AuthLayout() {
  const status = useSession((state) => state.status);

  useEffect(() => {
    // Nothing to set up; the guard below is the whole responsibility.
  }, []);

  if (status === 'ready' || status === 'needs-onboarding') {
    return <Redirect href="/" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="sign-up" />
      <Stack.Screen name="forgot-password" />
    </Stack>
  );
}
