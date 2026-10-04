/**
 * Passcode entry: the everyday way into SellFlow.
 *
 * This screen is the whole login experience for a returning seller, and that is
 * not a shortcut around authentication. Two independent things must both be true
 * before anything behind this screen renders:
 *
 *   1. A live Supabase session. It is persisted on the device, restored at
 *      launch, and the server keeps enforcing RLS with it either way. This
 *      screen cannot grant it.
 *   2. The passcode in the platform keystore, keyed to this user's id.
 *
 * So knowing a four digit code is not enough to become a seller: on a device that
 * has never run their account there is no session and no keystore record, and the
 * only route in is the real sign-in. This is the second lock described at the top
 * of `src/lib/passcode.ts`, not a replacement for the first.
 *
 * The one case that does need a credential is a wiped passcode, which is why the
 * escape at the bottom signs out rather than offering a hint.
 */

import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { BrandMark, Button, PasscodeKeypad, Screen, Text } from '@/components/ui';
import { DEFAULT_PASSCODE_LENGTH } from '@/lib/passcode';
import { useSession } from '@/store/session';
import { useLock } from '@/store/lock';
import { useTheme } from '@/theme/ThemeProvider';

export default function PasscodeScreen() {
  const { spacing } = useTheme();
  const user = useSession((state) => state.user);
  const signOut = useSession((state) => state.signOut);

  const isLocked = useLock((state) => state.isLocked);
  const hasPasscode = useLock((state) => state.hasPasscode);
  /** Null for a record written before lengths were stored. */
  const length = useLock((state) => state.length);
  const unlock = useLock((state) => state.unlock);

  const [entry, setEntry] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Set once the record has been wiped, so the copy can change. */
  const [wiped, setWiped] = useState(false);

  /*
   * Nothing to unlock. A fresh install, or the passcode was just removed after
   * too many wrong tries. Either way the seller belongs inside the app, not
   * staring at a keypad they cannot pass.
   */
  useEffect(() => {
    if (!isLocked) router.replace('/(app)');
  }, [isLocked]);

  const submit = useCallback(
    async (code: string) => {
      if (!user) return;
      setBusy(true);
      setError('');
      try {
        const result = await unlock(user.id, code);

        if (result.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.replace('/(app)');
          return;
        }

        setEntry('');
        setError(result.message);
        // A lockout deletes the stored record, so the honest thing on screen is
        // to say so rather than leave five more tries that cannot work.
        if (result.lockedOut) setWiped(true);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } finally {
        setBusy(false);
      }
    },
    [unlock, user],
  );

  return (
    <Screen grow>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: spacing.lg,
          padding: spacing.lg,
        }}
      >
        <BrandMark size={72} />

        <View style={{ alignItems: 'center', gap: spacing.xxs }}>
          <Text variant="heading">Enter your passcode</Text>
          <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
            {hasPasscode ? 'Unlock SellFlow to continue' : 'No passcode is set for this account'}
          </Text>
          {/*
            Which account is unlocking. On a shared phone this is the difference
            between "wrong passcode" and "I typed the right one into the wrong
            account's phone".
          */}
          {user?.email && hasPasscode ? (
            <Text variant="micro" tone="muted">
              {user.email}
            </Text>
          ) : null}
        </View>

        {/* Reserved height so the keypad does not move when a message appears. */}
        <View style={{ minHeight: 20 }}>
          {error ? (
            <Text variant="caption" tone="danger" style={{ textAlign: 'center' }} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
        </View>

        <PasscodeKeypad
          value={entry}
          length={length ?? DEFAULT_PASSCODE_LENGTH}
          /*
           * A record with no stored length cannot be auto-submitted: submitting
           * at 4 is what made longer passcodes impossible to enter. So the seller
           * ends the entry deliberately instead.
           */
          unknownLength={hasPasscode && length === null}
          onChange={(next) => {
            setEntry(next);
            if (error) setError('');
          }}
          onComplete={(code) => void submit(code)}
          onSubmitManually={(code) => void submit(code)}
          disabled={busy}
          invalid={Boolean(error)}
        />

        {/*
          Signed out rather than "forgot". There is no recovery for a passcode --
          it was never transmitted -- so the honest route back in is the account
          password, and that is what this does.
        */}
        <Button
          label={wiped ? 'Sign in with your password' : 'Use a different account'}
          variant="ghost"
          onPress={() => void signOut()}
          disabled={busy}
          block
        />
      </View>
    </Screen>
  );
}
