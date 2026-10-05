/**
 * Customer form, used for both creating and editing.
 *
 * WHY A DUPLICATE WARNING AND NOT A DUPLICATE BLOCK
 *
 * The database has `find_duplicate_customers`, which distinguishes a strong signal
 * (same phone) from a weak one (same name). Blocking on a name match would stop two
 * sisters or two customers called Rahim from ever being recorded, which is worse
 * than a duplicate. Blocking on a phone match is defensible -- it is almost certainly
 * the same person -- so that one is refused with the existing customer's name.
 *
 * The warning is shown while the seller types, not on submit. Finding out after
 * saving means remembering what you typed before you can act on it.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { TriangleAlert, UserPlus } from 'lucide-react-native';

import { Button, Card, Input, Screen, Text, TextArea } from '@/components/ui';
import {
  useCreateCustomer,
  useDuplicateCustomerCheck,
  useUpdateCustomer,
} from '@/features/customers/queries';
import { isBdMobileNumber, normalizeBdNumber } from '@/features/payments/normalize';
import { AppError } from '@/lib/errors';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export interface CustomerFormProps {
  customerId?: string;
  initial?: {
    name: string;
    phone: string | null;
    address: string | null;
    district: string | null;
    thana: string | null;
    notes: string | null;
  };
  onSaved?: () => void;
}

type Errors = Partial<Record<'name' | 'phone' | 'address', string>>;

export function CustomerForm({ customerId, initial, onSaved }: CustomerFormProps) {
  const router = useRouter();
  const { spacing, colors } = useTheme();

  const orgId = useSession((state) => state.organization?.id);

  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer();

  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [district, setDistrict] = useState(initial?.district ?? '');
  const [thana, setThana] = useState(initial?.thana ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /*
   * The duplicate check goes through the database's own `find_duplicate_customers`,
   * which is debounced, scoped to the tenant, and already distinguishes a strong
   * signal from a weak one. Recomputing it from the loaded customer list would mean a
   * second, subtly different definition of "duplicate" living in the client.
   */
  const duplicates = useDuplicateCustomerCheck(orgId, name, phone, { enabled: !customerId });

  /*
   * A phone match is a refusal; a name match is only a prompt.
   *
   * `find_duplicate_customers` ranks them: an exact phone match is almost certainly
   * the same person, whereas two customers called Rahim is an ordinary thing.
   * Blocking on a name would stop a seller recording real people.
   */
  const phoneMatch = duplicates.exactPhone ? duplicates.matches[0] : null;
  const nameMatch = phoneMatch
    ? null
    : (duplicates.matches.find((m) => m.match === 'name') ?? null);

  const validate = (): boolean => {
    const next: Errors = {};

    if (!name.trim()) next.name = "Enter the customer's name.";
    else if (name.trim().length > 120) next.name = 'That name is too long.';

    if (phone.trim() && !isBdMobileNumber(phone)) {
      next.phone = 'Enter a valid Bangladeshi mobile number, or leave it empty.';
    }

    setErrors(next);

    // A phone match is a refusal; a name match is only a prompt.
    if (phoneMatch) {
      setBanner(
        `This number already belongs to ${phoneMatch.name}. Open them instead of creating a second record.`,
      );
      return false;
    }

    return Object.keys(next).length === 0;
  };

  const save = async () => {
    setBanner(null);
    setSaved(false);
    if (!validate()) return;

    const payload = {
      name: name.trim(),
      // Canonicalised on the client as well as the server: the unique index is on the
      // raw text, so `+8801...` and `01...` for the same number would not collide.
      phone: phone.trim() ? normalizeBdNumber(phone) : null,
      address: address.trim() || null,
      district: district.trim() || null,
      thana: thana.trim() || null,
      notes: notes.trim() || null,
    };

    try {
      const savedRow = customerId
        ? await updateCustomer.mutateAsync({ customerId, input: payload })
        : await createCustomer.mutateAsync({ orgId: orgId as string, input: payload });

      setSaved(true);
      onSaved?.();
      router.replace(`/customer/${customerId ?? savedRow?.id}`);
    } catch (error) {
      setBanner(error instanceof AppError ? error.title : 'Could not save this customer.');
    }
  };

  const busy = createCustomer.isPending || updateCustomer.isPending;

  return (
    <Screen
      testID="customer-form"
      width="form"
      edges={['top']}
      footer={
        <Button
          label={customerId ? 'Save changes' : 'Save customer'}
          size="lg"
          fullWidth
          loading={busy}
          onPress={() => void save()}
          testID="customer-save"
        />
      }
    >
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">{customerId ? 'Edit customer' : 'New customer'}</Text>
          <Text variant="caption" tone="muted">
            Their order history builds up here as you record orders.
          </Text>
        </View>

        {banner ? (
          <Card elevation="flat" style={{ borderColor: colors.dangerBorder }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs }}>
              <TriangleAlert size={16} color={colors.danger} strokeWidth={1.75} />
              <Text variant="caption" tone="danger" style={{ flex: 1 }} testID="customer-error">
                {banner}
              </Text>
            </View>
          </Card>
        ) : null}

        {saved ? (
          <Card elevation="flat">
            <Text variant="caption" tone="success" testID="customer-saved">
              Saved.
            </Text>
          </Card>
        ) : null}

        {/*
         * The duplicate prompt. Certain (a phone match) is a refusal and is enforced
         * in validate(); uncertain (a name match) is a suggestion only, because two
         * customers sharing a first name is ordinary.
         */}
        {(phoneMatch ?? nameMatch) ? (
          <Card elevation="flat" style={{ borderColor: colors.warningBorder }}>
            <View style={{ gap: spacing.xs, alignItems: 'flex-start' }}>
              <Text variant="caption" tone={phoneMatch ? 'danger' : 'warning'}>
                {phoneMatch
                  ? `${phoneMatch.name} already uses this number.`
                  : `There is already a customer called ${nameMatch?.name}.`}
              </Text>
              {phoneMatch ? null : (
                <Text
                  variant="caption"
                  tone="primary"
                  accessibilityRole="button"
                  onPress={() => router.push(`/customer/${nameMatch?.id}`)}
                >
                  Open them instead
                </Text>
              )}
            </View>
          </Card>
        ) : null}

        <Card>
          <View style={{ gap: spacing.md }}>
            <Input
              label="Name"
              required
              value={name}
              onChangeText={setName}
              error={errors.name}
              placeholder="Rakib Hasan"
              autoComplete="name"
              testID="customer-name"
            />

            {/*
             * Optional. A walk-in customer with no number is a real thing, and
             * blocking the form would push people to write a fake number in.
             */}
            <Input
              label="Phone"
              value={phone}
              onChangeText={setPhone}
              error={errors.phone}
              hint="Optional. Lets you recognise them when they order again."
              keyboardType="phone-pad"
              placeholder="01XXXXXXXXX"
              testID="customer-phone"
            />

            <Input
              label="Address"
              value={address}
              onChangeText={setAddress}
              error={errors.address}
              placeholder="House, road, area"
              testID="customer-address"
            />

            <Input
              label="Thana"
              value={thana}
              onChangeText={setThana}
              placeholder="Mirpur"
              testID="customer-thana"
            />

            <Input
              label="District"
              value={district}
              onChangeText={setDistrict}
              placeholder="Dhaka"
              testID="customer-district"
            />

            <TextArea
              label="Notes"
              value={notes}
              onChangeText={setNotes}
              placeholder="Anything worth remembering. Prefers delivery after 6pm."
              testID="customer-notes"
            />
          </View>
        </Card>

        {!customerId ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
            <UserPlus size={15} color={colors.textMuted} strokeWidth={1.75} />
            <Text variant="caption" tone="muted">
              You can leave the phone empty for a customer you only meet in person.
            </Text>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}