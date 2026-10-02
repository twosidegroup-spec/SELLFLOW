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
  const systemScheme = useColorScheme();

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

  if (!fontsLoaded && !fontError) {
    // ThemeProvider is not mounted yet, so the raw tokens are used directly.
    // Hardcoding the light background here would give a dark-mode user a white
    // flash on every cold start, which is the exact problem this avoids.
    const resolved: 'light' | 'dark' =
      appearance === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : appearance;

    return <View style={[styles.blank, { backgroundColor: resolved === 'dark' ? darkColors.background : lightColors.background }]} />;
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider preference={appearance}>
            <StatusBarBridge />
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="(auth)" />
              <Stack.Screen name="onboarding" />
              <Stack.Screen name="(app)" />
              {/* Reachable without a session: a customer filling the order form
                  the seller sent them. */}
              <Stack.Screen name="order-form/[token]" />
            </Stack>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
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
