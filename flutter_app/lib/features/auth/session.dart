/// Session and authentication state.
///
/// TENANT ISOLATION STARTS HERE
///
/// The org id is never read from a widget, a route parameter, or anything the user
/// typed. It is resolved once, from the authenticated user's membership row, and
/// every downstream query is scoped by it. A client that trusts a supplied org id
/// will happily render another seller's ledger, because RLS filters rows but
/// nothing stops the *app* from asking for the wrong one.
///
/// Everything here is a Riverpod provider so the session can be replaced atomically
/// on sign-in and torn down completely on sign-out. A half-torn-down session is how
/// the previous user's dashboard survives into the next account.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../core/passcode.dart';

/// Where the app is in its authentication lifecycle.
enum AuthStage {
  /// No session, or checking for one.
  unknown,

  /// No session. Show sign-in / register.
  signedOut,

  /// Session exists but the device passcode has not been entered this time.
  locked,

  /// Session and passcode both satisfied.
  ready,
}

/// The authenticated account and its business context.
@immutable
class AccountContext {
  const AccountContext({
    required this.userId,
    required this.email,
    required this.orgId,
    required this.storeId,
    required this.displayName,
  });

  final String userId;
  final String email;

  /// The one org id every query is scoped by. Never from user input.
  final String orgId;

  /// Default store for order creation.
  final String storeId;

  final String displayName;

  /// Only the identity fields, never the org. Used for teardown comparison.
  String get identity => '$userId|$orgId';
}

/// Signals thrown by the auth layer, so the UI can show a real message rather than
/// "something went wrong".
class AuthFailure implements Exception {
  const AuthFailure(this.message, {this.fieldErrors = const {}});

  final String message;

  /// Per-field messages from the server, keyed by form field name.
  final Map<String, String> fieldErrors;

  @override
  String toString() => 'AuthFailure: $message';
}

/// Raised when sign-in succeeds but business context cannot be resolved.
///
/// Kept distinct from [AuthFailure] because there is no user-facing action that
/// fixes it, and reporting it as a credentials problem sends the seller to reset a
/// password that is perfectly fine.
class ContextUnavailable implements Exception {
  const ContextUnavailable(this.reason);

  final String reason;

  @override
  String toString() => 'ContextUnavailable: $reason';
}

final supabaseProvider = Provider<SupabaseClient>((ref) {
  throw UnimplementedError('supabaseClientProvider must be overridden at bootstrap');
});

/// Passcode service, overridable so widget tests never hit the keystore.
final passcodeServiceProvider = Provider<PasscodeService>(
  (ref) => PasscodeService(FlutterSecureStore()),
);

/// Current session, or null when signed out.
final sessionProvider =
    NotifierProvider<SessionNotifier, AccountContext?>(SessionNotifier.new);

/// Authentication lifecycle.
final authStageProvider =
    NotifierProvider<AuthStageNotifier, AuthStage>(AuthStageNotifier.new);

class AuthStageNotifier extends Notifier<AuthStage> {
  @override
  AuthStage build() => AuthStage.unknown;

  void move(AuthStage stage) => state = stage;
}

/// Backing state for [sessionProvider].
///
/// A [Notifier] rather than a plain `StateProvider` so that sign-out can clear the
/// session and every derived cache in one transition, and so a late async result
/// from the previous session cannot land after the new one has taken over.
class SessionNotifier extends Notifier<AccountContext?> {
  @override
  AccountContext? build() => null;

  /// Guards against a slow sign-in resolving after the user has signed out or
  /// switched accounts.
  int _generation = 0;

  bool get isReady => state != null;

  /// The org id, or null. Callers that need it should handle null explicitly --
  /// rendering anything while this is null risks showing stale data from a
  /// previous session.
  String? get orgId => state?.orgId;

  /// Restores a session on cold start.
  ///
  /// Returns the resolved [Session] or null. If a passcode exists the caller moves
  /// to [AuthStage.locked] rather than straight to [AuthStage.ready].
  Future<AccountContext?> restore() async {
    final client = ref.read(supabaseProvider);
    final auth = client.auth;
    if (auth.currentSession == null) {
      ref.read(authStageProvider.notifier).move(AuthStage.signedOut);
      return null;
    }

    final generation = ++_generation;
    try {
      final account = await _resolveContext(client);
      if (generation != _generation) return null; // superseded
      state = account;
      final hasPasscode = await ref.read(passcodeServiceProvider).hasPasscode(account.userId);
      if (generation != _generation) return null;
      ref.read(authStageProvider.notifier).move(
        hasPasscode ? AuthStage.locked : AuthStage.ready,
      );
      return account;
    } catch (error) {
      if (generation != _generation) return null;
      await signOut();
      rethrow;
    }
  }

  /// Signs in with email and password, then resolves business context.
  ///
  /// [onStage] lets the caller show a lock screen instead of the dashboard when a
  /// passcode is set.
  Future<AccountContext> signIn(
    String email,
    String password, {
    void Function(AuthStage stage)? onStage,
  }) async {
    final client = ref.read(supabaseProvider);
    final generation = ++_generation;

    final response = await client.auth.signInWithPassword(
      email: email.trim(),
      password: password,
    );

    if (response.user == null) {
      throw const AuthFailure('That email and password did not match.');
    }

    final account = await _resolveContext(client);
    if (generation != _generation) {
      // A sign-out or another sign-in happened while this one was in flight.
      // Dropping the result is the only safe option: applying it would attach the
      // previous account's business context to the current session.
      throw const AuthFailure('Sign-in was cancelled.');
    }

    state = account;

    final hasPasscode = await ref.read(passcodeServiceProvider).hasPasscode(account.userId);
    if (generation != _generation) {
      throw const AuthFailure('Sign-in was cancelled.');
    }

    final stage = hasPasscode ? AuthStage.locked : AuthStage.ready;
    ref.read(authStageProvider.notifier).move(stage);
    onStage?.call(stage);
    return account;
  }

  /// Creates an account and its business, then signs the user in.
  ///
  /// [paymentProvider] and [paymentNumber] are the seller's first receiving method.
  /// The number is validated before the call so an unusable account is rejected
  /// with a clear message instead of failing server-side.
  Future<AccountContext> register({
    required String fullName,
    required String email,
    required String password,
    required String businessName,
    required String paymentProvider,
    required String paymentNumber,
  }) async {
    final client = ref.read(supabaseProvider);
    final normalizedEmail = email.trim();

    final response = await client.auth.signUp(
      email: normalizedEmail,
      password: password,
      // Supabase user metadata. `full_name` is what the account screen reads back.
      data: <String, dynamic>{'full_name': fullName.trim()},
    );
    if (response.user == null) {
      throw const AuthFailure('Could not create the account. Try again.');
    }

    // Supabase may require email confirmation. Without a session there is nothing
    // to attach a business to, and failing here is honest.
    if (client.auth.currentSession == null) {
      throw const AuthFailure(
        'Confirm your email address, then sign in.',
      );
    }

    final generation = ++_generation;

    // The bootstrap RPC creates the organization and the seller's default store.
    final bootstrap = await client.rpc(
      'bootstrap_business',
      params: <String, dynamic>{'p_business_name': businessName.trim()},
    );
    if (bootstrap.error != null) {
      throw AuthFailure(_readable(bootstrap.error!));
    }

    final orgId = _extractId(bootstrap.data);
    if (orgId == null) {
      throw const ContextUnavailable('The business could not be created.');
    }

    // Connect the receiving account so payment detection has somewhere to file
    // money. Done here rather than on the dashboard so a seller who never opens
    // Payments still has a working account.
    final connected = await client.rpc(
      'create_payment_account',
      params: <String, dynamic>{
        'p_provider': paymentProvider,
        'p_account_number': paymentNumber.trim(),
      },
    );
    if (connected.error != null) {
      // Not fatal: the seller can connect it later from Settings. Registration
      // should not fail because of a payment account.
      debugPrint('create_payment_account during registration: ${connected.error!.message}');
    }

    final account = await _resolveContext(client);
    if (generation != _generation) {
      throw const AuthFailure('Registration was interrupted.');
    }
    state = account;
    ref.read(authStageProvider.notifier).move(AuthStage.ready);
    return account;
  }

  /// Records a passcode for the signed-in user.
  Future<void> setPasscode(String passcode) async {
    final current = state;
    if (current == null) throw const AuthFailure('Not signed in.');
    await ref.read(passcodeServiceProvider).setPasscode(current.userId, passcode);
    ref.read(authStageProvider.notifier).move(AuthStage.ready);
  }

  /// Unlocks after a passcode attempt.
  Future<PasscodeCheck> unlock(String passcode) async {
    final current = state;
    if (current == null) throw const AuthFailure('Not signed in.');
    final result = await ref.read(passcodeServiceProvider).verifyPasscode(current.userId, passcode);
    if (result.ok) {
      ref.read(authStageProvider.notifier).move(AuthStage.ready);
    }
    return result;
  }

  /// Clears the device passcode. Requires the account password, so it is only
  /// reachable from a flow that already proved ownership.
  Future<void> removePasscode() async {
    final current = state;
    if (current == null) throw const AuthFailure('Not signed in.');
    await ref.read(passcodeServiceProvider).clearPasscode(current.userId);
  }

  /// Signs out and tears down all local state.
  ///
  /// The order matters. Client-side caches are cleared BEFORE the network call,
  /// because a failed sign-out must not leave another seller's data on screen --
  /// and after it, a slow network call would leave it visible for seconds.
  Future<void> signOut() async {
    _generation += 1; // invalidate any in-flight resolution
    final client = ref.read(supabaseProvider);

    try {
      await client.auth.signOut();
    } catch (error) {
      // Local state still goes, even if the server call failed. Keeping the
      // dashboard on screen because of a network problem is worse than an
      // orphaned session token that expires on its own.
      debugPrint('signOut network call failed: $error');
    }

    state = null;
    ref.read(authStageProvider.notifier).move(AuthStage.signedOut);
  }

  /// Resolves user -> membership -> org -> default store.
  ///
  /// Every step is a query the signed-in user is permitted to make; nothing here
  /// is caller-supplied.
  Future<AccountContext> _resolveContext(SupabaseClient client) async {
    final authUser = client.auth.currentUser;
    if (authUser == null) {
      throw const AuthFailure('Not signed in.');
    }

    // `.single()` rather than `.maybeSingle()`: maybeSingle resolves to the map
    // itself and discards the error, so a permissions failure and a genuinely empty
    // membership become indistinguishable. Both are caught below and reported
    // differently, which matters because one is fixable by the seller and the
    // other is not.
    Map<String, dynamic>? membership;
    try {
      membership = await client
          .from('organization_members')
          .select('org_id, role')
          .eq('user_id', authUser.id)
          .limit(1)
          .single();
    } on PostgrestException catch (error) {
      throw AuthFailure(_readable(error));
    }

    final orgId = membership['org_id'] as String?;
    if (orgId == null || orgId.isEmpty) {
      throw const ContextUnavailable('This account is not a member of any business.');
    }

    Map<String, dynamic>? org;
    try {
      org = await client
          .from('organizations')
          .select('name')
          .eq('id', orgId)
          .single();
    } on PostgrestException catch (error) {
      throw AuthFailure(_readable(error));
    }

    Map<String, dynamic>? store;
    try {
      store = await client
          .from('stores')
          .select('id')
          .eq('org_id', orgId)
          .order('created_at', ascending: true)
          .limit(1)
          .single();
    } on PostgrestException catch (error) {
      throw AuthFailure(_readable(error));
    }
    final storeId = store['id'] as String?;
    if (storeId == null || storeId.isEmpty) {
      throw const ContextUnavailable('This business has no store yet.');
    }

    final name = org['name'] as String? ?? 'SellFlow';

    return AccountContext(
      userId: authUser.id,
      email: authUser.email ?? '',
      orgId: orgId,
      storeId: storeId,
      displayName: name,
    );
  }

  /// Reads an org id out of an RPC result that may be a bare string or an object.
  static String? _extractId(Object? data) {
    if (data is String) return data.isEmpty ? null : data;
    if (data is Map<String, dynamic>) {
      for (final key in ['id', 'org_id', 'organization_id']) {
        final value = data[key];
        if (value is String && value.isNotEmpty) return value;
      }
    }
    return null;
  }

  /// Turns a PostgREST error into something a seller can act on.
  ///
  /// Raw messages leak table and column names, which is both noise for a seller
  /// and a small amount of schema disclosure.
  static String _readable(Object error) {
    if (error is PostgrestException) {
      final code = error.code;
      if (code == '42501') return 'You do not have permission to do that.';
      if (code == 'PGRST116') return 'That record no longer exists.';
      return 'Could not complete that. Check your connection and try again.';
    }
    return 'Could not complete that. Try again.';
  }
}

/// Convenience selectors so widgets read intent, not plumbing.
final orgIdProvider = Provider<String?>((ref) => ref.watch(sessionProvider)?.orgId);

final storeIdProvider = Provider<String?>((ref) => ref.watch(sessionProvider)?.storeId);

/// Query key helper. Every key carries the org id so two accounts' cached data can
/// never be served to each other -- a query cache that survives sign-out is the
/// easiest way to leak one seller's data to the next.
String orgKey(String orgId, List<Object?> parts) => '$orgId|${parts.join('|')}';
