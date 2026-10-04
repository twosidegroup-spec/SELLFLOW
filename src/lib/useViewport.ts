/**
 * Where the viewport width puts us.
 *
 * The dashboard is one codebase rendering two shapes. The Android app is a phone
 * app with a bottom tab bar; on a desktop browser the same screens need a
 * persistent sidebar, a top bar, and room for a table with six columns instead of
 * a card with two. Rather than let each screen ask "am I wide?" and get its own
 * answer, every screen asks this.
 *
 * `useWindowDimensions` rather than a media query in CSS, because the layout is
 * built from React Native primitives that react-native-web turns into divs with
 * inline styles. There is no stylesheet to put a breakpoint in, and mixing the two
 * would mean the breakpoint and the layout disagreeing at exactly one width.
 *
 * The breakpoints match the ones the marketing site already ships its rail at, so
 * the public page and the dashboard change shape at the same width rather than at
 * two unrelated ones.
 */

import { useWindowDimensions } from 'react-native';

/**
 * Width at which the sidebar appears.
 *
 * Below this the sidebar would leave too little room for content to be readable,
 * so the drawer is used instead. 1024 rather than 768 because a 768-wide table of
 * orders with a customer and a total is already cramped, and a tablet held
 * sideways is still a touch device.
 */
export const SIDEBAR_MIN_WIDTH = 1024;

/** Width at which a data table stops being a comfortable five-column layout. */
export const WIDE_MIN_WIDTH = 1440;

/** Below this, two-column rows stop fitting and become single-column. */
export const MEDIUM_MIN_WIDTH = 768;

export type Breakpoint = 'mobile' | 'tablet' | 'desktop' | 'wide';

export interface Viewport {
  width: number;
  height: number;
  breakpoint: Breakpoint;
  /** Sidebar replaces the bottom tab bar. */
  isDesktop: boolean;
  /** Extra horizontal room for wide tables and denser grids. */
  isWide: boolean;
  /** Two-column row layouts are safe. */
  isMedium: boolean;
  isTouchFirst: boolean;
}

export function useViewport(): Viewport {
  const { width, height } = useWindowDimensions();

  const isDesktop = width >= SIDEBAR_MIN_WIDTH;
  const isWide = width >= WIDE_MIN_WIDTH;
  const isMedium = width >= MEDIUM_MIN_WIDTH;

  const breakpoint: Breakpoint = isWide
    ? 'wide'
    : isDesktop
      ? 'desktop'
      : isMedium
        ? 'tablet'
        : 'mobile';

  return {
    width,
    height,
    breakpoint,
    isDesktop,
    isWide,
    isMedium,
    /*
     * Not `!isDesktop`. A coarse pointer is the actual question: a 1440px browser
     * window on a touch laptop still wants the bigger hit targets, and treating
     * width alone as "not touch first" would shrink them for no reason.
     */
    isTouchFirst: !isDesktop,
  };
}
