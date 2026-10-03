/**
 * Automatic payment detection.
 *
 * One screen that tells the seller the truth about the native SMS listener:
 * whether it is running, which accounts it is listening for, what it has queued,
 * and what the engine did with what it detected.
 *
 * Four deliberate choices.
 *
 * **The permission is explained here, in plain words, before it is requested.** The
 * Android dialog says "allow SellFlow to receive SMS" and explains nothing. A
 * permission a seller does not understand is one they will refuse, and then
 * automatic detection silently never works. Consent is not bundled into sign-up,
 * and is asked for only here, only on Android, only when this screen is opened.
 *
 * **Nothing here claims a payment succeeded.** Every status comes from
 * `payment_events.status`, which only the engine writes. The app cannot set that
 * column -- the types say `Insert: never` and migration 0024 revokes the grant --
 * so "Confirmed" is the engine's word and not the device's.
 *
 * **Denial is a supported state, not a dead end.** The screen says what still
 * works, including manual entry through the same `record_payment` boundary as
 * before, and shows no fake "connected" state.
 *
 * **No message content appears anywhere.** Not in the status, not in the queue, not
 * in the diagnostics panel. A seller sees a payment service, an amount and a
 * transaction reference, which is exactly what the payment engine received.
 */

import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  CheckCircle2,
  Info,
  Lock,
  ShieldCheck,
  Smartphone,
  Trash2,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react-native';

import { ScreenHeader } from '@/components/ScreenHeader';
import {
  Badge,
  Button,
  Card,
  DetailRow,
  Divider,
  EmptyState,
  ListRow,
  RowIcon,
  Screen,
  SectionHeader,
  Text,
  TextArea,
  confirm,
} from '@/components/ui';
import {
  providerIcon,
  providerLabel,
  usePaymentAccounts,
} from '@/features/payments/queries';
import { requestSmsPermission, useSmsDetectionStatus } from '@/features/payments/sms/hooks';
import { detectionCopy, type DetectionStatus } from '@/features/payments/sms/status';
import {
  rejectionCopy,
  runDiagnostics,
  type DiagnosticsOutcome,
} from '@/features/payments/sms/diagnostics';
import { failureCopy } from '@/features/payments/sms/failures';
import { readQueue, writeQueue } from '@/features/payments/sms/queue';
import { formatDateTime, maskPhone } from '@/lib/format';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';
import type { SmsSendFailure } from '@/features/payments/sms/types';

export default function PaymentSmsScreen() {
  const { colors, spacing } = useTheme();
  const organization = useSession((state) => state.organization);
  const orgId = organization?.id;

  const accounts = usePaymentAccounts(orgId);
  const detection = useSmsDetectionStatus(orgId);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void detection.refresh();
      void accounts.refetch();
      // `detection` and `accounts` return stable objects across renders, so
      // depending on them would re-run this on every query refetch.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const status = detection.status;
  const queued = detection.snapshot.pending;
  const failed = detection.snapshot.failed;
  const permissionGranted = detection.native?.permission === 'granted';

  async function askForPermission() {
    setAsking(true);
    setNotice(null);
    try {
      const result = await requestSmsPermission();
      await detection.refresh();
      setNotice(
        result === 'granted'
          ? 'Permission granted. Automatic detection is on.'
          : 'No problem. Nothing else changes — you can record every payment by hand, exactly as before.',
      );
    } finally {
      setAsking(false);
    }
  }

  async function retryNow(clientRef: string) {
    setBusyRef(clientRef);
    try {
      // Marks the event due. The app-level listener owns the Supabase client and
      // the account list, and performs the send; this screen only flips the state
      // and refreshes, so there is exactly one code path that can talk to the
      // engine.
      await writeQueue(
        (await readQueue()).map((event) =>
          event.clientRef === clientRef
            ? { ...event, state: 'pending' as const, attempts: 0, nextAttemptAt: 0, lastError: null }
            : event,
        ),
      );
      await detection.refresh();
    } finally {
      setBusyRef(null);
    }
  }

  async function dismissEvent(clientRef: string) {
    const ok = await confirm({
      title: 'Remove this payment?',
      message:
        'It will not be sent. Record the payment by hand on the order so the money is still counted.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setBusyRef(clientRef);
    try {
      await writeQueue((await readQueue()).filter((event) => event.clientRef !== clientRef));
      await detection.refresh();
    } finally {
      setBusyRef(null);
    }
  }

  const rows = [...queued, ...failed];

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Automatic detection" subtitle={organization?.name} />

      <Screen onRefresh={() => void detection.refresh()}>
        <View style={{ gap: spacing.xl, paddingTop: spacing.sm }}>
          {/* ------------------------------------------------------ Status */}
          <View>
            <SectionHeader title="Status" />
            <Card>
              <StatusHeadline status={status} />

              <View style={{ marginTop: spacing.md }}>
                <DetailRow
                  label="Device listener"
                  value={
                    detection.native === null
                      ? 'Not available'
                      : detection.native.receiverActive
                        ? 'Active'
                        : 'Not active'
                  }
                />
                <DetailRow label="Connected accounts" value={String(accounts.active.length)} />
                <DetailRow label="Waiting to send" value={String(queued.length)} />
                <DetailRow
                  label="Last detected"
                  value={
                    detection.snapshot.lastDetectedAt
                      ? formatDateTime(detection.snapshot.lastDetectedAt)
                      : 'Nothing yet'
                  }
                />
              </View>

              {detection.lastFailure ? (
                <Text variant="micro" tone="muted" style={{ marginTop: spacing.sm }}>
                  {failureCopy(detection.lastFailure as SmsSendFailure)}
                </Text>
              ) : null}
            </Card>
          </View>

          {/* ------------------------------------------------- Permission */}
          {!permissionGranted ? (
            <View>
              <SectionHeader title="Message permission" />
              <Card>
                <View style={{ gap: spacing.md }}>
                  <View style={[styles.row, { gap: spacing.md }]}>
                    <ShieldCheck size={20} color={colors.primary} />
                    <Text variant="subtitle">Why SellFlow asks for this</Text>
                  </View>

                  <Text variant="body" tone="secondary">
                    SellFlow uses the relevant payment notification SMS to automatically detect
                    customer payments and reconcile them with your orders.
                  </Text>

                  <Text variant="micro" tone="muted">
                    It reads only bKash, Nagad, Rocket and Upay payment messages. It does not open
                    your messages, does not read one-time passcodes, and never keeps the text of a
                    message — only the payment service, amount, transaction reference and the phone
                    numbers involved.
                  </Text>

                  <Divider />

                  <Text variant="micro" tone="muted">
                    If you say no, nothing else changes. You can still record every payment by hand
                    from an order, and orders, stock and finance behave exactly the same.
                  </Text>

                  <Button
                    label="Allow payment messages"
                    block
                    loading={asking}
                    onPress={() => void askForPermission()}
                  />
                </View>
              </Card>
            </View>
          ) : null}

          {notice ? (
            <Card>
              <View style={[styles.row, { gap: spacing.md }]}>
                <Info size={18} color={colors.primary} />
                <Text variant="micro" tone="secondary" style={{ flex: 1 }}>
                  {notice}
                </Text>
              </View>
            </Card>
          ) : null}

          {/* --------------------------------------------------- Accounts */}
          <View>
            <SectionHeader title="What it listens for" />
            {accounts.active.length === 0 ? (
              <Card>
                <EmptyState
                  icon={Smartphone}
                  title="No account connected"
                  description="Automatic detection only recognises money arriving at a bKash, Nagad, Rocket or Upay number you have connected."
                  compact
                  actionLabel="Connect an account"
                  onActionPress={() => router.push('/(app)/payment-account/new')}
                />
              </Card>
            ) : (
              <Card style={{ paddingVertical: 0 }}>
                {accounts.active.map((account, index) => {
                  const Icon = providerIcon(account.provider);
                  return (
                    <ListRow
                      key={account.id}
                      title={account.label ?? providerLabel(account.provider)}
                      subtitle={`${providerLabel(account.provider)} · ${maskPhone(account.account_number)}`}
                      leading={
                        <RowIcon tone="info">
                          <Icon size={18} color={colors.primary} />
                        </RowIcon>
                      }
                      chevron={false}
                      trailing="Listening"
                      trailingTone="success"
                      last={index === accounts.active.length - 1}
                    />
                  );
                })}
              </Card>
            )}
          </View>

          {/* ------------------------------------------------------ Queue */}
          {rows.length > 0 ? (
            <View>
              <SectionHeader title="Waiting to send" />
              <Card flush>
                {rows.map((event, index) => (
                  <View key={event.clientRef}>
                    <View
                      style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: 4 }}
                    >
                      <View style={[styles.row, { gap: spacing.sm, flexWrap: 'wrap' }]}>
                        <Text variant="body">
                          {providerLabel(event.candidate.provider)} ·{' '}
                          {event.candidate.amount.toLocaleString('en-US')} BDT
                        </Text>
                        <Badge
                          label={event.state === 'failed' ? 'Needs attention' : 'Queued'}
                          tone={event.state === 'failed' ? 'danger' : 'warning'}
                        />
                      </View>

                      <Text variant="micro" tone="muted">
                        {event.candidate.transactionId} · detected{' '}
                        {formatDateTime(event.detectedAt)}
                        {event.attempts > 0
                          ? ` · ${event.attempts} attempt${event.attempts === 1 ? '' : 's'}`
                          : ''}
                      </Text>

                      {event.lastError ? (
                        <Text variant="micro" tone="danger">
                          {failureCopy(event.lastError)}
                        </Text>
                      ) : null}

                      {event.state === 'failed' ? (
                        <View style={[styles.actions, { gap: spacing.sm, marginTop: spacing.sm }]}>
                          <Button
                            label="Try again"
                            size="sm"
                            variant="secondary"
                            loading={busyRef === event.clientRef}
                            onPress={() => void retryNow(event.clientRef)}
                          />
                          <Button
                            label="Remove"
                            size="sm"
                            variant="ghost"
                            icon={Trash2}
                            onPress={() => void dismissEvent(event.clientRef)}
                          />
                        </View>
                      ) : null}
                    </View>
                    {index < rows.length - 1 ? <Divider /> : null}
                  </View>
                ))}
              </Card>
            </View>
          ) : null}

          {queued.length > 0 ? (
            <Card>
              <View style={[styles.row, { gap: spacing.md }]}>
                <WifiOff size={18} color={colors.textMuted} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="caption">Queued on this phone</Text>
                  <Text variant="micro" tone="muted">
                    These were read on the phone and are stored as structured payment fields, not as
                    message text. They are sent automatically when a connection is available.
                  </Text>
                </View>
              </View>
            </Card>
          ) : null}

          {/* --------------------------------------------- Privacy summary */}
          <View>
            <SectionHeader title="What is read, and what is not" />
            <Card>
              <View style={{ gap: spacing.sm }}>
                <PrivacyRow
                  ok
                  body="Payment notifications from bKash, Nagad, Rocket and Upay."
                />
                <PrivacyRow ok={false} body="Your message inbox, or any message from anyone else." />
                <PrivacyRow ok={false} body="One-time passcodes and security codes." />
                <PrivacyRow ok={false} body="Contacts, call history or other notifications." />
                <PrivacyRow ok={false} body="The text of any message — stored or sent." />
              </View>
            </Card>
          </View>

          {__DEV__ ? <DiagnosticsPanel /> : null}
        </View>
      </Screen>
    </View>
  );
}

/**
 * The status line.
 *
 * Rendered as a card rather than a banner because it carries a sentence of
 * explanation, and because "warning" is not one of the banner's three kinds: an
 * amber state here means "your attention would help", which is not the same as an
 * error and should not be coloured like one.
 */
function StatusHeadline({ status }: { status: DetectionStatus }) {
  const { colors, spacing } = useTheme();
  const copy = detectionCopy(status);

  const tone = {
    neutral: { fg: colors.textSecondary, bg: colors.surfaceSunken },
    info: { fg: colors.primary, bg: colors.primarySoft },
    success: { fg: colors.successStrong, bg: colors.successSoft },
    warning: { fg: colors.warningStrong, bg: colors.warningSoft },
    danger: { fg: colors.danger, bg: colors.dangerSoft },
  }[copy.tone];

  const Icon: LucideIcon =
    copy.tone === 'success'
      ? CheckCircle2
      : copy.tone === 'danger'
        ? TriangleAlert
        : copy.tone === 'warning'
          ? Lock
          : Info;

  return (
    <View
      style={[
        styles.row,
        {
          gap: spacing.md,
          backgroundColor: tone.bg,
          borderRadius: 12,
          padding: spacing.md,
        },
      ]}
    >
      <Icon size={20} color={tone.fg} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="subtitle" style={{ color: tone.fg }}>
          {copy.title}
        </Text>
        <Text variant="micro" tone="secondary">
          {copy.body}
        </Text>
      </View>
    </View>
  );
}

function PrivacyRow({ ok, body }: { ok: boolean; body: string }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing.sm }]}>
      {ok ? (
        <CheckCircle2 size={15} color={colors.successStrong} />
      ) : (
        <Lock size={15} color={colors.textMuted} />
      )}
      <Text variant="micro" tone={ok ? 'secondary' : 'muted'} style={{ flex: 1 }}>
        {ok ? 'Reads: ' : 'Never reads: '}
        {body}
      </Text>
    </View>
  );
}

/**
 * Development-only parser check.
 *
 * The provider notification texts are not publicly documented, so the fixtures in
 * `modules/sellflow-sms/fixtures` are representative rather than captured, and a
 * representative fixture cannot tell you whether a real message parses. Pasting a
 * real captured message here is how that gap gets closed -- see
 * `docs/device-qa-checklist.md`.
 *
 * The text is never stored or transmitted: it is one argument to the real native
 * parser, and only the resulting candidate or refusal reason is rendered. This is
 * not a route to a payment event; the output has no path to
 * `ingest_payment_event`.
 */
function DiagnosticsPanel() {
  const { colors, spacing } = useTheme();
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<DiagnosticsOutcome>(null);
  const [busy, setBusy] = useState(false);

  return (
    <View>
      <SectionHeader title="Parser check (development only)" />
      <Card>
        <View style={{ gap: spacing.md }}>
          <Text variant="micro" tone="muted">
            Paste a real payment message to see what the parser makes of it. Nothing is saved and
            nothing is sent anywhere.
          </Text>

          <TextArea
            value={text}
            onChangeText={setText}
            placeholder="Paste a bKash / Nagad / Rocket / Upay payment message"
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Button
            label="Parse"
            size="sm"
            variant="secondary"
            loading={busy}
            disabled={!text.trim()}
            onPress={async () => {
              setBusy(true);
              try {
                setOutcome(await runDiagnostics(text));
              } finally {
                setBusy(false);
              }
            }}
          />

          {outcome?.kind === 'matched' ? (
            <View style={{ gap: 4 }}>
              <Text variant="caption" style={{ color: colors.successStrong }}>
                Recognised as {providerLabel(outcome.candidate.provider)}
              </Text>
              <Text variant="micro" tone="muted">
                amount {outcome.candidate.amount} · reference {outcome.candidate.transactionId}
              </Text>
              <Text variant="micro" tone="muted">
                sender {outcome.candidate.senderAccount ?? 'not stated'} · receiver{' '}
                {outcome.candidate.receiverAccount ?? 'not stated'}
              </Text>
              <Text variant="micro" tone="muted">
                parser v{outcome.candidate.parserVersion} · hash{' '}
                {outcome.fingerprint.slice(0, 12)}…
              </Text>
            </View>
          ) : null}

          {outcome?.kind === 'rejected' ? (
            <Text variant="micro" tone="muted">
              {rejectionCopy(outcome.reason)}
            </Text>
          ) : null}
        </View>
      </Card>
    </View>
  );
}

const styles = {
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  actions: { flexDirection: 'row' },
} as const;