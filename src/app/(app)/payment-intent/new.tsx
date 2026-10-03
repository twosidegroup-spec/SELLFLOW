/**
 * Wait for a payment on an order.
 *
 * An intent is the thing a detected payment is matched against. Without one, an
 * arriving payment has nothing to line up with and lands in the review queue as
 * "no order found".
 *
 * The amount defaults to what is outstanding and the customer's number is
 * pre-filled from the order. Both defaults matter for matching quality rather
 * than convenience:
 *
 *   - the exact amount is what upgrades a match from "amount only" to confident
 *   - the customer's number is the difference between a strong match and a
 *     medium one, which is the difference between settling itself and waiting
 *     for a person
 *
 * The form does not validate that the amount is collectable; the RPC does,
 * because only the database knows the order's real total and what has already
 * been paid.
 */

import { useState } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { BellRing, CircleSlash } from 'lucide-react-native';

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
import {
  providerLabel,
  useOrderIntents,
  useOrderPaymentContext,
  usePaymentAccounts,
} from '@/features/payments/queries';
import { useCreatePaymentIntent } from '@/features/payments/mutations';
import { AppError } from '@/lib/errors';
import { formatForInput, toMajor, toMinor, type CurrencyCode } from '@/lib/money';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function NewPaymentIntentScreen() {
  const { colors, spacing } = useTheme();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();

  const organization = useSession((state) => state.organization);
  const role = useSession((state) => state.role);
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;
  const canWrite = role === 'owner' || role === 'manager';

  const context = useOrderPaymentContext(orderId);
  const accounts = usePaymentAccounts(organization?.id);
  const intents = useOrderIntents(orderId);
  const createIntent = useCreatePaymentIntent(orderId ?? '');

  const outstanding = context.outstanding;
  const [amountText, setAmountText] = useState(
    outstanding > 0 ? formatForInput(outstanding, currency) : '',
  );
  const [phone, setPhone] = useState(context.customer?.phone ?? '');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [touched, setTouched] = useState(false);

  const activeAccounts = accounts.active;
  const selectedAccount = activeAccounts.find((account) => account.id === accountId) ?? null;
  // Undefined rather than a placeholder string, so SelectField shows its own.
  const accountLabel = selectedAccount
    ? selectedAccount.label ?? providerLabel(selectedAccount.provider)
    : undefined;

  // An order with an intent already waiting gains nothing from a second one: two
  // open intents for the same order is exactly the tie the engine refuses.
  const alreadyWaiting = intents.open.length > 0;

  const amount = toMinor(amountText, currency);
  const amountError =
    touched && (amount === null || amount <= 0)
      ? 'Enter the amount the customer will send.'
      : undefined;

  const canSave =
    Boolean(orderId) &&
    canWrite &&
    amount !== null &&
    amount > 0 &&
    Boolean(selectedAccount) &&
    !alreadyWaiting &&
    !createIntent.isPending;

  async function handleSave() {
    Keyboard.dismiss();
    setTouched(true);
    if (!canSave || !selectedAccount) return;

    try {
      await createIntent.mutateAsync({
        orderId: orderId as string,
        accountId: selectedAccount.id,
        // `toMajor`, not `money`: the column stores whole taka, and `money()` is
        // the READ path. See the note in expense/new.tsx.
        expectedAmount: toMajor(amount as number, currency),
        customerPhone: phone.trim() || null,
        customerName: context.customer?.name ?? null,
      });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  if (context.isLoading) {
    return (
      <FormScreen title="Wait for a payment" footer={<Button label="Close" onPress={() => router.back()} block size="lg" />}>
        <Card>
          <Text variant="caption" tone="muted">
            Loading the order…
          </Text>
        </Card>
      </FormScreen>
    );
  }

  if (!context.order) {
    return (
      <FormScreen title="Wait for a payment" footer={<Button label="Close" onPress={() => router.back()} block size="lg" />}>
        <Card>
          <Text variant="caption" tone="muted">
            That order could not be loaded.
          </Text>
        </Card>
      </FormScreen>
    );
  }

  return (
    <FormScreen
      title="Wait for a payment"
      subtitle={context.order.order_number}
      footer={
        <Button
          label="Start waiting"
          onPress={() => void handleSave()}
          loading={createIntent.isPending}
          disabled={!canSave}
          block
          size="lg"
        />
      }
      sheets={
        <BottomSheet
          visible={accountOpen}
          onClose={() => setAccountOpen(false)}
          title="Paid into"
        >
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
            {activeAccounts.map((account, index) => (
              <View key={account.id}>
                <ListRow
                  title={account.label ?? providerLabel(account.provider)}
                  subtitle={account.account_number}
                  chevron={false}
                  selected={account.id === selectedAccount?.id}
                  last={index === activeAccounts.length - 1}
                  onPress={() => {
                    setAccountId(account.id);
                    setAccountOpen(false);
                  }}
                />
                {index < activeAccounts.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </View>
        </BottomSheet>
      }
    >
      <View style={{ gap: spacing.xl }}>
        {alreadyWaiting ? (
          <Card>
            <View style={[styles.noticeRow, { gap: spacing.md }]}>
              <RowIcon tone="warning">
                <CircleSlash size={18} color={colors.warningStrong} />
              </RowIcon>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="caption">Already waiting on this order</Text>
                <Text variant="micro" tone="muted">
                  A second request would only give the engine two equally good
                  answers, and it would refuse to guess between them.
                </Text>
              </View>
            </View>
          </Card>
        ) : null}

        {activeAccounts.length === 0 ? (
          <Card>
            <View style={[styles.noticeRow, { gap: spacing.md }]}>
              <RowIcon tone="danger">
                <CircleSlash size={18} color={colors.danger} />
              </RowIcon>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="caption">No payment account connected</Text>
                <Text variant="micro" tone="muted">
                  Connect the account customers pay into first — a payment can
                  only be recognised against a connected number.
                </Text>
                <Button
                  label="Connect an account"
                  size="sm"
                  variant="secondary"
                  onPress={() => router.push('/(app)/payment-account/new')}
                />
              </View>
            </View>
          </Card>
        ) : null}

        <Card>
          <View style={{ gap: spacing.md }}>
            <SelectField
              label="Paid into"
              value={accountLabel}
              placeholder="Choose an account"
              onPress={() => setAccountOpen(true)}
            />

            <Input
              label="Amount to expect"
              required
              numeric
              value={amountText}
              onChangeText={(text) => {
                setTouched(true);
                setAmountText(text);
              }}
              placeholder="0"
              editable={!createIntent.isPending}
              error={amountError}
              showError
              hint={
                outstanding > 0
                  ? `Outstanding on this order. The customer should send exactly this.`
                  : undefined
              }
            />

            <Input
              label="Customer number"
              value={phone}
              onChangeText={setPhone}
              placeholder="01812345678"
              editable={!createIntent.isPending}
              hint="Strongly recommended. Without it a matching amount alone is not enough to confirm a payment, because two customers can owe the same amount."
            />
          </View>
        </Card>

        <Card>
          <View style={[styles.noticeRow, { gap: spacing.md }]}>
            <RowIcon tone="info">
              <BellRing size={18} color={colors.primary} />
            </RowIcon>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="caption">What happens next</Text>
              <Text variant="micro" tone="muted">
                When a payment for this exact amount arrives on{' '}
                {accountLabel ?? 'the connected account'}, this
                order is marked paid automatically — but only if the sender
                number is {context.customer?.name ?? 'the customer'}
                {context.customer?.phone ? ` (${context.customer.phone})` : ''} and no other
                order is waiting for the same amount. Anything less waits for you.
              </Text>
            </View>
          </View>
        </Card>

        {createIntent.isError ? (
          <Card style={{ backgroundColor: colors.dangerSoft, borderColor: colors.danger }}>
            <Text variant="caption" tone="danger">
              {AppError.from(createIntent.error).title}
            </Text>
            <Text variant="micro" tone="secondary" style={{ marginTop: 2 }}>
              {AppError.from(createIntent.error).action}
            </Text>
          </Card>
        ) : null}
      </View>
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  noticeRow: { flexDirection: 'row', alignItems: 'flex-start' },
});