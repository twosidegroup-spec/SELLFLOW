/**
 * Which of the seller's own accounts a detected payment belongs to.
 *
 * This is a convenience filter, not an authorisation. It exists so the app does
 * not spend a network round trip on a payment that arrived at a number this
 * business never connected, and so a seller is never told "we saw a payment" for
 * money that is not theirs.
 *
 * The server does not take any of it on trust. `ingest_payment_event` resolves the
 * organisation from `p_payment_account_id`, calls `assert_org_write`, and compares
 * the provider against the account it resolved. A forged account id is a
 * `payment_account_not_found`, not a payment.
 *
 * Both interesting cases come from the same place: most provider notifications
 * name the payer and not the payee, so the receiving number is often absent. When
 * it is, the account is identified by provider plus "exactly one connected account
 * for it", which is refused rather than guessed when a seller runs two numbers.
 */

import { normalizeBdNumber } from '@/features/payments/normalize';
import type { AccountRejection, ConnectedAccount } from './types';
import type { PaymentCandidate } from '@sellflow-sms/types';

export type AccountResolution =
  | { ok: true; accountId: string; accountNumber: string }
  | { ok: false; reason: AccountRejection };

/**
 * Resolves the account a candidate is filed against.
 *
 * `accounts` must already be the org's *active and connected* accounts -- what
 * `usePaymentAccounts().active` returns. A disconnected account is one the seller
 * has switched off, and filing an event against it would match against an account
 * they are no longer using.
 *
 * The candidate's own `receiverAccount` wins whenever the message stated one:
 * that is the number the provider said received the money, and it is what the
 * server compares against the connected account. When it is absent, provider is
 * all there is, so a provider with exactly one connected account resolves and a
 * provider with several does not.
 */
export function resolveAccount(
  candidate: PaymentCandidate,
  accounts: ConnectedAccount[],
): AccountResolution {
  const forProvider = accounts.filter(
    (account) => account.provider === candidate.provider,
  );

  if (forProvider.length === 0) {
    return { ok: false, reason: 'account_not_connected' };
  }

  if (candidate.receiverAccount) {
    const exact = forProvider.find(
      (account) =>
        normalizeBdNumber(account.accountNumber) === candidate.receiverAccount,
    );
    if (exact) {
      return { ok: true, accountId: exact.id, accountNumber: exact.accountNumber };
    }
    // The message named a receiving number this business has not connected. That
    // is somebody else's money, and guessing the nearest account would file it
    // against a ledger it does not belong to.
    return { ok: false, reason: 'account_not_connected' };
  }

  if (forProvider.length === 1) {
    return {
      ok: true,
      accountId: forProvider[0]!.id,
      accountNumber: forProvider[0]!.accountNumber,
    };
  }

  // Two bKash numbers and a message that names neither. Any answer would be a
  // coin flip with real money attached, so there is no answer.
  return { ok: false, reason: 'ambiguous_account' };
}

/**
 * A stable key for one payment, used to recognise a redelivered candidate.
 *
 * Deliberately narrow: provider, reference and amount. The account is not part of
 * it because the same transfer arriving twice must collapse into one event even if
 * the account list was reloaded in between. The server's own constraint --
 * `(provider, payment_account_id, transaction_id)` -- remains the guarantee; this
 * only stops the app doing pointless work.
 */
export function candidateIdentity(candidate: PaymentCandidate): string {
  return `${candidate.provider}|${candidate.transactionId}|${candidate.amount}`;
}