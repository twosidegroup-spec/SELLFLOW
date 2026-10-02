/**
 * Passcode entry.
 *
 * Shown when a passcode is set and the device has been locked -- on sign-in,
 * and again whenever the app returns from the background for longer than
 * GRACE_MS. Nothing behind it is reachable: this screen is a gate, and it does
 * not sit in the tab navigator.
 *
 * Deliberately a custom keypad rather than a `TextInput`. A system keyboard
 * leaves the entered digits visible in the OS keyboard cache and offers
 * autofill; a purpose-built keypad never puts the passcode in a text field.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Delete, ShieldCheck } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { Button, Screen, Text } from '@/components/ui';
import { PASSCODE_ATTEMPTS } from '@/lib/passcode';
import { useSession } from '@/store/session';
import { useLock } from '@/store/lock';
import { useTheme } from '@/theme/ThemeProvider';

const MIN_LENGTH = 4;
const MAX_LENGTH = 8;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

export default function PasscodeScreen() {
  const { spacing, colors, radius, typography } = useTheme();
  const user = useSession((state) => state.user);
  const signOut = useSession((state) => state.signOut);

  const isLocked = useLock((state) => state.isLocked);
  const hasPasscode = useLock((state) => state.hasPasscode);
  const unlock = useLock((state) => state.unlock);

  const [entry, setEntry] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const attemptsLeft = useRef(PASSCODE_ATTEMPTS);

  /*
   * Nothing to unlock. This happens on a fresh install, or after the passcode
   * was wiped by too many failed attempts -- either way the seller should be
   * inside the app, not staring at a keypad.
   */
  useEffect(() => {
    if (!isLocked) {
      router.replace('/(app)');
    }
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
          setEntry('');
          router.replace('/(app)');
        } else {
          attemptsLeft.current -= 1;
          setEntry('');
          setError(result.message);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
      } finally {
        setBusy(false);
      }
    },
    [unlock, user],
  );

  function press(key: (typeof KEYS)[number]) {
    if (busy) return;

    if (key === 'clear') {
      setEntry('');
      setError('');
      return;
    }
    if (key === 'back') {
      setEntry((prev) => prev.slice(0, -1));
      return;
    }
    if (entry.length >= MAX_LENGTH) return;

    const next = entry + key;
    setEntry(next);
    if (error) setError('');

    // Auto-submit the moment it could be long enough to be valid. A confirm
    // step is deliberately skipped: a passcode is short, and an extra tap for a
    // value the seller just typed is friction with no safety gain.
    if (next.length >= MIN_LENGTH) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      void submit(next);
    }
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
        <Image
          source={require('@/../assets/icon.png')}
          style={{ width: 64, height: 64, borderRadius: radius.card }}
          resizeMode="contain"
          accessibilityLabel="SellFlow"
        />

        <View style={{ alignItems: 'center', gap: spacing.xxs }}>
          <Text variant="heading">Enter your passcode</Text>
          <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
            {hasPasscode
              ? 'Unlock SellFlow to continue'
              : 'No passcode is set for this account'}
          </Text>
        </View>

        {/* Dots, not the digits. Length is visible, value is not. */}
        <View style={{ flexDirection: 'row', gap: spacing.md, minHeight: 16 }}>
          {Array.from({ length: Math.max(MIN_LENGTH, entry.length) }).map((_, i) => (
            <View
              key={i}
              style={{
                width: 12,
                height: 12,
                borderRadius: radius.pill,
                backgroundColor: i < entry.length ? colors.primary : 'transparent',
                borderWidth: i < entry.length ? 0 : 1.5,
                borderColor: error ? colors.danger : colors.borderStrong,
              }}
            />
          ))}
        </View>

        {error ? (
          <Text variant="caption" tone="danger" style={{ textAlign: 'center' }} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : (
          <View style={{ minHeight: 20 }} />
        )}

        <View
          style={{
            width: 264,
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            columnGap: spacing.md,
            rowGap: spacing.md,
          }}
        >
          {KEYS.map((key) => (
            <Pressable
              key={key}
              onPress={() => press(key)}
              accessibilityRole="button"
              accessibilityLabel={
                key === 'clear' ? 'Clear passcode' : key === 'back' ? 'Delete last digit' : `Digit ${key}`
              }
              style={({ pressed }) => ({
                width: 72,
                height: 60,
                borderRadius: radius.card,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? colors.pressed : 'transparent',
              })}
            >
              {key === 'clear' ? (
                <Text variant="caption" tone="muted" style={typography.subtitle}>
                  Clear
                </Text>
              ) : key === 'back' ? (
                <Delete size={22} color={colors.textMuted} />
              ) : (
                <Text variant="numericLarge">{key}</Text>
              )}
            </Pressable>
          ))}
        </View>

        <Button
          label="Sign in as somebody else"
          variant="ghost"
          icon={ShieldCheck}
          onPress={() => void signOut()}
          disabled={busy}
          block
        />
      </View>
    </Screen>
  );
}