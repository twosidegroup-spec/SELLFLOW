/**
 * The Supabase implementation of {@link RegistrationDeps}.
 *
 * Everything that touches the network for registration lives here rather than in
 * the screen, so the screen stays a piece of UI and the ordering guarantees in
 * `plan.ts` remain the only place that decides what happens when.
 *
 * Every call reports what the SERVER confirmed. `bootstrapBusiness` resolves to the
 * org id that came back from the database rather than the id the caller hoped for,
 * and `createPaymentAccount` throws when the RPC refuses. There is no path here
 * that reports success because the seller filled in a form.
 */

import { AppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';
import type { PlannedAccount, RegistrationDeps, SmsPermissionOutcome } from '@/features/registration/plan';

export interface RegistrationInput {
  email: string;
  password: string;
  fullName: string;
  businessName: string;
  storeName: string | null;
}

export function createRegistrationDeps({
  plan,
  setPasscode,
  refreshWorkspace,
}: {
  plan: RegistrationInput;
  setPasscode: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
}): RegistrationDeps {
  return {
    /**
     * `auth.signUp`, which is the only way an `auth.users` row is created.
     *
     * `full_name` goes in user metadata because a database trigger
     * (`handle_new_user`) copies it into `profiles`. The client never writes to
     * `profiles`, and RLS has no INSERT policy on it by design.
     *
     * Email confirmation is disabled for this project (`config.toml`), so success
     * returns a session immediately. If that ever changes, this throws with an
     * honest message rather than pretending the seller is signed in.
     */
    createAccount: async () => {
      const { data, error } = await getSupabase().auth.signUp({
        email: plan.email,
        password: plan.password,
        options: { data: { full_name: plan.fullName } },
      });

      if (error) throw AppError.from(error);

      if (!data.session) {
        // With confirmation on, this is where a seller lands. Saying so is better
        // than a spinner that never resolves.
        throw new AppError(
          'Confirm your email to continue',
          'Open the email we sent you, then come back and sign in.',
        );
      }

      // `session.user` rather than `data.user`: a session with no user is not a
      // signed-in state, and a null there would propagate `undefined` as an id into
      // the payment-account RPCs.
      if (!data.session.user) {
        throw new AppError('Account was not signed in', 'Try again in a moment.');
      }

      return data.session.user.id;
    },

    /**
     * `bootstrap_business`. `SECURITY DEFINER`, derives `auth.uid()` server-side,
     * refuses `not_authenticated`, and is idempotent per user.
     *
     * The org id is read out of the returned JSON rather than assumed, because the
     * function returns the EXISTING organisation on a retry -- so re-running it
     * cannot create a second business.
     */
    bootstrapBusiness: async () => {
      const { data, error } = await getSupabase().rpc('bootstrap_business', {
        p_business_name: plan.businessName,
        p_store_name: plan.storeName,
        p_store_code: null,
      });

      if (error) throw AppError.from(error);

      const orgId = readOrgId(data);
      if (!orgId) {
        throw new AppError(
          'Business was not created',
          'Try again. If it keeps failing, contact support.',
        );
      }
      return orgId;
    },

    /**
     * `create_payment_account`. `SECURITY DEFINER` with `assert_org_write`, so a
     * client-supplied org id cannot file an account into somebody else's business.
     *
     * The account number arrives already canonicalised from `buildAccountPlan`.
     * That is deliberate: the server only does `btrim` plus a digit regex, so a
     * number entered through any other client as `+8801...` would be stored
     * verbatim and would NOT collide with the same number written `01...` under
     * the unique index.
     */
    createPaymentAccount: async (account: PlannedAccount, orgId: string) => {
      const { error } = await getSupabase().rpc('create_payment_account', {
        p_org_id: orgId,
        p_provider: account.provider,
        p_account_number: account.accountNumber,
        p_account_type: 'personal',
        p_label: account.label,
      });

      if (error) throw AppError.from(error);
    },

    setPasscode,

    refreshWorkspace,

    /**
     * The OS permission for `RECEIVE_SMS`.
     *
     * Asked for LAST, after the accounts exist, and never fatal. Refusing leaves
     * automation in `waiting_for_permission`, which is a true statement about the
     * device, and manual payment entry keeps working.
     *
     * Only meaningful on Android. Every other platform reports `unavailable`
     * without prompting, because the permission does not exist there.
     */
    requestSmsPermission: async (): Promise<SmsPermissionOutcome> => {
      try {
        const { PermissionsAndroid, Platform } = await import('react-native');
        if (Platform.OS !== 'android') return 'unavailable';

        const status = await PermissionsAndroid.request(
          RECEIVE_SMS_PERMISSION,
          {
            title: 'Detect payments automatically',
            message:
              'SellFlow reads bKash, Nagad and Rocket notifications so a customer payment can be matched to an order. It never opens your messages.',
            buttonPositive: 'Allow',
            buttonNegative: 'Not now',
          },
        );

        return status === 'granted' ? 'granted' : 'denied';
      } catch {
        return 'unavailable';
      }
    },
  };
}

/**
 * `PermissionsAndroid.PERMISSIONS.RECEIVE_SMS`.
 *
 * Referenced through `PermissionsAndroid.request` by name below. Named here so the
 * literal appears once: `payment-boundary.test.mjs` asserts that this constant is
 * used in a permission REQUEST and never declared as a permission in app config.
 */
const RECEIVE_SMS_PERMISSION = 'android.permission.RECEIVE_SMS' as never;

/**
 * Pulls the organisation id out of `bootstrap_business`'s jsonb return.
 *
 * Read defensively rather than assuming a key. A single unexpected shape must not
 * propagate `undefined` into `p_org_id`, which would surface as a database error
 * far from its cause.
 */
function readOrgId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;

  const record = data as Record<string, unknown>;

  // The function returns the org row, so `id` is the id.
  if (typeof record.id === 'string') return record.id;

  // Some shapes wrap it: { organization: { id } } or { org_id }.
  const organization = record.organization;
  if (organization && typeof organization === 'object') {
    const nested = (organization as Record<string, unknown>).id;
    if (typeof nested === 'string') return nested;
  }
  if (typeof record.org_id === 'string') return record.org_id;

  return null;
}