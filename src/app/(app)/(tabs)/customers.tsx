/**
 * Customers list.
 *
 * Searchable directory. Sorted by name rather than recency because a seller
 * looking for a customer is almost always looking for a specific person, not
 * browsing.
 */

import { useCallback } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Search, Trash2, Users } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { IconButton, ScreenHeader } from '@/components/ScreenHeader';
import {
  Avatar,
  EmptyState,
  ErrorState,
  FilterChip,
  ListRow,
  ListRowSkeleton,
  SearchBar,
  SellflowRefreshControl,
  confirm,
  useRefresh,
} from '@/components/ui';
import { useCustomers, useDeleteCustomer } from '@/features/customers/queries';
import { AppError } from '@/lib/errors';
import { initials } from '@/lib/format';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function CustomersScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const organization = useSession((state) => state.organization);
  const role = useSession((state) => state.role);
  const canWrite = role === 'owner' || role === 'manager';
  const deleteCustomer = useDeleteCustomer();

  /**
   * orders.customer_id is ON DELETE SET NULL, so removing a customer who has
   * ordered would quietly turn their sales into anonymous walk-in sales. The
   * server counts their orders first and refuses with an explanation.
   */
  const removeCustomer = async (customer: { id: string; name: string }) => {
    const confirmed = await confirm({
      title: 'Delete ' + customer.name + '?',
      message:
        'This cannot be undone. If they have ordered you will be asked to archive ' +
        'them instead, so your sales history stays correct.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await deleteCustomer.mutateAsync(customer.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      const refusal = AppError.from(error);
      await confirm({ title: refusal.title, message: refusal.action, confirmLabel: 'OK' });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  };

  const customers = useCustomers(organization?.id);
  // Destructured so the refresh callback depends on the function itself.
  const { refetch } = customers;

  /*
   * Tied to the seller's gesture rather than to `isFetching`, which also rises
   * for the refetch-on-focus below. Deriving the indicator from that made it
   * flash on every tab switch, which reads as the list reloading unbidden.
   */
  const refresh = useRefresh(
    useCallback(async () => {
      await refetch();
    }, [refetch]),
  );

  useFocusEffect(
    useCallback(() => {
      void customers.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const isFilteredEmpty =
    !customers.isLoading && customers.customers.length === 0 && customers.search.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Customers"
        subtitle={organization?.name}
        showBack={false}
        right={
          canWrite ? (
            <IconButton onPress={() => router.push('/(app)/customer/new')} label="Add customer" tone="primary">
              <Plus size={20} color={colors.primary} strokeWidth={2.25} />
            </IconButton>
          ) : undefined
        }
      />

      <FlatList
        data={customers.customers}
        keyExtractor={(item) => item.id}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingBottom: insets.bottom + 24,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
          refreshControl={<SellflowRefreshControl {...refresh} />}
        onEndReached={customers.loadMore}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <View style={{ gap: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.md }}>
            <SearchBar
              value={customers.search}
              onChangeText={customers.setSearch}
              placeholder="Search name or phone"
            />
            <View style={{ flexDirection: 'row', gap: spacing.xs }}>
              <FilterChip
                label="Active"
                selected={!customers.includeArchived}
                onPress={() => customers.setIncludeArchived(false)}
              />
              <FilterChip
                label="Archived"
                selected={customers.includeArchived}
                onPress={() => customers.setIncludeArchived(true)}
              />
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <ListRow
              title={item.name}
              subtitle={item.phone ?? item.email ?? 'No contact details'}
              leading={<Avatar label={initials(item.name)} />}
              onPress={() => router.push(`/(app)/customer/${item.id}`)}
              chevron={false}
              style={styles.rowMain}
            />
            {canWrite ? (
              <IconButton
                onPress={() => void removeCustomer(item)}
                label={`Delete ${item.name}`}
                tone="danger"
              >
                <Trash2 size={16} color={colors.textMuted} />
              </IconButton>
            ) : null}
          </View>
        )}
        ListEmptyComponent={
          customers.isLoading ? (
            <View style={{ gap: spacing.xs, paddingTop: spacing.sm }}>
              {[0, 1, 2, 3].map((key) => (
                <ListRowSkeleton key={key} />
              ))}
            </View>
          ) : customers.isError ? (
            <ErrorState
              title={AppError.from(customers.error).title}
              action={AppError.from(customers.error).action}
              onRetry={() => void customers.refetch()}
            />
          ) : isFilteredEmpty ? (
            <EmptyState
              icon={Search}
              title="No matching customers"
              description={`Nothing matches "${customers.search}".`}
              compact
              actionLabel="Clear search"
              onActionPress={() => customers.setSearch('')}
            />
          ) : (
            <EmptyState
              icon={Users}
              title="No customers yet"
              description="Save the people you sell to. Then you can see their order history, total spending and anything they owe you."
              actionLabel={canWrite ? 'Add your first customer' : undefined}
              onActionPress={canWrite ? () => router.push('/(app)/customer/new') : undefined}
            />
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  rowMain: {
    flex: 1,
  },
});
