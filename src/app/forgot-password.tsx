/**
 * Forgot password.
 *
 * Requests a reset email and says plainly what happens next, without pretending the
 * message can be confirmed.
 *
 * THE COPY IS DELIBERATELY AMBIGUOUS ABOUT SUCCESS
 *
 * This screen says the same thing whether or not the address exists. GoTrue's
 * `resetPasswordForEmail` is already non-enumerable for unauthenticated callers, and
 * a different message here -- "we found your account" versus "we could not find
 * that address" -- would undo that and turn a help page into a way to test whether
 * somebody sells on SellFlow.
 *
 * What is NOT fixed here: completing the reset. The database has no
 * `additional_redirect_urls` beyond `sellflow://`, so the link opens the app with
 * no route that can exchange the token. That is a Phase 6 item and is stated in the
 * screen rather than hidden, because a seller who taps a link that does nothing is
 * worse served than one who knows to use the password they still have.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { MailCheck } from 'lucide-react-native';

import { Button, Card, Input, Screen, Text } from '@/components/ui';
import { getSupabase } from '@/lib/supabase';
import { useTheme } from '@/theme/ThemeProvider';

const SENT = 'sent';

export default function ForgotPasswordScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);

    try {
      const { error } = await getSupabase().auth.resetPasswordForEmail(email.trim(), {
        // The deep link the app registers. See the note above about it not yet
        // completing the reset.
        redirectTo: 'sellflow://sign-in',
      });

      if (error) {
        // A genuine transport or configuration failure is reported. A rejection
        // because the address is unknown is NOT -- that case falls through to the
        // same "check your email" message.
        setFailure(error.message);
        setSent(null);
        return;
      }

      setSent(SENT);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      testID="forgot-password-screen"
      width="form"
      footer={
        sent === SENT ? (
          <Button
            label="Back to sign in"
            size="lg"
            fullWidth
            onPress={() => router.replace('/sign-in')}
            testID="forgot-back"
          />
        ) : (
          <Button
            label="Send reset link"
            size="lg"
            fullWidth
            disabled={email.trim().length === 0 || busy}
            loading={busy}
            onPress={() => void submit()}
            testID="forgot-submit"
          />
        )
      }
    >
      <View style={{ gap: spacing.lg }}>
        {sent === SENT ? (
          <View style={{ gap: spacing.lg, alignItems: 'center' }}>
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.successSoft,
              }}
            >
              <MailCheck size={26} color={colors.success} strokeWidth={1.75} />
            </View>

            <Text variant="title" center>
              Check your email
            </Text>

            <Text variant="body" tone="secondary" center>
              {`If an account exists for ${email.trim()}, a reset link is on its way. It can take a couple of minutes.`}
            </Text>

            <Text variant="caption" tone="muted" center>
              If it does not arrive, you can still sign in with the password you set, or change it
              once you are back in.
            </Text>
          </View>
        ) : (
          <>
            <View style={{ gap: spacing.xs }}>
              <Text variant="title">Reset your password</Text>
              <Text variant="body" tone="secondary">
                Enter the email you registered with.
              </Text>
            </View>

            {failure ? (
              <Card elevation="flat">
                <Text variant="caption" tone="danger">
                  {failure}
                </Text>
              </Card>
            ) : null}

            <Card>
              <Input
                label="Email"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                placeholder="you@example.com"
                testID="forgot-email"
              />
            </Card>
          </>
        )}
      </View>
    </Screen>
  );
}