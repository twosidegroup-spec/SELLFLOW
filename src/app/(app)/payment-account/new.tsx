/**
 * Connect a payment account.
 *
 * The number a seller types here is the single most consequential field in the
 * whole engine: it is the anchor every future match is scored against. A wrong
 * number does not produce a wrong payment, it produces no payment -- detection
 * silently does nothing. So the form normalises what was typed and shows the
 * canonical result back before saving, rather than trusting the input.
 *
 * There is no verification step and the UI does not pretend otherwise. The
 * account starts in `connected` and earns trust by `last_seen_at`: the first
 * real payment to arrive proves the number is the one customers actually use.
 */

import { useState } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Smartphone } from 'lucide-react-native';

import { FormScreen } from '@/components/FormScreen';
import {
  BottomSheet,
  Button,
  Card,
  Divider,
  Input,
  ListRow,
  RowIcon,
  SelectField,
  Text,
} from '@/components/ui';
import { PROVIDERS } from '@/features/payments/queries';
import { isCanonical, isBdMobileNumber, normalizeBdNumber } from '@/features/payments/normalize';
import { useCreatePaymentAccount } from '@/features/payments/mutations';
import type { PaymentProvider } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

const ACCOUNT_TYPES: { value: 'personal' | 'agent' | 'merchant'; label: string; hint: string }[] = [
  { value: 'personal', label: 'Personal', hint: 'A normal phone number' },
  { value: 'agent', label: 'Agent', hint: 'A reseller account' },
  { value: 'merchant', label: 'Merchant', hint: 'A registered business account' },
];

/**
 * Canonical form of a typed number.
 *
 * Delegates to the shared helper rather than reimplementing it: the SQL original
 * of this rule shipped a bug that turned +8801712... into 0801712..., and a second
 * copy in the UI is a third place for that to happen. See
 * src/features/payments/normalize.ts and scripts/payment-normalize.test.mjs.
 */
const normalize = normalizeBdNumber;

export default function NewPaymentAccountScreen() {
  const { colors, spacing } = useTheme();
  const organization = useSession((state) => state.organization);
  const role = useSession((state) => state.role);
  const canWrite = role === 'owner' || role === 'manager';

  const createAccount = useCreatePaymentAccount();

  const [provider, setProvider] = useState<PaymentProvider>('bkash');
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [accountType, setAccountType] = useState<'personal' | 'agent' | 'merchant'>('personal');
  const [providerOpen, setProviderOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [touched, setTouched] = useState(false);

  const canonical = normalize(number);
  const isValidNumber = isBdMobileNumber(number);
  // Show the canonical form once it differs, so "+880171..." visibly becomes
  // "0171..." rather than being quietly rewritten.
  const showsRewrite = isCanonical(number) === false && isValidNumber;

  const numberError = touched && number.length > 0 && !isValidNumber
    ? 'Enter an 11-digit BD mobile number, for example 01712345678.'
    : undefined;

  const canSave = Boolean(organization) && canWrite && isValidNumber && !createAccount.isPending;

  async function handleSave() {
    Keyboard.dismiss();
    setTouched(true);
    if (!canSave || !organization) return;

    try {
      await createAccount.mutateAsync({
        orgId: organization.id,
        provider,
        accountNumber: canonical,
        accountType,
        label: label.trim() || null,
      });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  const selectedProvider = PROVIDERS.find((option) => option.value === provider);
  const ProviderIcon = selectedProvider?.icon ?? Smartphone;

  if (!canWrite) {
    return (
      <FormScreen title="Connect a receiving account" footer={<Button label="Close" onPress={() => router.back()} block size="lg" />}>
        <Card>
          <Text variant="caption" tone="muted">
            Only the owner or a manager can connect a receiving account.
          </Text>
        </Card>
      </FormScreen>
    );
  }

  return (
    <FormScreen
      title="Connect a receiving account"
      subtitle="The number your customers pay into"
      footer={
        <Button
          label="Connect receiving account"
          onPress={() => void handleSave()}
          loading={createAccount.isPending}
          disabled={!canSave}
          block
          size="lg"
        />
      }
      sheets={
        <>
          <BottomSheet visible={providerOpen} onClose={() => setProviderOpen(false)} title="Provider">
            <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
              {PROVIDERS.map((option, index) => {
                const Icon = option.icon;
                return (
                  <View key={option.value}>
                    <ListRow
                      title={option.label}
                      subtitle={option.numberHint}
                      leading={
                        <RowIcon tone={option.value === provider ? 'info' : 'neutral'}>
                          <Icon
                            size={18}
                            color={option.value === provider ? colors.primary : colors.textMuted}
                          />
                        </RowIcon>
                      }
                      chevron={false}
                      selected={option.value === provider}
                      last={index === PROVIDERS.length - 1}
                      onPress={() => {
                        setProvider(option.value);
                        setProviderOpen(false);
                      }}
                    />
                    {index < PROVIDERS.length - 1 ? <Divider /> : null}
                  </View>
                );
              })}
            </View>
          </BottomSheet>

          <BottomSheet visible={typeOpen} onClose={() => setTypeOpen(false)} title="Account type">
            <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
              {ACCOUNT_TYPES.map((option, index) => (
                <View key={option.value}>
                  <ListRow
                    title={option.label}
                    subtitle={option.hint}
                    chevron={false}
                    selected={option.value === accountType}
                    last={index === ACCOUNT_TYPES.length - 1}
                    onPress={() => {
                      setAccountType(option.value);
                      setTypeOpen(false);
                    }}
                  />
                  {index < ACCOUNT_TYPES.length - 1 ? <Divider /> : null}
                </View>
              ))}
            </View>
          </BottomSheet>
        </>
      }
    >
      <View style={{ gap: spacing.xl }}>
        <Card>
          <View style={{ gap: spacing.md }}>
            <SelectField
              label="Provider"
              value={selectedProvider?.label}
              placeholder="Choose a provider"
              onPress={() => setProviderOpen(true)}
              icon={ProviderIcon}
            />

            <Input
              label="Receiving number"
              required
              numeric
              value={number}
              onChangeText={(text) => {
                setTouched(true);
                setNumber(text);
              }}
              placeholder="01712345678"
              autoFocus
              editable={!createAccount.isPending}
              error={numberError}
              showError
              hint={selectedProvider?.numberHint}
            />

            {/* The rewrite preview. Without this, a seller who types +880... has
                no way to tell whether the stored number is what they meant. */}
            {showsRewrite ? (
              <View style={[styles.rewrite, { gap: spacing.xs }]}>
                <Text variant="micro" tone="muted">
                  Saved as
                </Text>
                <Text variant="caption">{canonical}</Text>
              </View>
            ) : null}

            <SelectField
              label="Account type"
              value={ACCOUNT_TYPES.find((option) => option.value === accountType)?.label}
              onPress={() => setTypeOpen(true)}
            />
          </View>
        </Card>

        <Card>
          <View style={{ gap: spacing.md }}>
            <Input
              label="Label"
              value={label}
              onChangeText={setLabel}
              placeholder="Main counter"
              hint="Optional. Helps when you take payment through more than one number."
              editable={!createAccount.isPending}
            />
          </View>
        </Card>

        {/*
          Stated plainly because the seller is about to make a decision based on
          it: a wrong number does not mis-credit an order, it makes detection do
          nothing at all.
        */}
        <Card>
          <View style={{ gap: spacing.xs }}>
            <Text variant="caption">Check the number before saving</Text>
            <Text variant="micro" tone="muted">
              Payments are only recognised against this exact number. If it is
              wrong, nothing will be detected — but no order will be paid by
              mistake either. The first real payment that arrives proves the
              number is right.
            </Text>
          </View>
        </Card>

        {createAccount.isError ? (
          <Card style={{ backgroundColor: colors.dangerSoft, borderColor: colors.danger }}>
            <Text variant="caption" tone="danger">
              {AppError.from(createAccount.error).title}
            </Text>
            <Text variant="micro" tone="secondary" style={{ marginTop: 2 }}>
              {AppError.from(createAccount.error).action}
            </Text>
          </Card>
        ) : null}
      </View>
    </FormScreen>
  );
}


const styles = StyleSheet.create({
  rewrite: { alignItems: 'flex-start' },
});