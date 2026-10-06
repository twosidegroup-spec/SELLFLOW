/**
 * Connect a receiving account.
 *
 * SellFlow does not require a merchant account. The seller types the personal bKash,
 * Nagad, Rocket or Upay number their customers already pay into, and that is the whole
 * onboarding. Copy on this screen says so, because a seller who believes SellFlow needs
 * a merchant account will not start.
 *
 * WHY THE NORMALISED NUMBER IS SHOWN BACK
 *
 * `normalizeBdNumber` rewrites `+8801712...` to `01712...`. That is the right thing to
 * send, and it is also a silent edit of what the seller typed. The rewrite is displayed
 * next to the field instead of being applied quietly, because the number is how they
 * will recognise their own account later and a mismatch there is confusing.
 *
 * The server normalises again and is the authority; this mirror exists so the seller can
 * see what will actually be stored. They can disagree -- the SQL original had a
 * `substring(x from 2)` bug that turned +880 numbers into 080 -- which is why
 * scripts/payment-normalize.test.mjs holds the two together.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Badge, Button, Card, Input, Screen, Text } from '@/components/ui';
import { useCreatePaymentAccount } from '@/features/payments/mutations';
import { isCanonical, isBdMobileNumber, normalizeBdNumber } from '@/features/payments/normalize';
import { PROVIDERS, providerLabel } from '@/features/payments/queries';
import type { PaymentProvider } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function NewPaymentAccountScreen() {
  const router = useRouter();
  const { spacing } = useTheme();

  const orgId = useSession((state) => state.organization?.id);
  const role = useSession((state) => state.role);

  const createAccount = useCreatePaymentAccount();

  const [provider, setProvider] = useState<PaymentProvider>('bkash');
  const [number, setNumber] = useState('');
  const [accountType, setAccountType] = useState<'personal' | 'agent' | 'merchant'>('personal');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const normalised = normalizeBdNumber(number);
  const valid = isBdMobileNumber(number);
  const rewrites = number.trim() !== '' && valid && !isCanonical(number);

  const save = async () => {
    setError(null);

    if (!orgId) {
      setError('Your business is still loading. Try again in a moment.');
      return;
    }
    if (!valid) {
      setError('Enter the number your customers pay into, like 01XXXXXXXXX.');
      return;
    }

    try {
      await createAccount.mutateAsync({
        // From the SESSION. A route value or a typed org id would be a tenant the
        // seller does not own, and the database refuses it anyway.
        orgId,
        provider,
        accountNumber: normalised,
        accountType,
        label: label.trim() || null,
      });
      router.back();
    } catch (err) {
      setError(err instanceof AppError ? err.title : 'Could not connect this account.');
    }
  };

  if (!canWrite(role)) {
    return (
      <Screen testID="payment-account-new" width="form" edges={['top']}>
        <Card elevation="flat">
          <Text variant="caption" tone="muted">
            Your role cannot change payment accounts. Ask an owner or manager.
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen
      testID="payment-account-new"
      width="form"
      edges={['top']}
      footer={
        <Button
          label="Connect account"
          size="lg"
          fullWidth
          loading={createAccount.isPending}
          disabled={!valid}
          onPress={() => void save()}
          testID="payment-account-save"
        />
      }
    >
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">Connect an account</Text>
          <Text variant="caption" tone="muted">
            Use the personal number your customers already pay into. No merchant account
            is needed.
          </Text>
        </View>

        {error ? (
          <Text variant="caption" tone="danger" testID="payment-account-error">
            {error}
          </Text>
        ) : null}

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            Which method do they pay with?
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
            {PROVIDERS.map((option) => (
              <Badge
                key={option.value}
                label={providerLabel(option.value)}
                tone={provider === option.value ? 'primary' : 'neutral'}
                onPress={() => setProvider(option.value)}
                testID={`payment-provider-${option.value}`}
              />
            ))}
          </View>
        </View>

        <Card>
          <View style={{ gap: spacing.md }}>
            <Input
              label={`${providerLabel(provider)} number`}
              required
              value={number}
              onChangeText={setNumber}
              error={number.trim() !== '' && !valid ? 'That is not a Bangladeshi mobile number.' : null}
              hint="The receiving number, not your personal one."
              keyboardType="phone-pad"
              placeholder="01XXXXXXXXX"
              testID="payment-account-number"
            />

            {/*
             * The rewrite is shown rather than applied quietly. This number is how the
             * seller recognises their own account later.
             */}
            {rewrites ? (
              <Text variant="caption" tone="muted" testID="payment-account-rewrite">
                {`Will be saved as ${normalised}`}
              </Text>
            ) : null}

            <View style={{ gap: spacing.xs }}>
              <Text variant="caption" tone="secondary">
                What kind of number is it?
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
                {(['personal', 'agent', 'merchant'] as const).map((option) => (
                  <Badge
                    key={option}
                    label={option === 'personal' ? 'Personal' : option === 'agent' ? 'Agent' : 'Merchant'}
                    tone={accountType === option ? 'primary' : 'neutral'}
                    onPress={() => setAccountType(option)}
                    testID={`payment-account-type-${option}`}
                  />
                ))}
              </View>
              <Text variant="caption" tone="muted">
                {accountType === 'personal'
                  ? 'Almost always this. It works with no merchant agreement.'
                  : accountType === 'agent'
                    ? 'A bKash or Nagad agent number, if you send money through one.'
                    : 'A merchant number you already have with the provider.'}
              </Text>
            </View>

            <Input
              label="Label"
              value={label}
              onChangeText={setLabel}
              hint="Optional. Helps when you have more than one, like “Shop number”."
              placeholder="Shop number"
              testID="payment-account-label"
            />
          </View>
        </Card>
      </View>
    </Screen>
  );
}