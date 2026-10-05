/**
 * Text primitive.
 *
 * The only way text is styled in SellFlow V2. Screens pass a `variant` and a
 * `tone`; they never pass a size, a weight or a colour directly.
 *
 * That restriction is the whole point. It is what makes the type scale
 * enforceable: a screen cannot introduce a 17px semibold heading that exists in
 * no token, because there is no prop to do it with. `scripts/design-audit.mjs`
 * enforces the same rule at the token level.
 */

import { Text as RNText, type StyleProp, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { fontForWeight, typography, type ThemeColors } from '@/theme/tokens';

export type TextTone = 'default' | 'secondary' | 'muted' | 'inverse' | 'primary' | 'accent' | 'success' | 'warning' | 'danger';

export type TextVariant = keyof typeof typography;

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
  center?: boolean;
  /** Overrides the tone. For semantic values a variant cannot express. */
  color?: string;
  style?: StyleProp<TextStyle>;
}

/** Maps a tone to the token it resolves to, so both schemes stay in one place. */
export function toneColor(colors: ThemeColors, tone: TextTone): string {
  switch (tone) {
    case 'secondary':
      return colors.textSecondary;
    case 'muted':
      return colors.textMuted;
    case 'inverse':
      return colors.textInverse;
    case 'primary':
      return colors.primary;
    case 'accent':
      return colors.accent;
    case 'success':
      return colors.success;
    case 'warning':
      return colors.warning;
    case 'danger':
      return colors.danger;
    default:
      return colors.text;
  }
}

export function Text({
  variant = 'body',
  tone = 'default',
  center,
  color,
  style,
  ...rest
}: TextProps) {
  const { colors } = useTheme();
  const spec = typography[variant];

  return (
    <RNText
      // Numbers must be announced as numbers, and a long money string must not
      // be read digit by digit. Set once here so no screen has to remember.
      accessibilityRole={variant === 'numeric' || variant === 'numericLarge' ? 'text' : undefined}
      style={[
        {
          fontFamily: fontForWeight(spec.fontWeight),
          fontSize: spec.fontSize,
          lineHeight: spec.lineHeight,
          letterSpacing: spec.letterSpacing,
          color: color ?? toneColor(colors, tone),
          textAlign: center ? 'center' : 'left',
        },
        'fontVariant' in spec ? { fontVariant: spec.fontVariant } : null,
        style,
      ]}
      {...rest}
    />
  );
}