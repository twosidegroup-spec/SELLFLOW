/**
 * Password reset request.
 *
 * Sends Supabase's recovery email. The response is identical whether or not the
 * address exists -- telling an anonymous caller which emails are registered
 * would leak account information.
 */

import { useState } from 'react';
import { Keyboard, View } from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, Mail } from 'lucide-react-native';

import { Button, Input, Screen, Text } from '@/components/ui';
import { AppError } from '@/lib/errors';
import { getSupabase, isConfigured } from '@/lib/supabase';
import { useTheme } from '@/theme/ThemeProvider';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordScreen() {
  const { spacing } = useTheme();

  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<AppError | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    Keyboard.dismiss();
    setFormError(null);

    if (!email.trim() || !EMAIL_PATTERN.test(email.trim())) {
      setError('Enter the email address you signed up with.');
      return;
    }

    setError(undefined);
    setSubmitting(true);

    try {
      const { error: resetError } = await getSupabase().auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        { redirectTo: 'sellflow://sign-in' },
      );

      if (resetError) throw AppError.from(resetError);
      setSent(true);
    } catch (error) {
      setFormError(AppError.from(error));
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <Screen grow>
        <View style={{ flex: 1, justifyContent: 'center', maxWidth: 440, width: '100%', alignSelf: 'center' }}>
          <Text variant="display">Check your email</Text>
          <Text variant="body" tone="muted" style={{ marginTop: spacing.xs }}>
            If an account exists for {email.trim()}, we have sent a link to reset the password. It
            expires in one hour.
          </Text>
          <Button label="Back to sign in" onPress={() => router.replace('/sign-in')} block style={{ marginTop: spacing.xl }} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen grow>
      <View style={{ flex: 1, justifyContent: 'center', maxWidth: 440, width: '100%', alignSelf: 'center' }}>
        <Text variant="display">Reset password</Text>
        <Text variant="body" tone="muted" style={{ marginTop: spacing.xs, marginBottom: spacing.xl }}>
          Enter your email and we will send you a link to choose a new password.
        </Text>

        {formError ? (
          <View style={{ marginBottom: spacing.md }}>
            <Text variant="caption" tone="danger">{formError.title}</Text>
            <Text variant="micro" tone="secondary" style={{ marginTop: 2 }}>{formError.action}</Text>
          </View>
        ) : null}

        <View style={{ gap: spacing.md }}>
          <Input
            label="Email"
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              if (error) setError(undefined);
            }}
            placeholder="you@example.com"
            icon={Mail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            error={error}
            showError
            editable={!submitting}
            returnKeyType="go"
            onSubmitEditing={() => void handleSubmit()}
          />

          <Button
            label="Send reset link"
            onPress={() => void handleSubmit()}
            loading={submitting}
            disabled={!isConfigured}
            block
            size="lg"
          />

          <Button
            label="Back to sign in"
            variant="ghost"
            icon={ArrowLeft}
            onPress={() => router.back()}
            block
          />
        </View>
      </View>
    </Screen>
  );
}
