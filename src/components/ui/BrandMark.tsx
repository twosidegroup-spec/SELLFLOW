/**
 * The SellFlow mark, as shown inside the app.
 *
 * Deliberately not `assets/icon.png`.
 *
 * `icon.png` is a *launcher* asset: a 1024x1024 opaque tile (PNG colour type 2, no
 * alpha channel at all) with a pale plate baked in and the mark inset 12% from the
 * edges. Rendering it inside the app therefore does three wrong things at once,
 * all of them measured rather than guessed -- `scripts/splash-assets.test.mjs`
 * re-checks each one:
 *
 *   1. **The plate does not match the app.** Its modal colour is rgb(240,244,245),
 *      while the light theme background is #F8FAFC. That is a 1.15:1 contrast, so
 *      the tile is very nearly invisible against the page and reads as a faint
 *      smudge rather than a logo.
 *   2. **It glares in dark mode.** An opaque near-white plate on the #0B1120 lock
 *      screen is a bright rounded square -- the exact "white flash" the splash
 *      requirements rule out, appearing on the screen a seller sees every morning.
 *   3. **Most of it is padding.** The mark occupies 75% x 60% of the tile, so at
 *      64pt the logo itself is about 48 x 39pt and the surrounding dead plate is
 *      what dominates.
 *
 * `assets/android-icon-foreground.png` is the same mark with the plate removed and
 * proper transparent margins, so it can sit directly on the theme background and
 * adapts without a second asset. Its ink is #3E71BB, which reads clearly on the
 * dark background (6.4:1) and is a little soft on the near-white light one (2.3:1)
 * -- acceptable for a logo, which is not text or a control, and stated here rather
 * than glossed over.
 */

import React from 'react';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';

export interface BrandMarkProps {
  /** Edge length of the box. The mark scales inside it. */
  size?: number;
  /**
   * Optional tile behind the mark.
   *
   * Off by default: the mark is legible directly on the theme background in both
   * schemes, and a tile would reintroduce the plate problem this component exists
   * to avoid.
   */
  tiled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function BrandMark({ size = 64, tiled = false, style }: BrandMarkProps) {
  const { colors, radius } = useTheme();

  const mark = (
    <Image
      source={require('@/../assets/android-icon-foreground.png')}
      style={{ width: size, height: size }}
      resizeMode="contain"
      // The file name says "android", but it is just the plate-free mark, and
      // naming the thing it is avoids a future reader "fixing" the import back to
      // the launcher tile.
      accessibilityLabel="SellFlow"
    />
  );

  if (!tiled) return mark;

  return (
    <View
      style={[
        styles.tiled,
        {
          width: size,
          height: size,
          borderRadius: radius.sheet,
          backgroundColor: colors.primarySoft,
        },
        style,
      ]}
    >
      {/* Inset so the mark sits inside the tile rather than bleeding to its edges. */}
      {React.cloneElement(mark, { style: { width: size * 0.72, height: size * 0.72 } })}
    </View>
  );
}

const styles = StyleSheet.create({
  tiled: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
});
