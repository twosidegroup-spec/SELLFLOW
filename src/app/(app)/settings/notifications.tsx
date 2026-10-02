/**
 * Notification preferences.
 *
 * Stored per user, per business in `notification_preferences`. Toggling is
 * optimistic for responsiveness but rolls back on failure, because a preference
 * that silently did not save is worse than one that took an extra moment.
 */

import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';

import { ScreenHeader } from '@/components/ScreenHeader';
import { Card, Screen, SectionHeader, Text } from '@/components/ui';
import { AppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

type PreferenceKey =
  | 'new_order'
  | 'low_stock'
  | 'payment_due'
  | 'order_status'
  | 'account';

const GROUPS: { title: string; items: { key: PreferenceKey; label: string; description: string }[] }[] = [
  {
    title: 'Orders',
    items: [
      { key: 'new_order', label: 'New orders', description: 'When an order is created' },
      { key: 'order_status', label: 'Status changes', description: 'When an order moves forward or is cancelled' },
      { key: 'payment_due', label: 'Payments due', description: 'Reminders for outstanding balances' },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { key: 'low_stock', label: 'Low stock', description: 'When a product reaches its threshold' },
    ],
  },
  {
    title: 'Account',
    items: [
      { key: 'account', label: 'Account alerts', description: 'Security and sign-in events' },
    ],
  },
];

export default function NotificationSettingsScreen() {
  const { spacing, colors } = useTheme();
  const organization = useSession((state) => state.organization);
  const user = useSession((state) => state.user);

  const [values, setValues] = useState<Record<PreferenceKey, boolean>>({
    new_order: true,
    low_stock: true,
    payment_due: true,
    order_status: true,
    account: true,
  });

  useEffect(() => {
    void (async () => {
      if (!user || !organization) return;

      const { data } = await getSupabase()
        .from('notification_preferences')
        .select('new_order, low_stock, payment_due, order_status, account')
        .eq('org_id', organization.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (data) {
        setValues({
          new_order: data.new_order,
          low_stock: data.low_stock,
          payment_due: data.payment_due,
          order_status: data.order_status,
          account: data.account,
        });
      }
    })();
  }, [user, organization]);

  // `previous` rides along in the variables so a failed save can restore the
  // exact state the user saw before the tap.
  const save = useMutation<
    void,
    Error,
    { next: Record<PreferenceKey, boolean>; previous: Record<PreferenceKey, boolean> }
  >({
    mutationFn: async ({ next }) => {
      if (!user || !organization) return;

      const { error } = await getSupabase().from('notification_preferences').upsert(
        {
          org_id: organization.id,
          user_id: user.id,
          ...next,
        },
        { onConflict: 'org_id,user_id' },
      );

      if (error) throw AppError.from(error);
    },
    onError: (_error, { previous }) => {
      setValues(previous);
    },
  });

  function toggle(key: PreferenceKey) {
    const previous = values;
    const next = { ...previous, [key]: !previous[key] };
    setValues(next);
    save.mutate({ next, previous });
  }

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Notifications" />

      <Screen>
        <View style={{ gap: spacing.xl, paddingTop: spacing.sm }}>
          {GROUPS.map((group) => (
            <View key={group.title}>
              <SectionHeader title={group.title} />
              <Card flush>
                {group.items.map((item, index) => (
                  <View key={item.key}>
                    <View
                      style={[
                        {
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: spacing.md,
                          paddingHorizontal: spacing.md,
                          paddingVertical: spacing.sm,
                          minHeight: 56,
                        },
                        index < group.items.length - 1
                          ? {
                              borderBottomWidth: 1,
                              borderBottomColor: colors.border,
                            }
                          : null,
                      ]}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text variant="body">{item.label}</Text>
                        <Text variant="micro" tone="muted">{item.description}</Text>
                      </View>

                      <Switch
                        value={values[item.key]}
                        onValueChange={() => toggle(item.key)}
                        accessibilityLabel={item.label}
                        trackColor={{ false: colors.border, true: colors.primary }}
                        // The thumb sits on top of a saturated track in both
                        // schemes, so it stays white -- switching it to
                        // textInverse would make it vanish on the light track.
                        thumbColor={colors.onPrimary}
                        ios_backgroundColor={colors.border}
                      />
                    </View>
                  </View>
                ))}
              </Card>
            </View>
          ))}

          {save.isError ? (
            <Text variant="micro" tone="danger">
              {AppError.from(save.error).title}. {AppError.from(save.error).action}
            </Text>
          ) : null}
        </View>
      </Screen>
    </View>
  );
}
