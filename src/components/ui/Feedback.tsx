/**
 * Loading, empty and error states.
 *
 * Requirement: never leave the user staring at a blank screen, and never show a
 * spinner everywhere. Skeletons preserve the layout of the content that is
 * loading, which stops the page from jumping when data arrives.
 */

import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Database } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { Button } from './Button';
import { Text } from './Text';

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export function Skeleton({
  width,
  height = 14,
  borderRadius,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, radius } = useTheme();

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: width ?? '100%',
          height,
          borderRadius: borderRadius ?? radius.sm,
          backgroundColor: colors.skeleton,
        },
        style,
      ]}
    />
  );
}

/** Placeholder matching the shape of a list row. */
export function ListRowSkeleton() {
  const { spacing, radius } = useTheme();
  return (
    <View style={[styles.rowSkeleton, { paddingVertical: spacing.sm, gap: spacing.sm }]}>
      <Skeleton width={40} height={40} borderRadius={radius.control} />
      <View style={styles.rowSkeletonBody}>
        <Skeleton width="55%" height={14} />
        <Skeleton width="35%" height={12} />
      </View>
      <Skeleton width={64} height={16} />
    </View>
  );
}

/** Placeholder for a dashboard metric tile. */
export function StatSkeleton({ width = '48%' }: { width?: number | `${number}%` }) {
  const { spacing } = useTheme();
  return (
    <View style={{ width, gap: spacing.xs, paddingVertical: spacing.xs }}>
      <Skeleton width="60%" height={12} />
      <Skeleton width="80%" height={26} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onActionPress,
  secondaryLabel,
  onSecondaryPress,
  compact = false,
  style,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  onActionPress?: () => void;
  secondaryLabel?: string;
  onSecondaryPress?: () => void;
  /** Tighter layout for empty search results inside an already-populated screen. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { spacing, colors, radius } = useTheme();

  return (
    <View style={[styles.empty, compact ? { paddingVertical: spacing.xl } : { paddingVertical: spacing.xxl }, style]}>
      {Icon ? (
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: radius.card,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.surfaceSunken,
            marginBottom: spacing.md,
          }}
        >
          <Icon size={26} color={colors.textMuted} strokeWidth={1.75} />
        </View>
      ) : null}

      <Text variant="heading" center>
        {title}
      </Text>

      {description ? (
        <Text variant="body" tone="muted" center style={{ marginTop: spacing.xs, maxWidth: 320 }}>
          {description}
        </Text>
      ) : null}

      {actionLabel && onActionPress ? (
        <Button
          label={actionLabel}
          onPress={onActionPress}
          style={{ marginTop: spacing.lg, minWidth: 180 }}
        />
      ) : null}

      {secondaryLabel && onSecondaryPress ? (
        <Button
          label={secondaryLabel}
          variant="ghost"
          onPress={onSecondaryPress}
          style={{ marginTop: spacing.xs }}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

export function ErrorState({
  title,
  action,
  onRetry,
  retryLabel = 'Try again',
  compact = false,
}: {
  title: string;
  action?: string;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
}) {
  const { spacing, colors } = useTheme();

  return (
    <View
      style={[
        styles.standalone,
        { backgroundColor: colors.background },
        compact ? { paddingVertical: spacing.lg } : { paddingVertical: spacing.xxl },
      ]}
    >
      <Text variant="heading" center>
        {title}
      </Text>
      {action ? (
        <Text variant="body" tone="muted" center style={{ marginTop: spacing.xs, maxWidth: 320 }}>
          {action}
        </Text>
      ) : null}
      {onRetry ? (
        <Button
          label={retryLabel}
          variant="secondary"
          onPress={onRetry}
          style={{ marginTop: spacing.lg, minWidth: 160 }}
        />
      ) : null}
    </View>
  );
}

/** Centred spinner for actions that genuinely block, like initial auth. */
export function LoadingState({ label }: { label?: string }) {
  const { spacing, colors } = useTheme();

  return (
    <View
      style={[
        styles.standalone,
        styles.empty,
        { backgroundColor: colors.background, paddingVertical: spacing.xxxl, gap: spacing.sm },
      ]}
    >
      <ActivityIndicator color={colors.primary} />
      {label ? (
        <Text variant="caption" tone="muted">
          {label}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Shown when the app has no Supabase credentials.
 *
 * Requirement 26: the app must never substitute plausible-looking data for a
 * missing backend. It says exactly what is wrong and how to fix it, and offers
 * no way to proceed into a UI that could not persist anything.
 */
export function SetupRequired() {
  const { spacing, colors, radius } = useTheme();

  return (
    <View style={[styles.setup, styles.standalone, { backgroundColor: colors.background, paddingHorizontal: spacing.lg }]}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: radius.card,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.warningSoft,
          marginBottom: spacing.md,
        }}
      >
        <Database size={26} color={colors.warning} strokeWidth={1.75} />
      </View>

      <Text variant="heading" center>
        SellFlow is not connected
      </Text>

      <Text variant="body" tone="muted" center style={{ marginTop: spacing.xs, maxWidth: 340 }}>
        This build has no database behind it, so it cannot save orders, customers or stock. Nothing
        you enter would be kept.
      </Text>

      <View
        style={{
          marginTop: spacing.lg,
          alignSelf: 'stretch',
          backgroundColor: colors.surfaceSunken,
          borderRadius: radius.mark,
          padding: spacing.md,
          gap: spacing.xs,
        }}
      >
        <Text variant="micro" tone="muted">
          To fix this
        </Text>
        <Text variant="caption" tone="secondary">
          1. Copy .env.example to .env
        </Text>
        <Text variant="caption" tone="secondary">
          2. Add your Supabase URL and anon key
        </Text>
        <Text variant="caption" tone="secondary">
          3. Run the SQL in supabase/migrations, then restart the app
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rowSkeleton: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowSkeletonBody: {
    flex: 1,
    gap: 6,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  /**
   * A state that owns the whole screen: an error, a blocking spinner, a missing
   * configuration. These are rendered directly by a route layout rather than
   * inside a `Screen`, so they must paint their own background. Without it they
   * inherit whatever is behind them and their themed text lands on the wrong
   * surface.
   */
  standalone: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  setup: {
    flex: 1,
    justifyContent: 'center',
  },
});
