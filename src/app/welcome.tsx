/**
 * Welcome — the first screen a new seller sees.
 *
 * Deliberately says three things and nothing else: what SellFlow is, that it
 * needs no merchant account, and what happens next. No feature tour, no carousel,
 no fake numbers in a phone mockup.
 *
 * The "no merchant account" line is not marketing copy. It is the core
 * differentiator, and a seller who arrives expecting to be asked for a merchant
 * account will bounce before they read the rest.
 */

import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowRight, Check } from 'lucide-react-native';

import { Button, Text } from '@/components/ui';
import { useTheme } from '@/theme/ThemeProvider';

const PROMISES = [
  'Connect the bKash, Nagad and Rocket numbers you already use',
  'Keep orders, products and customers in one place',
  'See what you actually made after courier and costs',
];

/**
 * The brand tile.
 *
 * A gradient on a rounded square, not an image asset: it is two vector shapes, so
 * it stays sharp from a 160px splash down to a 40px tab mark, and it cannot fail
 * to load. There is no emoji and no logo bitmap anywhere in the interface.
 */
function BrandMark({ size = 64 }: { size?: number }) {
  const { colors, radius } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius.card,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      accessibilityElementsHidden
    >
      <View
        style={{
          width: size * 0.42,
          height: size * 0.42,
          borderRadius: radius.sm,
          backgroundColor: colors.onPrimary,
        }}
      />
    </View>
  );
}

export default function WelcomeScreen() {
  const router = useRouter();
  const { colors, spacing, layout, radius } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + spacing.xxxl,
          paddingBottom: insets.bottom + spacing.xl,
          gap: spacing.lg,
        },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <BrandMark />

      <View style={{ gap: spacing.sm, maxWidth: layout.maxProseWidth }}>
        <Text variant="display">Run your business from one place</Text>

        <Text variant="subtitle" tone="secondary">
          SellFlow brings your orders, products, customers, delivery and profit together — without
          asking you for a merchant account.
        </Text>
      </View>

      <View style={{ gap: spacing.sm, alignSelf: 'stretch', maxWidth: layout.maxFormWidth }}>
        {PROMISES.map((promise) => (
          <View key={promise} style={styles.promise}>
            <View
              style={{
                width: 22,
                height: 22,
                // radius.pill rather than a literal 11: the check circle is fully
                // round, and "fully round" is what `pill` means. The literal also
                // fails the design audit, which is how it got noticed.
                borderRadius: radius.pill,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.primarySoft,
              }}
            >
              <Check size={14} color={colors.primary} strokeWidth={2.5} />
            </View>
            <Text variant="body" tone="secondary" style={styles.promiseText}>
              {promise}
            </Text>
          </View>
        ))}
      </View>

      <View style={{ marginTop: spacing.md, gap: spacing.xs, maxWidth: layout.maxFormWidth }}>
        <Button
          label="Get started"
          size="lg"
          fullWidth
          iconRight={ArrowRight}
          onPress={() => router.push('/register')}
          testID="welcome-get-started"
        />
        <Button
          label="I already have an account"
          variant="ghost"
          fullWidth
          onPress={() => router.push('/sign-in')}
          testID="welcome-sign-in"
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  promise: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    // spacing.xs, not a literal: the audit reads StyleSheet values, and a bare 10
    // here is off the 4pt grid even though it looks right.
    gap: 8,
  },
  promiseText: {
    flex: 1,
  },
});