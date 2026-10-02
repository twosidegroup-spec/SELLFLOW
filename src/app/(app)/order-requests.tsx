/**
 * Requests that arrived through a shared order link.
 *
 * The seller's end of the customer form. A submission cannot become an order on
 * its own -- the price and stock the customer saw may be hours old, and an order
 * decrements stock and books revenue -- so every request waits here until the
 * seller opens it.
 *
 * Accepting does NOT create the order. It opens the normal order screen with the
 * request already filled in, so the live price and the stock floor are applied
 * exactly as they are for an order typed by hand. That reuse is the whole point:
 * a second way to create orders would be a second set of money rules, and the
 * last thing this codebase needs.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { ClipboardCheck, Inbox, Link2, Plus } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

import { ScreenHeader } from '@/components/ScreenHeader';
import {
  Badge,
  BottomSheet,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  Input,
  ListRowSkeleton,
  Screen,
  SectionHeader,
  Text,
} from '@/components/ui';
import {
  orderFormUrl,
  useCreateOrderForm,
  useDecideOrderRequest,
  useOrderRequests,
} from '@/features/orderForms/client';
import { useSession } from '@/store/session';
import type { OrderRequestRow } from '@/lib/database.types';
import { formatRelativeDay } from '@/lib/format';
import { AppError } from '@/lib/errors';
import { useTheme } from '@/theme/ThemeProvider';

export default function OrderRequestsScreen() {
  const { spacing, colors } = useTheme();
  const store = useSession((state) => state.store);
  const canWrite = useSession((state) => state.role) !== 'staff';

  const requests = useOrderRequests(store?.id);
  const createForm = useCreateOrderForm();
  const decide = useDecideOrderRequest();

  const [linkSheetOpen, setLinkSheetOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const rows = requests.data ?? [];
  const waiting = rows.filter((row) => row.status === 'new');

  const makeLink = async () => {
    if (!store) return;
    try {
      const result = await createForm.mutateAsync({
        storeId: store.id,
        label: label.trim() || 'Customer order form',
        days: 14,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCreated({ url: orderFormUrl(result.token), expiresAt: result.expiresAt });
      setLabel('');
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Customer orders" subtitle="Requests from your order links" />

      <Screen>
        {requests.isLoading ? (
          <View style={{ gap: spacing.sm }}>
            {[0, 1, 2].map((key) => (
              <ListRowSkeleton key={key} />
            ))}
          </View>
        ) : requests.isError ? (
          <ErrorState
            title="Could not load requests"
            action="Check your connection and try again."
            onRetry={() => void requests.refetch()}
          />
        ) : (
          <>
            <Card style={{ gap: spacing.sm }}>
              <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
                <Link2 size={18} />
                <Text variant="subtitle" style={{ flex: 1 }}>
                  Send customers a link
                </Text>
              </View>
              <Text variant="micro" tone="muted">
                They fill in their own order on their phone. Nothing is charged and no stock is
                used until you accept it.
              </Text>
              {canWrite ? (
                <Button
                  label="Create an order link"
                  icon={Plus}
                  variant="secondary"
                  block
                  onPress={() => {
                    setCreated(null);
                    setLinkSheetOpen(true);
                  }}
                />
              ) : null}
            </Card>

            <View style={{ marginTop: spacing.xl }}>
              <SectionHeader title={`Waiting for you (${waiting.length})`} />
            </View>

            {rows.length === 0 ? (
              <Card>
                <EmptyState
                  icon={Inbox}
                  title="No requests yet"
                  description="When a customer fills one of your links, it will appear here."
                  compact
                />
              </Card>
            ) : (
              <View style={{ gap: spacing.sm }}>
                {rows.map((request) => (
                  <RequestCard
                    key={request.id}
                    request={request}
                    canWrite={canWrite}
                    busy={decide.isPending}
                    onAccept={() =>
                      router.push({
                        pathname: '/order/new',
                        params: { request: request.id },
                      })
                    }
                    onDecline={() =>
                      void decide
                        .mutateAsync({ requestId: request.id, status: 'declined' })
                        .catch(() =>
                          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
                        )
                    }
                  />
                ))}
              </View>
            )}

            <Text variant="micro" tone="muted" style={{ marginTop: spacing.lg }}>
              Links are one-time copies. If you lose one, create another.
            </Text>
          </>
        )}
      </Screen>

      {/* Create a link ------------------------------------------------------- */}
      <BottomSheet
        visible={linkSheetOpen}
        onClose={() => setLinkSheetOpen(false)}
        title="Customer order link"
      >
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md }}>
          {created ? (
            <>
              <Text variant="caption">
                Send this link to your customer. It works for 14 days and then stops.
              </Text>
              <View
                style={{
                  padding: spacing.sm,
                  borderRadius: 10,
                  backgroundColor: colors.surfaceSunken,
                }}
              >
                <Text variant="body" selectable style={{ color: colors.text }}>
                  {created.url}
                </Text>
              </View>
              <Button
                label={copied ? 'Copied' : 'Copy link'}
                icon={Link2}
                block
                onPress={async () => {
                  await Clipboard.setStringAsync(created.url);
                  setCopied(true);
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  setTimeout(() => setCopied(false), 2000);
                }}
              />
              <Text variant="micro" tone="muted">
                The link is stored as a hash, so nobody can read it back out of the database. Keep
                this copy.
              </Text>
              <Button
                label="Done"
                variant="secondary"
                block
                onPress={() => {
                  setLinkSheetOpen(false);
                  setCreated(null);
                }}
              />
            </>
          ) : (
            <>
              <Input
                label="Name this link (optional)"
                value={label}
                onChangeText={setLabel}
                placeholder="WhatsApp link"
              />
              <Text variant="micro" tone="muted">
                Expires in 14 days. You can create a new one any time.
              </Text>
              {createForm.isError ? (
                <Text variant="micro" tone="danger">
                  {AppError.from(createForm.error).title}. {AppError.from(createForm.error).action}
                </Text>
              ) : null}
              <Button
                label="Create link"
                block
                size="lg"
                loading={createForm.isPending}
                onPress={() => void makeLink()}
              />
            </>
          )}
        </View>
      </BottomSheet>
    </View>
  );
}

function RequestCard({
  request,
  canWrite,
  busy,
  onAccept,
  onDecline,
}: {
  request: OrderRequestRow;
  canWrite: boolean;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const { spacing } = useTheme();
  const items = request.items ?? [];

  return (
    <Card style={{ gap: spacing.sm }}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="subtitle">{request.customer_name}</Text>
          <Text variant="micro" tone="muted">
            {[request.customer_phone, formatRelativeDay(request.created_at)]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        {request.status === 'new' ? (
          <Badge tone="warning" label="New" />
        ) : request.status === 'accepted' ? (
          <Badge tone="success" label="Accepted" />
        ) : (
          <Badge tone="neutral" label="Declined" />
        )}
      </View>

      <Divider />

      <View style={{ gap: spacing.xs }}>
        {items.map((item, index) => (
          <Text key={`${item.name}-${index}`} variant="body">
            {item.quantity} × {item.name}
            {item.size ? ` · size ${item.size}` : ''}
          </Text>
        ))}
      </View>

      {request.address || request.thana || request.district ? (
        <Text variant="micro" tone="muted">
          {[request.address, request.thana, request.district].filter(Boolean).join(', ')}
        </Text>
      ) : null}

      {request.message ? (
        <Text variant="micro" tone="muted">
          “{request.message}”
        </Text>
      ) : null}

      {request.status === 'new' && canWrite ? (
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xxs }}>
          <Button
            label="Not now"
            variant="secondary"
            size="sm"
            disabled={busy}
            onPress={onDecline}
            style={{ flex: 1 }}
          />
          <Button
            label="Review order"
            icon={ClipboardCheck}
            size="sm"
            disabled={busy}
            onPress={onAccept}
            style={{ flex: 1 }}
          />
        </View>
      ) : null}

      {request.status === 'new' && !canWrite ? (
        <Text variant="micro" tone="muted">
          Ask an owner or manager to review this one.
        </Text>
      ) : null}
    </Card>
  );
}
