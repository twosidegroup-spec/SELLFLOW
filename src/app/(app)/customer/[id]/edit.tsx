/**
 * Edit customer route.
 *
 * Loads the customer under the caller's RLS, then hands the form a snapshot to edit.
 * The id is a route value, never authority: if it belongs to another tenant the read
 * returns nothing and the screen says so rather than showing someone else's data.
 */

import { useLocalSearchParams } from 'expo-router';

import { CustomerForm } from '@/components/forms/CustomerForm';
import { ErrorState, LoadingState } from '@/components/ui';
import { useCustomer } from '@/features/customers/queries';

export default function EditCustomerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const customer = useCustomer(id);

  if (customer.isLoading) return <LoadingState label="Loading customer" />;

  if (customer.isError || !customer.data) {
    return (
      <ErrorState
        title="Could not load this customer"
        action="It may have been deleted, or you may not have access."
        onRetry={() => void customer.refetch()}
      />
    );
  }

  const row = customer.data;

  return (
    <CustomerForm
      customerId={row.id}
      initial={{
        name: row.name,
        phone: row.phone,
        address: row.address,
        district: row.district,
        thana: row.thana,
        notes: row.notes,
      }}
    />
  );
}