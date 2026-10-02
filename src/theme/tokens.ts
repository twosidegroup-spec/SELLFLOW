/**
 * Design tokens.
 *
 * Single source of truth for colour, spacing, radii, type, elevation and motion.
 * Nothing in the app should hardcode a hex value, a pixel gap, or a duration --
 * if something needs a value that is not here, that is a signal the scale needs
 * extending rather than that the screen should improvise.
 */

import { Platform, type TextStyle, type ViewStyle } from 'react-native';

// ---------------------------------------------------------------------------
// Colour
//
// Values are mode-independent where possible. `Palette` holds the raw brand and
// neutral ramps; `ThemeColors` resolves them into semantic roles for a scheme.
// Screens consume semantic roles only, which is what makes dark mode a data
// swap instead of a screen-by-screen audit.
// ---------------------------------------------------------------------------

const palette = {
  // Brand --------------------------------------------------------------
  blue50: '#EFF6FF',
  blue100: '#DBEAFE',
  blue200: '#BFDBFE',
  blue500: '#3B82F6',
  blue600: '#2563EB',
  blue700: '#1D4ED8',

  green600: '#16A34A',
  green700: '#15803D',
  green400: '#4ADE80',

  amber600: '#D97706',
  amber700: '#B45309',
  amber400: '#FBBF24',

  red600: '#DC2626',
  red400: '#F87171',

  // Light neutrals -----------------------------------------------------
  slate50: '#F8FAFC',
  slate100: '#F1F5F9',
  slate200: '#E2E8F0',
  slate300: '#CBD5E1',
  slate400: '#94A3B8',
  slate500: '#64748B',
  slate600: '#475569',
  slate700: '#334155',
  slate800: '#1E293B',
  slate900: '#0F172A',

  // Dark neutrals ------------------------------------------------------
  night950: '#0B1120',
  night900: '#111827',
  night850: '#172033',
  night800: '#1F2937',
  borderDark: '#243044',
} as const;

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceElevated: string;
  surfaceSunken: string;

  text: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;

  border: string;
  borderStrong: string;

  primary: string;
  primaryPressed: string;
  primarySoft: string;
  onPrimary: string;

  /**
   * Text/icon colour placed on top of a saturated accent (danger, success).
   *
   * Distinct from `onPrimary` because those accents are lightened for the dark
   * palette: white on `#4ADE80` is roughly 1.7:1 and effectively unreadable, so
   * in dark mode this resolves to near-black instead.
   */
  onAccent: string;

  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;

  /**
   * Darker variants of the semantic accents, for solid fills and small text.
   *
   * The brand colours `#16A34A` and `#D97706` reach only ~3.3:1 and ~3.2:1 as
   * text on a white surface. That is fine for an icon or a bold large label, but
   * button labels and 12-13px captions are "small text" under WCAG and need
   * 4.5:1. These roles exist so the brand colour can stay the accent while
   * anything textual uses a shade that actually passes.
   */
  successStrong: string;
  warningStrong: string;

  /** Scrim behind modals and sheets. */
  overlay: string;
  /** Pressed-state fill for list rows and tappable surfaces. */
  pressed: string;
  /** Skeleton placeholder. */
  skeleton: string;
}

export const lightColors: ThemeColors = {
  background: palette.slate50,
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  surfaceSunken: palette.slate100,

  text: palette.slate900,
  textSecondary: palette.slate600,
  textMuted: palette.slate500,
  textInverse: '#FFFFFF',

  border: palette.slate200,
  borderStrong: palette.slate300,

  primary: palette.blue600,
  primaryPressed: palette.blue700,
  primarySoft: palette.blue50,
  onPrimary: '#FFFFFF',
  onAccent: '#FFFFFF',

  success: palette.green600,
  successStrong: palette.green700,
  successSoft: '#F0FDF4',
  warning: palette.amber600,
  warningStrong: palette.amber700,
  warningSoft: '#FFFBEB',
  danger: palette.red600,
  dangerSoft: '#FEF2F2',

  overlay: 'rgba(15, 23, 42, 0.45)',
  pressed: 'rgba(15, 23, 42, 0.05)',
  skeleton: palette.slate200,
};

export const darkColors: ThemeColors = {
  background: palette.night950,
  surface: palette.night900,
  surfaceElevated: palette.night850,
  surfaceSunken: palette.night950,

  text: palette.slate50,
  textSecondary: palette.slate300,
  textMuted: palette.slate400,
  textInverse: palette.night950,

  border: palette.borderDark,
  borderStrong: '#31405a',

  // Blue is lightened for dark surfaces: #2563EB on #0B1120 fails contrast.
  primary: palette.blue500,
  primaryPressed: palette.blue200,
  primarySoft: 'rgba(59, 130, 246, 0.16)',
  onPrimary: palette.night950,
  onAccent: palette.night950,

  success: palette.green400,
  successStrong: palette.green400,
  successSoft: 'rgba(74, 222, 128, 0.14)',
  warning: palette.amber400,
  warningStrong: palette.amber400,
  warningSoft: 'rgba(251, 191, 36, 0.14)',
  danger: palette.red400,
  dangerSoft: 'rgba(248, 113, 113, 0.14)',

  overlay: 'rgba(0, 0, 0, 0.62)',
  pressed: 'rgba(255, 255, 255, 0.06)',
  skeleton: palette.night800,
};

// ---------------------------------------------------------------------------
// Spacing
//
// A 4pt scale. Screen padding, card padding and section gaps all come from
// here so vertical rhythm stays consistent across every screen.
// ---------------------------------------------------------------------------

export const spacing = {
  none: 0,
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
} as const;

/** Standard horizontal inset from the screen edge. */
export const SCREEN_PADDING = spacing.lg;

// ---------------------------------------------------------------------------
// Radii
//
// A small, semantic scale. Every radius in the app is one of these five, and
// which one is a statement about what the thing IS rather than a preference:
//
//   sm      small marks -- a nested tag, a tiny swatch
//   control inputs, buttons and inline notices a finger lands on
//   mark    the brand tile and inline notice blocks: neither a card nor a
//           control, so they get their own step instead of borrowing one
//   card    cards, panels and list containers
//   sheet   sheets and modals, where a softer corner reads as "floating"
//   pill    pills, badges, avatars and fully-round marks such as icon tiles
//           and the sheet drag handle
//
// Adding a sixth value is a design decision, not a convenience.
// ---------------------------------------------------------------------------

export const radius = {
  sm: 8,
  control: 10, // inputs and buttons
  mark: 12, // brand tile and inline notice blocks
  card: 14,
  sheet: 22,
  pill: 999,
} as const;

// ---------------------------------------------------------------------------
// Touch targets
// ---------------------------------------------------------------------------

export const touchTarget = {
  /** Minimum comfortable tap area. Anything smaller fails WCAG 2.5.8. */
  min: 44,
  comfortable: 48,
} as const;

/**
 * The one height every text entry control shares.
 *
 * `Input`, `SelectField` and `SearchBar` are interchangeable on a form -- a
 * seller moves between them without noticing a change -- so they must be the
 * same height. Derived from the type scale rather than picked: the body line box
 * is 21px, so 12px of vertical padding plus a 1px border on each side is the
 * smallest height that centres a line of body text with the padding the
 * spacing scale calls for.
 *
 * `Button` size `md` uses this too, so a primary action sitting under a row of
 * fields lines up with them.
 */
export const controlHeight = 46;

/** Height of a segmented-control segment and a filter chip. */
export const chipHeight = 36;

// ---------------------------------------------------------------------------
// Typography
//
// A single scale used everywhere. `fontFamily` resolves to the bundled Inter
// faces; `variant` maps to font weight rather than a separate family name,
// because React Native selects weight through fontWeight on a single family.
// ---------------------------------------------------------------------------

const fontFamily = {
  regular: 'Inter-Regular',
  medium: 'Inter-Medium',
  semibold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
} as const;

export interface TypeStyle extends TextStyle {
  fontFamily: string;
}

export const typography = {
  /** Screen title. Large and bold, as specified. */
  display: {
    fontFamily: fontFamily.bold,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.5,
  },
  /** Page heading. */
  title: {
    fontFamily: fontFamily.bold,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  /** Section heading within a screen. */
  heading: {
    fontFamily: fontFamily.semibold,
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  /** Row title / list item primary text. */
  subtitle: {
    fontFamily: fontFamily.semibold,
    fontSize: 15,
    lineHeight: 20,
  },
  body: {
    fontFamily: fontFamily.regular,
    fontSize: 15,
    lineHeight: 21,
  },
  /** Supporting text under a title. */
  caption: {
    fontFamily: fontFamily.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  /** Smallest text still allowed. 12pt is the floor -- never smaller. */
  micro: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    lineHeight: 16,
  },
  /** Money and counts. Tabular figures keep columns aligned. */
  numeric: {
    fontFamily: fontFamily.semibold,
    fontSize: 17,
    lineHeight: 22,
    fontVariant: ['tabular-nums' as const],
  },
  numericLarge: {
    fontFamily: fontFamily.bold,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.6,
    fontVariant: ['tabular-nums' as const],
  },
} satisfies Record<string, TypeStyle>;

// ---------------------------------------------------------------------------
// Icon sizes
//
// Lucide icons are drawn on a 24px grid and scaled by size/24. Keeping these
// few steps prevents the mismatched icon sizes that make an app look amateur.
// ---------------------------------------------------------------------------

export const iconSize = {
  sm: 16,
  md: 20,
  lg: 24,
  xl: 28,
} as const;

// ---------------------------------------------------------------------------
// Elevation
//
// Restrained on purpose: on a dark background, heavy shadows read as smudges.
// Borders carry most of the separation, and elevation is reserved for things
// that genuinely float (sheets, dialogs, the tab bar).
// ---------------------------------------------------------------------------

export const elevation = {
  none: {} satisfies ViewStyle,
  card: Platform.select<ViewStyle>({
    ios: {
      shadowColor: '#0F172A',
      shadowOpacity: 0.05,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
    },
    android: { elevation: 1 },
    default: {},
  })!,
  sheet: Platform.select<ViewStyle>({
    ios: {
      shadowColor: '#0F172A',
      shadowOpacity: 0.16,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: -4 },
    },
    android: { elevation: 24 },
    default: {},
  })!,
};

// ---------------------------------------------------------------------------
// Motion
//
// Fast and interruptible. Nothing in the app animates for longer than a
// quarter second, because perceived speed is mostly about how quickly the app
// acknowledges a touch.
// ---------------------------------------------------------------------------

export const motion = {
  instant: 90,
  fast: 150,
  normal: 220,
  /** Full-screen modal presentation. */
  slow: 280,
} as const;

/** Standard press opacity. Slightly lower on Android, where ripple already signals feedback. */
export const PRESSED_OPACITY = Platform.OS === 'ios' ? 0.65 : 0.75;

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

export const layout = {
  tabBarHeight: 56,
  /** Height reserved for the floating primary action on list screens. */
  fabSize: 56,
  minListItemHeight: touchTarget.comfortable,
  /**
   * The square tile behind a list-row icon. Paired with `radius.pill` so the
   * tile is a circle at any size, without each call site hardcoding half its own
   * width.
   */
  iconTile: 32,
} as const;
