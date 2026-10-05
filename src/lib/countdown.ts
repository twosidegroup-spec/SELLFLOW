/**
 * Countdown tick.
 *
 * A hook that exists so the lockout countdown can move WITHOUT storing the number in
 * state.
 *
 * WHY THIS IS NOT JUST AN INTERVAL
 *
 * The obvious version is `setInterval(() => setSecondsLeft(...), 1000)`, which puts a
 * setState in an effect. The React compiler rejects that -- a synchronous setState on
 * mount cascades an extra render before anything is painted -- and it also forces the
 * countdown into the same state object as the deadline it is derived from, which then
 * need synchronising.
 *
 * So the deadline is the only stored state, and this hook supplies the clock. It
 * ticks once a second ONLY while a deadline is in the future, which is the whole
 * point: an idle unlock screen must not re-render every second to display a zero.
 */

import { useEffect, useState } from 'react';

const TICK_MS = 1000;

export function useCountdownTick(deadline: number | null): number {
  // Derived, never stored as the source of truth. Re-deriving from the clock on
  // every render is what makes a device clock change mid-countdown harmless.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === null) return undefined;
    // Already expired: nothing to tick for. Without this, a stale deadline would
    // leave an interval running against a number nobody is reading.
    if (deadline <= Date.now()) return undefined;

    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [deadline]);

  if (deadline === null) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}