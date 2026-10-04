/**
 * Notifications inbox.
 *
 * Reads from the `notifications` table, which is populated by the database
 * (low-stock detection, payment-due reminders). A brand-new account has none,
 * and this screen says so honestly rather than showing invented activity.
 */

import { useCallback } from 'react';
import { FlatList, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Boxes, CreditCard, ReceiptText } from 'lucide-react-native';

import { ScreenHeader } from '@/components/ScreenHeader';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ListRowSkeleton,
  SellflowRefreshControl,
  Text,
  useRefresh,
} from '@/components/ui';
import type { NotificationKind, NotificationRow } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { formatTimeAgo } from '@/lib/format';
import { getSupabase } from '@/lib/supabase';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

const KIND_ICON: Record<NotificationKind, typeof Bell> = {
  new_order: ReceiptText,
  low_stock: Boxes,
  payment_due: CreditCard,
  order_status: ReceiptText,
  account: Bell,
};

export default function NotificationsScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const user = useSession((state) => state.user);

  const query = useQuery({
    queryKey: ['notifications'],
    enabled: Boolean(user),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw AppError.from(error);
      return (data ?? []) as NotificationRow[];
    },
  });

  const markAllRead = useMutation({
    mutationFn: async () => {
      const { error } = await getSupabase()
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .is('read_at', null);

      if (error) throw AppError.from(error);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useFocusEffect(
    useCallback(() => {
      void query.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const notifications = query.data ?? [];
  const hasUnread = notifications.some((entry) => entry.read_at === null);
  // Destructured so the refresh callback depends on the function itself.
  const { refetch } = query;

  /*
   * Tied to the seller's gesture rather than to `isFetching`, which also rises
   * for the refetch-on-focus above.
   */
  const refresh = useRefresh(
    useCallback(async () => {
      await refetch();
    }, [refetch]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Notifications"
        right={
          hasUnread ? (
            <Button
              label="Mark read"
              variant="ghost"
              size="sm"
              onPress={() => markAllRead.mutate()}
              loading={markAllRead.isPending}
            />
          ) : undefined
        }
      />

      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
          paddingBottom: insets.bottom + 24,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={<SellflowRefreshControl {...refresh} />}
        renderItem={({ item }) => <NotificationCard notification={item} />}
        ListEmptyComponent={
          query.isLoading ? (
            <View style={{ gap: spacing.xs, paddingTop: spacing.sm }}>
              {[0, 1, 2].map((key) => (
                <ListRowSkeleton key={key} />
              ))}
            </View>
          ) : query.isError ? (
            <ErrorState
              title={AppError.from(query.error).title}
              action={AppError.from(query.error).action}
              onRetry={() => void query.refetch()}
            />
          ) : (
            <EmptyState
              icon={Bell}
              title="Nothing to report"
              description="You will be told when an order needs attention, stock runs low or a payment is still outstanding."
            />
          )
        }
      />
    </View>
  );
}

function NotificationCard({ notification }: { notification: NotificationRow }) {
  const { colors, spacing, radius } = useTheme();
  const Icon = KIND_ICON[notification.kind] ?? Bell;
  const unread = notification.read_at === null;

  const data = (notification.data ?? {}) as Record<string, string | undefined>;
  const orderId = data.order_id;
  const productId = data.product_id;

  const onPress = () => {
    if (orderId) router.push(`/(app)/order/${orderId}`);
    else if (productId) router.push(`/(app)/product/${productId}`);
  };

  return (
    <Card
      onPress={orderId || productId ? onPress : undefined}
      accessibilityLabel={notification.title}
      style={{
        marginBottom: spacing.xs,
        borderRadius: radius.card,
        backgroundColor: unread ? colors.primarySoft : colors.surface,
      }}
    >
      <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
        <Icon
          size={18}
          color={unread ? colors.primary : colors.textMuted}
          strokeWidth={2}
          style={{ marginTop: 2 }}
        />

        <View style={{ flex: 1, gap: 4 }}>
          <Text variant="subtitle" numberOfLines={2}>
            {notification.title}
          </Text>
          {notification.body ? (
            <Text variant="caption" tone="muted">
              {notification.body}
            </Text>
          ) : null}
          <Text variant="micro" tone="muted">
            {formatTimeAgo(notification.created_at)}
          </Text>
        </View>

        {unread ? <Badge label="New" tone="info" /> : null}
      </View>
    </Card>
  );
}
