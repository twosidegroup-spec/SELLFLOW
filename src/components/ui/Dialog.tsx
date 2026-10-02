/**
 * Confirmation dialog and inline banners.
 *
 * `confirm` uses `Alert` on purpose. A destructive action should look and
 * behave like every other system dialog on the device -- the OS one is the only
 * option users already know how to dismiss, and it cannot be swiped away or
 * lost behind a keyboard by accident.
 */

import { Alert, StyleSheet, View } from 'react-native';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react-native';

import type { AppError } from '@/lib/errors';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

type BannerKind = 'success' | 'error' | 'info';

/**
 * Promise-based confirmation.
 *
 * Resolves true when confirmed, false when dismissed. Using the OS alert means
 * Android back and iOS swipe-down both mean "no", with no extra code.
 */
export function confirm(options: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      options.title,
      options.message,
      [
        { text: options.cancelLabel ?? 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        {
          text: options.confirmLabel ?? 'Confirm',
          style: options.destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      // Dismissed by the hardware back button or by tapping outside.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** Confirmation for a destructive, irreversible action. */
export function confirmDestructive(options: {
  title: string;
  message: string;
  confirmLabel?: string;
}): Promise<boolean> {
  return confirm({ ...options, destructive: true });
}

// ---------------------------------------------------------------------------
// Inline banners
// ---------------------------------------------------------------------------

/**
 * Non-blocking message inside a screen, e.g. a failed background sync.
 *
 * Errors that require the user to do something are rendered as a full-screen
 * state or a card, not a banner, so they cannot be missed.
 */
export function Banner({
  kind = 'info',
  title,
  style,
}: {
  kind?: BannerKind;
  title: string;
  style?: React.ComponentProps<typeof View>['style'];
}) {
  const { colors, radius, spacing } = useTheme();

  const palette = {
    success: { bg: colors.successSoft, fg: colors.success, Icon: CheckCircle2 },
    error: { bg: colors.dangerSoft, fg: colors.danger, Icon: AlertCircle },
    info: { bg: colors.primarySoft, fg: colors.primary, Icon: Info },
  } as const;

  const { bg, fg, Icon } = palette[kind];

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.banner,
        { backgroundColor: bg, borderRadius: radius.control, padding: spacing.sm, gap: spacing.xs },
        style,
      ]}
    >
      <Icon size={18} color={fg} strokeWidth={2} />
      <Text variant="caption" style={{ color: fg, flex: 1 }}>
        {title}
      </Text>
    </View>
  );
}

/** Renders an AppError as a banner, pairing the problem with the next step. */
export function ErrorBanner({ error, style }: { error: AppError; style?: React.ComponentProps<typeof View>['style'] }) {
  return <Banner kind="error" title={`${error.title}. ${error.action}`} style={style} />;
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
});
