/**
 * The dashboard shell for wide viewports.
 *
 * One component, three jobs, and the reason it exists is that the Android app is
 * a phone layout. Rendering it unchanged on a desktop browser produces a 420px
 * column of phone UI stranded in the middle of a 1440px screen with a tab bar
 * along the bottom, which is the thing this replaces.
 *
 * What it deliberately does NOT do:
 *
 *  - **It does not restyle the screens.** Every screen below it is the screen the
 *    APK ships. Only the frame around them changes. A dashboard whose web pages
 *    were separate implementations would drift from the app within a month, and
 *    the two would stop agreeing about what an order is.
 *  - **It does not own navigation state.** Routes and the auth guard stay with
 *    expo-router and `(app)/_layout.tsx`. This is chrome, not a router.
 *  - **It does not fetch anything.** The sidebar is a list of destinations.
 *
 * Layout at three widths, from `useViewport`:
 *
 *   >= 1024  fixed sidebar + sticky top bar + scrolling content
 *   >= 1440  wider content measure and a roomier grid, so a table is not
 *            stretched into unreadable columns of whitespace
 *   <  1024  no sidebar at all; the Android bottom tab bar is still the nav, and
 *            this component returns null
 */

import { useState } from 'react';
import { Pressable, Platform, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { LogOut, Menu, X } from 'lucide-react-native';

import { Text } from '@/components/ui';
import { NAV_SECTIONS, isNavItemActive, type NavItem } from '@/lib/navigation';
import { useViewport } from '@/lib/useViewport';
import { useTheme } from '@/theme/ThemeProvider';

/** Matches `NAV_SECTIONS` import above; kept next to it so they cannot drift. */
const SIDEBAR_WIDTH = 248;
const SIDEBAR_WIDTH_WIDE = 272;
const TOPBAR_HEIGHT = 60;

/**
 * Widest the content column is allowed to get.
 *
 * A website stops growing its text column at some point. Left unconstrained, an
 * order table on a 2560px monitor stretches each column into a pool of whitespace
 * with the total marooned in the middle of it, which is the clearest tell of an app
 * layout dropped onto a desktop browser.
 */
const CONTENT_MAX_WIDTH = 1440;

export function WebShell({ children }: { children: React.ReactNode }) {
  const { isDesktop } = useViewport();
  const [drawerOpen, setDrawerOpen] = useState(false);

  /*
   * A drawer left open across a resize would reappear over the content when the
   * viewport came back above the sidebar breakpoint, with nothing behind it to
   * close it.
   *
   * Adjusted during render rather than in an effect, which is React's pattern for
   * deriving state from a prop change: an effect would set state after the frame
   * that should have closed it had already painted the drawer.
   */
  const [wasDesktop, setWasDesktop] = useState(isDesktop);

  /*
   * This component is web chrome and must not exist on a device.
   *
   * The gate is the platform, NOT the width. Every branch below is chosen by
   * `isDesktop`, and a phone is `!isDesktop` by definition -- so width-gating gave
   * the Android app a hamburger top bar, a wordmark and a slide-in drawer on top of
   * its own navigation. The phone layout is the tab bar in `(tabs)/_layout.tsx` and
   * nothing else; this returns the children untouched and gets out of the way.
   *
   * Placed after every hook so the hook order stays stable across platforms.
   */
  if (Platform.OS !== 'web') return <>{children}</>;

  if (isDesktop !== wasDesktop) {
    setWasDesktop(isDesktop);
    if (isDesktop) setDrawerOpen(false);
  }

  if (!isDesktop) {
    /*
     * Narrow web viewports get the website too -- a top bar and a drawer -- rather
     * than falling through to the phone layout.
     *
     * Returning `children` here is what made the dashboard read as an app: a phone
     * browser, or a desktop window dragged narrow, got the Android bottom tab bar
     * and the phone's single-column cards. The tab bar is suppressed separately in
     * `(tabs)/_layout.tsx`, which is what actually stops it appearing.
     */
    return (
      <View style={styles.root}>
        <View style={styles.main}>
          <TopBar onOpenDrawer={() => setDrawerOpen(true)} showMenu />
        <View style={styles.content}>
          <View style={styles.contentInner}>{children}</View>
        </View>
        </View>
        {drawerOpen ? <Drawer onClose={() => setDrawerOpen(false)} /> : null}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Sidebar />

      <View style={styles.main}>
        <TopBar onOpenDrawer={() => setDrawerOpen(true)} showMenu={false} />

        {/*
          A plain flex View, deliberately NOT a ScrollView.

          The children are navigators, and a navigator fills whatever box it is
          given -- it does not want an outer scroller. Wrapping one in a ScrollView
          collapses it: the shell renders, the sidebar works, and the screen inside
          it comes out empty. Every screen already brings its own scrolling, so the
          second scroller bought nothing and cost the content.
        */}
        <View style={styles.content}>{children}</View>
      </View>

      {drawerOpen ? (
        <Drawer onClose={() => setDrawerOpen(false)} />
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ sidebar */

function Sidebar() {
  const { colors, spacing } = useTheme();
  const { isWide } = useViewport();
  const width = isWide ? SIDEBAR_WIDTH_WIDE : SIDEBAR_WIDTH;

  return (
    <View
      style={[
        styles.sidebar,
        {
          width,
          backgroundColor: colors.surface,
          borderRightColor: colors.border,
          paddingHorizontal: spacing.md,
        },
      ]}
    >
      <View style={[styles.brand, { paddingVertical: spacing.lg }]}>
        <View style={[styles.brandMark, { backgroundColor: colors.primary }]}>
          <Text variant="subtitle" style={{ color: colors.onPrimary }}>
            S
          </Text>
        </View>
        <Text variant="subtitle">SellFlow</Text>
      </View>

      <ScrollView
        style={styles.sidebarScroll}
        contentContainerStyle={{ paddingBottom: spacing.xl }}
        showsVerticalScrollIndicator={false}
      >
        {NAV_SECTIONS.map((section) => (
          <View key={section.key ?? section.items[0]?.key} style={{ marginBottom: spacing.lg }}>
            {section.label ? (
              <Text
                variant="micro"
                tone="muted"
                style={styles.sectionLabel}
              >
                {section.label.toUpperCase()}
              </Text>
            ) : null}
            {section.items.map((item) => (
              <SidebarLink key={item.key} item={item} />
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function SidebarLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const active = isNavItemActive(pathname, item);
  const Icon = item.icon;

  return (
    <Pressable
      onPress={() => {
        router.push(item.href as never);
        onNavigate?.();
      }}
      accessibilityRole="link"
      accessibilityState={{ selected: active }}
      accessibilityLabel={item.label}
      testID={`web-nav-${item.key}`}
      style={({ pressed }) => [
        styles.link,
        {
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.sm,
          borderRadius: 8,
          backgroundColor: active ? colors.primarySoft : pressed ? colors.surfaceSunken : 'transparent',
        },
      ]}
    >
      <Icon
        size={18}
        color={active ? colors.primary : colors.textMuted}
        strokeWidth={active ? 2.2 : 1.8}
      />
      <Text
        variant="body"
        numberOfLines={1}
        style={{ color: active ? colors.primary : colors.textSecondary, flex: 1 }}
      >
        {item.label}
      </Text>
    </Pressable>
  );
}

/**
 * Whether a destination is the current page.
 *
 * Lives in `@/lib/navigation` as `isNavItemActive`, next to the list it matches
 * against, so the sidebar, the drawer and the quick-action list cannot disagree
 * about what "the current page" means.
 */

/* ------------------------------------------------------------------- topbar */

function TopBar({
  onOpenDrawer,
  showMenu,
}: {
  onOpenDrawer: () => void;
  /** Hidden when the sidebar is already on screen, so the control is not duplicated. */
  showMenu: boolean;
}) {
  const { colors, spacing } = useTheme();
  const router = useRouter();

  return (
    <View
      style={[
        styles.topbar,
        {
          height: TOPBAR_HEIGHT,
          backgroundColor: colors.surface,
          borderBottomColor: colors.border,
          paddingHorizontal: spacing.lg,
        },
      ]}
    >
      {showMenu ? (
        <Pressable
          onPress={onOpenDrawer}
          accessibilityRole="button"
          accessibilityLabel="Open navigation"
          testID="web-drawer-open"
          style={{ marginRight: spacing.sm }}
        >
          <Menu size={20} color={colors.textSecondary} />
        </Pressable>
      ) : null}

      {/*
        The wordmark lives in the top bar at narrow widths because the sidebar it
        otherwise sits in is off-canvas there, which would leave the bar unlabelled.
      */}
      {showMenu ? (
        <View style={styles.brand}>
          <View style={[styles.brandMark, { backgroundColor: colors.primary }]}>
            <Text variant="subtitle" style={{ color: colors.onPrimary }}>
              S
            </Text>
          </View>
          <Text variant="subtitle">SellFlow</Text>
        </View>
      ) : null}

      <View style={{ flex: 1 }} />

      <Pressable
        onPress={() => router.push('/notifications')}
        accessibilityRole="link"
        accessibilityLabel="Notifications"
        testID="web-topbar-notifications"
        style={{ marginRight: spacing.md }}
      >
        <Text variant="body" style={{ color: colors.textSecondary }}>
          Notifications
        </Text>
      </Pressable>

      <Pressable
        onPress={() => router.push('/settings/account')}
        accessibilityRole="link"
        accessibilityLabel="Settings"
        testID="web-topbar-settings"
      >
        <Text variant="body" style={{ color: colors.textSecondary }}>
          Settings
        </Text>
      </Pressable>
    </View>
  );
}

/* ------------------------------------------------------------------- drawer */

function Drawer({ onClose }: { onClose: () => void }) {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Tappable scrim. Closes the drawer, and is what makes it a dialog. */}
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close navigation"
        style={[styles.scrim, { backgroundColor: 'rgba(2, 6, 23, 0.5)' }]}
      />

      <View
        accessibilityViewIsModal
        style={[
          styles.drawer,
          {
            width: Math.min(300, width - 56),
            backgroundColor: colors.surface,
            borderRightColor: colors.border,
            paddingHorizontal: spacing.md,
          },
        ]}
      >
        <View style={[styles.drawerHead, { paddingVertical: spacing.md }]}>
          <Text variant="subtitle">Navigate</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close navigation"
            testID="web-drawer-close"
          >
            <X size={20} color={colors.textSecondary} />
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {NAV_SECTIONS.map((section) => (
            <View key={section.key ?? section.items[0]?.key} style={{ marginBottom: spacing.lg }}>
              {section.label ? (
                <Text variant="micro" tone="muted" style={styles.sectionLabel}>
                  {section.label.toUpperCase()}
                </Text>
              ) : null}
              {section.items.map((item) => (
                <SidebarLink
                  key={item.key}
                  item={item}
                  // Every navigation closes the drawer. Leaving it open behind a
                  // new page is the classic thing that makes a drawer feel broken.
                  onNavigate={onClose}
                />
              ))}
            </View>
          ))}
        </ScrollView>

        <Pressable
          onPress={() => {
            onClose();
            router.push('/settings/account');
          }}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          style={[styles.signOut, { borderTopColor: colors.border, paddingVertical: spacing.md }]}
        >
          <LogOut size={18} color={colors.textSecondary} />
          <Text variant="body" style={{ color: colors.textSecondary }}>
            Account and sign out
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  sidebar: { height: '100%', borderRightWidth: StyleSheet.hairlineWidth },
  sidebarScroll: { flex: 1 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionLabel: { letterSpacing: 0.6, marginBottom: 6, marginLeft: 8 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  main: { flex: 1 },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  content: { flex: 1 },
  contentInner: { flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  drawer: { height: '100%', borderRightWidth: StyleSheet.hairlineWidth },
  drawerHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  signOut: {
    marginTop: 'auto',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
});
