/**
 * Theme context.
 *
 * Exposes the resolved colour set for the active scheme plus the static scales
 * (spacing, radii, typography). Screens read from `useTheme()` rather than
 * importing colours directly, which is what keeps light/dark in one place.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import {
  chipHeight,
  controlHeight,
  darkColors,
  elevation,
  iconSize,
  layout,
  lightColors,
  motion,
  radius,
  spacing,
  touchTarget,
  typography,
  type ThemeColors,
} from './tokens';

export type AppearancePreference = 'system' | 'light' | 'dark';

export interface Theme {
  colors: ThemeColors;
  scheme: 'light' | 'dark';
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  iconSize: typeof iconSize;
  touchTarget: typeof touchTarget;
  elevation: typeof elevation;
  motion: typeof motion;
  layout: typeof layout;
  /** Shared height for every text entry control. See tokens.ts. */
  controlHeight: number;
  /** Shared height for a filter chip and a segmented-control segment. */
  chipHeight: number;
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
      iconSize,
      touchTarget,
      elevation,
      motion,
      layout,
      controlHeight,
      chipHeight,
    }),
    [scheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return theme;
}
