/**
 * Card and layout containers.
 *
 * A card is a surface with a hairline, not a floating shadow. That is what lets
 * one elevation scale serve both themes: on light mode the border reads, and on
 * dark mode the shadow stays subtle enough not to turn grey surfaces muddy.
 */

import { forwardRef } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface CardProps {
  children: React.ReactNode;
  /** `flat` for a well, `raised` for a floating surface, `overlay` for a sheet. */
  elevation?: keyof ReturnType<typeof useTheme>['elevation'];
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Card({ children, elevation = 'raised', padded = true, style, testID }: CardProps) {
  const { colors, radius, spacing, elevation: scale } = useTheme();

  return (
<View
      testID={testID}
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radius.card,
          borderColor: colors.border,
          // Spread straight through: every level has the same shape (see
          // ElevationLevel in tokens.ts), so no cast and no narrowing is needed.
          ...scale[elevation],
        },
        padded && { padding: spacing.md },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A section heading with an optional action on the right. */
export function SectionHeader({
  title,
  action,
  onActionPress,
  style,
}: {
  title: string;
  action?: string;
  onActionPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { spacing } = useTheme();

  return (
    <View style={[styles.sectionHeader, { marginBottom: spacing.sm }, style]}>
      <Text variant="micro" tone="muted" style={{ textTransform: 'uppercase' }}>
        {title}
      </Text>
      {action && onActionPress ? (
        <Text
          variant="caption"
          tone="primary"
          onPress={onActionPress}
          accessibilityRole="button"
          suppressHighlighting
        >
          {action}
        </Text>
      ) : null}
    </View>
  );
}

/** A hairline rule. Uses `borderSubtle` so it recedes on both themes. */
export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={[{ height: 1, backgroundColor: colors.borderSubtle, marginVertical: spacing.sm }, style]}
    />
  );
}

/** A label/value pair, for detail screens. */
export function DetailRow({
  label,
  value,
  tone = 'default',
  numeric,
  multiline,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'secondary' | 'muted' | 'accent' | 'danger' | 'success';
  numeric?: boolean;
  multiline?: boolean;
}) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.detailRow, { paddingVertical: spacing.xs }]}>
      <Text variant="body" tone="secondary" style={styles.detailLabel}>
        {label}
      </Text>
      <Text
        variant={numeric ? 'numeric' : 'bodyStrong'}
        tone={tone}
        style={styles.detailValue}
        numberOfLines={multiline ? undefined : 2}
      >
        {value}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/**
 * The page shell every screen uses.
 *
 * Owns three things a screen should never re-implement:
 *
 *   * safe areas. `edges` decides which insets are applied; a screen with a fixed
 *     header and a scrolling body wants `['top']`, a full-bleed one wants `[]`.
 *   * the keyboard. `KeyboardAvoidingView` plus `keyboardShouldPersistTaps` is
 *     what lets a seller tap the next field in a form without the first tap only
 *     dismissing the keyboard.
 *   * a readable column. Forms stop at 520px and prose at 640px, because a form
 *     stretched across a desktop monitor is unreadable regardless of font size.
 *
 * Scrolling lives here rather than in each screen so that no screen can forget it
 * and produce content taller than the viewport with no way to reach the bottom.
 */

export type ScreenEdge = 'top' | 'bottom';

export interface ScreenProps extends Omit<ScrollViewProps, 'style'> {
  children: React.ReactNode;
  /** Rendered above the content, outside the scroll area. */
  header?: React.ReactNode;
  /** Rendered below the content, outside the scroll area. */
  footer?: React.ReactNode;
  edges?: ScreenEdge[];
  /** Caps the content column. `form` for inputs, `prose` for reading, `none` to fill. */
  width?: 'form' | 'prose' | 'none';
  /** Pinned to the bottom of the viewport, e.g. a primary action. */
  stickyFooter?: boolean;
  padded?: boolean;
  testID?: string;
}

export const Screen = forwardRef<ScrollView, ScreenProps>(function Screen(
  {
    children,
    header,
    footer,
    edges = ['top', 'bottom'],
    width = 'none',
    stickyFooter = false,
    padded = true,
    contentContainerStyle,
    testID,
    ...rest
  },
  ref,
) {
  const { colors, spacing, layout, screenPadding } = useTheme();
  const insets = useSafeAreaInsets();

  const paddingTop = edges.includes('top') ? insets.top : 0;
  const paddingBottom = edges.includes('bottom') ? insets.bottom : 0;

  const maxWidth =
    width === 'form' ? layout.maxFormWidth : width === 'prose' ? layout.maxProseWidth : undefined;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]} testID={testID}>
      {header ? (
        <View style={[styles.header, { paddingTop: paddingTop + spacing.xs }]}>{header}</View>
      ) : (
        paddingTop > 0 ? <View style={{ height: paddingTop, backgroundColor: colors.background }} /> : null
      )}

      <ScrollView
        ref={ref}
        style={styles.flex}
        // The first tap on a field must land on the field, not dismiss the keyboard.
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={isWeb() ? 'none' : 'on-drag'}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          {
            paddingHorizontal: padded ? screenPadding : 0,
            paddingTop: header ? spacing.md : spacing.lg,
            paddingBottom: (stickyFooter ? spacing.lg : spacing.xxl) + paddingBottom,
          },
          maxWidth
            ? { width: '100%', maxWidth, alignSelf: 'center' }
            : null,
          contentContainerStyle,
        ]}
        {...rest}
      >
        {children}
      </ScrollView>

      {footer ? (
        <View
          style={[
            styles.footer,
            {
              paddingBottom: paddingBottom + spacing.md,
              backgroundColor: colors.background,
              borderTopColor: colors.border,
              // A hairline only when the footer actually sits above content; a
              // divider on a screen with nothing behind it looks like a mistake.
              borderTopWidth: stickyFooter ? 1 : 0,
            },
          ]}
        >
          {footer}
        </View>
      ) : null}
    </View>
  );
});

/** Split out so `Platform` is only imported for one conditional. */
function isWeb(): boolean {
  return Platform.OS === 'web';
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 4,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  detailLabel: {
    flexShrink: 0,
  },
  detailValue: {
    flex: 1,
    textAlign: 'right',
  },
});