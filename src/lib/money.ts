/**
 * Money.
 *
 * Every amount in SellFlow is carried as an integer count of minor units
 * (poisha for BDT) rather than a float. `0.1 + 0.2 !== 0.3` in IEEE-754, and a
 * business tool that is off by a fraction on every order is worse than useless
 * -- so no arithmetic on money in this app ever touches a float.
 *
 * Postgres stores the authoritative value as `numeric(14,2)`, which is exact.
 * This module exists so the same exactness holds between the database and the
 * screen: values are parsed from decimal strings into integers immediately and
 * are only turned back into a string for display.
 */

/** Integer count of minor units. Always an integer; never a fraction. */
export type Money = number;

export interface Currency {
  code: string;
  symbol: string;
  /** Number of decimal places. BDT uses 2. */
  decimals: number;
}

export const CURRENCIES = {
  BDT: { code: 'BDT', symbol: 'Tk', decimals: 2 },
} as const satisfies Record<string, Currency>;

export type CurrencyCode = keyof typeof CURRENCIES;

export const DEFAULT_CURRENCY: CurrencyCode = 'BDT';

/** Zero, expressed for the given currency. */
export function zero(): Money {
  return 0;
}

/**
 * Parse a user-entered or server-returned decimal string into minor units.
 *
 * Accepts thousands separators, whitespace and a leading currency symbol, all of
 * which real sellers type. Returns `null` for anything that is not a number, so
 * callers can distinguish "empty input" from "zero".
 *
 *   toMinor('1,250.50') -> 125050
 *   toMinor('12')       -> 1200
 *   toMinor('')         -> null
 */
export function toMinor(value: string | number | null | undefined, currency: CurrencyCode = DEFAULT_CURRENCY): Money | null {
  const { decimals } = CURRENCIES[currency];
  const factor = 10 ** decimals;

  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Round rather than truncate: 2.675 * 100 is 267.49999... in binary.
    // A NUMBER is a whole-unit value arriving from a caller that has not been
    // through `toMinor` yet. `toMajor` is the way back to whole units.
    return Math.round(value * factor);
  }

  // Strip everything that is not a digit, minus or decimal point, then discard
  // any second decimal point so "1.2.3" degrades to 1.23 instead of NaN.
  let cleaned = value.replace(/[^\d.-]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
  }

  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;

  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;

  return Math.round(parsed * factor);
}

/**
 * Bangla digits, and the fact that JavaScript's `\d` does not include them.
 *
 * `\d` is ASCII-only, so a regex that "keeps the digits" silently deletes every
 * Bangla digit and leaves an empty string. That is how a quantity of ৫ became 0, and
 * 0 is a real stock level -- so the field accepted it and moved on.
 *
 * `orderForm.ts` had its own copy of this map for the same reason. There is one now.
 */
const BANGLA_DIGITS: Record<string, string> = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

/** Rewrites Bangla digits as ASCII, leaving everything else untouched. */
export function normaliseDigits(value: string): string {
  return value.replace(/[০-৯]/g, (digit) => BANGLA_DIGITS[digit] ?? digit);
}

/**
 * Parses a whole number of units, e.g. a stock count or a quantity.
 *
 * Distinct from `toMinor`, which is for MONEY and multiplies by the currency's
 * decimals. Using the money parser for a count is how a low-stock threshold of
 * 5 silently became 500.
 *
 * Bangla digits are accepted, because sellers type them and a quantity field that
 * reads ৫ as 0 is worse than one that refuses it.
 *
 * Returns 0 for empty, non-numeric, negative or non-finite input, so a stray
 * "Infinity" can never reach a database integer column.
 */
export function parseWholeNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;

  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(normaliseDigits(value).replace(/[^\d-]/g, ''), 10);

  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
}

/**
 * Parse a value that is known to be a number.
 *
 * `toMinor` returns null for input it cannot parse, which is right for form
 * fields but wrong for values coming from the database, where a missing figure
 * means zero rather than "invalid". This is the coercion for the READ path.
 *
 * READ PATH ONLY. It converts a column value (whole taka) into the minor units
 * the display layer needs, and it is the reason this module looked like it had
 * no way to write: the write path needs the opposite conversion, `toMajor`.
 * Calling `money()` on a value that is ALREADY in minor units multiplies by the
 * currency decimals a second time, and a product typed at 1,000 was stored at
 * 10,000,000. Use `toMajor` to prepare a value for a column or an RPC.
 */
export function money(value: number | null | undefined, currency: CurrencyCode = DEFAULT_CURRENCY): Money {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  const parsed = toMinor(value, currency);
  return parsed ?? 0;
}

/**
 * Format a money value that came straight off the database.
 *
 * Every money column and every RPC amount in this schema is `numeric(14,2)`, and
 * PostgREST returns that as a plain JSON number in WHOLE units: 5060 means five
 * thousand taka. `formatMoney`, by contrast, takes MINOR units, because everything
 * computed in the app is held in poisha to avoid float drift.
 *
 * Handing a column value straight to `formatMoney` therefore divides it by 100, and
 * the app shows a seller 50.60 for revenue that was actually 5,060. That is not a
 * rounding bug, it is a hundredfold lie about the one number the product exists to
 * get right, and it is invisible in a unit test because both functions are correct.
 * It was found by reading the running app against known seeded data.
 *
 * So the two paths have different names, and the database one says so:
 *
 *   formatMoney(...)       minor units -- app arithmetic, calculations, MoneyInput
 *   formatMajorUnits(...)  whole taka -- anything read from a column or an RPC
 *
 * Prefer this over wrapping in `money()`: a wrapper is invisible at the call site,
 * and the call site is exactly where the mistake gets made.
 */
export function formatMajorUnits(
  amount: number | null | undefined,
  currency: CurrencyCode = DEFAULT_CURRENCY,
  options: { showSymbol?: boolean; showZeroDecimals?: boolean } = {},
): string {
  return formatMoney(money(amount ?? 0, currency), currency, options);
}

/**
 * Convert minor units back to the whole taka a column or RPC parameter holds.
 *
 * The exact inverse of `toMinor`, and the conversion every WRITE needs. The
 * database stores `numeric(14,2)` in whole units; `toMinor` exists so the text
 * a seller types can be held exactly, in integers, while they are still editing
 * it. Anything that crosses the wire has to come back to whole units first.
 *
 *   toMajor(toMinor('1,250.50')) -> 1250.5   // exactly what the column wants
 *
 * Safe on a boundary: `amount` is always a whole number of minor units, and the
 * divisor is a power of ten no larger than the magnitude involved, so no
 * precision is lost.
 */
export function toMajor(amount: Money, currency: CurrencyCode = DEFAULT_CURRENCY): number {
  return amount / 10 ** CURRENCIES[currency].decimals;
}

/**
 * Format minor units for display.
 *
 * Uses Intl so digit grouping matches the seller's locale. Falls back to a
 * manual implementation on engines without full ICU, which is the difference
 * between "Tk1,250.50" and a crash on a low-end Android device.
 */
export function formatMoney(
  amount: Money,
  currency: CurrencyCode = DEFAULT_CURRENCY,
  options: { showSymbol?: boolean; showZeroDecimals?: boolean } = {},
): string {
  const config = CURRENCIES[currency];
  const { showSymbol = true, showZeroDecimals = false } = options;

  const negative = amount < 0;
  const major = Math.abs(amount) / 10 ** config.decimals;
  const digits = showZeroDecimals ? 0 : config.decimals;

  // Intl already emits the fraction digits, so its output IS the body. Appending
  // a separately-computed fraction on top of it is what produced "Tk9,440.00.00"
  // for every amount in the app.
  let body: string;
  try {
    body = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    body = major
      .toFixed(digits)
      .replace(/\B(?=(\d{3})+(?!\d)\.)/g, ',');
  }

  const sign = negative ? '-' : '';
  return showSymbol ? `${sign}${config.symbol}${body}` : `${sign}${body}`;
}

/**
 * A short form for places where the exact amount is not the point: a dashboard
 * caption, a sparkline label, a chart axis.
 *
 * Takes MINOR units, like every other formatter here, and says so by rounding to
 * one decimal alongside a k/M suffix. Two previous hand-rolled copies of this
 * took major units while their callers passed the result of `money()`, which is
 * what made "Unpaid to you" read Tk4.2M for a balance of Tk42,000.
 */
export function formatCompactMoney(
  amount: Money,
  currency: CurrencyCode = DEFAULT_CURRENCY,
): string {
  const config = CURRENCIES[currency];
  const major = Math.abs(amount) / 10 ** config.decimals;
  const sign = amount < 0 ? '-' : '';
  const symbol = config.symbol;

  if (major >= 1_000_000) return `${sign}${symbol}${round1(major / 1_000_000)}M`;
  // The rounded value decides the bucket, so Tk999.60 never renders as
  // "Tk1,000" beside a genuine "Tk1.0k".
  if (Math.round(major) >= 1000) return `${sign}${symbol}${round1(major / 1000)}k`;
  if (major >= 100) return `${sign}${symbol}${group(Math.round(major))}`;
  if (major > 0) return `${sign}${symbol}${round1(major)}`;
  return `${sign}${symbol}0`;
}

/** One decimal, but never a trailing ".0" -- "1.5k", not "1.50k". */
function round1(value: number): string {
  const text = value.toFixed(1);
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

/** Thousands grouping, degrading to a plain string without full ICU. */
function group(value: number): string {
  try {
    return value.toLocaleString();
  } catch {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
}

/**
 * Options for a whole-taka amount in a dense list or a sentence.
 *
 * Cents are noise when the row already says "cost" or "margin" next to the
 * figure, and dropping them keeps a price column from wrapping. Callers still
 * get the currency symbol, which is the part that was previously missing: a
 * bare "1150" on a catalogue row is indistinguishable from a stock count.
 */
export const EXACT = { showZeroDecimals: true } as const;

/**
 * Format for use inside a text input.
 *
 * No symbol and no grouping: both fight with the caret and force the value to
 * reflow while the user is mid-edit. Never use this for display: an amount
 * printed this way has no currency and reads as a bare number.
 */
export function formatForInput(amount: Money, currency: CurrencyCode = DEFAULT_CURRENCY): string {
  const { decimals } = CURRENCIES[currency];
  if (amount === 0) return '';
  return (amount / 10 ** decimals).toFixed(decimals).replace(/\.?0+$/, '');
}

// --- Arithmetic -------------------------------------------------------------
// All operations return Money and never leave integer space.

export function add(...values: Money[]): Money {
  return values.reduce<Money>((total, value) => total + Math.round(value), 0);
}

export function subtract(minuend: Money, subtrahend: Money): Money {
  return Math.round(minuend) - Math.round(subtrahend);
}

export function negate(value: Money): Money {
  return -Math.round(value);
}

/** Multiply by a whole quantity. Rounds half away from zero. */
export function multiply(amount: Money, quantity: number): Money {
  return Math.round(Math.round(amount) * quantity);
}

/** Percentage of an amount, e.g. a 10% discount. */
export function percentage(amount: Money, percent: number): Money {
  return Math.round((Math.round(amount) * percent) / 100);
}

export function isNegative(amount: Money): boolean {
  return amount < 0;
}

export function isPositive(amount: Money): boolean {
  return amount > 0;
}

export function equals(a: Money, b: Money): boolean {
  return a === b;
}

export function max(a: Money, b: Money): Money {
  return a >= b ? a : b;
}

export function min(a: Money, b: Money): Money {
  return a <= b ? a : b;
}

export function clampToZero(value: Money): Money {
  return value < 0 ? 0 : value;
}

/**
 * Distribute an amount across weights without losing or inventing minor units.
 *
 * The order-level discount has to be shared out over the line items so that the
 * lines still add back up to the order total. Handing the remainder to the
 * last line is what makes `sum(lines) === total` hold exactly, rather than off
 * by a single poisha.
 */
export function distribute(amount: Money, weights: number[]): Money[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0 || amount === 0) return weights.map(() => 0);

  const total = Math.round(amount);
  let allocated = 0;
  const shares = weights.map((weight) => {
    const share = Math.floor((total * weight) / totalWeight);
    allocated += share;
    return share;
  });

  let remainder = total - allocated;
  // Spread any leftover one unit at a time, largest weight first.
  const order = weights
    .map((weight, index) => ({ weight, index }))
    .sort((a, b) => b.weight - a.weight);

  let cursor = 0;
  while (remainder > 0 && order.length > 0) {
    const target = order[cursor % order.length];
    if (target) {
      const current = shares[target.index];
      if (current !== undefined) {
        shares[target.index] = current + 1;
      }
    }
    remainder -= 1;
    cursor += 1;
  }

  return shares;
}

/** Sum an array of amounts. */
export function sum(values: Money[]): Money {
  return values.reduce<Money>((total, value) => total + value, 0);
}
