/**
 * A list screen that is honest about having nothing.
 *
 * Every list in SellFlow starts here: one place that owns the loading, empty, error
 * and content states, so ten screens cannot each invent a slightly different empty
 * message and none of them explains what to do next.
 *
 * The empty state is not decoration. "No orders yet" with a button that starts the
 * first order is the difference between a new seller understanding the product and
 * concluding it is broken.
 */

import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LucideIcon } from 'lucide-react-native';

import { Button, EmptyState, ErrorState, ListRowSkeleton, Text } from '@/components/ui';
import { useTheme } from '@/theme/ThemeProvider';

export interface ListScreenProps {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  children?: React.ReactNode;
  /** The list itself. Omitted while loading, empty or errored. */
  rows?: React.ReactNode;
  rowCount?: number;
  isPending: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Drives the empty state. Absent rows with no empty title means "do not show one". */
  emptyTitle?: string;
  emptyDescription?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  /** Primary action, pinned under the title. */
  actionLabel?: string;
  onAction?: () => void;
  onRefresh?: () => void;
  testID?: string;
}

export function ListScreen({
  title,
  subtitle,
  icon,
  children,
  rows,
  rowCount = 6,
  isPending,
  error,
  onRetry,
  emptyTitle,
  emptyDescription,
  emptyActionLabel,
  onEmptyAction,
  actionLabel,
  onAction,
  onRefresh,
  testID,
}: ListScreenProps) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  if (error) {
    return (
      <ErrorState
        title="Could not load this"
        action="Check your connection and try again."
        onRetry={onRetry}
      />
    );
  }

  const isEmpty = !isPending && emptyTitle !== undefined && rows === undefined;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        paddingTop: insets.top + spacing.lg,
        paddingHorizontal: spacing.lg,
        paddingBottom: insets.bottom + spacing.xxxl,
        gap: spacing.md,
      }}
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={colors.primary} />
        ) : undefined
      }
      testID={testID}
    >
      <View style={{ gap: spacing.xxs }}>
        <Text variant="title">{title}</Text>
        {subtitle ? (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>

      {actionLabel && onAction ? (
        <Button label={actionLabel} fullWidth onPress={onAction} />
      ) : null}

      {isPending ? (
        <View style={{ gap: spacing.sm }}>
          {Array.from({ length: rowCount }).map((_, index) => (
            <ListRowSkeleton key={index} />
          ))}
        </View>
      ) : isEmpty ? (
        <EmptyState
          icon={icon}
          title={emptyTitle}
          description={emptyDescription}
          actionLabel={emptyActionLabel}
          onActionPress={onEmptyAction}
        />
      ) : (
        <View style={{ gap: spacing.sm }}>{rows}</View>
      )}

      {children}
    </ScrollView>
  );
}