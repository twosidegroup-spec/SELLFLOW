/**
 * Bottom sheet.
 *
 * Used for contextual pickers and short confirmations. Built on RN's `Modal` so
 * it escapes the keyboard and touch-blocking of an absolutely-positioned view,
 * which is what causes the classic "the sheet will not open while the keyboard
 * is up" bug.
 *
 * Presentation is a quick slide-up with a fade scrim. It animates in on mount
 * and out on dismiss, and never blocks input on the scrim behind it.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** Caps the sheet height as a fraction of the screen. */
  maxHeightRatio?: number;
  /** Hides the drag handle, e.g. for a destructive confirmation. */
  hideHandle?: boolean;
  /**
   * Makes the body scroll when it is taller than `maxHeightRatio`.
   *
   * Off by default because most sheets are short, and a scroll view inside a
   * sheet that also owns a list (the product picker) nests badly. A sheet that
   * can grow past the cap must opt in, or its overflow is simply unreachable --
   * the submit button sits below the fold with no way to reach it.
   */
  scroll?: boolean;
}

export function BottomSheet({
  visible,
  onClose,
  title,
  children,
  maxHeightRatio = 0.85,
  hideHandle = false,
  scroll = false,
}: BottomSheetProps) {
  const { colors, radius, spacing, motion, elevation } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  // A lazy useState initializer rather than a ref: this is a stable value that
  // is derived, never reassigned, and it is read during render to build the
  // interpolated styles below.
  const [progress] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? motion.normal : motion.fast,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, motion.fast, motion.normal, progress]);

  const { translateY, opacity } = useMemo(
    () => ({
      translateY: progress.interpolate({
        inputRange: [0, 1],
        outputRange: [height * 0.25, 0],
      }),
      opacity: progress,
    }),
    [progress, height],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            style={[styles.scrim, { backgroundColor: colors.overlay }]}
          />
        </Animated.View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetWrapper}
          pointerEvents="box-none"
        >
          <Animated.View
            style={[
              styles.sheet,
              elevation.sheet,
              {
                backgroundColor: colors.surfaceElevated,
                borderTopLeftRadius: radius.sheet,
                borderTopRightRadius: radius.sheet,
                paddingBottom: insets.bottom + spacing.md,
                maxHeight: height * maxHeightRatio,
                transform: [{ translateY }],
                opacity,
              },
            ]}
          >
            {!hideHandle ? <View style={styles.handleArea} pointerEvents="none">
              <View
                style={{
                  width: 36,
                  height: 4,
                  // A fully-rounded cap, the same as every other pill in the app.
                  borderRadius: radius.pill,
                  backgroundColor: colors.borderStrong,
                }}
              />
            </View> : null}

            {title ? (
              <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
                <Text variant="heading">{title}</Text>
              </View>
            ) : null}

            {scroll ? (
              <ScrollView
                style={styles.scrollBody}
                contentContainerStyle={{ paddingBottom: spacing.sm }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {children}
              </ScrollView>
            ) : (
              children
            )}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  scrim: {
    flex: 1,
  },
  sheetWrapper: {
    justifyContent: 'flex-end',
  },
  sheet: {
    paddingTop: 8,
  },
  scrollBody: {
    // The handle and title live outside this, so the body only takes what is left.
    flexGrow: 0,
  },
  handleArea: {
    alignItems: 'center',
    paddingBottom: 12,
    paddingTop: 4,
  },
});
