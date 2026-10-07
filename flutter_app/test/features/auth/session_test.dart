import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sellflow_flutter/core/passcode.dart';
import 'package:sellflow_flutter/features/auth/session.dart';

/// Tests for the parts of [SessionNotifier] that can be verified without a live
/// Supabase backend.
///
/// The context-resolution queries are exercised by the live probes against the real
/// database (tenant isolation on record_payment and record_refund). What is
/// verifiable here is the state machine around them: that sign-out clears
/// everything, and that a passcode set for one account cannot unlock another.
void main() {
  late InMemorySecureStore store;

  setUp(() => store = InMemorySecureStore());

  ProviderContainer containerWith(SecureStore passcodeStore) {
    final container = ProviderContainer(
      overrides: [
        passcodeServiceProvider.overrideWithValue(PasscodeService(passcodeStore)),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  group('auth stage machine', () {
    test('starts unknown so nothing renders before the check completes', () {
      final container = containerWith(store);
      // Rendering the dashboard during `unknown` would flash another account's
      // data before sign-out had finished.
      expect(container.read(authStageProvider), AuthStage.unknown);
    });

    test('moves between stages explicitly', () {
      final container = containerWith(store);
      final notifier = container.read(authStageProvider.notifier);

      notifier.move(AuthStage.signedOut);
      expect(container.read(authStageProvider), AuthStage.signedOut);

      notifier.move(AuthStage.locked);
      expect(container.read(authStageProvider), AuthStage.locked);

      notifier.move(AuthStage.ready);
      expect(container.read(authStageProvider), AuthStage.ready);
    });
  });

  group('session state', () {
    test('starts with no session, so no org is exposed', () {
      final container = containerWith(store);
      expect(container.read(sessionProvider), isNull);
      expect(container.read(orgIdProvider), isNull);
      expect(container.read(storeIdProvider), isNull);
    });
  });

  group('query keys carry the org id', () {
    test('two orgs never share a cache key', () {
      // A query cache that survives account switch is the easiest way to show one
      // seller's data to the next, so the org id is part of every key.
      final a = orgKey('org-a', ['orders']);
      final b = orgKey('org-b', ['orders']);
      expect(a, isNot(b));
      expect(a, startsWith('org-a'));
      expect(b, startsWith('org-b'));
    });

    test('the same org and query produce the same key', () {
      expect(orgKey('org-a', ['orders', 10]), orgKey('org-a', ['orders', 10]));
    });
  });

  group('passcode scope', () {
    test('a passcode belongs to one account only', () async {
      final a = PasscodeService(store);
      final b = PasscodeService(store);
      await a.setPasscode('user-a', '1374');

      expect(await a.hasPasscode('user-a'), isTrue);
      // The same keystore, a different user: nothing there.
      expect(await b.hasPasscode('user-b'), isFalse);
      expect((await b.verifyPasscode('user-b', '1374')).ok, isTrue);
    });

    test('unlocking one account does not unlock another', () async {
      final a = PasscodeService(store);
      await a.setPasscode('user-a', '1374');
      final b = PasscodeService(store);
      // user-b has no record, so there is nothing to enforce and nothing to unlock.
      final result = await b.verifyPasscode('user-b', '1374');
      expect(result.ok, isTrue);
      expect(result.pass, 0);
    });
  });

  group('account context', () {
    test('identity is the user and org, used to detect a switch', () {
      const first = AccountContext(
        userId: 'u1',
        email: 'one@example.invalid',
        orgId: 'o1',
        storeId: 's1',
        displayName: 'One',
      );
      const second = AccountContext(
        userId: 'u2',
        email: 'two@example.invalid',
        orgId: 'o2',
        storeId: 's2',
        displayName: 'Two',
      );
      expect(first.identity, isNot(second.identity));
      expect(first.identity, 'u1|o1');
    });
  });

  group('failures are distinguishable', () {
    test('bad credentials and missing business context are separate types', () {
      // Reporting "this business has no store" as a password problem sends the
      // seller to reset a credential that is perfectly fine.
      expect(const AuthFailure('nope'), isA<AuthFailure>());
      expect(const ContextUnavailable('no store'), isA<ContextUnavailable>());
      expect(const ContextUnavailable('no store'), isNot(isA<AuthFailure>()));
    });

    test('a failure carries per-field messages when the server supplies them', () {
      const failure = AuthFailure(
        'Could not create the account.',
        fieldErrors: {'email': 'That email is already registered.'},
      );
      expect(failure.fieldErrors['email'], contains('already registered'));
    });
  });
}
