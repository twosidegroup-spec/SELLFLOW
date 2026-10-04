/**
 * Account settings.
 *
 * Profile, passcode, password change, and sign out.
 *
 * The passcode section was missing entirely until now, which left the lock with no
 * exit: the only way it had ever been removed was five wrong guesses, which
 * deletes the record and locks the seller out until they sign in again. Setting,
 * changing and removing it all belong here, next to the account password it is
 * easy to confuse it with.
 */

import { useEffect, useState } from 'react';
import { Keyboard, View } from 'react-native';
import { router } from 'expo-router';
import { KeyRound, LogOut, Save, ShieldCheck, User } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { ScreenHeader } from '@/components/ScreenHeader';
import { Button, Card, Input, Screen, SectionHeader, Text, confirm, confirmDestructive } from '@/components/ui';
import { AppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';
import { useLock } from '@/store/lock';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

const MIN_PASSWORD = 8;

export default function AccountSettingsScreen() {
  const { colors, spacing } = useTheme();
  const user = useSession((state) => state.user);
  const signOut = useSession((state) => state.signOut);
  const refreshWorkspace = useSession((state) => state.refreshWorkspace);

  const hasPasscode = useLock((state) => state.hasPasscode);
  const passcodeLength = useLock((state) => state.length);
  const clearPasscode = useLock((state) => state.clearPasscode);

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [touched, setTouched] = useState(false);

  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [profileError, setProfileError] = useState<AppError | null>(null);
  const [passwordError, setPasswordError] = useState<AppError | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (!user) return;
      const { data } = await getSupabase()
        .from('profiles')
        .select('full_name, phone')
        .eq('id', user.id)
        .single();

      if (data && !touched) {
        setFullName(data.full_name ?? '');
        setPhone(data.phone ?? '');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const nameError = touched && !fullName.trim() ? 'Enter your name.' : undefined;

  const passwordErrors = {
    current: touched && !currentPassword ? 'Enter your current password.' : undefined,
    next:
      touched && newPassword.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : undefined,
    confirm:
      touched && confirmPassword !== newPassword ? 'The two passwords do not match.' : undefined,
  };

  const canSavePassword =
    currentPassword.length > 0 &&
    newPassword.length >= MIN_PASSWORD &&
    confirmPassword === newPassword;

  async function saveProfile() {
    Keyboard.dismiss();
    setTouched(true);
    setProfileError(null);

    if (!fullName.trim() || !user) return;

    setSavingProfile(true);
    try {
      const { error } = await getSupabase()
        .from('profiles')
        .update({ full_name: fullName.trim(), phone: phone.trim() || null })
        .eq('id', user.id);

      if (error) throw AppError.from(error);

      await refreshWorkspace();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setProfileError(AppError.from(error));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword() {
    Keyboard.dismiss();
    setTouched(true);
    setPasswordError(null);
    setPasswordNotice(null);

    if (!canSavePassword || !user) return;

    setSavingPassword(true);
    try {
      // Supabase requires the current password to prove the account is really
      // in the holder's hands before the credential changes.
      const { error: reauthError } = await getSupabase().auth.signInWithPassword({
        email: user.email ?? '',
        password: currentPassword,
      });

      if (reauthError) throw AppError.from(reauthError);

      const { error } = await getSupabase().auth.updateUser({ password: newPassword });
      if (error) throw AppError.from(error);

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTouched(false);
      setPasswordNotice('Password updated.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setPasswordError(AppError.from(error));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Account" />

      <Screen>
        <View style={{ gap: spacing.xl, paddingTop: spacing.sm }}>
          <View>
            <SectionHeader title="Profile" />
            <Card>
              <View style={{ gap: spacing.md }}>
                <Input
                  label="Email"
                  value={user?.email ?? ''}
                  editable={false}
                  hint="Your sign-in address cannot be changed here."
                />
                <Input
                  label="Name"
                  required
                  value={fullName}
                  onChangeText={(text) => {
                    setTouched(true);
                    setFullName(text);
                  }}
                  icon={User}
                  error={nameError}
                  autoCapitalize="words"
                />
                <Input
                  label="Phone"
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="Optional"
                  keyboardType="phone-pad"
                />
              </View>

              {profileError ? (
                <View style={{ marginTop: spacing.sm }}>
                  <Text variant="micro" tone="danger">
                    {profileError.title}. {profileError.action}
                  </Text>
                </View>
              ) : null}

              <Button
                label="Save profile"
                icon={Save}
                onPress={() => void saveProfile()}
                loading={savingProfile}
                block
                style={{ marginTop: spacing.md }}
              />
            </Card>
          </View>

          <View>
            <SectionHeader title="Password" />
            <Card>
              <View style={{ gap: spacing.md }}>
                <Input
                  label="Current password"
                  secureTextEntry
                  value={currentPassword}
                  onChangeText={(text) => {
                    setTouched(true);
                    setCurrentPassword(text);
                  }}
                  error={passwordErrors.current}
                  autoCapitalize="none"
                />
                <Input
                  label="New password"
                  secureTextEntry
                  value={newPassword}
                  onChangeText={(text) => {
                    setTouched(true);
                    setNewPassword(text);
                  }}
                  error={passwordErrors.next}
                  hint={`At least ${MIN_PASSWORD} characters`}
                  autoCapitalize="none"
                />
                <Input
                  label="Confirm new password"
                  secureTextEntry
                  value={confirmPassword}
                  onChangeText={(text) => {
                    setTouched(true);
                    setConfirmPassword(text);
                  }}
                  error={passwordErrors.confirm}
                  autoCapitalize="none"
                />
              </View>

              {passwordError ? (
                <View style={{ marginTop: spacing.sm }}>
                  <Text variant="micro" tone="danger">
                    {passwordError.title}. {passwordError.action}
                  </Text>
                </View>
              ) : null}

              {passwordNotice ? (
                <View style={{ marginTop: spacing.sm }}>
                  <Text variant="micro" tone="success">{passwordNotice}</Text>
                </View>
              ) : null}

              <Button
                label="Change password"
                icon={KeyRound}
                onPress={() => void changePassword()}
                loading={savingPassword}
                disabled={!canSavePassword}
                block
                style={{ marginTop: spacing.md }}
              />
            </Card>
          </View>

          <View>
            <SectionHeader title="Passcode" />
            <Card>
              <View style={{ gap: spacing.xs, marginBottom: spacing.md }}>
                <Text variant="caption">
                  {hasPasscode
                    ? `Your passcode is ${passcodeLength ? `${passcodeLength} digits` : 'set'} on this phone.`
                    : 'No passcode is set on this phone.'}
                </Text>
                <Text variant="micro" tone="muted">
                  {hasPasscode
                    ? 'It unlocks SellFlow when you open the app. It is stored only in this phone’s secure keystore and is not sent to SellFlow, so it cannot be recovered or moved to another phone.'
                    : 'A passcode stops anyone with your phone from seeing your orders, customers and takings. It is separate from your account password.'}
                </Text>
              </View>

              <View style={{ gap: spacing.sm }}>
                <Button
                  label={hasPasscode ? 'Change passcode' : 'Set a passcode'}
                  icon={ShieldCheck}
                  onPress={() => router.push('/set-passcode')}
                  block
                />

                {hasPasscode ? (
                  <Button
                    label="Remove passcode"
                    variant="ghost"
                    onPress={async () => {
                      const confirmed = await confirmDestructive({
                        title: 'Remove your passcode?',
                        message:
                          'SellFlow will open without asking for anything on this phone. Your account password still protects the account itself.',
                        confirmLabel: 'Remove',
                      });
                      if (confirmed && user) {
                        await clearPasscode(user.id);
                        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      }
                    }}
                    block
                  />
                ) : null}
              </View>
            </Card>
          </View>

          <View>
            <SectionHeader title="Session" />
            <Card>
              <Text variant="caption" tone="muted" style={{ marginBottom: spacing.md }}>
                Signing out clears the session on this device. Your data stays safe in the cloud.
              </Text>
              <Button
                label="Sign out"
                icon={LogOut}
                variant="secondary"
                block
                onPress={async () => {
                  const confirmed = await confirm({
                    title: 'Sign out?',
                    message: 'You will need to sign in again on this device.',
                    confirmLabel: 'Sign out',
                  });
                  if (confirmed) await signOut();
                }}
              />
            </Card>
          </View>
        </View>
      </Screen>
    </View>
  );
}
