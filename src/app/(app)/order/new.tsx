/**
 * Create order.
 *
 * Designed as a single fast mobile workflow (requirement 13) rather than a
 * multi-screen wizard. Everything the seller needs is on one scrollable page:
 * customer, items, delivery, discount, payment and notes, with a live summary
 * pinned above the keyboard that always shows what the customer will pay.
 *
 * The draft lives in this component and is submitted in one call to
 * `create_order`, which is transactional on the server. Nothing is optimistically
 * inserted -- a failed save shows the error and keeps the draft intact, because
 * requirement 33 says never pretend an operation succeeded.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertCircle, Minus, Plus, Search, Trash2, UserPlus, Wand2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { ScreenHeader } from '@/components/ScreenHeader';
import {
  Amount,
  BottomSheet,
  Button,
  Card,
  Divider,
  EmptyState,
  Input,
  ListRow,
  ListRowSkeleton,
  SearchBar,
  SectionHeader,
  SelectField,
  Text,
  TextArea,
} from '@/components/ui';
import { newOrderRef, useCreateOrder } from '@/features/orders/mutations';
import { useCustomerPicker, useCustomers } from '@/features/customers/queries';
import { useProductPicker, useProducts } from '@/features/products/queries';
import {
  PasteOrderSheet,
  toPastedDraft,
  type PastedDraft,
} from '@/features/orders/PasteOrderSheet';
import { parseOrderForm, requestToFormText } from '@/features/orders/orderForm';
import { fetchOrderRequest } from '@/features/orderForms/client';
import type { CustomerRow, PaymentMethod } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
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
import {
  addLineToDraft,
  calculateTotals,
  stockWarnings,
  validateDraft,
  type DraftLine,
} from '@/features/orders/calculations';

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'bkash', label: 'bKash' },
  { value: 'nagad', label: 'Nagad' },
  { value: 'rocket', label: 'Rocket' },
  { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'other', label: 'Other' },
];

export default function NewOrderScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const store = useSession((state) => state.store);
  const organization = useSession((state) => state.organization);
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const createOrder = useCreateOrder();

  // --- Draft state ----------------------------------------------------------
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [discountText, setDiscountText] = useState('');
  const [deliveryText, setDeliveryText] = useState('');
  const [paidText, setPaidText] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [notes, setNotes] = useState('');
  const [placedOn, setPlacedOn] = useState<Date>(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Stable across retries so a failed save can never create a duplicate.
  const [clientRef] = useState(() => newOrderRef());

  // --- Sheets ---------------------------------------------------------------
  const [productSheetOpen, setProductSheetOpen] = useState(false);
  const [customerSheetOpen, setCustomerSheetOpen] = useState(false);
  const [methodSheetOpen, setMethodSheetOpen] = useState(false);
  const [pasteSheetOpen, setPasteSheetOpen] = useState(false);

  // The whole catalogue, not the picker's search results: a pasted order names
  // arbitrary products, so matching needs to see everything the seller sells.
  const customerList = useCustomers(organization?.id).customers;
  const catalogue = useProducts(store?.id);
  const catalogueForMatching = useMemo(
    () =>
      catalogue.products.map((product) => ({
        id: product.id,
        name: product.name,
        sku: product.sku,
      })),
    [catalogue.products],
  );

  /**
   * Turns parsed customer text into draft lines.
   *
   * Every price comes from the catalogue row, never from what the customer typed.
   * A line priced by customer text would be exactly the kind of half-trusted
   * figure the unit bug came from: right most of the time, wrong by 100x when it
   * is not.
   */
  const applyDraft = useCallback(
    (draft: PastedDraft) => {
      const byId = new Map(catalogue.products.map((product) => [product.id, product]));

      setLines((current) => {
        let next = current;
        for (const pasted of draft.lines) {
          const product = byId.get(pasted.productId);
          if (!product) continue;
          next = addLineToDraft(next, {
            lineId: `${product.id}-${Date.now()}-${pasted.quantity}`,
            productId: product.id,
            variantId: null,
            name: product.name,
            sku: product.sku,
            unitPrice: money(product.selling_price, currency),
            unitCost: money(product.cost_price, currency),
            quantity: pasted.quantity,
            lineDiscount: 0,
            available: product.quantity,
            trackInventory: product.track_inventory,
          });
        }
        return next;
      });

      // A phone number is how the seller recognises a returning customer. Match
      // an existing one on it; never create a customer out of a paste, because a
      // mistyped number would quietly split one person's history in two.
      let matchedCustomer = false;
      if (draft.phone && !customer) {
        const wanted = draft.phone.replace(/\D/g, '').replace(/^88/, '');
        const existing = customerList.find(
          (entry) => entry.phone?.replace(/\D/g, '').replace(/^88/, '') === wanted,
        );
        if (existing) {
          setCustomer(existing);
          matchedCustomer = true;
        }
      }

      // The notes carry everything the customer wrote that did not land in a
      // structured field. Their NAME goes here too when no matching customer
      // record was found, because otherwise a walk-in order silently discards
      // the one thing the customer told us -- and the seller cannot tell that
      // the name was ever captured.
      const header: string[] = [];
      if (!matchedCustomer && draft.name) header.push(`Customer: ${draft.name}`);
      if (!matchedCustomer && draft.phone) header.push(`Phone: ${draft.phone}`);

      const notes = [header.join('\n'), draft.notes].filter(Boolean).join('\n');
      if (notes) {
        setNotes((current) => (current ? `${current}\n${notes}` : notes));
      }
    },
    [catalogue.products, currency, customer, customerList],
  );

  const params = useLocalSearchParams<{ request?: string }>();
  const requestId = params.request;

  // One application per request. Without this the effect would re-run whenever
  // the catalogue refetches and append a second copy of every line.
  const appliedRequest = useRef<string | null>(null);

  useEffect(() => {
    if (!requestId) return;
    // Wait for the catalogue: matching product names needs it, and running
    // against an empty list would silently mark every line "not found".
    if (catalogue.products.length === 0) return;
    if (appliedRequest.current === requestId) return;

    let cancelled = false;

    void (async () => {
      const request = await fetchOrderRequest(requestId);
      if (cancelled || !request) return;
      if (appliedRequest.current === requestId) return;
      appliedRequest.current = requestId;

      // Round-tripped through the same template and parser as a pasted reply, so
      // a link submission and a WhatsApp message are handled identically.
      const parsed = parseOrderForm(requestToFormText(request), catalogueForMatching);
      applyDraft(toPastedDraft(parsed));
    })();

    return () => {
      cancelled = true;
    };
  }, [requestId, catalogue.products, catalogueForMatching, applyDraft]);

  // --- Derived --------------------------------------------------------------
  // Held in MINOR units while the seller types, because `toMinor` keeps the
  // text exact. `create_order` computes against the product's own whole-unit
  // prices, so these three are converted back with `toMajor` at the call below.
  // Sending them as minor added the currency decimals a second time: a
  // delivery charge of 80 became 8,000 and the order total came out at 10,450
  // instead of 2,530.
  const discount = toMinor(discountText, currency) ?? 0;
  const delivery = toMinor(deliveryText, currency) ?? 0;
  const paid = toMinor(paidText, currency) ?? 0;

  const totals = useMemo(
    () => calculateTotals(lines, discount, delivery),
    [lines, discount, delivery],
  );

  const validation = validateDraft(lines);
  const warnings = stockWarnings(lines);
  const outstanding = Math.max(0, totals.total - paid);

  const canSubmit = validation.valid && !createOrder.isPending;

  const handleSubmit = useCallback(async () => {
    Keyboard.dismiss();

    if (!store) return;
    if (!validation.valid) return;

    try {
      const orderId = await createOrder.mutateAsync({
        storeId: store.id,
        customerId: customer?.id ?? null,
        lines,
        // Whole taka, because the server's items_total is built from the
        // product's own selling_price, which is a whole-unit column value.
        discount: toMajor(totals.discount, currency),
        deliveryCharge: toMajor(totals.deliveryCharge, currency),
        // Over-payment is rejected by the server; clamp here so the button
        // state and the preview agree.
        amountPaid: toMajor(Math.min(paid, totals.total), currency),
        paymentMethod,
        notes: notes.trim() || null,
        clientRef,
      });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // `replace` so Back from the order does not return to a stale draft.
      router.replace(`/(app)/order/${orderId}`);
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // The draft is intentionally preserved so the seller can retry.
    }
  }, [
    store,
    validation.valid,
    createOrder,
    customer,
    lines,
    totals.discount,
    totals.deliveryCharge,
    totals.total,
    paid,
    paymentMethod,
    notes,
    clientRef,
    currency,
  ]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="New order" subtitle={store?.name} />

      {/*
        The keyboard wrapper is what keeps the live summary reachable.
        Without it the summary bar sat at the bottom of the viewport and the
        keyboard covered "Create order" as soon as a low field took focus.
        Android resizes the window (adjustResize is the Expo default), so the
        behaviour is only needed on iOS; enabling it on both is a well known
        source of double-compensated layouts.
      */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.xl,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
        >
          {/* Customer ------------------------------------------------------ */}
          <SectionHeader title="Customer" />
          <Card>
            {customer ? (
              <View style={styles.customerRow}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="subtitle">{customer.name}</Text>
                  {customer.phone ? (
                    <Text variant="caption" tone="muted">{customer.phone}</Text>
                  ) : null}
                </View>
                <Button
                  label="Change"
                  variant="secondary"
                  size="sm"
                  onPress={() => setCustomerSheetOpen(true)}
                />
              </View>
            ) : (
              <Button
                label="Select customer"
                icon={UserPlus}
                variant="secondary"
                onPress={() => setCustomerSheetOpen(true)}
                block
              />
            )}
            <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs }}>
              Optional. Leave empty for a walk-in sale.
            </Text>
          </Card>

          {/* Paste a form the customer already filled in ---------------------- */}
          <View style={{ marginTop: spacing.md }}>
            <Button
              label="Paste customer order"
              icon={Wand2}
              variant="secondary"
              block
              onPress={() => setPasteSheetOpen(true)}
            />
            <Text variant="micro" tone="muted" style={{ marginTop: spacing.xs }}>
              Sent your customer a form and they filled it in? Paste their reply and the
              details land here.
            </Text>
          </View>

          {/* Items --------------------------------------------------------- */}
          <View style={{ marginTop: spacing.xl }}>
            <SectionHeader title="Items" />
          </View>

          {lines.length === 0 ? (
            <Card>
              <EmptyState
                icon={Search}
                title="No items yet"
                description="Search your products and tap to add them to this order."
                compact
                actionLabel="Add products"
                onActionPress={() => setProductSheetOpen(true)}
              />
            </Card>
          ) : (
            <View style={{ gap: spacing.xs }}>
              {lines.map((line) => (
                <LineRow
                  key={line.lineId}
                  line={line}
                  currency={currency}
                  onChangeQuantity={(quantity) =>
                    setLines((current) =>
                      current.map((candidate) =>
                        candidate.lineId === line.lineId ? { ...candidate, quantity } : candidate,
                      ),
                    )
                  }
                  onRemove={() =>
                    setLines((current) => current.filter((c) => c.lineId !== line.lineId))
                  }
                />
              ))}

              <Button
                label="Add another product"
                icon={Plus}
                variant="secondary"
                onPress={() => setProductSheetOpen(true)}
                block
              />
            </View>
          )}

          {/* Adjustments ---------------------------------------------------- */}
          <View style={{ marginTop: spacing.xl }}>
            <SectionHeader title="Adjustments" />
          </View>

          <Card>
            <View style={{ gap: spacing.md }}>
              <Input
                label="Order discount"
                numeric
                value={discountText}
                onChangeText={setDiscountText}
                placeholder="0"
                trailing={<Text variant="caption" tone="muted">{currency === 'BDT' ? 'Tk' : currency}</Text>}
                hint={
                  discount > totals.itemsTotal
                    ? 'This is more than the item total, so it will be capped.'
                    : undefined
                }
              />

              <Input
                label="Delivery charge"
                numeric
                value={deliveryText}
                onChangeText={setDeliveryText}
                placeholder="0"
                trailing={<Text variant="caption" tone="muted">{currency === 'BDT' ? 'Tk' : currency}</Text>}
              />

              <SelectField
                label="Order date"
                value={placedOn.toLocaleDateString()}
                onPress={() => setShowDatePicker(true)}
              />

              <TextArea
                label="Notes"
                value={notes}
                onChangeText={setNotes}
                placeholder="Delivery address, instructions, anything to remember"
              />
            </View>
          </Card>

          {/* Payment -------------------------------------------------------- */}
          <View style={{ marginTop: spacing.xl }}>
            <SectionHeader title="Payment" />
          </View>

          <Card>
            <View style={{ gap: spacing.md }}>
              <SelectField
                label="Method"
                value={PAYMENT_METHODS.find((m) => m.value === paymentMethod)?.label}
                onPress={() => setMethodSheetOpen(true)}
              />

              <Input
                label="Paid now"
                numeric
                value={paidText}
                onChangeText={setPaidText}
                placeholder={formatForInput(totals.total, currency) || '0'}
                trailing={<Text variant="caption" tone="muted">{currency === 'BDT' ? 'Tk' : currency}</Text>}
                hint={
                  outstanding > 0
                    ? `${formatMoney(outstanding, currency, EXACT)} will remain outstanding.`
                    : 'Fully paid.'
                }
              />
            </View>
          </Card>

          {/* Warnings ------------------------------------------------------- */}
          {warnings.length > 0 ? (
            <Card
              style={{
                marginTop: spacing.lg,
                backgroundColor: colors.warningSoft,
                borderColor: colors.warning,
                gap: spacing.xs,
              }}
            >
              <View style={styles.warnRow}>
                <AlertCircle size={18} color={colors.warning} strokeWidth={2} />
                <Text variant="caption" tone="warning" style={{ flex: 1 }}>
                  {warnings.length === 1
                    ? `${warnings[0]!.name} only has ${warnings[0]!.available} in stock`
                    : `${warnings.length} products do not have enough stock`}
                </Text>
              </View>
              <Text variant="micro" tone="secondary">
                The order will be blocked unless your business allows negative stock.
              </Text>
            </Card>
          ) : null}

          {createOrder.isError ? (
            <Card
              style={{
                marginTop: spacing.lg,
                backgroundColor: colors.dangerSoft,
                borderColor: colors.danger,
                gap: 2,
              }}
            >
              <Text variant="caption" tone="danger">
                {AppError.from(createOrder.error).title}
              </Text>
              <Text variant="micro" tone="secondary">
                {AppError.from(createOrder.error).action}
              </Text>
            </Card>
          ) : null}
        </ScrollView>

        {/* Live summary + submit ------------------------------------------- */}
        <View
          style={[
            styles.summaryBar,
            {
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
              paddingBottom: insets.bottom + spacing.sm,
              paddingHorizontal: spacing.lg,
              paddingTop: spacing.sm,
            },
          ]}
        >
          <View style={styles.summaryRow}>
            <View style={{ flex: 1 }}>
              <Text variant="micro" tone="muted">
                {totals.unitCount} {totals.unitCount === 1 ? 'item' : 'items'}
                {outstanding > 0 ? ` · ${formatMoney(outstanding, currency, EXACT)} due` : ''}
              </Text>
              <Amount value={totals.total} currency={currency} size="lg" />
            </View>

            <Button
              label={validation.valid ? 'Create order' : 'Add items'}
              onPress={() => void handleSubmit()}
              loading={createOrder.isPending}
              disabled={!canSubmit}
              size="lg"
              style={{ minWidth: 150 }}
            />
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* Sheets ------------------------------------------------------------- */}
      <PasteOrderSheet
        visible={pasteSheetOpen}
        onClose={() => setPasteSheetOpen(false)}
        products={catalogueForMatching}
        onApply={applyDraft}
      />

      <ProductSheet
        visible={productSheetOpen}
        onClose={() => setProductSheetOpen(false)}
        currency={currency}
        onSelect={(line) => {
          setLines((current) => addLineToDraft(current, line));
          setProductSheetOpen(false);
        }}
      />

      <CustomerSheet
        visible={customerSheetOpen}
        onClose={() => setCustomerSheetOpen(false)}
        onSelect={(selected) => {
          setCustomer(selected);
          setCustomerSheetOpen(false);
        }}
        onCreateNew={() => {
          setCustomerSheetOpen(false);
          router.push('/(app)/customer/new');
        }}
      />

      <BottomSheet
        visible={methodSheetOpen}
        onClose={() => setMethodSheetOpen(false)}
        title="Payment method"
      >
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
          {PAYMENT_METHODS.map((method, index) => {
            const selected = method.value === paymentMethod;
            return (
              <View key={method.value}>
                <ListRow
                  title={method.label}
                  onPress={() => {
                    setPaymentMethod(method.value);
                    setMethodSheetOpen(false);
                  }}
                  chevron={false}
                  selected={selected}
                  last={index === PAYMENT_METHODS.length - 1}
                />
                {index < PAYMENT_METHODS.length - 1 ? <Divider /> : null}
              </View>
            );
          })}
        </View>
      </BottomSheet>

      {showDatePicker ? (
        <DateTimePicker
          value={placedOn}
          mode="date"
          maximumDate={new Date()}
          onChange={(event, selected) => {
            // Android dismisses immediately; iOS keeps the wheel open.
            if (Platform.OS === 'android') setShowDatePicker(false);
            if (event.type === 'set' && selected) setPlacedOn(selected);
          }}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Line row
// ---------------------------------------------------------------------------

function LineRow({
  line,
  currency,
  onChangeQuantity,
  onRemove,
}: {
  line: DraftLine;
  currency: CurrencyCode;
  onChangeQuantity: (quantity: number) => void;
  onRemove: () => void;
}) {
  const { colors, spacing, radius, touchTarget } = useTheme();
  const lineValue = line.unitPrice * line.quantity - line.lineDiscount;

  return (
    <Card style={{ padding: spacing.sm, borderRadius: radius.card }}>
      <View style={styles.lineTop}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="subtitle" numberOfLines={1}>{line.name}</Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {formatMoney(line.unitPrice, currency, EXACT)} each
            {line.trackInventory && line.available > 0 ? ` · ${line.available} in stock` : ''}
          </Text>
        </View>

        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <Amount value={lineValue} currency={currency} />
        </View>
      </View>

      <View style={[styles.lineBottom, { marginTop: spacing.sm }]}>
        <View style={[styles.stepper, { backgroundColor: colors.surfaceSunken, borderRadius: radius.control }]}>
          <Pressable
            onPress={() => onChangeQuantity(Math.max(1, line.quantity - 1))}
            disabled={line.quantity <= 1}
            accessibilityRole="button"
            accessibilityLabel={`Decrease quantity of ${line.name}`}
            hitSlop={8}
            style={({ pressed }) => [
              styles.stepperButton,
              { opacity: pressed || line.quantity <= 1 ? 0.5 : 1 },
            ]}
          >
            <Minus size={16} color={colors.text} strokeWidth={2} />
          </Pressable>

          <Text variant="numeric" style={{ minWidth: 32, textAlign: 'center' }}>
            {line.quantity}
          </Text>

          <Pressable
            onPress={() => onChangeQuantity(line.quantity + 1)}
            accessibilityRole="button"
            accessibilityLabel={`Increase quantity of ${line.name}`}
            hitSlop={8}
            style={({ pressed }) => [styles.stepperButton, { opacity: pressed ? 0.5 : 1 }]}
          >
            <Plus size={16} color={colors.text} strokeWidth={2} />
          </Pressable>
        </View>

        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${line.name}`}
          hitSlop={8}
          style={({ pressed }) => [
            styles.removeButton,
            { minWidth: touchTarget.min, minHeight: touchTarget.min, opacity: pressed ? 0.5 : 1 },
          ]}
        >
          <Trash2 size={18} color={colors.danger} strokeWidth={2} />
        </Pressable>
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Product picker
// ---------------------------------------------------------------------------

function ProductSheet({
  visible,
  onClose,
  onSelect,
  currency,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (line: DraftLine) => void;
  currency: CurrencyCode;
}) {
  const { spacing } = useTheme();
  const picker = useProductPicker(useSession.getState().store?.id);

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Add products">
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm }}>
        <SearchBar
          value={picker.search}
          onChangeText={picker.setSearch}
          placeholder="Search by name or SKU"
          autoFocus
        />
      </View>

      <ScrollView
        style={{ maxHeight: 420 }}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}
        keyboardShouldPersistTaps="handled"
      >
        {picker.isLoading ? (
          <View style={{ paddingVertical: spacing.lg, gap: spacing.xs }}>
            {[0, 1, 2, 3].map((key) => (
              <ListRowSkeleton key={key} />
            ))}
          </View>
        ) : picker.products.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No products found"
            description={
              picker.search
                ? `Nothing matches "${picker.search}".`
                : 'Add a product before creating an order.'
            }
            compact
          />
        ) : (
          picker.products.map((product, index) => {
            const outOfStock = product.track_inventory && product.quantity <= 0;

            return (
              <View key={product.id}>
                <ListRow
                  title={product.name}
                  subtitle={
                    product.sku
                      ? `${product.sku}${outOfStock ? ' · out of stock' : ''}`
                      : outOfStock
                        ? 'Out of stock'
                        : undefined
                  }
                  trailing={formatMoney(money(product.selling_price, currency), currency, EXACT)}
                  trailingTone={outOfStock ? 'danger' : 'primary'}
                  chevron={false}
                  last={index === picker.products.length - 1}
                  onPress={
                    outOfStock
                      ? undefined
                      : () =>
                          onSelect({
                            lineId: `${product.id}-${Date.now()}`,
                            productId: product.id,
                            variantId: null,
                            name: product.name,
                            sku: product.sku,
                            unitPrice: money(product.selling_price, currency),
                            unitCost: money(product.cost_price, currency),
                            quantity: 1,
                            lineDiscount: 0,
                            available: product.quantity,
                            trackInventory: product.track_inventory,
                          })
                  }
                />
                {index < picker.products.length - 1 ? <Divider /> : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </BottomSheet>
  );
}

// ---------------------------------------------------------------------------
// Customer picker
// ---------------------------------------------------------------------------

function CustomerSheet({
  visible,
  onClose,
  onSelect,
  onCreateNew,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (customer: CustomerRow) => void;
  onCreateNew: () => void;
}) {
  const { spacing } = useTheme();
  const picker = useCustomerPicker(useSession.getState().organization?.id);

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Select customer">
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm }}>
        <SearchBar
          value={picker.search}
          onChangeText={picker.setSearch}
          placeholder="Search name or phone"
          autoFocus
        />
      </View>

      <ScrollView
        style={{ maxHeight: 380 }}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}
        keyboardShouldPersistTaps="handled"
      >
        {picker.customers.length === 0 ? (
          <View style={{ gap: spacing.md, paddingVertical: spacing.sm }}>
            <EmptyState
              icon={UserPlus}
              title={picker.search ? 'No match' : 'No customers yet'}
              description={
                picker.search
                  ? `Nothing matches "${picker.search}".`
                  : 'Add a customer to keep track of their orders and spending.'
              }
              compact
            />
            <Button label="Create customer" icon={UserPlus} onPress={onCreateNew} block />
          </View>
        ) : (
          <>
            {picker.customers.map((customer, index) => (
              <View key={customer.id}>
                <ListRow
                  title={customer.name}
                  subtitle={customer.phone ?? undefined}
                  onPress={() => onSelect(customer)}
                  last={index === picker.customers.length - 1}
                />
                {index < picker.customers.length - 1 ? <Divider /> : null}
              </View>
            ))}
            <Button
              label="Create customer"
              icon={UserPlus}
              variant="secondary"
              onPress={onCreateNew}
              block
              style={{ marginTop: spacing.md }}
            />
          </>
        )}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  lineTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  lineBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepperButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  warnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
