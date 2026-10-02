/**
 * Screen header.
 *
 * One header for every pushed screen, so titles, back affordances and safe-area
 * handling behave identically throughout the app.
 */

import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';

import { Text } from '@/components/ui';
import { useTheme } from '@/theme/ThemeProvider';

export function ScreenHeader({
  title,
  subtitle,
  /** Trailing element, usually a single icon button. */
  right,
  left,
  showBack = true,
  large = false,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  left?: React.ReactNode;
  showBack?: boolean;
  large?: boolean;
}) {
  const { colors, spacing, touchTarget, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top + spacing.xs,
          paddingBottom: spacing.sm,
          paddingHorizontal: spacing.md,
          backgroundColor: colors.background,
        },
      ]}
    >
      <View style={styles.row}>
        {left ??
          (showBack ? (
            <Pressable
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/(app)'))}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              hitSlop={8}
              style={({ pressed }) => [
                styles.iconButton,
                {
                  minWidth: touchTarget.min,
                  minHeight: touchTarget.min,
                  borderRadius: radius.control,
                  opacity: pressed ? 0.6 : 1,
                },
              ]}
            >
              <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
            </Pressable>
          ) : null)}

        <View style={styles.titles}>
          <Text variant={large ? 'display' : 'title'} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {right ? <View style={styles.right}>{right}</View> : null}
      </View>
    </View>
  );
}

/** Circular icon button for header actions and list rows. */
export function IconButton({
  onPress,
  label,
  children,
  tone = 'default',
}: {
  onPress: () => void;
  /** Required: an icon alone is not an accessible label. */
  label: string;
  children: React.ReactNode;
  tone?: 'default' | 'primary' | 'danger';
}) {
  const { colors, touchTarget, radius } = useTheme();

  const toneStyle = {
    default: { backgroundColor: colors.surfaceSunken, color: colors.text },
    primary: { backgroundColor: colors.primarySoft, color: colors.primary },
    danger: { backgroundColor: colors.dangerSoft, color: colors.danger },
  }[tone];

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [
        styles.iconButton,
        {
          minWidth: touchTarget.min,
          minHeight: touchTarget.min,
          // Same step as the back chevron beside it, so the two header
          // affordances cannot drift apart.
          borderRadius: radius.control,
          backgroundColor: toneStyle.backgroundColor,
          opacity: pressed ? 0.65 : 1,
        },
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  titles: {
    flex: 1,
    gap: 2,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
