/**
 * Root layout — SellFlow V2.
 *
 * Owns only global concerns, in the order they must happen:
 *
 *   fonts → theme → storage → Supabase → session → routes
 *
 * Three guarantees hold no matter where that sequence fails:
 *
 *   1. No blank screen, ever. `BootErrorBoundary` catches a render error and
 *      `useBootWatchdog` bounds a hung startup. Both were absent in V1.
 *   2. No white flash. The pre-font placeholder paints the resolved background
 *      rather than a hardcoded colour, so a dark-mode user never sees white.
 *   3. A missing backend is stated, not worked around. `SetupRequired` names the
 *      problem instead of letting every query fail with an opaque network error.
 */

import { useEffect } from 'react';
import { useColorScheme, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';

import { BootErrorBoundary } from '@/components/BootError';
import { ErrorState } from '@/components/ui/Feedback';
import { attemptKey, useBootWatchdog } from '@/lib/bootWatchdog';
import { hydrateConnectivity, startConnectivityWatch } from '@/lib/connectivity';
import { startOutboxReplay } from '@/lib/outbox';
import { queryClient } from '@/lib/queryClient';
import { getSupabase, isConfigured } from '@/lib/supabase';
import { useAppearance } from '@/store/appearance';
import { useSession } from '@/store/session';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { darkColors, lightColors } from '@/theme/tokens';

// Hold the splash until fonts are ready, so the first frame is not rendered in a
// fallback face and then re-laid out.
void SplashScreen.preventAutoHideAsync().catch(() => {
  // Already hidden; nothing to do.
});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    'Inter-Regular': require('../../assets/fonts/Inter-Regular.ttf'),
    'Inter-Medium': require('../../assets/fonts/Inter-Medium.ttf'),
    'Inter-SemiBold': require('../../assets/fonts/Inter-SemiBold.ttf'),
    'Inter-Bold': require('../../assets/fonts/Inter-Bold.ttf'),
  });

  const appearance = useAppearance((state) => state.preference);
  // Android reports 'unspecified' when the system expresses no preference, which
  // is neither light nor dark and so cannot select a palette. Treated as light.
  const systemScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const authStatus = useSession((state) => state.status);

  // Restore the saved preference before the first themed render.
  useEffect(() => {
    void useAppearance.getState().hydrate();
  }, []);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, fontError]);

  // Restore the outbox, then watch connectivity for the app's lifetime.
  useEffect(() => {
    void hydrateConnectivity();
    return startConnectivityWatch();
  }, []);

  // Replay anything queued while offline. Started once, here, rather than per
  // screen, because that is what makes the offline banner's promise true.
  useEffect(() => startOutboxReplay(), []);

  // Seed the session and follow every auth change.
  useEffect(() => {
    void useSession.getState().bootstrap();

    if (!isConfigured) return;

    const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
      void useSession.getState().handleSession(session);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  /*
   * Startup is "done" once the app knows who it is talking to. `loading` is the
   * only state that can hang indefinitely.
   *
   * `!isConfigured` also counts as settled, because the index route renders
   * `SetupRequired` for it -- a finished screen, not a pending one. Treating it
   * as pending would put a countdown in front of a message already on screen.
   */
  const startupSettled = authStatus !== 'loading' || !isConfigured;
  const boot = useBootWatchdog(startupSettled);

  if (!fontsLoaded && !fontError) {
    const resolved = appearance === 'system' ? systemScheme : appearance;
    return (
      <View
        style={{
          flex: 1,
          backgroundColor:
            resolved === 'dark' ? darkColors.background : lightColors.background,
        }}
      />
    );
  }

  /*
   * The boundary sits ABOVE ThemeProvider, deliberately. Its fallback reads raw
   * tokens rather than calling useTheme, because a boundary mounted below the
   * provider would re-enter itself whenever the theme was what failed -- turning
   * one caught error into a second uncaught one, and still a blank screen.
   */
  return (
    <BootErrorBoundary preference={appearance} systemScheme={systemScheme}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider preference={appearance}>
              <StatusBarBridge />
              {boot.phase === 'timed-out' ? (
                <BootTimeoutScreen key={attemptKey(boot.attempt)} onRetry={boot.retry} />
              ) : (
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: 'transparent' },
                  }}
                >
                  <Stack.Screen name="index" />
                </Stack>
              )}
            </ThemeProvider>
          </QueryClientProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </BootErrorBoundary>
  );
}

/** Keeps the native status bar legible against the active theme. */
function StatusBarBridge() {
  const { scheme } = useTheme();
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />;
}

/**
 * Shown when startup exceeded its deadline.
 *
 * Distinct wording from a crash, because the diagnosis differs: nothing failed,
 * something is slow. That the data is safe is true in both cases and worth
 * stating either way.
 */
function BootTimeoutScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      title="SellFlow is taking longer than usual to start"
      action="This usually means the connection is slow. Nothing has been lost — your orders, products and payments are still saved."
      onRetry={onRetry}
      retryLabel="Try again"
    />
  );
}