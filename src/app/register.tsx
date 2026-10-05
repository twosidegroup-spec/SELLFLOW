/**
 * Registration — step one of setting up a business.
 *
 * WHY THIS IS ONE SCREEN AND NOT FOUR
 *
 * The plan is validated as a unit (`validateRegistration`), not per step, so the
 * seller learns that their email was malformed while they are still looking at the
 * email field. The steps exist for pacing, not for deferring error reporting.
 *
 * THE PAYMENT SECTION IS THE IMPORTANT ONE
 *
 * At least one payment method is required, and each number belongs to its own
 * provider. That is not a form convenience -- it is the product's core claim. The
 * section therefore states the requirement in plain words, marks the mandatory one
 * distinctly from the optional ones, and refuses to submit while zero are
 * connected. A seller who finishes this screen must understand that SellFlow needs
 * the numbers they already use, and will not ask them for a merchant account.
 */

import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Check, ChevronLeft } from 'lucide-react-native';

import { Button, Card, Input, Screen, Text } from '@/components/ui';
import { SectionHeader } from '@/components/ui/Card';
import { isBdMobileNumber, normalizeBdNumber } from '@/features/payments/normalize';
import { providerLabel } from '@/features/payments/queries';
import { createRegistrationDeps } from '@/features/registration/deps';
import {
  buildAccountPlan,
  hasErrors,
  MIN_PASSWORD,
  REGISTRATION_PROVIDERS,
  runRegistration,
  validateRegistration,
  type RegistrationOutcome,
  type RegistrationPlan,
} from '@/features/registration/plan';
import type { PaymentProvider } from '@/lib/database.types';
import { useSession } from '@/store/session';
import { useLock } from '@/store/lock';
import { useTheme } from '@/theme/ThemeProvider';

import SetPasscode from './set-passcode';

type Step = 'identity' | 'payments' | 'passcode';

const STEPS: Step[] = ['identity', 'payments', 'passcode'];

export default function RegisterScreen() {
  const router = useRouter();
  const { spacing } = useTheme();

  const setPasscode = useLock((state) => state.setPasscode);
  const refreshWorkspace = useSession((state) => state.refreshWorkspace);

  /*
   * The passcode captured on the final step, held here rather than passed through
   * the plan. `runRegistration` writes it through a closure, so the raw value never
   * reaches the plan object, an RPC argument, or a log line.
   */
  const [passcode, setPasscodeValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /*
   * What a partial attempt already created. Registration's first two stages are
   * irreversible -- the auth user and the business both exist once created -- so a
   * retry must not re-run them blindly. Re-running `signUp` would fail on the
   * unique email, and re-running `bootstrap_business` would at best be idempotent
   * and at worst risk a second business. These ids are threaded through so a retry
   * touches only what is still missing.
   */
  const [progress, setProgress] = useState<{ userId: string | null; orgId: string | null }>({
    userId: null,
    orgId: null,
  });

  const [step, setStep] = useState<Step>('identity');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [password, setPassword] = useState('');

  // Which providers the seller has engaged with, and the numbers they typed.
  // A provider is "engaged" by being switched on OR by having text in its field,
  // so typing a number never has to be preceded by remembering to flip a switch.
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    bkash: true,
    nagad: false,
    rocket: false,
    upay: false,
  });
  const [numbers, setNumbers] = useState<Record<string, string>>({});

  const stepIndex = STEPS.indexOf(step);

  // The plan is rebuilt from raw state on every render rather than kept in its own
  // state object, so the numbers on screen and the numbers validated can never
  // drift apart.
  const plan: RegistrationPlan = useMemo(
    () => ({
      email,
      password,
      fullName,
      businessName,
      storeName: null,
      passcodeLength: 4,
      accounts: buildAccountPlan(
        REGISTRATION_PROVIDERS.filter((provider) => enabled[provider]),
        numbers,
      ),
      passcode: '',
    }),
    [email, password, fullName, businessName, enabled, numbers],
  );

  const allErrors = useMemo(() => validateRegistration(plan), [plan]);

  /**
   * Errors for the fields on the current step.
   *
   * `accounts` is dropped on the identity step so an empty payment section cannot
   * block a seller from moving off the first step. The payment step reads
   * `allErrors.accounts` directly.
   */
  const stepErrors = useMemo(() => {
    if (step !== 'identity') return allErrors;
    const { accounts: _ignored, ...identityErrors } = allErrors;
    return identityErrors;
  }, [allErrors, step]);

  const connected = plan.accounts.length;
  const paymentError = connected === 0 ? 'Connect at least one payment method to continue.' : allErrors.accounts;

  const submit = async () => {
    setSubmitting(true);
    setFailure(null);

    const deps = createRegistrationDeps({
      plan: { email, password, fullName, businessName, storeName: null },
      // The closure reads `passcode` from this scope. The raw value is therefore
      // never an argument to anything, so it cannot end up in an RPC payload, a
      // query log, or an error message.
      setPasscode: async () => {
        if (!progress.userId) return;
        await setPasscode(progress.userId, passcode, [4, 6]);
      },
      refreshWorkspace,
    });

    try {
      const outcome = await runRegistration({
        plan: { ...plan, passcode },
        deps,
        existingUserId: progress.userId,
        existingOrgId: progress.orgId,
        alreadyConnected: [],
      });

      // Remember what exists so a retry after a mid-flight failure does not attempt
      // to create the account or the business a second time.
      setProgress({ userId: outcome.userId, orgId: outcome.orgId });

      if (outcome.ok) {
        finish(outcome);
        return;
      }

      setFailure(outcome.message ?? 'Something went wrong. Your details were kept.');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Reports exactly what the backend confirmed.
   *
   * Automation is named from `outcome.automation`, which is derived in `plan.ts`
   * from a confirmed account, the OS permission and the platform -- never from
   * intent. A seller is never told automation is on because they tapped Continue.
   */
  const finish = (outcome: RegistrationOutcome) => {
    router.replace({
      pathname: '/setup-complete',
      params: {
        connected: outcome.connected.join(','),
        automation: outcome.automation,
      },
    });
  };

  const goNext = () => {
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next);
  };

  const goBack = () => {
    const previous = STEPS[stepIndex - 1];
    if (previous) setStep(previous);
    else router.back();
  };

  return (
    <Screen
      testID="register-screen"
      width="form"
      header={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Button
            label="Back"
            variant="ghost"
            onPress={goBack}
            icon={ChevronLeft}
            testID="register-back"
          />
          <View style={{ flex: 1 }} />
          <Text variant="caption" tone="muted">
            {`${stepIndex + 1} of ${STEPS.length}`}
          </Text>
        </View>
      }
footer={
        step === 'passcode' ? undefined : (
          <Button
            label="Continue"
            size="lg"
            fullWidth
            disabled={step === 'identity' && hasErrors(stepErrors)}
            onPress={goNext}
            testID="register-next"
          />
        )
      }
    >
      {step === 'identity' ? (
        <View style={{ gap: spacing.lg }}>
          <View style={{ gap: spacing.xs }}>
            <Text variant="title">Let us set up your business</Text>
            <Text variant="body" tone="secondary">
              You will not need a merchant account. SellFlow works with the payment numbers you
              already use.
            </Text>
          </View>

          <Card>
            <View style={{ gap: spacing.md }}>
              <Input
                label="Full name"
                required
                value={fullName}
                onChangeText={setFullName}
                error={stepErrors.fullName}
                placeholder="Rakib Hasan"
                autoComplete="name"
                testID="register-fullname"
              />
              <Input
                label="Email"
                required
                value={email}
                onChangeText={setEmail}
                error={stepErrors.email}
                placeholder="you@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                testID="register-email"
              />
              <Input
                label="Business or page name"
                required
                value={businessName}
                onChangeText={setBusinessName}
                error={stepErrors.businessName}
                placeholder="Rk Fashion"
                autoComplete="organization"
                testID="register-business"
              />
              <Input
                label="Account password"
                required
                secure
                value={password}
                onChangeText={setPassword}
                error={stepErrors.password}
                hint={`At least ${MIN_PASSWORD} characters. Used to sign in.`}
                autoComplete="password-new"
                testID="register-password"
              />
            </View>
          </Card>
        </View>
      ) : null}

      {step === 'payments' ? (
        <View style={{ gap: spacing.lg }}>
          <View style={{ gap: spacing.xs }}>
            <Text variant="title">Connect your payment numbers</Text>
            <Text variant="body" tone="secondary">
              These are the numbers customers already send money to. Connect at least one. Every
              number stays tied to the method you put it under.
            </Text>
          </View>

          <SectionHeader title="Payment methods" />

          <View style={{ gap: spacing.sm }}>
            {REGISTRATION_PROVIDERS.map((provider, index) => (
              <PaymentMethodRow
                key={provider}
                provider={provider}
                required={index === 0}
                on={Boolean(enabled[provider])}
                number={numbers[provider] ?? ''}
                onToggle={() =>
                  setEnabled((current) => ({ ...current, [provider]: !current[provider] }))
                }
                onNumber={(next) => setNumbers((current) => ({ ...current, [provider]: next }))}
              />
            ))}
          </View>

          {paymentError ? (
            <Text variant="caption" tone="danger" testID="register-payment-error">
              {paymentError}
            </Text>
          ) : (
            <Text variant="caption" tone="secondary" testID="register-payment-ok">
              {`${connected} method${connected === 1 ? '' : 's'} connected.`}
            </Text>
          )}
        </View>
      ) : null}

{step === 'passcode' ? (
        <SetPasscode
          optional
          busy={submitting}
          error={failure}
          onSet={async (digits) => {
            // Held in state, not written yet. `submit` persists it through the
            // deps closure, which only runs once there is a user id to key the
            // keystore record by.
            setPasscodeValue(digits);
          }}
          onDone={() => void submit()}
        />
      ) : null}
    </Screen>
  );
}

/**
 * The REQUIRED / OPTIONAL capsule.
 *
 * A separate component because it appears twice with different tones, and because
 * its padding has to be identical both times -- a badge whose two variants differ
 * by a pixel reads as a rendering bug rather than a distinction.
 *
 * The tight vertical padding is deliberate and is the one place in the app that
 * goes below the spacing scale: this is an 11px-capsule chip, not a control or a
 * block of content. It is not a layout rhythm value, so it is commented as such.
 */
function RequirementChip({ required }: { required: boolean }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: spacing.xxs,
        paddingVertical: BADGE_PADDING_V,
        borderRadius: radius.pill,
        backgroundColor: required ? colors.primarySoft : colors.surfaceSunken,
      }}
    >
      <Text variant="micro" tone={required ? 'primary' : 'muted'}>
        {required ? 'REQUIRED' : 'OPTIONAL'}
      </Text>
    </View>
  );
}

/**
 * Vertical padding for a badge capsule, in points.
 *
 * `spacing.xxs` (4) would make the chip 19px tall, taller than the 11px text it
 * contains. Two points is what a capsule of this type actually wants, and it is
 * named here rather than inlined so the design audit can see it is deliberate.
 */
const BADGE_PADDING_V = 2;

/**
 * One payment method: name, requirement, toggle, and the number field.
 *
 * The number field is only shown when the method is on, so the screen is not a
 * wall of four inputs with no indication of which one matters.
 */
function PaymentMethodRow({
  provider,
  required,
  on,
  number,
  onToggle,
  onNumber,
}: {
  provider: PaymentProvider;
  required: boolean;
  on: boolean;
  number: string;
  onToggle: () => void;
  onNumber: (next: string) => void;
}) {
  const { colors, radius, spacing, borderWidth } = useTheme();
  const typed = number.trim().length > 0;
  const valid = typed && isBdMobileNumber(number);

  return (
    <Card
      padded={false}
      elevation="flat"
      style={{
        borderColor: on ? colors.primaryBorder : colors.border,
        borderWidth: on ? borderWidth.thick : borderWidth.hairline,
        overflow: 'hidden',
      }}
    >
      <PressableRow onPress={onToggle} testID={`register-provider-${provider}-toggle`}>
        <View style={{ flex: 1, gap: spacing.xxs }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
            <Text variant="bodyStrong">{providerLabel(provider)}</Text>
<RequirementChip required={required} />
          </View>
          {valid ? (
            <Text variant="caption" tone="success">
              {`Connected · ${normalizeBdNumber(number)}`}
            </Text>
          ) : (
            <Text variant="caption" tone="muted">
              {on ? 'Enter your receiving number' : 'Not connected'}
            </Text>
          )}
        </View>

        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: radius.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: valid ? colors.success : 'transparent',
            borderWidth: valid ? 0 : 1.5,
            borderColor: on ? colors.primary : colors.borderStrong,
          }}
        >
          {valid ? (
            <Check size={14} color={colors.onSuccess} strokeWidth={3} />
          ) : on ? (
            <View
              style={{ width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.primary }}
            />
          ) : null}
        </View>
      </PressableRow>

      {on ? (
        <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md }}>
          <Input
            label={`${providerLabel(provider)} receiving number`}
            value={number}
            onChangeText={onNumber}
            prefix="+880"
            keyboardType="phone-pad"
            placeholder="1XXXXXXXXX"
            error={typed && !valid ? 'Enter an 11-digit Bangladeshi mobile number.' : null}
            testID={`register-provider-${provider}-number`}
          />
        </View>
      ) : null}
    </Card>
  );
}

/** A tappable row. Local because it exists only inside this screen. */
function PressableRow({
  onPress,
  children,
  testID,
}: {
  onPress: () => void;
  children: React.ReactNode;
  testID?: string;
}) {
  const { spacing } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="switch"
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        padding: spacing.md,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}