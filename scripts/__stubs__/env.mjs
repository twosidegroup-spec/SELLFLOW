/**
 * Test-only Supabase configuration.
 *
 * `@/lib/supabase` refuses to build a client when it is unconfigured, which is
 * the correct production behaviour. The outbox test is therefore configured
 * explicitly, through this module, so the real code is allowed to attempt its
 * RPCs while a stub stands in for the transport.
 *
 * These are placeholders. They are never sent anywhere, and they deliberately
 * are NOT the anon key from any real project.
 */
process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key-not-a-real-key';

export const configured = true;
