/**
 * Money input.
 *
 * Sellers in Bangladesh type `1200`, `1,200`, `৳1200` or `1200.50`. All four mean
 * the same amount, and a field that rejects the last two makes a seller retype it.
 *
 * WHY THE FIELD KEEPS A STRING
 *
 * The obvious implementation stores a number and formats on change, which destroys
 * the caret: typing `1200` and inserting a separator at the `1` turns the value into
 * `1,200` with the caret in the wrong place, and the next keystroke lands mid-number.
 * So the field holds the text the seller typed, parses it on every change for a
 * numeric value, and hands BOTH to the parent.
 *
 * MONEY IS INTEGER MINOR UNITS
 *
 * Everything below the input is computed in poisha, not in floating point. A price
 * of 1200.005 does not exist, and repeated addition of such a value drifts. The
 * rounding here is HALF_UP, matching what a seller expects, and the authoritative
 * total is computed by Postgres in `create_order` regardless.
 */

import { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Minus, Plus } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { DEFAULT_CURRENCY, formatForInput, toMinor } from '@/lib/money';
import type { Money } from '@/lib/money';
import { Input } from './Input';

const CURRENCY_SYMBOL: Record<string, string> = { BDT: '৳', USD: '$', INR: '₹', PKR: '₨' };

/**
 * Parses what a seller typed into minor units.
 *
 * Tolerates the currency symbol, both thousands separators, whitespace, and a
 * trailing decimal point mid-typing (`1200.` must not read as 1200 and then get
 * reformatted out from under the caret).
 */
export function parseMoneyInput(raw: string): Money | null {
  const cleaned = raw
    .replace(/[৳$₹₨]/g, '')
    .replace(/[\s,_]/g, '')
    .trim();

  if (cleaned === '') return null;
  // A bare separator or sign in progress is not an error; it is an incomplete value.
  if (!/^-?\d*\.?\d*$/.test(cleaned)) return null;

  return toMinor(cleaned, DEFAULT_CURRENCY);
}

export interface MoneyInputProps {
  label: string;
  value: Money | null;
  onChange: (next: Money | null) => void;
  error?: string | null;
  hint?: string;
  required?: boolean;
  /** Stepper buttons. Worth having for quantity; noise for a discount. */
  stepper?: { step: number; min?: number; max?: number };
  testID?: string;
}

export function MoneyInput({
  label,
  value,
  onChange,
  error,
  hint,
  required,
  stepper,
  testID,
}: MoneyInputProps) {
  const { colors, spacing } = useTheme();
  const symbol = CURRENCY_SYMBOL[DEFAULT_CURRENCY] ?? '';

  // The text the seller is editing. Seeded from the value once, then owned by them.
  const [text, setText] = useState(() => (value === null ? '' : formatForInput(value)));
  const [focused, setFocused] = useState(false);

  const commit = useCallback(
    (next: string) => {
      setText(next);
      onChange(parseMoneyInput(next));
    },
    [onChange],
  );

  const nudge = useCallback(
    (direction: 1 | -1) => {
      const current = value ?? 0;
      const next = current + direction * (stepper?.step ?? 1);
      const clamped = Math.max(stepper?.min ?? 0, Math.min(stepper?.max ?? Infinity, next));
      commit(String(clamped));
    },
    [commit, stepper, value],
  );

  /*
   * The displayed text is reformatted on blur, not on every keystroke. While
   * focused the seller owns the string exactly; on blur it becomes canonical
   * `1,200.00`. That is the only moment reformatting is safe.
   */
  const display = useMemo(() => {
    if (focused) return text;
    if (value === null) return '';
    return formatForInput(value);
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
        prefix={symbol}
        keyboardType="decimal-pad"
        placeholder="0"
        testID={testID ? `${testID}-input` : undefined}
        accessibilityLabel={`${label} in taka`}
      />

      {stepper ? (
        <View style={{ flexDirection: 'row', gap: spacing.xs }}>
          <StepperButton
            onPress={() => nudge(-1)}
            label="Decrease"
            testID={`${testID}-minus`}
            icon={<Minus size={16} color={colors.text} strokeWidth={2} />}
          />
          <StepperButton
            onPress={() => nudge(1)}
            label="Increase"
            testID={`${testID}-plus`}
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
  testID,
}: {
  onPress: () => void;
  label: string;
  icon: React.ReactNode;
  testID?: string;
}) {
  const { colors, radius, borderWidth, touchTarget } = useTheme();

  return (
    <View
      style={{
        width: touchTarget.comfortable,
        height: touchTarget.min,
        borderRadius: radius.control,
        borderWidth: borderWidth.hairline,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <PressableScale onPress={onPress} label={label} testID={testID}>
        {icon}
      </PressableScale>
    </View>
  );
}

/**
 * A pressable that meets the 44px touch target even though the icon inside is 16px.
 *
 * `hitSlop` is used rather than a padded Pressable so the visual size stays exactly
 * the button, while the tappable area grows to the target.
 */
function PressableScale({
  onPress,
  label,
  children,
  testID,
}: {
  onPress: () => void;
  label: string;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={14}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ alignItems: 'center', justifyContent: 'center' }}
    >
      {children}
    </Pressable>
  );
}
