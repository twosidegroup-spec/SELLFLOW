/**
 * Screen shell.
 *
 * Owns the things every screen needs to get right and that are easy to get wrong
 * individually: safe-area insets (notch, dynamic island, Android gesture bar),
 * keyboard avoidance, scroll behaviour, and background colour.
 *
 * Screens pass content rather than re-implementing any of this.
 */

import * as React from 'react';
import { useCallback } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SellflowRefreshControl } from './Refresh';
import { useTheme } from '@/theme/ThemeProvider';

export interface ScreenProps {
  children: React.ReactNode;
  /**
   * Wraps children in a ScrollView. Off for screens that own a FlatList.
   *
   * A `scroll={false}` screen cannot be refreshed by `Screen`, because
   * `RefreshControl` belongs to the scrollable and `Screen` does not own it. Use
   * `ListScreen`, which injects a themed one into the list.
   */
  scroll?: boolean;
  /**
   * Pull-to-refresh. Only meaningful with `scroll`.
   *
   * Pass the pair from `useRefresh` rather than a query flag: a `refreshing` value
   * that is not tied to the request is what makes an indicator feel broken,
   * either because it never appears or because it appears unprompted.
   */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Extra bottom padding, e.g. to clear a floating action button. */
  bottomInset?: number;
  /** Adds the standard horizontal screen padding. */
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  /** Sticks content to the bottom of the viewport instead of top-aligned. */
  grow?: boolean;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
}

/**
 * Widest a screen's content is allowed to get on web.
 *
 * Every screen inherits this, which is the point. Laying it out per screen meant
 * thirty-odd chances to forget, and the ones that did forget were the reason the
 * dashboard read as a stretched phone app: a single card or a single-column form
 * spanning 1900px of monitor. Centred and capped, the same components sit where a
 * website puts them.
 *
 * `alignSelf` is required alongside `maxWidth`, or the capped box hugs the left edge
 * instead of centring. Native is untouched -- a phone is never wider than this.
 */
const WEB_CONTENT_MAX_WIDTH = 1280;

function webMeasure(): ViewStyle | null {
  if (Platform.OS !== 'web') return null;
  return { width: '100%', maxWidth: WEB_CONTENT_MAX_WIDTH, alignSelf: 'center' };
}

export function Screen({
  children,
  scroll = true,
  onRefresh,
  refreshing = false,
  bottomInset = 0,
  padded = true,
  style,
  contentStyle,
  grow = false,
  keyboardShouldPersistTaps = 'handled',
}: ScreenProps) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  const handleContentSizeChange = useCallback(() => {
    // No-op hook point: ScrollView auto-adjusts. Kept out of the render path.
  }, []);

  /*
   * The Products tab used to pass `onRefresh` to a `scroll={false}` screen and
   * have it silently discarded, because the refresh props were only ever read in
   * the ScrollView branch -- so that tab had no pull-to-refresh at all, with no
   * type error and no warning. Warn rather than fail silently.
   */
  if (__DEV__ && !scroll && onRefresh) {
    console.warn(
      '[Screen] onRefresh has no effect when scroll={false}. Use ListScreen, or pass the ' +
        'refreshControl to your own scrollable.',
    );
  }

  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        webMeasure(),
        {
          paddingHorizontal: padded ? spacing.lg : 0,
          paddingBottom: bottomInset + insets.bottom + spacing.xl,
          // `grow` lets a short page centre its content instead of hugging the
          // top, which is what an empty state wants.
          flexGrow: grow ? 1 : 0,
        },
        contentStyle,
      ]}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      showsVerticalScrollIndicator={false}
      onContentSizeChange={handleContentSizeChange}
      refreshControl={
        onRefresh ? <SellflowRefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View
      style={[
        styles.flex,
        webMeasure(),
        {
          paddingHorizontal: padded ? spacing.lg : 0,
          paddingBottom: bottomInset + insets.bottom,
        },
        contentStyle,
      ]}
    >
      {children}
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.background }, style]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      // The iOS keyboard overlaps the bottom of the screen; without this the
      // submit button on a form ends up underneath it.
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      {body}
    </KeyboardAvoidingView>
  );
}

/**
 * A screen whose body is a virtualised list.
 *
 * Split out from `Screen` because a FlatList must be the direct child of the
 * scroll container -- nesting one inside another breaks recycling and is the
 * most common cause of a list that feels sluggish.
 *
 * Takes the refresh handler and injects a themed `RefreshControl` into the list,
 * so a list screen cannot end up with the platform default indicator or with a
 * `refreshing` flag that is not tied to the request.
 */
export function ListScreen({
  children,
  style,
  contentContainerStyle,
  bottomInset = 0,
  onRefresh,
  refreshing = false,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  bottomInset?: number;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const refreshControl = onRefresh ? (
    <SellflowRefreshControl refreshing={refreshing} onRefresh={onRefresh} />
  ) : undefined;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.background }, style]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {React.isValidElement(children)
        ? // Clone to inject the safe-area padding without wrapping the list,
          // which would nest scrollables.
          React.cloneElement(children as React.ReactElement<any>, {
            contentContainerStyle: [
              webMeasure(),
              {
                paddingBottom: bottomInset + insets.bottom,
                ...(contentContainerStyle as object | undefined),
              },
            ],
            refreshControl,
          })
        : children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
});
