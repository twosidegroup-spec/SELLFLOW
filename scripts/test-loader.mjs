/**
 * ESM loader for the SellFlow unit tests.
 *
 * The outbox and connectivity modules are written for React Native, so running
 * them under Node means standing in for three native modules. Everything else --
 * the actual outbox logic, the store, the storage wrapper, the error mapper --
 * is the real source, imported unmodified. Nothing is re-implemented here.
 *
 * Responsibilities:
 *   * resolve the `@/` path alias, which Node does not read from tsconfig
 *   * stub the native modules with controllable fakes
 *   * let a test import a FRESH copy of a module (restart simulation) by
 *     honouring a `?fresh=N` query on the specifier
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, resolve as resolvePath } from 'node:path';

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** Modules that must be replaced before the real code ever sees them. */
const STUBS = {
  'expo-network': 'scripts/__stubs__/expo-network.mjs',
  '@react-native-async-storage/async-storage': 'scripts/__stubs__/async-storage.mjs',
  '@supabase/supabase-js': 'scripts/__stubs__/supabase-js.mjs',
  // Flow-typed and unparseable by Node. Scripts that evaluate the real design
  // tokens need a stand-in for `Platform`.
  'react-native': 'scripts/__stubs__/react-native.mjs',
};

export async function resolve(specifier, context, nextResolve) {
  // The live probe needs the REAL supabase-js to talk to a real project. Every
  // other test wants the stub, so it stays the default.
  const useRealSupabase =
    specifier === '@supabase/supabase-js' && process.env.SELLFLOW_USE_REAL_SUPABASE === '1';

  // 1. Stub the native modules.
  const stub = useRealSupabase ? undefined : STUBS[specifier];
  if (stub) {
    return nextResolve(pathToFileURL(resolvePath(root, stub)).href, context);
  }

  // The generation marker a parent was imported with, so a whole module graph
  // restarts together. Without this, importing outbox.ts?fresh=2 would give IT a
  // fresh copy of connectivity.ts while the test held the original -- two
  // separate zustand stores, and the test would silently assert against the
  // wrong one.
  const parentQuery = context.parentURL?.includes('?fresh=')
    ? context.parentURL.slice(context.parentURL.indexOf('?fresh='))
    : '';

  const [pathname, ownQuery] = specifier.split('?');
  const suffix = ownQuery ? `?${ownQuery}` : (parentQuery || '');

  // 2. Resolve the `@/` alias. Node does not read tsconfig `paths`, and -- like
  //    Metro -- it must be told that `@/lib/money` means `money.ts`. The
  //    `@sellflow-sms` alias points at the local Expo module and gets the same
  //    treatment, so a test imports the real bridge rather than a copy.
  if (pathname?.startsWith('@/')) {
    const base = resolvePath(root, 'src', pathname.slice(2));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, resolvePath(base, 'index.ts')]) {
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href + suffix, context);
      }
    }
  }

  if (pathname === '@sellflow-sms' || pathname.startsWith('@sellflow-sms/')) {
    const relative = pathname === '@sellflow-sms' ? 'index' : pathname.slice('@sellflow-sms/'.length);
    const base = resolvePath(root, 'modules', 'sellflow-sms', relative);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, resolvePath(base, 'index.ts')]) {
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href + suffix, context);
      }
    }
  }

  // 3. Metro happily resolves `./storage` to `./storage.ts`. Node's ESM
  //    resolver does not, so the extension is added here rather than changing
  //    the application source, which must keep working under Metro.
  if ((pathname?.startsWith('./') || pathname?.startsWith('../')) && !extname(pathname)) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : root;
    const base = resolvePath(dirname(parent), pathname);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, resolvePath(base, 'index.ts')]) {
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href + suffix, context);
      }
    }
  }

  // 4. Everything else, unchanged.
  return nextResolve(specifier, context);
}
