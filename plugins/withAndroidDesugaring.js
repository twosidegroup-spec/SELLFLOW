/**
 * Core library desugaring for Android.
 *
 * ## Why this exists
 *
 * The APK declared `minSdk 24` and so installed on Android 7.x, where it then
 * failed in a way nobody could see. A dependency reached for `java.time.Duration`
 * -- added in API 26 -- and the platform threw:
 *
 *   java.lang.NoClassDefFoundError: Failed resolution of: Ljava/time/Duration;
 *
 * That happens on a *native* path, so it never reaches the JS error handler and
 * never shows a red box. The observable result was the worst kind: the app opened
 * normally, sign-in worked, the business loaded from the network, and every list
 * on every screen silently rendered empty. Nothing in logcat pointed at the
 * cause.
 *
 * Raising `minSdk` to 26 would have hidden it by refusing to install. That is
 * defensible, but it drops every Android 7 and 8 seller for a packaging problem
 * rather than a real incompatibility, and the product page already promised the
 * APK worked on what it installed on.
 *
 * ## What it does
 *
 * Core library desugaring back-ports the `java.time` family (and other Java 8+
 * library APIs) onto older runtimes, so those calls resolve on API 24 and 25
 * instead of throwing. The app then genuinely honours its own `minSdk`.
 *
 * ## Why a config plugin rather than build.gradle
 *
 * `/android` is gitignored. It is regenerated from `app.json` on every prebuild
 * and every EAS build, so an edit to `android/app/build.gradle` survives on one
 * machine and nowhere else -- it will never reach a release. Anything that has to
 * apply to a shipped APK has to live in tracked source: either `app.json` or a
 * plugin like this one. `plugins/withSellflowSms.js` already works this way for
 * the SMS receiver.
 */

const { withAppBuildGradle, withProjectBuildGradle } = require('expo/config-plugins');

/**
 * Kept in step with the Android Gradle Plugin's supported desugar release.
 * AGP 8.x pairs with desugar_jdk_libs 2.1.x; 2.0.x is rejected by AGP 8.9+.
 */
const DESUGAR_JDK_LIBS_VERSION = '2.1.5';

/**
 * Java 11 language level.
 *
 * Required by desugaring, and also what RN 0.86's own native sources target.
 * Setting it on the module rather than only the app keeps library modules
 * compiling against the same level as the app that consumes them, which is what
 * stops a duplicate-class mismatch at dex time.
 */
const JAVA_VERSION = '11';

const isJava = (block, key) => new RegExp(`${key}\\s+['"]\\d+['"]`);


/**
 * The application-module transform, as a pure string function.
 *
 * Separated from the Expo mod wrapper so it can be checked without a JDK, a
 * Gradle run or an Android SDK -- `plugins/verify-desugaring.mjs` runs it against
 * the real generated `build.gradle`. A plugin that can only be validated by
 * building an APK is a plugin that goes wrong unnoticed.
 *
 * Idempotent: running it on its own output changes nothing, so a prebuild that
 * runs twice does not accumulate duplicate blocks.
 */
function applyAppGradle(contents) {
  let next = contents;

  if (!next.includes('coreLibraryDesugaringEnabled')) {
    next = next.replace(
      /android\s*\{/,
      `android {
    compileOptions {
        // Back-ports java.time and the rest of the Java 8+ library API surface
        // onto API 24-25, which is what lets this APK honour its own minSdk
        // instead of throwing NoClassDefFoundError on Android 7.
        coreLibraryDesugaringEnabled true
        sourceCompatibility JavaVersion.VERSION_${JAVA_VERSION}
        targetCompatibility JavaVersion.VERSION_${JAVA_VERSION}
    }`,
    );
  }

  if (!next.includes('coreLibraryDesugaring ')) {
    next = next.replace(
      /dependencies\s*\{/,
      `dependencies {
    // Must stay in step with coreLibraryDesugaringEnabled above; a version skew
    // between the two fails the build rather than the app, which is the good case.
    coreLibraryDesugaring "com.android.tools:desugar_jdk_libs:${DESUGAR_JDK_LIBS_VERSION}"`,
    );
  }

  return next;
}

/**
 * The root-project transform, as a pure string function. Idempotent.
 *
 * Aligns the Java level across modules and deliberately does NOT enable
 * core library desugaring here.
 *
 * An earlier version of this file set `coreLibraryDesugaringEnabled true` on
 * every subproject. That fails the build:
 *
 *   > coreLibraryDesugaring configuration contains no dependencies.
 *   > Could not create task ':sellflow-sms:writeReleaseAarMetadata'.
 *
 * Enabling desugaring is a promise that the module also carries the
 * `desugar_jdk_libs` dependency, and only the app module does. Library modules
 * produce AARs; the app does the dexing, so the app is the only place the flag
 * and the dependency belong. Libraries only need a Java level that matches the
 * app's, or their bytecode and the app's desugared output disagree at dex time.
 *
 * Targets the `allprojects { }` block Expo generates, not `subprojects { }` --
 * the generated root build.gradle has no `subprojects` block, so a pattern
 * written for a hand-rolled project would silently match nothing and look like it
 * worked. Verified by plugins/verify-desugaring.mjs against the real file.
 */
function applyProjectGradle(contents) {
  if (contents.includes('javaLevelAlignedBySellflow')) return contents;

  const anchor = /allprojects\s*\{/.test(contents)
    ? /allprojects\s*\{/
    : /subprojects\s*\{/;

  if (!anchor.test(contents)) {
    throw new Error(
      'withAndroidDesugaring: found neither an allprojects nor a subprojects block in ' +
        'android/build.gradle. The Java level for library modules has to be set ' +
        'somewhere, or the app desugars to Java 11 bytecode while its dependencies ' +
        'stay on 8 and fail at dex time. Port applyProjectGradle in ' +
        'plugins/withAndroidDesugaring.js to whatever this project now generates.',
    );
  }

  return contents.replace(
    anchor,
    (match) => `${match}
    // javaLevelAlignedBySellflow
    //
    // Java level only. Core library desugaring is NOT enabled here on purpose --
    // see the note on applyProjectGradle. Enabling it per-module without also
    // giving each module the desugar_jdk_libs dependency fails the build with
    // "coreLibraryDesugaring configuration contains no dependencies".
    subprojects { project ->
        afterEvaluate {
            if (project.hasProperty("android")) {
                project.android {
                    compileOptions {
                        sourceCompatibility JavaVersion.VERSION_${JAVA_VERSION}
                        targetCompatibility JavaVersion.VERSION_${JAVA_VERSION}
                    }
                }
            }
        }
    }`,
  );
}

/**
 * Turns desugaring on for the application module.
 *
 * `withAppBuildGradle` runs against `android/app/build.gradle`, which is the
 * module whose `minSdk` decides whether the APK installs on a given device. That
 * makes it the one that has to agree: an app that desugars nothing but depends on
 * a library that does still throws at runtime.
 */
function withAppDesugaring(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      // build.gradle.kts is generated if the project ever moves to Kotlin DSL.
      // Bailing loudly beats writing Groovy into a .kts file and failing the build
      // with a syntax error nobody can trace back to this plugin.
      throw new Error(
        'withAndroidDesugaring: android/app/build.gradle.kts is not supported yet. ' +
          'Port the Groovy edits in plugins/withAndroidDesugaring.js to Kotlin DSL.',
      );
    }

    cfg.modResults.contents = applyAppGradle(cfg.modResults.contents);
    return cfg;
  });
}

/**
 * Applies the same Java level to every library module.
 *
 * Without this, a library module still compiling against Java 8 while the app is
 * on 11 produces a dex merge mismatch at build time. Cheaper to set once here
 * than to debug it later as an unrelated "duplicate class" failure.
 */
function withLibraryDesugaring(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') return cfg;

    cfg.modResults.contents = applyProjectGradle(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = function withAndroidDesugaring(config) {
  config = withAppDesugaring(config);
  config = withLibraryDesugaring(config);
  return config;
};

module.exports.applyAppGradle = applyAppGradle;
module.exports.applyProjectGradle = applyProjectGradle;
module.exports.DESUGAR_JDK_LIBS_VERSION = DESUGAR_JDK_LIBS_VERSION;

