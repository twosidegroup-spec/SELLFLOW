/**
 * The dashboard's navigation, declared once.
 *
 * The desktop sidebar, the mobile drawer and the Android bottom tab bar are three
 * renderings of one list. Declaring it here means adding a section is one edit
 * rather than three, and it is impossible for the sidebar and the tab bar to
 * disagree about what exists.
 *
 * Routes are the Expo Router paths the app already uses. Nothing here is
 * web-only: the sidebar links to the same screens the phone shows, which is what
 * makes "open an order on your phone, finish it in the browser" work at all.
 */

import {
  BarChart3,
  Bell,
  Boxes,
  ClipboardList,
  LayoutDashboard,
  Package,
  ReceiptText,
  Settings,
  Store,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react-native';

import type { NativeProvider } from '@sellflow-sms/types';

/** A leaf destination. */
export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /**
   * Only shown to sellers who actually use it.
   *
   * An empty "Devices" section that says "no devices yet" is worse than no
   * section, so anything with nothing behind it is filtered out rather than
   * rendered hollow.
   */
  requiresProvider?: false;
}

/** A group with an optional heading, e.g. Payments. */
export interface NavSection {
  /** Optional. The first item's key stands in when a group has no heading. */
  key?: string;
  label?: string;
  items: NavItem[];
}

/**
 * Hrefs are the group-free form -- `/orders`, not `/(app)/orders`.
 *
 * Expo Router treats a group as invisible in the URL: `stripGroupSegmentsFromPath`
 * is applied to every href before it is resolved, so `/(app)/orders` and `/orders`
 * are the same destination and produce the same browser URL. Both spellings are
 * accepted, and the generated route types list them side by side.
 *
 * The group-free form is the one stored here because it is the only one that can be
 * *compared* against a pathname. `usePathname()` returns the resolved, normalised
 * path (`/orders`); matching that against a group-prefixed href never matches, which
 * is why the sidebar used to render with nothing highlighted.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { key: 'dashboard', label: 'Dashboard', href: '/(app)', icon: LayoutDashboard },
      { key: 'orders', label: 'Orders', href: '/orders', icon: ReceiptText },
      { key: 'products', label: 'Products', href: '/products', icon: Boxes },
      { key: 'inventory', label: 'Inventory', href: '/products?view=inventory', icon: Package },
      { key: 'customers', label: 'Customers', href: '/customers', icon: Users },
    ],
  },
  {
    label: 'Payments',
    items: [
      { key: 'payments', label: 'Overview', href: '/payments', icon: Wallet },
      { key: 'payment-review', label: 'Review queue', href: '/payment-review', icon: ClipboardList },
      { key: 'payment-automation', label: 'Automation', href: '/payment-sms', icon: Store },
      { key: 'analytics', label: 'Analytics', href: '/analytics', icon: BarChart3 },
      { key: 'finance', label: 'Finance', href: '/finance', icon: Wallet },
    ],
  },
  {
    label: 'Account',
    items: [
      { key: 'notifications', label: 'Notifications', href: '/notifications', icon: Bell },
      { key: 'settings', label: 'Settings', href: '/settings/account', icon: Settings },
    ],
  },
];

/* ------------------------------------------------------------------ matching */

/** Splits a path into comparable segments, dropping query, hash and groups. */
function segmentsOf(path: string): string[] {
  return path
    .replace(/[?#].*$/, '')
    .split('/')
    .filter((segment) => segment.length > 0 && !/^\(.*\)$/.test(segment));
}

/**
 * Whether `pathname` is inside `item`'s destination.
 *
 * Matched on a trailing-segment basis rather than string equality, for two reasons.
 *
 * Segment-wise so that `/order/123` lights up Orders while `/order-archive` does
 * not -- `startsWith` on the raw string conflates those two.
 *
 * Trailing, so a base path in front of the route does not defeat the match. The web
 * build mounts the dashboard under a subpath, so the pathname can arrive as
 * `/orders` or `/app/orders` depending on whether the router has stripped the base
 * path yet. Both must highlight the same item, and which one arrives is not
 * something this file should have to know.
 */
export function isNavItemActive(pathname: string, item: NavItem): boolean {
  const target = segmentsOf(item.href);

  // `/(app)` is the dashboard. It keeps its group on purpose: the bare path `/` is
  // NOT the dashboard, it is `src/app/index.tsx`, the entry gate that only decides
  // where to send the session and then redirects to `/(app)`. Linking there would
  // flash "Loading your business" on every click of the one link that is always
  // visible. Its URL is the app root, so `segmentsOf` reduces the href to nothing.
  if (target.length === 0) {
    const current = segmentsOf(pathname);
    // The root itself, optionally with the base path in front of it. Anything
    // deeper is a different page and must not light up Dashboard.
    return current.length <= 1;
  }

  const current = segmentsOf(pathname);
  if (current.length < target.length) return false;

  const offset = current.length - target.length;
  return target.every((segment, index) => {
    const actual = current[offset + index];
    return actual !== undefined && actual === segment;
  });
}

/**
 * Provider label for display.
 *
 * Kept here rather than in the sidebar so the web and the app say the same thing
 * about the same provider.
 */
export const PROVIDER_LABEL: Record<NativeProvider, string> = {
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  upay: 'Upay',
};

/** Flattens the tree for callers that just want every destination. */
export function allNavItems(): NavItem[] {
  return NAV_SECTIONS.flatMap((section) => section.items);
}
