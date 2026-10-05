/**
 * Button primitive.
 *
 * One component for every tappable action, so that press feedback, disabled
 * handling and the accessibility contract are decided once rather than per
 * screen.
 *
 * ACCESSIBILITY
 *
 * A disabled button sets `accessibilityState` and `aria-disabled`, and stays
 * focusable, so a screen reader still reaches it and can explain why it cannot be
 * pressed. Making it unfocusable would leave a seller with a button that has
 * silently vanished from the tab order and no explanation.
 *
 * `minHeight` comes from `touchTarget`, never from a screen.
 */

import { useCallback } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  icon?: LucideIcon;
  /** Trailing icon, for a "next step" affordance. */
  iconRight?: LucideIcon;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityHint?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon: Icon,
  iconRight: IconRight,
  fullWidth = false,
  style,
  testID,
  accessibilityHint,
}: ButtonProps) {
  const { colors, radius, spacing, touchTarget } = useTheme();

  // A loading button is disabled. Without this, a seller can tap "Record payment"
  // twice while the first write is in flight.
  const inert = disabled || loading;

  const height = size === 'lg' ? touchTarget.comfortable : touchTarget.min;

  const surface: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: colors.primary, fg: colors.onPrimary, border: colors.primary },
    accent: { bg: colors.accent, fg: colors.onAccent, border: colors.accent },
    secondary: { bg: colors.surface, fg: colors.text, border: colors.borderStrong },
    ghost: { bg: 'transparent', fg: colors.primary, border: 'transparent' },
    danger: { bg: colors.danger, fg: colors.onDanger, border: colors.danger },
  };

  const { bg, fg, border } = surface[variant];

  const handlePress = useCallback(() => {
    if (inert) return;
    onPress?.();
  }, [inert, onPress]);

  return (
    <Pressable
      onPress={handlePress}
      disabled={inert}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inert, busy: loading }}
      // 0.5 rather than a hard disable so a disabled button still reads as a
      // button that is unavailable, which is different from something absent.
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: height,
          paddingHorizontal: spacing.md,
          borderRadius: radius.control,
          backgroundColor: bg,
          borderColor: border,
          borderWidth: variant === 'ghost' ? 0 : 1,
          opacity: disabled ? 0.45 : pressed && !loading ? 0.85 : 1,
        },
        fullWidth && styles.fullWidth,
        style,
      ]}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator size="small" color={fg} style={{ marginRight: spacing.xs }} />
        ) : Icon ? (
          <Icon size={18} color={fg} strokeWidth={2} style={{ marginRight: spacing.xs }} />
        ) : null}

        <Text variant="bodyStrong" color={fg} numberOfLines={1}>
          {label}
        </Text>

        {IconRight && !loading ? (
          <IconRight size={18} color={fg} strokeWidth={2} style={{ marginLeft: spacing.xs }} />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});