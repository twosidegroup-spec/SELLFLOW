/**
 * Shipment tracking card.
 *
 * Shows courier, tracking id, live status and the full event timeline, and
 * gives the seller one-tap copy for the three things they actually need to send
 * on: the tracking id, the tracking link, and a ready-made message to paste into
 * Messenger, WhatsApp or Instagram.
 *
 * The copy-to-clipboard feedback is deliberate and local: these actions have no
 * server round trip, so the confirmation must be immediate and cannot be
 * mistaken for a network state.
 */

import { useState } from 'react';
import { Pressable, Share as NativeShare, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import {
  Check,
  Copy,
  Link2,
  MessageSquare,
  Package,
  RefreshCw,
  Share2,
  Truck,
} from 'lucide-react-native';

import {
  Badge,
  BottomSheet,
  Button,
  Card,
  Divider,
  ListRow,
  ListRowSkeleton,
  SectionHeader,
  Text,
} from '@/components/ui';
import {
  activeShipment,
  buildCustomerMessage,
  providerLabel,
  useShipmentEvents,
  useShipments,
  useUpdateShipmentState,
  shipmentStateLabel,
  MANUAL_SHIPMENT_STATES,
} from '@/features/courier/queries';
import type { ShipmentState } from '@/lib/database.types';
import { formatDateTime } from '@/lib/format';
import { useTheme } from '@/theme/ThemeProvider';

/** States after which the parcel has stopped moving. */
function isClosedState(state: ShipmentState): boolean {
  return state === 'delivered' || state === 'returned' || state === 'cancelled';
}

const STATE_LABEL: Record<ShipmentState, string> = {
  requested: 'Waiting for courier confirmation',
  created: 'Created',
  picked: 'Picked up',
  in_transit: 'In transit',
  at_hub: 'At sorting hub',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  failed: 'Delivery failed',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

function stateTone(state: ShipmentState): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (state === 'delivered') return 'success';
  if (state === 'failed' || state === 'returned' || state === 'cancelled') return 'danger';
  if (state === 'requested') return 'warning';
  return 'info';
}

export function TrackingCard({
  orderId,
  orderNumber,
  onDispatch,
  canDispatch,
}: {
  orderId: string;
  orderNumber: string;
  onDispatch: () => void;
  canDispatch: boolean;
}) {
  const { colors, spacing } = useTheme();
  const [copied, setCopied] = useState<string | null>(null);
  const [stateSheetOpen, setStateSheetOpen] = useState(false);
  const updateState = useUpdateShipmentState();

  const shipments = useShipments(orderId);
  const shipment = activeShipment(shipments.data ?? []);
  const events = useShipmentEvents(shipment?.id);

  // Only the seller-entered providers can be corrected by the seller. A Pathao
  // parcel is owned by the courier: letting the app overwrite it would let a
  // local edit contradict the courier's own record.
  const sellerUpdatesStatus =
    shipment?.provider === 'manual' || shipment?.provider === 'redx';

  async function copy(label: string, value: string) {
    await Clipboard.setStringAsync(value);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(label);
    setTimeout(() => setCopied(null), 1800);
  }

  if (shipments.isLoading) {
    return (
      <View>
        <SectionHeader title="Courier" />
        <Card>
          <ListRowSkeleton />
        </Card>
      </View>
    );
  }

  if (shipments.isError) return null;

  // Nothing dispatched yet.
  if (!shipment) {
    return (
      <View>
        <SectionHeader title="Courier" />
        <Card>
          <View style={{ gap: spacing.sm }}>
            <View style={styles.row}>
              <Truck size={18} color={colors.textMuted} strokeWidth={2} />
              <Text variant="body" tone="secondary" style={{ flex: 1 }}>
                Not sent to a courier yet
              </Text>
            </View>
            {canDispatch ? (
              <Button label="Send to courier" icon={Truck} onPress={onDispatch} block />
            ) : (
              <Text variant="micro" tone="muted">
                Mark the order as Packed to enable dispatch.
              </Text>
            )}
          </View>
        </Card>
      </View>
    );
  }

  const courierName = shipment.provider_label ?? providerLabel(shipment.provider);
  const trackingId = shipment.tracking_id;
  const trackingUrl = shipment.tracking_url;

  const message = buildCustomerMessage({
    orderNumber,
    courierName,
    trackingId,
    trackingUrl,
  });

  return (
    <View>
      <SectionHeader title="Courier and tracking" />

      <Card>
        <View style={styles.row}>
          <View style={[styles.icon, { backgroundColor: colors.primarySoft }]}>
            <Truck size={18} color={colors.primary} strokeWidth={2} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="subtitle">{courierName}</Text>
            <Text variant="micro" tone="muted">
              {providerLabel(shipment.provider)} · attempt {shipment.attempt_no}
            </Text>
          </View>
          <Badge label={STATE_LABEL[shipment.state]} tone={stateTone(shipment.state)} />
        </View>

        {/* Being explicit about the wait is the point: a shipment sitting in
            `requested` has NOT been accepted by the courier yet. */}
        {shipment.state === 'requested' ? (
          <View style={[styles.note, { backgroundColor: colors.warningSoft, borderRadius: 10, padding: spacing.sm, marginTop: spacing.sm }]}>
            <Text variant="micro" tone="warning">
              Waiting for the courier to confirm. Do not send this order again -- retrying is
              safe and will not create a second parcel.
            </Text>
          </View>
        ) : null}

        {shipment.failure_reason ? (
          <View style={[styles.note, { backgroundColor: colors.dangerSoft, borderRadius: 10, padding: spacing.sm, marginTop: spacing.sm }]}>
            <Text variant="micro" tone="danger">
              {shipment.failure_reason}
            </Text>
          </View>
        ) : null}

        {/* Manual and REDX parcels have no courier webhook, so nobody else will            ever update their status. Offering the action here is what keeps a
            returned or delivered parcel from sitting in "in transit" forever. */}
        {sellerUpdatesStatus && !isClosedState(shipment.state) ? (
          <View style={{ marginTop: spacing.sm }}>
            <Button
              label="Update status"
              icon={RefreshCw}
              variant="secondary"
              size="sm"
              onPress={() => setStateSheetOpen(true)}
            />
          </View>
        ) : null}

        {trackingId ? (
          <>
            <Divider style={{ marginVertical: spacing.md }} />

            <View style={{ gap: spacing.xs }}>
              <Text variant="micro" tone="muted">Tracking ID</Text>
              <Pressable
                onPress={() => void copy('id', trackingId)}
                accessibilityRole="button"
                accessibilityLabel={`Copy tracking ID ${trackingId}`}
                style={({ pressed }) => [styles.copyRow, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Text variant="numeric" style={{ flex: 1 }}>{trackingId}</Text>
                {copied === 'id' ? (
                  <Check size={16} color={colors.success} strokeWidth={2.5} />
                ) : (
                  <Copy size={16} color={colors.textMuted} strokeWidth={2} />
                )}
              </Pressable>
            </View>
          </>
        ) : null}

        {trackingUrl ? (
          <View style={{ gap: spacing.xs, marginTop: spacing.sm }}>
            <Text variant="micro" tone="muted">Tracking link</Text>
            <Pressable
              onPress={() => void copy('link', trackingUrl)}
              accessibilityRole="button"
              accessibilityLabel="Copy tracking link"
              style={({ pressed }) => [styles.copyRow, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Link2 size={15} color={colors.textMuted} strokeWidth={2} />
              <Text variant="caption" style={{ flex: 1 }} numberOfLines={1}>
                {trackingUrl}
              </Text>
              {copied === 'link' ? (
                <Check size={16} color={colors.success} strokeWidth={2.5} />
              ) : (
                <Copy size={16} color={colors.textMuted} strokeWidth={2} />
              )}
            </Pressable>
          </View>
        ) : null}

        <View style={{ gap: spacing.xs, marginTop: spacing.md }}>
          <Button
            label="Copy message for customer"
            icon={MessageSquare}
            variant="secondary"
            onPress={() => void copy('message', message)}
            block
          />
          <Text variant="micro" tone="muted" style={{ textAlign: 'center' }}>
            Paste it into Messenger, WhatsApp or Instagram. The customer does not need SellFlow.
          </Text>
          <Button
            label="Share instead"
            icon={Share2}
            variant="ghost"
            size="sm"
            onPress={() => void NativeShare.share({ message })}
          />
        </View>
      </Card>

      {/* Timeline ------------------------------------------------------- */}
      {events.data && events.data.length > 0 ? (
        <Card style={{ marginTop: spacing.sm }}>
          <Text variant="heading" style={{ marginBottom: spacing.sm }}>
            Shipment history
          </Text>

          {events.data.map((event, index) => (
            <View key={event.id} style={styles.timelineRow}>
              <View style={styles.rail}>
                <View style={[styles.dot, { backgroundColor: colors.primary }]}>
                  <Package size={10} color={colors.onPrimary} strokeWidth={2.5} />
                </View>
                {index < events.data.length - 1 ? (
                  <View style={[styles.line, { backgroundColor: colors.border }]} />
                ) : null}
              </View>

              <View style={{ flex: 1, paddingBottom: spacing.md }}>
                <Text variant="subtitle">{event.label}</Text>
                <Text variant="micro" tone="muted">
                  {formatDateTime(event.occurred_at)} ·{' '}
                  {event.source === 'courier'
                    ? 'from courier'
                    : event.source === 'seller'
                      ? 'entered by you'
                      : 'SellFlow'}
                </Text>
                {event.note ? (
                  <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>
                    {event.note}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </Card>
      ) : null}

      {/* Seller-entered status. Writes through the same apply_shipment_update
          the courier webhook uses, tagged source='seller'. */}
      {shipment && sellerUpdatesStatus ? (
        <BottomSheet
          visible={stateSheetOpen}
          onClose={() => setStateSheetOpen(false)}
          title="Update parcel status"
        >
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
            {MANUAL_SHIPMENT_STATES.map((option, index) => (
              <View key={option.value}>
                <ListRow
                  title={option.label}
                  chevron={false}
                  selected={option.value === shipment.state}
                  last={index === MANUAL_SHIPMENT_STATES.length - 1}
                  onPress={() => {
                    setStateSheetOpen(false);
                    void updateState.mutateAsync({
                      shipmentId: shipment.id,
                      state: option.value,
                      label: shipmentStateLabel(option.value),
                    });
                  }}
                />
                {index < MANUAL_SHIPMENT_STATES.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </View>
        </BottomSheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  note: {
    gap: 2,
  },
  copyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    justifyContent: 'center',
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
