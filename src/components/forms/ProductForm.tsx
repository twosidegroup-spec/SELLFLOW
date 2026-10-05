/**
 * Product form, used for both creating and editing.
 *
 * One component for both because the field set is identical and the difference is a
 * single mutation plus an id in the route. Two near-identical forms would drift.
 *
 * VALIDATION, and what it refuses
 *
 * Selling price is required and must be positive. Cost price is OPTIONAL, and that
 * matters more than it looks: a seller who does not know what an item cost to make
 * can still sell it, and the app then says profit is "not recorded" rather than
 * reporting zero. Forcing a cost would push people to invent one, and an invented
 * cost produces a fake profit figure, which is the one number in this product that
 * must never be wrong.
 *
 * TENANT SCOPE
 *
 * The org id comes from the session and is passed to the mutation. Nothing on this
import { useState } from 'react';
 * link can file a product into another seller's business. RLS then enforces it
 * server-side regardless.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Button, Card, Input, MoneyInput, NumberInput, Screen, Text, TextArea } from '@/components/ui';
import {
  useCreateProduct,
  useUpdateProduct,
  type ProductInput,
} from '@/features/products/mutations';
import { money, toMajor, zero } from '@/lib/money';
import type { Money } from '@/lib/money';
import { AppError } from '@/lib/errors';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export interface ProductFormProps {
  /** Present when editing. Absent when creating. */
  productId?: string;
  /**
   * Seeded values, used only when editing.
   *
   * Money is passed in DATABASE UNITS (whole taka), not the minor units the form
   * edits. A route that had to convert would be handling the read path, and the
   * read path has a different helper from the write path -- see src/lib/money.ts.
   * Keeping both directions inside this one component means the conversion happens
   * exactly twice, in the two places that own it, and no route can get it backwards.
   */
  initial?: {
    name: string;
    sku: string | null;
    category: string | null;
    /** Whole taka, as stored in numeric(14,2). */
    sellingPrice: number;
    /** Whole taka, or null when the cost was never recorded. */
    costPrice: number | null;
    lowStockThreshold: number;
    trackInventory: boolean;
    notes: string | null;
    isArchived?: boolean;
  };
  /** Returning here after a successful save, e.g. "new and add another". */
  onSaved?: () => void;
}

/**
 * Stock levels are integer columns in Postgres. A threshold past this is not a
 * plausible shop, and is more likely a mistyped figure than a real warning level.
 */
const MAX_STOCK_THRESHOLD = 1_000_000;

type Errors = Partial<Record<'name' | 'sellingPrice' | 'costPrice' | 'sku' | 'threshold', string>>;

export function ProductForm({ productId, initial, onSaved }: ProductFormProps) {
  const router = useRouter();
  const { spacing } = useTheme();

  const orgId = useSession((state) => state.organization?.id);

  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();

  const [name, setName] = useState(initial?.name ?? '');
  const [sku, setSku] = useState(initial?.sku ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  // Database whole taka -> form minor units. The read-path helper, used on the read path.
  const [sellingPrice, setSellingPrice] = useState<Money | null>(
    initial ? money(initial.sellingPrice) : null,
  );
  const [costPrice, setCostPrice] = useState<Money | null>(
    // null stays null. Converting it to zero would claim the item is free to make.
    initial?.costPrice === null || initial?.costPrice === undefined ? null : money(initial.costPrice),
  );
  /*
   * A count of units, stored as a plain integer. It was briefly a Money, which meant
   * a threshold of 5 was parsed as 500 -- the ? and two decimal places had nothing
   * to do with it.
   */
  const [threshold, setThreshold] = useState<number | null>(initial?.lowStockThreshold ?? 0);
  const [notes, setNotes] = useState(initial?.notes ?? '');
const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<string | null>(null);
  /*
   * The "Saved" confirmation, derived rather than pushed by an effect.
   *
   * An earlier version set `saved: true` in an effect watching every field, which is
   * a synchronous setState on mount and cascades an extra render before anything
   * paints. Storing only the FLAG and deriving the rest removes the effect: the
   * notice shows when a save has happened AND nothing has been edited since, so it
   * disappears the instant a field changes -- which is what the effect was emulating.
   */
  const [justSaved, setJustSaved] = useState(false);
  const dirty = name !== '' || sellingPrice !== null || sku !== '' || costPrice !== null;
  const saved = justSaved && !dirty;

  const validate = (): boolean => {
    const next: Errors = {};

    if (!name.trim()) next.name = 'Give the product a name.';
    else if (name.trim().length > 120) next.name = 'That name is too long.';

    if (sellingPrice === null) next.sellingPrice = 'Enter a selling price.';
    else if (sellingPrice <= zero()) next.sellingPrice = 'The selling price must be more than zero.';

    // Optional, but if given it must be a real number. A negative cost would make
    // profit larger than revenue, which is not a thing that can happen.
    if (costPrice !== null && costPrice < zero()) {
      next.costPrice = 'A cost cannot be negative.';
    }

    // A count, never money. parseWholeNumber has already clamped it to >= 0, so the
    // only real failure here is a threshold past what any stock level could reach.
    if (threshold !== null && threshold > MAX_STOCK_THRESHOLD) {
      next.threshold = `That is more units than a shop could hold. Use a number below ${MAX_STOCK_THRESHOLD}.`;
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const save = async (andAddAnother: boolean) => {
    setBanner(null);
    if (!validate()) return;

    const input: ProductInput = {
      name: name.trim(),
      sku: sku.trim() || null,
      category: category.trim() || null,
      // Validation already refused a null selling price; the fallback is unreachable
      // in practice and exists only so the type is total.
      sellingPrice: sellingPrice === null ? 0 : toMajor(sellingPrice),
      // `null`, not 0. Zero would claim the item is free to make.
      costPrice: costPrice === null ? null : toMajor(costPrice),
      lowStockThreshold: threshold === null ? 0 : threshold,
      trackInventory: initial?.trackInventory ?? true,
      notes: notes.trim() || null,
    };

    try {
      if (productId) {
        await updateProduct.mutateAsync({ productId, input });
      } else {
        if (!orgId) throw new AppError('No business', 'Your business is still loading. Try again.');
        await createProduct.mutateAsync({ orgId, input });
      }

setJustSaved(true);

      if (andAddAnother) {
        // Keep the category: a seller adding a range does not want to retype it
        // per item, and it is the field most likely to be identical.
        setName('');
        setSku('');
        setSellingPrice(null);
        setCostPrice(null);
        setNotes('');
        setErrors({});
        return;
      }

      onSaved?.();
      router.back();
    } catch (error) {
      setBanner(error instanceof AppError ? error.title : 'Could not save the product.');
    }
  };

  const busy = createProduct.isPending || updateProduct.isPending;

  return (
    <Screen
      testID="product-form"
      width="form"
      edges={['top']}
      footer={
        <View style={{ gap: spacing.xs }}>
          <Button
            label={productId ? 'Save changes' : 'Save product'}
            size="lg"
            fullWidth
            loading={busy}
            onPress={() => void save(false)}
            testID="product-save"
          />
          {/*
           * "Save and add another" only makes sense when creating. On an edit there
           * is no list in front of the seller to add to.
           */}
          {productId ? null : (
            <Button
              label="Save and add another"
              variant="ghost"
              fullWidth
              disabled={busy}
              onPress={() => void save(true)}
              testID="product-save-another"
            />
          )}
        </View>
      }
    >
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">{productId ? 'Edit product' : 'New product'}</Text>
          <Text variant="caption" tone="muted">
            {productId
              ? 'Changes take effect for future orders. Past orders keep the price they were sold at.'
              : 'You can leave the cost price empty if you do not know it yet.'}
          </Text>
        </View>

        {banner ? (
          <Card elevation="flat">
            <Text variant="caption" tone="danger" testID="product-error">
              {banner}
            </Text>
          </Card>
        ) : null}

        {saved ? (
          <Card elevation="flat">
            <Text variant="caption" tone="success" testID="product-saved">
              Saved.
            </Text>
          </Card>
        ) : null}

        <Card>
          <View style={{ gap: spacing.md }}>
            <Input
              label="Product name"
              required
              value={name}
              onChangeText={setName}
              error={errors.name}
              placeholder="Black cargo pant"
              testID="product-name"
            />

            <Input
              label="SKU or reference"
              value={sku}
              onChangeText={setSku}
              error={errors.sku}
              hint="Optional. Your own code for this item."
              autoCapitalize="characters"
              placeholder="BCP-001"
              testID="product-sku"
            />

            <Input
              label="Category"
              value={category}
              onChangeText={setCategory}
              hint="Optional. Helps you group a large catalogue."
              placeholder="Pants"
              testID="product-category"
            />

            <MoneyInput
              label="Selling price"
              required
              value={sellingPrice}
              onChange={setSellingPrice}
              error={errors.sellingPrice}
              testID="product-selling-price"
            />

            {/*
             * Optional, and deliberately phrased so a seller who does not know this
             * does not feel obliged to guess.
             */}
            <MoneyInput
              label="Cost price"
              value={costPrice}
              onChange={setCostPrice}
              error={errors.costPrice}
              hint="What one unit costs you. Leave empty if you do not know — SellFlow will say profit is not recorded rather than report a wrong number."
              testID="product-cost-price"
            />

            <NumberInput
              label="Low stock alert at"
              value={threshold}
              onChange={setThreshold}
              error={errors.threshold}
              hint="In units. SellFlow warns you when a tracked product's stock falls this low."
              stepper={{ step: 1, min: 0 }}
              testID="product-threshold"
            />

            <TextArea
              label="Notes"
              value={notes}
              onChangeText={setNotes}
              placeholder="Anything worth remembering about this item."
              testID="product-notes"
            />
          </View>
        </Card>
      </View>
    </Screen>
  );
}
