/**
 * New product route.
 *
 * A wrapper: the form lives in `src/components/forms/ProductForm` because Expo Router
 * turns every file under `src/app` into a screen.
 */

import { ProductForm } from '@/components/forms/ProductForm';

export default function NewProductScreen() {
  return <ProductForm />;
}