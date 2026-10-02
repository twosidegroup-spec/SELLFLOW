/**
 * Screen shell.
 *
 * Owns the things every screen needs to get right and that are easy to get
 * wrong individually: safe-area insets (notch, dynamic island, Android gesture
 * bar), keyboard avoidance, scroll behaviour, and background colour.
 *
 * Screens pass content rather than re-implementing any of this.
 */

import * as React from 'react';
import { useCallback } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme/ThemeProvider';

export interface ScreenProps {
  children: React.ReactNode;
  /** Wraps children in a ScrollView. Off for screens that own a FlatList. */
  scroll?: boolean;
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

  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
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
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.textMuted}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View
      style={[
        styles.flex,
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
 */
export function ListScreen({
  children,
  style,
  contentContainerStyle,
  bottomInset = 0,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  bottomInset?: number;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

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
              {
                paddingBottom: bottomInset + insets.bottom,
                ...(contentContainerStyle as object | undefined),
              },
            ],
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
