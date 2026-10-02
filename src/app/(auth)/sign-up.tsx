/**
 * Create account.
 *
 * Collects only what is needed to start: email, password, and a name. The
 * business name is asked for in onboarding, immediately afterwards, so the user
 * is never asked for information before they can see the app -- requirement 42.
 */

import { useState } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import { Link, router } from 'expo-router';
import { ArrowRight, Lock, Mail, User } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { Button, Input, Screen, Text } from '@/components/ui';
import { AppError } from '@/lib/errors';
import { getSupabase, isConfigured } from '@/lib/supabase';
import { useTheme } from '@/theme/ThemeProvider';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export default function SignUpScreen() {
  const { colors, spacing, radius } = useTheme();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const [formError, setFormError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const next: typeof errors = {};

    if (!name.trim()) next.name = 'Enter your name.';
    if (!email.trim()) next.email = 'Enter your email address.';
    else if (!EMAIL_PATTERN.test(email.trim())) next.email = 'That does not look like an email address.';

    if (!password) next.password = 'Choose a password.';
    else if (password.length < MIN_PASSWORD) {
      next.password = `Use at least ${MIN_PASSWORD} characters.`;
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit() {
    Keyboard.dismiss();
    setFormError(null);
    setNotice(null);

    if (!validate()) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }

    setSubmitting(true);

    try {
      const { data, error } = await getSupabase().auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        // Carried into the `handle_new_user` trigger so the profile is
        // populated without a second round trip.
        options: { data: { full_name: name.trim() } },
      });

      if (error) throw AppError.from(error);

      if (data.session) {
        /*
         * Signed straight in. No navigation here on purpose: the root layout's
         * `onAuthStateChange` has already fired, and it is what decides between
         * /onboarding and /(app) from real workspace state. Navigating here too
         * would race that decision.
         */
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return;
      }

      /*
       * Only reachable while email confirmation is still enabled on the
       * Supabase project. It is switched off in production, so this branch
       * exists as a truthful explanation rather than as the normal path.
       */
      setNotice('Your project still requires email confirmation. Check your inbox, then sign in.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => router.replace('/sign-in'), 2600);
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
          <Text variant="display">Create account</Text>
          <Text variant="body" tone="muted" style={{ marginTop: spacing.xs }}>
            Start running your business from your phone.
          </Text>
        </View>

        {formError ? (
          <View style={[styles.formError, { backgroundColor: colors.dangerSoft, borderRadius: radius.mark, padding: spacing.sm, marginBottom: spacing.md }]}>
            <Text variant="caption" tone="danger">{formError.title}</Text>
            <Text variant="micro" tone="secondary" style={{ marginTop: 2 }}>{formError.action}</Text>
          </View>
        ) : null}

        {notice ? (
          <View style={[styles.formError, { backgroundColor: colors.successSoft, borderRadius: radius.mark, padding: spacing.sm, marginBottom: spacing.md }]}>
            <Text variant="caption" tone="success">{notice}</Text>
          </View>
        ) : null}

        <View style={{ gap: spacing.md }}>
          <Input
            label="Your name"
            value={name}
            onChangeText={(text) => {
              setName(text);
              if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
            }}
            placeholder="Rahim Uddin"
            icon={User}
            autoComplete="name"
            textContentType="name"
            error={errors.name}
            showError
            editable={!submitting}
            returnKeyType="next"
          />

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
            placeholder={`At least ${MIN_PASSWORD} characters`}
            icon={Lock}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            error={errors.password}
            showError
            editable={!submitting}
            returnKeyType="go"
            onSubmitEditing={() => void handleSubmit()}
          />

          <Button
            label="Create account"
            icon={ArrowRight}
            iconPosition="trailing"
            onPress={() => void handleSubmit()}
            loading={submitting}
            disabled={!isConfigured}
            block
            size="lg"
          />
        </View>

        <View style={[styles.footer, { marginTop: spacing.xxl, paddingTop: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}>
          <Text variant="caption" tone="muted">
            Already have an account?{' '}
            <Link href="/sign-in" asChild>
              <Text variant="caption" tone="primary" suppressHighlighting>
                Sign in
              </Text>
            </Link>
          </Text>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  formError: { gap: 2 },
  footer: { alignItems: 'center' },
});
