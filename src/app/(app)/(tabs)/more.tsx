/**
 * More tab.
 *
 * A menu, not a dumping ground. Grouped into three sections -- Tools, Business,
 * Account -- so the handful of things a seller actually opens remains obvious
 * even as settings grow.
 */

import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BarChart3,
  Bell,
  Building2,
  ChevronRight,
  CircleHelp,
  Database,
  Link2,
  LogOut,
  Moon,
  Receipt,
  Store,
  UserCog,
  Wallet,
} from 'lucide-react-native';

import { ScreenHeader } from '@/components/ScreenHeader';
import { Card, Divider, Screen, SectionHeader, Text } from '@/components/ui';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function MoreScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const organization = useSession((state) => state.organization);
  const store = useSession((state) => state.store);
  const user = useSession((state) => state.user);
  const role = useSession((state) => state.role);
  const signOut = useSession((state) => state.signOut);

  const isOwner = role === 'owner';

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="More" showBack={false} />

      <Screen bottomInset={insets.bottom}>
        <View style={{ gap: spacing.xl, paddingTop: spacing.sm }}>
          {/* Account summary --------------------------------------------- */}
          <Card>
            <Text variant="heading" numberOfLines={1}>
              {user?.email ?? 'Signed in'}
            </Text>
            <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {[organization?.name, store?.name].filter(Boolean).join(' · ')}
            </Text>
            {role ? (
              <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs, textTransform: 'capitalize' }}>
                Role: {role}
              </Text>
            ) : null}
          </Card>

          {/* Business intelligence ---------------------------------- */}
          <View>
            <SectionHeader title="Performance" />
            <Card flush>
              <MenuRow
                icon={BarChart3}
                title="Analytics"
                subtitle="Revenue, profit and product performance"
                onPress={() => router.push('/(app)/analytics')}
              />
              <Divider />
              <MenuRow
                icon={Wallet}
                title="Finance"
                subtitle="Costs, payments and COD settlement"
                onPress={() => router.push('/(app)/finance')}
              />
            </Card>
          </View>

          {/* Tools --------------------------------------------------------- */}
          <View>
            <SectionHeader title="Business tools" />
            <Card flush>
              <MenuRow
                icon={Receipt}
                title="Expenses"
                subtitle="Advertising, delivery, packaging"
                onPress={() => router.push('/(app)/expense')}
              />
              <Divider />
              <MenuRow
                icon={Link2}
                title="Customer orders"
                subtitle="Requests from your order links"
                onPress={() => router.push('/(app)/order-requests')}
              />
              <Divider />
              <MenuRow
                icon={Bell}
                title="Notifications"
                onPress={() => router.push('/(app)/notifications')}
              />
              <Divider />
              <MenuRow
                icon={Store}
                title="Store"
                subtitle={store?.name}
                onPress={() => router.push('/(app)/settings/business')}
              />
            </Card>
          </View>

          {/* Settings ------------------------------------------------------ */}
          <View>
            <SectionHeader title="Settings" />
            <Card flush>
              <MenuRow
                icon={Building2}
                title="Business"
                subtitle={isOwner ? undefined : 'Only the owner can edit'}
                onPress={() => router.push('/(app)/settings/business')}
              />
              <Divider />
              <MenuRow
                icon={UserCog}
                title="Account"
                subtitle="Profile, password, sign out"
                onPress={() => router.push('/(app)/settings/account')}
              />
              <Divider />
              <MenuRow
                icon={Bell}
                title="Notification preferences"
                onPress={() => router.push('/(app)/settings/notifications')}
              />
              <Divider />
              <MenuRow
                icon={Moon}
                title="Appearance"
                subtitle="Light, dark or system"
                onPress={() => router.push('/(app)/settings/appearance')}
              />
              <Divider />
              <MenuRow
                icon={Database}
                title="Data and sync"
                onPress={() => router.push('/(app)/settings/data')}
              />
              <Divider />
              <MenuRow
                icon={CircleHelp}
                title="Help and about"
                onPress={() => router.push('/(app)/settings/support')}
              />
            </Card>
          </View>

          {/* Sign out ------------------------------------------------------ */}
          <View>
            <SectionHeader title="Session" />
            <Card>
              <SignOutRow onPress={() => void signOut()} />
            </Card>
          </View>
        </View>
      </Screen>
    </View>
  );
}

function MenuRow({
  icon: Icon,
  title,
  subtitle,
  onPress,
}: {
  icon: typeof Bell;
  title: string;
  subtitle?: string;
  onPress: () => void;
}) {
  const { colors, spacing } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.md,
          minHeight: 52,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      <Icon size={20} color={colors.textSecondary} strokeWidth={1.9} />

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body">{title}</Text>
        {subtitle ? (
          <Text variant="micro" tone="muted">{subtitle}</Text>
        ) : null}
      </View>

      <ChevronRight size={18} color={colors.textMuted} strokeWidth={2} />
    </Pressable>
  );
}

function SignOutRow({ onPress }: { onPress: () => void }) {
  const { colors, spacing } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Sign out"
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: spacing.xs,
          minHeight: 48,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      <LogOut size={18} color={colors.danger} strokeWidth={2} />
      <Text variant="subtitle" tone="danger">Sign out</Text>
    </Pressable>
  );
}
