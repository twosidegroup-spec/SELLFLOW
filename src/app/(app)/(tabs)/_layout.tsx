/**
 * The seller's tab bar.
 *
 * Five destinations, in the order a seller uses them: today, orders, payments, stock
 * and people. Everything else lives under More.
 *
 * The bar is NOT rendered on web below the desktop breakpoint. `WebShell` is not in
 * V2 yet, so on a narrow web viewport the tab bar is the only navigation, and
 * hiding it would leave a dashboard with no way out. It is hidden at the desktop
 * breakpoint where a sidebar will take over, and only then.
 */

import { Tabs } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { Boxes, LayoutDashboard, Receipt, Users, Wallet } from 'lucide-react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { layout as layoutTokens } from '@/theme/tokens';

/** Below this width there is no sidebar, so the bar must stay. */
const SIDEBAR_BREAKPOINT = layoutTokens.lg;

export default function TabsLayout() {
  const { colors, spacing, typography } = useTheme();
  const { width } = useWindowDimensions();

  const showTabs = width < SIDEBAR_BREAKPOINT;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: showTabs
          ? {
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
              borderTopWidth: 1,
              height: layoutTokens.tabBar,
              // The bottom inset is applied here rather than per screen, so a tab
              // label never sits under a gesture bar or a notch.
              paddingBottom: spacing.xs,
              paddingTop: spacing.xs,
            }
          : { display: 'none' },
        tabBarLabelStyle: {
          fontFamily: typography.micro.fontWeight === '600' ? 'Inter-SemiBold' : 'Inter-Medium',
          fontSize: 11,
          lineHeight: 15,
          letterSpacing: 0.2,
        },
        tabBarItemStyle: { paddingVertical: spacing.xxs },
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Today',
          headerShown: false,
          tabBarIcon: ({ color }) => <LayoutDashboard size={20} color={color} strokeWidth={1.75} />,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'Orders',
          tabBarIcon: ({ color }) => <Receipt size={20} color={color} strokeWidth={1.75} />,
        }}
      />
      <Tabs.Screen
        name="payments"
        options={{
          title: 'Payments',
          tabBarIcon: ({ color }) => <Wallet size={20} color={color} strokeWidth={1.75} />,
        }}
      />
      <Tabs.Screen
        name="products"
        options={{
          title: 'Stock',
          tabBarIcon: ({ color }) => <Boxes size={20} color={color} strokeWidth={1.75} />,
        }}
      />
      <Tabs.Screen
        name="customers"
        options={{
          title: 'People',
          tabBarIcon: ({ color }) => <Users size={20} color={color} strokeWidth={1.75} />,
        }}
      />
    </Tabs>
  );
}