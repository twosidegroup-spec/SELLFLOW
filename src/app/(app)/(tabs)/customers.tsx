/**
 * Customers.
 *
 * Real rows scoped to the tenant in the session, searched on name OR phone because
 * sellers find people by either, often while the customer is on the phone.
 */

import { useRouter } from 'expo-router';
import { Users } from 'lucide-react-native';
import { View } from 'react-native';

import { ListScreen } from '@/components/ListScreen';
import { Badge, Card, SearchBar, Text } from '@/components/ui';
import { useCustomers } from '@/features/customers/queries';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function CustomersScreen() {
  const { spacing } = useTheme();
  const router = useRouter();

  const orgId = useSession((state) => state.organization?.id);
  const role = useSession((state) => state.role);

  const {
    customers,
    search,
    setSearch,
    isLoading,
    isError,
    error,
    refetch,
    hasMore,
    loadMore,
  } = useCustomers(orgId);

  return (
    <ListScreen
      testID="customers-screen"
      title="Customers"
      subtitle={orgId ? undefined : 'Loading your business…'}
      icon={Users}
      isPending={isLoading}
      error={isError ? error : null}
      onRetry={() => void refetch()}
      onRefresh={() => void refetch()}
      actionLabel={canWrite(role) ? 'New customer' : undefined}
      onAction={canWrite(role) ? () => router.push('/customer/new') : undefined}
      emptyTitle={search.trim() ? 'Nothing matched' : 'No customers yet'}
      emptyDescription={
        search.trim()
          ? `No customer matches “${search.trim()}”. Try part of a name, or the last digits of a number.`
          : 'Customers you sell to are listed here, with what they have ordered and what they still owe.'
      }
      emptyActionLabel={search.trim() ? 'Clear search' : 'Add a customer'}
      onEmptyAction={() => (search.trim() ? setSearch('') : router.push('/customer/new'))}
      rows={
        <>
          <SearchBar
            value={search}
            onChangeText={setSearch}
            placeholder="Search name or phone"
            testID="customers-search"
          />

          {customers.map((customer) => (
            <Card
              key={customer.id}
              elevation="flat"
              style={{ borderColor: 'transparent' }}
            >
              <Text
                variant="bodyStrong"
                accessibilityRole="button"
                onPress={() => router.push(`/customer/${customer.id}`)}
                testID={`customer-row-${customer.id}`}
              >
                {customer.name}
              </Text>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
                {/*
                 * A customer with no number reads as "not recorded", never as a blank
                 * line -- an empty gap is ambiguous between "none" and "loading".
                 */}
                <Text variant="caption" tone="muted">
                  {customer.phone ?? 'No phone recorded'}
                </Text>
                {customer.is_archived ? <Badge label="Archived" tone="neutral" /> : null}
              </View>
            </Card>
          ))}

          {hasMore ? (
            <Text
              variant="caption"
              tone="primary"
              accessibilityRole="button"
              onPress={loadMore}
              style={{ textAlign: 'center', paddingVertical: spacing.sm }}
              testID="customers-load-more"
            >
              Load more
            </Text>
          ) : null}
        </>
      }
    />
  );
}