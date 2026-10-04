/**
 * Bottom tab navigator.
 *
 * Five destinations, fixed and predictable (requirement 10).
 *
 * The bar is custom-rendered rather than themed so it can follow the design
 * system exactly: a hairline top border instead of a heavy shadow, 48pt targets,
 * and safe-area padding that respects the Android gesture bar and the iOS home
 * indicator.
 *
 * Tab state is lifted into a store so a screen can switch tab and then push a
 * detail screen, which the imperative `router` API cannot express on its own.
 *
 * **This bar is the phone layout.** On a viewport wide enough for a sidebar,
 * `WebShell` takes over and this bar is not rendered at all -- see
 * `src/components/web/WebShell.tsx`. Both are driven by the same `useViewport`
 * breakpoint, so there is no width at which a seller sees both, or neither.
 */

import { create } from 'zustand';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Boxes,
  LayoutDashboard,
  MoreHorizontal,
  ReceiptText,
  Users,
  type LucideIcon,
} from 'lucide-react-native';

import { Text } from '@/components/ui';
import { ConnectionBanner } from '@/components/ConnectionBanner';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * Minimal shape of the props a custom tab bar receives.
 *
 * Declared locally rather than imported: as of SDK 56 expo-router no longer
 * re-exports `@react-navigation/*` types for application code, and this screen
 * only needs two of the fields.
 */
interface TabBarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: { navigate: (name: string) => void };
}

export type TabName = 'index' | 'orders' | 'products' | 'customers' | 'more';

interface TabState {
  active: TabName;
  setActive: (tab: TabName) => void;
}

export const useTabState = create<TabState>((set) => ({
  active: 'index',
  setActive: (active) => set({ active }),
}));

const ICONS: Record<string, LucideIcon> = {
  index: LayoutDashboard,
  orders: ReceiptText,
  products: Boxes,
  customers: Users,
  more: MoreHorizontal,
};

const ORDER: string[] = ['index', 'orders', 'products', 'customers', 'more'];

export default function TabsLayout() {
  const { colors } = useTheme();

  /*
   * The bottom tab bar is the phone layout and is not rendered on web at all.
   *
   * `WebShell` draws the web navigation -- a sidebar, or a top bar and drawer when
   * the window is narrow -- and having both on screen at once is what made the
   * dashboard read as a phone app with a website bolted on. Returning `null` rather
   * than hiding it with a style keeps it out of the accessibility tree too, so a
   * screen reader is not offered five unlabelled tabs above the real navigation.
   */
  const isWeb = Platform.OS === 'web';

  /*
   * Every tab scene renders into here.
   *
   * The desktop shell lives one level up, in `(app)/_layout.tsx`, because it has
   * to wrap the whole authenticated stack. Anchoring it here meant every screen
   * pushed outside the tabs -- Finance, Analytics, Settings, the payment screens --
   * rendered full-bleed with no sidebar and no way to navigate except the browser
   * back button, which is the desktop failure the shell exists to prevent.
   *
   * So this layout is now only ever the phone layout, and the tab bar stays.
   */
  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/*
        Mounted once, here, rather than inside each tab screen.

        Connectivity is a property of the device, not of a screen. Rendering it
        per screen meant it could drift out of sync with the others and had to be
        remembered in five places.

        No top inset is applied: every screen's own ScreenHeader already adds
        insets.top, so adding one here would pad the header twice. The banner
        deliberately occupies the strip above it instead.
      */}
      <ConnectionBanner />

      <Tabs
        tabBar={isWeb ? () => null : (props) => <SellFlowTabBar {...props} />}
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: colors.background },
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Home' }} />
        <Tabs.Screen name="orders" options={{ title: 'Orders' }} />
        <Tabs.Screen name="products" options={{ title: 'Products' }} />
        <Tabs.Screen name="customers" options={{ title: 'Customers' }} />
        <Tabs.Screen name="more" options={{ title: 'More' }} />
      </Tabs>
    </View>
  );
}

function SellFlowTabBar({ state, navigation }: TabBarProps) {
  const { colors, layout } = useTheme();
  const insets = useSafeAreaInsets();
  const setActive = useTabState((store) => store.setActive);

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        {
          height: layout.tabBarHeight + insets.bottom,
          paddingBottom: insets.bottom,
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
      ]}
    >
      {state.routes.map((route, index) => {
        const name = route.name as TabName;
        const Icon = ICONS[name] ?? LayoutDashboard;
        const focused = state.index === index;
        const label = route.name === 'index' ? 'Home' : route.name;

        return (
          <Pressable
            key={route.key}
            onPress={() => {
              if (!focused) setActive(name);
              // `navigate` (not `push`) keeps Back from walking through every
              // tab the user has visited.
              navigation.navigate(route.name);
            }}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected: focused }}
            testID={`tab-${name}`}
            style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Icon
              size={22}
              color={focused ? colors.primary : colors.textMuted}
              // A slightly heavier stroke on the active tab, which reads more
              // clearly than colour alone.
              strokeWidth={focused ? 2.25 : 1.75}
            />
            <Text
              variant="micro"
              numberOfLines={1}
              style={{ color: focused ? colors.primary : colors.textMuted, fontSize: 10.5 }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export { ORDER as TAB_ORDER };

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    minHeight: 48,
  },
});
