/**
 * List rows.
 *
 * A consistent shape for anything tappable in a list: leading icon or avatar,
 * title with optional subtitle, and trailing content. Using one component
 * across Orders, Products and Customers is what stops the three screens from
 * drifting apart visually.
 */

import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Check, ChevronRight } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** Right-aligned supporting text, e.g. a money figure. */
  trailing?: string;
  trailingSubtitle?: string;
  /** Leading element. Falls back to a neutral rounded placeholder. */
  leading?: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Hides the chevron for rows that open a sheet rather than a screen. */
  chevron?: boolean;
  /** Marks the row as chosen inside a picker sheet. */
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Removes the divider for the last row in a group. */
  last?: boolean;
  accessibilityLabel?: string;
  trailingTone?: 'primary' | 'secondary' | 'muted' | 'success' | 'danger';
}

export function ListRow({
  title,
  subtitle,
  trailing,
  trailingSubtitle,
  leading,
  onPress,
  onLongPress,
  chevron,
  selected,
  style,
  last = false,
  accessibilityLabel,
  trailingTone = 'primary',
}: ListRowProps) {
  const { colors, spacing, touchTarget } = useTheme();

  const showChevron = (chevron ?? Boolean(onPress)) && !selected;

  const content = (
    <View
      style={[
        styles.row,
        {
          paddingVertical: spacing.sm,
          gap: spacing.sm,
          minHeight: touchTarget.comfortable,
          borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        style,
      ]}
    >
      {leading}

      <View style={styles.body}>
        <Text variant="subtitle" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {trailing !== undefined || trailingSubtitle !== undefined ? (
        <View style={styles.trailing}>
          {trailing !== undefined ? (
            <Text variant="numeric" tone={trailingTone} numberOfLines={1}>
              {trailing}
            </Text>
          ) : null}
          {trailingSubtitle ? (
            <Text variant="micro" tone="muted" numberOfLines={1}>
              {trailingSubtitle}
            </Text>
          ) : null}
        </View>
      ) : null}

      {showChevron ? <ChevronRight size={18} color={colors.textMuted} strokeWidth={2} /> : null}
      {selected ? <Check size={18} color={colors.primary} strokeWidth={2.5} /> : null}
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      style={({ pressed }) => [
        pressed ? { backgroundColor: colors.pressed } : null,
        // Keeps the pressed fill edge-to-edge with the row's own padding.
        { marginHorizontal: -spacing.md, paddingHorizontal: spacing.md },
      ]}
    >
      {content}
    </Pressable>
  );
}

/** Square icon tile used as a list row's leading element. */
export function RowIcon({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}) {
  const { colors, radius } = useTheme();

  const palette = {
    neutral: colors.surfaceSunken,
    info: colors.primarySoft,
    success: colors.successSoft,
    warning: colors.warningSoft,
    danger: colors.dangerSoft,
  } as const;

  return (
    <View
      style={[
        styles.icon,
        { backgroundColor: palette[tone], borderRadius: radius.control },
      ]}
    >
      {children}
    </View>
  );
}

/** Circular initials avatar for customers. */
export function Avatar({ label, size = 40 }: { label: string; size?: number }) {
  const { colors, typography } = useTheme();

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.surfaceSunken,
        },
      ]}
    >
      <Text
        style={[
          typography.micro,
          { color: colors.textSecondary, fontSize: size * 0.32, lineHeight: size * 0.42 },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  body: {
    flex: 1,
    gap: 2,
  },
  trailing: {
    alignItems: 'flex-end',
    gap: 2,
    maxWidth: '40%',
  },
  icon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
