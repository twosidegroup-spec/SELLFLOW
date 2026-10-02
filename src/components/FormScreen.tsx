/**
 * Form screen shell.
 *
 * The bug this exists to fix: four form screens placed their submit button in an
 * absolutely positioned bar at the bottom of the screen, with no
 * KeyboardAvoidingView. As soon as a low-lying field (delivery charge, amount
 * paid, stock) took focus, the keyboard covered the primary action and the
 * seller could not reach "Create order" without dismissing the keyboard first.
 * That is unreachable-by-keyboard, which is a release blocker on a phone.
 *
 * The fix is structural rather than cosmetic:
 *   * the footer is a flex sibling AFTER the scroll area, not an overlay, so it
 *     is always the last thing on screen and never sits on top of content
 *   * the whole screen sits inside a KeyboardAvoidingView, so the footer rises
 *     with the keyboard instead of being hidden behind it
 *   * the footer respects the bottom safe-area inset, so it clears the iOS home
 *     indicator and the Android gesture bar
 *
 * Android resizes the window for the keyboard (adjustResize is the Expo
 * default), so `behavior` is only needed on iOS. Setting it on Android as well
 * is a well-known source of double-compensated layouts, hence the platform
 * split.
 */

import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/ScreenHeader';
import { useTheme } from '@/theme/ThemeProvider';

export function FormScreen({
  title,
  subtitle,
  right,
  children,
  /** The primary action. Rendered in the fixed footer, outside the scroll area. */
  footer,
  /**
   * Modals and pickers. Rendered outside the scroll area so a bottom sheet is
   * never a descendant of a ScrollView, which keeps its own gesture handling
   * independent of the list underneath it.
   */
  sheets,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  sheets?: ReactNode;
}) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenHeader title={title} subtitle={subtitle} right={right} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        // The header is not part of the scrolling area, so the offset is 0 and
        // the whole remaining space is what the keyboard claims.
        keyboardVerticalOffset={0}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.sm,
            // Room for the footer so the last field can always be scrolled clear.
            paddingBottom: spacing.xl,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>

        <View
          style={[
            styles.footer,
            {
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
              paddingHorizontal: spacing.lg,
              paddingTop: spacing.sm,
              paddingBottom: insets.bottom + spacing.md,
            },
          ]}
        >
          {footer}
        </View>
      </KeyboardAvoidingView>

      {sheets}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
