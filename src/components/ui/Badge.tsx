/**
 * Badge and segmented control.
 *
 * A badge is a small status word, not a decoration. It has exactly one tone per
 * meaning, and "neutral" means nothing in particular rather than "fine" -- a seller
 * reading `5 in stock` should not have to work out whether that is good news.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'accent';

/**
 * Vertical padding for a badge capsule, in points.
 *
 * Two, not four: this is a label, not a control. Shared with the REQUIRED/OPTIONAL
 * chip in registration and the count chip on the dashboard, so all three read as the
 * same object at three sizes.
 */
const BADGE_PADDING_V = 2;

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  icon?: LucideIcon;
  /** Makes the badge a button. */
  onPress?: () => void;
  testID?: string;
}

export function Badge({ label, tone = 'neutral', icon: Icon, onPress, testID }: BadgeProps) {
  const { colors, spacing, radius } = useTheme();

  const palette: Record<BadgeTone, { bg: string; fg: string }> = {
    neutral: { bg: colors.surfaceSunken, fg: colors.textSecondary },
    primary: { bg: colors.primarySoft, fg: colors.primary },
    success: { bg: colors.successSoft, fg: colors.successStrong },
    warning: { bg: colors.warningSoft, fg: colors.warningStrong },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    accent: { bg: colors.accentSoft, fg: colors.accent },
  };

  const { bg, fg } = palette[tone];

  const body = (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: bg,
          borderRadius: radius.pill,
          paddingHorizontal: spacing.xs,
          gap: spacing.xxs,
        },
      ]}
    >
      {Icon ? <Icon size={11} color={fg} strokeWidth={2.5} /> : null}
      <Text variant="micro" color={fg}>
        {label}
      </Text>
    </View>
  );

  if (!onPress) return testID ? <View testID={testID}>{body}</View> : body;

  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      // A badge is small; the tap target is not. 12px of slop on every side turns a
      // 22px chip into something a thumb can actually hit.
      hitSlop={12}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {body}
    </Pressable>
  );
}

/**
 * Two or three mutually exclusive options.
 *
 * Used for order status filters. A row of pills was tried first and reads as
 * decoration; a segmented control reads as "pick one of these", which is what it is.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  testID,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (next: T) => void;
  testID?: string;
}) {
  const { colors, spacing, radius, chipHeight } = useTheme();

  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surfaceSunken,
        borderRadius: radius.control,
        padding: spacing.xxs,
        gap: spacing.xxs,
      }}
      accessibilityRole="tablist"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            testID={testID ? `${testID}-${option.value}` : undefined}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              styles.segment,
              {
                minHeight: chipHeight,
                borderRadius: radius.sm,
                backgroundColor: selected ? colors.surface : 'transparent',
                paddingHorizontal: spacing.sm,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text variant="caption" tone={selected ? 'default' : 'muted'}>
              {option.count === undefined ? option.label : `${option.label} ${option.count}`}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    // An 11px caps label needs BADGE_PADDING_V, not a spacing step: `spacing.xxs`
    // (4) makes the chip 19px tall around 11px of text, which reads as a button
    // rather than a label. Named so the design audit can see it is deliberate.
    paddingVertical: BADGE_PADDING_V,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

/** Re-exported so a screen can render arbitrary content beside a badge row. */
export type { ReactNode };