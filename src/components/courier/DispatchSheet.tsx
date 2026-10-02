/**
 * Dispatch sheet.
 *
 * The "Send to courier" flow. Three rules drive the whole design:
 *
 *  1. It is safe to double tap. One idempotency key is held for the lifetime of
 *     the sheet, so a second tap reuses it and the Edge Function returns the
 *     original consignment instead of creating a second parcel.
 *
 *  2. The UI never claims success the courier has not given. A shipment is only
 *     reported as created when a consignment id actually came back; anything
 *     else is a failure and the order stays put so the seller can retry.
 *
 *  3. It only offers what exists. Pathao is a real API. REDX and manual are
 *     explicitly not, and the sheet says so rather than presenting a button that
 *     cannot work.
 */

import { useState } from 'react';
import { Keyboard, View } from 'react-native';
import { AlertTriangle, Info, Truck } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import {
  BottomSheet,
  Button,
  Card,
  Divider,
  Input,
  ListRow,
  SelectField,
  Text,
} from '@/components/ui';
import {
  PROVIDERS,
  useDispatchKey,
  useDispatchShipment,
  useManualShipment,
  useUpdateShipmentState,
  providerLabel,
  shipmentStateLabel,
  MANUAL_SHIPMENT_STATES,
  type ProviderDefinition,
} from '@/features/courier/queries';
import type { CourierConnection, CourierProvider } from '@/features/dashboard/queries';
import type { OrderRow, SettlementState, ShipmentState } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { EXACT, formatForInput, formatMoney, toMinor, type CurrencyCode } from '@/lib/money';
import { useTheme } from '@/theme/ThemeProvider';

const SETTLEMENT_OPTIONS: { value: SettlementState; label: string; description: string }[] = [
  { value: 'collected', label: 'Collected', description: 'Delivered, courier has the cash' },
  { value: 'settled', label: 'Settled', description: 'The money has reached you' },
  { value: 'refunded', label: 'Refunded', description: 'Cash handed back to the customer' },
  { value: 'returned', label: 'Returned', description: 'Parcel came back' },
];

export function DispatchSheet({
  visible,
  onClose,
  order,
  connections,
  onMarkShipped,
  markingShipped,
  currency,
}: {
  visible: boolean;
  onClose: () => void;
  order: OrderRow;
  connections: CourierConnection[];
  onMarkShipped: () => void;
  markingShipped: boolean;
  currency: CurrencyCode;
}) {
  const { colors, spacing } = useTheme();

  const [provider, setProvider] = useState<CourierProvider>('pathao');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [manualTracking, setManualTracking] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualLabel, setManualLabel] = useState('');
  const [manualState, setManualState] = useState<ShipmentState | null>(null);
  const [stateSheetOpen, setStateSheetOpen] = useState(false);

  // One key per open attempt. Reused by every retry until the sheet closes.
  const [idempotencyKey] = useDispatchKey();

  const dispatch = useDispatchShipment();
  const manual = useManualShipment();
  const updateState = useUpdateShipmentState();

  const definition: ProviderDefinition =
    PROVIDERS.find((entry) => entry.id === provider) ?? PROVIDERS[0]!;
  const isApi = definition.hasApi;
  const cod = order.cod_amount > 0;

  function close() {
    onClose();
  }

  async function handleDispatch() {
    Keyboard.dismiss();
    try {
      const result = await dispatch.mutateAsync({
        orderId: order.id,
        provider: 'pathao',
        connectionId,
        idempotencyKey,
      });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      close();

      if (result.status === 'already_dispatched') {
        // Nothing was sent. The order already has a parcel, which is the safe
        // outcome, but the seller should know their tap did nothing.
        return;
      }
      onMarkShipped();
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  async function handleManual() {
    Keyboard.dismiss();
    if (!manualTracking.trim()) return;

    try {
      const shipment = await manual.mutateAsync({
        orderId: order.id,
        provider,
        label: manualLabel.trim() || providerLabel(provider),
        trackingId: manualTracking.trim(),
        trackingUrl: manualUrl.trim() || null,
        idempotencyKey,
      });

      // Apply the seller's current status only once the shipment exists. Doing
      // it before would reference a shipment id that does not exist yet.
      if (manualState && shipment?.id) {
        await updateState.mutateAsync({
          shipmentId: shipment.id,
          state: manualState,
          label: shipmentStateLabel(manualState),
        });
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setManualTracking('');
      setManualUrl('');
      setManualLabel('');
      setManualState(null);
      close();
      onMarkShipped();
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  const error = dispatch.error ?? manual.error;
  const busy = dispatch.isPending || manual.isPending;

  return (
    <BottomSheet visible={visible} onClose={close} title="Send to courier">
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md }}>
        {/* COD summary, so the seller confirms what the courier will collect */}
        {cod ? (
          <View style={[styles.codBox, { backgroundColor: colors.warningSoft, borderRadius: 10, padding: spacing.sm }]}>
            <Text variant="caption" tone="warning">
              Courier will collect {formatMoney(toMinor(order.cod_amount, currency) ?? 0, currency, EXACT)} in cash
            </Text>
          </View>
        ) : (
          <View style={[styles.codBox, { backgroundColor: colors.successSoft, borderRadius: 10, padding: spacing.sm }]}>
            <Text variant="caption" tone="success">
              Prepaid. There is nothing for the courier to collect.
            </Text>
          </View>
        )}

        <View style={{ gap: spacing.xs }}>
          <Text variant="micro" tone="muted">Choose a courier</Text>
          {PROVIDERS.map((entry, index) => {
            const selected = entry.id === provider;
            const connections = entry.hasApi
              ? undefined
              : undefined;
            void connections;

            return (
              <View key={entry.id}>
                <ListRow
                  title={entry.label}
                  subtitle={entry.note ?? (entry.hasApi ? 'Connected by API' : undefined)}
                  selected={selected}
                  chevron={false}
                  onPress={() => setProvider(entry.id)}
                  last={index === PROVIDERS.length - 1}
                />
              </View>
            );
          })}
        </View>

        {/* --- Pathao: real API ------------------------------------------- */}
        {isApi ? (
          <>
            <SelectField
              label="Pathao account"
              value={
                connections.find((c) => c.id === connectionId)?.label ??
                connections[0]?.label ??
                'No account connected'
              }
              onPress={() => setConnectionId(connections[0]?.id ?? null)}
            />

            {connections.length === 0 ? (
              <View style={[styles.warn, { backgroundColor: colors.dangerSoft, borderRadius: 10, padding: spacing.sm }]}>
                <View style={styles.warnRow}>
                  <AlertTriangle size={16} color={colors.danger} strokeWidth={2} />
                  <Text variant="caption" tone="danger" style={{ flex: 1 }}>
                    No Pathao account is connected. Add one in Settings first.
                  </Text>
                </View>
              </View>
            ) : null}

            {order.delivery_district && order.delivery_thana ? (
              <View style={styles.noteRow}>
                <Info size={14} color={colors.textMuted} strokeWidth={2} />
                <Text variant="micro" tone="muted" style={{ flex: 1 }}>
                  Delivering to {order.delivery_thana}, {order.delivery_district}
                </Text>
              </View>
            ) : (
              <View style={[styles.warn, { backgroundColor: colors.warningSoft, borderRadius: 10, padding: spacing.sm }]}>
                <View style={styles.warnRow}>
                  <AlertTriangle size={16} color={colors.warning} strokeWidth={2} />
                  <Text variant="caption" tone="warning" style={{ flex: 1 }}>
                    Add a district and thana to this order before shipping.
                  </Text>
                </View>
              </View>
            )}

            <Button
              label="Send to Pathao"
              icon={Truck}
              onPress={() => void handleDispatch()}
              loading={busy}
              disabled={busy || connections.length === 0}
              block
              size="lg"
            />

            <Text variant="micro" tone="muted" style={{ textAlign: 'center' }}>
              Tapping twice is safe. You will never create two parcels.
            </Text>
          </>
        ) : (
          /* --- REDX / manual: no API, seller enters the tracking --------- */
          <>
            <Card
              style={{
                backgroundColor: colors.surfaceSunken,
                borderWidth: 0,
                gap: 2,
              }}
            >
              <Text variant="caption" tone="secondary">
                {provider === 'redx'
                  ? 'REDX has a merchant API, but it is not publicly documented in a form SellFlow can verify. Rather than guess at its endpoints, you enter the tracking details and keep the timeline up to date.'
                  : 'Enter the tracking details yourself for this courier.'}
              </Text>
              <Text variant="micro" tone="muted">
                The order moves to Shipped and the customer can be given the tracking link.
              </Text>
            </Card>

            <Input
              label="Courier name"
              value={manualLabel}
              onChangeText={setManualLabel}
              placeholder={providerLabel(provider)}
              autoCapitalize="words"
            />

            <Input
              label="Tracking ID"
              required
              value={manualTracking}
              onChangeText={setManualTracking}
              placeholder="Consignment number"
              autoCapitalize="characters"
            />

            <Input
              label="Tracking link"
              value={manualUrl}
              onChangeText={setManualUrl}
              placeholder="Optional"
              autoCapitalize="none"
              keyboardType="url"
            />

            <SelectField
              label="Current status"
              value={manualState ? shipmentStateLabel(manualState) : undefined}
              placeholder="Select what you know"
              onPress={() => setStateSheetOpen(true)}
            />
            <Text variant="micro" tone="muted">
              If the courier has already collected it, record that now. You can change this at any
              time from the order.
            </Text>

            <Button
              label="Save tracking and ship"
              icon={Truck}
              onPress={() => void handleManual()}
              loading={busy}
              disabled={busy || !manualTracking.trim()}
              block
              size="lg"
            />
          </>
        )}

        {error ? (
          <View style={[styles.warn, { backgroundColor: colors.dangerSoft, borderRadius: 10, padding: spacing.sm }]}>
            <Text variant="caption" tone="danger">
              {AppError.from(error).title}
            </Text>
            <Text variant="micro" tone="secondary" style={{ marginTop: 2 }}>
              {AppError.from(error).action}
            </Text>
          </View>
        ) : null}

        <Divider />

        <Button
          label={markingShipped ? 'Marking as shipped...' : 'Mark as shipped without a courier'}
          variant="ghost"
          onPress={onMarkShipped}
          loading={markingShipped}
          disabled={busy}
          block
        />
      </View>

      {/* Seller-entered status picker. Only reachable on the manual path, where
          there is no courier webhook to tell us where the parcel actually is. */}
      <BottomSheet visible={stateSheetOpen} onClose={() => setStateSheetOpen(false)} title="Current status">
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
          {MANUAL_SHIPMENT_STATES.map((option, index) => (
            <View key={option.value}>
              <ListRow
                title={option.label}
                chevron={false}
                selected={option.value === manualState}
                last={index === MANUAL_SHIPMENT_STATES.length - 1}
                onPress={() => {
                  setManualState(option.value);
                  setStateSheetOpen(false);
                }}
              />
              {index < MANUAL_SHIPMENT_STATES.length - 1 ? <Divider /> : null}
            </View>
          ))}
        </View>
      </BottomSheet>
    </BottomSheet>
  );
}

// ---------------------------------------------------------------------------
// COD settlement sheet
// ---------------------------------------------------------------------------

export function SettlementSheet({
  visible,
  onClose,
  orderId,
  expectedAmount,
  currency,
  onSubmit,
  submitting,
  error,
}: {
  visible: boolean;
  onClose: () => void;
  orderId: string;
  expectedAmount: number;
  currency: CurrencyCode;
  onSubmit: (input: {
    state: SettlementState;
    amount?: number | null;
    reference?: string | null;
    notes?: string | null;
  }) => Promise<void>;
  submitting: boolean;
  error: AppError | null;
}) {
  const { spacing } = useTheme();
  const [state, setState] = useState<SettlementState>('collected');
  const [amountText, setAmountText] = useState(formatForInput(expectedAmount, currency));
  const [reference, setReference] = useState('');
  const [open, setOpen] = useState(false);

  const amount = toMinor(amountText, currency) ?? 0;
  const isSettling = state === 'settled';

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Record cash on delivery">
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md }}>
        <Text variant="caption" tone="muted">
          Expected {formatMoney(expectedAmount, currency, EXACT)}
        </Text>

        <SelectField
          label="Status"
          value={SETTLEMENT_OPTIONS.find((o) => o.value === state)?.label}
          onPress={() => setOpen(true)}
        />
        <Text variant="micro" tone="muted">
          {SETTLEMENT_OPTIONS.find((o) => o.value === state)?.description}
        </Text>

        {isSettling ? (
          <>
            <Input
              label="Amount received"
              numeric
              value={amountText}
              onChangeText={setAmountText}
              placeholder="0"
            />
            <Input
              label="Reference"
              value={reference}
              onChangeText={setReference}
              placeholder="bKash / bank transaction id"
              autoCapitalize="none"
            />
          </>
        ) : null}

        {error ? (
          <Text variant="micro" tone="danger">
            {error.title}. {error.action}
          </Text>
        ) : null}

        <Button
          label="Save"
          onPress={() =>
            void onSubmit({
              state,
              amount: isSettling ? amount : null,
              reference: reference.trim() || null,
            })
          }
          loading={submitting}
          disabled={isSettling && amount <= 0}
          block
          size="lg"
        />
      </View>

      <BottomSheet visible={open} onClose={() => setOpen(false)} title="COD status">
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
          {SETTLEMENT_OPTIONS.map((option, index) => (
            <View key={option.value}>
              <ListRow
                title={option.label}
                subtitle={option.description}
                selected={option.value === state}
                chevron={false}
                last={index === SETTLEMENT_OPTIONS.length - 1}
                onPress={() => {
                  setState(option.value);
                  setOpen(false);
                }}
              />
              {index < SETTLEMENT_OPTIONS.length - 1 ? <Divider /> : null}
            </View>
          ))}
        </View>
      </BottomSheet>
    </BottomSheet>
  );
}

const styles = {
  codBox: { gap: 2 } as const,
  warn: { gap: 2 } as const,
  warnRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
  noteRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
};
