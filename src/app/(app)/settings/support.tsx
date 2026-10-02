/**
 * Help and about.
 *
 * A short, honest support page. No invented contact details -- if support email
 * is not configured, the section says so instead of showing a dead link.
 */

import { Linking, Platform, View } from 'react-native';
import Constants from 'expo-constants';
import { CircleHelp, Mail, ShieldCheck } from 'lucide-react-native';

import { ScreenHeader } from '@/components/ScreenHeader';
import { Card, DetailRow, Screen, SectionHeader, Text } from '@/components/ui';
import { useTheme } from '@/theme/ThemeProvider';

function SupportSettingsContent() {
  const { spacing, colors } = useTheme();

  const version = Constants.expoConfig?.version ?? '1.0.0';
  const supportEmail = Constants.expoConfig?.extra?.supportEmail as string | undefined;

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Help and about" />

      <Screen>
        <View style={{ gap: spacing.xl, paddingTop: spacing.sm }}>
          <Card>
            <Text variant="title">SellFlow</Text>
            <Text variant="body" tone="muted" style={{ marginTop: spacing.xs }}>
              From customer message to delivered order, all in one place.
            </Text>

            <View style={{ marginTop: spacing.md }}>
              <DetailRow label="Version" value={version} />
              <DetailRow label="Platform" value={`${Platform.OS} ${Platform.Version}`} />
            </View>
          </Card>

          <View>
            <SectionHeader title="Getting started" />
            <Card>
              <View style={{ gap: spacing.sm }}>
                <Step
                  n={1}
                  title="Add your products"
                  body="Name, selling price and how much you paid. That is enough to start."
                />
                <Step
                  n={2}
                  title="Add your customers"
                  body="So you can see their order history and what they owe you."
                />
                <Step
                  n={3}
                  title="Create an order"
                  body="Pick products, set a quantity, take payment. Stock updates itself."
                />
              </View>
            </Card>
          </View>

          <View>
            <SectionHeader title="How stock works" />
            <Card>
              <Text variant="body" tone="secondary">
                Stock is reduced the moment an order is created, so you cannot accidentally sell the
                same item twice. Cancelling or returning an order puts the stock back automatically,
                and every change is recorded in the product&apos;s history.
              </Text>
            </Card>
          </View>

          <View>
            <SectionHeader title="Your data" />
            <Card>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <ShieldCheck size={20} color={colors.textSecondary} strokeWidth={2} />
                <Text variant="body" tone="secondary" style={{ flex: 1 }}>
                  Each business is isolated at the database level. Your orders, customers and stock
                  are never visible to another business, and access is enforced by the server rather
                  than by this app.
                </Text>
              </View>
            </Card>
          </View>

          <View>
            <SectionHeader title="Contact" />
            <Card>
              {supportEmail ? (
                <>
                  <Text variant="body" tone="secondary" style={{ marginBottom: spacing.sm }}>
                    Something not working? Get in touch.
                  </Text>
                  <Card
                    onPress={() => void Linking.openURL(`mailto:${supportEmail}`)}
                    accessibilityLabel={`Email support at ${supportEmail}`}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
                  >
                    <Mail size={18} color={colors.textSecondary} strokeWidth={2} />
                    <Text variant="body">{supportEmail}</Text>
                  </Card>
                </>
              ) : (
                // Honest rather than decorative: no support address is
                // configured for this build, so the section says so.
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <CircleHelp size={20} strokeWidth={2} />
                  <Text variant="body" tone="secondary" style={{ flex: 1 }}>
                    No support address is configured for this build. Use the contact details you
                    received when you set up your account.
                  </Text>
                </View>
              )}
            </Card>
          </View>
        </View>
      </Screen>
    </View>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  const { spacing, colors } = useTheme();

  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm }}>
      <View
        style={{
          width: 22,
          height: 22,
          // A numbered disc: fully round, like every other circular mark.
          borderRadius: 999,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.primarySoft,
        }}
      >
        <Text variant="micro" tone="primary">{n}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="subtitle">{title}</Text>
        <Text variant="caption" tone="muted">{body}</Text>
      </View>
    </View>
  );
}

export default SupportSettingsContent;
