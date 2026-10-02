/**
 * Connectivity banner.
 *
 * One global strip under the header, and it stays silent when there is nothing
 * to say. A permanent "you are online" bar is noise, so the idle case renders
 * nothing at all.
 *
 * The three states a seller actually needs to be told about:
 *
 *   offline   You are working from cached data and your changes are held.
 *             This is the dangerous one: without it, a seller keeps taking
 *             orders believing they are saved.
 *   syncing   Their queued work is going out right now.
 *   back      It worked. A short green confirmation, because recovery is
 *   online    otherwise silent -- nothing on screen changed, so the seller has
 *             no way to know whether their queued orders went through.
 *
 * The colour is load-bearing rather than decorative: amber/rose for a problem,
 * green for confirmation. It is reinforced with an icon and words so it does
 * not rely on colour alone.
 */

import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Check, CloudOff, RefreshCw } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { RECONNECT_NOTICE_MS, useConnectivity } from '@/lib/connectivity';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from '@/components/ui';

type Tone = 'offline' | 'syncing' | 'success';

export function ConnectionBanner() {
  const online = useConnectivity((state) => state.online);
  const pending = useConnectivity((state) => state.pending);
  const syncState = useConnectivity((state) => state.syncState);
  const justReconnected = useConnectivity((state) => state.justReconnected);
  const acknowledge = useConnectivity((state) => state.acknowledgeReconnect);

  const { colors, spacing } = useTheme();

  const queued = pending.length;

  // The recovery notice is a moment, not a state. It clears itself so the strip
  // cannot sit there saying "Back online" over a screen that has been fine for
  // an hour.
  useEffect(() => {
    if (!justReconnected) return;
    const timer = setTimeout(acknowledge, RECONNECT_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [justReconnected, acknowledge]);

  // Reconnecting is good news; a short haptic is the confirmation that matches
  // the banner arriving.
  useEffect(() => {
    if (!justReconnected) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [justReconnected]);

  let tone: Tone | null = null;
  let message: string | null = null;

  if (!online) {
    tone = 'offline';
    message =
      queued > 0
        ? `No network connection. ${queued} change${queued === 1 ? '' : 's'} will sync when you reconnect.`
        : 'No network connection. Showing your last synced data.';
  } else if (justReconnected) {
    tone = 'success';
    message =
      queued > 0
        ? `Back online. Syncing ${queued} queued change${queued === 1 ? '' : 's'}.`
        : 'Back online. Everything is up to date.';
  } else if (queued > 0 || syncState === 'syncing') {
    tone = 'syncing';
    message =
      queued > 0
        ? `Syncing ${queued} queued change${queued === 1 ? '' : 's'}...`
        : 'Syncing...';
  }

  // Nothing to communicate.
  if (tone === null || message === null) return null;

  const palette =
    tone === 'offline'
      ? { bg: colors.warningSoft, fg: colors.warningStrong, border: colors.warning }
      : tone === 'success'
        ? { bg: colors.successSoft, fg: colors.successStrong ?? colors.success, border: colors.success }
        : { bg: colors.primarySoft, fg: colors.primary, border: colors.primary };

  const Icon = tone === 'offline' ? CloudOff : tone === 'success' ? Check : RefreshCw;

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[
        styles.container,
        {
          backgroundColor: palette.bg,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.xs,
          marginHorizontal: spacing.lg,
          marginTop: spacing.xs,
          marginBottom: 0,
          borderRadius: 10,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.border,
        },
      ]}
    >
      <Icon size={14} color={palette.fg} strokeWidth={2.5} />
      <Text variant="micro" numberOfLines={2} style={{ color: palette.fg, flex: 1 }}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: '100%',
  },
});