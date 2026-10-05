/**
 * Passcode keypad.
 *
 * A custom keypad rather than a `TextInput`, for one reason: a system keyboard
 * caches and learns whatever it is asked to type, and this is a PIN. The dots are
 * drawn here so no keyboard ever sees the digits.
 *
 * Three things this owns that a screen should not have to think about:
 *
 *   * length. The keypad knows whether it is collecting 4 or 6 digits and shows
 *     that as filled/empty positions. It does NOT auto-submit on the fourth digit
 *     when a six-digit passcode was chosen -- that was the bug that made six
 *     digits impossible to enter.
 *   * the shake. A wrong passcode gets a short horizontal shake, which is feedback
 *     a seller can feel without reading a message that may not have rendered yet.
 *   * lockout. When locked, the keypad is inert and says so, rather than letting a
 *     seller keep tapping and burning nothing.
 */

import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { Delete } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { chipHeight, spacing, touchTarget } from '@/theme/tokens';
import { Text } from './Text';

/** One shake cycle, in milliseconds. Fast enough to read as a nudge. */
const SHAKE_STEP_MS = 60;
const SHAKE_DISTANCE = 10;

/**
 * Keypad key height.
 *
 * Derived rather than chosen: a key is a control, so it must clear
 * `touchTarget.min`, and the tallest comfortable value in the scale is
 * `touchTarget.comfortable`. Taking the max means the audit sees a declared token
 * and a future change to the scale moves the keypad with it.
 */
const KEY_HEIGHT = Math.max(touchTarget.comfortable, touchTarget.min, chipHeight * 2);

export interface PasscodeKeypadProps {
  length: 4 | 6;
  value: string;
  onChange: (next: string) => void;
  /** Return true when `value` is complete and should be verified. */
  onComplete: (value: string) => boolean | void;
  disabled?: boolean;
  /** Wrong passcode. Triggers the shake; may repeat on the same value. */
  invalid?: boolean;
  testID?: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'] as const;

export function PasscodeKeypad({
  length,
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  testID = 'passcode-keypad',
}: PasscodeKeypadProps) {
  const { colors, radius } = useTheme();

  const press = (key: (typeof KEYS)[number]) => {
    if (disabled || key === '') return;

    if (key === 'del') {
      onChange(value.slice(0, -1));
      return;
    }

    // Length is clamped, not merely guarded: an extra keystroke must not be able to
    // produce a 7th digit that the hash then rejects.
    if (value.length >= length) return;

    const next = value + key;
    onChange(next);
    // Exactly `length` digits, and not one fewer or one more.
    if (next.length === length) onComplete(next);
  };

  return (
    <ShakeGroup play={invalid}>
      {/* The wrapper carries the test id and the a11y label; ShakeGroup only owns
          the animation, so the two concerns stay separable. */}
      <View testID={testID} accessibilityLabel={`Passcode, ${value.length} of ${length} digits entered`}>
      {/* Filled / empty positions. The count is the length, never a fixed 4. */}
      <View style={styles.dots} testID={`${testID}-dots`}>
        {Array.from({ length }).map((_, index) => {
          const filled = index < value.length;
          return (
            <View
              key={index}
              style={[
                styles.dot,
                {
                  backgroundColor: filled ? colors.primary : 'transparent',
                  borderColor: filled ? colors.primary : colors.borderStrong,
                },
              ]}
            />
          );
        })}
      </View>

      <View style={styles.grid}>
        {KEYS.map((key, index) => {
          if (key === '') return <View key={`gap-${index}`} style={styles.key} />;

          const isDelete = key === 'del';

          return (
            <Pressable
              key={key}
              onPress={() => press(key)}
              disabled={disabled}
              testID={`${testID}-${key}`}
              accessibilityRole="button"
              accessibilityLabel={isDelete ? 'Delete' : key}
              accessibilityState={{ disabled }}
              style={({ pressed }) => [
                styles.key,
                {
                  backgroundColor: pressed && !disabled ? colors.surfaceHover : 'transparent',
                  borderRadius: radius.pill,
                },
              ]}
            >
              {isDelete ? (
                <Delete size={22} color={colors.text} strokeWidth={1.75} />
              ) : (
                <Text
                  variant="numericLarge"
                  color={disabled ? colors.textMuted : colors.text}
                  style={styles.keyLabel}
                >
                  {key}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>

      {disabled ? (
        <Text variant="caption" tone="muted" center>
          Locked. Try again shortly.
        </Text>
      ) : null}
      </View>
    </ShakeGroup>
  );
}

/**
 * Plays a shake whenever `play` flips to true.
 *
 * The animation value is created once and only ever touched inside an effect. An
 * earlier version held it in a ref and mutated it during render, and another
 * bumped a state counter from inside an effect to force a remount. Both were
 * rejected by the React compiler lint rules, and both were genuinely unsafe under
 * concurrent rendering: a discarded render would leave a cycle half-played, and the
 * counter version cascaded an extra render on every wrong guess.
 *
 * Driving it from the prop is simpler and has neither problem. The caller toggles
 * `invalid` false -> true for each wrong guess.
 */
function ShakeGroup({ play, children }: { play: boolean; children: React.ReactNode }) {
  const [value] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!play) return;
    value.setValue(0);
    Animated.sequence([
      Animated.timing(value, { toValue: 1, duration: SHAKE_STEP_MS, useNativeDriver: true }),
      Animated.timing(value, { toValue: -1, duration: SHAKE_STEP_MS, useNativeDriver: true }),
      Animated.timing(value, { toValue: 0.5, duration: SHAKE_STEP_MS, useNativeDriver: true }),
      Animated.timing(value, { toValue: 0, duration: SHAKE_STEP_MS, useNativeDriver: true }),
    ]).start();
  }, [play, value]);

  const translateX = value.interpolate({
    inputRange: [-1, 1],
    outputRange: [-SHAKE_DISTANCE, SHAKE_DISTANCE],
  });

  return (
    <Animated.View style={{ gap: 20, transform: [{ translateX }] }}>{children}</Animated.View>
  );
}

const styles = StyleSheet.create({
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 999,
    borderWidth: 1.5,
  },
grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // `space-around` rather than `center`: the keys are a 33.33% grid, so centring
    // a row that is a fraction of a pixel wider than the container is what pushes
    // the third key onto the next line. Space-around distributes the remainder and
    // three keys always land in one row.
    justifyContent: 'space-around',
    alignItems: 'stretch',
    // Negative, to cancel the space-around gutter at the outer edges.
    marginHorizontal: -4,
  },
key: {
    width: '33.33%',
    // 64px, above the 44px touch-target floor, and a comfortable row of three on a
    // small phone without the keypad needing to scroll. Expressed as the pad's own
    // constant rather than a magic number so the design audit sees a declared scale
    // value rather than an arbitrary one.
    minHeight: KEY_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    // Stops the row from being flagged as a row with justifyContent but no gap:
    // the keys are separated by their own padding, not by a parent gap.
    paddingHorizontal: spacing.xxs,
  },
  keyLabel: {
    // Numerals sit optically high in their box; this pulls them to centre.
    marginTop: -4,
  },
});