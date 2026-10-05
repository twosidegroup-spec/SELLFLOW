/**
 * People — the seller's customers.
 *
 * Real rows from `customers`, scoped to the organization in the session. Note the
 * scope: customers belong to an ORGANIZATION, not a store, because a seller's
 * customers do not change when they open a second outlet.
 */

import { useRouter } from 'expo-router';
import { Users } from 'lucide-react-native';

import { ListScreen } from '@/components/ListScreen';
import { Card, Text } from '@/components/ui';
import { useCustomers } from '@/features/customers/queries';
import { canWrite, useSession } from '@/store/session';

export default function CustomersScreen() {
  const router = useRouter();

  const orgId = useSession((state) => state.organization?.id);
  const role = useSession((state) => state.role);

  const { customers, isLoading, isError, error, refetch } = useCustomers(orgId);

  return (
    <ListScreen
      testID="customers-screen"
      title="People"
      icon={Users}
      isPending={isLoading}
      error={isError ? error : null}
      onRetry={() => void refetch()}
      onRefresh={() => void refetch()}
      actionLabel={canWrite(role) ? 'Add customer' : undefined}
      onAction={canWrite(role) ? () => router.push('/customer/new') : undefined}
      rows={
        customers.length > 0
          ? customers.map((customer) => (
              <Card key={customer.id} elevation="flat" style={{ borderColor: 'transparent' }}>
                <Text
                  variant="bodyStrong"
                  accessibilityRole="button"
                  onPress={() => router.push(`/customer/${customer.id}`)}
                >
                  {customer.name}
                </Text>
                {customer.phone ? (
                  <Text variant="caption" tone="muted">
                    {customer.phone}
                  </Text>
                ) : null}
              </Card>
            ))
          : undefined
      }
      emptyTitle="No customers yet"
      emptyDescription="Add a customer and their order history builds up from there."
      emptyActionLabel="Add a customer"
      onEmptyAction={() => router.push('/customer/new')}
    />
  );
}