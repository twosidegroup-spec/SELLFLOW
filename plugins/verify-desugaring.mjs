import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { applyAppGradle, applyProjectGradle, DESUGAR_JDK_LIBS_VERSION } = require("../plugins/withAndroidDesugaring.js");

const app = applyAppGradle(readFileSync("android/app/build.gradle", "utf8"));
const proj = applyProjectGradle(readFileSync("android/build.gradle", "utf8"));

const balanced = (t) => (t.match(/\{/g) || []).length === (t.match(/\}/g) || []).length;
const checks = [
  ["desugaring enabled", /coreLibraryDesugaringEnabled\s+true/.test(app)],
  [`desugar_jdk_libs ${DESUGAR_JDK_LIBS_VERSION} dependency`, new RegExp(`coreLibraryDesugaring\\s+"com\\.android\\.tools:desugar_jdk_libs:${DESUGAR_JDK_LIBS_VERSION.replace(/\./g, "\\.")}"`).test(app)],
  ["sourceCompatibility 11", /sourceCompatibility JavaVersion\.VERSION_11/.test(app)],
  ["targetCompatibility 11", /targetCompatibility JavaVersion\.VERSION_11/.test(app)],
  ["allprojects block targeted", /allprojects\s*\{/.test(readFileSync("android/build.gradle","utf8"))],
  ["project does NOT enable desugaring (would fail build)", !/coreLibraryDesugaringEnabled/.test(proj)],
  ["project java level aligned", /sourceCompatibility JavaVersion\.VERSION_11/.test(proj)],
  ["project subprojects afterEvaluate", /afterEvaluate/.test(proj)],
  ["app braces balanced", balanced(app)],
  ["project braces balanced", balanced(proj)],
  ["app idempotent", applyAppGradle(app) === app],
  ["project idempotent", applyProjectGradle(proj) === proj],
  ["minSdk still 24 (all Android)", /minSdkVersion rootProject\.ext\.minSdkVersion/.test(readFileSync("android/app/build.gradle","utf8"))],
];
let bad = 0;
for (const [l, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}`); if (!ok) bad++; }
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
