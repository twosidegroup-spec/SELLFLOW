/**
 * Debounced value.
 *
 * Moved here from the old `components/ui/Controls.tsx` during the V2 rebuild.
 * It is not UI: three preserved data modules (`customers/queries`,
 * `orders/queries`, `products/queries`) import it, and those are kept because
 * they are the data layer over the live database rather than part of the old
 * interface. Deleting a hook the surviving data layer depends on would have
 * broken the preserve list to remove a screen.
 *
 * Search fields debounce through this rather than firing a request per
 * keystroke: every keystroke would otherwise become a round trip, which is what
 * makes search feel laggy and wastes the seller's data allowance.
 */

import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    // Skip the leading-edge update so the first render is not delayed.
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}