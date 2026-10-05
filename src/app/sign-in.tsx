/**
 * Sign in.
 *
 * Real Supabase email/password authentication against the seller's own account.
 * There is no demo account, no bypass, and no local fallback -- a build without a
 * backend shows `SetupRequired` upstream of this route rather than offering a way
 * in that would not persist anything.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO
 *
 * It does not reveal whether an email exists. GoTrue answers "Invalid login
 * credentials" for both an unknown address and a wrong password, and that answer is
 * passed through unchanged: a different message for "no such account" turns the form
 * into an account-enumeration oracle.
 *
 * It does not echo the password anywhere. No console output, no error object, no
 * analytics. The only place it exists is component state and the one request body it
 * is sent in.
 *
 * IT DOES DISTINGUISH FAILURE KINDS
 *
 * A wrong password and a dead network are different problems with different
 * remedies, and telling a seller their password is wrong when their connection is
 * down sends them to reset a password that was fine. `AppError` already separates
 * them; this screen renders what it says.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, ErrorState, Input, Screen, Text } from '@/components/ui';
import { AppError } from '@/lib/errors';
import { getSupabase, isConfigured } from '@/lib/supabase';
import { useLock } from '@/store/lock';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function SignInScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const insets = useSafeAreaInsets();

  const handleSession = useSession((state) => state.handleSession);
  const setWorkspace = useSession((state) => state.setWorkspace);
  const lockNow = useLock((state) => state.lockNow);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AppError | null>(null);

  const submit = async () => {
    if (busy) return;

    setBusy(true);
    setFailure(null);

    try {
      const { data, error } = await getSupabase().auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        // Rendered through the shared mapper so GoTrue's codes become copy a seller
        // can act on, and so a raw driver message never reaches the screen.
        setFailure(AppError.from(error));
        return;
      }

      if (!data.session) {
        setFailure(
          new AppError('Sign in failed', 'Try again, or reset your password.'),
        );
        return;
      }

      /*
       * Two things, and the order matters.
       *
       * `handleSession` resolves the seller to their organization and store. If
       * that fails -- a live session whose business cannot be read -- it sets
       * `workspace-unavailable` rather than signed-out, and this screen routes back
       * to `/` so the entry route can show that state with a retry. Sending them
       * here instead would tell a seller with a working password that they signed
       * out, which is what the V1 flow did.
       */
      await handleSession(data.session);

      /*
       * A fresh sign-in must not inherit a previous session's lock. `lockNow` only
       * matters when a passcode exists; when it does, the `(app)` gate will redirect
       * to /passcode. Calling it here rather than relying on the guard is what stops
       * the app opening already unlocked on a seller who had just switched accounts
       * on a shared device.
       */
      lockNow();

      const state = useSession.getState();
      if (state.status === 'signed-out') {
        router.replace('/');
        return;
      }
      if (state.status === 'needs-onboarding') {
        router.replace('/register');
        return;
      }
      if (state.status === 'ready') {
        // Defensive: `setWorkspace` is a no-op here, but going through the store
        // keeps a single path into "authenticated" rather than a router.push that
        // could race the guard.
        setWorkspace(state.organization!, state.store!, state.stores);
        router.replace('/(app)');
        return;
      }

      router.replace('/');
    } catch (unexpected) {
      // A thrown network failure has no GoTrue code, so it is reported as a
      // connection problem rather than as bad credentials.
      setFailure(AppError.from(unexpected));
    } finally {
      setBusy(false);
    }
  };

  if (!isConfigured) {
    return <ErrorState title="SellFlow is not connected" action="This build has no database behind it." />;
  }

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  return (
    <Screen
      testID="sign-in-screen"
      width="form"
      footer={
        <Button
          label="Sign in"
          size="lg"
          fullWidth
          disabled={!canSubmit}
          loading={busy}
          onPress={() => void submit()}
          testID="sign-in-submit"
        />
      }
    >
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xs }}>
          <Text variant="title">Welcome back</Text>
          <Text variant="body" tone="secondary">
            Sign in with the email and password you registered with.
          </Text>
        </View>

        {/*
         * The failure is a block above the form rather than an inline field error:
         * "Invalid login credentials" is about the pair, not about one field, and
         * colouring one input red would blame the wrong one.
         */}
        {failure ? (
          <Card elevation="flat" style={{ borderColor: failure.title ? undefined : undefined }}>
            <View style={{ gap: spacing.xxs }}>
              <Text variant="bodyStrong" tone="danger">
                {failure.title}
              </Text>
              {failure.action ? (
                <Text variant="caption" tone="secondary">
                  {failure.action}
                </Text>
              ) : null}
            </View>
          </Card>
        ) : null}

        <Card>
          <View style={{ gap: spacing.md }}>
            <Input
              label="Email"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              placeholder="you@example.com"
              testID="sign-in-email"
            />
            <Input
              label="Password"
              secure
              value={password}
              onChangeText={setPassword}
              autoComplete="current-password"
              textContentType="password"
              placeholder="Your password"
              testID="sign-in-password"
              onSubmitEditing={() => void submit()}
              returnKeyType="go"
            />
          </View>
        </Card>

        <Button
          label="Forgot your password?"
          variant="ghost"
          onPress={() => router.push('/forgot-password')}
          testID="sign-in-forgot"
        />

        <Text variant="caption" tone="muted" center style={{ paddingBottom: insets.bottom }}>
          New to SellFlow? Create a business from the welcome screen.
        </Text>
      </View>
    </Screen>
  );
}