/**
 * Add expense.
 *
 * Amount is the only required field. Category defaults to Miscellaneous, and
 * the date defaults to today -- both of which cover the overwhelming majority of
 * entries without the seller touching anything.
 *
 * The submit button lives in `FormScreen`'s footer rather than in an absolutely
 * positioned overlay, so it rises with the keyboard instead of being buried
 * beneath it. See components/FormScreen.tsx for the detail.
 */

import { useState } from 'react';
import { Keyboard, Platform, View } from 'react-native';
import { router } from 'expo-router';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Save } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { FormScreen } from '@/components/FormScreen';
import {
  BottomSheet,
  Button,
  Card,
  Divider,
  Input,
  ListRow,
  SelectField,
  Text,
  TextArea,
} from '@/components/ui';
import { EXPENSE_CATEGORIES, useCreateExpense } from '@/features/expenses/queries';
import type { ExpenseCategory } from '@/lib/database.types';
import { AppError } from '@/lib/errors';
import { toDateString } from '@/lib/format';
import { toMajor, toMinor, type CurrencyCode } from '@/lib/money';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

function symbol(currency: CurrencyCode): string {
  return currency === 'BDT' ? 'Tk' : currency;
}

export default function NewExpenseScreen() {
  const { colors, spacing } = useTheme();
  const organization = useSession((state) => state.organization);
  const store = useSession((state) => state.store);
  const currency = (organization?.currency ?? 'BDT') as CurrencyCode;

  const createExpense = useCreateExpense();

  const [amountText, setAmountText] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('miscellaneous');
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState<Date>(new Date());
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [touched, setTouched] = useState(false);

  const amount = toMinor(amountText, currency);
  const amountError =
    touched && (amount === null || amount <= 0)
      ? 'Enter an amount greater than zero.'
      : undefined;

  const canSave = amount !== null && amount > 0 && !createExpense.isPending;

  async function handleSave() {
    Keyboard.dismiss();
    setTouched(true);

    if (!canSave || !organization || !store) return;

    try {
      await createExpense.mutateAsync({
        orgId: organization.id,
        storeId: store.id,
        input: {
          // `toMajor`, not `money`. `amount` is already minor -- `toMinor` did
          // that when the seller typed it -- and the column stores whole taka.
          // `money()` is the READ path, and using it here multiplied the figure
          // by 100: an expense of 1,500 was stored and shown as 15,000,000.
          amount: toMajor(amount, currency),
          category,
          incurredOn: toDateString(date),
          description: description.trim() || null,
          note: note.trim() || null,
        },
      });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  return (
    <FormScreen
      title="New expense"
      footer={
        <Button
          label="Save expense"
          icon={Save}
          onPress={() => void handleSave()}
          loading={createExpense.isPending}
          disabled={!canSave}
          block
          size="lg"
        />
      }
      sheets={
        <>
          <BottomSheet
            visible={categoryOpen}
            onClose={() => setCategoryOpen(false)}
            title="Category"
          >
            <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
              {EXPENSE_CATEGORIES.map((option, index) => (
                <View key={option.value}>
                  <ListRow
                    title={option.label}
                    chevron={false}
                    selected={option.value === category}
                    last={index === EXPENSE_CATEGORIES.length - 1}
                    onPress={() => {
                      setCategory(option.value);
                      setCategoryOpen(false);
                    }}
                  />
                  {index < EXPENSE_CATEGORIES.length - 1 ? <Divider /> : null}
                </View>
              ))}
            </View>
          </BottomSheet>

          {showDatePicker ? (
            <DateTimePicker
              value={date}
              mode="date"
              maximumDate={new Date()}
              onChange={(event, selected) => {
                // Android closes the picker on selection; iOS keeps the wheel up.
                if (Platform.OS === 'android') setShowDatePicker(false);
                if (event.type === 'set' && selected) setDate(selected);
              }}
            />
          ) : null}
        </>
      }
    >
      <View style={{ gap: spacing.xl }}>
        <Card>
          <View style={{ gap: spacing.md }}>
            <Input
              label="Amount"
              required
              numeric
              value={amountText}
              onChangeText={(text) => {
                setTouched(true);
                setAmountText(text);
              }}
              placeholder="0"
              autoFocus
              trailing={
                <Text variant="caption" tone="muted">
                  {symbol(currency)}
                </Text>
              }
              error={amountError}
              editable={!createExpense.isPending}
            />

            <SelectField
              label="Category"
              value={EXPENSE_CATEGORIES.find((c) => c.value === category)?.label}
              onPress={() => setCategoryOpen(true)}
            />

            <SelectField
              label="Date"
              value={date.toLocaleDateString()}
              onPress={() => setShowDatePicker(true)}
            />
          </View>
        </Card>

        <Card>
          <View style={{ gap: spacing.md }}>
            <Input
              label="Description"
              value={description}
              onChangeText={setDescription}
              placeholder="Facebook ad campaign"
            />
            <TextArea
              label="Note"
              value={note}
              onChangeText={setNote}
              placeholder="Optional details"
            />
          </View>
        </Card>

        {createExpense.isError ? (
          <Card style={{ backgroundColor: colors.dangerSoft, borderColor: colors.danger }}>
            <Text variant="caption" tone="danger">
              {AppError.from(createExpense.error).title}
            </Text>
            <Text variant="micro" tone="secondary" style={{ marginTop: 2 }}>
              {AppError.from(createExpense.error).action}
            </Text>
          </Card>
        ) : null}
      </View>
    </FormScreen>
  );
}
