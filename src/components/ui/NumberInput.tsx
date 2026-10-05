/**
 * Whole-number input, for quantities rather than money.
 *
 * WHY THIS IS NOT MoneyInput
 *
 * Quantities are counts: a low-stock alert at 5 units, a correction of +3 pieces. They
 * are not money. Reusing the money parser for them is a real bug, not a style
 * preference -- money multiplies by the currency's decimals, so a threshold of 5
 * silently becomes 500 and a stock correction of +3 becomes 300. `parseWholeNumber`
 * lives in src/lib/money.ts precisely to keep that distinction in one place.
 *
 * A count also has no decimals and no currency symbol. Showing "৳" beside a number of
 * shirts tells the seller the wrong thing about what they are typing.
 *
 * The field still holds the STRING the seller typed, for the caret reason documented
 * in MoneyInput: reformatting on every keystroke moves the cursor.
 */

import { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Minus, Plus } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { parseWholeNumber } from '@/lib/money';
import { Input } from './Input';

export interface NumberInputProps {
  label: string;
  /** Null means "not filled in yet", which is distinct from zero. */
  value: number | null;
  onChange: (next: number | null) => void;
  error?: string | null;
  hint?: string;
  required?: boolean;
  /** Stepper buttons. Worth having on every count -- stock is edited with one thumb. */
  stepper?: { step: number; min?: number; max?: number };
  testID?: string;
}

export function NumberInput({
  label,
  value,
  onChange,
  error,
  hint,
  required,
  stepper,
  testID,
}: NumberInputProps) {
  const { colors, spacing } = useTheme();
  const [text, setText] = useState(value === null ? '' : String(value));
  const [focused, setFocused] = useState(false);

  /*
   * Derived, not pushed. An effect syncing `value` back into `text` would fight the
   * seller mid-keystroke. Only the stepper writes to `text`, because that is the one
   * case where the value genuinely changes underneath the cursor.
   */
  const commit = useCallback(
    (next: string) => {
      // Blocking the character beats accepting and discarding it: the latter makes
      // the field look broken on a numeric keypad.
      const digits = next.replace(/[^\d]/g, '');
      setText(digits);
      onChange(digits === '' ? null : parseWholeNumber(digits));
    },
    [onChange],
  );

  const current = value ?? 0;

  const nudge = useCallback(
    (direction: 1 | -1) => {
      const step = stepper?.step ?? 1;
      const min = stepper?.min ?? 0;
      const max = stepper?.max ?? Number.MAX_SAFE_INTEGER;
      const next = Math.min(max, Math.max(min, current + direction * step));
      onChange(next);
      setText(String(next));
    },
    [current, onChange, stepper],
  );

  /*
   * Reformatted on blur only, never on every keystroke -- same rule as MoneyInput,
   * for the same reason.
   */
  const display = useMemo(() => {
    if (focused) return text;
    if (value === null) return '';
    return String(value);
  }, [focused, text, value]);

  return (
    <View style={{ gap: spacing.xxs }}>
      <Input
        label={label}
        required={required}
        value={display}
        onChangeText={commit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        error={error}
        hint={hint}
        keyboardType="number-pad"
        placeholder="0"
        testID={testID ? `${testID}-input` : undefined}
        accessibilityLabel={`${label}, a count`}
      />

      {stepper ? (
        <View style={{ flexDirection: 'row', gap: spacing.xs }}>
          <StepperButton
            onPress={() => nudge(-1)}
            disabled={current <= (stepper.min ?? 0)}
            label="Decrease"
            testID={testID ? `${testID}-minus` : undefined}
            icon={<Minus size={16} color={colors.text} strokeWidth={2} />}
          />
          <StepperButton
            onPress={() => nudge(1)}
            disabled={current >= (stepper.max ?? Number.MAX_SAFE_INTEGER)}
            label="Increase"
            testID={testID ? `${testID}-plus` : undefined}
            icon={<Plus size={16} color={colors.text} strokeWidth={2} />}
          />
        </View>
      ) : null}
    </View>
  );
}

function StepperButton({
  onPress,
  label,
  icon,
  disabled,
  testID,
}: {
  onPress: () => void;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  testID?: string;
}) {
  const { colors, radius, spacing, controlHeight } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [
        {
          width: 48,
          height: controlHeight,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: radius.sm,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: pressed ? colors.surfaceHover : 'transparent',
          opacity: disabled ? 0.4 : 1,
          marginTop: spacing.xxs,
        },
      ]}
    >
      {icon}
    </Pressable>
  );
}