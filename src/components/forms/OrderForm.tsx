/**
 * New order.
 *
 * The screen a seller actually lives in. Everything else in SellFlow is a ledger over
 * this.
 *
 * THREE RULES THAT SHAPE THE WHOLE SCREEN
 *
 * 1. Totals are computed here and recomputed by `create_order` in Postgres. The
 *    preview is a convenience; the server figure is the truth. They agree because
 *    both use integer minor units -- not because two implementations were kept in
 *    step by hand.
 *
 * 2. Stock is a WARNING, never a block. `allow_negative_stock` is a per-business
 *    setting, and the server is the authority on it. Refusing here would contradict a
 *    rule the seller deliberately turned off.
 *
 * 3. Nothing is inferred into the order. A pasted customer message becomes a DRAFT
 *    with its warnings visible, never an order. The seller is the one who knows
 *    whether "saree" meant cotton or silk.
 */

import { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ClipboardPaste, Plus, Trash2, TriangleAlert, User } from 'lucide-react-native';

import {
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingState,
  MoneyInput,
  NumberInput,
  Screen,
  SearchBar,
  SectionHeader,
  Text,
  TextArea,
} from '@/components/ui';
import { useCustomerPicker } from '@/features/customers/queries';
import {
  addLineToDraft,
  calculateTotals,
  lineTotal,
  outstanding,
  stockWarnings,
  validateDraft,
  type DraftLine,
} from '@/features/orders/calculations';
import { useCreateOrder } from '@/features/orders/mutations';
import { BLANK_FORM_TEMPLATE, parseOrderForm } from '@/features/orders/orderForm';
import { useProductPicker } from '@/features/products/queries';
import type { PaymentMethod } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { formatMoney, money, toMajor, zero } from '@/lib/money';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

/** Payment methods a seller can actually take in the room. */
const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'bkash', label: 'bKash' },
  { value: 'nagad', label: 'Nagad' },
  { value: 'rocket', label: 'Rocket' },
  { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank' },
];

export function OrderForm() {
  const router = useRouter();
  const { colors, spacing } = useTheme();

  const storeId = useSession((state) => state.store?.id);
  const orgId = useSession((state) => state.organization?.id);
  const role = useSession((state) => state.role);

  const products = useProductPicker(storeId);
  const customers = useCustomerPicker(orgId);
  const createOrder = useCreateOrder();

  const [lines, setLines] = useState<DraftLine[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [discount, setDiscount] = useState<number | null>(null);
  const [deliveryCharge, setDeliveryCharge] = useState<number | null>(null);
  const [amountPaid, setAmountPaid] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [banner, setBanner] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [pasteWarnings, setPasteWarnings] = useState<string[]>([]);

  /*
   * One id per draft, minted when the screen mounts and NOT regenerated per attempt.
   * This is what makes a double-tap safe: `create_order` is idempotent on client_ref,
   * so the second submission returns the first order instead of creating a twin.
   */
  const [clientRef] = useState(() => newClientRef());

  const totals = useMemo(
    () => calculateTotals(lines, discount ?? zero(), deliveryCharge ?? zero()),
    [lines, discount, deliveryCharge],
  );

  const due = useMemo(
    () => outstanding(totals.total, amountPaid ?? zero()),
    [totals.total, amountPaid],
  );

  const validation = validateDraft(lines);
  const short = stockWarnings(lines);

  const addProduct = useCallback(
    (product: (typeof products.products)[number]) => {
      setLines((current) =>
        addLineToDraft(current, {
          lineId: newLineId(),
          productId: product.id,
          variantId: null,
          name: product.name,
          sku: product.sku,
          unitPrice: money(product.selling_price),
          // A missing cost stays ZERO and is flagged by `profitIsPartial`, rather than
          // being treated as a real cost of nothing.
          unitCost: product.cost_price === null ? zero() : money(product.cost_price),
          quantity: 1,
          lineDiscount: zero(),
          available: product.quantity,
          trackInventory: product.track_inventory,
        }),
      );
    },
    // The whole picker object, not just `products`: the query returns a new object on
    // every refetch, and depending on the array alone would keep a closure pointing at
    // a stale catalogue.
    [products],
  );

  const setQuantity = (lineId: string, quantity: number | null) => {
    setLines((current) =>
      current.map((line) => (line.lineId === lineId ? { ...line, quantity: quantity ?? 1 } : line)),
    );
  };

  const removeLine = (lineId: string) => {
    setLines((current) => current.filter((line) => line.lineId !== lineId));
  };

  /*
   * Paste a customer's reply.
   *
   * The parser is forgiving about shape and strict about what it claims: anything it
   * could not place comes back in `warnings` and is shown, rather than being dropped
   * or guessed into the order. A parse that silently lost a line would be worse than
   * one that admits it needs a human.
   *
   * This only ever produces a DRAFT. "Saree" matching "Cotton Saree" is a guess
   * priced onto a real customer's order, so an ambiguous product is left for the
   * seller rather than resolved by a similarity score.
   */
  const applyPaste = () => {
    const parsed = parseOrderForm(pasted, products.products.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
    })));

    if (parsed.empty) {
      setPasteWarnings(['Nothing readable in that text.']);
      return;
    }

    const matched = parsed.lines.filter((line) => line.productId !== null);
    const ambiguous = parsed.lines.filter((line) => line.productId === null);

    if (matched.length > 0) {
      setLines((current) =>
        // Merged one at a time so two lines naming the same product add their
        // quantities instead of replacing each other.
        matched.reduce<DraftLine[]>((acc, line) => {
          const product = products.products.find((p) => p.id === line.productId);
          if (!product) return acc;
          return addLineToDraft(acc, {
            lineId: newLineId(),
            productId: product.id,
            variantId: null,
            name: product.name,
            sku: product.sku,
            unitPrice: money(product.selling_price),
            unitCost: product.cost_price === null ? zero() : money(product.cost_price),
            quantity: line.quantity,
            lineDiscount: zero(),
            available: product.quantity,
            trackInventory: product.track_inventory,
          });
        }, current),
      );
    }

    const warnings = [...parsed.warnings];

    if (ambiguous.length > 0) {
      for (const line of ambiguous) {
        warnings.push(
          line.candidates.length > 1
            ? `“${line.name}” could be ${line.candidates.map((c) => c.name).join(' or ')}. Pick one.`
            : `“${line.name}” is not in your catalogue. Add it by hand.`,
        );
      }
    }

    // Address and the customer's own message are carried into notes rather than being
    // silently dropped. A rider cannot be dispatched from an order with no address on
    // it, and the seller would not remember.
    const extra = [parsed.address, parsed.thana, parsed.district, parsed.message]
      .filter(Boolean)
      .join(' · ');
    if (extra) setNotes((current) => (current ? `${current}\n${extra}` : extra));

    if (parsed.name && !customerId) {
      const match = customers.customers.find(
        (c) =>
          (parsed.phone && c.phone === parsed.phone) ||
          c.name.trim().toLowerCase() === (parsed.name ?? '').trim().toLowerCase(),
      );
      if (match) setCustomerId(match.id);
      else warnings.push(`“${parsed.name}” is not a customer yet. Add them below.`);
    }

    setPasteWarnings(warnings);
  };

  const submit = async () => {
    setBanner(null);

    if (!storeId) {
      setBanner('Your store is still loading. Try again in a moment.');
      return;
    }
    if (!validation.valid) {
      setBanner(validation.reason ?? 'This order is not ready to save.');
      return;
    }

    try {
      const orderId = await createOrder.mutateAsync({
        storeId,
        customerId,
        lines,
        discount: toMajor(discount ?? zero()),
        deliveryCharge: toMajor(deliveryCharge ?? zero()),
        amountPaid: toMajor(amountPaid ?? zero()),
        paymentMethod: method,
        notes: notes.trim() || null,
        clientRef,
      });

      router.replace(`/order/${orderId}`);
    } catch (error) {
      setBanner(error instanceof AppError ? error.title : 'Could not save this order. Nothing was changed.');
    }
  };

  const writable = canWrite(role);

  if (!writable) {
    return (
      <Screen testID="order-new" width="form" edges={['top']}>
        <ErrorState
          title="You cannot create orders"
          action="Your role is read-only for sales. Ask an owner or manager to change this."
        />
      </Screen>
    );
  }

  return (
    <Screen
      testID="order-new"
      width="form"
      edges={['top']}
      footer={
        <Button
          label={`Save order · ${formatMoney(totals.total)}`}
          size="lg"
          fullWidth
          loading={createOrder.isPending}
          disabled={!validation.valid}
          onPress={() => void submit()}
          testID="order-save"
        />
      }
    >
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">New order</Text>
          <Text variant="caption" tone="muted">
            Add what the customer is buying, then how they are paying.
          </Text>
        </View>

        {banner ? (
          <Card elevation="flat" style={{ borderColor: colors.dangerBorder }}>
            <View style={{ flexDirection: 'row', gap: spacing.xs, alignItems: 'flex-start' }}>
              <TriangleAlert size={16} color={colors.danger} strokeWidth={1.75} />
              <Text variant="caption" tone="danger" style={{ flex: 1 }} testID="order-error">
                {banner}
              </Text>
            </View>
          </Card>
        ) : null}

        <CustomerPicker
          customerId={customerId}
          onChange={setCustomerId}
        />

        {/*
         * Paste a reply. For a seller working from WhatsApp this is how the order
         * actually arrives, so it is offered on the screen rather than buried.
         */}
        {showPaste ? (
          <Card elevation="flat">
            <View style={{ gap: spacing.sm }}>
              <TextArea
                label="Paste the customer's message"
                value={pasted}
                onChangeText={setPasted}
                placeholder={BLANK_FORM_TEMPLATE}
                testID="order-paste-input"
              />

              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Button
                  label="Fill the order"
                  icon={ClipboardPaste}
                  onPress={applyPaste}
                  disabled={pasted.trim().length === 0}
                  testID="order-paste-apply"
                />
                <Button
                  label="Close"
                  variant="ghost"
                  onPress={() => {
                    setShowPaste(false);
                    setPasted('');
                    setPasteWarnings([]);
                  }}
                />
              </View>

              {pasteWarnings.length > 0 ? (
                <View style={{ gap: spacing.xxs }} testID="order-paste-warnings">
                  {pasteWarnings.map((warning) => (
                    <Text key={warning} variant="caption" tone="warning">
                      {warning}
                    </Text>
                  ))}
                </View>
              ) : (
                <Text variant="caption" tone="muted">
                  Products SellFlow recognises are added. Anything ambiguous is left for you to pick.
                </Text>
              )}
            </View>
          </Card>
        ) : (
          <Button
            label="Paste a customer's message"
            variant="secondary"
            icon={ClipboardPaste}
            fullWidth
            onPress={() => setShowPaste(true)}
            testID="order-paste-open"
          />
        )}

        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Items" />

          {lines.length === 0 ? (
            <Card elevation="flat">
              <Text variant="caption" tone="muted">
                Nothing added yet. Pick a product below.
              </Text>
            </Card>
          ) : (
            <View style={{ gap: spacing.xs }}>
              {lines.map((line) => (
                <Card key={line.lineId} elevation="flat" testID={`order-line-${line.lineId}`}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: spacing.xs,
                    }}
                  >
                    <Text variant="bodyStrong" style={{ flex: 1 }}>
                      {line.name}
                    </Text>
                    <Pressable
                      onPress={() => removeLine(line.lineId)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${line.name}`}
                      testID={`order-line-remove-${line.lineId}`}
                      hitSlop={8}
                    >
                      <Trash2 size={16} color={colors.textMuted} strokeWidth={1.75} />
                    </Pressable>
                  </View>

                  <Text variant="caption" tone="muted">
                    {`${formatMoney(line.unitPrice)} each`}
                    {line.trackInventory
                      ? ` · ${line.available} in stock`
                      : ' · stock not tracked'}
                  </Text>

                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm }}>
                    <View style={{ flex: 1 }}>
                      <NumberInput
                        label="Quantity"
                        value={line.quantity}
                        onChange={(next) => setQuantity(line.lineId, next)}
                        stepper={{ step: 1, min: 1 }}
                        testID={`order-qty-${line.lineId}`}
                      />
                    </View>
                    <Text variant="numeric" style={{ paddingBottom: spacing.sm }}>
                      {formatMoney(lineTotal(line))}
                    </Text>
                  </View>

                  {line.trackInventory && line.quantity > line.available ? (
                    <Badge
                      label={`Only ${line.available} in stock`}
                      tone="warning"
                    />
                  ) : null}
                </Card>
              ))}
            </View>
          )}

          {/*
           * A warning, not a block. `allow_negative_stock` belongs to the business, and
           * the server is where that decision is enforced and reported.
           */}
          {short.length > 0 ? (
            <Card elevation="flat" style={{ borderColor: colors.warningBorder }}>
              <Text variant="caption" tone="warning">
                {short.length === 1
                  ? `You are selling more than the recorded stock of ${short[0]?.name ?? 'a product'}.`
                  : `${short.length} lines are over the recorded stock.`}{' '}
                You can still save this if the count is out of date.
              </Text>
            </Card>
          ) : null}
        </View>

        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Add a product" />

          <SearchBar
            value={products.search}
            onChangeText={products.setSearch}
            placeholder="Search by name or SKU"
            testID="order-product-search"
          />

          {products.isLoading ? (
            <LoadingState label="Loading products" />
          ) : products.products.length === 0 ? (
            <Card elevation="flat">
              <Text variant="caption" tone="muted">
                {products.search
                  ? 'Nothing matches that search.'
                  : 'You have no products yet. Add one first.'}
              </Text>
            </Card>
          ) : (
            <View style={{ gap: spacing.xs }}>
              {products.products.map((product) => (
                <Pressable
                  key={product.id}
                  onPress={() => addProduct(product)}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${product.name}`}
                  testID={`order-add-${product.id}`}
                >
                  {({ pressed }) => (
                    <Card
                      elevation="flat"
                      style={pressed ? { opacity: 0.7 } : undefined}
                    >
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: spacing.xs,
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text variant="bodyStrong">{product.name}</Text>
                          <Text variant="caption" tone="muted">
                            {product.quantity} in stock
                          </Text>
                        </View>
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: spacing.xs,
                          }}
                        >
                          <Text variant="numeric">{formatMoney(product.selling_price)}</Text>
                          <Plus size={16} color={colors.textMuted} strokeWidth={1.75} />
                        </View>
                      </View>
                    </Card>
                  )}
                </Pressable>
              ))}
            </View>
          )}
        </View>

        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Totals" />

          <Card>
            <View style={{ gap: spacing.md }}>
              <MoneyInput
                label="Discount"
                value={discount}
                onChange={setDiscount}
                stepper={{ step: 1000, min: 0 }}
                hint="Across the whole order. Lines are adjusted proportionally."
                testID="order-discount"
              />
              <MoneyInput
                label="Delivery charge"
                value={deliveryCharge}
                onChange={setDeliveryCharge}
                stepper={{ step: 1000, min: 0 }}
                hint="What the customer pays for delivery."
                testID="order-delivery"
              />

              <View style={{ gap: spacing.xxs }}>
                <SummaryLine label="Items" value={formatMoney(totals.itemsTotal)} />
                {totals.discount > 0 ? (
                  <SummaryLine label="Discount" value={`- ${formatMoney(totals.discount)}`} />
                ) : null}
                {totals.deliveryCharge > 0 ? (
                  <SummaryLine label="Delivery" value={formatMoney(totals.deliveryCharge)} />
                ) : null}
                <SummaryLine label="Total" value={formatMoney(totals.total)} emphasis />
              </View>

              {/*
               * Profit is shown only as far as the data supports. A line whose cost
               * was never recorded makes this figure optimistic, so it is labelled
               * rather than presented as the answer.
               */}
              {totals.profitIsPartial ? (
                <Text variant="caption" tone="warning" testID="order-profit-partial">
                  Profit is at least {formatMoney(totals.profit)} — some products have no recorded cost.
                </Text>
              ) : (
                <Text variant="caption" tone="muted">
                  Profit {formatMoney(totals.profit)}
                </Text>
              )}
            </View>
          </Card>
        </View>

        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Payment" />

          <Card>
            <View style={{ gap: spacing.md }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
                {METHODS.map((option) => (
                  <Badge
                    key={option.value}
                    label={option.label}
                    tone={method === option.value ? 'primary' : 'neutral'}
                    onPress={() => setMethod(option.value)}
                    testID={`order-method-${option.value}`}
                  />
                ))}
              </View>

              <MoneyInput
                label="Amount paid now"
                value={amountPaid}
                onChange={setAmountPaid}
                hint={
                  due === 0 && totals.total > 0
                    ? 'Fully paid.'
                    : 'Leave empty if nothing was paid yet. The rest is recorded as due.'
                }
                testID="order-amount-paid"
              />

              {totals.total > 0 && due > 0 ? (
                <Card elevation="flat" style={{ borderColor: colors.warningBorder }}>
                  <Text variant="caption" tone="warning" testID="order-due">
                    {`${formatMoney(due)} is still due on this order.`}
                  </Text>
                </Card>
              ) : null}

              <TextArea
                label="Notes"
                value={notes}
                onChangeText={setNotes}
                placeholder="Anything about this order worth remembering."
                testID="order-notes"
              />
            </View>
          </Card>
        </View>
      </View>
    </Screen>
  );
}

function SummaryLine({
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
        alignItems: 'center',
        justifyContent: 'space-between',
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

/** Customer chooser. Null customer is a real, common thing: a walk-in. */
function CustomerPicker({
  customerId,
  onChange,
}: {
  customerId: string | null;
  onChange: (id: string | null) => void;
}) {
  const { colors, spacing } = useTheme();
  const orgId = useSession((state) => state.organization?.id);
  const picker = useCustomerPicker(orgId);

  const selected = picker.customers.find((c) => c.id === customerId) ?? null;

  return (
    <View style={{ gap: spacing.sm }}>
      <SectionHeader title="Customer" />

      {selected ? (
        <Card elevation="flat" testID="order-customer-selected">
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: spacing.xs,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
              <User size={15} color={colors.textMuted} strokeWidth={1.75} />
              <Text variant="bodyStrong">{selected.name}</Text>
            </View>
            <Pressable onPress={() => onChange(null)} hitSlop={8} accessibilityRole="button">
              <Text variant="caption" tone="primary">
                Change
              </Text>
            </Pressable>
          </View>
        </Card>
      ) : (
        <View style={{ gap: spacing.xs }}>
          <SearchBar
            value={picker.search}
            onChangeText={picker.setSearch}
            placeholder="Search customers, or leave empty for a walk-in"
            testID="order-customer-search"
          />
          {picker.customers.slice(0, 5).map((customer) => (
            <Pressable
              key={customer.id}
              onPress={() => onChange(customer.id)}
              accessibilityRole="button"
              accessibilityLabel={`Use ${customer.name}`}
              testID={`order-customer-${customer.id}`}
            >
              <Card elevation="flat">
                <Text variant="bodyStrong">{customer.name}</Text>
                {customer.phone ? (
                  <Text variant="caption" tone="muted">
                    {customer.phone}
                  </Text>
                ) : null}
              </Card>
            </Pressable>
          ))}
          <Text variant="caption" tone="muted">
            No customer selected — this will be recorded as a walk-in sale.
          </Text>
        </View>
      )}
    </View>
  );
}

/** Stable per-draft id. Reused across retries, which is what makes saving idempotent. */
function newClientRef(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `ord_${Date.now().toString(36)}_${random}`;
}

let lineCounter = 0;
function newLineId(): string {
  lineCounter += 1;
  return `line_${lineCounter}`;
}