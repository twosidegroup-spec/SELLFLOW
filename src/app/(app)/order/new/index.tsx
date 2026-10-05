/**
 * New order route.
 *
 * A wrapper, because the form lives in `src/components/forms` -- Expo Router turns
 * every file under `src/app` into a screen.
 */

import { OrderForm } from '@/components/forms/OrderForm';

export default function NewOrderScreen() {
  return <OrderForm />;
}