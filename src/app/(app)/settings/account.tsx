/**
 * Account.
 *
 * The seller's own identity, their passcode, and the way out. This is the only
 * screen with a sign-out action, and it says what sign-out actually does.
 *
 * The tenant is displayed, never editable here. Changing which organization a screen
 * reads is exactly the kind of thing that must not be reachable by editing client
 * state, and there is no case where a seller needs it in V2.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Building2, ChevronRight, Store, Wallet } from 'lucide-react-native';

import SetPasscode from '../../set-passcode';
import { Button, Card, Divider, Screen, Text } from '@/components/ui';
import { getSupabase, isConfigured } from '@/lib/supabase';
import { useLock } from '@/store/lock';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function AccountScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();

  const user = useSession((state) => state.user);
  const organization = useSession((state) => state.organization);
  const store = useSession((state) => state.store);
  const role = useSession((state) => state.role);
  const signOut = useSession((state) => state.signOut);

  const hasLock = useLock((state) => state.hasPasscode);
  const setPasscode = useLock((state) => state.setPasscode);

  const [changing, setChanging] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const doSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);

    if (isConfigured) {
      await getSupabase().auth.signOut().catch(() => {
        // Even if the network call fails, clear local state: leaving a signed-in
        // shell a seller cannot use is worse than a stale server session, and the
        // token is short-lived and server-revocable.
      });
    }
    await signOut();
    router.replace('/sign-in');
  };

  if (changing) {
    return (
      <SetPasscode
        onSet={async (digits) => {
          if (user?.id) await setPasscode(user.id, digits, [4, 6]);
        }}
        onDone={() => setChanging(false)}
      />
    );
  }

  return (
    <Screen testID="account-screen" width="form">
      <View style={{ gap: spacing.lg }}>
<View style={{ gap: spacing.xxs }}>
          <Text variant="title">Account</Text>
        </View>

        {/*
         * Payments is a stack route rather than a tab, so it gets an explicit entry
         * point here. It sits high on the screen because receiving money and confirming
         * a payment are the two things a seller opens the app to do.
         */}
        <Card>
          <View style={{ gap: spacing.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
              <Wallet size={16} color={colors.textMuted} strokeWidth={1.75} />
              <Text variant="bodyStrong">Payments</Text>
            </View>
            <Text variant="caption" tone="muted">
              The bKash, Nagad, Rocket and Upay numbers you receive into, automatic
              detection, and payments that need checking.
            </Text>
            <Button
              label="Open Payments"
              variant="secondary"
              onPress={() => router.push('/payments')}
              testID="account-open-payments"
            />
          </View>
        </Card>

        <Card>
          <View style={{ gap: spacing.xs }}>
            <Text variant="micro" tone="muted">
              SIGNED IN AS
            </Text>
            <Text variant="bodyStrong">{user?.email ?? '—'}</Text>
            {user?.user_metadata?.full_name ? (
              <Text variant="caption" tone="muted">
                {String(user.user_metadata.full_name)}
              </Text>
            ) : null}
          </View>
        </Card>

        {/*
         * The tenant, shown for the seller's reassurance and for support. Read-only
         * by design: an editable organization here would mean the client choosing
         * which tenant to read, which is precisely what RLS exists to prevent.
         */}
        <Card>
          <View style={{ gap: spacing.md }}>
            <View style={{ gap: spacing.xxs }}>
              <Text variant="micro" tone="muted">
                BUSINESS
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
                <Building2 size={16} color="transparent" strokeWidth={1.75} />
                <Text variant="bodyStrong">{organization?.name ?? '—'}</Text>
              </View>
            </View>

            <Divider style={{ marginVertical: spacing.none }} />

            <View style={{ gap: spacing.xxs }}>
              <Text variant="micro" tone="muted">
                OUTLET
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
                <Store size={16} color="transparent" strokeWidth={1.75} />
                <Text variant="bodyStrong">{store?.name ?? '—'}</Text>
              </View>
              {store?.code ? (
                <Text variant="caption" tone="muted">
                  {`Code ${store.code}`}
                </Text>
              ) : null}
            </View>

            {role ? (
              <Text variant="caption" tone="muted">
                {`Your role: ${role}`}
              </Text>
            ) : null}
          </View>
        </Card>

        <View style={{ gap: spacing.xs }}>
          <Button
            label={hasLock ? 'Change passcode' : 'Set a passcode'}
            variant="secondary"
            fullWidth
            onPress={() => setChanging(true)}
            testID="account-change-passcode"
          />
          <Button
            label="Business details"
            variant="ghost"
            fullWidth
            iconRight={ChevronRight}
            onPress={() => router.push('/settings/business')}
            testID="account-business"
          />
          <Button
            label="Notifications"
            variant="ghost"
            fullWidth
            iconRight={ChevronRight}
            onPress={() => router.push('/settings/notifications')}
            testID="account-notifications"
          />
          <Button
            label="Support"
            variant="ghost"
            fullWidth
            iconRight={ChevronRight}
            onPress={() => router.push('/settings/support')}
            testID="account-support"
          />
        </View>

        <Button
          label="Sign out"
          variant="danger"
          fullWidth
          loading={signingOut}
          onPress={() => void doSignOut()}
          testID="account-signout"
        />

        <Text variant="caption" tone="muted" center>
          Signing out removes your session from this phone. Your business and its data stay exactly
          as they are.
        </Text>
      </View>
    </Screen>
  );
}