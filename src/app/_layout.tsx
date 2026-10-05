/**
 * Root layout.
 *
 * Owns only global concerns: fonts, theme, query client, connectivity watching
 * and the Supabase auth listener. Route protection lives in the group layouts
 * (`(auth)` and `(app)`), which is where it can be read alongside the routes it
 * guards.
 */

import { useEffect } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';

import { BootErrorBoundary } from '@/components/BootError';
import { ErrorState } from '@/components/ui';
import { attemptKey, useBootWatchdog } from '@/lib/bootWatchdog';
import { hydrateConnectivity, startConnectivityWatch } from '@/lib/connectivity';
import { startOutboxReplay } from '@/lib/outbox';
import { queryClient } from '@/lib/queryClient';
import { getSupabase, isConfigured } from '@/lib/supabase';
import { useAppearance } from '@/store/appearance';
import { useSession } from '@/store/session';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { darkColors, lightColors } from '@/theme/tokens';

// Hold the splash until fonts are ready, so the first frame is not rendered in
// a fallback face and then re-laid out.
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
  // Android reports 'unspecified' when the system has no preference set, which is
  // neither light nor dark and so cannot select a palette. Treated as light.
  const systemScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const authStatus = useSession((state) => state.status);

  // Restore the saved preference before the first themed render, so a dark-mode
  // user never sees a white flash.
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

  // Replay anything that was queued while offline. This is what makes the
  // offline banner's promise true, so it is started once, here, rather than
  // per screen.
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
   * Startup watchdog.
   *
   * "Startup is done" means the app knows who it is talking to. `loading` is the
   * only state where a wait can hang indefinitely: every other state has already
   * resolved to a decision the router can act on.
   *
   * `!isConfigured` also counts as satisfied, because `index.tsx` renders
   * `SetupRequired` for it. That is a finished screen, not a pending one, and
   * treating it as pending would put a 15-second timer in front of a message that
   * is already on screen.
   */
  const startupSettled = authStatus !== 'loading' || !isConfigured;
  const boot = useBootWatchdog(startupSettled);

  if (!fontsLoaded && !fontError) {
    // ThemeProvider is not mounted yet, so the raw tokens are used directly.
    // Hardcoding the light background here would give a dark-mode user a white
    // flash on every cold start, which is the exact problem this avoids.
    const resolved: 'light' | 'dark' =
      appearance === 'system' ? systemScheme : appearance;

    return <View style={[styles.blank, { backgroundColor: resolved === 'dark' ? darkColors.background : lightColors.background }]} />;
  }

  /*
   * Above ThemeProvider, deliberately. A boundary below it would read from a
   * theme context that may itself be what failed, turning a caught render error
   * into a second uncaught one and still producing a blank screen.
   */
  return (
    <BootErrorBoundary preference={appearance} systemScheme={systemScheme}>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider preference={appearance}>
              <StatusBarBridge />
              {/*
                The watchdog renders beside the navigator rather than around it,
                so a timeout does not tear down a half-mounted navigation stack.
                `BootTimeoutScreen` is keyed by attempt so a retry remounts the
                whole subtree and re-runs session bootstrap from scratch.
              */}
              {boot.phase === 'timed-out' ? (
                <BootTimeoutScreen key={attemptKey(boot.attempt)} onRetry={boot.retry} />
              ) : (
                <Stack
                  screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }}
                >
                  <Stack.Screen name="index" />
                  <Stack.Screen name="(auth)" />
                  {/*
                    The single registration flow. Outside the (auth) group on purpose:
                    it has to keep rendering across the moment signUp succeeds and the
                    session flips to "signed in, no business yet", which the (auth)
                    guard would otherwise treat as a reason to leave.
                  */}
                  <Stack.Screen name="register" />
                  {/* Passcode gate and setup. Both need a valid session; the app
                      layout redirects to /passcode when a passcode is locked. */}
                  <Stack.Screen name="passcode" />
                  <Stack.Screen name="set-passcode" />
                  <Stack.Screen name="(app)" />
                  {/* Reachable without a session: a customer filling the order form
                      the seller sent them. */}
                  <Stack.Screen name="order-form/[token]" />
                </Stack>
              )}
            </ThemeProvider>
          </QueryClientProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </BootErrorBoundary>
  );
}

/**
 * Shown when startup exceeded its deadline.
 *
 * Distinct wording from a crash, because the diagnosis differs: nothing has
 * failed, something is slow. Telling a seller their data is safe is true in both
 * cases and worth stating either way.
 */
function BootTimeoutScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      title="SellFlow is taking longer than usual to start"
      action="This usually means the connection is slow. Nothing has been lost -- your orders, products and payments are still saved."
      onRetry={onRetry}
      retryLabel="Try again"
    />
  );
}

/** Keeps the native status bar legible against the active theme. */
function StatusBarBridge() {
  const { scheme } = useTheme();
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  blank: { flex: 1 },
});
