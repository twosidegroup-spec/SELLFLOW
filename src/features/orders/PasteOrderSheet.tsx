/**
 * Pasting a customer-filled order form.
 *
 * The seller sends a short form over WhatsApp or SMS, the customer fills it in
 * and sends it back, and the seller pastes that reply here. The point is that
 * nobody retypes an order a customer already wrote down carefully.
 *
 * The paste never becomes an order on its own. It becomes a *reviewable draft*:
 * what SellFlow understood is shown field by field, anything it could not match
 * is called out, and the seller presses Apply. A parser that is 95% right and
 * commits silently is worse than no parser at all, because the seller stops
 * reading the screen.
 */

import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { TriangleAlert, Wand2, ClipboardCopy } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

import {
  Badge,
  BottomSheet,
  Button,
  Card,
  Divider,
  Text,
  TextArea,
} from '@/components/ui';
import { useTheme } from '@/theme/ThemeProvider';
import {
  BLANK_FORM_TEMPLATE,
  parseOrderForm,
  type MatchableProduct,
  type ParsedOrderForm,
} from './orderForm';

export interface PastedDraft {
  name: string | null;
  phone: string | null;
  lines: { productId: string; quantity: number; name: string }[];
  /** Raw product text that did not match, kept for the seller to act on. */
  unmatched: { raw: string; quantity: number; candidates: { id: string; name: string }[] }[];
  /** Address block to append to the order notes. */
  notes: string | null;
}

export function toNotes(parsed: ParsedOrderForm): string | null {
  const parts: string[] = [];
  if (parsed.address) parts.push(`Address: ${parsed.address}`);
  if (parsed.thana) parts.push(`Thana: ${parsed.thana}`);
  if (parsed.district) parts.push(`Jela: ${parsed.district}`);
  if (parsed.size && !parsed.lines.length) parts.push(`Size: ${parsed.size}`);
  if (parsed.message) parts.push(parsed.message);
  for (const line of parsed.lines) {
    if (line.productId === null && !parts.some((p) => p.includes(line.raw))) {
      parts.push(`Asked for: ${line.raw} x${line.quantity}`);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

/**
 * Shapes a parse result for the order draft.
 *
 * Exported because a request that arrived through a shared link is turned into
 * the same structure, so both entry points feed the draft through identical code.
 */
export function toPastedDraft(parsed: ParsedOrderForm): PastedDraft {
  return {
    name: parsed.name,
    phone: parsed.phone,
    lines: parsed.lines
      .filter((line) => line.productId !== null)
      .map((line) => ({
        productId: line.productId as string,
        quantity: line.quantity,
        name: line.name,
      })),
    unmatched: parsed.lines
      .filter((line) => line.productId === null)
      .map((line) => ({ raw: line.raw, quantity: line.quantity, candidates: line.candidates })),
    notes: toNotes(parsed),
  };
}

export function PasteOrderSheet({
  visible,
  onClose,
  products,
  onApply,
}: {
  visible: boolean;
  onClose: () => void;
  products: MatchableProduct[];
  onApply: (draft: PastedDraft) => void;
}) {
  const { spacing, colors } = useTheme();
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [parsed, setParsed] = useState<ParsedOrderForm | null>(null);

  const canApply = !!parsed && (parsed.lines.length > 0 || !!parsed.name || !!parsed.phone);

  const apply = (source: string | null) => {
    if (typeof source === 'string') setText(source);
    const result = parseOrderForm(typeof source === 'string' ? source : text, products);
    setParsed(result);
    if (result.empty) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } else {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const applyDraft = () => {
    if (!parsed) return;
    onApply(toPastedDraft(parsed));
    setText('');
    setParsed(null);
    onClose();
  };

  const rows = useMemo(() => {
    if (!parsed) return [];
    return [
      { label: 'Name', value: parsed.name },
      { label: 'Phone', value: parsed.phone },
      { label: 'Address', value: parsed.address },
      { label: 'Thana', value: parsed.thana },
      { label: 'Jela', value: parsed.district },
      { label: 'Message', value: parsed.message },
    ].filter((row) => !!row.value);
  }, [parsed]);

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Paste customer order" scroll>
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md }}>
        <Text variant="micro" tone="muted">
          Send your customer this form, let them fill it in, then paste their reply below.
        </Text>

        <Button
          label={copied ? 'Blank form copied' : 'Copy blank form to send'}
          icon={ClipboardCopy}
          variant="secondary"
          block
          onPress={async () => {
            await Clipboard.setStringAsync(BLANK_FORM_TEMPLATE);
            setCopied(true);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setTimeout(() => setCopied(false), 2500);
          }}
        />

        <TextArea
          label="Customer's reply"
          value={text}
          onChangeText={setText}
          placeholder={'Name: Rahim Uddin\nProduct: Cotton Saree\nQuantity: 2'}
          multiline
          minHeight={200}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Button
          label="Read this order"
          icon={Wand2}
          block
          disabled={!text.trim()}
          onPress={() => apply(null)}
        />

        {parsed ? (
          <Card style={{ gap: spacing.sm, backgroundColor: colors.surfaceSunken }}>
            {parsed.empty ? (
              <Text variant="caption" tone="danger">
                Nothing recognisable in that paste. Check it includes at least a name or a
                product.
              </Text>
            ) : null}

            {rows.map((row) => (
              <View key={row.label} style={{ gap: 1 }}>
                <Text variant="micro" tone="muted">
                  {row.label}
                </Text>
                <Text variant="body">{row.value}</Text>
              </View>
            ))}

            {parsed.lines.length ? (
              <View style={{ gap: spacing.xs }}>
                <Divider />
                <Text variant="micro" tone="muted">
                  Products
                </Text>
                {parsed.lines.map((line, index) => (
                  <View
                    key={`${line.raw}-${index}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: spacing.sm,
                    }}
                  >
                    <Text variant="body" style={{ flex: 1 }}>
                      {line.name} ×{line.quantity}
                    </Text>
                    <Badge
                      tone={line.productId ? 'success' : line.candidates.length ? 'warning' : 'danger'}
                      label={
                        line.productId ? 'matched' : line.candidates.length ? 'pick one' : 'not found'
                      }
                    />
                  </View>
                ))}
              </View>
            ) : null}

            {parsed.warnings.length ? (
              <View style={{ gap: spacing.xs }}>
                <Divider />
                {parsed.warnings.map((warning) => (
                  <View key={warning} style={{ flexDirection: 'row', gap: spacing.xs }}>
                    <TriangleAlert size={14} color={colors.warningStrong} />
                    <Text variant="micro" tone="muted" style={{ flex: 1 }}>
                      {warning}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </Card>
        ) : null}

        {parsed && parsed.lines.some((l) => l.candidates.length) ? (
          <Text variant="micro" tone="muted">
            Where a product is ambiguous, add it by hand after applying so you can choose the
            right one.
          </Text>
        ) : null}

        <Button
          label={canApply ? 'Use this order' : 'Nothing to apply yet'}
          block
          size="lg"
          disabled={!canApply}
          onPress={applyDraft}
        />

        {canApply ? (
          <Text variant="micro" tone="muted" style={{ textAlign: 'center' }}>
            This fills the form below. Nothing is saved until you create the order.
          </Text>
        ) : null}
      </View>
    </BottomSheet>
  );
}
