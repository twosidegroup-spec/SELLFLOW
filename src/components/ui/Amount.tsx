/**
 * Money display.
 *
 * Requirement 45: a user must never have to guess whether a number is
 * revenue, cost, profit, a payment or an outstanding balance. Every amount in
 * the app goes through one of these components, each of which forces an
 * explicit label and an explicit tone, so "amount minus amount" never appears
 * as an unlabelled figure.
 */

import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { CURRENCIES, formatMoney, type CurrencyCode, type Money } from '@/lib/money';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

/**
 * A single money value.
 *
 * `size` maps to the type scale rather than an ad-hoc font size. `tone` is used
 * for profit/loss semantics only.
 */
export function Amount({
  value,
  currency = 'BDT',
  size = 'md',
  tone = 'primary',
  showSymbol = true,
  style,
  accessibilityLabel,
}: {
  value: Money;
  currency?: CurrencyCode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  tone?: 'primary' | 'secondary' | 'muted' | 'success' | 'danger';
  showSymbol?: boolean;
  style?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
}) {
  const { typography } = useTheme();

  const sizeMap = {
    sm: typography.caption,
    md: typography.numeric,
    lg: typography.title,
    xl: typography.numericLarge,
  } as const;

  const text = formatMoney(value, currency, { showSymbol });

  return (
    <Text
      variant="body"
      tone={tone}
      numberOfLines={1}
      style={[sizeMap[size], style]}
      accessibilityLabel={accessibilityLabel ?? text}
    >
      {text}
    </Text>
  );
}

/**
 * A labelled money line.
 *
 * The default for every financial summary in the app. Rendering `label` and
 * `amount` side by side is what makes a totals block unambiguous.
 */
export function AmountRow({
  label,
  value,
  currency = 'BDT',
  size = 'md',
  tone = 'primary',
  /** Draws a top border and adds vertical breathing room -- marks a subtotal. */
  emphasis = false,
  sublabel,
  style,
}: {
  label: string;
  value: Money;
  currency?: CurrencyCode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  tone?: 'primary' | 'secondary' | 'muted' | 'success' | 'danger';
  emphasis?: boolean;
  sublabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, spacing } = useTheme();

  return (
    <View
      style={[
        styles.amountRow,
        {
          paddingVertical: spacing.xs,
          marginTop: emphasis ? spacing.xs : 0,
          paddingTop: emphasis ? spacing.sm : undefined,
          borderTopWidth: emphasis ? StyleSheet.hairlineWidth : 0,
          borderTopColor: colors.border,
        },
        style,
      ]}
    >
      <View style={styles.amountLabel}>
        <Text variant={emphasis ? 'subtitle' : 'body'} tone={emphasis ? 'primary' : 'secondary'}>
          {label}
        </Text>
        {sublabel ? (
          <Text variant="micro" tone="muted">
            {sublabel}
          </Text>
        ) : null}
      </View>
      <Amount value={value} currency={currency} size={size} tone={tone} />
    </View>
  );
}

/**
 * A labelled count row: the same shape as `AmountRow` without a currency.
 *
 * Exists so that a quantity can never be printed through the money formatter.
 * Routing a count through `Amount` is what made "15 orders" render as
 * "Tk15.00.00" and a low-stock threshold of 6 render as "Tk0.00.06".
 */
export function CountRow({
  label,
  value,
  suffix,
  tone = 'primary',
  emphasis = false,
  sublabel,
  style,
}: {
  label: string;
  value: number | string;
  /** e.g. "orders", "units", "parcels". Rendered after the number. */
  suffix?: string;
  tone?: 'primary' | 'secondary' | 'muted' | 'success' | 'danger';
  emphasis?: boolean;
  sublabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, spacing } = useTheme();

  return (
    <View
      style={[
        styles.amountRow,
        {
          paddingVertical: spacing.xs,
          marginTop: emphasis ? spacing.xs : 0,
          paddingTop: emphasis ? spacing.sm : undefined,
          borderTopWidth: emphasis ? StyleSheet.hairlineWidth : 0,
          borderTopColor: colors.border,
        },
        style,
      ]}
    >
      <View style={styles.amountLabel}>
        <Text variant={emphasis ? 'subtitle' : 'body'} tone={emphasis ? 'primary' : 'secondary'}>
          {label}
        </Text>
        {sublabel ? (
          <Text variant="micro" tone="muted">
            {sublabel}
          </Text>
        ) : null}
      </View>
      <Text variant={emphasis ? 'numeric' : 'body'} tone={tone}>
        {value}
        {suffix ? <Text variant="body" tone="muted">{` ${suffix}`}</Text> : null}
      </Text>
    </View>
  );
}

/**
 * Headline metric for the dashboard.
 *
 * Value plus a caption that says which figure it is and over what window, e.g.
 * "Revenue today". Never shown without that caption.
 */
export function Metric({
  label,
  value,
  currency = 'BDT',
  size = 'lg',
  caption,
  tone = 'primary',
  style,
}: {
  label: string;
  value: Money;
  currency?: CurrencyCode;
  /** Same scale as `Amount`. `md` is for a three-up row; `lg` stands alone. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  caption?: string;
  tone?: 'primary' | 'success' | 'danger';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ gap: 2 }, style]} accessible accessibilityRole="text">
      <Text variant="micro" tone="muted" numberOfLines={1}>
        {label}
      </Text>
      <Amount value={value} currency={currency} size={size} tone={tone} />
      {caption ? (
        <Text variant="micro" tone="muted" numberOfLines={2}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A figure that is deliberately NOT money: a margin percentage, a delivery
 * success rate. Same shape as `Metric`, but the caller supplies the string so a
 * percentage can never be printed with a currency symbol.
 */
export function RatioMetric({
  label,
  value,
  caption,
  tone = 'primary',
  style,
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: 'primary' | 'success' | 'danger';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ gap: 2 }, style]} accessible accessibilityRole="text">
      <Text variant="micro" tone="muted" numberOfLines={1}>
        {label}
      </Text>
      <Text variant="numeric" tone={tone}>
        {value}
      </Text>
      {caption ? (
        <Text variant="micro" tone="muted" numberOfLines={2}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

/** Non-monetary count, e.g. "3 orders". */
export function CountMetric({
  label,
  value,
  caption,
  style,
}: {
  label: string;
  value: number;
  caption?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style} accessible accessibilityRole="text">
      <Text variant="micro" tone="muted" numberOfLines={1}>
        {label}
      </Text>
      <Text variant="numeric">{value}</Text>
        {caption ? (
          // One line, always. Metric is used in three-up rows where the cells
          // are equal width, so a caption that wraps makes one column taller
          // than its neighbours and the row reads as broken rather than as three
          // equal facts.
          <Text variant="micro" tone="muted" numberOfLines={1}>
            {caption}
          </Text>
        ) : null}
    </View>
  );
}

/** Currency symbol, for input affixes. */
export function currencySymbol(code: CurrencyCode = 'BDT'): string {
  return CURRENCIES[code].symbol;
}

const styles = StyleSheet.create({
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  amountLabel: {
    flex: 1,
    gap: 2,
  },
});
