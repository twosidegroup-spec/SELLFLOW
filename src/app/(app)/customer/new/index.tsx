/**
 * New customer route.
 *
 * A one-line wrapper. Expo Router treats every file under `src/app` as a screen, so
 * the form itself lives in `src/components/forms` -- otherwise a 300-line form
 * would also silently become a 300-line route at `/customer-form`.
 */

import { CustomerForm } from '@/components/forms/CustomerForm';

export default function NewCustomerScreen() {
  return <CustomerForm />;
}