/**
 * "Wait for this payment" on an order.
 *
 * Creates a payment intent: a statement that money for THIS order is expected, so that
 * when a payment message arrives the engine has something to match it against. Without
 * an intent there is nothing waiting, and an arriving payment becomes `unmatched` --
 * which is the correct outcome for an advance, but a poor experience for the common
 * case of "I have sent 600, please confirm".
 *
 * THE MONEY BOUNDARY
 *
 * `expected_amount` is a `numeric(14,2)` column in WHOLE taka, so the value sent is
 * built with `toMajor()` and never with `money()`. `money()` is the read path and would
 * multiply a seller's 600 into 60,000. This is the same class of mistake as the
 * hundredfold display defect, in the opposite direction, and it is why the assertion
 * below is worth having in a test rather than only in a comment.
 *
 * The form defaults to what is actually OUTSTANDING, not to the order total. A customer
 * who has already paid 400 of 1,000 is sending 600, and an intent for 1,000 would never
 * match.
 */

import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import {
  Button,
  Card,
  DetailRow,
  ErrorState,
  LoadingState,
  MoneyInput,
  Screen,
  SectionHeader,
  Text,
} from '@/components/ui';
import { useCreatePaymentIntent } from '@/features/payments/mutations';
import {
  providerLabel,
  useOrderIntents,
  useOrderPaymentContext,
  usePaymentAccounts,
} from '@/features/payments/queries';
import type { Money } from '@/lib/money';
import { AppError } from '@/lib/errors';
import { formatMajorUnits, money, toMajor, zero } from '@/lib/money';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function NewPaymentIntentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { spacing } = useTheme();

  const orgId = useSession((state) => state.organization?.id);
  const role = useSession((state) => state.role);

  const accounts = usePaymentAccounts(orgId);
  const context = useOrderPaymentContext(id);
  const openIntents = useOrderIntents(id);
  const createIntent = useCreatePaymentIntent(id);

  const [accountId, setAccountId] = useState<string | null>(null);
  const [amount, setAmount] = useState<Money | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Outstanding is the correct default. An intent for the full order total would never
   * match a customer who has already paid part of it.
   *
   * `money()` here IS the read path: the column holds whole taka and the form edits
   * minor units. The write goes back through `toMajor`.
   */
  const outstanding = useMemo(() => {
    const order = context.order;
    if (!order) return null;
    return money(Math.max(0, order.total - order.amount_paid));
  }, [context.order]);

  const effective = amount ?? outstanding ?? null;
  const save = async () => {
    setError(null);

    if (!accountId) {
      setError('Choose the account the money is going into.');
      return;
    }
    if (!effective || effective <= zero()) {
      setError('This order has nothing outstanding, so there is nothing to wait for.');
      return;
    }

    try {
      await createIntent.mutateAsync({
        orderId: id,
        accountId,
        // `toMajor`, never `money`: this value is written to a whole-taka column.
        expectedAmount: toMajor(effective),
        customerPhone: context?.customer?.phone ?? null,
        customerName: context?.customer?.name ?? null,
      });
      router.back();
    } catch (err) {
      setError(err instanceof AppError ? err.title : 'Could not start waiting for this payment.');
    }
  };

  if (!canWrite(role)) {
    return (
      <Screen testID="payment-intent-new" width="form" edges={['top']}>
        <ErrorState title="Your role cannot do this" action="Ask an owner or manager." />
      </Screen>
    );
  }

  if (context.isLoading) return <LoadingState label="Loading order" />;

  if (!context.order) {
    return (
      <Screen testID="payment-intent-new" width="form" edges={['top']}>
        <ErrorState
          title="Could not load this order"
          action="It may have been deleted, or you may not have access."
        />
      </Screen>
    );
  }

  const active = accounts.active;

  return (
    <Screen
      testID="payment-intent-new"
      width="form"
      edges={['top']}
      footer={
        <Button
          label="Wait for this payment"
          size="lg"
          fullWidth
          loading={createIntent.isPending}
          disabled={!accountId || !effective || effective <= zero()}
          onPress={() => void save()}
          testID="payment-intent-save"
        />
      }
    >
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">{`Wait for payment on #${context.order.order_number}`}</Text>
          <Text variant="caption" tone="muted">
            SellFlow watches for money arriving into an account you connect. When it sees
            a matching payment it settles this order.
          </Text>
        </View>

        {error ? (
          <Text variant="caption" tone="danger" testID="payment-intent-error">
            {error}
          </Text>
        ) : null}

        <Card>
          <View style={{ gap: spacing.sm }}>
            <DetailRow label="Order total" value={formatMajorUnits(context.order.total)} numeric />
            <DetailRow
              label="Already paid"
              value={formatMajorUnits(context.order.amount_paid)}
              numeric
            />
            <DetailRow
              label="Outstanding"
              value={outstanding === null ? '—' : formatMajorUnits(context.order.total - context.order.amount_paid)}
              numeric
              tone={outstanding && outstanding > zero() ? 'danger' : 'success'}
            />
          </View>
        </Card>

        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Which account will it arrive in?" />

          {active.length === 0 ? (
            <Card elevation="flat" style={{ borderColor: 'currentColor' }}>
              <View style={{ gap: spacing.sm }}>
                <Text variant="caption" tone="muted">
                  You have no connected account, so there is nothing to watch. Connect the
                  bKash, Nagad, Rocket or Upay number your customers pay into.
                </Text>
                <Button
                  label="Connect an account"
                  variant="secondary"
                  onPress={() => router.push('/payment-account/new')}
                  testID="payment-intent-connect"
                />
              </View>
            </Card>
          ) : (
            <View style={{ gap: spacing.xs }}>
              {active.map((account) => (
                <Card key={account.id} elevation="flat">
                  <PressableRow
                    onPress={() => setAccountId(account.id)}
                    selected={accountId === account.id}
                    testID={`payment-intent-account-${account.id}`}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
                      <Text variant="bodyStrong">{providerLabel(account.provider)}</Text>
                      {account.label ? (
                        <Text variant="caption" tone="muted">
                          {account.label}
                        </Text>
                      ) : null}
                    </View>
                    <Text variant="caption" tone="muted">
                      {account.account_number}
                    </Text>
                  </PressableRow>
                </Card>
              ))}
            </View>
          )}
        </View>

        <MoneyInput
          label="Amount you expect"
          value={effective}
          onChange={setAmount}
          /*
           * `readOnly`-by-convention rather than locked: the seller may be told a
           * different figure than the balance suggests, and this is where they record
           * it. Left editable deliberately, because a locked field would be a lie the
           * moment the two disagree.
           */
          hint={
            effective === outstanding
              ? 'Defaults to what is outstanding. Change it only if you agreed another figure.'
              : 'Changed from the outstanding balance.'
          }
          testID="payment-intent-amount"
        />

        {/*
         * Already waiting? Saying so beats letting the seller create a second intent
         * and wonder why only one matches.
         */}
        {(openIntents.intents ?? []).filter((intent) => intent.status === 'open').length > 0 ? (
          <Card elevation="flat">
            <Text variant="caption" tone="warning" testID="payment-intent-existing">
              This order is already waiting for a payment. A second wait will not match twice.
            </Text>
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}

/** A row that reads as selectable without pretending to be a checkbox. */
function PressableRow({
  onPress,
  selected,
  testID,
  children,
}: {
  onPress: () => void;
  selected: boolean;
  testID: string;
  children: React.ReactNode;
}) {
  const { colors, radius, spacing } = useTheme();
  const [pressed, setPressed] = useState(false);

  return (
    <View
      style={{
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: selected ? colors.primary : 'transparent',
        backgroundColor: pressed ? colors.surfaceSunken : 'transparent',
        padding: spacing.xs,
      }}
    >
      <Pressable
        onPress={onPress}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        testID={testID}
      >
        <View style={{ gap: spacing.xxs }}>{children}</View>
      </Pressable>
    </View>
  );
}
