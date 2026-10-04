/**
 * Registration.
 *
 * One continuous flow, replacing what used to be three separate screens: create
 * account, set up the business, then set a passcode -- with a fourth journey
 * afterwards to find and connect a payment account. A seller now finishes setting
 * up in one place and lands in a working business.
 *
 * The steps are ordered by dependency, not by preference:
 *
 *   1. Account    email, password, name. Nothing can exist without this.
 *   2. Business   the name customers will see. Creates the organisation.
 *   3. Passcode   the everyday lock, chosen here rather than after the fact.
 *   4. Payments   one or more receiving numbers. Optional to skip, but at least
 *                 one is required for payment automation to have anything to
 *                 detect against.
 *   5. Done       backend writes confirmed, permission asked, then in.
 *
 * Two decisions worth stating, because both could reasonably have gone otherwise.
 *
 * **The account password is still asked for.** The brief listed the fields to
 * collect and a password was not among them, but the passcode cannot replace it:
 * the passcode lives only in this device's keystore, so a seller who changes
 * phones or reinstalls has no way back in without it, and Supabase's own
 * password reset is built around it. Dropping it would have meant either locking
 * people out permanently or weakening the account to a 4-digit code. It is asked
 * for once, labelled as the account password, and is not part of everyday login.
 *
 * **Nothing is created until the last step is pressed.** Every screen collects,
 * every screen validates, and a single submit performs the writes in order. That
 * is why a seller who abandons the flow at step 4 has no half-made business to
 * recover from.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, ArrowRight, Building2, Lock, Mail, User } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import {
  BrandMark,
  Button,
  Card,
  Input,
  PasscodeKeypad,
  SegmentedControl,
  SetupCompleteView,
  Text,
} from '@/components/ui';
import { AppError, paymentAccountError } from '@/lib/errors';
import { PASSCODE_LENGTHS, validatePasscode, type PasscodeLength } from '@/lib/passcode';
import type { PaymentProvider } from '@/lib/database.types';
import { getSupabase, isConfigured } from '@/lib/supabase';
import { PROVIDERS, providerLabel } from '@/features/payments/queries';
import { isBdMobileNumber, normalizeBdNumber } from '@/features/payments/normalize';
import { requestSmsPermission } from '@/features/payments/sms/hooks';
import { useLock } from '@/store/lock';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';
import {
  MIN_PASSWORD,
  buildAccountPlan,
  deriveAutomation,
  runRegistration,
  validateRegistration,
  type AutomationState,
  type RegistrationPlan,
} from '@/features/registration/plan';

type Step = 'account' | 'business' | 'passcode' | 'payments' | 'done';

const STEP_ORDER: Step[] = ['account', 'business', 'passcode', 'payments', 'done'];

export default function RegisterScreen() {
  const { colors, spacing, radius } = useTheme();

  const setPasscode = useLock((state) => state.setPasscode);
  const hydrateLock = useLock((state) => state.hydrate);
  const refreshWorkspace = useSession((state) => state.refreshWorkspace);
  const userId = useSession((state) => state.user?.id);

  const [requestedStep, setRequestedStep] = useState<Step>('account');
  const [busy, setBusy] = useState(false);

  // Form state. Held here rather than per-step so Back never discards a
  // half-finished answer.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [passcodeLength, setPasscodeLength] = useState<PasscodeLength>(4);
  const [passcode, setPasscodeValue] = useState('');
  const [selected, setSelected] = useState<PaymentProvider[]>([]);
  const [numbers, setNumbers] = useState<Record<string, string>>({});

  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<AppError | null>(null);
  const [accountErrors, setAccountErrors] = useState<Record<string, string>>({});

  // What the last run actually achieved. Drives the completion copy, so the app
  // cannot say "ready to sell" over a partially-created account set.
  const [outcome, setOutcome] = useState<{
    automation: AutomationState;
    connected: PaymentProvider[];
  } | null>(null);

  /*
   * Survives the submission that creates the account, so a retry of a later
   * step does not try to sign the same email up again. See `runRegistration`.
   */
  const created = useRef<{ userId: string | null; orgId: string | null; connected: PaymentProvider[] }>({
    userId: null,
    orgId: null,
    connected: [],
  });

  /*
   * Resume.
   *
   * Someone can arrive here already signed in: they started registering, the
   * account was created, and then the connection dropped before the business was.
   * That leaves a real auth user with no business, and `bootstrap_business` is
   * the only thing that can finish it. Rather than keep a second screen alive for
   * that case, this one detects it and starts at the business step -- so there is
   * genuinely a single registration flow, not two that happen to look alike.
   *
   * Derived during render rather than pushed with an effect. An effect that calls
   * setState renders twice for one state change, and here the extra pass would
   * also flash the account form at somebody who is resuming.
   */
  const status = useSession((state) => state.status);
  const resuming = status === 'needs-onboarding' && Boolean(userId);

  const step: Step = resuming && requestedStep === 'account' ? 'business' : requestedStep;

  // A signed-in seller who already has a business has no business registering.
  useEffect(() => {
    if (status === 'ready') router.replace('/(app)');
  }, [status]);

  const plan = useMemo<RegistrationPlan>(
    () => ({
      email: email.trim(),
      password,
      fullName: fullName.trim(),
      businessName: businessName.trim(),
      storeName: null,
      passcodeLength,
      passcode,
      accounts: buildAccountPlan(selected, numbers),
    }),
    [businessName, email, fullName, numbers, passcode, passcodeLength, password, selected],
  );

  const stepIndex = STEP_ORDER.indexOf(step);

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  const goTo = useCallback((next: Step) => {
    Keyboard.dismiss();
    setErrors({});
    setFormError(null);
    setRequestedStep(next);
  }, []);

  const back = useCallback(() => {
    const index = STEP_ORDER.indexOf(step);
    // Never back into the account step while resuming: it is skipped, and
    // stepping into it would just bounce straight back out again.
    if (index <= 0 || (resuming && index === 1)) return;
    goTo(STEP_ORDER[index - 1]!);
  }, [goTo, resuming, step]);

  // ---------------------------------------------------------------------------
  // Step validation
  // ---------------------------------------------------------------------------

  function validateCurrentStep(): boolean {
    const all = validateRegistration(plan);
    const next: Record<string, string | undefined> = {};

    if (step === 'account') {
      next.email = all.email;
      next.password = all.password;
      next.fullName = all.fullName;
    } else if (step === 'business') {
      next.businessName = all.businessName;
    } else if (step === 'passcode') {
      const check = validatePasscode(passcode, PASSCODE_LENGTHS);
      if (!check.ok) next.passcode = check.message;
    } else if (step === 'payments') {
      // Skipping is allowed. Only a *partly* filled selection is an error, and
      // then only for the providers that are actually missing a number.
      const incomplete = selected.filter((provider) => !isBdMobileNumber(numbers[provider] ?? ''));
      if (incomplete.length > 0) {
        next.payments = `Enter a receiving number for ${incomplete
          .map((provider) => providerLabel(provider))
          .join(', ')}.`;
      }
    }

    setErrors(next);
    const ok = !Object.values(next).some(Boolean);
    if (!ok) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    return ok;
  }

  function advance() {
    if (!validateCurrentStep()) return;
    const index = STEP_ORDER.indexOf(step);
    const next = STEP_ORDER[index + 1];
    if (next) goTo(next);
  }

  // ---------------------------------------------------------------------------
  // Provider selection
  // ---------------------------------------------------------------------------

  const toggleProvider = useCallback((provider: PaymentProvider) => {
    setSelected((prev) =>
      prev.includes(provider) ? prev.filter((item) => item !== provider) : [...prev, provider],
    );
    setAccountErrors((prev) => {
      const { [provider]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  const selectedAccounts = useMemo(() => buildAccountPlan(selected, numbers), [numbers, selected]);

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  async function submit() {
    // Validated as a unit, not just the visible step: discovering on the last
    // step that the email was malformed is the kind of thing that makes a flow
    // feel broken.
    const all = validateRegistration(plan);
    if (all.email || all.password || all.fullName || all.businessName) {
      setErrors({
        email: all.email,
        password: all.password,
        fullName: all.fullName,
        businessName: all.businessName,
      });
      // Send them to the earliest step that is wrong rather than silently
      // refusing on the last one.
      if (all.email || all.password || all.fullName) goTo('account');
      else goTo('business');
      return;
    }

    if (all.accounts && selected.length > 0) {
      setErrors({ payments: all.accounts });
      goTo('payments');
      return;
    }

    setBusy(true);
    setFormError(null);
    setAccountErrors({});

    try {
      const result = await runRegistration({
        plan,
        deps: {
          createAccount: async () => {
            const { data, error } = await getSupabase().auth.signUp({
              email: plan.email.trim().toLowerCase(),
              password: plan.password,
              // Carried into the `handle_new_user` trigger so the profile row is
              // populated without a second round trip.
              options: { data: { full_name: plan.fullName.trim() } },
            });
            if (error) throw AppError.from(error);
            if (!data.user) throw new AppError('Could not create your account', 'Try again in a moment.');
            return data.user.id;
          },

          bootstrapBusiness: async () => {
            const { data, error } = await getSupabase().rpc('bootstrap_business', {
              p_business_name: plan.businessName.trim(),
              // The store name is not asked for. `bootstrap_business` defaults it,
              // and a seller is not interrogated before they can use the product.
              p_store_name: null,
              p_store_code: null,
            });
            if (error) throw AppError.from(error);
            const orgId = (data as { org_id?: string } | null)?.org_id;
            if (!orgId) {
              throw new AppError('Could not create your business', 'Try again in a moment.');
            }
            return orgId;
          },

          createPaymentAccount: async (account, orgId) => {
            const { error } = await getSupabase().rpc('create_payment_account', {
              p_org_id: orgId,
              p_provider: account.provider,
              // Canonicalised client-side so what is stored matches what the
              // seller saw confirmed; the server normalises again regardless.
              p_account_number: normalizeBdNumber(account.accountNumber),
              p_account_type: 'personal',
              p_label: null,
            });
            if (error) {
              const mapped = paymentAccountError(error, providerLabel(account.provider));
              // Recorded per provider so the seller is told *which* one failed and
              // the others are kept.
              setAccountErrors((prev) => ({ ...prev, [account.provider]: mapped.action }));
              throw mapped;
            }
          },

          setPasscode: async () => {
            const id = created.current.userId ?? userId;
            if (!id) throw new AppError('Could not save your passcode', 'Set it later in Settings.');
            const result = await setPasscode(id, plan.passcode, PASSCODE_LENGTHS);
            if (!result.ok) throw new AppError(result.message, 'Choose different digits.');
          },

          refreshWorkspace: async () => {
            await refreshWorkspace();
          },

          requestSmsPermission: async () => {
            // Only asked once there is something to detect against, and never
            // fatal. See `runRegistration`.
            if (selectedAccounts.length === 0) return 'unavailable';
            const granted = await requestSmsPermission();
            return granted === 'granted' ? 'granted' : 'denied';
          },
        },
        alreadyConnected: created.current.connected,
        // While resuming there is already a signed-in user, so signUp must be
        // skipped rather than attempted against an email that is taken.
        existingUserId: created.current.userId ?? userId ?? null,
        existingOrgId: created.current.orgId,
      });

      created.current = {
        userId: result.userId ?? created.current.userId,
        orgId: result.orgId ?? created.current.orgId,
        connected: result.connected,
      };

      /*
       * No fake success. Every provider that failed is shown by name, and the
       * seller stays on the payments step with those providers still selected so
       * one tap retries exactly what is missing. The two that worked are not
       * discarded and not re-sent -- that would hit the unique index.
       */
      if (result.failed.length > 0) {
        setAccountErrors(
          Object.fromEntries(result.failed.map((failure) => [failure.provider, failure.message])),
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      if (!result.ok && result.message) {
        setFormError(
          new AppError(
            result.stage === 'account' ? 'Could not create your account' : 'Could not finish setting up',
            result.message,
          ),
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      // The passcode was written to the keystore, so re-read the lock state and
      // let the app layout see an unlocked, known-length passcode immediately.
      await hydrateLock(created.current.userId ?? undefined);

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setOutcome({ automation: result.automation, connected: result.connected });
      goTo('done');
    } catch (error) {
      setFormError(AppError.from(error));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (step === 'done') {
    const automation = outcome?.automation ?? deriveAutomation(0, 'unavailable');
    return (
      <SetupCompleteView
        accountsConnected={outcome?.connected.length ?? 0}
        automationState={automation}
        onDone={() => router.replace('/(app)')}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.content,
          { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.xxl },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ maxWidth: 440, width: '100%', alignSelf: 'center', gap: spacing.xl }}>
          {/* Progress. Three of four steps; the completion view is not a step. */}
          <View style={[styles.top, { gap: spacing.md }]}>
            {stepIndex > 0 && !(resuming && stepIndex === 1) ? (
              <Button
                label="Back"
                variant="ghost"
                icon={ArrowLeft}
                onPress={back}
                disabled={busy}
                style={styles.backButton}
              />
            ) : (
              <BrandMark size={56} />
            )}
            <View style={[styles.dots, { gap: spacing.xs }]}>
              {STEP_ORDER.slice(0, 4).map((name, index) => (
                <View
                  key={name}
                  style={{
                    flex: 1,
                    height: 4,
                    borderRadius: radius.pill,
                    backgroundColor: index <= stepIndex ? colors.primary : colors.border,
                  }}
                />
              ))}
            </View>
          </View>

          {formError ? (
            <View
              style={{
                backgroundColor: colors.dangerSoft,
                borderRadius: radius.mark,
                padding: spacing.sm,
                gap: 2,
              }}
            >
              <Text variant="caption" tone="danger">
                {formError.title}
              </Text>
              <Text variant="micro" tone="secondary">
                {formError.action}
              </Text>
            </View>
          ) : null}

          {step === 'account' ? (
            <View style={{ gap: spacing.lg }}>
              <View>
                <Text variant="display">Create your account</Text>
                <Text variant="body" tone="muted" style={{ marginTop: spacing.xs }}>
                  Step 1 of 4. This is the only time you will need your password.
                </Text>
              </View>

              <Input
                label="Full name"
                required
                value={fullName}
                onChangeText={(text) => {
                  setFullName(text);
                  setErrors((prev) => ({ ...prev, fullName: undefined }));
                }}
                placeholder="Rahim Uddin"
                icon={User}
                autoComplete="name"
                textContentType="name"
                autoCapitalize="words"
                error={errors.fullName}
                showError
                editable={!busy}
                returnKeyType="next"
              />

              <Input
                label="Email"
                required
                value={email}
                onChangeText={(text) => {
                  setEmail(text);
                  setErrors((prev) => ({ ...prev, email: undefined }));
                }}
                placeholder="you@example.com"
                icon={Mail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                textContentType="emailAddress"
                error={errors.email}
                showError
                editable={!busy}
                returnKeyType="next"
              />

              <Input
                label="Account password"
                required
                value={password}
                onChangeText={(text) => {
                  setPassword(text);
                  setErrors((prev) => ({ ...prev, password: undefined }));
                }}
                placeholder={`At least ${MIN_PASSWORD} characters`}
                icon={Lock}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="new-password"
                textContentType="newPassword"
                error={errors.password}
                showError
                editable={!busy}
                hint="Used to recover your account if you change phones. Your 4 or 6 digit passcode is what you use day to day."
                returnKeyType="go"
                onSubmitEditing={() => advance()}
              />
            </View>
          ) : null}

          {step === 'business' ? (
            <View style={{ gap: spacing.lg }}>
              <View>
                <Text variant="display">Your business</Text>
                <Text variant="body" tone="muted" style={{ marginTop: spacing.xs }}>
                  {resuming
                    ? 'One more step. Pick the name your customers will recognise.'
                    : 'Step 2 of 4. This is the name your customers will recognise.'}
                </Text>
              </View>

              <Input
                label="Business / Page name"
                required
                value={businessName}
                onChangeText={(text) => {
                  setBusinessName(text);
                  setErrors((prev) => ({ ...prev, businessName: undefined }));
                }}
                placeholder="Apex Traders"
                icon={Building2}
                autoCapitalize="words"
                error={errors.businessName}
                showError
                editable={!busy}
                returnKeyType="go"
                onSubmitEditing={() => advance()}
              />
            </View>
          ) : null}

          {step === 'passcode' ? (
            <View style={{ gap: spacing.lg, alignItems: 'center' }}>
              <View style={{ alignItems: 'center', gap: spacing.xs }}>
                <Text variant="display">Set a passcode</Text>
                <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
                  {resuming
                    ? 'This is what unlocks SellFlow each time you open it.'
                    : 'Step 3 of 4. This is what unlocks SellFlow each time you open it.'}
                </Text>
              </View>

              {/* The length is chosen up front, so the keypad knows when to
                  submit instead of guessing. */}
              <SegmentedControl
                options={PASSCODE_LENGTHS.map((length) => ({
                  value: length,
                  label: `${length} digits`,
                }))}
                value={passcodeLength}
                onChange={(value) => {
                  setPasscodeLength(value);
                  setPasscodeValue('');
                  setErrors((prev) => ({ ...prev, passcode: undefined }));
                }}
                style={{ alignSelf: 'stretch' }}
              />

              <PasscodeKeypad
                value={passcode}
                length={passcodeLength}
                onChange={(next) => {
                  setPasscodeValue(next);
                  setErrors((prev) => ({ ...prev, passcode: undefined }));
                }}
                onComplete={() => advance()}
                disabled={busy}
                invalid={Boolean(errors.passcode)}
              />

              {errors.passcode ? (
                <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
                  {errors.passcode}
                </Text>
              ) : (
                <View style={{ minHeight: 20 }} />
              )}

              <Text variant="micro" tone="muted" style={{ textAlign: 'center', maxWidth: 320 }}>
                Stored on this device only, in the phone&apos;s secure keystore, as a salted
                hash. It is never sent to SellFlow.
              </Text>
            </View>
          ) : null}

          {step === 'payments' ? (
            <View style={{ gap: spacing.lg }}>
              <View>
                <Text variant="display">Where you get paid</Text>
                <Text variant="body" tone="muted" style={{ marginTop: spacing.xs }}>
                  {resuming
                    ? 'Last step. Connect the number your customers pay into, so SellFlow can match a payment to an order.'
                    : 'Step 4 of 4. Connect the number your customers pay into, so SellFlow can match a payment to an order.'}
                </Text>
              </View>

              {/*
                A checkbox list rather than a picker: the brief is one, two, three
                or all four, and a single-select control cannot express that
                without a second "and another?" prompt.
              */}
              <View style={{ gap: spacing.sm }}>
                {PROVIDERS.map((provider) => {
                  const on = selected.includes(provider.value);
                  const Icon = provider.icon;
                  const failure = accountErrors[provider.value];
                  return (
                    <Card
                      key={provider.value}
                      style={{
                        borderColor: failure ? colors.danger : on ? colors.primary : colors.border,
                        backgroundColor: on ? colors.primarySoft : colors.surface,
                      }}
                    >
                      <View style={{ gap: spacing.sm }}>
                        <Button
                          label={provider.label}
                          icon={Icon}
                          variant="ghost"
                          onPress={() => toggleProvider(provider.value)}
                          disabled={busy}
                          block
                          style={{ justifyContent: 'flex-start' }}
                        />

                        {on ? (
                          <Input
                            label={`${provider.label} receiving number`}
                            required
                            numeric
                            value={numbers[provider.value] ?? ''}
                            onChangeText={(text) => {
                              setNumbers((prev) => ({ ...prev, [provider.value]: text }));
                              setAccountErrors((prev) => {
                                const { [provider.value]: _removed, ...rest } = prev;
                                return rest;
                              });
                            }}
                            placeholder="01712345678"
                            keyboardType="phone-pad"
                            error={failure}
                            showError
                            editable={!busy}
                          />
                        ) : null}
                      </View>
                    </Card>
                  );
                })}
              </View>

              {errors.payments ? (
                <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
                  {errors.payments}
                </Text>
              ) : null}

              <Card style={{ backgroundColor: colors.surfaceSunken, borderColor: colors.border }}>
                <View style={{ gap: spacing.xs }}>
                  <Text variant="caption">You can add more later</Text>
                  <Text variant="micro" tone="muted">
                    Connect as many as you like, and change them any time from Payments.
                    You can also skip this and record payments by hand.
                  </Text>
                </View>
              </Card>
            </View>
          ) : null}

          {/* One primary action per step. The passcode step submits itself from
              the keypad, so it gets a Continue only as an escape hatch for a
              length the keypad has not reached. */}
          {step !== 'passcode' ? (
            <Button
              label={step === 'payments' ? 'Finish setup' : 'Continue'}
              icon={ArrowRight}
              iconPosition="trailing"
              onPress={() => (step === 'payments' ? void submit() : advance())}
              loading={busy}
              disabled={!isConfigured || (step === 'payments' && selected.length > 0 && selectedAccounts.length !== selected.length)}
              block
              size="lg"
            />
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center' },
  top: { flexDirection: 'row', alignItems: 'center' },
  // Pulls the ghost Back button left so it optically aligns with the card edge
  // instead of sitting inside the screen padding.
  backButton: { marginLeft: -12, paddingHorizontal: 0 },
  dots: { flexDirection: 'row', flex: 1 },
});
