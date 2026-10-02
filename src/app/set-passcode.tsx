/**
 * Passcode setup.
 *
 * Offered once, after the business exists, so the seller is never asked about
 * security before they have seen the product. Skipping is a first-class choice:
 * a seller who does not want a passcode is not blocked from using SellFlow.
 *
 * The same keypad as the entry screen, with a confirm step -- here the value is
 * being set for months, so mistyping it and locking yourself out deserves a
 * confirmation the entry screen does not need.
 */

import { useCallback, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Delete, ShieldCheck } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { Button, Screen, Text } from '@/components/ui';
import { useLock } from '@/store/lock';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

const MIN_LENGTH = 4;
const MAX_LENGTH = 8;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

export default function SetPasscodeScreen() {
  const { spacing, colors, radius, typography } = useTheme();
  const user = useSession((state) => state.user);
  const setPasscode = useLock((state) => state.setPasscode);

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
        const result = await setPasscode(user.id, code);
        if (result.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.replace('/(app)');
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

    if (next.length < MIN_LENGTH) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return;
    }

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    if (stage === 'create') {
      setFirst(next);
      setEntry('');
      setStage('confirm');
      return;
    }

    if (next !== first) {
      // Do not silently accept a different value; send them back to the start.
      setError('Those did not match. Start again.');
      setEntry('');
      setFirst('');
      setStage('create');
      return;
    }

    void finish(next);
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
          <Text variant="heading">
            {stage === 'create' ? 'Create a passcode' : 'Confirm your passcode'}
          </Text>
          <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
            {stage === 'create'
              ? `${MIN_LENGTH} to ${MAX_LENGTH} digits. Asked once when you sign in.`
              : 'Enter the same digits again.'}
          </Text>
        </View>

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
                key === 'clear' ? 'Clear' : key === 'back' ? 'Delete last digit' : `Digit ${key}`
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
          label="Skip for now"
          variant="ghost"
          onPress={() => {
            useLock.getState().markOffered();
            router.replace('/(app)');
          }}
          disabled={busy}
          block
        />

        {stage === 'confirm' ? (
          <Button
            label="Start over"
            variant="ghost"
            icon={ShieldCheck}
            onPress={() => {
              setFirst('');
              setEntry('');
              setError('');
              setStage('create');
            }}
            disabled={busy}
            block
          />
        ) : null}
      </View>
    </Screen>
  );
}