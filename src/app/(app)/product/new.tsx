/**
 * Product create / edit.
 *
 * One screen for both. Fields are ordered by how often they are needed, and
 * only name is required -- requirement 15 says not to force sellers to fill in
 * things they do not track yet.
 *
 * After creating a product the seller is offered an opening stock figure,
 * because "I added a product" is almost always followed by "I have 12 of these".
 */

import { useMemo, useState } from 'react';
import { Keyboard, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Package, Save, Warehouse } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { FormScreen } from '@/components/FormScreen';
import {
  BottomSheet,
  Button,
  Card,
  Input,
  SectionHeader,
  SelectField,
  Text,
} from '@/components/ui';
import { useAdjustStock } from '@/features/orders/mutations';
import { useCreateProduct, useUpdateProduct } from '@/features/products/mutations';
import { useProduct } from '@/features/products/queries';
import { AppError } from '@/lib/errors';
import {
  EXACT,
  formatMoney,
  parseWholeNumber,
  toMajor,
  toMinor,
  type CurrencyCode,
} from '@/lib/money';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

function symbol(currency: CurrencyCode): string {
  return currency === 'BDT' ? 'Tk' : currency;
}

export default function ProductFormScreen() {
  const { colors, spacing } = useTheme();
  const params = useLocalSearchParams<{ id?: string }>();
  const productId = params.id;
  const isEditing = Boolean(productId);

  const organization = useSession((state) => state.organization);
  const store = useSession((state) => state.store);
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const existing = useProduct(productId);
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const adjustStock = useAdjustStock();

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [category, setCategory] = useState('');
  const [priceText, setPriceText] = useState('');
  const [costText, setCostText] = useState('');
  const [thresholdText, setThresholdText] = useState('0');
  const [trackInventory, setTrackInventory] = useState(true);
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const [pendingStock, setPendingStock] = useState<string | null>(null);
  // Set when a product is created in this session. A new product has no route
  // param yet, but its id is needed to record the opening stock against it.
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Seed the form from server data exactly once, using React's sanctioned
  // "adjust state during render" pattern rather than an effect. An effect would
  // run a second render pass and, worse, could clobber what the seller has
  // already typed if a background refetch lands mid-edit.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const loaded = existing.data;
  if (loaded && !touched && seededFor !== loaded.id) {
    setSeededFor(loaded.id);
    setName(loaded.name);
    setSku(loaded.sku ?? '');
    setCategory(loaded.category ?? '');
    setPriceText(loaded.selling_price ? String(loaded.selling_price) : '');
    setCostText(loaded.cost_price === null ? '' : String(loaded.cost_price));
    setThresholdText(String(loaded.low_stock_threshold));
    setTrackInventory(loaded.track_inventory);
    setNotes(loaded.notes ?? '');
  }

  const price = toMinor(priceText, currency);
  const cost = costText.length > 0 ? toMinor(costText, currency) : null;

  const nameError = touched && !name.trim() ? 'Enter a product name.' : undefined;
  const priceError = touched && (price === null || price < 0) ? 'Enter a price of zero or more.' : undefined;
  const costError =
    touched && costText.length > 0 && (cost === null || cost < 0) ? 'Enter a cost of zero or more.' : undefined;

  const busy = createProduct.isPending || updateProduct.isPending;
  const canSave = name.trim().length > 0 && price !== null && price >= 0 && !busy;

  const margin = useMemo(() => {
    if (price === null || cost === null) return null;
    return {
      absolute: price - cost,
      percent: price === 0 ? null : Math.round(((price - cost) / price) * 100),
    };
  }, [price, cost]);

  async function handleSave() {
    Keyboard.dismiss();
    setTouched(true);

    if (!canSave || !organization) return;

const payload = {
      name: name.trim(),
      sku: sku.trim(),
      category: category.trim(),
      // `toMajor`, not `money`. Both `price` and `cost` are already in minor
      // units -- `toMinor` did that when the seller typed them -- and the column
      // stores whole taka. `money()` is the READ path: calling it here multiplied
      // by the currency decimals a second time, so a product typed at 1,000 was
      // stored at 10,000,000 and every margin derived from it was nonsense.
      sellingPrice: price === null ? 0 : toMajor(price, currency),
      costPrice: cost === null ? null : toMajor(cost, currency),
      // A unit count, NOT money. Reading this through toMinor() multiplied it
      // by 100, so "warn me at 5" was stored as 500 and the warning never fired
      // until stock was nearly gone. parseWholeNumber keeps it a plain integer,
      // and it is right for the two stock fields below too.
      lowStockThreshold: parseWholeNumber(thresholdText),
      trackInventory,
      notes: notes.trim(),
    };

    try {
      if (isEditing && productId) {
        await updateProduct.mutateAsync({ productId, input: payload });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back();
        return;
      }

      const created = await createProduct.mutateAsync({ orgId: organization.id, input: payload });

      if (store && trackInventory && created) {
        // Ask for opening stock inline instead of sending the seller hunting.
        setCreatedId(created.id);
        setPendingStock('0');
      } else {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back();
      }
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  const mutationError = createProduct.error ?? updateProduct.error;

  return (
    <FormScreen
      title={isEditing ? 'Edit product' : 'New product'}
      footer={
        <Button
          label={isEditing ? 'Save changes' : 'Save product'}
          icon={Save}
          onPress={() => void handleSave()}
          loading={busy}
          disabled={!canSave}
          block
          size="lg"
        />
      }
      sheets={
        <StockSheet
          visible={pendingStock !== null}
          currency={currency}
          value={pendingStock ?? ''}
          onChange={setPendingStock}
          saving={adjustStock.isPending}
          error={adjustStock.isError ? AppError.from(adjustStock.error) : null}
          onSkip={() => {
            setPendingStock(null);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            router.back();
          }}
          onSave={async (delta) => {
            const targetId = productId ?? createdId;
            if (!store || !targetId) return;

            try {
              await adjustStock.mutateAsync({
                storeId: store.id,
                productId: targetId,
                variantId: null,
                delta,
                reason: 'initial',
                note: isEditing ? 'Stock adjustment' : 'Opening stock',
              });
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setPendingStock(null);
              router.back();
            } catch {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            }
          }}
        />
      }
    >
        <View style={{ gap: spacing.xl }}>
          <Card>
            <View style={{ gap: spacing.md }}>
              <Input
                label="Product name"
                required
                value={name}
                onChangeText={(text) => {
                  setTouched(true);
                  setName(text);
                }}
                placeholder="Cotton T-Shirt"
                icon={Package}
                error={nameError}
                editable={!busy}
                returnKeyType="next"
              />

              <Input
                label="Selling price"
                required
                numeric
                value={priceText}
                onChangeText={setPriceText}
                placeholder="0"
                trailing={<Text variant="caption" tone="muted">{symbol(currency)}</Text>}
                error={priceError}
                editable={!busy}
              />

              <Input
                label="Cost price"
                numeric
                value={costText}
                onChangeText={setCostText}
                placeholder="Optional"
                trailing={<Text variant="caption" tone="muted">{symbol(currency)}</Text>}
                hint="What you paid. Used to work out profit."
                error={costError}
                editable={!busy}
              />

              {margin ? (
                <View
                  style={{
                    backgroundColor: margin.absolute >= 0 ? colors.successSoft : colors.dangerSoft,
                    padding: spacing.sm,
                    borderRadius: 10,
                  }}
                >
                  <Text variant="caption" tone={margin.absolute >= 0 ? 'success' : 'danger'}>
                    Margin {margin.absolute >= 0 ? '+' : ''}
                    {formatMoney(margin.absolute, currency, EXACT)}
                    {margin.percent !== null ? ` (${margin.percent}%)` : ''}
                  </Text>
                </View>
              ) : null}
            </View>
          </Card>

          <View>
            <SectionHeader title="Inventory" />
            <Card>
              <View style={{ gap: spacing.md }}>
                <SelectField
                  label="Stock tracking"
                  value={trackInventory ? 'Track stock' : 'Do not track'}
                  onPress={() => setTrackInventory((current) => !current)}
                  icon={Warehouse}
                />

                {trackInventory ? (
                  <Input
                    label="Low stock alert at"
                    numeric
                    value={thresholdText}
                    onChangeText={setThresholdText}
                    placeholder="0"
                    hint="You will be warned when stock reaches this level. 0 turns the warning off."
                    editable={!busy}
                  />
                ) : null}

                {isEditing && trackInventory ? (
                  <Button
                    label="Adjust stock"
                    variant="secondary"
                    onPress={() => setPendingStock('0')}
                    block
                  />
                ) : null}
              </View>
            </Card>
          </View>

          <View>
            <SectionHeader title="Details" />
            <Card>
              <View style={{ gap: spacing.md }}>
                <Input
                  label="SKU"
                  value={sku}
                  onChangeText={setSku}
                  placeholder="Optional code"
                  autoCapitalize="characters"
                />
                <Input
                  label="Category"
                  value={category}
                  onChangeText={setCategory}
                  placeholder="Optional"
                />
                <Input
                  label="Notes"
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Optional"
                />
              </View>
            </Card>
          </View>

          {mutationError ? (
            <Card style={{ backgroundColor: colors.dangerSoft, borderColor: colors.danger }}>
              <Text variant="caption" tone="danger">{AppError.from(mutationError).title}</Text>
              <Text variant="micro" tone="secondary" style={{ marginTop: 2 }}>
                {AppError.from(mutationError).action}
              </Text>
            </Card>
          ) : null}
        </View>
    </FormScreen>
  );
}

/**
 * Opening-stock prompt.
 *
 * "Set to" is implemented as a first adjustment only when the caller passes the
 * difference, so the sheet always reports a *delta*. For a brand-new product
 * the two are identical, which is why a single mode is offered here rather than
 * pretending to support both.
 */
function StockSheet({
  visible,
  onChange,
  value,
  onSave,
  onSkip,
  currency,
  saving,
  error,
}: {
  visible: boolean;
  value: string;
  onChange: (value: string) => void;
  onSave: (delta: number) => Promise<void>;
  onSkip: () => void;
  currency: CurrencyCode;
  saving: boolean;
  error: AppError | null;
}) {
  const { spacing } = useTheme();
  // A unit COUNT. Reading this through toMinor() multiplied it by 100, so an
  // opening stock of 20 was recorded as 2,000 units.
  const delta = parseWholeNumber(value);

  return (
    <BottomSheet visible={visible} onClose={onSkip} title="How much stock do you have?">
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md }}>
        <Input
          label="Quantity in stock"
          numeric
          value={value}
          onChangeText={onChange}
          placeholder="0"
          autoFocus
        />

        {error ? (
          <Text variant="micro" tone="danger">
            {error.title}. {error.action}
          </Text>
        ) : null}

        <Button
          label="Save stock"
          onPress={() => void onSave(delta)}
          loading={saving}
          disabled={delta <= 0}
          block
          size="lg"
        />

        <Button label="Skip for now" variant="ghost" onPress={onSkip} block />
      </View>
    </BottomSheet>
  );
}

