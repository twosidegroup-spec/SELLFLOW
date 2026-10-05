/**
 * Registration completion.
 *
 * States what the backend actually confirmed and nothing more. `plan.ts` derives
 * `automation` from a confirmed account, the OS permission and the platform -- so
 * this screen cannot say "automation is on" because the seller tapped Continue.
 *
 * The copy for each automation state is deliberately different:
 *
 *   active                  it is matching payments now
 *   waiting_for_permission  the account is connected, one tap is missing
 *   manual_only             payment entry still works, nothing is automatic
 *   needs_attention         something the seller must look at
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { CircleAlert, CircleCheck, Radio, Settings2 } from 'lucide-react-native';

import { Button, Card, Screen, Text } from '@/components/ui';
import type { AutomationState } from '@/features/registration/plan';
import type { PaymentProvider } from '@/lib/database.types';
import { providerLabel } from '@/features/payments/queries';
import { useTheme } from '@/theme/ThemeProvider';

const AUTOMATION: Record<
  AutomationState,
  { title: string; body: string; tone: 'success' | 'warning' | 'danger'; Icon: typeof Radio }
> = {
  active: {
    title: 'Payment detection is on',
    body: 'When a customer pays you, SellFlow matches it to an order on its own.',
    tone: 'success',
    Icon: Radio,
  },
  waiting_for_permission: {
    title: 'Payment detection needs permission',
    body: 'Your payment method is connected. Allow the SMS permission and detection will start working.',
    tone: 'warning',
    Icon: Settings2,
  },
  manual_only: {
    title: 'You are ready to sell',
    body: 'Record payments by hand for now. You can turn on automatic detection any time from Payments.',
    tone: 'success',
    Icon: CircleCheck,
  },
  needs_attention: {
    title: 'Almost there',
    body: 'One of your payment methods could not be connected. Check it in Payments.',
    tone: 'danger',
    Icon: CircleAlert,
  },
};

function parseProviders(raw: string | undefined): PaymentProvider[] {
  if (!raw) return [];
  return raw.split(',').filter(Boolean) as PaymentProvider[];
}

export default function SetupCompleteScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const params = useLocalSearchParams<{ connected?: string; automation?: string }>();

  const providers = parseProviders(params.connected);
  const state = (params.automation ?? 'manual_only') as AutomationState;
  const copy = AUTOMATION[state] ?? AUTOMATION.manual_only;
  const { Icon } = copy;

  return (
    <Screen
      testID="setup-complete-screen"
      width="form"
      footer={
        <Button
          label="Go to my dashboard"
          size="lg"
          fullWidth
          onPress={() => router.replace('/(app)')}
          testID="setup-complete-continue"
        />
      }
    >
      <View style={{ gap: spacing.lg, alignItems: 'center' }}>
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: copy.tone === 'danger' ? colors.dangerSoft : colors.successSoft,
          }}
        >
          <Icon
            size={26}
            color={copy.tone === 'danger' ? colors.danger : colors.success}
            strokeWidth={1.75}
          />
        </View>

        <Text variant="title" center>
          {copy.title}
        </Text>
      </View>

      <Card>
        <View style={{ gap: spacing.md }}>
          <Text variant="body" tone="secondary">
            {copy.body}
          </Text>

          {providers.length > 0 ? (
            <View style={{ gap: spacing.xs }}>
              <Text variant="micro" tone="muted">
                CONNECTED PAYMENT METHODS
              </Text>
              <Text variant="body" tone="secondary">
                {providers.map(providerLabel).join(', ')}
              </Text>
            </View>
          ) : null}
        </View>
      </Card>

      <Text variant="caption" tone="muted" center>
        You do not need a merchant account. SellFlow works with the payment numbers you already
        use.
      </Text>
    </Screen>
  );
}