/**
 * The one pull-to-refresh in SellFlow.
 *
 * Four screens had four different refresh behaviours, and three of them were
 * broken in ways a seller would notice immediately:
 *
 *   - **Products had none at all.** It passed `onRefresh` and `refreshing` to
 *     `Screen scroll={false}`, which renders a plain `View`. The refresh props
 *     were accepted by the type and then silently discarded, so pulling down on
 *     the Products tab did nothing.
 *   - **The payment detection screen showed no spinner.** It passed `onRefresh`
 *     with no `refreshing`, which defaults to `false`. A controlled
 *     `RefreshControl` with `refreshing={false}` snaps straight back, so the
 *     gesture looked inert.
 *   - **The Payments hub spun on its own.** It combined two queries with `&&`
 *     where the logic needs `||`: `accounts.isLoading && review.isLoading`. The
 *     moment the first of the two resolved, `isFetching` was true while
 *     `isLoading` was false, so the refresh indicator animated unprompted on
 *     every cold mount.
 *   - **Analytics and Finance had none**, and no refetch on focus either, so
 *     revenue and profit were stale on every entry.
 *
 * Using the platform `RefreshControl` is the whole point. The pull, the rubber
 * band, the spinner and the settle are the OS drawing its own component, which is
 * why it tracks the finger correctly and cannot drift out of sync with the
 * gesture. Nothing here fakes an animation.
 *
 * The one real cause of a "jumpy" indicator is a `refreshing` flag that is not
 * driven by the request. `useRefresh` is the answer to that: it takes a function
 * that returns a promise, shows the spinner for exactly as long as the work
 * takes, ignores a second pull while one is in flight, and cannot get stuck
 * because the flag is cleared in a `finally`.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { RefreshControl } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';

export interface UseRefreshResult {
  refreshing: boolean;
  onRefresh: () => void;
}

/**
 * Drives a `RefreshControl` from a promise-returning function.
 *
 * `work` must resolve when the refresh is genuinely finished -- awaiting the
 * query's `refetch()` does that, and so does awaiting `invalidateQueries()` for
 * queries that are already mounted.
 */
export function useRefresh(work: () => Promise<unknown>): UseRefreshResult {
  const [refreshing, setRefreshing] = useState(false);

  /*
   * Guards re-entry from a ref, because a second pull can land before React has
   * re-rendered with `refreshing: true`, and two overlapping refetches of the
   * same query is exactly the duplicate-request problem this is meant to avoid.
   */
  const inFlight = useRef(false);

  const onRefresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);

    // `finally`, not a `.then`: a rejected refetch must still lower the spinner,
    // or the control stays stuck forever.
    void Promise.resolve()
      .then(work)
      .catch(() => {
        // The error belongs to the query's own state, which the screen already
        // renders. Swallowing it here keeps an unhandled rejection out of the
        // console while leaving the feedback where the seller can see it.
      })
      .finally(() => {
        inFlight.current = false;
        setRefreshing(false);
      });
  }, [work]);

  return { refreshing, onRefresh };
}

/**
 * `true` only while a *background* refetch is running -- one the seller did not
 * ask for, such as a refetch on focus.
 *
 * This is the distinction that keeps the spinner still. A refresh indicator
 * appearing because a screen refetched itself while the seller was reading it is
 * the thing that makes pull-to-refresh feel broken, so the flag is deliberately
 * derived from the explicit `useRefresh` state rather than from the query.
 */
export function useBackgroundRefetch(isFetching: boolean, isLoading: boolean): boolean {
  return isFetching && !isLoading;
}

export interface SellflowRefreshControlProps {
  refreshing: boolean;
  onRefresh: () => void;
}

/**
 * A themed `RefreshControl`.
 *
 * Centralised so the indicator is the same object on every screen: the same
 * brand colour, the same plate behind it, and no platform-default blue leaking
 * through on Android.
 */
export function SellflowRefreshControl({ refreshing, onRefresh }: SellflowRefreshControlProps) {
  const { colors } = useTheme();

  return useMemo(
    () => (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={onRefresh}
        tintColor={colors.textMuted}
        colors={[colors.primary]}
        progressBackgroundColor={colors.surface}
        // Keeps the indicator from being drawn over a sticky header. Zero rather
        // than the safe-area inset: the header is a sibling above the scroll
        // view, not an overlay, so the scroll view already starts below it.
        progressViewOffset={0}
      />
    ),
    [colors.primary, colors.surface, colors.textMuted, onRefresh, refreshing],
  );
}
