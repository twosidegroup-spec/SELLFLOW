/**
 * SellFlow V2 design tokens.
 *
 * Written from zero for the rebuild. Every value in the application comes from
 * this file or from `scripts/design-audit.mjs` fails the build -- that is the
 * mechanism that makes "no random one-off styling" enforceable rather than
 * aspirational.
 *
 * DESIGN DIRECTION
 *
 * Premium fintech meets modern SaaS. The reference points are the tools serious
 * operators already trust -- the density and numeric discipline of a trading
 * terminal, the restraint of a well-set editorial layout -- not a consumer app.
 *
 * The rules that produce that look:
 *
 *   * Colour does almost nothing. One brand hue, one warm accent for money, and
 *     three semantic states. Chrome is greyscale, so colour carries meaning
 *     instead of decoration.
 *   * Type does the work. One family, four weights, a tight scale, and a
 *     dedicated tabular numeric style so columns of money align to the digit.
 *   * Space is a 4pt grid with a deliberately short scale. Nine steps is enough
 *     for any screen; a longer scale is a symptom of inconsistent judgement.
 *   * Borders over shadows. Elevation is a hairline plus a barely-there shadow,
 *     which survives a dark theme without becoming a grey smear.
 *
 * LIGHT AND DARK
 *
 * Both are authored, not derived. Dark mode is not light mode with inverted
 * values: pure white on pure black vibrates, so the dark background is a deep
 * blue-black and surfaces step upward in lightness rather than downward.
 */

// ---------------------------------------------------------------------------
// Palette primitives
// ---------------------------------------------------------------------------

/**
 * Raw hues. Not exported for general use -- components consume the semantic
 * scales below. Exported because the design audit needs to check that the two
 * semantic sets reference these and nothing else.
 */
const palette = {
  /*
   * Neutral ramp. Very slightly blue: pure grey reads cold and clinical next to
   * warm accent colours, and this keeps surfaces feeling calm rather than dead.
   *
   * `n50` and `n975` are pinned to the splash colours already configured in
   * `app.json` (#F8FAFC / #0B1120). That is not a coincidence to be tidied later:
   * `expo-splash-screen` takes its colour as a literal, so if these two ever
   * diverge the seller sees a flash of the wrong colour between the native splash
   * and the first React frame. `scripts/splash-assets.test.mjs` asserts the
   * equality so the tie cannot silently rot.
   */
  n0: '#FFFFFF',
  n25: '#FCFCFD',
  n50: '#F8FAFC',
  n100: '#EFF1F5',
  n150: '#E6E9EF',
  n200: '#DBDFE8',
  n300: '#C2C8D4',
  n400: '#98A1B2',
  n500: '#6E7788',
  n600: '#525B6B',
  n700: '#3A4250',
  n800: '#252B36',
  n850: '#1B202A',
  n900: '#141821',
  n950: '#0D1117',
  n975: '#0B1120',

  // Brand: a deep indigo. Trustworthy, reads as finance without being a bank,
  // and holds contrast against both the warm accent and the neutral ramp.
  brand50: '#EEF2FF',
  brand100: '#E0E7FF',
  brand200: '#C7D2FE',
  brand300: '#A5B4FC',
  brand400: '#818CF8',
  brand500: '#6366F1',
  brand600: '#4F46E5',
  brand700: '#4338CA',
  brand800: '#3730A3',
  brand900: '#262179',

  // Accent: warm amber. Used ONLY for money -- revenue, profit, cash received.
  // One hue for one meaning means a seller reads the screen faster.
  amber50: '#FFFBEB',
  amber100: '#FEF3C7',
  amber200: '#FDE68A',
  amber400: '#FBBF24',
  amber500: '#F59E0B',
  amber600: '#D97706',
  amber700: '#B45309',
  amber800: '#92400E',

  // Semantic states.
  green50: '#ECFDF5',
  green100: '#D1FAE5',
  green200: '#A7F3D0',
  green500: '#10B981',
  green600: '#059669',
  green700: '#047857',
  green800: '#065F46',

  red50: '#FEF2F2',
  red100: '#FEE2E2',
  red200: '#FECACA',
  red500: '#EF4444',
  red600: '#DC2626',
  red700: '#B91C1C',
  red800: '#991B1B',

  blue50: '#EFF6FF',
  blue100: '#DBEAFE',
  blue200: '#BFDBFE',
  blue500: '#3B82F6',
  blue600: '#2563EB',
  blue700: '#1D4ED8',
} as const;

export type Palette = typeof palette;

// ---------------------------------------------------------------------------
// Semantic colour
// ---------------------------------------------------------------------------

export interface ThemeColors {
  /** App background, behind cards. */
  background: string;
  /** Raised surface: cards, sheets, menus. */
  surface: string;
  /** Recessed surface: table headers, wells, skeletons. */
  surfaceSunken: string;
  /** Inputs at rest. */
  surfaceInput: string;
  /** Fill for a pressed or selected row. */
  surfaceHover: string;

  /** Primary body text. */
  text: string;
  /** Supporting copy: labels, subtitles. */
  textSecondary: string;
  /** Placeholders, timestamps, disabled. Never for information a seller needs. */
  textMuted: string;
  /** Text on a saturated fill. */
  textInverse: string;

  border: string;
  /** Hairline used inside a component, e.g. a row divider. */
  borderSubtle: string;
  borderStrong: string;
  /** Focus ring. Always visible against `background`. */
  focus: string;

  primary: string;
  primaryHover: string;
  primaryPressed: string;
  onPrimary: string;
  /** Tinted fill for a primary action that should recede, e.g. a banner. */
  primarySoft: string;
  primaryBorder: string;

  /** Money. Revenue, profit, received. The only place amber is used. */
  accent: string;
  accentSoft: string;
  accentBorder: string;
  onAccent: string;

  success: string;
  successSoft: string;
  successBorder: string;
  onSuccess: string;
  successStrong: string;

  warning: string;
  warningSoft: string;
  warningBorder: string;
  onWarning: string;
  warningStrong: string;

  danger: string;
  dangerSoft: string;
  dangerBorder: string;
  onDanger: string;
  dangerStrong: string;

  info: string;
  infoSoft: string;
  infoBorder: string;
  onInfo: string;

  skeleton: string;
  /** Overlay behind a modal. */
  scrim: string;
  /** The wordmark's brand tile gradient, two stops. */
  brandGradient: [string, string];
}

export const lightColors: ThemeColors = {
  background: palette.n50,
  surface: palette.n0,
  surfaceSunken: palette.n100,
  surfaceInput: palette.n0,
  surfaceHover: palette.n100,

  text: palette.n900,
  textSecondary: palette.n600,
  /**
   * `n600`, not `n500`.
   *
   * `n500` on `n50` measures 4.31:1 and fails WCAG AA for body text. Muted text is
   * still text a seller has to read -- timestamps, helper copy, a unit next to a
   * figure -- so it gets the same threshold as `textSecondary`. It reads as quieter
   * because it is lighter than body, not because it is allowed to be unreadable.
   */
  textMuted: palette.n600,
  textInverse: palette.n0,

  border: palette.n200,
  borderSubtle: palette.n150,
  borderStrong: palette.n300,
  focus: palette.brand500,

  primary: palette.brand600,
  primaryHover: palette.brand700,
  primaryPressed: palette.brand800,
  onPrimary: palette.n0,
  primarySoft: palette.brand50,
  primaryBorder: palette.brand200,

  accent: palette.amber600,
  accentSoft: palette.amber50,
  accentBorder: palette.amber200,
  onAccent: palette.n0,

  success: palette.green600,
  successSoft: palette.green50,
  successBorder: palette.green200,
  onSuccess: palette.n0,
  successStrong: palette.green700,

  warning: palette.amber600,
  warningSoft: palette.amber50,
  warningBorder: palette.amber200,
  onWarning: palette.n0,
  warningStrong: palette.amber800,

  danger: palette.red600,
  dangerSoft: palette.red50,
  dangerBorder: palette.red200,
  onDanger: palette.n0,
  dangerStrong: palette.red700,

  info: palette.blue600,
  infoSoft: palette.blue50,
  infoBorder: palette.blue200,
  onInfo: palette.n0,

  skeleton: palette.n150,
  scrim: 'rgba(13, 17, 23, 0.45)',
  brandGradient: [palette.brand600, palette.brand800],
};

export const darkColors: ThemeColors = {
  // Not #000000. A pure black background with white text causes halation on
  // OLED panels and makes elevation impossible to read. This is deep enough to
  // feel like night, light enough that a hairline border still separates
  // surfaces.
  background: palette.n975,
  surface: palette.n900,
  surfaceSunken: palette.n850,
  surfaceInput: palette.n850,
  surfaceHover: palette.n850,

  text: palette.n50,
  textSecondary: palette.n300,
  textMuted: palette.n400,
  textInverse: palette.n950,

  border: palette.n800,
  borderSubtle: palette.n850,
  borderStrong: palette.n700,
  focus: palette.brand400,

  // Lighter than the light-mode hue: on a dark surface a saturated indigo at the
  // same value stops reading as a brand and starts reading as a smudge.
  primary: palette.brand400,
  primaryHover: palette.brand300,
  primaryPressed: palette.brand200,
  onPrimary: palette.n975,
  primarySoft: palette.n900,
  primaryBorder: palette.n800,

  accent: palette.amber400,
  accentSoft: palette.n950,
  accentBorder: palette.n800,
  onAccent: palette.n975,

  success: palette.green500,
  successSoft: palette.n950,
  successBorder: palette.n800,
  onSuccess: palette.n975,
  successStrong: palette.green200,

  warning: palette.amber400,
  warningSoft: palette.n950,
  warningBorder: palette.n800,
  onWarning: palette.n975,
  warningStrong: palette.amber200,

  danger: palette.red500,
  dangerSoft: palette.n950,
  dangerBorder: palette.n800,
  onDanger: palette.n975,
  dangerStrong: palette.red200,

  info: palette.blue500,
  infoSoft: palette.n950,
  infoBorder: palette.n800,
  onInfo: palette.n975,

  skeleton: palette.n850,
  scrim: 'rgba(0, 0, 0, 0.65)',
  brandGradient: [palette.brand500, palette.brand800],
};

// ---------------------------------------------------------------------------
// Spacing
// ---------------------------------------------------------------------------

/**
 * A 4pt grid, nine steps.
 *
 * The old system had the same count. This is not inertia: past ~10 steps a
 * scale stops guiding decisions and starts hiding them, because almost any value
 * you want is "a step". A short scale means spacing choices are visible in
 * review, which is the point of having one.
 */
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

/** Standard horizontal inset from a screen edge. */
export const SCREEN_PADDING = spacing.lg;

// ---------------------------------------------------------------------------
// Radii
// ---------------------------------------------------------------------------

/**
 * Each value states what the thing IS, which is why there are six rather than an
 * arbitrary curve. Adding a seventh is a design decision, not a convenience.
 *
 *   sm      small marks, nested tags, tiny swatches
 *   control inputs, buttons -- anything a finger lands on
 *   mark    the brand tile and inline notice blocks
 *   card    cards, panels, list containers
 *   sheet   sheets and modals, where a softer corner reads as "floating"
 *   pill    badges, avatars, and fully-round marks
 */
export const radius = {
  sm: 6,
  control: 10,
  mark: 12,
  card: 14,
  sheet: 22,
  pill: 999,
} as const;

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/**
 * One family, four weights, loaded from `assets/fonts`.
 *
 * A seller reads figures far more than prose, so the numeric styles are treated
 * as first-class variants with tabular figures. `numeric` is for table cells and
 * metric values where the digits must line up vertically; `body` is never used
 * for money.
 *
 * `letterSpacing` is declared optional on every variant rather than left off the
 * ones that do not want it. An inferred union of eight object shapes with mixed
 * keys means consumers have to narrow before they can read `letterSpacing`, which
 * pushes the check onto every call site instead of resolving it once here.
 */
export interface TypeStyle {
  fontSize: number;
  lineHeight: number;
  fontWeight: '400' | '500' | '600' | '700';
  letterSpacing?: number;
  /**
   * Not `readonly`, even though the tokens below are declared `as const`-free.
   * React Native's `TextStyle` wants a mutable `FontVariant[]`, and a readonly
   * tuple is not assignable to one. Copying at the point of use is cheaper than
   * loosening the type, because this is the only consumer.
   */
  fontVariant?: ['tabular-nums'];
}

export type TypographyVariant =
  | 'display'
  | 'numericLarge'
  | 'title'
  | 'heading'
  | 'subtitle'
  | 'body'
  | 'bodyStrong'
  | 'caption'
  | 'micro'
  | 'numeric'
  | 'numericSmall';

export const typography: Record<TypographyVariant, TypeStyle> = {
  /** Screen-level number. One per view at most. */
  display: { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.6 },
  /** The number on a dashboard tile. */
  numericLarge: { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.5 },
  /** Page title. */
  title: { fontSize: 21, lineHeight: 27, fontWeight: '700', letterSpacing: -0.3 },
  /** Section heading. */
  heading: { fontSize: 17, lineHeight: 23, fontWeight: '600', letterSpacing: -0.2 },
  /** Supporting line under a heading. */
  subtitle: { fontSize: 15, lineHeight: 21, fontWeight: '500', letterSpacing: -0.1 },
  /** Default body. */
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  /** Table cells, list secondary lines. */
  bodyStrong: { fontSize: 15, lineHeight: 22, fontWeight: '600', letterSpacing: -0.1 },
  /** Labels, helper text. */
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  /** Section eyebrows, above-the-line metadata. */
  micro: { fontSize: 11, lineHeight: 15, fontWeight: '600', letterSpacing: 0.4 },

  /**
   * Tabular figures. `fontVariant` is what makes columns of money align; without
   * it a proportional 1 sits narrower than a 0 and a total visibly wobbles.
   */
  numeric: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
    letterSpacing: -0.1,
    fontVariant: ['tabular-nums'],
  },
  numericSmall: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    letterSpacing: 0,
    fontVariant: ['tabular-nums'],
  },
};

export const fontFamily = {
  regular: 'Inter-Regular',
  medium: 'Inter-Medium',
  semibold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
} as const;

/** Maps a typography weight token to a loaded font file. */
export function fontForWeight(weight: string): string {
  switch (weight) {
    case '700':
      return fontFamily.bold;
    case '600':
      return fontFamily.semibold;
    case '500':
      return fontFamily.medium;
    default:
      return fontFamily.regular;
  }
}

// ---------------------------------------------------------------------------
// Iconography
// ---------------------------------------------------------------------------

/**
 * A 4px scale. Icons come from lucide at `strokeWidth: 1.75`, which is the
 * setting that keeps a 20px glyph legible on a low-DPI Android panel instead of
 * turning into a grey blob.
 */
export const iconSize = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
} as const;

// ---------------------------------------------------------------------------
// Touch targets
// ---------------------------------------------------------------------------

export const touchTarget = {
  /** The absolute floor. Anything smaller is a bug, not a preference. */
  min: 44,
  /** Primary actions. */
  comfortable: 48,
} as const;

/**
 * Shared control heights, so a filter chip and a text input line up on the same
 * optical row regardless of which screen they appear on.
 */
export const controlHeight = 48;
export const chipHeight = 36;

// ---------------------------------------------------------------------------
// Elevation and borders
// ---------------------------------------------------------------------------

/**
 * Shadows, plus the border width they pair with.
 *
 * Elevation is a hairline first and a shadow second. That ordering is what makes
 * a single shadow set work in both themes: on light mode the shadow reads, and
 * on dark mode the border does the separating while the shadow stays subtle
 * enough not to turn grey surfaces muddy.
 */
/**
 * One shape for every level, so `Card` can spread a level straight into a style
 * without casting. An inferred union of four different object literals means the
 * consumer has to narrow before it can read `shadowOffset`, which pushes a cast
 * into every card -- and a cast here would silently accept a missing offset.
 */
export interface ElevationLevel {
  borderWidth: number;
  shadowColor: string;
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffset: { width: number; height: number };
  elevation: number;
}

export const elevation = {
  none: { borderWidth: 0, shadowColor: '#0D1117', shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 },
  flat: { borderWidth: 1, shadowColor: '#0D1117', shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 },
  raised: {
    borderWidth: 1,
    shadowColor: '#0D1117',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  overlay: {
    borderWidth: 1,
    shadowColor: '#0D1117',
    shadowOpacity: 0.16,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
} satisfies Record<string, ElevationLevel>;

export const borderWidth = {
  hairline: 1,
  thick: 2,
} as const;

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/**
 * Durations and easings, plus the scale that keeps them short.
 *
 * Motion here is confirmation, not decoration. A seller tapping "Record payment"
 * needs to see that the tap registered within ~100ms; anything longer reads as
 * the app thinking. The durations below are deliberately at the fast end of what
 * feels good.
 *
 * `easeOut` is the default. It decelerates into rest, which is what makes a
 * transition feel like it has arrived rather than been cut off.
 */
export const motion = {
  /** Press feedback. Fast enough to feel instant. */
  instant: 100,
  /** Small state changes: a chip, a toggle, a badge. */
  fast: 160,
  /** Default. Sheets, expands, most transitions. */
  base: 240,
  /** Large surfaces: modals, full-screen presentations. */
  slow: 320,

  easeOut: { tension: 180, friction: 22 },
  easeInOut: { tension: 160, friction: 24 },
  /** For springs only. Overshoots slightly; good for a confirmation. */
  spring: { tension: 240, friction: 18 },
} as const;

/** Delay before a number starts counting up, so the tile lands first. */
export const numberTransitionDelay = 80;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Breakpoints and structural widths.
 *
 * These match the marketing site's rail widths on purpose: the same viewport
 * should produce the same structural decision in the app and on the site.
 */
export const layout = {
  /** Tablet and above. */
  md: 768,
  /** Desktop: a persistent sidebar replaces the bottom tabs. */
  lg: 1024,
  /** Wide desktop. */
  xl: 1440,
  /** Readable column for a form or a long document. */
  maxFormWidth: 520,
  /** Readable column for prose. */
  maxProseWidth: 640,
  /** Caps how far a data table stretches. A 40-column table at 2560px is unreadable. */
  maxTableWidth: 1100,
  /** Web dashboard shell content cap. */
  webContentMax: 1280,
  /** Sidebar width on desktop web. */
  sidebar: 248,
  sidebarWide: 272,
  /** Bottom tab bar height, excluding the safe-area inset. */
  tabBar: 56,
  header: 56,
} as const;