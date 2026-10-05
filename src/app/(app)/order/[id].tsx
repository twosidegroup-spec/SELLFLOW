/**
 * Order detail: what was bought, what it costs, what has been paid, and what happens next.
 *
 * WHY THE STATUS BUTTONS COME FROM THE DATABASE
 *
 * `allowed_order_statuses` is asked for, not hardcoded. The legal transitions are
 * business logic -- a cancelled order cannot be delivered, a delivered one cannot be
 * re-packed -- and it lives in Postgres where it is enforced. Copying that matrix
 * into the client would create a second version that can disagree, and the seller
 * would be the one who finds out.
 *
 * WHY COD IS NOT MONEY
 *
 * A cash-on-delivery order is a receivable. The dashboard treats it as revenue only
 * once it is settled, and so does this screen: `cod_settled` is shown separately from
 * `amount_paid` so a seller is never told they have the cash for a parcel that is
 * still with the rider.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { TriangleAlert, User } from 'lucide-react-native';

import {
  Badge,
  Button,
  Card,
  DetailRow,
  Divider,
  ErrorState,
  LoadingState,
  MoneyInput,
  Screen,
  SectionHeader,
  Text,
} from '@/components/ui';
import { useRecordPayment, useSetOrderStatus } from '@/features/orders/mutations';
import {
  ORDER_STATUS_FLOW,
  ORDER_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
  orderStatusTone,
  paymentStatusTone,
} from '@/features/orders/presentation';
import {
  useAllowedStatuses,
  useOrder,
  useOrderHistory,
  useOrderItems,
  usePayments,
} from '@/features/orders/queries';
import type { PaymentMethod } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { formatMoney, toMajor } from '@/lib/money';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, spacing } = useTheme();

  const role = useSession((state) => state.role);
  const writable = canWrite(role);

  const order = useOrder(id);
  const items = useOrderItems(id);
  const history = useOrderHistory(id);
  const payments = usePayments(id);
  const allowed = useAllowedStatuses(id);

  const setStatus = useSetOrderStatus(id);
  const recordPayment = useRecordPayment(id);

  const [paymentAmount, setPaymentAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [banner, setBanner] = useState<string | null>(null);
  const [showPayment, setShowPayment] = useState(false);

  if (order.isLoading) return <LoadingState label="Loading order" />;

  if (order.isError || !order.data) {
    return (
      <ErrorState
        title="Could not load this order"
        action="It may have been deleted, or you may not have access."
        onRetry={() => void order.refetch()}
      />
    );
  }

  const row = order.data;

  /*
   * Due is derived from the order total and the recorded payments, not from
   * `payment_status`. The status is a summary the database maintains; this is the
   * arithmetic, and a disagreement between them is a bug worth seeing rather than
   * papering over with the status.
   */
  const paid = row.amount_paid;
  const due = Math.max(0, row.total - paid);
  const live = !['cancelled', 'returned'].includes(row.status);

  const move = async (status: (typeof ORDER_STATUS_FLOW)[number]) => {
    setBanner(null);
    try {
      await setStatus.mutateAsync({ status });
    } catch (error) {
      setBanner(error instanceof AppError ? error.title : 'Could not change the status.');
    }
  };

  const pay = async () => {
    setBanner(null);
    if (paymentAmount === null || paymentAmount <= 0) {
      setBanner('Enter how much was paid.');
      return;
    }
    try {
      await recordPayment.mutateAsync({
        amount: toMajor(paymentAmount),
        method,
      });
      setPaymentAmount(null);
      setShowPayment(false);
    } catch (error) {
      setBanner(error instanceof AppError ? error.title : 'Could not record that payment.');
    }
  };

  return (
    <Screen testID="order-detail" width="form" edges={['top']}>
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">#{row.order_number}</Text>
          <View style={{ flexDirection: 'row', gap: spacing.xs, alignItems: 'center' }}>
            <Badge label={ORDER_STATUS_LABEL[row.status]} tone={orderStatusTone(row.status)} />
            <Badge
              label={PAYMENT_STATUS_LABEL[row.payment_status]}
              tone={paymentStatusTone(row.payment_status, live)}
            />
          </View>
          <Text variant="caption" tone="muted">
            {new Date(row.placed_at).toLocaleString()}
          </Text>
        </View>

        {banner ? (
          <Card elevation="flat" style={{ borderColor: colors.dangerBorder }}>
            <View style={{ flexDirection: 'row', gap: spacing.xs, alignItems: 'flex-start' }}>
              <TriangleAlert size={16} color={colors.danger} strokeWidth={1.75} />
              <Text variant="caption" tone="danger" style={{ flex: 1 }} testID="order-detail-error">
                {banner}
              </Text>
            </View>
          </Card>
        ) : null}

        {/*
         * COD is called out separately from `amount_paid`. A seller reading "paid in
         * full" on a parcel that is still with the rider has been told something false,
         * and will spend money they have not received.
         */}
        {row.is_cod && !row.cod_settled ? (
          <Card elevation="flat" style={{ borderColor: colors.warningBorder }}>
            <View style={{ gap: spacing.xxs }}>
              <Text variant="caption" tone="warning">
                Cash on delivery — {formatMoney(row.cod_amount)} to collect.
              </Text>
              <Text variant="caption" tone="muted">
                This is not counted as money in hand until the courier pays out.
              </Text>
            </View>
          </Card>
        ) : null}
        {row.is_cod && row.cod_settled ? (
          <Card elevation="flat" style={{ borderColor: colors.successBorder }}>
            <Text variant="caption" tone="success">
              {`Courier paid out ${formatMoney(row.cod_amount)}.`}
            </Text>
          </Card>
        ) : null}

        {row.customer_id ? (
          <Card elevation="flat">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
              <User size={15} color={colors.textMuted} strokeWidth={1.75} />
              <Text
                variant="bodyStrong"
                tone="primary"
                accessibilityRole="button"
                onPress={() => router.push(`/customer/${row.customer_id}`)}
                testID="order-detail-customer"
              >
                View customer
              </Text>
            </View>
          </Card>
        ) : null}

        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Items" />

          {items.isLoading ? (
            <LoadingState label="Loading items" />
          ) : (
            <Card>
              <View style={{ gap: spacing.sm }}>
                {(items.data ?? []).map((line, index) => (
                  <View key={line.id} style={{ gap: spacing.xxs }}>
                    {index > 0 ? <Divider /> : null}
                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: spacing.xs,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text variant="bodyStrong">
                          {line.product_name}
                          {line.variant_name ? ` · ${line.variant_name}` : ''}
                        </Text>
                        <Text variant="caption" tone="muted">
                          {`${line.quantity} × ${formatMoney(line.unit_price)}`}
                        </Text>
                      </View>
                      <Text variant="numeric">{formatMoney(line.line_total)}</Text>
                    </View>
                  </View>
                ))}

                <Divider />

                <View style={{ gap: spacing.xxs }}>
                  <Row label="Items" value={formatMoney(row.items_total)} />
                  {row.discount > 0 ? (
                    <Row label="Discount" value={`- ${formatMoney(row.discount)}`} />
                  ) : null}
                  {row.delivery_charge > 0 ? (
                    <Row label="Delivery" value={formatMoney(row.delivery_charge)} />
                  ) : null}
                  <Row label="Total" value={formatMoney(row.total)} emphasis />
                </View>
              </View>
            </Card>
          )}
        </View>

        {/*
         * Profit, honestly. `unit_cost` is null on a line whose cost was never
         * recorded, and an order containing one cannot be given a real profit figure.
         * That is reported as "not recorded" instead of being summed as if the cost
         * were zero.
         */}
        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Profit" />
          <Card elevation="flat">
            {itemsHasUnknownCost(items.data) ? (
              <Text variant="caption" tone="muted" testID="order-profit-unknown">
                Not recorded — at least one product in this order has no cost price.
              </Text>
            ) : (
              <DetailRow
                label="Profit"
                value={formatMoney(row.profit)}
                numeric
                tone={row.profit < 0 ? 'danger' : 'success'}
              />
            )}
          </Card>
        </View>

        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Payment" />

          <Card>
            <View style={{ gap: spacing.md }}>
              <DetailRow label="Paid" value={formatMoney(paid)} numeric />
              <DetailRow
                label="Still due"
                value={formatMoney(due)}
                numeric
                tone={due > 0 ? 'danger' : 'success'}
              />

              {payments.data && payments.data.length > 0 ? (
                <View style={{ gap: spacing.xxs }}>
                  <Text variant="micro" tone="muted">
                    PAYMENTS
                  </Text>
                  {payments.data.map((payment) => (
                    <View
                      key={payment.id}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: spacing.xs,
                      }}
                    >
                      <Text variant="caption" tone="muted">
                        {`${new Date(payment.paid_at).toLocaleDateString()} · ${payment.method}`}
                      </Text>
                      <Text
                        variant="caption"
                        tone={payment.is_refund ? 'danger' : 'default'}
                      >
                        {payment.is_refund
                          ? `- ${formatMoney(payment.amount)}`
                          : formatMoney(payment.amount)}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {writable && live && due > 0 ? (
                showPayment ? (
                  <View style={{ gap: spacing.sm }}>
                    <MoneyInput
                      label="Amount received"
                      value={paymentAmount}
                      onChange={setPaymentAmount}
                      hint={`Up to ${formatMoney(due)}.`}
                      testID="payment-amount"
                    />
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
                      {(['cash', 'bkash', 'nagad', 'rocket', 'card', 'bank'] as PaymentMethod[]).map(
                        (option) => (
                          <Badge
                            key={option}
                            label={option}
                            tone={method === option ? 'primary' : 'neutral'}
                            onPress={() => setMethod(option)}
                          />
                        ),
                      )}
                    </View>
                    <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                      <Button
                        label="Record payment"
                        loading={recordPayment.isPending}
                        onPress={() => void pay()}
                        testID="payment-save"
                      />
                      <Button label="Cancel" variant="ghost" onPress={() => setShowPayment(false)} />
                    </View>
                  </View>
                ) : (
                  <Button
                    label="Record a payment"
                    variant="secondary"
                    fullWidth
                    onPress={() => setShowPayment(true)}
                    testID="payment-open"
                  />
                )
              ) : null}
            </View>
          </Card>
        </View>

        {/*
         * Status actions come from the server. Everything the database will refuse is
         * simply not offered, so the seller never fills in a note for a change that
         * cannot happen.
         */}
        {writable ? (
          <View style={{ gap: spacing.sm }}>
            <SectionHeader title="Move this order on" />

            {allowed.isLoading ? (
              <LoadingState label="Loading options" />
            ) : !allowed.data || allowed.data.length === 0 ? (
              <Card elevation="flat">
                <Text variant="caption" tone="muted" testID="order-status-closed">
                  This order has reached a final status. Nothing further can change.
                </Text>
              </Card>
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
                {allowed.data.map((option) => (
                  <Badge
                    key={option}
                    label={ORDER_STATUS_LABEL[option]}
                    tone={orderStatusTone(option)}
                    onPress={() => void move(option)}
                    testID={`order-status-${option}`}
                  />
                ))}
              </View>
            )}
          </View>
        ) : null}

        {history.data && history.data.length > 0 ? (
          <View style={{ gap: spacing.sm }}>
            <SectionHeader title="History" />
            <Card>
              <View style={{ gap: spacing.xs }}>
                {history.data.map((entry) => (
                  <View
                    key={entry.id}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: spacing.xs,
                    }}
                  >
                    <Text variant="caption">
                      {entry.from_status
                        ? `${ORDER_STATUS_LABEL[entry.from_status]} → ${ORDER_STATUS_LABEL[entry.to_status]}`
                        : ORDER_STATUS_LABEL[entry.to_status]}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {new Date(entry.created_at).toLocaleString()}
                    </Text>
                  </View>
                ))}
              </View>
            </Card>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

/** True when any line has no cost price, which makes the order profit unknowable. */
function itemsHasUnknownCost(
  items: { unit_cost: number | null }[] | undefined,
): boolean {
  return (items ?? []).some((line) => line.unit_cost === null);
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  const { spacing } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: spacing.xs,
      }}
    >
      <Text variant={emphasis ? 'bodyStrong' : 'caption'} tone={emphasis ? 'default' : 'muted'}>
        {label}
      </Text>
      <Text variant={emphasis ? 'numericLarge' : 'numeric'}>{value}</Text>
    </View>
  );
}