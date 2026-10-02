/**
 * Form field.
 *
 * Wraps `TextInput` with a label, inline error and supporting text. Errors
 * appear only after the field has been touched or the form submitted, so
 * validation helps while typing instead of scolding the user on the first
 * keystroke.
 *
 * Also exports `Field` for label/description/error layout around custom
 * controls (segmented controls, switches, steppers).
 */

import { forwardRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export interface FieldProps {
  label?: string;
  /** Supportive copy shown under the control. */
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Field({ label, hint, error, required, children, style }: FieldProps) {
  const { spacing } = useTheme();

  return (
    <View style={[{ gap: spacing.xs }, style]}>
      {label ? (
        <Text variant="caption" tone="secondary">
          {label}
          {required ? <Text tone="danger">{`  *`}</Text> : null}
        </Text>
      ) : null}

      {children}

      {error ? (
        <Text variant="micro" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="micro" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export interface InputProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  icon?: LucideIcon;
  /** Rendered at the trailing edge, e.g. a "Clear" or unit affordance. */
  trailing?: React.ReactNode;
  /**
   * A money field: decimal keypad, and the value sits against the trailing unit.
   *
   * Left-aligned, deliberately. Right-aligned money entry is a desktop
   * convention; on a handset it strands a one-character value like "0" against
   * the far edge, three hundred pixels from its own label, and an empty-looking
   * box is easy to miss. Left alignment keeps the number where the label is and
   * the unit where the eye finishes.
   */
  numeric?: boolean;
  /**
   * Minimum height of the control itself, for a field that must be taller than
   * one line before it has any content. Distinct from `containerStyle`, which
   * styles the whole field including its label.
   */
  minHeight?: number;
  containerStyle?: StyleProp<ViewStyle>;
  /** Forces the error to display even before the field is touched. */
  showError?: boolean;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    label,
    hint,
    error,
    required,
    icon: Icon,
    trailing,
    numeric = false,
    minHeight,
    containerStyle,
    showError,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const { colors, radius, spacing, typography, controlHeight } = useTheme();
  const [focused, setFocused] = useState(false);

  const hasError = Boolean(error) && (showError === true || focused || rest.value !== undefined);

  const borderColor = hasError
    ? colors.danger
    : focused
      ? colors.primary
      : colors.border;

  return (
    <Field label={label} hint={hint} error={hasError ? error : undefined} required={required} style={containerStyle}>
      <View
        style={[
          styles.inputRow,
          {
            backgroundColor: colors.surface,
            borderColor,
            borderRadius: radius.control,
            // A 2px ring on focus rather than a border-width change, so the
            // field does not resize as it gains focus.
            borderWidth: focused || hasError ? 2 : 1,
            paddingHorizontal: spacing.sm,
            gap: spacing.xs,
            // An explicit height for a single-line field, not a minimum. The body
            // line box is 21px and the padding below is 12px a side; letting the
            // content decide left `SelectField` one pixel taller than `Input`,
            // which is visible when the two sit in the same form.
            //
            // A multiline field must grow instead: a fixed height clipped the
            // text to the first line and let it overlap its own label.
            ...(rest.multiline
              ? { minHeight: minHeight ?? controlHeight }
              : { height: controlHeight }),
            // A multiline control must FILL this box, not sit centred inside it.
            // `styles.inputRow` centres its children so a single-line field's
            // text and icon share a baseline; left at `center`, a textarea sized
            // by min-height would collapse to its own content height and the box
            // would be a tall frame around an 87px sliver of text.
            alignItems: rest.multiline ? ('stretch' as const) : ('center' as const),
          },
        ]}
      >
        {Icon ? (
          <Icon size={18} color={focused ? colors.primary : colors.textMuted} strokeWidth={2} />
        ) : null}

        <TextInput
          ref={ref}
          accessibilityLabel={label}
          placeholderTextColor={colors.textMuted}
          keyboardType={numeric ? 'decimal-pad' : undefined}
          selectionColor={colors.primary}
          cursorColor={colors.primary}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={[
            styles.input,
            typography.body,
            {
              color: colors.text,
              paddingVertical: spacing.sm,
              // Tabular figures so a price does not jitter horizontally as the
              // seller types, without moving the value away from its label.
              fontVariant: numeric ? ['tabular-nums'] : undefined,
            },
          ]}
          {...rest}
        />

        {trailing}
      </View>
    </Field>
  );
});

/**
 * Multi-line variant.
 *
 * `minHeight` sizes the CONTROL, not the surrounding field: three body lines
 * plus the vertical padding, so the box is tall enough to show its own
 * placeholder before a single character is typed. The previous value was passed
 * as `containerStyle`, which styles the label-and-control wrapper and therefore
 * did nothing to the control.
 *
 * The caller's `minHeight` must be destructured here and passed explicitly.
 * `Input` pulls `minHeight` out of its own props into a local, so anything left
 * in `rest` no longer contains it -- meaning a hardcoded `minHeight` here used
 * to win no matter what the caller asked for, and every multiline field in the
 * app was stuck at 88px.
 */
export const TextArea = forwardRef<TextInput, InputProps>(function TextArea(
  { containerStyle, minHeight, ...rest },
  ref,
) {
  return (
    <Input
      ref={ref}
      multiline
      numberOfLines={3}
      textAlignVertical="top"
      minHeight={minHeight ?? 88}
      containerStyle={containerStyle}
      {...rest}
    />
  );
});

/** Read-only field that looks tappable and opens a picker. */
export function SelectField({
  label,
  value,
  placeholder,
  onPress,
  icon: Icon,
  hint,
  error,
  showError,
}: {
  label?: string;
  value?: string;
  placeholder?: string;
  onPress: () => void;
  icon?: LucideIcon;
  hint?: string;
  error?: string;
  showError?: boolean;
}) {
  const { colors, radius, spacing, typography, controlHeight } = useTheme();

  return (
    <Field label={label} hint={hint} error={showError ? error : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label ?? placeholder}
        onPress={onPress}
        style={({ pressed }) => [
          styles.inputRow,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderRadius: radius.control,
            borderWidth: 1,
            paddingHorizontal: spacing.sm,
            // Same height as `Input`, so the two are interchangeable on a form.
            height: controlHeight,
            gap: spacing.xs,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        {Icon ? <Icon size={18} color={colors.textMuted} strokeWidth={2} /> : null}
        <Text
          style={[
            styles.input,
            typography.body,
            { color: value ? colors.text : colors.textMuted, paddingVertical: spacing.sm, flex: 1 },
          ]}
          numberOfLines={1}
        >
          {value ?? placeholder ?? 'Select'}
        </Text>
      </Pressable>
    </Field>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    // Removes the default vertical padding on Android that breaks alignment
    // with the leading icon.
    includeFontPadding: false,
    textAlignVertical: 'center',
    padding: 0,
  },
});
