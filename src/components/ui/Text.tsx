/**
 * Text.
 *
 * The only component screens should use for copy. Routing every string through
 * here means the type scale, colour roles and font weights are applied
 * consistently, and a screen can never accidentally ship 15px body text in a
 * colour that fails contrast.
 */

import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';

type Variant = keyof ReturnType<typeof useTheme>['typography'];
type Tone = 'primary' | 'secondary' | 'muted' | 'inverse' | 'success' | 'warning' | 'danger';

export interface TextProps extends RNTextProps {
  variant?: Variant;
  tone?: Tone;
  /** Shorthand for `textAlign`. */
  center?: boolean;
}

export function Text({
  variant = 'body',
  tone = 'primary',
  center,
  style,
  ...rest
}: TextProps) {
  const { colors, typography } = useTheme();

  // WCAG "large text" is 24px normal, or ~18.7px bold. Only the three display
  // sizes qualify. Everything else is small text and needs 4.5:1, which the
  // brand green (#16A34A, 3.3:1 on white) and amber (#D97706, 3.2:1) do not
  // reach. So the component resolves the tone against its own font size rather
  // than leaving every call site to remember.
  const isLargeText =
    variant === 'display' || variant === 'title' || variant === 'numericLarge';

  const toneColor: Record<Tone, string> = {
    primary: colors.text,
    secondary: colors.textSecondary,
    muted: colors.textMuted,
    inverse: colors.textInverse,
    success: isLargeText ? colors.success : colors.successStrong,
    warning: isLargeText ? colors.warning : colors.warningStrong,
    danger: colors.danger,
  };

  return (
    <RNText
      // Numbers and order ids should stay readable when a list reorders.
      allowFontScaling
      maxFontSizeMultiplier={1.6}
      style={[
        typography[variant],
        { color: toneColor[tone] },
        center ? { textAlign: 'center' } : null,
        style,
      ]}
      {...rest}
    />
  );
}
