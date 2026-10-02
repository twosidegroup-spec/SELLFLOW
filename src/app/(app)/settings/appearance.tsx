/**
 * Appearance.
 *
 * Light / dark / system. The preference is applied immediately and persisted, so
 * switching to dark does not require a restart.
 */

import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, Monitor, Moon, Sun } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { ScreenHeader } from '@/components/ScreenHeader';
import { Screen, Text } from '@/components/ui';
import { StorageKeys, writeJson } from '@/lib/storage';
import { useAppearance } from '@/store/appearance';
import { useTheme } from '@/theme/ThemeProvider';
import type { AppearancePreference } from '@/theme/ThemeProvider';

const OPTIONS: {
  value: AppearancePreference;
  label: string;
  description: string;
  Icon: typeof Sun;
}[] = [
  { value: 'light', label: 'Light', description: 'Always the light palette', Icon: Sun },
  { value: 'dark', label: 'Dark', description: 'Always the dark palette', Icon: Moon },
  { value: 'system', label: 'System', description: 'Follow the device setting', Icon: Monitor },
];

export default function AppearanceSettingsScreen() {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const preference = useAppearance((state) => state.preference);
  const setPreference = useAppearance((state) => state.setPreference);

  async function choose(value: AppearancePreference) {
    setPreference(value);
    void Haptics.selectionAsync();
    await writeJson(StorageKeys.appearance, value);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Appearance" />

      <Screen bottomInset={insets.bottom}>
        <View style={{ gap: spacing.md, paddingTop: spacing.md }}>
          {OPTIONS.map(({ value, label, description, Icon }) => {
            const selected = preference === value;

            return (
              <Pressable
                key={value}
                onPress={() => void choose(value)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={label}
                style={({ pressed }) => [
                  styles.row,
                  {
                    backgroundColor: colors.surface,
                    borderColor: selected ? colors.primary : colors.border,
                    borderRadius: radius.card,
                    padding: spacing.md,
                    opacity: pressed ? 0.75 : 1,
                  },
                ]}
              >
                <Icon
                  size={20}
                  color={selected ? colors.primary : colors.textSecondary}
                  strokeWidth={2}
                />

                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="subtitle">{label}</Text>
                  <Text variant="caption" tone="muted">{description}</Text>
                </View>

                {selected ? <Check size={20} color={colors.primary} strokeWidth={2.5} /> : null}
              </Pressable>
            );
          })}
        </View>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    minHeight: 60,
  },
});
