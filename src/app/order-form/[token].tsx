/**
 * The customer-facing half of a shared order form.
 *
 * Reached by anyone holding the link, signed in or not, which is why it lives
 * outside the `(app)` group and outside the auth gate in `index.tsx`. A customer
 * ordering from their own phone has no SellFlow account and must not be made to
 * create one.
 *
 * This screen only ever calls `public_order_form` and `submit_order_request`
 * through the anonymous client in `@/features/orderForms/client`. It never reads
 * or writes any table directly: a mistake here would be visible to the whole
 * internet, and the database-side functions are the only place the rules live.
 */

import { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { CircleCheck, Link2Off, Minus, Plus, Send } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { ScreenHeader } from '@/components/ScreenHeader';
import {
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  Input,
  ListRowSkeleton,
  Screen,
  Text,
} from '@/components/ui';
import {
  fetchPublicForm,
  submitPublicRequest,
  type PublicRequestLine,
} from '@/features/orderForms/client';
import { useTheme } from '@/theme/ThemeProvider';

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; store: string | null; products: { name: string; price: number }[] }
  | { phase: 'dead'; error: { title: string; action: string } };

/** A link failure as the customer sees it: never which of the three it was. */
function describe(error: unknown): { title: string; action: string } {
  const appError = error as { title?: string; action?: string };
  return {
    title: appError.title ?? 'This link is not working',
    action: appError.action ?? 'Ask the shop for a new order link.',
  };
}
export default function PublicOrderFormScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { spacing, colors } = useTheme();

  const [state, setState] = useState<State>({ phase: 'loading' });
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [thana, setThana] = useState('');
  const [district, setDistrict] = useState('');
  const [message, setMessage] = useState('');
  const [lines, setLines] = useState<PublicRequestLine[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const retry = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const form = await fetchPublicForm(String(token ?? ''));
      setState({ phase: 'ready', store: form.store_name, products: form.products });
    } catch (error) {
      setState({ phase: 'dead', error: describe(error) });
    }
  }, [token]);

  useEffect(() => {
    // Every setState below sits after an await, so the first paint already has
    // the loading state in place. `cancelled` stops a response from landing on a
    // screen the customer has already left.
    let cancelled = false;

    void (async () => {
      try {
        const form = await fetchPublicForm(String(token ?? ''));
        if (cancelled) return;
        setState({ phase: 'ready', store: form.store_name, products: form.products });
        // Pre-select the first product so the customer sees how adding works,
        // rather than staring at an empty list.
        if (form.products[0]) setLines([{ name: form.products[0].name, quantity: 1 }]);
      } catch (error) {
        if (cancelled) return;
        setState({ phase: 'dead', error: describe(error) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const addProduct = (productName: string) => {
    setLines((current) => {
      const existing = current.find((line) => line.name === productName);
      if (existing) {
        return current.map((line) =>
          line.name === productName ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [...current, { name: productName, quantity: 1 }];
    });
  };

  const setQuantity = (productName: string, quantity: number) => {
    setLines((current) =>
      quantity <= 0
        ? current.filter((line) => line.name !== productName)
        : current.map((line) => (line.name === productName ? { ...line, quantity } : line)),
    );
  };

  const setSize = (productName: string, size: string) => {
    setLines((current) =>
      current.map((line) => (line.name === productName ? { ...line, size } : line)),
    );
  };

  const submit = async () => {
    setSending(true);
    setSendError(null);
    try {
      await submitPublicRequest(String(token ?? ''), {
        name: name.trim(),
        phone: phone.trim() || undefined,
        items: lines.map((line) => ({
          name: line.name,
          quantity: line.quantity,
          size: line.size,
        })),
        address: address.trim() || undefined,
        thana: thana.trim() || undefined,
        district: district.trim() || undefined,
        message: message.trim() || undefined,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSent(true);
    } catch (error) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setSendError((error as { title?: string }).title ?? 'Could not send your order.');
    } finally {
      setSending(false);
    }
  };

  // --- Sent ----------------------------------------------------------------
  if (sent) {
    return (
      <View style={{ flex: 1 }}>
        <ScreenHeader title="Order sent" />
        <Screen scroll={false}>
        <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg }}>
          <EmptyState
            icon={CircleCheck}
            title="Thank you, your order is in"
            description={
              state.phase === 'ready' && state.store
                ? `${state.store} has your request and will confirm it with you.`
                : 'The shop has your request and will confirm it with you.'
            }
          />
        </View>
        </Screen>
      </View>
    );
  }

  // --- Dead link -----------------------------------------------------------
  if (state.phase === 'dead') {
    return (
      <View style={{ flex: 1 }}>
        <ScreenHeader title="Order form" />
        <Screen scroll={false}>
        <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg }}>
          <ErrorState
            title={state.error.title}
            action={state.error.action}
            onRetry={() => void retry()}
          />
        </View>
        </Screen>
      </View>
    );
  }

  // --- Loading -------------------------------------------------------------
  if (state.phase === 'loading') {
    return (
      <View style={{ flex: 1 }}>
        <ScreenHeader title="Order form" />
        <Screen scroll={false}>
        <View style={{ padding: spacing.lg, gap: spacing.sm }}>
          {[0, 1, 2, 3].map((key) => (
            <ListRowSkeleton key={key} />
          ))}
        </View>
        </Screen>
      </View>
    );
  }

  const canSend = name.trim().length > 0 && lines.length > 0 && !sending;

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title={state.store ?? 'Order form'} />
      <Screen scroll={false}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text variant="caption" tone="muted">
          Fill this in and send it to the shop. They will confirm your order and tell you the
          total.
        </Text>

        {/* Who ------------------------------------------------------------- */}
        <View style={{ gap: spacing.sm }}>
          <Text variant="subtitle">Your details</Text>
          <Input
            label="Name"
            value={name}
            onChangeText={setName}
            placeholder="Your full name"
            autoCapitalize="words"
            returnKeyType="next"
          />
          <Input
            label="Phone (optional)"
            value={phone}
            onChangeText={setPhone}
            placeholder="01XXXXXXXXX"
            keyboardType="phone-pad"
          />
        </View>

        {/* What ------------------------------------------------------------ */}
        <View style={{ gap: spacing.sm }}>
          <Text variant="subtitle">What you want</Text>

          {lines.map((line) => (
            <Card key={line.name} style={{ gap: spacing.sm }}>
              <Text variant="subtitle">{line.name}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                <Button
                  label=""
                  icon={Minus}
                  variant="secondary"
                  size="sm"
                  onPress={() => setQuantity(line.name, line.quantity - 1)}
                  accessibilityLabel={`Remove one ${line.name}`}
                />
                <Text variant="title" style={{ minWidth: 36, textAlign: 'center' }}>
                  {line.quantity}
                </Text>
                <Button
                  label=""
                  icon={Plus}
                  variant="secondary"
                  size="sm"
                  onPress={() => setQuantity(line.name, line.quantity + 1)}
                  accessibilityLabel={`Add one ${line.name}`}
                />
              </View>
              <Input
                label="Size (optional)"
                value={line.size ?? ''}
                onChangeText={(text) => setSize(line.name, text)}
                placeholder="e.g. 42"
              />
            </Card>
          ))}

          <Card style={{ gap: spacing.xs }}>
            <Text variant="micro" tone="muted">
              Add something else
            </Text>
            {state.products.length === 0 ? (
              <Text variant="caption" tone="muted">
                This shop has not listed any products yet. Write what you need in the note
                below.
              </Text>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: spacing.xs, paddingVertical: spacing.xxs }}
              >
                {state.products.map((product) => (
                  <Button
                    key={product.name}
                    label={product.name}
                    variant="secondary"
                    size="sm"
                    onPress={() => addProduct(product.name)}
                  />
                ))}
              </ScrollView>
            )}
          </Card>
        </View>

        {/* Where ----------------------------------------------------------- */}
        <View style={{ gap: spacing.sm }}>
          <Text variant="subtitle">Where to deliver</Text>
          <Input
            label="Address"
            value={address}
            onChangeText={setAddress}
            placeholder="House, road, area"
            multiline
            minHeight={72}
          />
          <Input label="Thana" value={thana} onChangeText={setThana} placeholder="Dhanmondi" />
          <Input label="Jela" value={district} onChangeText={setDistrict} placeholder="Dhaka" />
        </View>

        {/* Anything else ---------------------------------------------------- */}
        <View style={{ gap: spacing.sm }}>
          <Text variant="subtitle">Anything else?</Text>
          <Input
            label="Your message"
            value={message}
            onChangeText={setMessage}
            placeholder="Call before delivery"
            multiline
            minHeight={72}
          />
        </View>

        {sendError ? (
          <Text variant="caption" tone="danger">
            {sendError}
          </Text>
        ) : null}

        <Divider />

        <Button
          label={sending ? 'Sending' : 'Send my order'}
          icon={Send}
          size="lg"
          block
          loading={sending}
          disabled={!canSend}
          onPress={() => void submit()}
        />

        {!name.trim() ? (
          <Text variant="micro" tone="muted" style={{ textAlign: 'center' }}>
            Add your name so the shop knows who the order is for.
          </Text>
        ) : lines.length === 0 ? (
          <Text variant="micro" tone="muted" style={{ textAlign: 'center' }}>
            Pick at least one product.
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: spacing.xs, justifyContent: 'center' }}>
          <Link2Off size={12} color={colors.textMuted} />
          <Text variant="micro" tone="muted">
            Only the shop can see this.
          </Text>
        </View>
      </ScrollView>
      </Screen>
    </View>
  );
}
