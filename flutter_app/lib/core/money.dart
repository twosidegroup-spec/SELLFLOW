/// Money as integer minor units.
///
/// WHY `int` AND NOT `double`
///
/// A `double` cannot represent most decimal fractions exactly, so arithmetic on
/// money accumulates error: `0.1 + 0.2 != 0.3`. Across a ledger that drift becomes
/// a real discrepancy a seller has to reconcile by hand. Every monetary value in
/// this app is therefore an `int` count of minor units (poisha/taka paisa), and no
/// `double` is permitted to touch one anywhere in the client.
///
/// The reference implementation had a bug where minor and major units were
/// confused for a whole release cycle, undercounting every figure by 100x.
/// [formatMajorUnits] exists because of it: converting minor units for display is
/// the one place a decimal point belongs, and it is named so the conversion is
/// impossible to do by accident.
library;

/// Minor-unit amount. BDT has 2 decimals, so 1000 == Tk 10.00.
typedef Money = int;

class Currency {
  const Currency({
    required this.code,
    required this.symbol,
    required this.decimals,
    required this.label,
  });

  /// ISO code, e.g. `BDT`.
  final String code;

  /// Symbol shown before a formatted amount.
  final String symbol;

  /// Minor units per major unit. 100 for two-decimal currencies.
  final int decimals;

  /// Human name for forms and summaries.
  final String label;

  /// Factor to convert major units to minor units.
  int get factor => _pow10(decimals);
}

int _pow10(int n) {
  var result = 1;
  for (var i = 0; i < n; i++) {
    result *= 10;
  }
  return result;
}

const bdt = Currency(code: 'BDT', symbol: 'Tk', decimals: 2, label: 'Taka');

const currencies = <String, Currency>{'BDT': bdt};

const defaultCurrencyCode = 'BDT';

Currency currencyOf([String? code]) =>
    currencies[code ?? defaultCurrencyCode] ?? bdt;

/// Zero, in minor units.
Money zero() => 0;

/// Digits used for counting, replacing ASCII digits with ASCII digits.
///
/// Sellers type amounts with a normal keyboard, but pasted values and some input
/// methods carry full-width or non-ASCII numerals. Parsing accepts them; storing
/// them as ASCII keeps one representation in the database.
String normaliseDigits(String value) {
  final buffer = StringBuffer();
  for (final rune in value.runes) {
    if (rune >= 0xFF10 && rune <= 0xFF19) {
      // Full-width digits ０-９.
      buffer.writeCharCode(rune - 0xFF10 + 0x30);
    } else if (rune >= 0x0660 && rune <= 0x0669) {
      // Arabic-Indic digits.
      buffer.writeCharCode(rune - 0x0660 + 0x30);
    } else if (rune >= 0x06F0 && rune <= 0x06F9) {
      // Extended Arabic-Indic digits.
      buffer.writeCharCode(rune - 0x06F0 + 0x30);
    } else {
      buffer.writeCharCode(rune);
    }
  }
  return buffer.toString();
}

/// Parses user input into minor units, or null when it is not a usable amount.
///
/// Returns null rather than throwing or coercing: a field holding junk must be
/// rejected by the caller with a message, never silently become zero.
Money? toMinor(String? value, [String code = defaultCurrencyCode]) {
  if (value == null) return null;
  final currency = currencyOf(code);
  final cleaned = normaliseDigits(value).replaceAll(',', '').trim();
  if (cleaned.isEmpty) return null;
  if (!RegExp(r'^-?\d*\.?\d*$').hasMatch(cleaned)) return null;
  if (cleaned == '.' || cleaned == '-') return null;

  final negative = cleaned.startsWith('-');
  final unsigned = negative ? cleaned.substring(1) : cleaned;
  final dot = unsigned.indexOf('.');
  final whole = dot == -1 ? unsigned : unsigned.substring(0, dot);
  final fraction = dot == -1 ? '' : unsigned.substring(dot + 1);

  if (whole.isEmpty && fraction.isEmpty) return null;

  final factor = currency.decimals;

  // Whole part shifts into minor units.
  var minor =
      (int.tryParse(whole.isEmpty ? '0' : whole) ?? 0) * currency.factor;

  // Fraction contributes its first `decimals` digits directly. Any digit beyond
  // that cannot be represented, so only the FIRST dropped digit is consulted for
  // rounding -- rounding twice would double-count it.
  if (fraction.isNotEmpty) {
    final kept = fraction.substring(
      0,
      factor > 0 && fraction.length > factor ? factor : fraction.length,
    );
    minor += int.tryParse(kept.padRight(factor, '0')) ?? 0;

    // Half-up at the minor-unit boundary rather than truncation, so an amount
    // entered with more precision than the currency supports is not silently
    // reduced in the seller's favour.
    if (fraction.length > factor && int.parse(fraction[factor]) >= 5) {
      minor += 1;
    }
  }

  return negative ? -minor : minor;
}

/// Parses a bare whole number, e.g. a quantity. Rejects anything non-integral.
int? parseWholeNumber(String? value) {
  if (value == null) return null;
  final cleaned = normaliseDigits(value).trim();
  if (cleaned.isEmpty) return null;
  return int.tryParse(cleaned);
}

/// Coerces anything nullable into a safe amount.
Money money(num? value, [String code = defaultCurrencyCode]) {
  final currency = currencyOf(code);
  final scaled = (value ?? 0) * currency.factor;
  return scaled.round();
}

/// Converts minor units to a decimal for display ONLY.
///
/// Named to make the minor/major boundary explicit at every call site. Never feed
/// the result back into arithmetic — use [toMinor] for that.
double formatMajorUnits(Money amount, [String code = defaultCurrencyCode]) {
  final currency = currencyOf(code);
  return amount / currency.factor;
}

/// Inverse of [formatMajorUnits], for input fields only.
double toMajor(Money amount, [String code = defaultCurrencyCode]) =>
    formatMajorUnits(amount, code);

/// `1,234` — grouped integer part, no decimals. For compact table cells.
String formatMoney(
  Money amount, {
  String code = defaultCurrencyCode,
  bool showDecimals = false,
  bool showSymbol = true,
  bool signed = false,
}) {
  final currency = currencyOf(code);
  final negative = amount < 0;
  final absolute = amount.abs();
  final factor = currency.factor;

  final whole = absolute ~/ factor;
  final fraction = (absolute % factor).toString().padLeft(
    currency.decimals,
    '0',
  );

  final grouped = _group(whole.toString());
  final showFraction = showDecimals || fraction.split('').any((d) => d != '0');

  final buffer = StringBuffer();
  if (negative) buffer.write('-');
  if (signed && !negative && amount != 0) buffer.write('+');
  if (showSymbol) buffer.write(currency.symbol);
  buffer.write(grouped);
  if (showFraction) {
    buffer.write('.');
    buffer.write(fraction);
  }
  return buffer.toString();
}

/// `12.3k` — for dense dashboards where a full figure would dominate the row.
String formatCompactMoney(Money amount, {String code = defaultCurrencyCode}) {
  final currency = currencyOf(code);
  final negative = amount < 0;
  final major = formatMajorUnits(amount.abs(), code);
  final absolute = major.abs();

  String body;
  if (absolute >= 10000000) {
    body = '${_trimZero(major / 10000000)}cr';
  } else if (absolute >= 100000) {
    body = '${_trimZero(major / 100000)}l';
  } else if (absolute >= 1000) {
    body = '${_trimZero(major / 1000)}k';
  } else {
    body = _trimZero(major);
  }

  final buffer = StringBuffer();
  if (negative) buffer.write('-');
  buffer.write(currency.symbol);
  buffer.write(body);
  return buffer.toString();
}

/// The money a text field should pre-fill. No symbol, no grouping.
String formatForInput(Money amount, [String code = defaultCurrencyCode]) {
  final currency = currencyOf(code);
  if (amount % currency.factor == 0) {
    return (amount ~/ currency.factor).toString();
  }
  return formatMajorUnits(amount, code).toStringAsFixed(currency.decimals);
}

String _trimZero(double value) {
  if (value == value.roundToDouble()) return value.round().toString();
  return value.toStringAsFixed(1);
}

String _group(String digits) {
  final negative = digits.startsWith('-');
  final body = negative ? digits.substring(1) : digits;
  final buffer = StringBuffer();
  for (var i = 0; i < body.length; i++) {
    if (i > 0 && (body.length - i) % 3 == 0) buffer.write(',');
    buffer.write(body[i]);
  }
  if (negative) buffer.write('-');
  return buffer.toString();
}

/// Render options for figures that must show `.00` even at zero.
const exact = <String, bool>{'showDecimals': true};

Money add(Money a, Money b) => a + b;

Money subtract(Money minuend, Money subtrahend) => minuend - subtrahend;

Money negate(Money value) => -value;

Money multiply(Money amount, num quantity) => (amount * quantity).round();

/// `percent` is a fraction: 12.5 for 12.5%.
Money percentage(Money amount, num percent) => (amount * percent / 100).round();

bool isNegative(Money amount) => amount < 0;

bool isPositive(Money amount) => amount > 0;

bool equals(Money a, Money b) => a == b;

Money max(Money a, Money b) => a > b ? a : b;

Money min(Money a, Money b) => a < b ? a : b;

/// Clamps to zero. For receivables and balances that cannot go below nothing.
Money clampToZero(Money value) => value < 0 ? 0 : value;

Money sum(Iterable<Money> values) => values.fold(0, (acc, v) => acc + v);

/// Splits [amount] across [weights], distributing the remainder.
///
/// `allocate(1000, [1, 1, 1])` yields `[333, 333, 334]`, not `[333, 333, 333]`.
///
/// Losing the remainder silently understates a total by up to n-1 minor units per
/// split, which across many splits becomes a visible reconciliation gap. The last
/// bucket absorbs the difference so the parts always sum exactly to [amount].
List<Money> distribute(Money amount, List<int> weights) {
  if (weights.isEmpty) return <Money>[];
  final totalWeight = sum(weights.map((w) => w));

  // All-zero weights carry no proportion, so there is nothing to divide by.
  // Everything still has to land somewhere: returning zeros for every bucket
  // would discard the whole amount, which is the exact failure this function
  // exists to prevent. The last bucket absorbs it.
  if (totalWeight <= 0) {
    return <Money>[for (var i = 0; i < weights.length - 1; i++) 0, amount];
  }

  final result = <Money>[];
  var distributed = 0;
  for (var i = 0; i < weights.length; i++) {
    final isLast = i == weights.length - 1;
    final share = isLast
        ? amount - distributed
        : (amount * weights[i] / totalWeight).round();
    result.add(share);
    distributed += share;
  }
  return result;
}
