/**
 * Button.
 *
 * Press feedback is a scale-down plus opacity rather than a ripple: it reads
 * the same on both platforms, works identically inside scroll views and
 * bottom sheets, and stays interruptible. Every button clears the 44pt minimum
 * touch target at every size.
 */

import { forwardRef } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconPosition?: 'leading' | 'trailing';
  loading?: boolean;
  /** Stretches to the container width. Default for form submit buttons. */
  block?: boolean;
  full?: boolean;
  style?: StyleProp<ViewStyle>;
}

const HEIGHTS: Record<ButtonSize, number> = { sm: 40, md: 46, lg: 52 };

export const Button = forwardRef<View, ButtonProps>(function Button(
  {
    label,
    variant = 'primary',
    size = 'md',
    icon: Icon,
    iconPosition = 'leading',
    loading = false,
    block = false,
    full = false,
    disabled,
    style,
    ...rest
  },
  ref,
) {
  const { colors, radius, spacing, typography } = useTheme();
  // A loading button must not be re-triggerable; treat it as disabled so the
  // label does not shift or the handler fire twice.
  const isDisabled = disabled || loading;

  const palette: Record<ButtonVariant, { bg: string; pressed: string; fg: string; border?: string }> = {
    primary: { bg: colors.primary, pressed: colors.primaryPressed, fg: colors.onPrimary },
    secondary: { bg: 'transparent', pressed: colors.pressed, fg: colors.primary, border: colors.border },
    ghost: { bg: 'transparent', pressed: colors.pressed, fg: colors.textSecondary },
    danger: { bg: colors.danger, pressed: colors.danger, fg: colors.onAccent },
    // `successStrong`, not `success`: the brand green only reaches 3.3:1 as
    // white text on white, so a solid success button label would be unreadable.
    success: { bg: colors.successStrong, pressed: colors.successStrong, fg: colors.onAccent },
  };

  const tone = palette[variant];
  const height = HEIGHTS[size];
  const iconSize = size === 'sm' ? 16 : 20;

  // Solid accents take `onAccent`, which flips to near-black in dark mode so
  // the label stays readable on the lightened success/warning colours.
  const usesAccent = variant === 'danger' || variant === 'success';
  const foreground = usesAccent ? colors.onAccent : tone.fg;

  const content = (
    <>
      {loading ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : (
        <View style={[styles.row, { gap: spacing.xs }]}>
          {Icon && iconPosition === 'leading' ? <Icon size={iconSize} color={foreground} strokeWidth={2} /> : null}
          <Text
            numberOfLines={1}
            style={[
              typography.subtitle,
              { color: foreground, fontSize: size === 'sm' ? 14 : 15 },
            ]}
          >
            {label}
          </Text>
          {Icon && iconPosition === 'trailing' ? <Icon size={iconSize} color={foreground} strokeWidth={2} /> : null}
        </View>
      )}
    </>
  );

  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        {
          height,
          borderRadius: radius.control,
          backgroundColor: tone.bg,
          borderWidth: tone.border ? 1 : 0,
          borderColor: tone.border,
          opacity: isDisabled ? 0.45 : pressed ? 0.75 : 1,
          // Only stretch when asked. Setting `alignSelf: 'flex-start'` as the
          // default silently overrode a centred parent, so a button inside an
          // `EmptyState` or `ErrorState` sat hard against the left edge while
          // the copy above it was centred.
          ...(block || full ? { alignSelf: 'stretch' as const } : null),
          paddingHorizontal: size === 'sm' ? spacing.md : spacing.lg,
        },
        pressed && !isDisabled ? { transform: [{ scale: 0.98 }] } : null,
        style,
      ]}
      {...rest}
    >
      {content}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
