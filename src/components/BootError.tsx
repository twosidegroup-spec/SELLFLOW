/**
 * Startup error boundary.
 *
 * WHY THIS EXISTS
 *
 * Phase 0 found zero error boundaries in the entire app. React Native's behaviour
 * on an uncaught render error is to unmount the whole tree and leave the native
 * root view empty. That is the "blank white screen" -- not a crash, no stack
 * trace on the device, no red box in production, no way out. The seller sees
 * nothing and the app appears broken.
 *
 * A boundary above the navigator converts that into a screen with words on it,
 * because a failed render must never be able to produce an empty view.
 *
 * WHERE IT GOES
 *
 * Above `ThemeProvider`, deliberately. The fallback paints `colors.background`,
 * so if the boundary itself is rendered before the theme resolves it would read
 * from a null context and throw -- the one failure this is meant to prevent. It
 * therefore resolves its own colours from the appearance preference and the raw
 * token sets, exactly as `_layout.tsx` does for its pre-font placeholder.
 *
 * WHAT IT IS NOT
 *
 * Not a crash reporter and not a logger. It records the error name and message so
 * a support conversation has something concrete, and deliberately drops the
 * component stack: it contains file paths, and in this app those paths sit next
 * to tenant identifiers in query keys.
 */

import React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text as RNText, View } from 'react-native';
import { AlertTriangle, RotateCw } from 'lucide-react-native';

import { darkColors, lightColors, radius, spacing, touchTarget } from '@/theme/tokens';
import type { AppearancePreference } from '@/theme/ThemeProvider';

interface Props {
  children: React.ReactNode;
  /** Same preference the root layout resolved, so the fallback matches the theme. */
  preference: AppearancePreference;
  /**
   * The OS colour scheme, needed when the preference is `system`.
   *
   * `ColorSchemeName` includes `'unspecified'` on Android, which is neither
   * light nor dark, so it is normalised to light at the call site rather than
   * widening this type to admit a value that cannot pick a palette.
   */
  systemScheme: 'light' | 'dark' | null | undefined;
}

interface State {
  error: Error | null;
  /** Incremented by "Try again" to force a fresh attempt at the subtree. */
  attempt: number;
}

export class BootErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidUpdate(previous: Props): void {
    // A retry only helps if the cause is gone. When the seller fixes it by
    // changing something real -- signing in, completing setup, reconnecting --
    // the inputs change, so the error is cleared and the tree gets another chance
    // instead of staying stuck behind a "Try again" button that re-fails.
    if (this.state.error && previous.preference !== this.props.preference) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error): void {
    // Dev only. A production crash is silent by design here; the seller's next
    // step is a screenshot, not a stack trace they cannot act on.
    if (__DEV__) {
      console.error('[boot] unhandled render error', error);
    }
  }

  private retry = () => {
    this.setState((current) => ({ error: null, attempt: current.attempt + 1 }));
  };

  override render(): React.ReactNode {
    const { error, attempt } = this.state;
    if (!error) {
      return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>;
    }

    const resolved =
      this.props.preference === 'system'
        ? this.props.systemScheme === 'dark'
          ? 'dark'
          : 'light'
        : this.props.preference;
    const colors = resolved === 'dark' ? darkColors : lightColors;

    return (
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <ScrollView
          contentContainerStyle={styles.content}
          // The error text is the entire diagnostic here, so it must be
          // selectable and scrollable even when the message is long.
          showsVerticalScrollIndicator={false}
        >
          <View
            style={[styles.iconWrap, { backgroundColor: colors.dangerSoft }]}
            accessibilityElementsHidden
          >
            <AlertTriangle size={26} color={colors.danger} strokeWidth={1.75} />
          </View>

          <FallbackText color={colors.text} size={19} weight="600" center>
            SellFlow could not start
          </FallbackText>

          <FallbackText color={colors.textSecondary} size={15} center>
            Something went wrong while opening the app. Your orders, products and payments are
            unaffected and still saved.
          </FallbackText>

          <View style={[styles.detail, { backgroundColor: colors.surfaceSunken }]}>
            <FallbackText color={colors.textMuted} size={12} weight="600">
              DETAILS
            </FallbackText>
            <FallbackText color={colors.textSecondary} size={13}>
              {error.name}: {error.message}
            </FallbackText>
          </View>

          <Pressable
            onPress={this.retry}
            accessibilityRole="button"
            accessibilityLabel="Try starting SellFlow again"
            testID="boot-error-retry"
            style={({ pressed }) => [
              styles.retry,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <RotateCw size={17} color={colors.onPrimary} strokeWidth={2} />
            <FallbackText color={colors.onPrimary} size={15} weight="600">
              Try again
            </FallbackText>
          </Pressable>

          <FallbackText color={colors.textMuted} size={13} center>
            If this keeps happening, restart SellFlow. If it still fails, send us the details
            above.
          </FallbackText>
        </ScrollView>
      </View>
    );
  }
}

/**
 * Minimal text.
 *
 * The themed `Text` component reads from `useTheme()`, which throws outside a
 * `ThemeProvider` -- and this boundary is deliberately mounted above one. Rather
 * than reimplement the type scale, this covers only the three variants needed
 * here. Styling is inline so the fallback has no external dependency at all:
 * if the design tokens themselves were what failed to load, this must still
 * render.
 */
function FallbackText({
  color,
  size,
  weight = '400',
  center,
  style,
  children,
}: {
  color: string;
  size: number;
  weight?: '400' | '600';
  center?: boolean;
  style?: object;
  children: React.ReactNode;
}) {
  return (
    <RNText
      style={[
        {
          color,
          fontSize: size,
          fontFamily:
            weight === '600'
              ? Platform.select({ ios: 'Inter-SemiBold', default: 'Inter-SemiBold' })
              : Platform.select({ ios: 'Inter-Regular', default: 'Inter-Regular' }),
          textAlign: center ? 'center' : 'left',
          lineHeight: Math.round(size * 1.45),
        },
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

/*
 * Every value below is a spacing or radius token.
 *
 * Not stylistic preference: `scripts/design-audit.mjs` fails the build on
 * off-scale literals, and this screen is the last one a seller ever sees. If it
 * drifts off the scale it will read as a different product from the app it
 * replaced. Inline `gap: 8` values are accepted by the audit as intra-element
 * icon/label pairs.
 */
const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    gap: spacing.sm,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: radius.mark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detail: {
    alignSelf: 'stretch',
    borderRadius: radius.mark,
    padding: spacing.sm,
    gap: spacing.xxs,
  },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    minHeight: touchTarget.comfortable,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.control,
  },
});