/**
 * Text input primitives.
 *
 * `Input` is the only way a seller types into the app. It owns the parts that are
 * easy to get subtly wrong on every screen: label association, an error that is
 * announced rather than only coloured, a helper line, and a text field that never
 * sits below the keyboard.
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
import { Eye, EyeOff, TriangleAlert } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export interface FieldProps {
  label: string;
  /** Shown when `error` is set, and announced to a screen reader. */
  error?: string | null;
  /** Persistent hint. Replaced by the error when there is one. */
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Field({ label, error, hint, required, children, style, testID }: FieldProps) {
  const { colors, spacing } = useTheme();

  return (
    <View style={[{ gap: spacing.xxs }, style]} testID={testID}>
      <Text variant="caption" tone="secondary">
        {label}
        {required ? (
          <Text variant="caption" tone="danger">
            {' *'}
          </Text>
        ) : null}
      </Text>

      {children}

      {/*
       * The error lives here, in the accessibility tree, rather than being
       * signalled only by a red border. A border is invisible to a screen reader,
       * so a colour-only error is an error a blind seller never learns about.
       */}
      {error ? (
        <View style={styles.inlineRow} accessibilityLiveRegion="polite">
          <TriangleAlert size={13} color={colors.danger} strokeWidth={2} />
          <Text variant="caption" tone="danger" style={styles.flex}>
            {error}
          </Text>
        </View>
      ) : hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export interface InputProps extends Omit<TextInputProps, 'style'> {
  label: string;
  error?: string | null;
  hint?: string;
  required?: boolean;
  /** Renders a reveal toggle and masks the value. */
  secure?: boolean;
  prefix?: string;
  containerStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  { label, error, hint, required, secure, prefix, containerStyle, testID, ...rest },
  ref,
) {
  const { colors, radius, spacing, controlHeight, typography } = useTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const borderColor = error
    ? colors.danger
    : focused
      ? colors.focus
      : colors.border;

  return (
    <Field label={label} error={error} hint={hint} required={required} style={containerStyle} testID={testID}>
      <View
        style={[
          styles.inputShell,
          {
            minHeight: controlHeight,
            borderRadius: radius.control,
            backgroundColor: colors.surfaceInput,
            borderColor,
            // Two pixels while focused, one at rest. Thicker than a hairline so the
            // focus ring is visible on a cheap panel without changing the size.
            borderWidth: focused ? 2 : 1,
            paddingHorizontal: spacing.sm,
          },
        ]}
      >
        {prefix ? (
          <Text variant="body" tone="muted" style={{ marginRight: spacing.xxs }}>
            {prefix}
          </Text>
        ) : null}

        <TextInput
          ref={ref}
          style={[
            styles.input,
            typography.body,
            { color: colors.text, paddingVertical: spacing.xs },
          ]}
          placeholderTextColor={colors.textMuted}
          onFocus={(event) => {
            setFocused(true);
            rest.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            rest.onBlur?.(event);
          }}
          secureTextEntry={secure && !revealed}
          accessibilityLabel={label}
          accessibilityHint={hint}
          testID={testID ? `${testID}-input` : undefined}
          {...rest}
        />

        {secure ? (
          <Pressable
            onPress={() => setRevealed((value) => !value)}
            // A 44px target even though the icon is 18px.
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            testID={testID ? `${testID}-reveal` : undefined}
          >
            {revealed ? (
              <EyeOff size={18} color={colors.textMuted} strokeWidth={1.75} />
            ) : (
              <Eye size={18} color={colors.textMuted} strokeWidth={1.75} />
            )}
          </Pressable>
        ) : null}
      </View>
    </Field>
  );
});

/** Multi-line variant. Same shell, taller, with a sensible row count. */
export const TextArea = forwardRef<TextInput, Omit<InputProps, 'multiline' | 'numberOfLines'>>(
  function TextArea({ containerStyle, ...rest }, ref) {
    const { spacing } = useTheme();
    return (
      <Input
        ref={ref}
        multiline
        numberOfLines={4}
        textAlignVertical="top"
        containerStyle={[{ minHeight: spacing.xxxl * 2 }, containerStyle]}
        {...rest}
      />
    );
  },
);

const styles = StyleSheet.create({
  inputShell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    // Web only. Without it a focused input shows a default focus ring on top of
    // the border token, which is the browser's chrome, not ours.
    ...(({ outlineStyle: 'none' } as unknown) as object),
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  flex: {
    flex: 1,
  },
});