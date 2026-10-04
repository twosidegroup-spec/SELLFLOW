/**
 * Error handling.
 *
 * Requirement: never show a raw database error, never fail silently. Every
 * failure surfaces as an `AppError` with two fields -- what happened, and what
 * the user can do about it.
 *
 * The database raises stable machine-readable messages (`insufficient_stock`,
 * `overpayment`, ...) with a human `hint`. Postgres does not expose `hint`
 * through PostgREST, so the message is mapped here and the mapping is the
 * single place where server and client wording are kept in sync.
 */

import type { PostgrestError } from '@supabase/supabase-js';

/** A failure the UI can render directly. */
export class AppError extends Error {
  readonly title: string;
  /** What the user can do next. Always actionable. */
  readonly action: string;
  /** Preserved for logging. Never rendered. */
  override readonly cause?: unknown;

  constructor(title: string, action: string, options?: { cause?: unknown }) {
    super(title, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.title = title;
    this.action = action;
    this.cause = options?.cause;
  }

  static from(error: unknown): AppError {
    if (error instanceof AppError) return error;

    // Auth is checked FIRST, and deliberately. A `PostgrestError` is recognised
    // by having `code` and `message` -- and supabase-js's `AuthApiError` has
    // both, so with PostgREST first, every wrong password was routed to the
    // database mapper and came out as "The server could not complete that /
    // Your connection is fine". A seller with a typo was told to check their
    // internet instead of their password.
    if (isAuthError(error)) return fromAuth(error);

    if (isPostgrestError(error)) return fromPostgrest(error);

    if (isNetworkError(error)) return fromNetwork(error);

    if (error instanceof Error) {
      // Configuration problems are programming errors, not user errors, so
      // they read as a defect rather than blaming the user's connection.
      if (error.message.includes('Supabase is not configured')) {
        return new AppError(
          'SellFlow is not set up yet',
          'Add your Supabase URL and anon key to the .env file, then restart the app.',
          { cause: error },
        );
      }
      return new AppError('Something went wrong', 'Try again. If it keeps happening, restart the app.', {
        cause: error,
      });
    }

    return new AppError('Something went wrong', 'Try again in a moment.');
  }
}

// ---------------------------------------------------------------------------
// Recognisers
// ---------------------------------------------------------------------------

/**
 * Recognises a Supabase database error.
 *
 * A `PostgrestError` always carries `details` and `hint` alongside `code` and
 * `message`; that pair is the reliable marker, because `code` + `message` on
 * their own also describes an `AuthApiError`.
 */
function isPostgrestError(error: unknown): error is PostgrestError {
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as Record<string, unknown>;
  if (typeof candidate.message !== 'string') return false;
  if ('details' in candidate && 'hint' in candidate) return true;

  // A bare `{ code, message }` with no auth marker is treated as a database
  // error, which is what PostgREST produces and what the RPC suites exercise.
  return 'code' in candidate && !('__isAuthError' in candidate);
}

interface AuthLikeError {
  message: string;
  status?: number;
}

/**
 * Recognises a Supabase auth failure.
 *
 * Three signals, in descending order of certainty:
 *
 *   1. `__isAuthError`, which supabase-js stamps on every `AuthApiError`.
 *   2. A numeric `status`. Gotrue always sets one; `PostgrestError` never does.
 *   3. A message fragment only GoTrue produces.
 *
 * The message fallback is checked LAST and only after ruling out a database
 * error, because the fragments include short words like "otp" and "session"
 * that appear in unrelated database messages.
 */
function isAuthError(error: unknown): error is AuthLikeError {
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as Record<string, unknown>;
  if (typeof candidate.message !== 'string') return false;

  if (candidate.__isAuthError === true) return true;
  if (typeof candidate.status === 'number') return true;

  // A database error wins: it is identified structurally, so its prose is free
  // to contain any word the auth pattern happens to match.
  if ('details' in candidate && 'hint' in candidate) return false;

  return AUTH_MESSAGE_PATTERN.test(candidate.message);
}

/**
 * Message fragments that only GoTrue produces.
 *
 * Word-bounded on purpose. The earlier unanchored form could match "otp"
 * inside an unrelated database message and route it to the auth mapper.
 */
const AUTH_MESSAGE_PATTERN =
  /\b(invalid login credentials|email not confirmed|user already registered|password should be at least|email rate limit|token refresh|not authenticated|failed to fetch|session|otp|signup|confirmation link)\b/i;

function isNetworkError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return (
    error.message === 'Network request failed' ||
    error.name === 'NetworkError' ||
    /fetch failed|network/i.test(error.message)
  );
}

/**
 * A PostgREST error that never got a response.
 *
 * supabase-js reports a transport failure as a PostgREST error with an empty
 * `code` and the raw JS error as the message ("TypeError: Failed to fetch"), so
 * it looks exactly like a server refusal. It is not one, and the two must not
 * share wording: telling a seller with no signal that "your connection is fine"
 * sends them looking in the wrong place, and appending the raw exception text to
 * their screen is a developer string leaking into the product.
 */
function isTransportFailure(error: PostgrestError): boolean {
  return error.code === '' || /typeerror|failed to fetch|fetch failed|network request failed|load failed/i.test(error.message);
}

// ---------------------------------------------------------------------------
// Database error mapping
// ---------------------------------------------------------------------------

/** Server-side `raise exception` codes, mapped to copy a seller can act on. */
const DATABASE_ERRORS: Record<string, { title: string; action: string }> = {
  not_authenticated: {
    title: 'Your session has expired',
    action: 'Sign in again to continue.',
  },
  store_not_found: {
    title: 'Store unavailable',
    action: 'This store no longer exists or you no longer have access to it. Pick another store.',
  },
  insufficient_role: {
    title: 'Read-only access',
    action: 'Ask the business owner to change your role if you need to make this change.',
  },
  insufficient_stock: {
    title: 'Not enough stock',
    action: 'Reduce the quantity, or add stock before creating this order.',
  },
  inventory_not_tracked: {
    title: 'Inventory tracking is off',
    action: 'Turn on inventory tracking for this product first.',
  },
  empty_order: {
    title: 'No products selected',
    action: 'Add at least one product to the order.',
  },
  invalid_quantity: {
    title: 'Invalid quantity',
    action: 'Enter a whole number of 1 or more.',
  },
  invalid_price: {
    title: 'Invalid price',
    action: 'Enter a price of zero or more.',
  },
  invalid_discount: {
    title: 'Invalid discount',
    action: 'The discount cannot be negative or larger than the order value.',
  },
  invalid_delivery_charge: {
    title: 'Invalid delivery charge',
    action: 'Enter a delivery charge of zero or more.',
  },
  invalid_payment: {
    title: 'Invalid payment',
    action: 'Enter an amount greater than zero.',
  },
  overpayment: {
    title: 'Amount exceeds the balance due',
    action: 'Enter no more than the outstanding amount on this order.',
  },
  product_not_found: {
    title: 'Product unavailable',
    action: 'One of the selected products was removed. Refresh and try again.',
  },
  variant_not_found: {
    title: 'Option unavailable',
    action: 'One of the selected options was removed. Refresh and try again.',
  },
  customer_not_found: {
    title: 'Customer unavailable',
    action: 'That customer was removed. Pick another customer.',
  },
  order_not_found: {
    title: 'Order unavailable',
    action: 'This order was removed or you no longer have access to it.',
  },
  order_closed: {
    title: 'Order is closed',
    action: 'This order is cancelled or returned. Record a refund instead of a payment.',
  },
  invalid_transition: {
    title: 'Status change not allowed',
    action: 'Pick a status that is valid for where this order is now.',
  },
  invalid_business_name: {
    title: 'Business name required',
    action: 'Enter a name between 1 and 120 characters.',
  },
  invalid_reason: {
    title: 'Invalid stock reason',
    action: 'Choose how the stock is changing.',
  },
  idempotency_key_reused: {
    title: 'That payment was already recorded',
    action: 'This looks like the same payment being sent twice with different details. Refresh the order to see what was actually taken, then record any remaining balance as a new payment.',
  },
  duplicate_key: {
    title: 'That already exists',
    action: 'Refresh the list to see the newest entry.',
  },
    // Raised by `create_payment_account`. Without this it fell through to the
    // generic "Value not allowed", which told a seller nothing about the one
    // thing they had just typed wrong.
    invalid_account_number: {
      title: 'That receiving number is not valid',
      action: 'Enter the number using digits only, for example 01712345678.',
    },
  };

/** PostgREST/Postgres error codes that are not app-level conditions. */
const POSTGREST_CODES: Record<string, { title: string; action: string }> = {
  '23505': { title: 'That already exists', action: 'Refresh to see the newest entry.' },
  '23503': {
    title: 'Still in use',
    action: 'Remove the records that depend on this one first.',
  },
  '23502': { title: 'Missing information', action: 'Fill in every required field and try again.' },
  '23514': { title: 'Value not allowed', action: 'Check the values you entered and try again.' },
  '42501': {
    title: 'Not allowed',
    action: 'You do not have permission to do this. Ask your business owner for access.',
  },
  'PGRST116': { title: 'Not found', action: 'It may have been removed. Refresh to check.' },
  'PGRST202': {
    title: 'This action is temporarily unavailable',
    action:
      'The database could not match the request. This usually means the app was updated before the server was. Try again in a moment.',
  },
  'PGRST203': {
    title: 'This action is temporarily unavailable',
    action:
      'The database could not tell which function to run. Try again in a moment.',
  },
  '42P01': {
    title: 'Database is not ready',
    action: 'The database is missing something this action needs. Try again shortly.',
  },
  '42P13': {
    title: 'Database is not ready',
    action: 'A database function could not be created. Try again shortly.',
  },
  '42883': {
    title: 'Database is not ready',
    action: 'A database function this action needs is missing. Try again shortly.',
  },
  '57014': {
    title: 'That took too long',
    action: 'The server took too long to respond. Check your connection and try again.',
  },
  '40001': {
    title: 'Please try again',
    action: 'Two updates ran at the same time. Try once more.',
  },
  '40P01': {
    title: 'Please try again',
    action: 'The request was cancelled before it finished. Try once more.',
  },
};

/**
 * Messages that mean "the server refused this", not "you are offline".
 *
 * RLS violations in particular produce a long prose message that matches none of
 * the codes above, and previously fell through to the generic network message.
 * Telling a seller to check their internet when the database rejected the write
 * sends them down the wrong path entirely.
 */
const SERVER_REFUSALS: { pattern: RegExp; title: string; action: string }[] = [
  {
    pattern: /row-level security/i,
    title: 'You do not have access to that',
    action:
      'Your account is not set up to change this yet. If you have just signed up, finish creating your business first, then try again.',
  },
  {
    pattern: /duplicate key value/i,
    title: 'That already exists',
    action: 'Refresh and try again.',
  },
  {
    pattern: /violates foreign key/i,
    title: 'That record is linked to something else',
    action: 'Refresh the list and try again.',
  },
  {
    pattern: /invalid input syntax|malformed/i,
    title: 'The server rejected that value',
    action: 'Check the details you entered and try again.',
  },
  {
    pattern: /could not find the function|schema cache/i,
    title: 'This action is temporarily unavailable',
    action: 'The app is newer than the server. Try again in a moment.',
  },
];

function fromPostgrest(error: PostgrestError): AppError {
  // No response arrived. Checked before the code table because an empty `code`
  // and a raw JS message match none of the entries below, and the fallback at
  // the end would tell the seller their connection was fine.
  if (isTransportFailure(error)) return fromNetwork(error);

  const mapped = POSTGREST_CODES[error.code];
  if (mapped) return new AppError(mapped.title, mapped.action, { cause: error });

  // Postgres `raise exception '<code>'` surfaces as the message, sometimes with
  // a prefix. Match on the code anywhere in the text rather than exact equality.
  const known = Object.entries(DATABASE_ERRORS).find(([code]) => error.message.includes(code));
  if (known) {
    return new AppError(known[1].title, known[1].action, { cause: error });
  }

  // A `raise exception` we do not recognise. It is still our own exception
  // format (a bare word, no SQL syntax), so surface a generic-but-safe message
  // and keep the detail out of the UI.
  if (/^[a-z_]+$/.test(error.message.trim())) {
    return new AppError(
      'That action could not be completed',
      'Check the details and try again. If it keeps happening, contact support.',
      { cause: error },
    );
  }

  // The server answered and refused. Saying "check your internet connection"
  // here was actively wrong: it sent the seller after a connectivity problem
  // that did not exist, and hid the reason the request was rejected.
  const refusal = SERVER_REFUSALS.find((entry) => entry.pattern.test(error.message));
  if (refusal) {
    return new AppError(refusal.title, refusal.action, { cause: error });
  }

  // Last resort. The response proves the network is fine -- we received it --
  // so do not claim otherwise. Include the server's own wording, which is the
  // only thing that can identify an unmapped condition, but keep it in `action`
  // so it surfaces in the error card.
  const detail = error.message.trim();
  const short = detail.length > 160 ? `${detail.slice(0, 157)}...` : detail;

  return new AppError(
    'The server could not complete that',
    `Your connection is fine -- the request was rejected. (${short})`,
    { cause: error },
  );
}

function fromAuth(error: AuthLikeError): AppError {
  const message = error.message.toLowerCase();

  if (message.includes('invalid login credentials')) {
    return new AppError('Incorrect email or password', 'Check your details and try again.', {
      cause: error,
    });
  }
  if (message.includes('email not confirmed')) {
    return new AppError('Confirm your email first', 'Open the link we sent you, then sign in.', {
      cause: error,
    });
  }
  if (message.includes('user already registered')) {
    return new AppError('That email is already registered', 'Sign in instead, or reset your password.', {
      cause: error,
    });
  }
  if (message.includes('password should be at least')) {
    return new AppError('Password too short', 'Use at least 8 characters.', { cause: error });
  }
  if (message.includes('rate limit') || error.status === 429) {
    return new AppError('Too many attempts', 'Wait a minute before trying again.', { cause: error });
  }
  if (message.includes('token') || message.includes('session')) {
    return new AppError('Your session has expired', 'Sign in again to continue.', { cause: error });
  }
  if (message.includes('fetch') || message.includes('network')) {
    return new AppError('No connection', 'Check your internet connection and try again.', {
      cause: error,
    });
  }

  return new AppError('Could not sign you in', 'Try again in a moment.', { cause: error });
}

function fromNetwork(error: Error): AppError {
  return new AppError('No connection', 'Check your internet connection. Your work is saved locally and will sync when you are back online.', {
    cause: error,
  });
}

// ---------------------------------------------------------------------------
// Offline detection
// ---------------------------------------------------------------------------

/**
 * True when the failure looks like a connectivity problem rather than a
 * rejected request. Used to decide whether to queue a write for later.
 */
export function isOfflineError(error: unknown): boolean {
  if (isNetworkError(error)) return true;
  if (isPostgrestError(error)) {
    return error.code === '' || /network|fetch|timeout|ECONNRESET/i.test(error.message);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Payment account errors
// ---------------------------------------------------------------------------

/**
 * A failure while connecting a receiving account, in the seller's terms.
 *
 * `create_payment_account` has a unique index on (org, provider, account_number)
 * and no ON CONFLICT clause, so a repeat comes back as a bare `23505`. The
 * generic copy for that code -- "That already exists / Refresh to see the newest
 * entry" -- is actively wrong here: there is nothing to refresh, and the number
 * is already connected under this very provider. Saying which provider turns a
 * dead end into something the seller can act on.
 */
export function paymentAccountError(error: unknown, providerLabel: string): AppError {
  const base = AppError.from(error);

  if (isPostgrestError(error) && error.code === '23505') {
    return new AppError(
      `That ${providerLabel} number is already connected`,
      `Remove the existing ${providerLabel} account first, or use a different receiving number.`,
      { cause: error },
    );
  }

  if (isPostgrestError(error) && /invalid_account_number/.test(error.message)) {
    return new AppError(
      'That receiving number is not valid',
      'Enter the number using digits only, for example 01712345678.',
      { cause: error },
    );
  }

  return base;
}
