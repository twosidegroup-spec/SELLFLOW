/**
 * Business settings.
 *
 * Editing the organization is restricted to the owner in the UI. That is a
 * courtesy, not a control -- the RLS policy on `organizations` is what actually
 * enforces it, and a non-owner calling the update would get a 42501 regardless.
 */

import { useState } from 'react';
import { Keyboard, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Store } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { ScreenHeader } from '@/components/ScreenHeader';
import {
  Badge,
  BottomSheet,
  Button,
  Card,
  Divider,
  Input,
  ListRow,
  Screen,
  SectionHeader,
  SelectField,
  Text,
} from '@/components/ui';
import { AppError } from '@/lib/errors';
import { toMajor, toMinor, type CurrencyCode } from '@/lib/money';
import { getSupabase } from '@/lib/supabase';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * The zones a shop is realistically in, rather than every name Postgres knows.
 *
 * The server validates whatever arrives against `pg_timezone_names` and falls
 * back to UTC, so an unusual zone can never break a report. A short list keeps
 * the picker honest: if a seller's zone is not here, that is a gap to fix, not
 * something to leave them hunting for.
 */
const TIMEZONES: { value: string; label: string }[] = [
  { value: 'Asia/Dhaka', label: 'Dhaka (UTC+6)' },
  { value: 'Asia/Kolkata', label: 'Kolkata (UTC+5:30)' },
  { value: 'Asia/Karachi', label: 'Karachi (UTC+5)' },
  { value: 'Asia/Dubai', label: 'Dubai (UTC+4)' },
  { value: 'Asia/Singapore', label: 'Singapore (UTC+8)' },
  { value: 'Asia/Jakarta', label: 'Jakarta (UTC+7)' },
  { value: 'Asia/Manila', label: 'Manila (UTC+8)' },
  { value: 'Europe/London', label: 'London (UTC+0/+1)' },
  { value: 'Europe/Berlin', label: 'Berlin (UTC+1/+2)' },
  { value: 'Europe/Istanbul', label: 'Istanbul (UTC+3)' },
  { value: 'America/New_York', label: 'New York (UTC-5/-4)' },
  { value: 'America/Chicago', label: 'Chicago (UTC-6/-5)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (UTC-8/-7)' },
  { value: 'Australia/Sydney', label: 'Sydney (UTC+10/+11)' },
  { value: 'UTC', label: 'UTC (no offset)' },
];

export default function BusinessSettingsScreen() {
  const { colors, spacing } = useTheme();
  const queryClient = useQueryClient();
  const organization = useSession((state) => state.organization);
  const store = useSession((state) => state.store);
  const role = useSession((state) => state.role);
  const isOwner = role === 'owner';
  const [timezoneOpen, setTimezoneOpen] = useState(false);

  /**
   * A deliberately short, practical list rather than every zone Postgres knows.
   * The server validates whatever arrives against pg_timezone_names and falls back
   * to UTC if it does not, so an unusual zone cannot break a report -- but a
   * seller who cannot find theirs here will not know why.
   */
  const saveTimezone = useMutation({
    mutationFn: async (timezone: string) => {
      if (!store) return;
      const { error } = await getSupabase().from('stores').update({ timezone }).eq('id', store.id);
      if (error) throw AppError.from(error);
    },
    onSuccess: async () => {
      await useSession.getState().refreshWorkspace();
      setTimezoneOpen(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
    },
  });
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const [name, setName] = useState('');
  const [deliveryFee, setDeliveryFee] = useState('');
  const [touched, setTouched] = useState(false);

  // Seed once from the loaded organization, during render rather than in an
  // effect, so a background refetch cannot clobber unsaved edits.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (organization && !touched && seededFor !== organization.id) {
    setSeededFor(organization.id);
    setName(organization.name);
    setDeliveryFee(
      organization.default_delivery_fee ? String(organization.default_delivery_fee) : '',
    );
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!organization) return;

      const fee = toMinor(deliveryFee, currency) ?? 0;
      if (fee < 0) throw new AppError('Invalid delivery fee', 'Enter zero or more.');

      const { error } = await getSupabase()
        .from('organizations')
        .update({
          name: name.trim(),
          // `toMajor`, not `money`. `fee` is already minor; the column stores
          // whole taka. `money()` is the READ path and multiplied by 100 again.
          default_delivery_fee: toMajor(fee, currency),
        })
        .eq('id', organization.id);

      if (error) throw AppError.from(error);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void useSession.getState().refreshWorkspace();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
  });

  const nameError = touched && !name.trim() ? 'Enter a business name.' : undefined;
  const canSave = name.trim().length > 0 && !save.isPending;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Business" />

      <Screen bottomInset={80}>
        <View style={{ gap: spacing.xl, paddingTop: spacing.sm }}>
          {!isOwner ? (
            <Card style={{ backgroundColor: colors.warningSoft, borderColor: colors.warning }}>
              <Text variant="caption" tone="warning">
                Only the business owner can change these settings.
              </Text>
            </Card>
          ) : null}

          <View>
            <SectionHeader title="Details" />
            <Card>
              <View style={{ gap: spacing.md }}>
                <Input
                  label="Business name"
                  required
                  value={name}
                  onChangeText={(text) => {
                    setTouched(true);
                    setName(text);
                  }}
                  editable={isOwner}
                  error={nameError}
                  autoCapitalize="words"
                />

                <Input
                  label="Default delivery charge"
                  numeric
                  value={deliveryFee}
                  onChangeText={setDeliveryFee}
                  placeholder="0"
                  editable={isOwner}
                  hint="Pre-filled when creating a new order."
                  trailing={
                    <Text variant="caption" tone="muted">{currency === 'BDT' ? 'Tk' : currency}</Text>
                  }
                />
              </View>
            </Card>
          </View>

          <View>
            <SectionHeader title="Currency" />
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Text variant="body" tone="secondary" style={{ flex: 1 }}>
                  {organization?.currency ?? 'BDT'}
                </Text>
              </View>
              <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs }}>
                BDT is the only currency available right now. Changing it affects how amounts are
                shown throughout the app; existing records keep their original values.
              </Text>
            </Card>
          </View>

          <View>
            <SectionHeader title="Inventory" />
            <Card>
              <Text variant="body" tone="secondary">
                Allow negative stock
              </Text>
              <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs }}>
                When off, an order that would take stock below zero is blocked and stock is restored
                automatically if an order is cancelled or returned.
              </Text>
              <View style={{ flexDirection: 'row', gap: spacing.xs, marginTop: spacing.sm }}>
                <Badge
                  label={organization?.allow_negative_stock ? 'Allowed' : 'Blocked'}
                  tone={organization?.allow_negative_stock ? 'warning' : 'success'}
                />
              </View>
            </Card>
          </View>

          <View>
            <SectionHeader title="Stores" />
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Store size={18} color={colors.textMuted} strokeWidth={2} />
                <Text variant="body">{store?.name}</Text>
              </View>
              <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs }}>
                Store order numbers use the code {store?.code ?? 'ORD'} as a prefix. Managing stores
                requires an owner account.
              </Text>
            </Card>
          </View>

          {/*
            The one setting that decides what "today" means.

            SellFlow records the exact moment of every order, but which DAY it
            belongs to depends on where the shop is. Reporting used to cut days
            at UTC midnight, so a seller at UTC+6 saw their first six hours of
            trading filed under the previous day and "Today" read zero every
            morning. This is the single place that boundary is decided.

            Changing it re-buckets historical daily figures: orders previously
            filed under a UTC day move to the seller's own day. The money does not
            change, only which day it is reported on.
          */}
          {isOwner && store ? (
            <View>
              <SectionHeader title="Business day" />
              <Card style={{ gap: spacing.sm }}>
                <SelectField
                  label="Timezone"
                  value={
                    TIMEZONES.find((zone) => zone.value === store.timezone)?.label ??
                    store.timezone ??
                    'UTC'
                  }
                  onPress={() => setTimezoneOpen(true)}
                />
                <Text variant="micro" tone="muted">
                  A day starts at midnight in this timezone. Today, Analytics and Finance all
                  use it. Default is Asia/Dhaka (UTC+6).
                </Text>
              </Card>
            </View>
          ) : null}

          {save.isError ? (
            <Card style={{ backgroundColor: colors.dangerSoft, borderColor: colors.danger }}>
              <Text variant="caption" tone="danger">{AppError.from(save.error).title}</Text>
              <Text variant="micro" tone="secondary" style={{ marginTop: 2 }}>
                {AppError.from(save.error).action}
              </Text>
            </Card>
          ) : null}
        </View>
      </Screen>

      {isOwner ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: colors.surface,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.sm,
            paddingBottom: spacing.lg,
          }}
        >
          <Button
            label="Save changes"
            icon={Save}
            onPress={() => {
              Keyboard.dismiss();
              setTouched(true);
              if (canSave) save.mutate();
            }}
            loading={save.isPending}
            disabled={!canSave}
            block
            size="lg"
          />
        </View>
      ) : null}
      <BottomSheet
        visible={timezoneOpen}
        onClose={() => setTimezoneOpen(false)}
        title="Business day timezone"
        scroll
      >
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>
          <Text variant="micro" tone="muted" style={{ marginBottom: spacing.sm }}>
            Midnight in this timezone is where a new day starts. Today, Analytics and Finance all
            use it, so a sale at 1am counts for the day you made it.
          </Text>
          {TIMEZONES.map((zone, index) => (
            <View key={zone.value}>
              <ListRow
                title={zone.label}
                subtitle={zone.value}
                selected={zone.value === (store?.timezone ?? null)}
                last={index === TIMEZONES.length - 1}
                onPress={() => void saveTimezone.mutateAsync(zone.value)}
              />
              {index < TIMEZONES.length - 1 ? <Divider /> : null}
            </View>
          ))}
          {saveTimezone.isPending ? (
            <Text variant="micro" tone="muted" style={{ marginTop: spacing.sm }}>
              Saving…
            </Text>
          ) : null}
        </View>
      </BottomSheet>
    </View>
  );
}
