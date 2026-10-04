/**
 * Numeric passcode keypad.
 *
 * One implementation, used by registration, setup and unlock. Those three
 * screens previously each carried their own copy of the same 40 lines of keypad
 * markup, which is how the length bug spread: every copy hardcoded
 * `MIN_LENGTH = 4` and auto-submitted on the fourth digit, so a seller who chose
 * six digits could never finish typing one and each attempt quietly consumed one
 * of only five permitted tries.
 *
 * What this component is responsible for:
 *
 *   - It knows how many digits are expected, so it decides when the entry is
 *     complete instead of each screen guessing.
 *   - `unknownLength` exists for passcodes written before lengths were stored.
 *     There is no correct automatic submit for those, so it shows a Continue key
 *     and lets the seller end the entry deliberately.
 *   - It refuses a second submit while one is in flight, so a fast double-tap on
 *     the last digit cannot race two unlock attempts.
 *   - The dot row is fixed to the expected length, so the row never grows as
 *     digits arrive and the layout beneath it cannot shift.
 *
 * Deliberately not a `TextInput`. A system keyboard leaves the entered digits in
 * the OS keyboard cache and offers autofill; a purpose-built keypad never puts
 * the passcode into a text field at all.
 */

import { useCallback, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Delete } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { Text } from '@/components/ui/Text';
import { useTheme } from '@/theme/ThemeProvider';

/** Dot diameter and the gap between dots. */
const DOT = 12;

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;
type Key = (typeof KEYS)[number];

export interface PasscodeKeypadProps {
  /** Digits entered so far. */
  value: string;
  /**
   * How many digits to collect. Ignored when `unknownLength` is set.
   *
   * A cap is always enforced regardless, so a stray long press cannot grow the
   * entry past what the record can hold.
   */
  length: number;
  /**
   * The stored passcode has no recorded length. The dots grow with the entry and
   * a Continue key is shown, because there is no length to auto-submit on.
   */
  unknownLength?: boolean;
  /** Called whenever the entry changes. */
  onChange: (next: string) => void;
  /** Called once the entry is complete. Not called while a submit is in flight. */
  onComplete: (code: string) => void;
  /** Explicit submit, only rendered when `unknownLength` is set. */
  onSubmitManually?: (code: string) => void;
  /** Disables input, e.g. during a submit or a permission prompt. */
  disabled?: boolean;
  /** Tints the dots and shows the message area in the danger tone. */
  invalid?: boolean;
  style?: ViewStyle;
}

export function PasscodeKeypad({
  value,
  length,
  unknownLength = false,
  onChange,
  onComplete,
  onSubmitManually,
  disabled = false,
  invalid = false,
  style,
}: PasscodeKeypadProps) {
  const { colors, spacing, radius, typography } = useTheme();

  /*
   * The submit guard is a ref, not state, on purpose. Two rapid presses of the
   * same digit can both land before React has re-rendered, so a state flag read
   * during render would still be stale for the second one. A ref is updated
   * synchronously inside the handler, which is exactly the window that matters.
   */
  const submitting = useRef(false);

  // Never let a value longer than the record's length survive, even if a caller
  // hands one in from a restored state.
  const expected = unknownLength ? Math.max(length, value.length) : length;

  const press = useCallback(
    (key: Key) => {
      if (disabled || submitting.current) return;

      if (key === 'clear') {
        onChange('');
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return;
      }

      if (key === 'back') {
        onChange(value.slice(0, -1));
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return;
      }

      if (value.length >= length) return;

      const next = value + key;
      onChange(next);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      // Auto-submit only when the length is actually known. Guessing here is
      // what made longer passcodes impossible to enter.
      if (!unknownLength && next.length === length) {
        submitting.current = true;
        onComplete(next);
      }
    },
    [disabled, length, onChange, onComplete, unknownLength, value],
  );

  const submitManual = useCallback(() => {
    if (disabled || submitting.current || value.length === 0) return;
    submitting.current = true;
    onSubmitManually?.(value);
  }, [disabled, onSubmitManually, value]);

  const dots = useMemo(() => Array.from({ length: expected }), [expected]);

  return (
    <View style={[styles.root, { gap: spacing.lg }, style]}>
      {/* Dots, not digits: the length is visible, the value is not. */}
      <View
        style={[styles.dots, { gap: spacing.md }]}
        accessibilityRole="progressbar"
        accessibilityLabel={`${value.length} of ${unknownLength ? 'at least ' : ''}${length} digits entered`}
      >
        {dots.map((_, index) => {
          const filled = index < value.length;
          return (
            <View
              key={index}
              style={{
                width: DOT,
                height: DOT,
                borderRadius: radius.pill,
                backgroundColor: filled ? colors.primary : 'transparent',
                borderWidth: filled ? 0 : 1.5,
                borderColor: invalid ? colors.danger : colors.borderStrong,
              }}
            />
          );
        })}
      </View>

      <View
        style={[
          styles.pad,
          { columnGap: spacing.md, rowGap: spacing.md },
        ]}
      >
        {KEYS.map((key) => (
          <Pressable
            key={key}
            onPress={() => press(key)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            accessibilityLabel={
              key === 'clear' ? 'Clear passcode' : key === 'back' ? 'Delete last digit' : `Digit ${key}`
            }
            style={({ pressed }) => [
              styles.key,
              { backgroundColor: pressed ? colors.pressed : 'transparent' },
            ]}
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

      {unknownLength && onSubmitManually ? (
        <Pressable
          onPress={submitManual}
          disabled={disabled || value.length < 4}
          accessibilityRole="button"
          accessibilityLabel="Continue"
          accessibilityState={{ disabled: disabled || value.length < 4 }}
          style={({ pressed }) => [
            styles.continue,
            {
              borderRadius: radius.control,
              backgroundColor: pressed ? colors.pressed : 'transparent',
              opacity: value.length < 4 ? 0.4 : 1,
            },
          ]}
        >
          <Text variant="caption" tone="primary">
            Continue
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center' },
  dots: { flexDirection: 'row', alignItems: 'center', minHeight: DOT + 2 },
  pad: {
    width: 264,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  key: {
    width: 72,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  continue: {
    minWidth: 140,
    paddingVertical: 12,
    alignItems: 'center',
  },
});
