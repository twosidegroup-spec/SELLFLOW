/**
 * Formatting helpers for dates, quantities and display text.
 *
 * "Today" and "Yesterday" are resolved against the device clock, not the
 * server clock -- a seller in Dhaka opening the app at 1am should see their own
 * idea of today.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Local calendar date as `YYYY-MM-DD`, which is what the SQL date columns want. */
export function toDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '--';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '--';

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '--';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '--';

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/** "Today", "Yesterday", or a date -- the format used in dense order lists. */
export function formatRelativeDay(value: string | Date | null | undefined): string {
  if (!value) return '--';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '--';

  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / DAY_MS);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date);
}

/** "2 hours ago", "just now". Used in activity feeds. */
export function formatTimeAgo(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);

  if (seconds < 45) return 'just now';

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['week', 604800],
    ['month', 2629800],
    ['year', 31557600],
  ];

  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0]!;
  for (const unit of units) {
    if (seconds >= unit[1]) chosen = unit;
  }

  const delta = -Math.round(seconds / chosen[1]);

  try {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(delta, chosen[0]);
  } catch {
    return formatDate(date);
  }
}

/** Truncate with an ellipsis, for long product or customer names. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

/** Initials for the avatar placeholder. Handles single-word and CJK names. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Quantity label that never renders "1 items". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

/** Last two characters of a phone number, for a masked display. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return phone;
  return `...${digits.slice(-4)}`;
}
