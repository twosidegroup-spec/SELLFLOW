/**
 * Order detail.
 *
 * Everything a seller needs to run one order: who it is going to and where, what
 * is inside, what it costs them, what has been paid, where the parcel is, and
 * the full history.
 *
 * Financial presentation is deliberate (requirement 45). Customer-facing money
 * and seller-facing cost are in separate blocks, because a seller who sees
 * "1,000" must always be able to say whether that is revenue, cost or profit.
 */

import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Banknote,
  CircleDot,
  MapPin,
  Package,
  Smartphone,
  Truck,
  Undo2,
  User,
  Wallet,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { DispatchSheet, SettlementSheet } from '@/components/courier/DispatchSheet';
import { TrackingCard } from '@/components/courier/TrackingCard';
import { ScreenHeader } from '@/components/ScreenHeader';
import {
  Amount,
  AmountRow,
  Badge,
  BottomSheet,
  Button,
  Card,
  DetailRow,
  Divider,
  ErrorState,
  Input,
  ListRow,
  ListRowSkeleton,
  OrderStatusBadge,
  PaymentStatusBadge,
  Screen,
  SectionHeader,
  SelectField,
  Text,
  confirm,
  statusLabel,
} from '@/components/ui';
import { useCouriers } from '@/features/dashboard/queries';
import { providerLabel, useOrderIntents } from '@/features/payments/queries';
import {
  useMarkShipped,
  useRecordSettlement,
  useSettlement,
} from '@/features/courier/queries';
import {
  useRecordPayment,
  useRecordRefund,
  useSetOrderStatus,
} from '@/features/orders/mutations';
import {
  useAllowedStatuses,
  useOrder,
  useOrderHistory,
  useOrderItems,
  usePayments,
} from '@/features/orders/queries';
import type { OrderStatus, PaymentMethod } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { formatDateTime, formatRelativeDay } from '@/lib/format';
import {
  EXACT,
  formatForInput,
  formatMoney,
  money,
  toMajor,
  toMinor,
  type CurrencyCode,
} from '@/lib/money';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'bkash', label: 'bKash' },
  { value: 'nagad', label: 'Nagad' },
  { value: 'rocket', label: 'Rocket' },
  { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'other', label: 'Other' },
];

export default function OrderDetailScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string }>();
  const orderId = params.id;

  const organization = useSession((state) => state.organization);
  const role = useSession((state) => state.role);
  const canWrite = role === 'owner' || role === 'manager';
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const order = useOrder(orderId);
  const items = useOrderItems(orderId);
  const history = useOrderHistory(orderId);
  const payments = usePayments(orderId);
  // Intents this order is already waiting on, shown next to the button that
  // creates them so a seller is never told to start waiting twice.
  const openIntents = useOrderIntents(orderId).open;
  const allowed = useAllowedStatuses(orderId);
  const settlement = useSettlement(orderId);
  const couriers = useCouriers(organization?.id);

  const setStatus = useSetOrderStatus(orderId);
  const recordPayment = useRecordPayment(orderId);
  const recordRefund = useRecordRefund(orderId);
  const markShipped = useMarkShipped(orderId);
  const recordSettlement = useRecordSettlement(orderId);

  const [statusSheet, setStatusSheet] = useState(false);
  const [paymentSheet, setPaymentSheet] = useState(false);
  const [dispatchSheet, setDispatchSheet] = useState(false);
  const [settlementSheet, setSettlementSheet] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void order.refetch();
      void items.refetch();
      void history.refetch();
      void payments.refetch();
      void allowed.refetch();
      void settlement.refetch();
      void couriers.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [orderId]),
  );

  if (order.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Order" />
        <Screen>
          <ListRowSkeleton />
          <ListRowSkeleton />
        </Screen>
      </View>
    );
  }

  if (order.isError || !order.data) {
    const error = AppError.from(order.error);
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScreenHeader title="Order" />
        <Screen>
          <ErrorState title={error.title} action={error.action} onRetry={() => void order.refetch()} />
        </Screen>
      </View>
    );
  }

  const data = order.data;
  const total = money(data.total, currency);
  const paid = money(data.amount_paid, currency);
  const due = Math.max(0, total - paid);
  const isClosed = data.status === 'cancelled' || data.status === 'returned';
  const canDispatch = data.status === 'packed';

  async function changeStatus(status: OrderStatus) {
    setStatusSheet(false);

    const destructive = status === 'cancelled' || status === 'returned';
    const ok = await confirm({
      title: `Mark as ${statusLabel(status).toLowerCase()}?`,
      message: destructive
        ? status === 'cancelled'
          ? 'Stock for this order will go back into your inventory.'
          : 'Stock will be restored and the parcel returned.'
        : undefined,
      confirmLabel: statusLabel(status),
      destructive,
    });
    if (!ok) return;

    try {
      await setStatus.mutateAsync({ status });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title={data.order_number}
        subtitle={`Placed ${formatRelativeDay(data.placed_at)}`}
        right={
          canWrite && (allowed.data?.length ?? 0) > 0 ? (
            <Button label="Status" variant="secondary" size="sm" onPress={() => setStatusSheet(true)} />
          ) : undefined
        }
      />

      <Screen>
        <View style={{ gap: spacing.xl, paddingTop: spacing.sm }}>
          {/* Status ------------------------------------------------------- */}
          <Card>
            <View style={styles.row}>
              <View style={{ flex: 1, gap: 4 }}>
                <OrderStatusBadge status={data.status} />
                {data.failure_reason ? (
                  <Text variant="micro" tone="danger">
                    {data.failure_reason}
                  </Text>
                ) : null}
              </View>
              <PaymentStatusBadge status={data.payment_status} />
            </View>

            {data.is_cod ? (
              <View style={{ marginTop: spacing.sm }}>
                <Badge
                  label={`COD ${formatMoney(money(data.cod_amount, currency), currency, EXACT)}`}
                  tone="warning"
                />
              </View>
            ) : null}

            {setStatus.isError ? (
              <Text variant="micro" tone="danger" style={{ marginTop: spacing.xs }}>
                {AppError.from(setStatus.error).title}. {AppError.from(setStatus.error).action}
              </Text>
            ) : null}
          </Card>

          {/* Customer ----------------------------------------------------- */}
          <View>
            <SectionHeader title="Customer" />
            <Card>
              <ListRow
                title={data.delivery_name ?? data.customer?.name ?? 'Walk-in customer'}
                subtitle={data.delivery_phone ?? data.customer?.phone ?? undefined}
                leading={<User size={18} color={colors.textMuted} strokeWidth={2} />}
                onPress={
                  data.customer
                    ? () => router.push(`/(app)/customer/${data.customer!.id}`)
                    : undefined
                }
                chevron={Boolean(data.customer)}
                last
              />

              {data.delivery_address ? (
                <View style={{ marginTop: spacing.sm, gap: 2 }}>
                  <View style={styles.row}>
                    <MapPin size={15} color={colors.textMuted} strokeWidth={2} />
                    <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
                      {data.delivery_address}
                    </Text>
                  </View>
                  <Text variant="caption" tone="muted" style={{ marginLeft: 23 }}>
                    {[data.delivery_thana, data.delivery_district].filter(Boolean).join(', ') ||
                      'No district or thana set'}
                  </Text>
                </View>
              ) : null}
            </Card>
          </View>

          {/* Items -------------------------------------------------------- */}
          <View>
            <SectionHeader title="Items" />
            <Card>
              {items.data?.map((item, index) => (
                <View key={item.id}>
                  <View style={styles.row}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="subtitle" numberOfLines={2}>
                        {item.product_name}
                        {item.variant_name ? ` (${item.variant_name})` : ''}
                      </Text>
                      <Text variant="caption" tone="muted">
                        {item.sku ? `${item.sku} · ` : ''}
                        {item.quantity} × {formatMoney(money(item.unit_price, currency), currency, EXACT)}
                        {item.line_discount > 0
                          ? ` − ${formatMoney(money(item.line_discount, currency), currency, EXACT)}`
                          : ''}
                      </Text>
                      {item.unit_cost !== null ? (
                        <Text variant="micro" tone="muted">
                          Cost {formatMoney(money(item.unit_cost, currency), currency, EXACT)} each
                        </Text>
                      ) : null}
                    </View>
                    <Amount value={money(item.line_total, currency)} currency={currency} />
                  </View>
                  {index < (items.data?.length ?? 0) - 1 ? (
                    <Divider style={{ marginVertical: spacing.xs }} />
                  ) : null}
                </View>
              ))}

              <View style={{ marginTop: spacing.md }}>
                <AmountRow
                  label="Product subtotal"
                  value={money(data.items_total, currency)}
                  currency={currency}
                />
                {data.discount > 0 ? (
                  <AmountRow
                    label="Discount"
                    value={-money(data.discount, currency)}
                    currency={currency}
                    tone="danger"
                  />
                ) : null}
                {data.delivery_charge > 0 ? (
                  <AmountRow
                    label="Delivery charged to customer"
                    value={money(data.delivery_charge, currency)}
                    currency={currency}
                  />
                ) : null}
                <AmountRow label="Customer payable" value={total} currency={currency} emphasis />
              </View>
            </Card>
          </View>

          {/* Courier ------------------------------------------------------ */}
          <TrackingCard
            orderId={orderId}
            orderNumber={data.order_number}
            onDispatch={() => setDispatchSheet(true)}
            canDispatch={canDispatch && canWrite}
          />

          {/* Costs -------------------------------------------------------- */}
          {data.cost_total > 0 || data.courier_cost > 0 || data.other_cost > 0 ? (
            <View>
              <SectionHeader title="Your costs and profit" />
              <Card>
                <AmountRow
                  label="Product cost"
                  value={-money(data.cost_total, currency)}
                  currency={currency}
                />
                {data.courier_cost > 0 ? (
                  <AmountRow
                    label="Courier cost"
                    value={-money(data.courier_cost, currency)}
                    currency={currency}
                  />
                ) : null}
                {data.other_cost > 0 ? (
                  <AmountRow
                    label="Packaging and other"
                    value={-money(data.other_cost, currency)}
                    currency={currency}
                  />
                ) : null}
                <AmountRow
                  label="Profit"
                  value={money(data.profit, currency)}
                  currency={currency}
                  emphasis
                  tone={data.profit >= 0 ? 'success' : 'danger'}
                />
                <Text variant="micro" tone="muted" style={{ marginTop: spacing.xxs }}>
                  Revenue is what the customer pays. Profit is what you keep.
                </Text>
              </Card>
            </View>
          ) : null}

          {/* Payment ------------------------------------------------------ */}
          <View>
            <SectionHeader title="Payment" />
            <Card>
              <AmountRow label="Paid" value={paid} currency={currency} tone="success" />
              {due > 0 && !isClosed ? (
                <AmountRow label="Outstanding" value={due} currency={currency} tone="danger" emphasis />
              ) : null}

              {canWrite && !isClosed ? (
                <>
                  <Button
                    label={due > 0 ? 'Record payment' : 'Record another payment'}
                    icon={Banknote}
                    variant={due > 0 ? 'success' : 'secondary'}
                    onPress={() => setPaymentSheet(true)}
                    block
                    style={{ marginTop: spacing.md }}
                  />

                  {/*
                    Two ways to settle an order, and they are not the same
                    thing. "Record payment" is the seller asserting money changed
                    hands. "Wait for a payment" is the opposite: it publishes an
                    intent for the detection engine to match a real MFS
                    notification against, so an order can be paid without the
                    seller touching this screen at all.

                    Only offered while something is outstanding, because waiting
                    for money that is already recorded would be meaningless.
                  */}
                  {due > 0 ? (
                    <Button
                      label={
                        openIntents.length > 0
                          ? 'Waiting for a payment'
                          : 'Wait for a mobile payment'
                      }
                      icon={Smartphone}
                      variant="secondary"
                      onPress={() => router.push(`/(app)/payment-intent/new?orderId=${orderId}`)}
                      block
                      style={{ marginTop: spacing.sm }}
                    />
                  ) : null}

                  {openIntents.length > 0 ? (
                    <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs }}>
                      Waiting for{' '}
                      {formatMoney(openIntents[0]?.expected_amount ?? 0, currency, EXACT)}
                      {openIntents[0]?.accounts
                        ? ` on ${openIntents[0].accounts.label ?? providerLabel(openIntents[0].accounts.provider)}`
                        : ''}
                      . If a matching payment is detected it will be applied
                      automatically.
                    </Text>
                  ) : null}
                </>
              ) : null}

              {payments.data && payments.data.length > 0 ? (
                <View style={{ marginTop: spacing.md, gap: spacing.xxs }}>
                  <Divider />
                  {payments.data.map((payment) => (
                    <DetailRow
                      key={payment.id}
                      label={`${payment.is_refund ? 'Refund' : 'Payment'} · ${METHODS.find((m) => m.value === payment.method)?.label ?? payment.method}`}
                      sublabel={formatDateTime(payment.paid_at)}
                      amount={formatMoney(
                        payment.is_refund ? -money(payment.amount, currency) : money(payment.amount, currency),
                        currency,
                        EXACT,
                      )}
                      tone={payment.is_refund ? 'danger' : 'success'}
                    />
                  ))}
                </View>
              ) : null}
            </Card>
          </View>

          {/* COD settlement ---------------------------------------------- */}
          {data.is_cod ? (
            <View>
              <SectionHeader title="Cash on delivery" />
              <Card>
                <View style={styles.row}>
                  <Wallet size={18} color={colors.textSecondary} strokeWidth={2} />
                  <View style={{ flex: 1 }}>
                    <Text variant="body">
                      {settlement.data ? SETTLEMENT_LABEL[settlement.data.state] : 'Waiting for delivery'}
                    </Text>
                  </View>
                  {settlement.data?.state === 'settled' ? (
                    <Badge label="Settled" tone="success" />
                  ) : settlement.data?.state === 'collected' ? (
                    <Badge label="Not yet paid" tone="warning" />
                  ) : null}
                </View>

                <View style={{ marginTop: spacing.sm }}>
                  <AmountRow
                    label="Courier is holding"
                    value={money(data.cod_amount, currency)}
                    currency={currency}
                  />
                  {settlement.data ? (
                    <AmountRow
                      label="Paid to you"
                      value={money(settlement.data.settled_amount, currency)}
                      currency={currency}
                      tone="success"
                    />
                  ) : null}
                </View>

                {canWrite ? (
                  <Button
                    label="Record settlement"
                    variant="secondary"
                    onPress={() => setSettlementSheet(true)}
                    block
                    style={{ marginTop: spacing.md }}
                  />
                ) : null}

                <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs }}>
                  Mark it settled only when the money actually reaches your account.
                </Text>
              </Card>
            </View>
          ) : null}

          {/* Notes -------------------------------------------------------- */}
          {data.notes ? (
            <View>
              <SectionHeader title="Notes" />
              <Card>
                <Text variant="body" tone="secondary">{data.notes}</Text>
              </Card>
            </View>
          ) : null}

          {/* Timeline ----------------------------------------------------- */}
          <View>
            <SectionHeader title="History" />
            <Card>
              {history.data?.map((entry, index) => (
                <View key={entry.id} style={styles.timelineRow}>
                  <View style={styles.rail}>
                    <View style={[styles.dot, { backgroundColor: colors.primary }]}>
                      <CircleDot size={10} color={colors.onPrimary} strokeWidth={2.5} />
                    </View>
                    {index < (history.data?.length ?? 0) - 1 ? (
                      <View style={[styles.line, { backgroundColor: colors.border }]} />
                    ) : null}
                  </View>
                  <View style={{ flex: 1, paddingBottom: spacing.md }}>
                    <Text variant="subtitle">{statusLabel(entry.to_status)}</Text>
                    <Text variant="micro" tone="muted">{formatDateTime(entry.created_at)}</Text>
                    {entry.note ? (
                      <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>
                        {entry.note}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </Card>
          </View>
        </View>
      </Screen>

      {/* Sheets ---------------------------------------------------------- */}
      <BottomSheet visible={statusSheet} onClose={() => setStatusSheet(false)} title="Change status">
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
          {(allowed.data ?? []).map((status, index) => (
            <View key={status}>
              <ListRow
                title={statusLabel(status)}
                leading={
                  status === 'cancelled' || status === 'returned' ? (
                    <Undo2 size={18} color={colors.danger} strokeWidth={2} />
                  ) : status === 'packed' || status === 'shipped' ? (
                    <Truck size={18} color={colors.textSecondary} strokeWidth={2} />
                  ) : (
                    <Package size={18} color={colors.textSecondary} strokeWidth={2} />
                  )
                }
                onPress={() => void changeStatus(status)}
                chevron={false}
                last={index === (allowed.data?.length ?? 0) - 1}
              />
              {index < (allowed.data?.length ?? 0) - 1 ? <Divider /> : null}
            </View>
          ))}
        </View>
      </BottomSheet>

      <DispatchSheet
        visible={dispatchSheet}
        onClose={() => setDispatchSheet(false)}
        order={data}
        connections={couriers.data ?? []}
        markingShipped={markShipped.isPending}
        onMarkShipped={async () => {
          try {
            await markShipped.mutateAsync();
            setDispatchSheet(false);
          } catch {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          }
        }}
        currency={currency}
      />

      <PaymentSheet
        visible={paymentSheet}
        onClose={() => setPaymentSheet(false)}
        maxAmount={due}
        currency={currency}
        submitting={recordPayment.isPending}
        error={recordPayment.isError ? AppError.from(recordPayment.error) : null}
        onSubmit={async (amount, method) => {
          try {
            // `amount` is minor (the sheet parses the seller's text with
            // toMinor); `record_payment` writes to a whole-unit column, so it
            // goes back to whole units first. Sending minor made every payment
            // 100x its real value.
            await recordPayment.mutateAsync({ amount: toMajor(amount, currency), method });
            setPaymentSheet(false);
          } catch {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          }
        }}
      />

      <SettlementSheet
        visible={settlementSheet}
        onClose={() => setSettlementSheet(false)}
        orderId={orderId}
        expectedAmount={money(data.cod_amount, currency)}
        currency={currency}
        submitting={recordSettlement.isPending}
        error={recordSettlement.isError ? AppError.from(recordSettlement.error) : null}
        onSubmit={async (input) => {
          try {
            // The sheet parses the amount into minor units; `record_settlement`
            // writes a whole-unit column.
            await recordSettlement.mutateAsync({
              ...input,
              amount: input.amount === null || input.amount === undefined
                ? null
                : toMajor(input.amount, currency),
            });
            setSettlementSheet(false);
          } catch {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          }
        }}
      />

      {/* Refund ---------------------------------------------------------- */}
      {isClosed && paid > 0 && canWrite ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: insets.bottom + spacing.md }}>
          <Button
            label="Record refund"
            variant="secondary"
            onPress={async () => {
              const ok = await confirm({
                title: `Refund ${formatMoney(paid, currency, EXACT)}?`,
                message: 'This records money handed back to the customer.',
                confirmLabel: 'Refund',
                destructive: true,
              });
              if (!ok) return;
              try {
                // `paid` is minor; the refund column is whole units.
                await recordRefund.mutateAsync({ amount: toMajor(paid, currency), method: 'cash' });
              } catch {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              }
            }}
            block
          />
        </View>
      ) : null}

      {/* Manual status override, for couriers with no webhook ------------- */}
      {canWrite && data.status === 'failed_delivery' ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: insets.bottom + spacing.md }}>
          <Button
            label="Re-attempt delivery"
            icon={Truck}
            onPress={() => void changeStatus('packed')}
            block
          />
        </View>
      ) : null}
    </View>
  );
}

const SETTLEMENT_LABEL: Record<string, string> = {
  expected: 'Not delivered yet',
  collected: 'Collected by courier',
  settled: 'Paid out to you',
  refunded: 'Refunded',
  returned: 'Returned',
};

// ---------------------------------------------------------------------------
// Payment sheet
// ---------------------------------------------------------------------------

function PaymentSheet({
  visible,
  onClose,
  onSubmit,
  maxAmount,
  currency,
  submitting,
  error,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (amount: number, method: PaymentMethod) => Promise<void>;
  maxAmount: number;
  currency: CurrencyCode;
  submitting: boolean;
  error: AppError | null;
}) {
  const { spacing } = useTheme();
  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [methodOpen, setMethodOpen] = useState(false);

  const amount = toMinor(amountText, currency) ?? 0;
  const invalid = amount <= 0 || amount > maxAmount;

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Record payment">
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md }}>
        <Text variant="caption" tone="muted">
          Outstanding: {formatMoney(maxAmount, currency, EXACT)}
        </Text>

        <Input
          label="Amount received"
          numeric
          value={amountText}
          onChangeText={setAmountText}
          placeholder="0"
          autoFocus
          error={
            amountText.length > 0 && invalid
              ? `Enter between 1 and ${formatMoney(maxAmount, currency, EXACT)}.`
              : undefined
          }
          showError
          trailing={
            <Button
              label="All"
              size="sm"
              variant="ghost"
              onPress={() => setAmountText(formatForInput(maxAmount, currency))}
            />
          }
        />

        <SelectField
          label="Method"
          value={METHODS.find((m) => m.value === method)?.label}
          onPress={() => setMethodOpen(true)}
          icon={Banknote}
        />

        {error ? (
          <Text variant="micro" tone="danger">
            {error.title}. {error.action}
          </Text>
        ) : null}

        <Button
          label="Record payment"
          onPress={() => void onSubmit(amount, method)}
          loading={submitting}
          disabled={invalid}
          block
          size="lg"
        />
      </View>

      <BottomSheet visible={methodOpen} onClose={() => setMethodOpen(false)} title="Method">
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
          {METHODS.map((option, index) => (
            <View key={option.value}>
              <ListRow
                title={option.label}
                selected={option.value === method}
                chevron={false}
                last={index === METHODS.length - 1}
                onPress={() => {
                  setMethod(option.value);
                  setMethodOpen(false);
                }}
              />
              {index < METHODS.length - 1 ? <Divider /> : null}
            </View>
          ))}
        </View>
      </BottomSheet>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  timelineRow: {
    flexDirection: 'row',
    gap: 12,
  },
  rail: {
    alignItems: 'center',
    width: 24,
  },
  dot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  line: {
    width: StyleSheet.hairlineWidth,
    flex: 1,
    marginVertical: 4,
  },
});
