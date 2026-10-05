/**
 * Loading, empty and error states.
 *
 * The rule these exist to enforce: a screen must never leave a seller staring at
 * nothing, and must never invent data to fill the space. There is no spinner
 * everywhere -- `Skeleton` preserves the shape of the content that is loading so
 * the layout does not jump when data arrives.
 *
 * Every full-screen state paints its own background. These render as a route's
 * entire output rather than inside a `Screen`, so without an explicit background
 * they inherit whatever is behind them and themed text lands on the wrong
 * surface.
 */

import { ActivityIndicator, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Database, Inbox, TriangleAlert } from 'lucide-react-native';
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
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, gap: spacing.sm }}>
      <Skeleton width={40} height={40} borderRadius={radius.pill} />
      <View style={{ flex: 1, gap: spacing.xxs }}>
        <Skeleton width="55%" height={14} />
        <Skeleton width="35%" height={12} />
      </View>
      <Skeleton width={64} height={16} />
    </View>
  );
}

/** Placeholder for a dashboard metric. */
export function StatSkeleton({ width = '48%' }: { width?: number | `${number}%` }) {
  const { spacing } = useTheme();
  return (
    <View style={{ width, gap: spacing.xxs, paddingVertical: spacing.xxs }}>
      <Skeleton width="60%" height={12} />
      <Skeleton width="80%" height={26} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

/**
 * Shown when a request succeeded and there is genuinely nothing yet.
 *
 * The default title is "Nothing here yet" rather than a figure. A dashboard that
 * shows a fabricated revenue number to look populated teaches a seller to trust
 * numbers the app made up.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title = 'Nothing here yet',
  description,
  actionLabel,
  onActionPress,
  secondaryLabel,
  onSecondaryPress,
  compact = false,
  style,
}: {
  icon?: LucideIcon;
  title?: string;
  description?: string;
  actionLabel?: string;
  onActionPress?: () => void;
  secondaryLabel?: string;
  onSecondaryPress?: () => void;
  /** Tighter layout for an empty search result inside a populated screen. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { spacing, colors, radius } = useTheme();

  return (
    <View
      style={[
        styles.centred,
        { paddingVertical: compact ? spacing.xl : spacing.xxl },
        style,
      ]}
    >
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: radius.mark,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.surfaceSunken,
          marginBottom: spacing.md,
        }}
      >
        <Icon size={24} color={colors.textMuted} strokeWidth={1.75} />
      </View>

      <Text variant="heading" center>
        {title}
      </Text>

      {description ? (
        <Text
          variant="body"
          tone="muted"
          center
          style={{ marginTop: spacing.xxs, maxWidth: 320 }}
        >
          {description}
        </Text>
      ) : null}

      {actionLabel && onActionPress ? (
        <Button
          label={actionLabel}
          onPress={onActionPress}
          style={{ marginTop: spacing.lg, alignSelf: 'center' }}
        />
      ) : null}

      {secondaryLabel && onSecondaryPress ? (
        <Button
          label={secondaryLabel}
          variant="ghost"
          onPress={onSecondaryPress}
          style={{ marginTop: spacing.xs, alignSelf: 'center' }}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

/**
 * A failure the seller can act on.
 *
 * `title` says what failed and `action` says what to do. Neither is optional,
 * because an error screen that only says "Something went wrong" makes the seller
 * guess, and a blank screen makes them reinstall the app.
 */
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
  const { spacing } = useTheme();

  return (
    <View
      style={[
        styles.standalone,
        { paddingVertical: compact ? spacing.lg : spacing.xxl },
      ]}
    >
      <View style={{ alignItems: 'center', maxWidth: 360 }}>
        <Text variant="heading" center>
          {title}
        </Text>
        {action ? (
          <Text variant="body" tone="muted" center style={{ marginTop: spacing.xxs }}>
            {action}
          </Text>
        ) : null}
        {onRetry ? (
          <Button
            label={retryLabel}
            variant="secondary"
            onPress={onRetry}
            style={{ marginTop: spacing.lg, alignSelf: 'center' }}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * A failure worth stopping for.
 *
 * Separate from `ErrorState` because it carries an icon and uses the danger tint,
 * which is reserved for exactly this: an operation that did not complete and left
 * something inconsistent. Reach for `ErrorState` first.
 */
export function FatalErrorState({
  title,
  action,
  onRetry,
}: {
  title: string;
  action?: string;
  onRetry?: () => void;
}) {
  const { spacing, colors, radius } = useTheme();

  return (
    <View style={[styles.standalone, { paddingVertical: spacing.xxl }]}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: radius.mark,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.dangerSoft,
          marginBottom: spacing.md,
        }}
      >
        <TriangleAlert size={24} color={colors.danger} strokeWidth={1.75} />
      </View>

      <Text variant="heading" center>
        {title}
      </Text>
      {action ? (
        <Text variant="body" tone="muted" center style={{ marginTop: spacing.xxs, maxWidth: 340 }}>
          {action}
        </Text>
      ) : null}
      {onRetry ? (
        <Button
          label="Try again"
          onPress={onRetry}
          style={{ marginTop: spacing.lg, alignSelf: 'center' }}
        />
      ) : null}
    </View>
  );
}

/** Centred spinner for actions that genuinely block, like initial auth. */
export function LoadingState({ label }: { label?: string }) {
  const { spacing, colors } = useTheme();

  return (
    <View style={[styles.standalone, { paddingVertical: spacing.xxxl, gap: spacing.sm }]}>
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
 * The app never substitutes plausible-looking data for a missing backend. It
 * names the problem, gives the three steps to fix it, and offers no way into a UI
 * that could not persist anything the seller typed.
 */
export function SetupRequired() {
  const { spacing, colors, radius } = useTheme();

  const steps = [
    'Copy .env.example to .env',
    'Add your Supabase URL and anon key',
    'Run the SQL in supabase/migrations, then restart',
  ];

  return (
    <ScrollView
      contentContainerStyle={[styles.standalone, { paddingVertical: spacing.xxl }]}
      showsVerticalScrollIndicator={false}
    >
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: radius.mark,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.warningSoft,
          marginBottom: spacing.md,
        }}
      >
        <Database size={24} color={colors.warning} strokeWidth={1.75} />
      </View>

      <Text variant="heading" center>
        SellFlow is not connected
      </Text>

      <Text variant="body" tone="muted" center style={{ marginTop: spacing.xxs, maxWidth: 340 }}>
        This build has no database behind it, so it cannot save orders, customers or stock.
        Nothing you enter would be kept.
      </Text>

      <View
        style={{
          marginTop: spacing.lg,
          alignSelf: 'stretch',
          maxWidth: 400,
          backgroundColor: colors.surfaceSunken,
          borderRadius: radius.mark,
          borderWidth: 1,
          borderColor: colors.border,
          padding: spacing.md,
          gap: spacing.xs,
        }}
      >
        <Text variant="micro" tone="muted">
          TO FIX THIS
        </Text>
        {steps.map((step, index) => (
          <Text key={step} variant="caption" tone="secondary">
            {`${index + 1}. ${step}`}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  standalone: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  centred: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
});