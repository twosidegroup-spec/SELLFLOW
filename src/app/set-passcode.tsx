/**
 * Set a passcode.
 *
 * TWO STAGES, ALWAYS: create, then confirm.
 *
 * This is the fix for a self-inflicted lockout. V1's registration captured the
 * passcode once and moved on, so a typo left the seller staring at a keypad where
 * every entry counted as a failed attempt -- and five failures used to delete the
 * record. The seller had mistyped once and was locked out of a business holding
 * their live orders.
 *
 * `set-passcode.tsx` had already been given the two-stage flow. Registration had
 * not. This is that same flow, used by both, so the rule cannot drift between them.
 *
 * The keypad never auto-submits before the chosen length is reached, which is what
 * makes a six-digit passcode enterable at all.
 */

import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { ShieldCheck } from 'lucide-react-native';

import { Button, Card, ErrorState, LoadingState, PasscodeKeypad, Screen, Text } from '@/components/ui';
import { PASSCODE_LENGTHS, validatePasscode, type PasscodeLength } from '@/lib/passcode';
import { useTheme } from '@/theme/ThemeProvider';

export interface SetPasscodeProps {
  /**
   * Persists the passcode. Resolving is the only definition of success, so this
   * must reject when the keystore write fails.
   */
  onSet: (passcode: string) => Promise<void>;
  /** Called after a successful write, once the seller confirms. */
  onDone: () => void;
  /** Shown instead of the form. */
  busy?: boolean;
  error?: string | null;
  /** Skips straight to the end. Used when a passcode already exists. */
  optional?: boolean;
}

export default function SetPasscodeScreen({ onSet, onDone, busy, error, optional }: SetPasscodeProps) {
  const { spacing, colors } = useTheme();

  const [length, setLength] = useState<PasscodeLength>(4);
  const [stage, setStage] = useState<'create' | 'confirm'>('create');
  const [first, setFirst] = useState('');
  const [value, setValue] = useState('');
  const [shake, setShake] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const mismatch = () => {
    // Restart rather than merely complaining. The seller already knows it is wrong;
    // making them press delete four times to clear it is busywork.
    setShake(true);
    setStage('create');
    setFirst('');
    setValue('');
  };

  const onComplete = useCallback(
    async (digits: string) => {
      if (stage === 'create') {
        const check = validatePasscode(digits, PASSCODE_LENGTHS);
        if (!check.ok) {
          setShake(true);
          setLocalError(check.message);
          setValue('');
          return;
        }
        setFirst(digits);
        setValue('');
        setStage('confirm');
        return;
      }

      if (digits !== first) {
        mismatch();
        return;
      }

      setSaving(true);
      setLocalError(null);
      try {
        await onSet(digits);
        onDone();
      } catch (caught) {
        setLocalError(caught instanceof Error ? caught.message : 'Could not save your passcode.');
        setSaving(false);
        setStage('create');
        setFirst('');
        setValue('');
      }
    },
    [stage, first, onSet, onDone],
  );

  if (busy) return <LoadingState label="Setting up your business" />;

  const failed = error ?? localError;

  if (failed && saving) {
    return (
      <ErrorState
        title="Could not finish setting up"
        action={failed}
        onRetry={() => {
          setLocalError(null);
          setSaving(false);
        }}
      />
    );
  }

  return (
    <Screen
      testID="set-passcode-screen"
      width="form"
      edges={['top', 'bottom']}
      footer={
        optional ? (
          <Button
            label="Skip for now"
            variant="ghost"
            fullWidth
            onPress={onDone}
            testID="set-passcode-skip"
          />
        ) : undefined
      }
    >
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xs }}>
          <Text variant="title">
            {stage === 'create' ? 'Choose a passcode' : 'Confirm your passcode'}
          </Text>
          <Text variant="body" tone="secondary">
            {stage === 'create'
              ? 'This unlocks SellFlow on this phone. It is not your account password.'
              : 'Enter the same passcode again, to be sure it is right.'}
          </Text>
        </View>

        <Card>
          <View style={{ gap: spacing.md, alignItems: 'center' }}>
            <ShieldCheck size={20} color={colors.primary} strokeWidth={1.75} />

            {/* Length chosen BEFORE entry, never after. It has to be known, not
                guessed: the keypad waits for exactly this many digits. */}
            {stage === 'create' ? (
              <View style={{ flexDirection: 'row', gap: spacing.xs }} testID="set-passcode-lengths">
                {PASSCODE_LENGTHS.map((option) => {
                  const selected = option === length;
                  return (
                    <Button
                      key={option}
                      label={`${option} digits`}
                      variant={selected ? 'primary' : 'secondary'}
                      onPress={() => setLength(option)}
                      testID={`set-passcode-length-${option}`}
                    />
                  );
                })}
              </View>
            ) : null}

            <PasscodeKeypad
              length={length}
              value={value}
              onChange={(next) => {
                setValue(next);
                setShake(false);
              }}
              onComplete={onComplete}
              disabled={saving}
              invalid={shake}
              testID="set-passcode-keypad"
            />

            {localError ? (
              <Text variant="caption" tone="danger" center testID="set-passcode-error">
                {localError}
              </Text>
            ) : null}
          </View>
        </Card>

        {stage === 'confirm' ? (
          <Button
            label="Start over"
            variant="ghost"
            fullWidth
            onPress={mismatch}
            testID="set-passcode-restart"
          />
        ) : null}
      </View>
    </Screen>
  );
}