/**
 * Theme context.
 *
 * Exposes the resolved colour set for the active scheme plus the static scales.
 * Components read from `useTheme()` rather than importing tokens directly, which
 * is what keeps light and dark in one place: there is exactly one decision --
 * `scheme` -- and everything downstream follows from it.
 *
 * The provider is deliberately thin. It holds no state of its own; the
 * preference comes from the appearance store, so the root layout stays the single
 * source of truth for what the app looks like.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import {
  borderWidth,
  chipHeight,
  controlHeight,
  darkColors,
  elevation,
  iconSize,
  layout,
  lightColors,
  motion,
  numberTransitionDelay,
  radius,
  spacing,
  touchTarget,
  typography,
  fontFamily,
  fontForWeight,
  type ThemeColors,
  type TypographyVariant,
} from './tokens';

export type AppearancePreference = 'system' | 'light' | 'dark';

export interface Theme {
  colors: ThemeColors;
  scheme: 'light' | 'dark';
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  fontFamily: typeof fontFamily;
  fontForWeight: typeof fontForWeight;
  iconSize: typeof iconSize;
  touchTarget: typeof touchTarget;
  borderWidth: typeof borderWidth;
  elevation: typeof elevation;
  motion: typeof motion;
  layout: typeof layout;
  controlHeight: number;
  chipHeight: number;
  numberTransitionDelay: number;
  screenPadding: number;
}

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({
  preference,
  children,
}: {
  preference: AppearancePreference;
  children: ReactNode;
}) {
  const systemScheme = useColorScheme();
  const scheme: 'light' | 'dark' =
    preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;

  const value = useMemo<Theme>(
    () => ({
      colors: scheme === 'dark' ? darkColors : lightColors,
      scheme,
      spacing,
      radius,
      typography,
      fontFamily,
      fontForWeight,
      iconSize,
      touchTarget,
      borderWidth,
      elevation,
      motion,
      layout,
      controlHeight,
      chipHeight,
      numberTransitionDelay,
      screenPadding: spacing.lg,
    }),
    [scheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) {
    // A thrown error here means a component rendered outside the provider. That is
    // a wiring bug, and failing loudly during development is better than a
    // component silently falling back to unthemed colours in production.
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return theme;
}

/** Convenience selector for the common case of only needing colours. */
export function useColors(): ThemeColors {
  return useTheme().colors;
}

export type { ThemeColors, TypographyVariant };