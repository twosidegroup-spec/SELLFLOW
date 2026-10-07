/// Bangladeshi phone-number normalisation.
///
/// WHY THIS EXISTS SEPARATELY FROM `money`
///
/// A payment SMS carries the payer/receiver number in whatever form the provider
/// chose: `+8801711000111`, `8801711000111`, `01711000111`, `1711000111`. If the
/// same seller connects their account as `01711000111` and a message arrives as
/// `+8801711000111`, a naive string comparison fails and the payment is dropped as
/// "not connected to you" — silently, for every payment.
///
/// So every number that reaches an account lookup or a candidate match passes
/// through [normalizeBdNumber] first. Account matching that skips this is a bug.
library;

/// Canonical form: `01XXXXXXXXX` (11 digits).
const _expectedLength = 11;

/// Converts any accepted form of a BD number to `01XXXXXXXXX`.
///
/// Returns the input trimmed of separators when it cannot be canonicalised, so a
/// malformed number still compares deterministically against itself rather than
/// collapsing to an empty string that might match an unset field.
String normalizeBdNumber(String raw) {
  var digits = raw.replaceAll(RegExp(r'[\s\-()]'), '');

  // Strip a leading `+` or `00` international prefix.
  if (digits.startsWith('+')) {
    digits = digits.substring(1);
  } else if (digits.startsWith('00')) {
    digits = digits.substring(2);
  }

  // `8801XXXXXXXXX` (13 digits) and `01XXXXXXXXX` both reduce to a 10-digit national
  // number, so the trunk zero is re-added once below.
  if (digits.startsWith('880')) {
    digits = digits.substring(3);
  }

  if (digits.length == 10 && digits.startsWith('1')) {
    digits = '0$digits';
  }

  return digits;
}

/// Whether [raw] looks like a usable BD mobile number.
bool isBdMobileNumber(String raw) {
  final normalized = normalizeBdNumber(raw);
  if (normalized.length != _expectedLength) return false;
  if (!RegExp(r'^01[3-9]\d{8}$').hasMatch(normalized)) return false;
  return true;
}

/// Whether [raw] is already in canonical `01XXXXXXXXX` form.
bool isCanonical(String raw) => RegExp(r'^01[3-9]\d{8}$').hasMatch(raw);
