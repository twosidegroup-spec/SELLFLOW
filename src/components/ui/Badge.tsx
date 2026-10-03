/**
 * Status and tag badges.
 *
 * Pills are used only where the shape carries meaning -- a status, a count, a
 * filter -- never as generic decoration. Every badge pairs its colour with a
 * text label, so status is never communicated by colour alone.
 */

import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type {
  OrderStatus,
  PaymentEventStatus,
  PaymentIntentStatus,
  PaymentMatchStrength,
  PaymentStatus,
} from '@/lib/database.types';
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

/**
 * Payment engine badges.
 *
 * The colours carry the review queue's meaning, so they are chosen by what the
 * seller has to DO rather than by the database enum name:
 *
 *   confirmed        green  -- money is on the order, nothing to do
 *   review_required  amber  -- the engine saw it and refused; a person decides
 *   unmatched        amber  -- real money, nothing was waiting for it
 *   mismatch         red    -- the numbers do not line up
 *   duplicate        grey   -- correctly ignored, never counted twice
 *
 * `customer_phone_matched` being null versus false is the reason `medium` and
 * `weak` are distinct words here: one means "nobody could be identified" and the
 * other means "the wrong person sent it".
 */

const EVENT_STATUS: Record<PaymentEventStatus, { label: string; tone: Tone }> = {
  detected: { label: 'Detected', tone: 'info' },
  matched: { label: 'Matched', tone: 'info' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  unmatched: { label: 'No order found', tone: 'warning' },
  mismatch: { label: 'Does not match', tone: 'danger' },
  duplicate: { label: 'Already counted', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  review_required: { label: 'Needs review', tone: 'warning' },
};

export function PaymentEventStatusBadge({
  status,
  style,
}: {
  status: PaymentEventStatus;
  style?: StyleProp<ViewStyle>;
}) {
  const entry = EVENT_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge label={entry.label} tone={entry.tone} style={style} />;
}

const MATCH_STRENGTH: Record<PaymentMatchStrength, { label: string; tone: Tone }> = {
  strong: { label: 'Confident', tone: 'success' },
  medium: { label: 'Amount only', tone: 'warning' },
  weak: { label: 'Unlikely', tone: 'danger' },
  manual: { label: 'By you', tone: 'info' },
};

export function PaymentMatchBadge({
  strength,
  style,
}: {
  strength: PaymentMatchStrength;
  style?: StyleProp<ViewStyle>;
}) {
  const entry = MATCH_STRENGTH[strength] ?? { label: strength, tone: 'neutral' as Tone };
  return <Badge label={entry.label} tone={entry.tone} style={style} />;
}

const INTENT_STATUS: Record<PaymentIntentStatus, { label: string; tone: Tone }> = {
  open: { label: 'Waiting', tone: 'info' },
  matched: { label: 'Paid', tone: 'success' },
  partially_paid: { label: 'Part paid', tone: 'warning' },
  expired: { label: 'Expired', tone: 'neutral' },
  cancelled: { label: 'Stopped', tone: 'neutral' },
  mismatched: { label: 'Mismatch', tone: 'danger' },
};

export function PaymentIntentStatusBadge({
  status,
  style,
}: {
  status: PaymentIntentStatus;
  style?: StyleProp<ViewStyle>;
}) {
  const entry = INTENT_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge label={entry.label} tone={entry.tone} style={style} />;
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
