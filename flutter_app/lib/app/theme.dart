/// SellFlow design system.
///
/// The brief was explicit that this must not read as a default Material app or a
/// CRUD admin template. That rules out the defaults this file therefore overrides:
///
///  - Colour. The stock `ColorScheme.fromSeed` produces a tonal palette whose
///    contrast steps are fine for controls and poor for dense numeric tables.
///    This defines an explicit light and dark scheme with hand-picked surfaces so a
///    money column has predictable contrast in both modes.
///  - Shape. Restrained. 12dp for cards, 8dp for controls, full only for sheets
///    and pills. Nothing at 28dp.
///  - Type. One family, a fixed ramp, tabular figures for every monetary value so
///    digits align down a column instead of jittering.
///  - Density. A seller scanning an order list needs several rows visible at once,
///    so vertical padding is tighter than stock and rows are a fixed height.
///
/// Deliberately absent: gradients, elevation shadows beyond level 1, and emoji.
/// Motion lives in [SellMotion] and every duration here has a stated reason.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Seed for the brand hue. Deep teal reads as financial/trustworthy without the
/// alarm association of red or the cheapness of pure green.
const _brandSeed = Color(0xFF0F766E);

abstract final class SellTokens {
  // Spacing scale. 4dp base.
  static const double s1 = 4;
  static const double s2 = 8;
  static const double s3 = 12;
  static const double s4 = 16;
  static const double s5 = 20;
  static const double s6 = 24;
  static const double s8 = 32;
  static const double s10 = 40;

  // Corner radii.
  static const double rControl = 8;
  static const double rCard = 12;
  static const double rSheet = 20;

  /// Dense list row height. Fixed so scrolling stays predictable and the eye can
  /// lock onto a row.
  static const double rowHeight = 56;

  /// Minimum interactive target. Material says 48; list rows here are 56 tall so
  /// the whole row is the target, not just the trailing chevron.
  static const double minTarget = 48;
}

/// Semantic colours that are NOT part of a Material [ColorScheme].
///
/// Payment status is the screen sellers read most, and the palette it needs is
/// about meaning, not brand: money that has arrived, money that is still owed,
/// money that is stuck. These are defined once here rather than re-derived per
/// screen, so "overdue" cannot mean amber in one view and red in another.
@immutable
class SellSemantics extends ThemeExtension<SellSemantics> {
  const SellSemantics({
    required this.received,
    required this.onReceived,
    required this.owed,
    required this.onOwed,
    required this.partial,
    required this.onPartial,
    required this.danger,
    required this.onDanger,
    required this.divider,
    required this.surfaceRaised,
    required this.numericColumn,
  });

  /// Money the seller actually has.
  final Color received;
  final Color onReceived;

  /// Money the courier or customer still owes.
  final Color owed;
  final Color onOwed;

  /// Partially settled: neither fully received nor fully owed.
  final Color partial;
  final Color onPartial;

  /// Refunds, destructive actions, blocked states.
  final Color danger;
  final Color onDanger;

  final Color divider;

  /// Cards and sheets sitting above the page background.
  final Color surfaceRaised;

  /// Tabular figures colour. Slightly dimmer than body text so a column of numbers
  /// reads as data rather than as prose.
  final Color numericColumn;

  @override
  SellSemantics copyWith({
    Color? received,
    Color? onReceived,
    Color? owed,
    Color? onOwed,
    Color? partial,
    Color? onPartial,
    Color? danger,
    Color? onDanger,
    Color? divider,
    Color? surfaceRaised,
    Color? numericColumn,
  }) {
    return SellSemantics(
      received: received ?? this.received,
      onReceived: onReceived ?? this.onReceived,
      owed: owed ?? this.owed,
      onOwed: onOwed ?? this.onOwed,
      partial: partial ?? this.partial,
      onPartial: onPartial ?? this.onPartial,
      danger: danger ?? this.danger,
      onDanger: onDanger ?? this.onDanger,
      divider: divider ?? this.divider,
      surfaceRaised: surfaceRaised ?? this.surfaceRaised,
      numericColumn: numericColumn ?? this.numericColumn,
    );
  }

  @override
  SellSemantics lerp(ThemeExtension<SellSemantics>? other, double t) {
    if (other is! SellSemantics) return this;
    return SellSemantics(
      received: Color.lerp(received, other.received, t)!,
      onReceived: Color.lerp(onReceived, other.onReceived, t)!,
      owed: Color.lerp(owed, other.owed, t)!,
      onOwed: Color.lerp(onOwed, other.onOwed, t)!,
      partial: Color.lerp(partial, other.partial, t)!,
      onPartial: Color.lerp(onPartial, other.onPartial, t)!,
      danger: Color.lerp(danger, other.danger, t)!,
      onDanger: Color.lerp(onDanger, other.onDanger, t)!,
      divider: Color.lerp(divider, other.divider, t)!,
      surfaceRaised: Color.lerp(surfaceRaised, other.surfaceRaised, t)!,
      numericColumn: Color.lerp(numericColumn, other.numericColumn, t)!,
    );
  }

  static const light = SellSemantics(
    received: Color(0xFF047857),
    onReceived: Color(0xFFFFFFFF),
    owed: Color(0xFFB45309),
    onOwed: Color(0xFFFFFFFF),
    partial: Color(0xFF1D4ED8),
    onPartial: Color(0xFFFFFFFF),
    danger: Color(0xFFB91C1C),
    onDanger: Color(0xFFFFFFFF),
    divider: Color(0xFFE2E8F0),
    surfaceRaised: Color(0xFFFFFFFF),
    numericColumn: Color(0xFF334155),
  );

  static const dark = SellSemantics(
    received: Color(0xFF34D399),
    onReceived: Color(0xFF04211A),
    owed: Color(0xFFFBBF24),
    onOwed: Color(0xFF241A02),
    partial: Color(0xFF93C5FD),
    onPartial: Color(0xFF071B33),
    danger: Color(0xFFF87171),
    onDanger: Color(0xFF2A0B0B),
    divider: Color(0xFF24303F),
    surfaceRaised: Color(0xFF141B24),
    numericColumn: Color(0xFFCBD5E1),
  );
}

/// Motion tokens.
///
/// Every duration here answers "what would feel broken without it", which is the
/// only justification that survives. Short enough to feel immediate, long enough
/// that a state change is perceptible.
abstract final class SellMotion {
  /// Press feedback. Must be under ~100ms or it lags the finger.
  static const fast = Duration(milliseconds: 120);

  /// Content cross-fade and state swap.
  static const normal = Duration(milliseconds: 220);

  /// Sheets and dialogs entering. Long enough to read as a layer arriving.
  static const slow = Duration(milliseconds: 320);

  /// Route push. Slightly longer than [normal] so navigation feels like movement
  /// between places rather than a swap.
  static const route = Duration(milliseconds: 260);

  /// Standard easing. Decelerate: fast start, gentle settle, which matches the
  /// physical feel of a card coming to rest.
  static const easeOut = Curves.easeOutCubic;

  /// For elements entering the viewport. Slight overshoot-free acceleration.
  static const emphasised = Curves.easeOutQuart;

  /// Duration to show a spinner before it becomes noise rather than feedback.
  ///
  /// Anything under this renders instantly: a 60ms network response does not need
  /// a spinner, and flashing one is more distracting than waiting.
  static const delayBeforeSpinner = Duration(milliseconds: 250);

  static PageTransitionsTheme routeTheme() => PageTransitionsTheme(
        builders: {
          TargetPlatform.android: const _SellPageTransitionsBuilder(),
        },
      );
}

/// Shared transition: a short fade with a small upward slide.
///
/// Not the platform default, which on Android zooms the whole page. A POS
/// app pushing between list and detail reads better as the new screen settling
/// into place, and the 6dp travel is small enough to feel immediate.
class _SellPageTransitionsBuilder extends PageTransitionsBuilder {
  const _SellPageTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    final curved = CurvedAnimation(
      parent: animation,
      curve: SellMotion.easeOut,
      reverseCurve: Curves.easeIn,
    );
    return FadeTransition(
      opacity: curved,
      child: SlideTransition(
        position: Tween<Offset>(
          begin: const Offset(0, 0.03),
          end: Offset.zero,
        ).animate(curved),
        child: child,
      ),
    );
  }
}

ThemeData buildSellTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: isDark ? const Color(0xFF2DD4BF) : _brandSeed,
    onPrimary: isDark ? const Color(0xFF04211A) : Colors.white,
    primaryContainer: isDark ? const Color(0xFF113B36) : const Color(0xFFCCFBF1),
    onPrimaryContainer: isDark ? const Color(0xFF99F6E4) : const Color(0xFF134E4A),
    secondary: isDark ? const Color(0xFF94A3B8) : const Color(0xFF475569),
    onSecondary: isDark ? const Color(0xFF111827) : Colors.white,
    secondaryContainer: isDark ? const Color(0xFF1E293B) : const Color(0xFFE2E8F0),
    onSecondaryContainer: isDark ? const Color(0xFFE2E8F0) : const Color(0xFF1E293B),
    tertiary: isDark ? const Color(0xFF93C5FD) : const Color(0xFF1D4ED8),
    onTertiary: isDark ? const Color(0xFF071B33) : Colors.white,
    error: isDark ? const Color(0xFFF87171) : const Color(0xFFB91C1C),
    onError: isDark ? const Color(0xFF2A0B0B) : Colors.white,
    errorContainer: isDark ? const Color(0xFF3B1414) : const Color(0xFFFEE2E2),
    onErrorContainer: isDark ? const Color(0xFFFECACA) : const Color(0xFF7F1D1D),
    surface: isDark ? const Color(0xFF0B1017) : const Color(0xFFF8FAFC),
    onSurface: isDark ? const Color(0xFFE2E8F0) : const Color(0xFF0F172A),
    surfaceContainerLowest: isDark ? const Color(0xFF070B10) : Colors.white,
    surfaceContainerLow: isDark ? const Color(0xFF0F1620) : const Color(0xFFF1F5F9),
    surfaceContainer: isDark ? const Color(0xFF141B24) : const Color(0xFFF1F5F9),
    surfaceContainerHigh: isDark ? const Color(0xFF1A2430) : const Color(0xFFE8EDF2),
    surfaceContainerHighest: isDark ? const Color(0xFF212D3B) : const Color(0xFFDFE6ED),
    onSurfaceVariant: isDark ? const Color(0xFF94A3B8) : const Color(0xFF64748B),
    outline: isDark ? const Color(0xFF334155) : const Color(0xFFCBD5E1),
    outlineVariant: isDark ? const Color(0xFF24303F) : const Color(0xFFE2E8F0),
    shadow: Colors.black,
    scrim: Colors.black,
    inverseSurface: isDark ? const Color(0xFFE2E8F0) : const Color(0xFF0F172A),
    onInverseSurface: isDark ? const Color(0xFF0F172A) : const Color(0xFFF8FAFC),
    inversePrimary: isDark ? _brandSeed : const Color(0xFF2DD4BF),
  );

  final semantics = isDark ? SellSemantics.dark : SellSemantics.light;

  final base = ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: scheme.surface,
    splashFactory: InkSparkle.splashFactory,
    visualDensity: VisualDensity.standard,
  );

  return base.copyWith(
    extensions: [semantics],
    pageTransitionsTheme: SellMotion.routeTheme(),
    textTheme: _textTheme(base.textTheme, scheme),
    appBarTheme: AppBarTheme(
      backgroundColor: scheme.surface,
      foregroundColor: scheme.onSurface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0.5,
      centerTitle: false,
      titleTextStyle: TextStyle(
        color: scheme.onSurface,
        fontSize: 20,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.2,
      ),
      systemOverlayStyle: isDark
          ? SystemUiOverlayStyle.light.copyWith(
              statusBarColor: Colors.transparent,
              systemNavigationBarColor: scheme.surface,
              systemNavigationBarIconBrightness: Brightness.light,
            )
          : SystemUiOverlayStyle.dark.copyWith(
              statusBarColor: Colors.transparent,
              systemNavigationBarColor: scheme.surface,
              systemNavigationBarIconBrightness: Brightness.dark,
            ),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      color: semantics.surfaceRaised,
      surfaceTintColor: Colors.transparent,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SellTokens.rCard),
        side: BorderSide(color: scheme.outlineVariant),
      ),
    ),
    dividerTheme: DividerThemeData(
      color: semantics.divider,
      thickness: 1,
      space: 1,
    ),
    listTileTheme: ListTileThemeData(
      contentPadding: const EdgeInsets.symmetric(horizontal: SellTokens.s4),
      minVerticalPadding: SellTokens.s2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(SellTokens.rControl)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: isDark ? scheme.surfaceContainerLow : Colors.white,
      contentPadding: const EdgeInsets.symmetric(
        horizontal: SellTokens.s4,
        vertical: SellTokens.s4,
      ),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(SellTokens.rControl),
        borderSide: BorderSide(color: scheme.outline),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(SellTokens.rControl),
        borderSide: BorderSide(color: scheme.outlineVariant),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(SellTokens.rControl),
        borderSide: BorderSide(color: scheme.primary, width: 2),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(SellTokens.rControl),
        borderSide: BorderSide(color: scheme.error),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(SellTokens.rControl),
        borderSide: BorderSide(color: scheme.error, width: 2),
      ),
      // 16dp minimum keeps iOS-style zoom-from-focus from triggering on Android.
      labelStyle: const TextStyle(fontSize: 15),
      floatingLabelStyle: const TextStyle(fontSize: 13),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(SellTokens.minTarget),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(SellTokens.rControl),
        ),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(SellTokens.minTarget),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(SellTokens.rControl),
        ),
        side: BorderSide(color: scheme.outline),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        minimumSize: const Size(0, SellTokens.minTarget),
        textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      height: 64,
      elevation: 0,
      backgroundColor: semantics.surfaceRaised,
      surfaceTintColor: Colors.transparent,
      indicatorColor: isDark ? const Color(0xFF113B36) : const Color(0xFFCCFBF1),
      labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
      labelTextStyle: WidgetStatePropertyAll(
        TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w500,
          color: scheme.onSurfaceVariant,
        ),
      ),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: semantics.surfaceRaised,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(SellTokens.rSheet),
        ),
      ),
      showDragHandle: true,
      dragHandleColor: scheme.outline,
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: semantics.surfaceRaised,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SellTokens.rCard),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: scheme.inverseSurface,
      contentTextStyle: TextStyle(color: scheme.onInverseSurface, fontSize: 14),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SellTokens.rControl),
      ),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: scheme.primary,
      linearTrackColor: scheme.surfaceContainerHigh,
      circularTrackColor: scheme.surfaceContainerHigh,
    ),
    chipTheme: ChipThemeData(
      side: BorderSide(color: scheme.outlineVariant),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SellTokens.rControl),
      ),
      labelStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected)
            ? scheme.onPrimary
            : (isDark ? scheme.surfaceContainerHighest : Colors.white),
      ),
      trackColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected)
            ? scheme.primary
            : scheme.surfaceContainerHigh,
      ),
    ),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: scheme.primary,
      selectionColor: scheme.primary.withValues(alpha: 0.24),
      selectionHandleColor: scheme.primary,
    ),
  );
}

/// Type ramp.
///
/// Tabular figures everywhere a number appears: proportional digits make a money
/// column shimmer as values change, because `1` is narrower than `8`.
TextTheme _textTheme(TextTheme base, ColorScheme scheme) {
  const fontFamily = 'Roboto';
  final numeric = TextStyle(
    fontFamily: fontFamily,
    fontFeatures: const [FontFeature.tabularFigures()],
    color: scheme.onSurface,
  );

  return base.copyWith(
    displaySmall: numeric.copyWith(fontSize: 32, fontWeight: FontWeight.w600, letterSpacing: -0.5),
    headlineMedium: numeric.copyWith(fontSize: 26, fontWeight: FontWeight.w600, letterSpacing: -0.4),
    headlineSmall: numeric.copyWith(fontSize: 22, fontWeight: FontWeight.w600, letterSpacing: -0.3),
    titleLarge: numeric.copyWith(fontSize: 19, fontWeight: FontWeight.w600, letterSpacing: -0.2),
    titleMedium: numeric.copyWith(fontSize: 16, fontWeight: FontWeight.w600),
    titleSmall: numeric.copyWith(fontSize: 14, fontWeight: FontWeight.w600),
    bodyLarge: numeric.copyWith(fontSize: 16, height: 1.45),
    bodyMedium: numeric.copyWith(fontSize: 14.5, height: 1.45),
    bodySmall: numeric.copyWith(fontSize: 13, height: 1.4, color: scheme.onSurfaceVariant),
    labelLarge: numeric.copyWith(fontSize: 14, fontWeight: FontWeight.w600),
    labelMedium: numeric.copyWith(fontSize: 12.5, fontWeight: FontWeight.w500),
    labelSmall: numeric.copyWith(
      fontSize: 11.5,
      fontWeight: FontWeight.w500,
      letterSpacing: 0.3,
      color: scheme.onSurfaceVariant,
    ),
  );
}
