/**
 * Passcode setup and change.
 *
 * Reached from Settings to set, change or remove a passcode, and no longer from
 * onboarding -- registration asks for it directly now.
 *
 * Two stages, unlike the unlock screen: here the value is being kept for months,
 * so mistyping it and locking yourself out deserves a confirmation the unlock
 * screen correctly does not need.
 *
 * The length is chosen up front rather than inferred, and the keypad is told what
 * it is. This is the fix for a real lockout: the unlock screen used to submit on
 * the fourth digit regardless of what had been set, so a six digit passcode could
 * be created here and then never entered again -- five attempts and the record was
 * deleted.
 */

import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { RotateCcw } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { BrandMark, Button, PasscodeKeypad, Screen, SegmentedControl, Text } from '@/components/ui';
import { PASSCODE_LENGTHS, type PasscodeLength } from '@/lib/passcode';
import { useLock } from '@/store/lock';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function SetPasscodeScreen() {
  const { spacing } = useTheme();
  const user = useSession((state) => state.user);
  const setPasscode = useLock((state) => state.setPasscode);
  const hasPasscode = useLock((state) => state.hasPasscode);

  const [length, setLength] = useState<PasscodeLength>(4);
  const [stage, setStage] = useState<'create' | 'confirm'>('create');
  const [first, setFirst] = useState('');
  const [entry, setEntry] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const finish = useCallback(
    async (code: string) => {
      if (!user) return;
      setBusy(true);
      try {
        const result = await setPasscode(user.id, code, PASSCODE_LENGTHS);
        if (result.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          // Back, not replace: this screen is pushed from Settings, so returning
          // there leaves the seller where they were.
          if (router.canGoBack()) router.back();
          else router.replace('/(app)');
        } else {
          setError(result.message);
          setEntry('');
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
      } finally {
        setBusy(false);
      }
    },
    [setPasscode, user],
  );

  function restart() {
    setFirst('');
    setEntry('');
    setError('');
    setStage('create');
  }

  function handleComplete(code: string) {
    if (stage === 'create') {
      setFirst(code);
      setEntry('');
      setStage('confirm');
      return;
    }
    if (code !== first) {
      // Never silently accept a different value.
      setError('Those did not match. Start again.');
      setEntry('');
      restart();
      return;
    }
    void finish(code);
  }

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
          <Text variant="heading">
            {stage === 'create'
              ? hasPasscode
                ? 'Choose a new passcode'
                : 'Create a passcode'
              : 'Confirm your passcode'}
          </Text>
          <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
            {stage === 'create'
              ? 'This is what unlocks SellFlow each time you open it.'
              : 'Enter the same digits again.'}
          </Text>
        </View>

        {/* Only offered while choosing; the confirm stage is committed to it. */}
        {stage === 'create' ? (
          <SegmentedControl
            options={PASSCODE_LENGTHS.map((value) => ({ value, label: `${value} digits` }))}
            value={length}
            onChange={(value) => {
              setLength(value);
              setEntry('');
              setError('');
            }}
            style={{ alignSelf: 'stretch' }}
          />
        ) : null}

        <View style={{ minHeight: 20 }}>
          {error ? (
            <Text variant="caption" tone="danger" style={{ textAlign: 'center' }} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
        </View>

        <PasscodeKeypad
          value={entry}
          length={length}
          onChange={(next) => {
            setEntry(next);
            if (error) setError('');
          }}
          onComplete={handleComplete}
          disabled={busy}
          invalid={Boolean(error)}
        />

        <Text variant="micro" tone="muted" style={{ textAlign: 'center', maxWidth: 320 }}>
          Stored on this device only, as a salted hash in the phone&apos;s secure keystore.
          It is never sent to SellFlow and cannot be recovered.
        </Text>

        {stage === 'confirm' ? (
          <Button
            label="Start over"
            variant="ghost"
            icon={RotateCcw}
            onPress={restart}
            disabled={busy}
            block
          />
        ) : null}
      </View>
    </Screen>
  );
}
