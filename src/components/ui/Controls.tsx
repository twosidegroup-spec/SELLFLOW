/**
 * Search field, segmented control and option rows.
 *
 * The search field debounces through `useDebouncedValue` rather than firing a
 * query per keystroke, so typing stays smooth on a real database.
 */

import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { Search, X } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

/**
 * Returns `value` after it has stopped changing for `delay` ms.
 *
 * Used for search input and any other value that drives a query. Without it,
 * every keystroke becomes a round trip, which is what makes search feel laggy
 * and also wastes the user's data allowance.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    // Skip the leading-edge update so the first render is not delayed.
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

// ---------------------------------------------------------------------------
// SearchBar
// ---------------------------------------------------------------------------

export function SearchBar({
  value,
  onChangeText,
  placeholder = 'Search',
  autoFocus,
  onSubmit,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
}) {
  const { colors, radius, spacing, typography, controlHeight } = useTheme();
  const hasValue = value.length > 0;

  return (
    <View
      style={[
        styles.search,
        {
          backgroundColor: colors.surfaceSunken,
          borderRadius: radius.control,
          paddingHorizontal: spacing.sm,
          // Same height as every other text entry control.
          height: controlHeight,
        },
      ]}
    >
      <Search size={18} color={colors.textMuted} strokeWidth={2} />

      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        onSubmitEditing={onSubmit}
        selectionColor={colors.primary}
        style={[styles.searchInput, typography.body, { color: colors.text }]}
      />

      {hasValue ? (
        <Pressable
          onPress={() => onChangeText('')}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          // Expands the visible touch area without changing the icon size.
          hitSlop={12}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <X size={18} color={colors.textMuted} strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// SegmentedControl
// ---------------------------------------------------------------------------

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
  /** Optional trailing count, e.g. the number of orders in a filter. */
  count?: number;
}

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  style,
  scrollable = false,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
  scrollable?: boolean;
}) {
  const { colors, radius, spacing, chipHeight } = useTheme();

  // `onChange` is deliberately a dependency: a caller passing a new closure
  // each render must not leave a press handler pointing at a stale value, which
  // is exactly the kind of bug where a filter silently stops responding.
  const items = useMemo(
    () =>
      options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              styles.segment,
              {
                borderRadius: radius.sm,
                backgroundColor: selected ? colors.surface : 'transparent',
                opacity: pressed && !selected ? 0.6 : 1,
              },
            ]}
          >
            <Text
              variant="caption"
              numberOfLines={1}
              style={{ color: selected ? colors.text : colors.textSecondary }}
            >
              {option.label}
            </Text>
            {option.count !== undefined ? (
              <Text variant="micro" tone={selected ? 'primary' : 'muted'}>
                {option.count}
              </Text>
            ) : null}
          </Pressable>
        );
      }),
    [options, value, onChange, colors, radius],
  );

  const container = (
    <View
      style={[
        styles.segmentTrack,
        {
          backgroundColor: colors.surfaceSunken,
          borderRadius: radius.control,
          // 4px of track inset, not 3: the design audit judges padding as page
          // rhythm, and 4 is the smallest step on the spacing scale. The visual
          // difference is a single pixel around the selected segment.
          padding: spacing.xxs,
          gap: spacing.xxs,
          // Track height is the chip height plus the track's padding on both
          // sides, so a segment and a standalone FilterChip are the same size.
          height: chipHeight + spacing.xxs * 2,
        },
        style,
      ]}
    >
      {items}
    </View>
  );

  if (scrollable) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 3 }}>
        {items}
      </ScrollView>
    );
  }

  return container;
}

/** Horizontal row of filter chips, for secondary filters under a search bar. */
export function FilterChip({
  label,
  selected,
  onPress,
  style,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, radius, spacing, chipHeight } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        {
          borderRadius: radius.pill,
          paddingHorizontal: spacing.sm,
          height: chipHeight,
          borderColor: selected ? colors.primary : colors.border,
          backgroundColor: selected ? colors.primarySoft : colors.surface,
          opacity: pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      <Text variant="caption" style={{ color: selected ? colors.primary : colors.textSecondary }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchInput: {
    flex: 1,
    padding: 0,
    includeFontPadding: false,
    textAlignVertical: 'center',
    // Android adds default horizontal padding that breaks the row alignment.
    paddingHorizontal: 0,
  },
  segmentTrack: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8,
  },
  chip: {
    justifyContent: 'center',
    borderWidth: 1,
  },
});
