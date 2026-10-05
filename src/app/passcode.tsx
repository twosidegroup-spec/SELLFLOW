/**
 * Passcode unlock.
 *
 * The simple surface the product asks for: a passcode, nothing else. The seller
 * does not re-enter their email, business name, or organization.
 *
 * WHY THAT IS SAFE
 *
 * A passcode alone cannot identify WHICH account to open, and this screen does not
 * pretend otherwise. The account comes from the Supabase session, resolved at
 * launch by `bootstrap()`; the passcode record is namespaced to that session's user
 * id (`secureKey(userId)` in `lib/passcode.ts`). The keypad therefore verifies
 * "is this the person already signed in on this phone", not "who is this".
 *
 * The lockout policy is the fixed one: five wrong guesses start a 30 second
 * cooldown, the record is NEVER deleted, and the entry reopens on its own. A seller
 * who forgot their passcode escapes with the account password.
 *
 * WHAT HAPPENS ON A KEYSTORE FAILURE
 *
 * `hydrate` in `store/lock.ts` resolves a failed read as "no passcode stored", so a
 * broken Keystore cannot leave the app on a permanently blank keypad. This screen
 * therefore renders even when there is no record -- and says so plainly rather than
 * pretending the seller mistyped anything.
 */

import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Button, Card, ErrorState, PasscodeKeypad, Screen, Text } from '@/components/ui';
import { useCountdownTick } from '@/lib/countdown';
import { PASSCODE_LOCKOUT_MS, readPasscodeLength, type PasscodeLength } from '@/lib/passcode';
import { getSupabase } from '@/lib/supabase';
import { useLock } from '@/store/lock';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function PasscodeScreen() {
  const router = useRouter();
  const { spacing, colors } = useTheme();

  const user = useSession((state) => state.user);
  const isLocked = useLock((state) => state.isLocked);

  const [length, setLength] = useState<PasscodeLength>(4);
  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [shake, setShake] = useState(false);
  /*
   * The lockout is ONE piece of state, not a pair.
   *
   * An earlier version held `lockedUntil` plus a `secondsLeft` counter and
   * synchronised them from an effect. That is a setState inside an effect on mount,
   * which the compiler rules reject and which cascades an extra render before
   * anything is painted.
   *
   * A single nullable deadline is the whole state. The number shown is derived from
   * it during render, and the interval's only job is to expire it.
   */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /*
   * The stored length is READ, never assumed.
   *
   * Assuming 4 is the bug that made a six-digit passcode impossible to enter: the
   * keypad submitted on the fourth digit, the remaining two were swallowed by the
   * in-flight hash, and every one of those entries burned one of only five lives.
   */
  useEffect(() => {
    if (!user?.id) return;

    let cancelled = false;
    void readPasscodeLength(user.id).then((stored) => {
      if (cancelled) return;
      // A record from before the length field existed reports null; asking is
      // better than guessing.
      if (stored === 4 || stored === 6) setLength(stored);
    });

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  /*
   * Expire the lockout once the window has passed.
   *
   * No setState on mount: the interval's only job is to clear the deadline when it
   * lapses. The seconds on screen are derived during render by `useCountdownTick`,
   * so nothing has to be pushed into state for the countdown to move, and an idle
   * screen is not re-rendering every second.
   */
  useEffect(() => {
    if (lockedUntil === null || lockedUntil <= Date.now()) return undefined;

    const timer = setInterval(() => {
      if (Date.now() >= lockedUntil) setLockedUntil(null);
    }, 500);

    return () => clearInterval(timer);
  }, [lockedUntil]);

  const secondsLeft = useCountdownTick(lockedUntil);

  /*
   * A plain function, not a `useCallback`.
   *
   * The memoised version could not be preserved by the compiler, because the body
   * reaches into a zustand store via `getState()` and the compiler cannot prove the
   * returned promise is stable across renders. Nothing here needs a stable identity:
   * `PasscodeKeypad` is not memoised on `onComplete`, and the value it closes over is
   * read fresh on every render anyway. A `useCallback` that the compiler then has to
   * opt out of is worse than no `useCallback` at all.
   */
  const onComplete = async (digits: string) => {
    if (checking || !user?.id) return;

      setChecking(true);
      setShake(false);
      setMessage(null);

      try {
        /*
         * Verification runs through the store, not directly, so there is ONE place
         * that turns a verdict into a lock state. The screen never sets `isLocked`
         * itself -- that is what previously allowed two code paths to disagree about
         * whether the app was open.
         */
        const result = await useLock.getState().unlock(user.id, digits);

        if (result.ok) {
          setValue('');
          router.replace('/(app)');
          return;
        }

        setShake(true);
        setMessage(result.message || 'Incorrect passcode.');
        setValue('');

        if (result.lockedOut) {
          // Read the window back from the policy rather than restating it, so the
          // countdown can never disagree with the actual cooldown.
          setLockedUntil(Date.now() + PASSCODE_LOCKOUT_MS);
        }
      } catch {
        // An unreadable keystore must not authenticate anyone, and must not read as
        // "you typed it wrong" -- those are different problems with different fixes.
        setShake(true);
        setMessage('Could not check your passcode. Try again in a moment.');
        setValue('');
      } finally {
        setChecking(false);
      }
  };

  const signOut = async () => {
    if (isConfiguredGuard()) {
      await getSupabase().auth.signOut().catch(() => {
        // A network failure must still leave the device signed out locally.
      });
    }
    useSession.getState().signOut().catch(() => {});
    router.replace('/sign-in');
  };

  /*
   * Already unlocked: nothing to do here.
   *
   * Reached by deep link or by a race after a successful sign-in. Redirecting
   * rather than rendering a keypad a seller does not need.
   */
  if (!user) {
    return (
      <ErrorState
        title="No active session"
        action="Sign in again to unlock SellFlow."
        onRetry={() => router.replace('/sign-in')}
      />
    );
  }

  return (
    <Screen
      testID="passcode-screen"
      width="form"
      footer={
        <Button
          label="Use a different account"
          variant="ghost"
          fullWidth
          onPress={() => void signOut()}
          testID="passcode-signout"
        />
      }
    >
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xs, alignItems: 'center' }}>
          <Text variant="title">Enter your passcode</Text>
          <Text variant="body" tone="secondary" center>
            {user.email ?? 'Your account'}
          </Text>
        </View>

        <Card>
          <View style={{ gap: spacing.md, alignItems: 'center' }}>
            <PasscodeKeypad
              length={length}
              value={value}
              onChange={(next) => {
                setValue(next);
                setShake(false);
              }}
              onComplete={onComplete}
              disabled={checking || secondsLeft > 0}
              invalid={shake}
              testID="passcode-keypad"
            />

            {message ? (
              <Text
                variant="caption"
                tone={secondsLeft > 0 ? 'warning' : 'danger'}
                center
                testID="passcode-message"
                accessibilityLiveRegion="polite"
              >
                {secondsLeft > 0
                  ? `${message} ${secondsLeft}s`
                  : message}
              </Text>
            ) : (
              <Text variant="caption" tone="muted" center>
                {`${length} digits`}
              </Text>
            )}
          </View>
        </Card>
      </View>
    </Screen>
  );
}

/** Kept local so the screen reads the guard rather than importing isConfigured. */
function isConfiguredGuard(): boolean {
  try {
    return Boolean(getSupabase());
  } catch {
    return false;
  }
}