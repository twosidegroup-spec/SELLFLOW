/**
 * Search field.
 *
 * A bare `TextInput` with an icon, deliberately not a chip: it reads as one field
 * and behaves like one.
 *
 * The debounce lives in the QUERY layer, not here. A debounce inside the input
 * would mean two independent timers -- one to update the visible text, one to update
 * the request -- and the two would drift whenever a query was refetched from
 * elsewhere. One source of truth for "what is being searched" is easier to reason
 * about than two that must agree.
 */

import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Search, X } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { typography } from '@/theme/tokens';

export function SearchBar({
  value,
  onChangeText,
  placeholder = 'Search',
  autoFocus,
  onSubmit,
  testID,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  testID?: string;
}) {
  const { colors, spacing, radius, controlHeight } = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: controlHeight,
        paddingHorizontal: spacing.sm,
        gap: spacing.xs,
        backgroundColor: colors.surfaceInput,
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: colors.border,
      }}
      testID={testID}
    >
      <Search size={18} color={colors.textMuted} strokeWidth={1.75} />

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
        accessibilityLabel={placeholder}
        testID={testID ? `${testID}-input` : undefined}
        style={[
          styles.input,
          typography.body,
          { color: colors.text },
        ]}
      />

      {/*
       * The clear button only exists once there is something to clear. An always-
       * present X on an empty field is a target that does nothing.
       */}
      {value.length > 0 ? (
        <Pressable
          onPress={() => onChangeText('')}
          testID={testID ? `${testID}-clear` : undefined}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={10}
          style={{ marginRight: -6, padding: spacing.xxs }}
        >
          <X size={16} color={colors.textMuted} strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    flex: 1,
    // Web only: without it a focused field draws the browser's own focus ring on
    // top of the container border, so the field looks like it has two borders.
    outlineStyle: 'none',
  } as object,
});