/**
 * BD phone normalisation, client side.
 *
 * This mirrors `payment_normalize_bk_number` in migration 0022. The mirror
 * exists so the account form can show the seller the canonical form of what
 * they typed; the server normalises again and is the authority.
 *
 * It is a separate implementation on purpose — the client never sends a number
 * the server has not normalised itself — which also means the two can drift.
 * That is not hypothetical: the SQL original shipped a bug where `+8801712...`
 * normalised to `0801712...` instead of `01712...`, because `substring(x from 2)`
 * is a character offset rather than a regex capture group. Every +880 payment
 * would have failed to match. `scripts/payment-normalize.test.mjs` exists to
 * keep the mirror honest.
 */

/**
 * Canonicalises a Bangladeshi mobile number to `01XXXXXXXXX`.
 *
 * Accepts `017…`, `+88017…`, `88017…`, `171…`, and tolerates spaces and dashes.
 * Anything that is not recognisably a BD mobile number is returned as its digits
 * only — deliberately not coerced into something that could match by accident.
 */
export function normalizeBdNumber(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '');

  // +8801712345678 / 8801712345678 -> 01712345678
  if (/^8801[3-9]\d{8}$/.test(digits)) return `0${digits.slice(3)}`;
  // 1712345678 -> 01712345678
  if (/^1[3-9]\d{8}$/.test(digits)) return `0${digits}`;
  // 01712345678, already canonical
  if (/^01[3-9]\d{8}$/.test(digits)) return digits;

  return digits;
}

/**
 * Whether a typed number is a usable BD mobile number.
 *
 * Used to gate the save button, so the seller is told before submitting rather
 * than after a round trip.
 */
export function isBdMobileNumber(raw: string): boolean {
  return /^01[3-9]\d{8}$/.test(normalizeBdNumber(raw));
}

/**
 * Whether retyping the canonical form would change what the seller sees.
 *
 * The account form uses this to show "Saved as 017…" when someone typed
 * +880…, so the rewrite is visible instead of silent.
 */
export function isCanonical(raw: string): boolean {
  const trimmed = (raw ?? '').trim();
  return isBdMobileNumber(trimmed) && trimmed === normalizeBdNumber(trimmed);
}