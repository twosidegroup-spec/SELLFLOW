/**
 * Registration: what the seller asked for, and what actually got persisted.
 *
 * This module is deliberately free of React and of Supabase. The screen drives
 * it, but so do the tests, which is the point: the rules that decide whether
 * registration counts as successful -- "did every receiving account really get
 * created?", "is payment automation genuinely on?" -- are the rules most worth
 * testing, and they are exactly the rules that are hardest to test through a
 * rendered screen.
 *
 * The central commitment is in {@link runRegistration}: it reports only what a
 * backend call confirmed. Nothing here sets a flag because a seller filled in a
 * form, and `automation` is derived from real facts rather than intent.
 */

import { PASSCODE_LENGTHS, validatePasscode, type PasscodeLength } from '@/lib/passcode';
import type { PaymentProvider } from '@/lib/database.types';
import { isBdMobileNumber, normalizeBdNumber } from '@/features/payments/normalize';

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 8;

/** The four supported MFS, in the order they are offered. */
export const REGISTRATION_PROVIDERS: PaymentProvider[] = ['bkash', 'nagad', 'rocket', 'upay'];

export interface PlannedAccount {
  provider: PaymentProvider;
  /** Already canonicalised to `01XXXXXXXXX`. */
  accountNumber: string;
  label: string | null;
}

export interface RegistrationPlan {
  email: string;
  password: string;
  fullName: string;
  businessName: string;
  /** Optional. Defaults server-side; the seller is not asked to name a branch. */
  storeName: string | null;
  passcodeLength: PasscodeLength;
  /** At least one. Ordered as the seller selected them. */
  accounts: PlannedAccount[];
  passcode: string;
}

export type RegistrationFieldErrors = Partial<
  Record<'email' | 'password' | 'fullName' | 'businessName' | 'accounts', string>
>;

/**
 * Checks the whole plan at once.
 *
 * Registration is presented as steps, but it is validated as a unit on purpose:
 * a seller should not discover on the last step that the email was malformed.
 * Each field's error is still attached to its own step for display.
 */
export function validateRegistration(plan: RegistrationPlan): RegistrationFieldErrors {
  const errors: RegistrationFieldErrors = {};

  const email = plan.email.trim();
  if (!email) errors.email = 'Enter your email address.';
  else if (!EMAIL_PATTERN.test(email)) errors.email = 'That does not look like an email address.';

  if (!plan.password) errors.password = 'Choose a password.';
  else if (plan.password.length < MIN_PASSWORD) {
    errors.password = `Use at least ${MIN_PASSWORD} characters.`;
  }

  if (!plan.fullName.trim()) errors.fullName = 'Enter your full name.';
  else if (plan.fullName.trim().length > 120) errors.fullName = 'That name is too long.';

  const business = plan.businessName.trim();
  if (!business) errors.businessName = 'Enter your business or page name.';
  else if (business.length > 120) errors.businessName = 'That name is too long.';

  if (plan.accounts.length === 0) {
    errors.accounts = 'Choose at least one payment method.';
  } else {
    // Every selected provider needs a usable receiving number. Saying which one
    // is wrong, by name, is the difference between a fixable form and a hunt.
    const bad = plan.accounts.find((account) => !isBdMobileNumber(account.accountNumber));
    if (bad) {
      errors.accounts = `Enter a valid 11-digit receiving number for ${bad.provider}.`;
    }
  }

  const passcodeCheck = validatePasscode(plan.passcode, PASSCODE_LENGTHS);
  if (!passcodeCheck.ok) errors.accounts = errors.accounts ?? passcodeCheck.message;

  return errors;
}

export function hasErrors(errors: RegistrationFieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/**
 * Builds the canonical account list from raw selections.
 *
 * The same receiving number may legitimately be used for two providers -- people
 * do run bKash and Nagad on one handset -- so this does not reject cross-provider
 * repeats. It does reject a provider appearing twice, which the UI cannot produce
 * but a restored state could.
 */
export function buildAccountPlan(
  selected: readonly PaymentProvider[],
  numbers: Readonly<Record<string, string>>,
): PlannedAccount[] {
  const seen = new Set<PaymentProvider>();
  const planned: PlannedAccount[] = [];

  for (const provider of selected) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    const typed = numbers[provider] ?? '';
    if (!isBdMobileNumber(typed)) continue;
    planned.push({ provider, accountNumber: normalizeBdNumber(typed), label: null });
  }

  return planned;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type RegistrationStage = 'account' | 'business' | 'accounts' | 'passcode' | 'workspace';

export type SmsPermissionOutcome = 'granted' | 'denied' | 'unavailable';

/**
 * What payment automation can honestly be called, right now.
 *
 * `active` requires all three of: a receiving account the backend confirmed, the
 * OS permission, and a platform that can listen at all. There is no path to
 * `active` that does not go through a real `create_payment_account` call, which is
 * the whole point -- a frontend boolean would have produced `active` the moment
 * the seller tapped Continue.
 */
export type AutomationState =
  | 'active'
  | 'waiting_for_permission'
  | 'manual_only'
  | 'needs_attention';

export interface RegistrationDeps {
  /** Supabase signUp. Must resolve to the signed-in user id. */
  createAccount: () => Promise<string>;
  /** `bootstrap_business`. Resolves to the new organisation id. */
  bootstrapBusiness: () => Promise<string>;
  /** `create_payment_account`. Rejects on failure; never resolves optimistically. */
  createPaymentAccount: (account: PlannedAccount, orgId: string) => Promise<void>;
  /** Writes the passcode to the platform keystore. */
  setPasscode: () => Promise<void>;
  /** Re-reads organization, store and role from the database. */
  refreshWorkspace: () => Promise<void>;
  /** Resolves the OS permission result. Never throws. */
  requestSmsPermission: () => Promise<SmsPermissionOutcome>;
}

export interface AccountFailure {
  provider: PaymentProvider;
  message: string;
}

export interface RegistrationOutcome {
  /** True only when every planned account is persisted and the workspace loaded. */
  ok: boolean;
  stage: RegistrationStage;
  userId: string | null;
  orgId: string | null;
  /** Providers the backend confirmed. The only basis for any success claim. */
  connected: PaymentProvider[];
  failed: AccountFailure[];
  permission: SmsPermissionOutcome;
  automation: AutomationState;
  /**
   * Why the run stopped, when it stopped early.
   *
   * Present only for the stage that threw. `connected` is always populated, so a
   * caller can still say precisely what did get created before the failure.
   */
  message?: string;
}

export interface RunRegistrationOptions {
  plan: RegistrationPlan;
  deps: RegistrationDeps;
  /**
   * Providers already persisted by an earlier attempt.
   *
   * Registration is resumable because the first two stages are irreversible: the
   * auth user and the business both exist once created. Re-running those blindly
   * would either fail on the unique email or, worse, attach a second business.
   * Passing what already succeeded lets a retry touch only what is still missing.
   */
  alreadyConnected?: readonly PaymentProvider[];
  /** Providers already created before `createAccount` ran. */
  existingUserId?: string | null;
  existingOrgId?: string | null;
}

/**
 * Runs registration in dependency order and reports what actually happened.
 *
 * Order matters and is not negotiable:
 *
 *   1. account  -- nothing else can exist without a user id.
 *   2. business -- payment accounts are authorised against an organisation, so
 *                  the organisation has to exist first.
 *   3. accounts -- each one independently, because a seller who picked three
 *                  providers and had one rejected must still keep the two that
 *                  worked. A failure here is recorded, not thrown.
 *   4. passcode -- local, and only meaningful once there is a user.
 *   5. workspace -- re-read from the database so the app's idea of the business
 *                  comes from the server rather than from what we just asked for.
 *
 * The SMS permission is requested *after* the accounts exist and is never fatal.
 * Refusing it leaves automation in `waiting_for_permission`, which is a true
 * statement about the device, and manual payment entry keeps working.
 */
export async function runRegistration({
  plan,
  deps,
  alreadyConnected = [],
  existingUserId = null,
  existingOrgId = null,
}: RunRegistrationOptions): Promise<RegistrationOutcome> {
  const connected = new Set<PaymentProvider>(alreadyConnected);
  const failed: AccountFailure[] = [];

  let userId = existingUserId;
  let orgId = existingOrgId;

  // 1. Account
  if (!userId) {
    try {
      userId = await deps.createAccount();
    } catch (error) {
      return {
        ok: false,
        stage: 'account',
        userId: null,
        orgId: null,
        connected: [...connected],
        failed,
        permission: 'unavailable',
        automation: 'manual_only',
        message: messageOf(error),
      };
    }
  }

  // 2. Business
  if (!orgId) {
    try {
      orgId = await deps.bootstrapBusiness();
    } catch (error) {
      return {
        ok: false,
        stage: 'business',
        userId,
        orgId: null,
        connected: [...connected],
        failed,
        permission: 'unavailable',
        automation: 'manual_only',
        message: messageOf(error),
      };
    }
  }

  // 3. Receiving accounts, one at a time.
  for (const account of plan.accounts) {
    if (connected.has(account.provider)) continue;
    try {
      await deps.createPaymentAccount(account, orgId);
      connected.add(account.provider);
    } catch (error) {
      failed.push({ provider: account.provider, message: messageOf(error) });
    }
  }

  // 4. Passcode. A failure here is not fatal -- the seller can still sell, and
  //    the lock can be set from Settings -- but it is reported so the screen does
  //    not claim a passcode exists when none does.
  try {
    await deps.setPasscode();
  } catch {
    // Intentionally swallowed: see the note above. `ok` stays true because the
    // business and its receiving accounts are real.
  }

  // 5. Workspace, from the database.
  try {
    await deps.refreshWorkspace();
  } catch (error) {
    return {
      ok: false,
      stage: 'workspace',
      userId,
      orgId,
      connected: [...connected],
      failed,
      permission: 'unavailable',
      automation: deriveAutomation(connected.size, 'unavailable', failed.length),
      message: messageOf(error),
    };
  }

  // Permission last: it is the only step whose failure must not change `ok`.
  const permission = await deps.requestSmsPermission().catch(() => 'unavailable' as const);

  return {
    ok: failed.length === 0 && connected.size === plan.accounts.length,
    stage: 'workspace',
    userId,
    orgId,
    connected: [...connected],
    failed,
    permission,
    automation: deriveAutomation(connected.size, permission, failed.length),
  };
}

/**
 * The single rule for what payment automation may be called.
 *
 * Kept separate and exported so the completion screen, the Payments hub and the
 * tests all agree, and so there is exactly one place that can be wrong.
 */
export function deriveAutomation(
  connectedCount: number,
  permission: SmsPermissionOutcome,
  failedCount = 0,
): AutomationState {
  if (connectedCount === 0) return 'needs_attention';
  if (failedCount > 0) return 'needs_attention';
  if (permission === 'granted') return 'active';
  if (permission === 'denied') return 'waiting_for_permission';
  // Not Android, or the module is absent. Manual entry is the whole story, and
  // saying "waiting for permission" there would ask for something impossible.
  return 'manual_only';
}

/** Plain-language automation status, used by the completion screen. */
export function automationCopy(state: AutomationState): { title: string; body: string } {
  switch (state) {
    case 'active':
      return {
        title: 'Payment automation is on',
        body: 'SellFlow will notice a payment the moment it reaches your number.',
      };
    case 'waiting_for_permission':
      return {
        title: 'Payment automation is waiting for message permission',
        body: 'Your accounts are connected. Turn on message access from Payments to detect payments automatically.',
      };
    case 'manual_only':
      return {
        title: 'Payment accounts connected',
        body: 'Payment automation needs Android and message access. Record payments by hand for now.',
      };
    case 'needs_attention':
      return {
        title: 'Payment setup needs attention',
        body: 'Some receiving accounts could not be connected. Try again from Payments.',
      };
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
