/**
 * Card and section primitives.
 *
 * Deliberately low-contrast: a hairline border carries most of the separation,
 * with a very slight shadow on light mode. Heavy card stacks are the main thing
 * that makes an app look template-generated, so these stay quiet by default.
 */

import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export interface CardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Removes internal padding for cards that contain their own dividers. */
  flush?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
}

export function Card({
  children,
  style,
  flush = false,
  onPress,
  accessibilityLabel,
  disabled,
}: CardProps) {
  const { colors, radius, spacing, elevation } = useTheme();

  const base: StyleProp<ViewStyle> = [
    styles.card,
    {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.card,
      padding: flush ? 0 : spacing.md,
    },
    elevation.card,
    style,
  ];

  if (!onPress) {
    return <View style={base}>{children}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [base, pressed && !disabled ? { opacity: 0.7 } : null]}
    >
      {children}
    </Pressable>
  );
}

/** Section heading with an optional trailing action. */
export function SectionHeader({
  title,
  actionLabel,
  onActionPress,
  style,
  compact = false,
}: {
  title: string;
  actionLabel?: string;
  onActionPress?: () => void;
  style?: StyleProp<ViewStyle>;
  /**
   * Steps the title down a level.
   *
   * A section header is a label for what follows, not content in its own right.
   * At `heading` weight it is as large as the money inside the card beneath it,
   * and a screen full of them reads as a stack of headlines rather than as data.
   */
  compact?: boolean;
}) {
  const { spacing } = useTheme();

  return (
    <View style={[styles.sectionHeader, { marginBottom: spacing.sm }, style]}>
      <Text variant={compact ? 'subtitle' : 'heading'}>{title}</Text>
      {actionLabel && onActionPress ? (
        <Text
          variant="caption"
          tone="primary"
          onPress={onActionPress}
          accessibilityRole="button"
          suppressHighlighting
        >
          {actionLabel}
        </Text>
      ) : null}
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }, style]} />;
}

/**
 * Label/value row used throughout detail screens.
 *
 * `amount` renders right-aligned with tabular figures so a column of money lines
 * up, which is what makes financial screens scannable.
 */
export function DetailRow({
  label,
  value,
  amount,
  tone = 'primary',
  emphasis = false,
  sublabel,
}: {
  label: string;
  value?: string;
  amount?: string;
  tone?: 'primary' | 'secondary' | 'muted' | 'success' | 'danger';
  emphasis?: boolean;
  sublabel?: string;
}) {
  const { spacing } = useTheme();
  const labelTone = tone === 'primary' ? 'secondary' : tone;

  return (
    <View style={[styles.detailRow, { paddingVertical: spacing.xs }]}>
      <View style={styles.detailLabel}>
        <Text variant={emphasis ? 'subtitle' : 'body'} tone={labelTone}>
          {label}
        </Text>
        {sublabel ? (
          <Text variant="micro" tone="muted">
            {sublabel}
          </Text>
        ) : null}
      </View>

      {value !== undefined ? (
        <Text variant={emphasis ? 'numeric' : 'body'} tone={tone} numberOfLines={1}>
          {value}
        </Text>
      ) : null}

      {amount !== undefined ? (
        <Text
          variant={emphasis ? 'numeric' : 'body'}
          tone={tone}
          numberOfLines={1}
          style={styles.detailAmount}
        >
          {amount}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    // Overflow hidden would clip the focus ring of children; borders are
    // hairlines so the corners still read correctly.
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  detailLabel: {
    flex: 1,
    gap: 2,
  },
  detailAmount: {
    minWidth: 96,
    textAlign: 'right',
  },
});
