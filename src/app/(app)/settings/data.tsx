/**
 * Data and sync.
 *
 * Tells the truth about what is stored where and what is waiting to sync.
 *
 * The queued-changes section is deliberately prominent: requirement 23 says the
 * app must clearly communicate synchronisation state and must not silently lose
 * user data. If a seller has three unsaved changes, this screen says so and
 * offers to retry them.
 */

import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { RefreshCw, Trash2 } from 'lucide-react-native';

import { ScreenHeader } from '@/components/ScreenHeader';
import {
  Banner,
  Button,
  Card,
  DetailRow,
  Divider,
  Screen,
  SectionHeader,
  Text,
  confirm,
} from '@/components/ui';
import { useConnectivity } from '@/lib/connectivity';
import { queryClient } from '@/lib/queryClient';
import { formatDateTime, formatTimeAgo } from '@/lib/format';
import { flushOutbox } from '@/lib/outbox';
import { useTheme } from '@/theme/ThemeProvider';

export default function DataSettingsScreen() {
  const { spacing } = useTheme();

  const online = useConnectivity((state) => state.online);
  const syncState = useConnectivity((state) => state.syncState);
  const pending = useConnectivity((state) => state.pending);
  const lastSyncAt = useConnectivity((state) => state.lastSyncAt);
  const clearQueue = useConnectivity((state) => state.clearQueue);
  const markSynced = useConnectivity((state) => state.markSynced);

  const [refreshing, setRefreshing] = useState(false);
  const [flushMessage, setFlushMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setFlushMessage(null);
    try {
      // Replay anything queued while offline BEFORE refreshing, so the numbers
      // the seller sees already include the work they were told would sync.
      const result = await flushOutbox();

      if (result.blocked) {
        setFlushMessage(`${result.blocked.title}. ${result.blocked.action}`);
      } else if (result.interrupted && result.remaining > 0) {
        setFlushMessage(
          `Connection dropped again. ${result.remaining} change${result.remaining === 1 ? '' : 's'} still waiting.`,
        );
      } else if (result.replayed > 0) {
        setFlushMessage(
          `Synced ${result.replayed} queued change${result.replayed === 1 ? '' : 's'}.`,
        );
      }

      // Refetch everything currently in the cache. Anything not in the cache
      // will load fresh on its next mount anyway.
      await queryClient.invalidateQueries();
      await queryClient.refetchQueries();
      if (!result.blocked && !result.interrupted) await markSynced();
    } finally {
      setRefreshing(false);
    }
  }, [markSynced]);

  useEffect(() => {
    if (online && syncState === 'offline') {
      // Connectivity came back. Replay first, then tell the user we are
      // catching up rather than silently changing numbers under them.
      useConnectivity.setState({ syncState: 'syncing' });
      void flushOutbox().then((result) => {
        setFlushMessage(
          result.blocked
            ? `${result.blocked.title}. ${result.blocked.action}`
            : result.replayed > 0
              ? `Synced ${result.replayed} queued change${result.replayed === 1 ? '' : 's'}.`
              : null,
        );
        return queryClient.invalidateQueries();
      });
    }
  }, [online, syncState]);

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Data and sync" />

      <Screen onRefresh={() => void refresh()} refreshing={refreshing}>
        <View style={{ gap: spacing.xl, paddingTop: spacing.sm }}>
          {/* Status ------------------------------------------------------ */}
          <View>
            <SectionHeader title="Status" />
            <Card>
              {online ? (
                <Banner
                  kind={syncState === 'syncing' ? 'info' : 'success'}
                  title={syncState === 'syncing' ? 'Syncing your data' : 'Connected'}
                />
              ) : (
                <Banner
                  kind="error"
                  title="You are offline. The app is showing your last synced data."
                />
              )}

              <View style={{ marginTop: spacing.md }}>
                <DetailRow
                  label="Last synced"
                  value={lastSyncAt ? formatTimeAgo(lastSyncAt) : 'Not yet'}
                />
                <DetailRow label="Queued changes" value={String(pending.length)} />
              </View>

              {flushMessage ? (
                <Banner
                  kind={
                    flushMessage.includes('Connection dropped') || flushMessage.includes('.')
                      ? 'error'
                      : 'success'
                  }
                  title={flushMessage}
                  style={{ marginTop: spacing.sm }}
                />
              ) : null}

              <Button
                label="Sync now"
                icon={RefreshCw}
                onPress={() => void refresh()}
                loading={refreshing || syncState === 'syncing'}
                disabled={!online}
                block
                style={{ marginTop: spacing.md }}
              />
            </Card>
          </View>

          {/* Queue ------------------------------------------------------ */}
          {pending.length > 0 ? (
            <View>
              <SectionHeader title="Waiting to sync" />
              <Card flush>
                {pending.map((mutation, index) => (
                  <View key={mutation.id}>
                    <View style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
                      <Text variant="body">{mutation.summary}</Text>
                      <Text variant="micro" tone="muted">
                        {formatDateTime(mutation.createdAt)} · {mutation.attempts} attempt
                        {mutation.attempts === 1 ? '' : 's'}
                      </Text>
                    </View>
                    {index < pending.length - 1 ? <Divider /> : null}
                  </View>
                ))}
              </Card>

              <Button
                label="Discard queued changes"
                icon={Trash2}
                variant="secondary"
                block
                style={{ marginTop: spacing.sm }}
                onPress={async () => {
                  const confirmed = await confirm({
                    title: 'Discard queued changes?',
                    message:
                      'These changes were never saved to the server and will be lost. This cannot be undone.',
                    confirmLabel: 'Discard',
                    destructive: true,
                  });
                  if (confirmed) await clearQueue();
                }}
              />
            </View>
          ) : null}

          {/* Where data lives ------------------------------------------- */}
          <View>
            <SectionHeader title="Where your data is stored" />
            <Card>
              <Text variant="body" tone="secondary">
                Every order, customer, product, stock movement and expense is stored in your Supabase
                database, not on this phone. Selling out the same data is automatic.
              </Text>
              <Text variant="micro" tone="muted" style={{ marginTop: spacing.sm }}>
                Each business is isolated at the database level. Even a bug in this app could not
                show you another business&apos; records.
              </Text>
            </Card>
          </View>

          {/* Cache ------------------------------------------------------ */}
          <View>
            <SectionHeader title="Offline cache" />
            <Card>
              <Text variant="body" tone="secondary">
                Recently viewed screens are cached on this device so SellFlow opens instantly and
                stays usable with poor signal.
              </Text>
              <Text variant="micro" tone="muted" style={{ marginTop: spacing.sm }}>
                Clearing the cache is safe. It only means the next screen you open needs a
                connection to load.
              </Text>

              <Button
                label="Clear cache"
                variant="secondary"
                block
                style={{ marginTop: spacing.md }}
                onPress={async () => {
                  const confirmed = await confirm({
                    title: 'Clear cached data?',
                    message: 'Your records are safe. The app will reload them when you next connect.',
                    confirmLabel: 'Clear',
                  });
                  if (confirmed) {
                    await queryClient.invalidateQueries();
                    await queryClient.clear();
                  }
                }}
              />
            </Card>
          </View>
        </View>
      </Screen>
    </View>
  );
}
