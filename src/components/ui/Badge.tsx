/**
 * Status and tag badges.
 *
 * Pills are used only where the shape carries meaning -- a status, a count, a
 * filter -- never as generic decoration. Every badge pairs its colour with a
 * text label, so status is never communicated by colour alone.
 */

import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type { OrderStatus, PaymentStatus } from '@/lib/database.types';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const ORDER_STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  processing: { label: 'Processing', tone: 'info' },
  packaging: { label: 'Packaging', tone: 'info' },
  packed: { label: 'Packed', tone: 'info' },
  shipped: { label: 'Shipped', tone: 'info' },
  on_delivery: { label: 'On Delivery', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  returned: { label: 'Returned', tone: 'danger' },
  failed_delivery: { label: 'Delivery Failed', tone: 'danger' },
};

const PAYMENT_STATUS: Record<PaymentStatus, { label: string; tone: Tone }> = {
  unpaid: { label: 'Unpaid', tone: 'danger' },
  partial: { label: 'Partial', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

export function OrderStatusBadge({ status, style }: { status: OrderStatus; style?: StyleProp<ViewStyle> }) {
  return <Badge tone={ORDER_STATUS[status].tone} label={ORDER_STATUS[status].label} style={style} />;
}

export function PaymentStatusBadge({ status, style }: { status: PaymentStatus; style?: StyleProp<ViewStyle> }) {
  return <Badge tone={PAYMENT_STATUS[status].tone} label={PAYMENT_STATUS[status].label} style={style} />;
}

export function statusLabel(status: OrderStatus): string {
  return ORDER_STATUS[status].label;
}

/** The forward path, in order. Drives the "next step" shortcut on order detail. */
export const STATUS_FLOW: OrderStatus[] = [
  'pending', 'confirmed', 'processing', 'packaging', 'packed',
  'shipped', 'on_delivery', 'delivered',
];

/** States where the parcel is still moving and something could go wrong. */
export const IN_TRANSIT_STATUSES: OrderStatus[] = [
  'confirmed', 'processing', 'packaging', 'packed', 'shipped', 'on_delivery',
];

export function Badge({
  label,
  tone = 'neutral',
  icon,
  style,
}: {
  label: string;
  tone?: Tone;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, radius, spacing } = useTheme();

  const palette: Record<Tone, { bg: string; fg: string }> = {
    neutral: { bg: colors.surfaceSunken, fg: colors.textSecondary },
    info: { bg: colors.primarySoft, fg: colors.primary },
    success: { bg: colors.successSoft, fg: colors.successStrong },
    warning: { bg: colors.warningSoft, fg: colors.warningStrong },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
  };

  const tonePalette = palette[tone];

  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: tonePalette.bg, borderRadius: radius.pill, paddingHorizontal: spacing.xs, gap: 4 },
        style,
      ]}
    >
      {icon}
      <Text variant="micro" style={{ color: tonePalette.fg }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    // Keeps a single-line badge at a consistent, legible height. The inner
    // padding uses the smallest step on the scale rather than an arbitrary 3.
    minHeight: 24,
    paddingVertical: 4,
    // A pill hugs its label. Without this, a badge inside a column stretches to
    // the full card width and reads as a button rather than a status tag.
    alignSelf: 'flex-start',
  },
});
