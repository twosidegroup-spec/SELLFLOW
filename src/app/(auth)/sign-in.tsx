/**
 * Sign in.
 *
 * Real Supabase email/password authentication. No demo accounts, no bypass, no
 * seeded session -- requirement 19.
 *
 * Validation runs on submit and then on change once a field has failed, which
 * gives immediate feedback without scolding the user mid-keystroke.
 */

import { useState } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import { Link, router } from 'expo-router';
import { ArrowRight, Lock, Mail } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { Button, Input, Screen, Text } from '@/components/ui';
import { AppError } from '@/lib/errors';
import { getSupabase, isConfigured } from '@/lib/supabase';
import { useTheme } from '@/theme/ThemeProvider';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignInScreen() {
  const { colors, spacing, radius } = useTheme();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<AppError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const next: { email?: string; password?: string } = {};

    if (!email.trim()) next.email = 'Enter your email address.';
    else if (!EMAIL_PATTERN.test(email.trim())) next.email = 'That does not look like an email address.';

    if (!password) next.password = 'Enter your password.';

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit() {
    Keyboard.dismiss();
    setFormError(null);

    if (!validate()) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }

    setSubmitting(true);

    try {
      const { error } = await getSupabase().auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });

      if (error) throw AppError.from(error);

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The root layout's auth listener moves the user on; no manual navigate.
    } catch (error) {
      setFormError(AppError.from(error));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen grow>
      <View style={{ flex: 1, justifyContent: 'center', maxWidth: 440, width: '100%', alignSelf: 'center' }}>
        <View style={{ marginBottom: spacing.xxl }}>
          <View
            style={[
              styles.logo,
              { backgroundColor: colors.primary, borderRadius: radius.mark, marginBottom: spacing.lg },
            ]}
          >
            <Text variant="title" style={{ color: colors.onPrimary }}>
              S
            </Text>
          </View>

          <Text variant="display">Sign in</Text>
          <Text variant="body" tone="muted" style={{ marginTop: spacing.xs }}>
            Manage your customers, orders and stock in one place.
          </Text>
        </View>

        {formError ? (
          <View
            style={[
              styles.formError,
              {
                backgroundColor: colors.dangerSoft,
                borderRadius: radius.mark,
                padding: spacing.sm,
                marginBottom: spacing.md,
              },
            ]}
          >
            <Text variant="caption" tone="danger">
              {formError.title}
            </Text>
            <Text variant="micro" tone="secondary" style={{ marginTop: 2 }}>
              {formError.action}
            </Text>
          </View>
        ) : null}

        <View style={{ gap: spacing.md }}>
          <Input
            label="Email"
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              if (errors.email) setErrors((prev) => ({ ...prev, email: undefined }));
            }}
            placeholder="you@example.com"
            icon={Mail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
            error={errors.email}
            showError
            editable={!submitting}
            returnKeyType="next"
          />

          <Input
            label="Password"
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
            }}
            placeholder="Your password"
            icon={Lock}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            error={errors.password}
            showError
            editable={!submitting}
            returnKeyType="go"
            onSubmitEditing={() => void handleSubmit()}
          />

          <Button
            label="Sign in"
            icon={ArrowRight}
            iconPosition="trailing"
            onPress={() => void handleSubmit()}
            loading={submitting}
            disabled={!isConfigured}
            block
            size="lg"
          />

          <Link href="/forgot-password" asChild>
            <Button label="Forgot your password?" variant="ghost" size="sm" block />
          </Link>
        </View>

        <View style={[styles.footer, { marginTop: spacing.xxl, paddingTop: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}>
          <Text variant="caption" tone="muted">
            New to SellFlow?{' '}
            <Text
              variant="caption"
              tone="primary"
              onPress={() => router.push('/sign-up')}
              suppressHighlighting
              accessibilityRole="link"
            >
              Create an account
            </Text>
          </Text>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  logo: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formError: {
    gap: 2,
  },
  footer: {
    alignItems: 'center',
  },
});
