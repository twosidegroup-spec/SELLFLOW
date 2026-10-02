/**
 * Customer create / edit.
 *
 * Only a name is required. Sellers recording a sale from a phone call should be
 * able to type the name and be done -- everything else is optional detail they
 * can fill in later.
 */

import { useState } from 'react';
import { Keyboard, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AlertTriangle, Save, User } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { FormScreen } from '@/components/FormScreen';
import {
  Avatar,
  Button,
  Card,
  Divider,
  Input,
  ListRow,
  SectionHeader,
  Text,
  TextArea,
} from '@/components/ui';
import {
  useCreateCustomer,
  useCustomer,
  useDuplicateCustomerCheck,
  useUpdateCustomer,
} from '@/features/customers/queries';
import { AppError } from '@/lib/errors';
import { initials } from '@/lib/format';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function CustomerFormScreen() {
  const { colors, spacing } = useTheme();
  const params = useLocalSearchParams<{ id?: string }>();
  const customerId = params.id;
  const isEditing = Boolean(customerId);

  const organization = useSession((state) => state.organization);
  const existing = useCustomer(customerId);
  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);

  // Seed once from server data during render rather than in an effect, so a
  // background refetch cannot overwrite what the seller is typing.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const loaded = existing.data;
  if (loaded && !touched && seededFor !== loaded.id) {
    setSeededFor(loaded.id);
    setName(loaded.name);
    setPhone(loaded.phone ?? '');
    setEmail(loaded.email ?? '');
    setAddress(loaded.address ?? '');
    setNotes(loaded.notes ?? '');
  }

  // Duplicate detection only applies when creating. When editing, the record on
  // screen IS the existing record and would always match itself.
  const duplicates = useDuplicateCustomerCheck(organization?.id, name, phone, {
    enabled: !isEditing,
  });

  const nameError = touched && !name.trim() ? 'Enter the customer name.' : undefined;
  const phoneError =
    touched && phone.length > 0 && phone.replace(/\D/g, '').length < 6
      ? 'That phone number looks too short.'
      : undefined;
  const emailError =
    touched && email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      ? 'That does not look like an email address.'
      : undefined;

  const busy = createCustomer.isPending || updateCustomer.isPending;
  const canSave = name.trim().length > 0 && !busy;

  /**
   * Whether the form may be submitted.
   *
   * When possible duplicates have been found and the seller has not yet chosen,
   * saving is blocked. This is the whole point of the check: without it the app
   * would either silently merge two people or silently create a second record,
   * and both are worse than asking.
   */
  const duplicatesPending =
    !isEditing && duplicates.matches.length > 0 && !duplicates.resolved;

  async function handleSave() {
    Keyboard.dismiss();
    setTouched(true);

    if (!canSave || duplicatesPending) return;

    try {
      if (isEditing && customerId) {
        await updateCustomer.mutateAsync({
          customerId,
          input: { name, phone, email, address, notes },
        });
      } else if (organization) {
        await createCustomer.mutateAsync({
          orgId: organization.id,
          input: { name, phone, email, address, notes },
        });
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  const mutationError = createCustomer.error ?? updateCustomer.error;

  return (
    <FormScreen
      title={isEditing ? 'Edit customer' : 'New customer'}
      footer={
        <Button
          label={
            duplicatesPending
              ? 'Choose who this is first'
              : isEditing
                ? 'Save changes'
                : 'Save customer'
          }
          icon={duplicatesPending ? AlertTriangle : Save}
          onPress={() => void handleSave()}
          loading={busy}
          disabled={!canSave || duplicatesPending || duplicates.isLoading}
          block
          size="lg"
        />
      }
    >
        <View style={{ gap: spacing.xl }}>
          {/* --------------------------------------------------- duplicates */}
          {!isEditing && duplicates.matches.length > 0 ? (
            <Card
              style={{
                borderColor: duplicates.exactPhone ? colors.warning : colors.border,
                backgroundColor: duplicates.exactPhone ? colors.warningSoft : colors.surface,
                gap: spacing.xs,
              }}
            >
              <Text variant="subtitle">
                {duplicates.exactPhone
                  ? 'This phone number is already on file'
                  : 'A similar customer already exists'}
              </Text>
              <Text variant="micro" tone="secondary">
                {duplicates.exactPhone
                  ? 'Check the list below. If this is the same person, open their record instead of creating a second one.'
                  : 'Same name, different phone number. These may be two different people, so nothing has been changed for you.'}
              </Text>

              <View style={{ marginTop: spacing.xs }}>
                {duplicates.matches.map((match, index) => (
                  <View key={match.id}>
                    <ListRow
                      title={match.name}
                      subtitle={[
                        match.phone,
                        match.order_count > 0
                          ? `${match.order_count} order${match.order_count === 1 ? '' : 's'}`
                          : 'no orders yet',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      leading={
                        <View style={{ alignItems: 'center', gap: 4, width: 52 }}>
                          <Avatar label={initials(match.name)} size={32} />
                        </View>
                      }
                      onPress={() => router.replace(`/(app)/customer/${match.id}`)}
                      accessibilityLabel={`Open existing customer ${match.name}`}
                      last={index === duplicates.matches.length - 1}
                    />
                    {index < duplicates.matches.length - 1 ? <Divider /> : null}
                  </View>
                ))}
              </View>

              <View style={{ gap: spacing.xs, marginTop: spacing.sm }}>
                <Button
                  label="This is a different person"
                  variant="secondary"
                  size="sm"
                  onPress={duplicates.markResolved}
                  block
                />
                <Text variant="micro" tone="muted" center>
                  Only continue if you are sure. A second record means their order history is
                  split in two.
                </Text>
              </View>
            </Card>
          ) : null}

          <Card>
            <View style={{ gap: spacing.md }}>
              <Input
                label="Name"
                required
                value={name}
                onChangeText={(text) => {
                  setTouched(true);
                  setName(text);
                }}
                placeholder="Rahim Uddin"
                icon={User}
                error={nameError}
                editable={!busy}
                autoCapitalize="words"
                returnKeyType="next"
              />

              <Input
                label="Phone"
                value={phone}
                onChangeText={setPhone}
                placeholder="+8801..."
                keyboardType="phone-pad"
                error={phoneError}
                editable={!busy}
              />
            </View>
          </Card>

          <View>
            <SectionHeader title="Details" />
            <Card>
              <View style={{ gap: spacing.md }}>
                <Input
                  label="Email"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Optional"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  error={emailError}
                  editable={!busy}
                />
                <TextArea
                  label="Address"
                  value={address}
                  onChangeText={setAddress}
                  placeholder="Where to deliver"
                  editable={!busy}
                />
                <TextArea
                  label="Notes"
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Preferences, how they pay, anything worth remembering"
                  editable={!busy}
                />
              </View>
            </Card>
          </View>

          {mutationError ? (
            <Card style={{ backgroundColor: colors.dangerSoft, borderColor: colors.danger }}>
              <Text variant="caption" tone="danger">{AppError.from(mutationError).title}</Text>
              <Text variant="micro" tone="secondary" style={{ marginTop: 2 }}>
                {AppError.from(mutationError).action}
              </Text>
            </Card>
          ) : null}
        </View>
    </FormScreen>
  );
}
