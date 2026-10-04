/**
 * Registration completion transition.
 *
 * The brief for this moment was "polished, professional, short" and specifically
 * not a long splash. So this is a single full-bleed confirmation that plays once
 * and hands over: the brand mark settles, a check draws itself, one line of
 * context appears, and the screen navigates away.
 *
 * It uses React Native's `Animated` rather than Reanimated. The whole animation
 * is transform and opacity, which `Animated` runs on the native driver, so none
 * of it competes with the JS thread that is still finishing the last queries. It
 * is also the lower-risk choice in a codebase that does not currently use
 * Reanimated anywhere: a first-time animation dependency in the one screen a
 * brand-new seller sees is a poor place to discover a configuration problem.
 *
 * Nothing here is decorative for its own sake. There is no confetti and no
 * emoji; the mark, the rule and the tick are the existing SellFlow visual
 * language at three sizes.
 */

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';

import { automationCopy, type AutomationState } from '@/features/registration/plan';

import { BrandMark } from '@/components/ui/BrandMark';
import { Text } from '@/components/ui/Text';
import { useTheme } from '@/theme/ThemeProvider';

export interface SetupCompleteViewProps {
  /** What was actually created, shown so the screen never overstates the result. */
  accountsConnected: number;
  /**
   * The automation state derived from confirmed backend writes and the real OS
   * permission result. Taken as a value rather than recomputed here, so this
   * component has no way to talk itself into a better answer than the one
   * `deriveAutomation` gave.
   */
  automationState: AutomationState;
  /** Fired once the animation has played. Navigation is the caller's job. */
  onDone: () => void;
}

export function SetupCompleteView({
  accountsConnected,
  automationState,
  onDone,
}: SetupCompleteViewProps) {
  const { colors, spacing } = useTheme();
  const copy = automationCopy(automationState);

  /*
   * `useState` with an initialiser rather than `useRef(...).current`.
   *
   * An `Animated.Value` is a stable, non-reactive handle, so this is the React 19
   * idiom for one -- and unlike a ref it is legal to touch during render, which
   * matters because `interpolate` is called while building the style.
   */
  const [mark] = useState(() => new Animated.Value(0));
  const [tick] = useState(() => new Animated.Value(0));
  const [copyAnim] = useState(() => new Animated.Value(0));

  /*
   * Animated's completion callback ignores a returned cleanup function, so the
   * handoff timer lives in a ref and is cleared from this effect's own teardown.
   * Without that, unmounting mid-animation -- a seller who backs out -- would
   * still fire `onDone` and navigate them somewhere they did not pick.
   */
  const handoff = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const sequence = Animated.sequence([
      Animated.timing(mark, {
        toValue: 1,
        duration: 340,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.parallel([
        Animated.spring(tick, {
          toValue: 1,
          // A little overshoot reads as "landed" rather than "faded in".
          friction: 5,
          tension: 140,
          useNativeDriver: true,
        }),
        Animated.timing(copyAnim, {
          toValue: 1,
          duration: 260,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    ]);

    sequence.start(({ finished }) => {
      if (!finished) return;
      // The pause before handing over is not baked into the animation, so this
      // component never decides how long the next screen takes to appear.
      handoff.current = setTimeout(onDone, 220);
    });

    return () => {
      sequence.stop();
      if (handoff.current !== null) clearTimeout(handoff.current);
    };
  }, [copyAnim, mark, onDone, tick]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background, padding: spacing.lg }]}>
      <Animated.View
        style={[
          styles.markWrap,
          {
            opacity: mark,
            transform: [
              {
                scale: mark.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }),
              },
            ],
          },
        ]}
      >
        <BrandMark size={96} />
      </Animated.View>

      <Animated.View
        style={[
          styles.tick,
          {
            opacity: tick,
            backgroundColor: colors.successSoft,
            borderColor: colors.success,
            transform: [
              { scale: tick.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
            ],
          },
        ]}
      >
        <Check size={26} color={colors.success} strokeWidth={2.5} />
      </Animated.View>

      <Animated.View
        style={{
          opacity: copyAnim,
          alignItems: 'center',
          gap: spacing.xs,
          transform: [
            { translateY: copyAnim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
          ],
        }}
      >
        <Text variant="heading">{copy.title}</Text>
        <Text variant="caption" tone="muted" style={styles.centre}>
          {copy.body}
        </Text>
        <Text variant="micro" tone="muted" style={styles.centre}>
          {accountsConnected === 1
            ? '1 receiving number connected.'
            : `${accountsConnected} receiving numbers connected.`}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 },
  markWrap: { alignItems: 'center', justifyContent: 'center' },
  tick: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 999,
    width: 56,
    height: 56,
    // Sits below and to the right of the mark, the way a verified badge does.
    top: '32%',
    left: '58%',
  },
  centre: { textAlign: 'center', maxWidth: 320 },
});
