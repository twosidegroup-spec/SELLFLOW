/**
 * Payments hub.
 *
 * One screen answering four questions a seller has about money:
 *
 *   where does money arrive      connected receiving accounts
 *   is detection actually on     the real state of the listener, not the permission
 *   what needs me               payments the engine would not attach on its own
 *   what has happened           recent activity
 *
 * THE DETECTION CARD IS THE POINT OF THIS SCREEN
 *
 * It is fed by `deriveDetectionStatus`, which builds its answer from facts the app can
 * prove: an OS permission result, whether the receiver is actually registered, whether
 * there is an account to receive into, the local queue, and the engine's own verdict.
 *
 * It never says "active" because a permission was granted. A build where the plugin did
 * not run reports `receiver_unavailable` and this card says automation is not active,
 * because it is not. `needs_review` and `confirmed` come from the engine's status column,
 * which the app cannot write.
 *
 * COD is shown as money OWED, never as received, and is kept out of the received total.
 */

import { useRouter } from 'expo-router';
import { CreditCard, Plus, Receipt } from 'lucide-react-native';
import { View } from 'react-native';

import { Badge, Button, Card, Screen, SectionHeader, Text } from '@/components/ui';
import { PaymentEventStatusBadge } from '@/components/payments/PaymentBadges';
import {
  providerLabel,
    usePaymentAccounts,
  usePaymentActivity,
  usePaymentReview,
} from '@/features/payments/queries';
import { usePaymentHealth } from '@/features/payments/intelligence';
import { detectionCopy } from '@/features/payments/sms/status';
import { useSmsDetectionStatus } from '@/features/payments/sms/hooks';
import { formatMajorUnits } from '@/lib/money';
import { canWrite, useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function PaymentsScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();

  const orgId = useSession((state) => state.organization?.id);
  const role = useSession((state) => state.role);

  const accounts = usePaymentAccounts(orgId);
  const review = usePaymentReview(orgId);
  const activity = usePaymentActivity(orgId);
  const detection = useSmsDetectionStatus(orgId);
  const health = usePaymentHealth(orgId, accounts);

  const editable = canWrite(role);
  const copy = detectionCopy(detection.status);

  return (
    <Screen testID="payments-screen" width="form" edges={['top']}>
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xxs }}>
          <Text variant="title">Payments</Text>
          <Text variant="caption" tone="muted">
            SellFlow works with the accounts you already use. No merchant account needed.
          </Text>
        </View>

        {/* -------------------------------------------------------- detection */}
        <Card
          testID="payments-detection"
          style={{ borderColor: toneBorder(colors, copy.tone) }}
        >
          <View style={{ gap: spacing.sm }}>
            <Text variant="micro" tone="muted">
              AUTOMATIC DETECTION
            </Text>
            <Text variant="heading" tone={copyTone(copy.tone)} testID="payments-detection-title">
              {copy.title}
            </Text>
            <Text variant="caption" tone="muted">
              {copy.body}
            </Text>

            {/*
             * The facts behind the claim. A seller who is told detection is on has a
             * right to know which of the four things it depends on is actually true.
             */}
            <View style={{ gap: spacing.xxs }}>
              <FactRow
                label="Message permission"
                value={
                  detection.native?.permission === 'granted'
                    ? 'Granted'
                    : detection.native?.permission === 'denied'
                      ? 'Refused'
                      : detection.native?.permission === 'not_determined'
                        ? 'Not asked yet'
                        : 'Not supported here'
                }
              />
              <FactRow
                label="Listener registered"
                value={detection.native?.receiverActive ? 'Yes' : 'No'}
              />
              <FactRow label="Accounts connected" value={String(accounts.active.length)} />
              {health.duplicateCount > 0 ? (
                <FactRow label="Already counted, not double-counted" value={String(health.duplicateCount)} />
              ) : null}
              <FactRow
                label="Waiting to be sent"
                value={String(detection.snapshot.pending.length)}
              />
            </View>

            {accounts.active.length === 0 && editable ? (
              <Button
                label="Connect an account"
                variant="secondary"
                fullWidth
                icon={Plus}
                onPress={() => router.push('/payment-account/new')}
                testID="payments-connect"
              />
            ) : null}
          </View>
        </Card>

        {/* --------------------------------------------------------- review */}
        {review.count > 0 ? (
          <Card style={{ borderColor: colors.warningBorder }} testID="payments-review-card">
            <View style={{ gap: spacing.sm }}>
              <Text variant="heading">{`${review.count} payment${review.count === 1 ? '' : 's'} need checking`}</Text>
              <Text variant="caption" tone="muted">
                Money arrived that SellFlow would not attach to an order on its own. Nothing
                has been applied.
              </Text>
              <Button
                label="Review them"
                fullWidth
                onPress={() => router.push('/payment-review')}
                testID="payments-review-open"
              />
            </View>
          </Card>
        ) : null}

        {/* ------------------------------------------------------- accounts */}
        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Receiving accounts" />

          {accounts.isLoading ? (
            <Text variant="caption" tone="muted">
              Loading…
            </Text>
          ) : accounts.accounts.length === 0 ? (
            <Card elevation="flat">
              <Text variant="caption" tone="muted" testID="payments-no-accounts">
                None connected yet. Add the bKash, Nagad, Rocket or Upay number your
                customers pay into.
              </Text>
            </Card>
          ) : (
            <View style={{ gap: spacing.xs }}>
              {accounts.accounts.map((account) => (
                <Card key={account.id} elevation="flat">
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: spacing.xs,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
                      <CreditCard size={15} color={colors.textMuted} strokeWidth={1.75} />
                      <Text variant="bodyStrong">{providerLabel(account.provider)}</Text>
                      {account.label ? (
                        <Text variant="caption" tone="muted">
                          {account.label}
                        </Text>
                      ) : null}
                    </View>
                    {/*
                     * Only a `connected` account can receive a match. Saying "connected"
                     * for a pending or errored one would be a claim the engine disagrees
                     * with.
                     */}
                    <Badge
                      label={account.status === 'connected' ? 'Connected' : account.status}
                      tone={account.status === 'connected' ? 'success' : 'warning'}
                    />
                  </View>
                  <Text variant="caption" tone="muted">
                    {account.account_number}
                  </Text>
                </Card>
              ))}

              {editable ? (
                <Button
                  label="Connect another account"
                  variant="secondary"
                  fullWidth
                  onPress={() => router.push('/payment-account/new')}
                  testID="payments-add-account"
                />
              ) : null}
            </View>
          )}
        </View>

        {/* ------------------------------------------------------- activity */}
        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Recent payments" />

          {activity.isLoading ? (
            <Text variant="caption" tone="muted">
              Loading…
            </Text>
          ) : (activity.events ?? []).length === 0 ? (
            <Card elevation="flat">
              <Text variant="caption" tone="muted" testID="payments-no-activity">
                No payments detected or recorded yet.
              </Text>
            </Card>
          ) : (
            <View style={{ gap: spacing.xs }}>
              {(activity.events ?? []).slice(0, 8).map((event) => (
                <Card key={event.id} elevation="flat">
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: spacing.xs,
                    }}
                  >
                    <Text variant="bodyStrong">{formatMajorUnits(event.amount)}</Text>
                    <PaymentEventStatusBadge status={event.status} />
                  </View>
                  <Text variant="caption" tone="muted">
                    {`${providerLabel(event.provider)} · ${event.orders?.order_number ?? 'no order'} · ${new Date(event.detected_at).toLocaleDateString()}`}
                  </Text>
                </Card>
              ))}
            </View>
          )}
        </View>

        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="Record one by hand" />
          <Card elevation="flat">
            <View style={{ gap: spacing.sm }}>
              <Text variant="caption" tone="muted">
                Open an order and use “Record a payment” there. Manual entry works whether
                or not automatic detection is on.
              </Text>
              <Button
                label="Go to orders"
                variant="secondary"
                icon={Receipt}
                onPress={() => router.push('/orders')}
                testID="payments-go-orders"
              />
            </View>
          </Card>
        </View>
      </View>
    </Screen>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  const { spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.xs }}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="caption">{value}</Text>
    </View>
  );
}

/** Only `connected` accounts can be matched against, so only that is success. */
function copyTone(tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger') {
  if (tone === 'danger') return 'danger' as const;
  if (tone === 'warning') return 'warning' as const;
  if (tone === 'success') return 'success' as const;
  if (tone === 'info') return 'primary' as const;
  return 'default' as const;
}

function toneBorder(
  colors: { warningBorder: string; dangerBorder: string; border: string },
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger',
) {
  if (tone === 'danger') return colors.dangerBorder;
  if (tone === 'warning') return colors.warningBorder;
  return colors.border;
}